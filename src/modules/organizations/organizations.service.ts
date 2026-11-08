import { ObjectId, type Collection, type Db, type Document } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { isDuplicateKey } from '../../platform/db/mongo.js';
import { randomCode } from '../../platform/security/crypto.js';
import { errors } from '../../platform/http/errors.js';
import { normalizeEmail } from '../../platform/email.js';
import { normalizePhone } from '../../platform/phone.js';
import type { AccountsApi, MembershipSummary } from '../accounts/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { PAYOUT_PROVIDERS, spacesOf, type MembershipDoc, type OrgCapability, type OrgCategory, type OrgLevel, type OrgRole, type OrgSpace, type OrganizationDoc, type PayoutProvider } from './organizations.types.js';

/** How each space names its roles (what the member is told, what the team list shows). */
export const SPACE_LABELS: Record<OrgSpace, string> = { organizer: 'Organisateur', restaurant: 'Restaurant', shop: 'Boutique' };
export const ROLE_LABELS: Record<OrgRole, string> = { owner: 'Propriétaire', manager: 'Gérant', scanner: 'Contrôleur', staff: 'Employé' };
/** The roles an owner may give in each space (the owner role is the platform admins' call). */
export const SPACE_ROLES: Record<OrgSpace, OrgRole[]> = { organizer: ['manager', 'scanner'], restaurant: ['manager', 'staff'], shop: ['manager', 'staff'] };
/** The app's key of a space: what /espace opens. */
export const spaceKey = (space: OrgSpace, orgId: ObjectId | string) => `${space}:${typeof orgId === 'string' ? orgId : orgId.toHexString()}`;

export type NewMember = { phone: string; roles: OrgRole[]; firstName?: string; lastName?: string; password?: string };

export type CreateOrgInput = { slug: string; name: string; category: OrgCategory; capabilities: OrgCapability[]; level?: OrgLevel; payoutPhone?: string; email?: string };
export type UpdateOrgInput = Partial<{ name: string; category: OrgCategory; level: OrgLevel; status: OrganizationDoc['status']; payoutPhone: string | null; email: string | null }>;

export class OrganizationsService {
  private readonly orgs: Collection<OrganizationDoc>;
  private readonly members: Collection<MembershipDoc>;

  constructor(
    db: Db,
    private readonly clock: Clock,
    private readonly accounts: AccountsApi,
    private readonly notifications: () => NotificationsApi,
  ) {
    this.orgs = db.collection<OrganizationDoc>('organizations');
    this.members = db.collection<MembershipDoc>('memberships');
  }

  private payout(phone: string | null | undefined) {
    if (!phone) return null;
    const p = normalizePhone(phone);
    if (!p) throw errors.validation('Numéro de paiement invalide.', { field: 'payoutPhone' });
    return { phone: p };
  }

  private email(input: string | null | undefined) {
    if (!input) return null;
    const v = normalizeEmail(input);
    if (!v) throw errors.validation('Adresse e-mail invalide.', { field: 'email' });
    return v;
  }

  async create(input: CreateOrgInput): Promise<OrganizationDoc> {
    const now = this.clock.now();
    const doc: OrganizationDoc = {
      _id: new ObjectId(),
      slug: input.slug,
      name: input.name.trim(),
      category: input.category,
      capabilities: [...new Set(input.capabilities)],
      level: input.level ?? 'nouveau',
      stats: { ratingAvg: null, ratingCount: 0, tripsCount: 0 },
      status: 'active',
      payoutAccount: this.payout(input.payoutPhone),
      email: this.email(input.email),
      logo: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.orgs.insertOne(doc);
    } catch (err) {
      if (isDuplicateKey(err, 'slug_unique')) throw errors.conflict('SLUG_TAKEN', 'Cet identifiant est déjà utilisé.');
      throw err;
    }
    return doc;
  }

