import type { MongoClient, ObjectId } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { withTransaction } from '../../platform/db/mongo.js';
import { AppError, errors } from '../../platform/http/errors.js';
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from '../../platform/security/passwords.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { Niveau, AccountsApi, Campus } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { OtpService } from './otp.service.js';
import type { SessionService } from './session.service.js';
import type { DeviceInfo, OtpChannel, OtpPurpose, Tokens } from './identity.types.js';

type Ctx = { ip: string; requestId: string };

export type RegisterInput = {
  verificationToken: string;
  /** Optional: can be added later on the profile. */
  studentNumber?: string | null;
  firstName: string;
  lastName: string;
  campus: Campus;
  onCampus: boolean;
  village?: string | null;
  room?: string | null;
  /** UFR code and home region (GET /reference/student). */
  ufr: string;
  /** Year of study (optional for older apps). */
  niveau?: string;
  region: string;
  password: string;
  termsVersion: string;
  device?: DeviceInfo;
};

/** Only SMS is wired for now; WhatsApp and e-mail wait for their providers (Q-14). */
export function assertChannelAvailable(channel: OtpChannel) {
  if (channel !== 'sms') throw errors.rule('CHANNEL_UNAVAILABLE', 'Ce moyen d’envoi n’est pas encore disponible. Choisis SMS.');
}

// Sign-in and reset say which part is wrong: sign-up step 1 already tells whether a number has an account, so hiding it here
// would protect nothing. Brute force stays bounded by the per-identifier limit and the account lock.
const ACCOUNT_NOT_FOUND = () => new AppError(404, 'ACCOUNT_NOT_FOUND', 'Aucun compte sur ce numéro.');
const WRONG_PASSWORD = () => new AppError(401, 'WRONG_PASSWORD', 'Mot de passe incorrect.');

export class AuthService {
  constructor(
    private readonly mongo: MongoClient,
    private readonly clock: Clock,
    private readonly accounts: AccountsApi,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly limiter: Limiter,
    private readonly audit: AuditApi,
  ) {}

  /** Step 1 of sign-up ("Ce compte existe déjà"). Rate-limited by route: it necessarily tells whether a number is taken. */
  async checkAvailability(input: { phone: string; studentNumber?: string | null }) {
    const phone = this.accounts.phoneOrThrow(input.phone);
    const studentNumber = input.studentNumber?.trim() ? this.accounts.normalizeStudentNumber(input.studentNumber) : null;
    return this.accounts.availability(phone, studentNumber);
  }

  async requestOtp(input: { phone: string; purpose: OtpPurpose; channel: OtpChannel }, ctx: Ctx) {
    assertChannelAvailable(input.channel);
    const phone = this.accounts.phoneOrThrow(input.phone);
    const existing = await this.accounts.findByPhone(phone);
    // Sign-up: a number with a non-student account (a team member) may complete it into a student account.
    if (input.purpose === 'register' && !(await this.accounts.canRegister(phone))) throw errors.conflict('PHONE_TAKEN', 'Ce numéro a déjà un compte.');
    if (input.purpose === 'change_phone' && existing) throw errors.conflict('PHONE_TAKEN', 'Ce numéro a déjà un compte.');
    // Reset: no code for a number without an account (same openness as sign-in, see 09-decisions.md).
    if (input.purpose === 'reset_password' && !existing) throw ACCOUNT_NOT_FOUND();
    return this.otp.create({ phone, purpose: input.purpose, channel: input.channel, ip: ctx.ip });
  }

  async register(input: RegisterInput, ctx: Ctx): Promise<{ userId: ObjectId; tokens: Tokens }> {
    // A space typed by the keyboard around a password is never part of it.
    input = { ...input, password: input.password.trim() };
    const problem = passwordProblem(input.password);
    if (problem) throw errors.validation(problem, { field: 'password' });
    const studentNumber = input.studentNumber?.trim() ? this.accounts.normalizeStudentNumber(input.studentNumber) : null;
    const firstName = this.accounts.normalizeName(input.firstName, 'firstName');
    const lastName = this.accounts.normalizeName(input.lastName, 'lastName');
    const residence = this.accounts.residence({ campus: input.campus, onCampus: input.onCampus, village: input.village, room: input.room });
    const origin = this.accounts.origin({ ufr: input.ufr, region: input.region });
    const passwordHash = await hashPassword(input.password);

    const user = await withTransaction(this.mongo, async (session) => {
      const { phone } = await this.otp.consume(input.verificationToken, 'register', session);
      return this.accounts.createStudentAccount(
        { phone, studentNumber, firstName, lastName, campus: input.campus, ...residence, ...origin, niveau: (input.niveau ?? null) as Niveau | null, passwordHash, termsVersion: input.termsVersion },
        session,
      );
    });
    // A team member's account completed: their password changed, so their other sessions end (as after a reset).
    if (user.linked) await this.sessions.revokeAll(user._id);
    await this.audit.record({ actor: { type: 'user', id: user._id.toHexString() }, action: user.linked ? 'account.register_linked' : 'account.register', target: { type: 'user', id: user._id.toHexString() }, requestId: ctx.requestId, ip: ctx.ip });
    const tokens = await this.sessions.start(user, input.device ?? {}, ctx.ip);
    return { userId: user._id, tokens };
  }

