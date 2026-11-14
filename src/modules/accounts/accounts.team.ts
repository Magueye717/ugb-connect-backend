import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { ObjectId, type Collection, type Db } from 'mongodb';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import { ObjectIdString, PhoneInput, toObjectId } from '../../platform/http/schemas.js';
import { maskPhone } from '../../platform/phone.js';
import type { AuditApi } from '../audit/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type { AccountsService } from './accounts.service.js';
import { PLATFORM_ROLE_LABELS, PLATFORM_ROLES, ROLE_SPACES, type PlatformRole, type UserDoc } from './accounts.types.js';

/** `userId`: changing a member's roles; `phone`: adding someone (step 2). */
export type TeamInput = { phone?: string; userId?: string; roles: PlatformRole[]; restoIds?: string[]; firstName?: string; lastName?: string; password?: string };

/**
 * The app creator's team, managed by the super admin only: alert publishers, public restaurants' menu publishers (each
 * on the restaurants assigned to them), place, restaurant and shop editors… Adding someone takes two steps (the
 * number, then the roles; a new number gets an account with a name and a password). They are notified.
 */
export class PlatformTeam {
  private readonly users: Collection<UserDoc>;

  constructor(
    db: Db,
    private readonly clock: Clock,
    private readonly accounts: AccountsService,
    private readonly notifications: () => NotificationsApi,
  ) {
    this.users = db.collection<UserDoc>('users');
    this.restos = db.collection('publicRestos');
  }

  private readonly restos: Collection<{ _id: ObjectId; name: string; status: string }>;

  async list() {
    const docs = await this.users.find({ 'platformRoles.0': { $exists: true }, status: { $ne: 'deleted' } }).sort({ firstName: 1, lastName: 1 }).limit(500).toArray();
    const restoIds = [...new Set(docs.flatMap((u) => (u.restoIds ?? []).map((id) => id.toHexString())))].map((id) => new ObjectId(id));
    const restos = new Map((restoIds.length ? await this.restos.find({ _id: { $in: restoIds } }).toArray() : []).map((r) => [r._id.toHexString(), r.name]));
    return docs.map((u) => ({
      userId: u._id.toHexString(), firstName: u.firstName, lastName: u.lastName, phoneMasked: maskPhone(u.phone), roles: u.platformRoles,
      restos: (u.restoIds ?? []).map((id) => ({ id: id.toHexString(), name: restos.get(id.toHexString()) ?? '' })),
    }));
  }

  /** What the super admin can give, with the labels and the space each role opens. */
  roles() {
    return PLATFORM_ROLES.map((r) => ({ value: r, label: PLATFORM_ROLE_LABELS[r], space: ROLE_SPACES.find((s) => (s.roles as readonly string[]).includes(r))?.label ?? null }));
  }

  async lookup(phoneInput: string) {
    const user = await this.accounts.findByPhone(this.accounts.phoneOrThrow(phoneInput));
    return user && user.status !== 'deleted' ? { exists: true as const, firstName: user.firstName, lastName: `${user.lastName.slice(0, 1)}.`, roles: user.platformRoles } : { exists: false as const };
  }

  async set(input: TeamInput, by: ObjectId) {
    const roles = [...new Set(input.roles)];
    if (!roles.length) throw errors.validation('Choisis au moins un rôle.', { field: 'roles' });
    const restoIds = roles.includes('resto_u_staff') ? [...new Set(input.restoIds ?? [])].map(toObjectId) : [];
    if (roles.includes('resto_u_staff')) {
      if (!restoIds.length) throw errors.validation('Choisis le ou les restaurants qu’il gère.', { field: 'restoIds' });
      if ((await this.restos.countDocuments({ _id: { $in: restoIds } })) !== restoIds.length) throw errors.validation('Restaurant inconnu.', { field: 'restoIds' });
    }
    let user = input.userId ? await this.accounts.findById(toObjectId(input.userId)) : null;
    if (input.userId && !user) throw errors.notFound();
    if (!user) {
      if (!input.phone) throw errors.validation('Indique son numéro.', { field: 'phone' });
      const phone = this.accounts.phoneOrThrow(input.phone);
      user = await this.accounts.findByPhone(phone);
      if (user && user.status === 'deleted') user = null;
      if (!user) {
        if (!input.firstName?.trim() || !input.lastName?.trim() || !input.password?.trim()) {
          throw errors.rule('USER_NOT_FOUND', 'Aucun compte avec ce numéro : indique son prénom, son nom et un mot de passe pour le créer.');
        }
        user = await this.accounts.createStaffUser({ phone, firstName: input.firstName, lastName: input.lastName, password: input.password });
      }
    }
    if (user._id.equals(by) && !roles.includes('team_manager')) throw errors.forbidden('Tu ne peux pas retirer ton propre rôle de gestion de l’équipe.');
    const before = user.platformRoles;
    await this.users.updateOne({ _id: user._id }, { $set: { platformRoles: roles, restoIds, updatedAt: this.clock.now() } });
    const added = roles.filter((r) => !before.includes(r));
    if (added.length && !user._id.equals(by)) {
      const space = ROLE_SPACES.find((s) => (s.roles as readonly string[]).some((r) => added.includes(r as PlatformRole)));
      await this.notifications().notify([user._id], {
        type: 'team.role_added', category: 'social', icon: 'shield-checkmark-outline', tone: 'primary', url: space ? `/espace?vers=${space.space}` : null,
        dedupeKey: `team:${user._id.toHexString()}:${roles.join('+')}:${this.clock.now().getTime()}`,
        title: 'Tu rejoins l’équipe UGB Connect',
        body: `Rôle : ${added.map((r) => PLATFORM_ROLE_LABELS[r]).join(', ')}. Ouvre l’espace depuis ton profil, « Mes espaces ».`,
      });
    }
    return { userId: user._id, roles };
  }

