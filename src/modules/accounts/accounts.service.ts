import type { ClientSession, ObjectId } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { isDuplicateKey } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import { normalizeEmail } from '../../platform/email.js';
import { normalizePhone, maskPhone } from '../../platform/phone.js';
import { hashPassword, passwordProblem } from '../../platform/security/passwords.js';
import type { AccountsRepository } from './accounts.repository.js';
import { NIVEAUX,
  CAMPUSES, EDIT_WINDOW_DAYS, NAME_RE, REGIONS, ROLE_SPACES, ROOM_RE, STUDENT_NUMBER_RE, UFR_CODES, VILLAGES,
  type AppSpace, type Audience, type AudienceProfile, type Campus, type MembershipSummary, type Region, type UfrCode, type NewStudentAccount, type NotificationPrefs, type OrganizationsPort, type PlatformRole, type StudentProfileDoc, type UserDoc,
} from './accounts.types.js';

/** Progressive lock after repeated wrong passwords: 5th failure → 1 min, then 5, 15, 60 min. */
const LOCK_STEPS_MIN = [1, 5, 15, 60];
const LOCK_AFTER = 5;

const DEFAULT_PREFS: NotificationPrefs = { social: true, cours: true, paiements: true, campus: true };

export type StudentProfileInput = { campus: Campus; onCampus: boolean; village?: string | null; room?: string | null };

export class AccountsService {
  constructor(
    private readonly repo: AccountsRepository,
    private readonly clock: Clock,
    private readonly organizations: () => OrganizationsPort,
    /** "10-01": the rentrée, each year (Dakar is UTC+0). */
    private readonly rentree = '10-01',
  ) {}

  // ---- Once a year: UFR, region and card details --------------------------------------------------------

  /** The last rentrée on or before `now`, and the next one after it. */
  private rentrees(now: Date) {
    const at = (year: number) => new Date(`${year}-${this.rentree}T00:00:00.000Z`);
    const year = now.getUTCFullYear();
    const last = at(year) <= now ? at(year) : at(year - 1);
    return { last, next: at(last.getUTCFullYear() + 1) };
  }

  /** Given since the last rentrée: locked until the next one (the date), else null (free to change). */
  private lockedUntil(setAt: Date | null | undefined, now: Date) {
    if (!setAt) return null;
    const { last, next } = this.rentrees(now);
    return setAt >= last ? next : null;
  }

  private static frDate = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Dakar', day: 'numeric', month: 'long', year: 'numeric' });

  // ---- Validation shared by sign-up and profile edits -------------------------------------------------

  normalizeStudentNumber(input: string) {
    const v = input.toUpperCase().replace(/\s/g, '');
    if (!STUDENT_NUMBER_RE.test(v)) throw errors.validation('Numéro étudiant invalide. Exemple : P232055', { field: 'studentNumber' });
    return v;
  }

  normalizeName(input: string, field: 'firstName' | 'lastName') {
    const v = input.trim().replace(/\s+/g, ' ');
    if (!v || v.length > 60 || !NAME_RE.test(v)) throw errors.validation('Utilise uniquement des lettres, des espaces ou des tirets.', { field });
    return v;
  }

  /** Village and room only for students living in a campus residence; the village must belong to the campus. */
  residence(input: StudentProfileInput): { onCampus: boolean; village: string | null; room: string | null } {
    if (!input.onCampus) return { onCampus: false, village: null, room: null };
    const village = input.village ?? '';
    if (!VILLAGES[input.campus].includes(village)) throw errors.validation('Choisis ton village.', { field: 'village' });
    const room = (input.room ?? '').toUpperCase().replace(/\s/g, '');
    if (!ROOM_RE.test(room)) throw errors.validation('Numéro de chambre invalide. Exemple : 214 ou C12', { field: 'room' });
    return { onCampus: true, village, room };
  }

  /** UFR and home region, as asked at sign-up and in the profile. */
  origin(input: { ufr: string; region: string }): { ufr: UfrCode; region: Region } {
    if (!(UFR_CODES as string[]).includes(input.ufr)) throw errors.validation('Choisis ton UFR.', { field: 'ufr' });
    if (!(REGIONS as readonly string[]).includes(input.region)) throw errors.validation('Choisis ta région d’origine.', { field: 'region' });
    return { ufr: input.ufr as UfrCode, region: input.region as Region };
  }

