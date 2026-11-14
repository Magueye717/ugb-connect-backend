import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db, MongoClient, ObjectId } from 'mongodb';

import { actorOf } from '../../platform/auth/auth.js';
import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import { withTransaction } from '../../platform/db/mongo.js';
import { normalizePhone } from '../../platform/phone.js';
import { hashPassword } from '../../platform/security/passwords.js';
import { toObjectId } from '../../platform/http/schemas.js';
import type { AuditApi } from '../audit/index.js';
import type { MediaApi, MediaUsage } from '../media/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { accountsCollections, accountsMigrations } from './accounts.collections.js';
import { AccountsRepository } from './accounts.repository.js';
import { registerAccountsRoutes } from './accounts.routes.js';
import { AccountsService } from './accounts.service.js';
import { PlatformTeam, registerTeamRoutes } from './accounts.team.js';
import type { OrganizationsPort, PlatformRole } from './accounts.types.js';

export type { StudentCard } from './accounts.service.js';
export type { Audience, AudienceProfile, Campus, NewStudentAccount, OrganizationsPort, MembershipSummary, Niveau, PlatformRole, Region, UfrCode, UserDoc } from './accounts.types.js';
export { CAMPUS_LABELS, CAMPUSES, NIVEAUX, PLATFORM_ROLE_LABELS, PLATFORM_ROLES, REGIONS, STORED_STUDENT_NUMBER_RE, STUDENT_NUMBER_MAX, STUDENT_NUMBER_RE, UFR_CODES, UFRS, VILLAGES } from './accounts.types.js';
export type { StudentProfileInput } from './accounts.service.js';
export { CampusSchema, NiveauInput, RegionInput, UfrInput } from './accounts.schemas.js';
export { accountsCollections, accountsMigrations };

/** Public surface of the accounts module. Other modules get this object, never the repository. */
export type AccountsApi = Pick<
  AccountsService,
  | 'normalizeStudentNumber' | 'normalizeName' | 'residence' | 'phoneOrThrow' | 'availability' | 'canRegister' | 'createStudentAccount'
  | 'origin' | 'audienceOf' | 'userIdsInAudience' | 'studentByNumber' | 'searchStudents'
  | 'findForLogin' | 'findByPhone' | 'findById' | 'namesByIds' | 'contactsByIds' | 'hasStudentProfile' | 'notificationPrefsByIds' | 'recordLoginFailure' | 'recordLoginSuccess' | 'setPassword'
  | 'createStaffUser' | 'setPlatformRoles' | 'hasAnySpace' | 'hasPlatformRole' | 'markCardRead' | 'claimStudentNumber' | 'changePhone' | 'setAvatar'
> & {
  requireStudent: preHandlerHookHandler;
  requirePlatformRole(role: PlatformRole): preHandlerHookHandler;
  /** Any of these roles (admins always pass). */
  requireAnyPlatformRole(roles: PlatformRole[]): preHandlerHookHandler;
  /** The public restaurants a menu publisher handles; null: all (admins). */
  restosOf(userId: ObjectId): Promise<ObjectId[] | null>;
  registerRoutes(app: FastifyInstance): void;
};

/** Profile pictures. The media module deletes a picture once none of these reference it. */
export const ACCOUNTS_MEDIA_USAGE: MediaUsage[] = [{ collection: 'users', path: 'avatar.mediaId' }];

/**
 * Deploys: the first administrator (platform role `admin`), from the server's settings. Only when no account uses this
 * phone yet: an existing one is left exactly as it is (its password and roles are never changed here).
 */
export async function ensureBootstrapAdmin(db: Db, clock: Clock, input: { phone: string; password: string; firstName: string; lastName: string }): Promise<'created' | 'exists'> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error('BOOTSTRAP_ADMIN_PHONE is not a valid Senegalese number');
  const service = new AccountsService(new AccountsRepository(db), clock, () => {
    throw new Error('Organizations are not available while bootstrapping the administrator');
  });
  if (await service.findByPhone(phone)) return 'exists';
  const user = await service.createStaffUser({ phone, password: input.password, firstName: input.firstName, lastName: input.lastName });
  // The first administrator also runs the team, the payment switches and the notifications (the explicit roles).
  await service.setPlatformRoles(user._id, ['admin', 'payments_manager', 'notifications_sender', 'team_manager']);
  return 'created';
}

/**
 * Deploys: the student account the store reviewers (Google Play, App Store) sign in with, « Student Test », from the
 * server's settings. Only when no account uses this phone yet: an existing one is left exactly as it is.
 */