  async login(input: { identifier: string; password: string; device?: DeviceInfo }, ctx: Ctx): Promise<{ userId: ObjectId; tokens: Tokens }> {
    const key = input.identifier.replace(/\s/g, '').toUpperCase();
    await this.limiter.hit(`login:id:${key}`, { limit: 10, windowS: 600 });

    const user = await this.accounts.findForLogin(input.identifier);
    if (!user || !user.passwordHash) throw ACCOUNT_NOT_FOUND();
    // Removed from every team and no student profile: as if the number had no account.
    if (!(await this.accounts.hasAnySpace(user._id))) throw ACCOUNT_NOT_FOUND();
    const now = this.clock.now();
    if (user.login.lockedUntil && user.login.lockedUntil > now) {
      const wait = Math.ceil((user.login.lockedUntil.getTime() - now.getTime()) / 1000);
      throw errors.tooMany('Trop de tentatives. Réessaie plus tard.', wait);
    }
    // Trimmed like at sign-up; an account created before trimming keeps working with its exact password.
    const typed = input.password.trim();
    const ok = (await verifyPassword(user.passwordHash, typed)) || (typed !== input.password && (await verifyPassword(user.passwordHash, input.password)));
    if (!ok) {
      const lockedUntil = await this.accounts.recordLoginFailure(user._id);
      if (lockedUntil) {
        await this.audit.record({ actor: { type: 'system' }, action: 'account.login_locked', target: { type: 'user', id: user._id.toHexString() }, requestId: ctx.requestId, ip: ctx.ip, metadata: { until: lockedUntil } });
      }
      throw WRONG_PASSWORD();
    }
    if (user.status !== 'active') throw errors.forbidden('Ce compte est suspendu. Contacte le support.');

    await this.accounts.recordLoginSuccess(user._id);
    if (needsRehash(user.passwordHash)) await this.accounts.setPassword(user._id, await hashPassword(typed));
    await this.limiter.reset(`login:id:${key}`);
    await this.audit.record({ actor: { type: 'user', id: user._id.toHexString() }, action: 'account.login', target: { type: 'user', id: user._id.toHexString() }, requestId: ctx.requestId, ip: ctx.ip });
    return { userId: user._id, tokens: await this.sessions.start(user, input.device ?? {}, ctx.ip) };
  }

  refresh(refreshToken: string, ctx: Ctx) {
    return this.sessions.refresh(refreshToken, ctx.ip, (id) => this.accounts.findById(id));
  }

  logout(refreshToken: string, userId: string) {
    return this.sessions.logout(refreshToken, userId);
  }

  async logoutAll(userId: ObjectId, ctx: Ctx) {
    await this.sessions.revokeAll(userId);
    await this.audit.record({ actor: { type: 'user', id: userId.toHexString() }, action: 'session.logout_all', target: { type: 'user', id: userId.toHexString() }, requestId: ctx.requestId, ip: ctx.ip });
  }

  /** "Mot de passe oublié": verified phone → new password, every session ends. */
  /** The new number, proven by its code, replaces the old one (sign-in, and refunds when they went to the old one). */
  async changePhone(userId: ObjectId, verificationToken: string, ctx: Ctx) {
    const { phone } = await this.otp.consume(verificationToken, 'change_phone');
    await this.accounts.changePhone(userId, phone);
    await this.audit.record({ actor: { type: 'user', id: userId.toHexString() }, action: 'account.phone_changed', target: { type: 'user', id: userId.toHexString() }, requestId: ctx.requestId, ip: ctx.ip });
  }

  async resetPassword(input: { verificationToken: string; newPassword: string }, ctx: Ctx) {
    input = { ...input, newPassword: input.newPassword.trim() };
    const problem = passwordProblem(input.newPassword);
    if (problem) throw errors.validation(problem, { field: 'newPassword' });
    const passwordHash = await hashPassword(input.newPassword);
    const userId = await withTransaction(this.mongo, async (session) => {
      const { phone } = await this.otp.consume(input.verificationToken, 'reset_password', session);
      const user = await this.accounts.findByPhone(phone, session);
      if (!user) return null;
      await this.accounts.setPassword(user._id, passwordHash, session);
      return user._id;
    });
    if (!userId) return;
    await this.sessions.revokeAll(userId);
    await this.audit.record({ actor: { type: 'user', id: userId.toHexString() }, action: 'account.password_reset', target: { type: 'user', id: userId.toHexString() }, requestId: ctx.requestId, ip: ctx.ip });
  }

  async changePassword(userId: ObjectId, sessionId: string, input: { currentPassword: string; newPassword: string }, ctx: Ctx) {
    input = { ...input, newPassword: input.newPassword.trim() };
    const user = await this.accounts.findById(userId);
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw errors.validation('Mot de passe actuel incorrect.', { field: 'currentPassword' });
    }
    const problem = passwordProblem(input.newPassword);
    if (problem) throw errors.validation(problem, { field: 'newPassword' });
    await this.accounts.setPassword(userId, await hashPassword(input.newPassword));
    await this.sessions.revokeAll(userId, sessionId);
    await this.audit.record({ actor: { type: 'user', id: userId.toHexString() }, action: 'account.password_change', target: { type: 'user', id: userId.toHexString() }, requestId: ctx.requestId, ip: ctx.ip });
  }
}