  phoneOrThrow(input: string) {
    const phone = normalizePhone(input);
    if (!phone) throw errors.validation('Numéro invalide. Il doit commencer par 70, 71, 75, 76, 77 ou 78.', { field: 'phone' });
    return phone;
  }

  // ---- Sign-up -----------------------------------------------------------------------------------------

  /**
   * Sign-up step 1. A number whose account isn't a student's (someone given a role in a team, or on the app creator's
   * team) is not taken: sign-up completes that account (`existingAccount`), its roles stay.
   */
  async availability(phone: string, studentNumber: string | null) {
    const [phoneTaken, numberTaken, existing] = await Promise.all([
      this.repo.phoneExists(phone),
      studentNumber ? this.repo.studentNumberExists(studentNumber) : Promise.resolve(false),
      this.repo.findUserByPhone(phone),
    ]);
    const completes = !!existing && !(await this.repo.findProfileByUserId(existing._id));
    const phoneConflict = phoneTaken && !completes;
    return {
      available: !phoneConflict && !numberTaken,
      conflict: phoneConflict ? ('phone' as const) : numberTaken ? ('student_number' as const) : undefined,
      ...(completes ? { existingAccount: true } : {}),
    };
  }

  /** A number sign-up may use: no account, or an account that isn't a student's yet. */
  async canRegister(phone: string) {
    const existing = await this.repo.findUserByPhone(phone);
    return !existing || !(await this.repo.findProfileByUserId(existing._id));
  }

  /** User + student profile, inside the caller's transaction. Unique indexes decide races between two sign-ups. */
  async createStudentAccount(input: NewStudentAccount, session: ClientSession): Promise<UserDoc & { linked?: true }> {
    const now = this.clock.now();
    // The number already has an account without a student profile (a team member): sign-up completes it. The code
    // sent to the number proves it is theirs, as for "mot de passe oublié"; the name and password given now win.
    const existing = await this.repo.findUserByPhone(input.phone, session);
    if (existing) {
      if (await this.repo.findProfileByUserId(existing._id, session)) throw errors.conflict('PHONE_TAKEN', 'Ce numéro a déjà un compte.');
      const updated = await this.repo.completeAsStudent(
        existing._id,
        {
          firstName: input.firstName, lastName: input.lastName, passwordHash: input.passwordHash, phoneVerifiedAt: now,
          terms: { version: input.termsVersion, acceptedAt: now }, login: { failedCount: 0, lockedUntil: null, lastLoginAt: existing.login.lastLoginAt }, updatedAt: now,
        },
        session,
      );
      try {
        await this.repo.insertProfile(this.newProfile(existing._id, input, now), session);
      } catch (err) {
        if (isDuplicateKey(err, 'student_number_unique_when_set')) throw errors.conflict('STUDENT_NUMBER_TAKEN', 'Ce numéro étudiant a déjà un compte.');
        throw err;
      }
      return { ...updated!, linked: true };
    }
    const user: UserDoc = {
      _id: this.repo.newId(),
      phone: input.phone,
      phoneVerifiedAt: now,
      passwordHash: input.passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      status: 'active',
      platformRoles: [],
      login: { failedCount: 0, lockedUntil: null, lastLoginAt: null },
      terms: { version: input.termsVersion, acceptedAt: now },
      notificationPrefs: DEFAULT_PREFS,
      payoutAccount: { phone: input.phone, verifiedAt: now },
      email: null,
      avatar: null,
      lastLocation: null,
      createdAt: now,
      updatedAt: now,
    };
    const profile = this.newProfile(user._id, input, now);
    try {
      await this.repo.insertUser(user, session);
      await this.repo.insertProfile(profile, session);
    } catch (err) {
      if (isDuplicateKey(err, 'phone_unique')) throw errors.conflict('PHONE_TAKEN', 'Ce numéro a déjà un compte.');
      if (isDuplicateKey(err, 'student_number_unique')) throw errors.conflict('STUDENT_NUMBER_TAKEN', 'Ce numéro étudiant a déjà un compte.');
      throw err;
    }
    return user;
  }

