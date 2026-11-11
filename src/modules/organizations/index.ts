import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { ObjectId, type Db } from 'mongodb';

import { actorOf } from '../../platform/auth/auth.js';
import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import { toObjectId } from '../../platform/http/schemas.js';
import type { AccountsApi, OrganizationsPort } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { organizationsCollections, organizationsMigrations } from './organizations.collections.js';
import { registerOrganizationsRoutes } from './organizations.routes.js';
import { OrganizationsService, type CreateOrgInput } from './organizations.service.js';
import { ORG_SPACES, type OrgCapability, type OrgRole, type OrgSpace, type PayoutProvider } from './organizations.types.js';
import type { MediaUsage } from '../media/index.js';

export { organizationsCollections, organizationsMigrations };
export type { OrgCapability, OrgRole, OrgLevel, OrgCategory, OrgSpace, PayoutProvider } from './organizations.types.js';
export { ORG_SPACES, PAYOUT_PROVIDERS, spacesOf } from './organizations.types.js';
export type { OrgCard } from './organizations.service.js';

export type OrganizationsApi = OrganizationsPort & {
  /**
   * Guard for /org/:orgId/... routes: 404 unless the caller holds one of `roles` in `space` (no existence oracle).
   * `space: 'param'` reads it from the route (`/org/:orgId/:space/...`).
   */
  requireOrgRole(roles: OrgRole[], space?: OrgSpace | 'param'): preHandlerHookHandler;
  roleIn: OrganizationsService['roleIn'];
  create(input: CreateOrgInput): ReturnType<OrganizationsService['create']>;
  setMember: OrganizationsService['setMember'];
  setOwner: OrganizationsService['setOwner'];
  addCapability: OrganizationsService['addCapability'];
  cards: OrganizationsService['cards'];
  /** Active members of a space and their roles: who to notify (a restaurant's new order), who owns it. */
  members(orgId: ObjectId, space: OrgSpace): Promise<{ userId: ObjectId; roles: OrgRole[] }[]>;
  /** Where an organization's claims are paid (through `provider`: its own number if set); null until one is set. */
  payoutPhone(orgId: ObjectId, provider?: string): Promise<string | null>;
  /** Each provider's number (its own, else the organization's): shown to the owner and Référencement only. */
  payoutNumbers(orgId: ObjectId): Promise<Record<PayoutProvider, string | null>>;
  setPayoutNumbers(orgId: ObjectId, numbers: Partial<Record<PayoutProvider, string | null>>): Promise<void>;
  /** Owners and managers of every active organization: told when a payment method is switched off app-wide. */
  teamLeadIds(): Promise<ObjectId[]>;
  /** Is the organization active and verified for this (e.g. selling event tickets)? */
  can(orgId: ObjectId, capability: OrgCapability): Promise<boolean>;
  /**
   * A student's own organization (category `Étudiant`), created the first time they organize an event: they own it,
   * its payouts go to their number, and their events go through the admins' review.
   */
  personalOrg(user: { _id: ObjectId; firstName: string; lastName: string; phone: string }, create?: boolean): Promise<ObjectId | null>;
  isPersonal(orgId: ObjectId): Promise<boolean>;
  /** The entities this person owns (active ones), and whether each is a student's own. */
  /** The entities a restaurant or a shop can join. Never a caravan organizer: caravans are a space of their own. */
  ownedBy(userId: ObjectId): Promise<{ orgId: ObjectId; name: string; personal: boolean; organizer: boolean }[]>;
  /** Adds a finished trip to the organizer's count ("128 trajets effectués"). */
  countTrip(orgId: ObjectId): Promise<void>;
  /** The students' average rating of its trips and events (ratings module). */
  setRating(orgId: ObjectId, avg: number | null, count: number): Promise<void>;
  registerRoutes(app: FastifyInstance, requireAdmin: preHandlerHookHandler, requireCaravanEditor: preHandlerHookHandler): void;
};