  /**
   * A number per provider (Wave, Orange Money): null takes it off. Each is checked as a Senegalese mobile number.
   */
  async setPayoutNumbers(id: ObjectId, numbers: Partial<Record<PayoutProvider, string | null>>) {
    const $set: Document = { updatedAt: this.clock.now() };
    const $unset: Document = {};
    for (const p of PAYOUT_PROVIDERS) {
      if (!(p in numbers)) continue;
      const n = numbers[p];
      if (!n) $unset[`payoutAccounts.${p}`] = '';
      else {
        const phone = normalizePhone(n);
        if (!phone) throw errors.validation(`Numéro ${p === 'wave' ? 'Wave' : 'Orange Money'} invalide.`, { field: `payoutNumbers.${p}` });
        $set[`payoutAccounts.${p}`] = phone;
      }
    }
    await this.orgs.updateOne({ _id: id }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) });
  }

  /** Where a payout through `provider` goes: its own number, else the organization's one. */
  async payoutNumbers(id: ObjectId) {
    const o = await this.get(id);
    return Object.fromEntries(PAYOUT_PROVIDERS.map((p) => [p, o.payoutAccounts?.[p] ?? o.payoutAccount?.phone ?? null])) as Record<PayoutProvider, string | null>;
  }

  async update(id: ObjectId, input: UpdateOrgInput) {
    const $set: Partial<OrganizationDoc> = { updatedAt: this.clock.now() };
    if (input.name !== undefined) $set.name = input.name.trim();
    if (input.category !== undefined) $set.category = input.category;
    if (input.level !== undefined) $set.level = input.level;
    if (input.status !== undefined) $set.status = input.status;
    if (input.payoutPhone !== undefined) $set.payoutAccount = this.payout(input.payoutPhone);
    if (input.email !== undefined) $set.email = this.email(input.email);
    const doc = await this.orgs.findOneAndUpdate({ _id: id }, { $set }, { returnDocument: 'after' });
    if (!doc) throw errors.notFound();
    return doc;
  }

  // ---- Référencement: caravan organizers ---------------------------------------------------------------------

  /** Every organization that runs caravans, with its owner (to call them). */
  async caravanOrganizers() {
    const orgs = await this.orgs.find({ capabilities: 'caravans' }).sort({ name: 1 }).limit(500).toArray();
    const owners = await this.members.find({ orgId: { $in: orgs.map((o) => o._id) }, space: 'organizer', status: 'active', roles: 'owner' }).toArray();
    const users = new Map((await Promise.all([...new Set(owners.map((m) => m.userId.toHexString()))].map((id) => this.accounts.findById(new ObjectId(id))))).filter((u) => !!u).map((u) => [u!._id.toHexString(), u!]));
    return orgs.map((org) => {
      const m = owners.find((x) => x.orgId.equals(org._id));
      const u = m ? users.get(m.userId.toHexString()) : undefined;
      return { org, owner: u ? { firstName: u.firstName, lastName: u.lastName, phone: u.phone } : null };
    });
  }

  /** The caravan organizer this account already owns, if any (caravans are their own space, apart from shops). */
  private async caravanOrgOf(userId: ObjectId) {
    return (await this.membershipsForUser(userId)).find((m) => m.roles.includes('owner') && m.capabilities.includes('caravans')) ?? null;
  }

  /** Before adding: the account of this number, and the caravan organizer it already runs (one per account). */
  async caravanOwnerLookup(phoneInput: string) {
    const phone = this.accounts.phoneOrThrow(phoneInput);
    const user = await this.accounts.findByPhone(phone);
    if (!user || user.status === 'deleted') return { account: null, organizer: null };
    const org = await this.caravanOrgOf(user._id);
    return { account: { firstName: user.firstName, lastName: user.lastName }, organizer: org ? { name: org.name } : null };
  }

  /**
   * A transport company or an amicale that sells caravan seats: always its own organization (its own organizer space),
   * never joined to a shop or a restaurant the owner may run. An account is created for a new number. Seats are paid to
   * the payout number, the owner's by default.
   */
  async createCaravanOrganizer(input: { name: string; category: OrgCategory; level?: OrgLevel; payoutPhone?: string; owner: { phone: string; firstName?: string; lastName?: string; password?: string } }) {
    const phone = this.accounts.phoneOrThrow(input.owner.phone);
    const known = await this.accounts.findByPhone(phone);
    const existing = known ? await this.caravanOrgOf(known._id) : null;
    if (existing) throw errors.conflict('ALREADY_ORGANIZER', `Ce numéro gère déjà « ${existing.name} ».`);
    if (!known && (!input.owner.firstName || !input.owner.lastName)) throw errors.validation('Indique le prénom et le nom du responsable.', { field: 'owner' });
    const owner = known ?? (await this.accounts.createStaffUser({ phone, firstName: input.owner.firstName!, lastName: input.owner.lastName!, password: input.owner.password }));
    const base = input.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'organisateur';
    const org = await this.create({
      slug: `${base}-${randomCode(4).toLowerCase()}`, name: input.name, category: input.category, capabilities: ['caravans'], level: input.level ?? 'verifie',
      payoutPhone: input.payoutPhone ?? owner.phone,
    });
    await this.setOwner(org._id, phone, null);
    return org;
  }

  list() {
    return this.orgs.find({}).sort({ name: 1 }).limit(500).toArray();
  }

  async get(id: ObjectId) {
    const doc = await this.orgs.findOne({ _id: id });
    if (!doc) throw errors.notFound();
    return doc;
  }

  async setRating(orgId: ObjectId, avg: number | null, count: number) {
    await this.orgs.updateOne({ _id: orgId }, { $set: { 'stats.ratingAvg': avg, 'stats.ratingCount': count, updatedAt: this.clock.now() } });
  }

  async countTrip(orgId: ObjectId) {
    await this.orgs.updateOne({ _id: orgId }, { $inc: { 'stats.tripsCount': 1 }, $set: { updatedAt: this.clock.now() } });
  }

  /** Public cards of several organizations (listings show who runs each departure). */
  async cards(ids: ObjectId[]): Promise<Map<string, OrgCard>> {
    const docs = ids.length ? await this.orgs.find({ _id: { $in: ids } }).toArray() : [];
    return new Map(docs.map((o) => [o._id.toHexString(), orgCard(o)]));
  }

  /** The spaces this organization has (its capabilities): where members can be added. */
  async spaces(orgId: ObjectId) {
    return spacesOf(await this.get(orgId));
  }

  /** Adds a capability (a shop for a restaurant, a student's own shop): its space opens for the owners. */
  async addCapability(orgId: ObjectId, capability: OrgCapability) {
    const org = await this.orgs.findOneAndUpdate({ _id: orgId }, { $addToSet: { capabilities: capability }, $set: { updatedAt: this.clock.now() } }, { returnDocument: 'after' });
    if (!org) throw errors.notFound();
    const owners = await this.members.distinct('userId', { orgId, status: 'active', roles: 'owner' });
    for (const userId of owners) await this.grant(orgId, userId, spacesOf(org), ['owner'], null);
    return org;
  }

  /** Step 1 of adding someone: does this number already have an account? Only the first name shows (to confirm). */
  async lookup(phoneInput: string, orgId?: ObjectId) {
    const phone = this.accounts.phoneOrThrow(phoneInput);
    const user = await this.accounts.findByPhone(phone);
    if (!user || user.status === 'deleted') return { exists: false as const };
    // Already in the team: their roles, so the owner edits them instead of starting over.
    const assignments = orgId ? await this.rolesOf(orgId, user._id) : [];
    return { exists: true as const, firstName: user.firstName, lastName: user.lastName.slice(0, 1) + '.', assignments };
  }

  /**
   * Step 2: gives roles in one space to an account (by phone). An existing account is linked; a new number gets an
   * account with the first name, last name and password given (all required then). The person is notified.
   */
  async setMember(orgId: ObjectId, space: OrgSpace, input: NewMember, grantedBy: ObjectId | null) {
    const org = await this.get(orgId);
    if (!spacesOf(org).includes(space)) throw errors.rule('SPACE_NOT_OPEN', `${org.name} n’a pas d’espace ${SPACE_LABELS[space].toLowerCase()}.`);
    const phone = this.accounts.phoneOrThrow(input.phone);
    let user = await this.accounts.findByPhone(phone);
    let created = false;
    if (!user || user.status === 'deleted') {
      if (!input.firstName?.trim() || !input.lastName?.trim() || !input.password?.trim()) {
        throw errors.rule('USER_NOT_FOUND', 'Aucun compte avec ce numéro : indique son prénom, son nom et un mot de passe pour le créer.');
      }
      user = await this.accounts.createStaffUser({ phone, firstName: input.firstName, lastName: input.lastName, password: input.password });
      created = true;
    }
    const roles = [...new Set(input.roles)];
    await this.grant(orgId, user._id, [space], roles, grantedBy);
    if (grantedBy) {
      const role = roles.map((r) => ROLE_LABELS[r]).join(', ');
      await this.notifications().notify([user._id], {
        type: 'org.member_added', category: 'social', icon: 'people-outline', tone: 'primary', url: `/espace?vers=${encodeURIComponent(spaceKey(space, orgId))}`,
        dedupeKey: `member:${orgId.toHexString()}:${space}:${user._id.toHexString()}:${roles.join('+')}:${this.clock.now().getTime()}`,
        title: `Tu rejoins ${org.name} · ${SPACE_LABELS[space]}`,
        body: `Rôle : ${role}. Ouvre l’espace depuis ton profil, « Mes espaces ».`,
      });
    }
    return { userId: user._id, roles, created };
  }

  // ---- "Mon équipe": the whole entity, every space at once ----------------------------------------------------------

  /** The roles the owner can give, space by space (the entity's spaces only), and everyone with their roles. */
  async team(orgId: ObjectId) {
    const org = await this.get(orgId);
    const spaces = spacesOf(org);
    const list = await this.members.find({ orgId, status: 'active', space: { $in: spaces } }).toArray();
    const ids = [...new Set(list.map((m) => m.userId.toHexString()))];
    const users = new Map((await Promise.all(ids.map((id) => this.accounts.findById(new ObjectId(id))))).flatMap((u) => (u ? [[u._id.toHexString(), u] as const] : [])));
    const members = ids.map((id) => {
      const mine = list.filter((m) => m.userId.toHexString() === id).sort((a, b) => spaces.indexOf(a.space) - spaces.indexOf(b.space));
      const u = users.get(id);
      return {
        userId: id, firstName: u?.firstName ?? '', lastName: u?.lastName ?? '', owner: mine.some((m) => m.roles.includes('owner')),
        spaces: mine.map((m) => ({ space: m.space, label: SPACE_LABELS[m.space], roles: m.roles.map((r) => ({ value: r, label: ROLE_LABELS[r] })) })),
      };
    });
    // The owner first, then by first name.
    members.sort((a, b) => Number(b.owner) - Number(a.owner) || a.firstName.localeCompare(b.firstName, 'fr'));
    return { spaces: spaces.map((sp) => ({ space: sp, label: SPACE_LABELS[sp], roles: SPACE_ROLES[sp].map((r) => ({ value: r, label: ROLE_LABELS[r] })) })), members };
  }

  /** A member's current roles in this entity, space by space (the editor pre-ticks them). */
  async rolesOf(orgId: ObjectId, userId: ObjectId) {
    const list = await this.members.find({ orgId, userId, status: 'active' }).toArray();
    return list.map((m) => ({ space: m.space, roles: m.roles }));
  }

  /**
   * Sets someone's roles in every space of the entity at once (Gérant of the restaurant and Contrôleur of the
   * caravans…): a space left without roles is taken away. By phone (a new number gets an account with the name and
   * password given) or by userId (an existing member). The owner's own memberships are the platform admins' call.
   */
  async setTeamMember(orgId: ObjectId, input: { phone?: string; userId?: ObjectId; firstName?: string; lastName?: string; password?: string; assignments: { space: OrgSpace; roles: OrgRole[] }[] }, grantedBy: ObjectId) {
    const org = await this.get(orgId);
    const open = spacesOf(org);
    for (const a of input.assignments) {
      if (!open.includes(a.space)) throw errors.rule('SPACE_NOT_OPEN', `${org.name} n’a pas d’espace ${SPACE_LABELS[a.space].toLowerCase()}.`);
      if (a.roles.some((r) => !SPACE_ROLES[a.space].includes(r))) throw errors.forbidden('Ce rôle n’existe pas dans cet espace.');
    }
    const wanted = new Map(open.map((sp) => [sp, [...new Set(input.assignments.filter((a) => a.space === sp).flatMap((a) => a.roles))]]));
    if (![...wanted.values()].some((r) => r.length)) throw errors.validation('Choisis au moins un rôle.', { field: 'assignments' });

    let user = input.userId ? await this.accounts.findById(input.userId) : await this.accounts.findByPhone(this.accounts.phoneOrThrow(input.phone ?? ''));
    let created = false;
    if (!user || user.status === 'deleted') {
      if (input.userId) throw errors.notFound('Membre introuvable.');
      if (!input.firstName?.trim() || !input.lastName?.trim() || !input.password?.trim()) {
        throw errors.rule('USER_NOT_FOUND', 'Aucun compte avec ce numéro : indique son prénom, son nom et un mot de passe pour le créer.');
      }
      user = await this.accounts.createStaffUser({ phone: this.accounts.phoneOrThrow(input.phone!), firstName: input.firstName, lastName: input.lastName, password: input.password });
      created = true;
    }
    const before = await this.members.find({ orgId, userId: user._id, status: 'active' }).toArray();
    if (before.some((m) => m.roles.includes('owner'))) throw errors.forbidden('Les rôles du propriétaire ne se modifient pas ici.');

    const added: string[] = [];
    const now = this.clock.now();
    for (const [space, roles] of wanted) {
      const had = before.find((m) => m.space === space)?.roles ?? [];
      if (roles.length) {
        await this.grant(orgId, user._id, [space], roles, grantedBy);
        const fresh = roles.filter((r) => !had.includes(r));
        if (fresh.length) added.push(`${SPACE_LABELS[space]} : ${fresh.map((r) => ROLE_LABELS[r]).join(', ')}`);
      } else if (had.length) {
        await this.members.updateOne({ orgId, userId: user._id, space, status: 'active' }, { $set: { status: 'revoked', updatedAt: now } });
      }
    }
    if (added.length) {
      const first = open.find((sp) => wanted.get(sp)!.length)!;
      await this.notifications().notify([user._id], {
        type: 'org.member_added', category: 'social', icon: 'people-outline', tone: 'primary', url: `/espace?vers=${encodeURIComponent(spaceKey(first, orgId))}`,
        dedupeKey: `member:${orgId.toHexString()}:${user._id.toHexString()}:${now.getTime()}`,
        title: before.length ? `Nouveau rôle chez ${org.name}` : `Tu rejoins ${org.name}`,
        body: `${added.join(' · ')}. Ouvre l’espace depuis ton profil, « Mes espaces ».`,
      });
    }
    return { userId: user._id, created, assignments: [...wanted].map(([space, roles]) => ({ space, roles })) };
  }

  /** Out of the team: every space of the entity at once (the owner stays). */
  async removeFromTeam(orgId: ObjectId, userId: ObjectId) {
    const org = await this.get(orgId);
    const list = await this.members.find({ orgId, userId, status: 'active' }).toArray();
    if (!list.length) throw errors.notFound('Membre introuvable.');
    if (list.some((m) => m.roles.includes('owner'))) throw errors.forbidden('Le propriétaire ne se retire pas de l’équipe.');
    await this.members.updateMany({ orgId, userId, status: 'active' }, { $set: { status: 'revoked', updatedAt: this.clock.now() } });
    await this.notifications().notify([userId], {
      type: 'org.role_removed', category: 'social', icon: 'people-outline', tone: 'warning', url: null,
      dedupeKey: `team-removed:${orgId.toHexString()}:${userId.toHexString()}:${this.clock.now().getTime()}`,
      title: `Tu ne fais plus partie de ${org.name}`,
      body: 'Tes accès à ses espaces sont retirés.',
    });
  }

  /** One role taken away; the person keeps their other roles (the space closes with its last one). */
  async removeRole(orgId: ObjectId, userId: ObjectId, space: OrgSpace, role: OrgRole) {
    const org = await this.get(orgId);
    const m = await this.members.findOne({ orgId, userId, space, status: 'active', roles: role });
    if (!m) throw errors.notFound('Ce rôle n’est pas attribué.');
    if (m.roles.includes('owner')) throw errors.forbidden('Les rôles du propriétaire ne se modifient pas ici.');
    const roles = m.roles.filter((r) => r !== role);
    await this.members.updateOne({ _id: m._id }, { $set: roles.length ? { roles, updatedAt: this.clock.now() } : { status: 'revoked', updatedAt: this.clock.now() } });
    await this.notifications().notify([userId], {
      type: 'org.role_removed', category: 'social', icon: 'people-outline', tone: 'warning', url: null,
      dedupeKey: `role-removed:${m._id.toHexString()}:${role}:${this.clock.now().getTime()}`,
      title: `Rôle retiré chez ${org.name}`,
      body: `${SPACE_LABELS[space]} : tu n’es plus ${ROLE_LABELS[role].toLowerCase()}.`,
    });
    return { remaining: roles };
  }

  /** Writes the memberships (one per space). Re-granting replaces the roles and reactivates. */
  private async grant(orgId: ObjectId, userId: ObjectId, spaces: OrgSpace[], roles: OrgRole[], grantedBy: ObjectId | null) {
    const now = this.clock.now();
    for (const space of spaces) {
      await this.members.updateOne(
        { orgId, userId, space },
        { $set: { roles, status: 'active', grantedBy, updatedAt: now }, $setOnInsert: { _id: new ObjectId(), createdAt: now } },
        { upsert: true },
      );
    }
  }

  /** The platform admins name an owner: they hold every space of the organization. */
  async setOwner(orgId: ObjectId, phone: string, grantedBy: ObjectId | null) {
    const org = await this.get(orgId);
    const user = await this.accounts.findByPhone(this.accounts.phoneOrThrow(phone));
    if (!user) throw errors.rule('USER_NOT_FOUND', 'Aucun compte avec ce numéro.');
    await this.grant(orgId, user._id, spacesOf(org), ['owner'], grantedBy);
    return user._id;
  }

  /** Removed from a space: no access to it any more (an owner can't be removed by a member). */
  async revokeMember(orgId: ObjectId, space: OrgSpace, userId: ObjectId) {
    const res = await this.members.updateOne({ orgId, space, userId, status: 'active', roles: { $ne: 'owner' } }, { $set: { status: 'revoked', updatedAt: this.clock.now() } });
    if (res.matchedCount === 0) throw errors.notFound();
  }

  async listMembers(orgId: ObjectId, space: OrgSpace) {
    const list = await this.members.find({ orgId, space, status: 'active' }).toArray();
    const users = await Promise.all(list.map((m) => this.accounts.findById(m.userId)));
    return list.map((m, i) => ({ userId: m.userId.toHexString(), roles: m.roles, firstName: users[i]?.firstName ?? '', lastName: users[i]?.lastName ?? '' }));
  }

  async membershipsForUser(userId: ObjectId): Promise<MembershipSummary[]> {
    const list = await this.members.find({ userId, status: 'active' }).toArray();
    if (!list.length) return [];
    const orgs = await this.orgs.find({ _id: { $in: list.map((m) => m.orgId) }, status: 'active' }).toArray();
    const byId = new Map(orgs.map((o) => [o._id.toHexString(), o]));
    return list.flatMap((m) => {
      const o = byId.get(m.orgId.toHexString());
      // A space the organization no longer has (capability removed) stays closed.
      if (!o || !spacesOf(o).includes(m.space)) return [];
      return [{ orgId: o._id.toHexString(), name: o.name, category: o.category, level: o.level, roles: m.roles, capabilities: o.capabilities, space: m.space, logoUrl: o.logo?.url ?? null }];
    });
  }

  /**
   * Active membership of an active organization with one of `roles` (owner can do everything), in `space` (or any
   * space when omitted). Null otherwise.
   */
  async roleIn(orgId: ObjectId, userId: ObjectId, roles: OrgRole[], space?: OrgSpace): Promise<OrgRole[] | null> {
    const m = await this.members.findOne({ orgId, userId, status: 'active', ...(space ? { space } : { roles: { $in: roles.length ? [...roles, 'owner'] : ['owner'] } }) });
    if (!m) return null;
    const org = await this.orgs.findOne({ _id: orgId, status: 'active' }, { projection: { _id: 1 } });
    if (!org) return null;
    return m.roles.includes('owner') || m.roles.some((r) => roles.includes(r)) ? m.roles : null;
  }
}

export function orgView(o: OrganizationDoc) {
  return {
    id: o._id.toHexString(),
    slug: o.slug,
    name: o.name,
    category: o.category,
    capabilities: o.capabilities,
    level: o.level,
    rating: o.stats.ratingAvg,
    trips: o.stats.tripsCount,
    status: o.status,
    hasPayoutAccount: !!o.payoutAccount,
    email: o.email,
    /** Null until the media module ships (logo upload). */
    logoUrl: o.logo?.url ?? null,
  };
}

/** What students see of an organizer: no contact details, no payout account. */
export type OrgCard = { id: string; slug: string; name: string; category: OrganizationDoc['category']; level: OrganizationDoc['level']; rating: number | null; trips: number; logoUrl: string | null };
export const orgCard = (o: OrganizationDoc): OrgCard => ({
  id: o._id.toHexString(),
  slug: o.slug,
  name: o.name,
  category: o.category,
  level: o.level,
  rating: o.stats.ratingAvg,
  trips: o.stats.tripsCount,
  logoUrl: o.logo?.url ?? null,
});