  private newProfile(userId: ObjectId, input: NewStudentAccount, now: Date): StudentProfileDoc {
    return {
      _id: this.repo.newId(),
      userId,
      studentNumber: input.studentNumber,
      studentNumberSetAt: input.studentNumber ? now : null,
      campus: input.campus,
      onCampus: input.onCampus,
      village: input.village,
      room: input.room,
      ufr: input.ufr,
      region: input.region,
      originSetAt: input.ufr || input.region ? now : null,
      filiere: null,
      niveau: input.niveau ?? null,
      academicGroupIds: [],
      verification: { status: 'unverified', verifiedAt: null },
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Accounts created by an admin (organizer staff): no student profile, no password until "mot de passe oublié". */
  /**
   * An account created by someone else (an owner adding an employee, an admin adding a business owner or a team
   * member). With a password, the person can sign in at once; without, they set it with "mot de passe oublié".
   */
  async createStaffUser(input: { phone: string; firstName: string; lastName: string; password?: string }): Promise<UserDoc> {
    const now = this.clock.now();
    const phone = this.phoneOrThrow(input.phone);
    const password = input.password?.trim();
    if (password) {
      const problem = passwordProblem(password);
      if (problem) throw errors.validation(problem, { field: 'password' });
    }
    const user: UserDoc = {
      _id: this.repo.newId(),
      phone,
      phoneVerifiedAt: null,
      passwordHash: password ? await hashPassword(password) : null,
      firstName: this.normalizeName(input.firstName, 'firstName'),
      lastName: this.normalizeName(input.lastName, 'lastName'),
      status: 'active',
      platformRoles: [],
      login: { failedCount: 0, lockedUntil: null, lastLoginAt: null },
      terms: null,
      notificationPrefs: DEFAULT_PREFS,
      payoutAccount: { phone, verifiedAt: now },
      email: null,
      avatar: null,
      lastLocation: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.repo.insertUser(user);
    } catch (err) {
      if (isDuplicateKey(err, 'phone_unique')) throw errors.conflict('PHONE_TAKEN', 'Ce numéro a déjà un compte.');
      throw err;
    }
    return user;
  }

  // ---- Login support -----------------------------------------------------------------------------------

  /** Phone number or student number (the API accepts both; the app currently sends the phone). */
  async findForLogin(identifier: string): Promise<UserDoc | null> {
    const phone = normalizePhone(identifier);
    if (phone) return this.repo.findUserByPhone(phone);
    const number = identifier.toUpperCase().replace(/\s/g, '');
    if (!STUDENT_NUMBER_RE.test(number)) return null;
    const profile = await this.repo.findProfileByStudentNumber(number);
    return profile ? this.repo.findUserById(profile.userId) : null;
  }

  findByPhone(phone: string, session?: ClientSession) {
    return this.repo.findUserByPhone(phone, session);
  }

  findById(id: ObjectId) {
    return this.repo.findUserById(id);
  }

  /** What each user agreed to receive as push notifications (Social / Cours / Paiements switches). */
  async notificationPrefsByIds(ids: ObjectId[]): Promise<Map<string, NotificationPrefs>> {
    const users = ids.length ? await this.repo.findPrefsByIds(ids) : [];
    return new Map(users.map((u) => [u._id.toHexString(), u.notificationPrefs]));
  }

  /**
   * Names and phone numbers, for people who need to reach someone (an organizer calling a late passenger).
   * Callers must check that right themselves.
   */
  async contactsByIds(ids: ObjectId[]): Promise<Map<string, { firstName: string; lastName: string; phone: string }>> {
    const users = ids.length ? await this.repo.findContactsByIds(ids) : [];
    return new Map(users.map((u) => [u._id.toHexString(), { firstName: u.firstName, lastName: u.lastName, phone: u.phone }]));
  }

  /** First and last names of several users at once (lists that show who is in a trip). */
  async namesByIds(ids: ObjectId[]): Promise<Map<string, { firstName: string; lastName: string }>> {
    const users = ids.length ? await this.repo.findUsersByIds(ids) : [];
    return new Map(users.map((u) => [u._id.toHexString(), { firstName: u.firstName, lastName: u.lastName }]));
  }

  /** Returns the lock end when this failure triggers (or extends) a lock. */
  async recordLoginFailure(userId: ObjectId): Promise<Date | null> {
    const now = this.clock.now();
    const count = await this.repo.incrementLoginFailures(userId, now);
    if (count < LOCK_AFTER) return null;
    const minutes = LOCK_STEPS_MIN[Math.min(count - LOCK_AFTER, LOCK_STEPS_MIN.length - 1)]!;
    const until = new Date(now.getTime() + minutes * 60_000);
    await this.repo.setLockedUntil(userId, until);
    return until;
  }

  recordLoginSuccess(userId: ObjectId) {
    return this.repo.recordLoginSuccess(userId, this.clock.now());
  }

  setPassword(userId: ObjectId, passwordHash: string, session?: ClientSession) {
    return this.repo.setPassword(userId, passwordHash, this.clock.now(), session);
  }

  // ---- Profile -----------------------------------------------------------------------------------------

  /**
   * The spaces the app can open, in this order (the first is home): the student space, each space of each organization
   * (Khoulé & frère · Restaurant, Khoulé & frère · Boutique…), then the platform team's spaces.
   */
  private spacesFrom(user: UserDoc, profile: unknown, memberships: MembershipSummary[]): AppSpace[] {
    const spaces: AppSpace[] = [];
    if (profile) spaces.push({ key: 'student', type: 'student', kind: null, orgId: null, name: 'Étudiant', roles: [], logoUrl: null, personal: false });
    for (const m of memberships) {
      // A student's own events are managed from the student space (« Mes événements », its scanner): no organizer space.
      // The membership stays: it lets them scan and validate their events' tickets.
      if (m.space === 'organizer' && m.category === 'Étudiant') continue;
      const kind = m.space === 'organizer' ? null : m.space;
      spaces.push({ key: `${m.space}:${m.orgId}`, type: kind ? 'business' : 'organizer', kind, orgId: m.orgId, name: m.name, roles: m.roles, logoUrl: m.logoUrl, personal: m.category === 'Étudiant' });
    }
    const admin = user.platformRoles.includes('admin');
    for (const r of ROLE_SPACES) {
      const roles = r.roles.filter((role) => user.platformRoles.includes(role));
      if (admin || roles.length) spaces.push({ key: r.space, type: r.space, kind: null, orgId: null, name: r.label, roles: admin ? ['admin', ...roles] : roles, logoUrl: null, personal: false });
    }
    return spaces;
  }

  /** Has the account anything left to open? A removed employee with no student profile has not: they can't sign in. */
  async hasAnySpace(userId: ObjectId) {
    const user = await this.repo.findUserById(userId);
    if (!user) return false;
    const [profile, memberships] = await Promise.all([this.repo.findProfileByUserId(userId), this.organizations().membershipsForUser(userId)]);
    return this.spacesFrom(user, profile, memberships).length > 0;
  }

  async getMe(userId: ObjectId) {
    const user = await this.repo.findUserById(userId);
    if (!user) throw errors.unauthenticated();
    const [profile, memberships] = await Promise.all([this.repo.findProfileByUserId(userId), this.organizations().membershipsForUser(userId)]);
    const spaces = this.spacesFrom(user, profile, memberships);
    return {
      id: user._id.toHexString(),
      firstName: user.firstName,
      lastName: user.lastName,
      initials: `${user.firstName.charAt(0)}${user.lastName.charAt(0)}`.toUpperCase(),
      phoneMasked: maskPhone(user.phone),
      platformRoles: user.platformRoles,
      student: profile
        ? {
            studentNumber: profile.studentNumber,
            campus: profile.campus,
            onCampus: profile.onCampus,
            village: profile.village,
            room: profile.room,
            ufr: profile.ufr,
            region: profile.region,
            filiere: profile.filiere,
            niveau: profile.niveau,
            verified: profile.verification.status === 'verified',
            identity: profile.identity
              ? { birthDate: profile.identity.birthDate, birthPlace: profile.identity.birthPlace, nationality: profile.identity.nationality, fromCard: profile.identity.source === 'card', updatedAt: profile.identity.updatedAt.toISOString() }
              : null,
            // Until the next rentrée, what's filled stays (null: free to change).
            originEditableFrom: this.lockedUntil(profile.ufr || profile.region ? (profile.originSetAt ?? profile.createdAt) : null, this.clock.now())?.toISOString() ?? null,
            identityEditableFrom: this.lockedUntil(profile.identity?.source === 'card' ? profile.identity.updatedAt : null, this.clock.now())?.toISOString() ?? null,
            // Typed by the student: correctable until then (null: locked, or nothing typed).
            studentNumberEditableUntil: this.editableUntil(profile.studentNumber ? (profile.studentNumberSetAt ?? profile.createdAt) : null, this.clock.now())?.toISOString() ?? null,
            identityEditableUntil: this.editableUntil(profile.identity?.source === 'manual' ? (profile.identity.firstSetAt ?? profile.identity.updatedAt) : null, this.clock.now())?.toISOString() ?? null,
          }
        : null,
      spaces,
      organizations: memberships.map((m) => ({ id: m.orgId, name: m.name, category: m.category, level: m.level, roles: m.roles, capabilities: m.capabilities, space: m.space })),
      payoutPhoneMasked: maskPhone(user.payoutAccount.phone),
      email: user.email ? { address: user.email.address, verified: user.email.verifiedAt !== null } : null,
      avatarUrl: user.avatar?.url ?? null,
      // Only ever returned to the user themself.
      location: user.lastLocation
        ? {
            lat: user.lastLocation.point.coordinates[1],
            lng: user.lastLocation.point.coordinates[0],
            accuracyM: user.lastLocation.accuracyM,
            updatedAt: user.lastLocation.updatedAt.toISOString(),
          }
        : null,
    };
  }

  /** "Informations personnelles": campus, living on campus or not, village and room. */
  async updateResidence(userId: ObjectId, input: { campus?: Campus; onCampus: boolean; village?: string | null; room?: string | null }) {
    const profile = await this.repo.findProfileByUserId(userId);
    if (!profile) throw errors.forbidden('Réservé aux étudiants.');
    const campus = input.campus ?? profile.campus;
    if (!(CAMPUSES as readonly string[]).includes(campus)) throw errors.validation('Choisis ton campus.', { field: 'campus' });
    const residence = this.residence({ ...input, campus });
    await this.repo.updateProfile(userId, { campus, ...residence }, this.clock.now());
  }

  /** "Mon UFR et ma région" in the profile (students who signed up before they were asked, or who changed UFR). */
  /** UFR, région, niveau: each may come alone (what isn't sent stays). */
  async updateOrigin(userId: ObjectId, input: { ufr?: string; region?: string; niveau?: string }) {
    const profile = await this.repo.findProfileByUserId(userId);
    if (!profile) throw errors.forbidden('Réservé aux étudiants.');
    const now = this.clock.now();
    const merged = { ufr: input.ufr ?? profile.ufr, region: input.region ?? profile.region };
    if (input.ufr !== undefined && !(UFR_CODES as string[]).includes(input.ufr)) throw errors.validation('Choisis ton UFR.', { field: 'ufr' });
    if (input.region !== undefined && !(REGIONS as readonly string[]).includes(input.region)) throw errors.validation('Choisis ta région d’origine.', { field: 'region' });
    if (input.niveau !== undefined && !(NIVEAUX as readonly string[]).includes(input.niveau)) throw errors.validation('Choisis ton niveau.', { field: 'niveau' });
    // Given this year: a filled field stays until the rentrée; an empty one can still be filled.
    const until = this.lockedUntil(profile.originSetAt ?? profile.createdAt, now);
    const changes = (was: string | null | undefined, next: string | undefined) => next !== undefined && !!was && was !== next;
    if (until && (changes(profile.ufr, input.ufr) || changes(profile.region, input.region) || changes(profile.niveau, input.niveau))) {
      throw errors.conflict('ORIGIN_LOCKED', `Ton UFR, ton niveau et ta région se changent une fois par an : modifiables à la rentrée, le ${AccountsService.frDate.format(until)}.`, { editableFrom: until.toISOString() });
    }
    await this.repo.updateProfile(
      userId,
      { ufr: merged.ufr as UfrCode | null, region: merged.region as Region | null, ...(input.niveau !== undefined ? { niveau: input.niveau } : {}), originSetAt: now },
      now,
    );
  }

  /** The student's own card was just read and its number is theirs: they may save their identity for a while. */
  /** Until when what was first given at `since` can still be corrected by the student (null: no longer). */
  private editableUntil(since: Date | null | undefined, now: Date) {
    if (!since) return null;
    const until = new Date(since.getTime() + EDIT_WINDOW_DAYS * 24 * 3_600_000);
    return now < until ? until : null;
  }

  /**
   * A student gives their number (on « Ma carte étudiant », typed or read from their own card). Correctable for
   * EDIT_WINDOW_DAYS after it was first given (a typo); then it doesn't change here (the UGB Connect team fixes it):
   * `has-other` when the profile already has another, locked.
   */
  async claimStudentNumber(userId: ObjectId, input: string): Promise<'set' | 'has-other'> {
    const number = this.normalizeStudentNumber(input);
    const profile = await this.repo.findProfileByUserId(userId);
    if (!profile) throw errors.forbidden('Réservé aux étudiants.');
    const now = this.clock.now();
    if (profile.studentNumber === number) return 'set';
    const since = profile.studentNumber ? (profile.studentNumberSetAt ?? profile.createdAt) : null;
    if (profile.studentNumber && !this.editableUntil(since, now)) return 'has-other';
    try {
      const res = await this.repo.profiles.updateOne(
        { _id: profile._id, studentNumber: profile.studentNumber },
        { $set: { studentNumber: number, studentNumberSetAt: since ?? now, updatedAt: now } },
      );
      if (!res.matchedCount) return 'has-other';
    } catch (err) {
      if (isDuplicateKey(err, 'student_number_unique_when_set')) throw errors.conflict('STUDENT_NUMBER_TAKEN', 'Ce numéro étudiant est déjà utilisé par un autre compte. Écris à l’équipe UGB Connect si c’est le tien.');
      throw err;
    }
    return 'set';
  }

  async markCardRead(userId: ObjectId) {
    await this.repo.updateProfile(userId, { cardReadAt: this.clock.now() }, this.clock.now());
  }

  /**
   * Birth date, place of birth, nationality: from the student's own card only (read and matched within 30 min; a
   * misread can be corrected before saving). Saved once: it can't be changed afterwards.
   */
  async updateIdentity(userId: ObjectId, input: { birthDate: string | null; birthPlace: string | null; nationality: string | null; fromCard?: boolean }) {
    const profile = await this.repo.findProfileByUserId(userId);
    if (!profile) throw errors.forbidden('Réservé aux étudiants.');
    const now = this.clock.now();
    if (!input.fromCard) return this.typedIdentity(profile, input, now);
    // Saved from the card this year: a filled field stays until the rentrée (new card); an empty one can be filled.
    const saved = profile.identity?.source === 'card' ? profile.identity : null;
    const until = this.lockedUntil(saved?.updatedAt, now);
    if (saved && until) {
      const changes = (old: string | null, v: string | null) => old !== null && (v?.trim().replace(/\s+/g, ' ') || null) !== old;
      if (changes(saved.birthDate, input.birthDate) || changes(saved.birthPlace, input.birthPlace) || changes(saved.nationality, input.nationality)) {
        throw errors.conflict('IDENTITY_LOCKED', `Enregistré depuis ta carte cette année : modifiable à la rentrée, le ${AccountsService.frDate.format(until)}.`, { editableFrom: until.toISOString() });
      }
    }
    if (!profile.cardReadAt || now.getTime() - profile.cardReadAt.getTime() > 30 * 60_000) {
      throw errors.rule('CARD_SCAN_REQUIRED', 'Scanne d’abord ta carte étudiant : son numéro doit être le tien.');
    }
    if (input.birthDate) {
      const d = new Date(`${input.birthDate}T00:00:00Z`);
      const age = (now.getTime() - d.getTime()) / (365.25 * 24 * 3_600_000);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input.birthDate || age < 14 || age > 80) {
        throw errors.validation('Date de naissance invalide.', { field: 'birthDate' });
      }
    }
    const clean = (v: string | null) => v?.trim().replace(/\s+/g, ' ') || null;
    await this.repo.updateProfile(
      userId,
      { identity: { birthDate: input.birthDate, birthPlace: clean(input.birthPlace), nationality: clean(input.nationality), source: 'card', updatedAt: now }, cardReadAt: null },
      now,
    );
  }

  /**
   * Typed by hand (no card at hand): saved without a scan, correctable for EDIT_WINDOW_DAYS after it was first given,
   * then locked. Never over details read from the card this year; a scan may always replace typed ones.
   */
  private async typedIdentity(profile: StudentProfileDoc, input: { birthDate: string | null; birthPlace: string | null; nationality: string | null }, now: Date) {
    const fromCard = profile.identity?.source === 'card' ? this.lockedUntil(profile.identity.updatedAt, now) : null;
    if (fromCard) throw errors.conflict('IDENTITY_LOCKED', `Enregistré depuis ta carte cette année : modifiable à la rentrée, le ${AccountsService.frDate.format(fromCard)}.`, { editableFrom: fromCard.toISOString() });
    const typed = profile.identity?.source === 'manual' ? profile.identity : null;
    const firstSetAt = typed ? (typed.firstSetAt ?? typed.updatedAt) : now;
    if (typed && !this.editableUntil(firstSetAt, now)) {
      throw errors.conflict('IDENTITY_LOCKED', `Rempli à la main il y a plus de ${EDIT_WINDOW_DAYS} jours : scanne ta carte étudiant pour le mettre à jour.`);
    }
    this.checkBirthDate(input.birthDate, now);
    const clean = (v: string | null) => v?.trim().replace(/\s+/g, ' ') || null;
    await this.repo.updateProfile(
      profile.userId,
      { identity: { birthDate: input.birthDate, birthPlace: clean(input.birthPlace), nationality: clean(input.nationality), source: 'manual', updatedAt: now, firstSetAt } },
      now,
    );
  }

  private checkBirthDate(birthDate: string | null, now: Date) {
    if (!birthDate) return;
    const d = new Date(`${birthDate}T00:00:00Z`);
    const age = (now.getTime() - d.getTime()) / (365.25 * 24 * 3_600_000);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== birthDate || age < 14 || age > 80) {
      throw errors.validation('Date de naissance invalide.', { field: 'birthDate' });
    }
  }