export async function ensureReviewStudent(client: MongoClient, db: Db, clock: Clock, input: { phone: string; password: string; termsVersion: string }): Promise<'created' | 'exists'> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error('REVIEW_STUDENT_PHONE is not a valid Senegalese number');
  const service = new AccountsService(new AccountsRepository(db), clock, () => {
    throw new Error('Organizations are not available while creating the review account');
  });
  if (await service.findByPhone(phone)) return 'exists';
  const passwordHash = await hashPassword(input.password);
  await withTransaction(client, (session) =>
    service.createStudentAccount(
      {
        phone, studentNumber: null, firstName: 'Student', lastName: 'Test', campus: 'campus1', onCampus: true, village: 'Village E', room: '101',
        ufr: 'SAT', region: 'Saint-Louis', niveau: 'Licence 1', passwordHash, termsVersion: input.termsVersion,
      },
      session,
    ),
  );
  return 'created';
}

export function createAccountsModule(deps: { db: Db; clock: Clock; rentree: string; audit: AuditApi; organizations: () => OrganizationsPort; notifications: () => NotificationsApi; media: () => Pick<MediaApi, 'claim' | 'release'> }): AccountsApi {
  const service = new AccountsService(new AccountsRepository(deps.db), deps.clock, deps.organizations, deps.rentree);
  const team = new PlatformTeam(deps.db, deps.clock, service, deps.notifications);

  const requireStudent: preHandlerHookHandler = async (req) => {
    if (!(await service.hasStudentProfile(toObjectId(actorOf(req).userId)))) throw errors.forbidden('Réservé aux étudiants.');
  };
  const requirePlatformRole = (role: PlatformRole): preHandlerHookHandler => async (req) => {
    if (!(await service.hasPlatformRole(toObjectId(actorOf(req).userId), role))) throw errors.forbidden();
  };
  const requireAnyPlatformRole = (roles: PlatformRole[]): preHandlerHookHandler => async (req) => {
    const userId = toObjectId(actorOf(req).userId);
    for (const role of roles) if (await service.hasPlatformRole(userId, role)) return;
    throw errors.forbidden();
  };

  return {
    normalizeStudentNumber: (v) => service.normalizeStudentNumber(v),
    normalizeName: (v, f) => service.normalizeName(v, f),
    residence: (i) => service.residence(i),
    phoneOrThrow: (v) => service.phoneOrThrow(v),
    origin: (i) => service.origin(i),
    audienceOf: (u) => service.audienceOf(u),
    studentByNumber: (n) => service.studentByNumber(n),
    searchStudents: (w, l, e) => service.searchStudents(w, l, e),
    userIdsInAudience: (a) => service.userIdsInAudience(a),
    availability: (p, n) => service.availability(p, n),
    canRegister: (p) => service.canRegister(p),
    createStudentAccount: (i, s) => service.createStudentAccount(i, s),
    findForLogin: (i) => service.findForLogin(i),
    findByPhone: (p, s) => service.findByPhone(p, s),
    findById: (id) => service.findById(id),
    namesByIds: (ids) => service.namesByIds(ids),
    contactsByIds: (ids) => service.contactsByIds(ids),
    hasStudentProfile: (id) => service.hasStudentProfile(id),
    notificationPrefsByIds: (ids) => service.notificationPrefsByIds(ids),
    recordLoginFailure: (id) => service.recordLoginFailure(id),
    recordLoginSuccess: (id) => service.recordLoginSuccess(id),
    setPassword: (id, h, s) => service.setPassword(id, h, s),
    createStaffUser: (i) => service.createStaffUser(i),
    hasAnySpace: (u) => service.hasAnySpace(u),
    markCardRead: (u) => service.markCardRead(u),
    claimStudentNumber: (u, n) => service.claimStudentNumber(u, n),
    changePhone: (u, p) => service.changePhone(u, p),
    setAvatar: (u, a) => service.setAvatar(u, a),
    hasPlatformRole: (u, r) => service.hasPlatformRole(u, r),
    setPlatformRoles: (id, r) => service.setPlatformRoles(id, r),
    requireStudent,
    requirePlatformRole,
    requireAnyPlatformRole,
    restosOf: (u) => team.restosOf(u),
    registerRoutes: (app) => {
      registerAccountsRoutes(app, { service, audit: deps.audit, requireStudent, requireAdmin: requirePlatformRole('admin'), requireTeam: requirePlatformRole('team_manager'), claimImage: (u, id) => deps.media().claim(u, [id]).then((r) => r[0]!), releaseImages: (ids) => deps.media().release(ids) });
      registerTeamRoutes(app, { team, audit: deps.audit, requireAdmin: requirePlatformRole('team_manager') });
    },
  };
}