/** Organization logos. The media module deletes a picture once none of these reference it. */
export const ORGANIZATIONS_MEDIA_USAGE: MediaUsage[] = [{ collection: 'organizations', path: 'logo.mediaId' }];

export function createOrganizationsModule(deps: { db: Db; clock: Clock; accounts: AccountsApi; audit: AuditApi; notifications: () => NotificationsApi }): OrganizationsApi {
  const service = new OrganizationsService(deps.db, deps.clock, deps.accounts, deps.notifications);

  const requireOrgRole = (roles: OrgRole[], space?: OrgSpace | 'param'): preHandlerHookHandler => async (req) => {
    const params = req.params as { orgId?: string; space?: string };
    if (!params.orgId) throw errors.notFound();
    const s = space === 'param' ? params.space : space;
    if (space === 'param' && !ORG_SPACES.includes(s as OrgSpace)) throw errors.notFound();
    if (!(await service.roleIn(toObjectId(params.orgId), toObjectId(actorOf(req).userId), roles, s as OrgSpace | undefined))) throw errors.notFound();
  };

  return {
    membershipsForUser: (userId) => service.membershipsForUser(userId),
    roleIn: (o, u, r, sp) => service.roleIn(o, u, r, sp),
    create: (i) => service.create(i),
    setMember: (o, sp, i, g) => service.setMember(o, sp, i, g),
    setOwner: (o, p, g) => service.setOwner(o, p, g),
    addCapability: (o, c) => service.addCapability(o, c),
    cards: (ids) => service.cards(ids),
    members: async (orgId, space) => (await deps.db.collection('memberships').find({ orgId, space, status: 'active' }, { projection: { userId: 1, roles: 1 } }).toArray()).map((m) => ({ userId: m.userId, roles: m.roles })),
    teamLeadIds: () => service.teamLeadIds(),
    payoutPhone: async (orgId, provider) => {
      const o = await service.get(orgId);
      return (provider && o.payoutAccounts?.[provider as PayoutProvider]) || o.payoutAccount?.phone || null;
    },
    payoutNumbers: (orgId) => service.payoutNumbers(orgId),
    setPayoutNumbers: (orgId, n) => service.setPayoutNumbers(orgId, n),
    personalOrg: async (user, create = true) => {
      const slug = `etudiant-${user._id.toHexString()}`;
      const existing = await deps.db.collection('organizations').findOne({ slug }, { projection: { _id: 1 } });
      if (existing || !create) return existing?._id ?? null;
      const org = await service.create({ slug, name: `${user.firstName} ${user.lastName}`, category: 'Étudiant', capabilities: [], level: 'nouveau', payoutPhone: user.phone }).catch(async (err) => {
        // Created at the same moment by another request.
        const again = await deps.db.collection('organizations').findOne({ slug }, { projection: { _id: 1 } });
        if (again) return { _id: again._id };
        throw err;
      });
      await service.setOwner(org._id, user.phone, null);
      return org._id;
    },
    isPersonal: async (orgId) => (await service.get(orgId).catch(() => null))?.category === 'Étudiant',
    ownedBy: async (userId) => {
      const owned = (await service.membershipsForUser(userId)).filter((m) => m.roles.includes('owner') && !m.capabilities.includes('caravans'));
      const byOrg = new Map(owned.map((m) => [m.orgId, { orgId: new ObjectId(m.orgId), name: m.name, personal: m.category === 'Étudiant', organizer: m.capabilities.includes('caravans') || m.capabilities.includes('events') }]));
      return [...byOrg.values()];
    },
    can: async (orgId, capability) => {
      const o = await service.get(orgId).catch(() => null);
      return !!o && o.status === 'active' && o.capabilities.includes(capability);
    },
    countTrip: (orgId) => service.countTrip(orgId),
    setRating: (orgId, avg, count) => service.setRating(orgId, avg, count),
    requireOrgRole,
    registerRoutes: (app, requireAdmin, requireCaravanEditor) => registerOrganizationsRoutes(app, { service, audit: deps.audit, requireAdmin, requireCaravanEditor, requireOrgRole }),
  };
}