  /** What announcements are matched on for this account (null: not a student, whole-university items only). */
  async audienceOf(userId: ObjectId): Promise<AudienceProfile> {
    const p = await this.repo.findProfileByUserId(userId);
    return p ? { campus: p.campus, ufr: p.ufr, region: p.region, village: p.village } : null;
  }

  /** Students an announcement is for. A UFR- or region-targeted one skips students who haven't said theirs. */
  userIdsInAudience(a: Audience) {
    return this.repo.userIdsMatching({
      ...(a.campuses.length ? { campus: { $in: a.campuses } } : {}),
      ...(a.ufrs.length ? { ufr: { $in: a.ufrs } } : {}),
      ...(a.regions.length ? { region: { $in: a.regions } } : {}),
    });
  }

  /** The student holding this number (P232055), with what a found card needs: name, phone, UFR, campus. */
  async studentByNumber(studentNumber: string): Promise<StudentCard | null> {
    const p = await this.repo.findProfileByStudentNumber(studentNumber);
    if (!p) return null;
    const u = await this.repo.findUserById(p.userId);
    return u && u.status === 'active' ? cardOf(u, p) : null;
  }

  /**
   * Everyone whose first or last name contains one of these words (a card read by OCR, a name typed by the finder):
   * "ndiay" finds Ndiaye, "fatou" finds Fatoumata. Best matches first: a word that is a whole name counts twice, so
   * "NDIAYE Fatou" puts Fatou Ndiaye before the other Ndiayes. Accounts without a student profile are included
   * (an identity or bank card can be anyone's).
   */
  /**
   * Students whose names contain these words, best first. `exactWords`: only those with at least this many of the
   * words as a whole name (a card read by the camera: two names really on it, never a stray word in the picture).
   */
  async searchStudents(words: string[], limit = 20, exactWords = 0): Promise<StudentCard[]> {
    const clean = [...new Set(words.map((w) => w.trim()).filter((w) => w.length >= 2))].slice(0, 6);
    if (!clean.length) return [];
    const users = await this.repo.findUsersByNames(clean.map(containing), 300);
    const profiles = new Map((await this.repo.findProfilesByUserIds(users.map((u) => u._id))).map((p) => [p.userId.toHexString(), p]));
    const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const wanted = clean.map(fold);
    return users
      .map((u) => {
        const names = `${u.firstName} ${u.lastName}`.split(/[\s'-]+/).map(fold);
        const score = wanted.reduce((n, w) => n + (names.includes(w) ? 2 : names.some((x) => x.includes(w)) ? 1 : 0), 0);
        const exact = wanted.filter((w) => names.includes(w)).length;
        return { card: cardOf(u, profiles.get(u._id.toHexString()) ?? null), score, exact };
      })
      .filter((x) => x.exact >= exactWords)
      .sort((a, b) => b.score - a.score || a.card.lastName.localeCompare(b.card.lastName) || a.card.firstName.localeCompare(b.card.firstName))
      .slice(0, limit)
      .map((x) => x.card);
  }

  /** Adds or replaces the e-mail address. It starts unverified; a new address resets the verification. */
  async changePhone(userId: ObjectId, phone: string) {
    const user = await this.repo.findUserById(userId);
    if (!user) throw errors.unauthenticated();
    const now = this.clock.now();
    try {
      await this.repo.setPhone(userId, phone, user.payoutAccount.phone === user.phone, now);
    } catch (err) {
      if (isDuplicateKey(err, 'phone_unique')) throw errors.conflict('PHONE_TAKEN', 'Ce numéro a déjà un compte.');
      throw err;
    }
  }

  /** The profile picture (an upload of purpose `avatar`), or none. */
  /** Returns the picture it replaced (to delete from the storage), if any. */
  async setAvatar(userId: ObjectId, avatar: UserDoc['avatar']) {
    const before = (await this.repo.findUserById(userId))?.avatar ?? null;
    await this.repo.setUserFields(userId, { avatar }, this.clock.now());
    return before && !(avatar && avatar.mediaId.equals(before.mediaId)) ? before.mediaId : null;
  }

  async setEmail(userId: ObjectId, input: string) {
    const address = normalizeEmail(input);
    if (!address) throw errors.validation('Adresse e-mail invalide.', { field: 'email' });
    const user = await this.repo.findUserById(userId);
    if (!user) throw errors.unauthenticated();
    if (user.email?.address === address) return;
    const now = this.clock.now();
    try {
      await this.repo.setUserFields(userId, { email: { address, verifiedAt: null, addedAt: now } }, now);
    } catch (err) {
      if (isDuplicateKey(err, 'email_unique')) throw errors.conflict('EMAIL_TAKEN', 'Cette adresse e-mail est déjà utilisée par un autre compte.');
      throw err;
    }
  }

  removeEmail(userId: ObjectId) {
    return this.repo.setUserFields(userId, { email: null }, this.clock.now());
  }

  /** Stored as GeoJSON ([lng, lat]) so future "near me" queries can use the 2dsphere index. */
  setLocation(userId: ObjectId, input: { lat: number; lng: number; accuracyM?: number }) {
    const now = this.clock.now();
    return this.repo.setUserFields(
      userId,
      { lastLocation: { point: { type: 'Point', coordinates: [input.lng, input.lat] }, accuracyM: input.accuracyM ?? null, updatedAt: now } },
      now,
    );
  }

  clearLocation(userId: ObjectId) {
    return this.repo.setUserFields(userId, { lastLocation: null }, this.clock.now());
  }

  async getNotificationPrefs(userId: ObjectId) {
    const user = await this.repo.findUserById(userId);
    if (!user) throw errors.unauthenticated();
    return user.notificationPrefs;
  }

  setNotificationPrefs(userId: ObjectId, prefs: NotificationPrefs) {
    return this.repo.setNotificationPrefs(userId, prefs, this.clock.now());
  }

  async setPlatformRoles(userId: ObjectId, roles: PlatformRole[]) {
    const user = await this.repo.setPlatformRoles(userId, [...new Set(roles)], this.clock.now());
    if (!user) throw errors.notFound();
    return user;
  }

  // ---- Capability checks used by guards ------------------------------------------------------------------

  async hasStudentProfile(userId: ObjectId) {
    return (await this.repo.findProfileByUserId(userId)) !== null;
  }

  /** Read from the database, not the token: a revoked role stops working on the next request. */
  async hasPlatformRole(userId: ObjectId, role: PlatformRole) {
    const user = await this.repo.findUserById(userId);
    return !!user && user.status === 'active' && (user.platformRoles.includes(role) || user.platformRoles.includes('admin'));
  }
}

/** Someone a found card may belong to: enough to tell two namesakes apart, and to call them. Students have the rest. */
export type StudentCard = { userId: ObjectId; firstName: string; lastName: string; phone: string; studentNumber: string | null; ufr: UfrCode | null; campus: Campus | null; village: string | null };

const cardOf = (u: Pick<UserDoc, '_id' | 'firstName' | 'lastName' | 'phone'>, p: StudentProfileDoc | null): StudentCard => ({
  userId: u._id, firstName: u.firstName, lastName: u.lastName, phone: u.phone, studentNumber: p?.studentNumber ?? null, ufr: p?.ufr ?? null, campus: p?.campus ?? null, village: p?.village ?? null,
});

const ACCENTS: Record<string, string> = { a: 'aàâä', c: 'cç', e: 'eéèêë', i: 'iîï', o: 'oôö', u: 'uùûü', y: 'yÿ' };
/** A piece of a name, case and accents ignored: "ndiay" matches "NDIAYE", "ndeye" matches "Ndéye". */
function containing(word: string) {
  const plain = word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z'-]/g, '');
  return new RegExp([...plain].map((ch) => (ACCENTS[ch] ? `[${ACCENTS[ch]}]` : ch.replace(/[-']/g, '\\$&'))).join(''), 'i');
}