  /** Out of the team: no role, no restaurant. Without a student profile or another space, they can't sign in any more. */
  async remove(userId: ObjectId, by: ObjectId) {
    if (userId.equals(by)) throw errors.forbidden('Tu ne peux pas te retirer toi-même.');
    const res = await this.users.updateOne({ _id: userId, 'platformRoles.0': { $exists: true } }, { $set: { platformRoles: [], restoIds: [], updatedAt: this.clock.now() } });
    if (!res.matchedCount) throw errors.notFound();
    // Told, like a member removed from an entity's team (their spaces disappear at once: roles are read per request).
    await this.notifications().notify([userId], {
      type: 'team.role_removed', category: 'social', icon: 'shield-outline', tone: 'warning', url: null,
      dedupeKey: `team-removed:${userId.toHexString()}:${this.clock.now().getTime()}`,
      title: 'Tu ne fais plus partie de l’équipe UGB Connect',
      body: 'Tes rôles et leurs espaces sont retirés.',
    });
  }

  /** The public restaurants a menu publisher handles; null: all of them (admins). */
  async restosOf(userId: ObjectId): Promise<ObjectId[] | null> {
    const u = await this.users.findOne({ _id: userId }, { projection: { platformRoles: 1, restoIds: 1 } });
    if (!u) return [];
    return u.platformRoles.includes('admin') ? null : (u.restoIds ?? []);
  }
}

const Member = Type.Object({
  userId: Type.String(), firstName: Type.String(), lastName: Type.String(), phoneMasked: Type.String(), roles: Type.Array(Type.String()),
  restos: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })),
});

export function registerTeamRoutes(root: FastifyInstance, d: { team: PlatformTeam; audit: AuditApi; requireAdmin: preHandlerHookHandler }) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const admin = { preHandler: [requireAuth, d.requireAdmin] };
  const tags = ['admin'];
  const trail = (req: { id: string; actor: { userId: string } | null }, action: string, id: string, metadata?: Record<string, unknown>) =>
    d.audit.record({ actor: { type: 'user', id: req.actor?.userId }, action, target: { type: 'user', id }, requestId: req.id, metadata });

  app.get(
    '/admin/team',
    { ...admin, schema: { tags, description: 'The super admin’s team, and the roles he can give.', response: { 200: Type.Object({ items: Type.Array(Member), roles: Type.Array(Type.Object({ value: Type.String(), label: Type.String(), space: Type.Union([Type.String(), Type.Null()]) })) }) } } },
    async () => ({ items: await d.team.list(), roles: d.team.roles() }),
  );

  app.post(
    '/admin/team/lookup',
    {
      ...admin,
      schema: {
        tags, body: Type.Object({ phone: PhoneInput }, { additionalProperties: false }),
        response: { 200: Type.Union([Type.Object({ exists: Type.Literal(true), firstName: Type.String(), lastName: Type.String(), roles: Type.Array(Type.String()) }), Type.Object({ exists: Type.Literal(false) })]) },
      },
    },
    async (req) => d.team.lookup(req.body.phone),
  );

  app.put(
    '/admin/team',
    {
      ...admin,
      schema: {
        tags,
        description: 'Gives roles (replacing the previous ones). A new number needs firstName, lastName and password. resto_u_staff needs restoIds.',
        body: Type.Object(
          {
            phone: Type.Optional(PhoneInput),
            userId: Type.Optional(ObjectIdString),
            roles: Type.Array(Type.Enum(PLATFORM_ROLES), { minItems: 1, maxItems: PLATFORM_ROLES.length }),
            restoIds: Type.Optional(Type.Array(ObjectIdString, { maxItems: 20 })),
            firstName: Type.Optional(Type.String({ minLength: 2, maxLength: 40 })),
            lastName: Type.Optional(Type.String({ minLength: 2, maxLength: 40 })),
            password: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const res = await d.team.set(req.body, toObjectId(actorOf(req).userId));
      await trail(req, 'team.set', res.userId.toHexString(), { roles: res.roles });
      return reply.status(204).send();
    },
  );

  app.delete('/admin/team/:userId', { ...admin, schema: { tags, params: Type.Object({ userId: ObjectIdString }, { additionalProperties: false }) } }, async (req, reply) => {
    await d.team.remove(toObjectId(req.params.userId), toObjectId(actorOf(req).userId));
    await trail(req, 'team.remove', req.params.userId);
    return reply.status(204).send();
  });
}
