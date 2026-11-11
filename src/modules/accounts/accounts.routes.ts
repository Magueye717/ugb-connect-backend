import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ObjectId } from 'mongodb';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { errors } from '../../platform/http/errors.js';
import { IdParams, ObjectIdString, toObjectId } from '../../platform/http/schemas.js';
import type { AuditApi } from '../audit/index.js';
import type { AccountsService } from './accounts.service.js';
import { CreateStaffUserBody, EmailBody, IdentityBody, LocationBody, MeResponse, NotificationPrefsSchema, OriginBody, PlatformRolesBody, ResidenceBody, StudentReference } from './accounts.schemas.js';
import { CAMPUS_LABELS, CAMPUSES, REGIONS, STUDENT_NUMBER_MAX, STUDENT_NUMBER_RE, UFRS, VILLAGES, type UserDoc } from './accounts.types.js';

type Deps = {
  service: AccountsService;
  audit: AuditApi;
  requireStudent: preHandlerHookHandler;
  /** An upload (purpose avatar) becomes the user's: its stored reference. */
  claimImage: (userId: ObjectId, mediaId: string) => Promise<NonNullable<UserDoc['avatar']>>;
  /** Deletes pictures nothing references any more (the media module). */
  releaseImages: (mediaIds: (ObjectId | null)[]) => Promise<number>;
  requireAdmin: preHandlerHookHandler;
};

export function registerAccountsRoutes(root: FastifyInstance, { service, audit, requireStudent, requireAdmin, claimImage, releaseImages }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const me = (req: Parameters<typeof actorOf>[0]) => toObjectId(actorOf(req).userId);

  app.get('/me', { preHandler: requireAuth, schema: { tags: ['me'], response: { 200: MeResponse } } }, async (req) => service.getMe(me(req)));

  // Public (the sign-up form needs it): campuses and their villages, UFRs, home regions.
  app.get('/reference/student', { schema: { tags: ['reference'], response: { 200: StudentReference } } }, async () => ({
    campuses: CAMPUSES.map((key) => ({ key, label: CAMPUS_LABELS[key], villages: VILLAGES[key] })),
    ufrs: UFRS.map((u) => ({ code: u.code, name: u.name })),
    regions: [...REGIONS],
    // The sign-up form checks the same rule as the server.
    studentNumber: { pattern: STUDENT_NUMBER_RE.source, maxLength: STUDENT_NUMBER_MAX, example: 'P232055' },
  }));

  // "Mon UFR et ma région": announcements for one UFR or region reach the student only once they're known.
  app.put('/me/origin', { preHandler: [requireAuth, requireStudent], schema: { tags: ['me'], body: OriginBody } }, async (req, reply) => {
    await service.updateOrigin(me(req), req.body);
    return reply.status(204).send();
  });

  app.put(
    '/me/student-number',
    {
      preHandler: [requireAuth, requireStudent],
      schema: {
        tags: ['me'],
        description: 'A student gives their number (optional at sign-up). Correctable for 3 days after it was first given, then it does not change here.',
        body: Type.Object({ studentNumber: Type.String({ minLength: 1, maxLength: 30 }) }, { additionalProperties: false }),
      },
    },
    async (req, reply) => {
      if ((await service.claimStudentNumber(me(req), req.body.studentNumber)) === 'has-other') {
        throw errors.conflict('STUDENT_NUMBER_SET', 'Ton numéro étudiant est enregistré depuis plus de 3 jours : il ne se change plus ici. Écris à l’équipe UGB Connect en cas d’erreur.');
      }
      return reply.status(204).send();
    },
  );

  app.put('/me/identity', { preHandler: [requireAuth, requireStudent], schema: { tags: ['me'], description: 'Birth date, place of birth, nationality (optional).', body: IdentityBody } }, async (req, reply) => {
    await service.updateIdentity(me(req), req.body);
    return reply.status(204).send();
  });

  app.patch(
    '/me/student-profile',
    { preHandler: [requireAuth, requireStudent], schema: { tags: ['me'], body: ResidenceBody } },
    async (req, reply) => {
      await service.updateResidence(me(req), req.body);
      return reply.status(204).send();
    },
  );

  app.get('/me/notification-preferences', { preHandler: requireAuth, schema: { tags: ['me'], response: { 200: NotificationPrefsSchema } } }, async (req) =>
    service.getNotificationPrefs(me(req)),
  );

  app.put('/me/notification-preferences', { preHandler: requireAuth, schema: { tags: ['me'], body: NotificationPrefsSchema } }, async (req, reply) => {
    await service.setNotificationPrefs(me(req), req.body);
    return reply.status(204).send();
  });

  // Keyed by user, not IP: a campus Wi-Fi shares one IP between thousands of students.
  const perUser = (max: number, timeWindow: string) => ({ rateLimit: { max, timeWindow, hook: 'preHandler' as const, keyGenerator: (r: { actor: { userId: string } | null; ip: string }) => r.actor?.userId ?? r.ip } });

  app.put(
    '/me/avatar',
    { preHandler: requireAuth, config: perUser(20, '1 hour'), schema: { tags: ['me'], description: 'The profile picture: an upload (purpose avatar), or null to remove it.', body: Type.Object({ photoId: Type.Union([Type.Null(), ObjectIdString]) }, { additionalProperties: false }) } },
    async (req, reply) => {
      const replaced = await service.setAvatar(me(req), req.body.photoId ? await claimImage(me(req), req.body.photoId) : null);
      await releaseImages([replaced]);
      return reply.status(204).send();
    },
  );

  app.put('/me/email', { preHandler: requireAuth, config: perUser(10, '1 hour'), schema: { tags: ['me'], body: EmailBody } }, async (req, reply) => {
    await service.setEmail(me(req), req.body.email);
    return reply.status(204).send();
  });

  app.delete('/me/email', { preHandler: requireAuth, schema: { tags: ['me'] } }, async (req, reply) => {
    await service.removeEmail(me(req));
    return reply.status(204).send();
  });

  app.put('/me/location', { preHandler: requireAuth, config: perUser(60, '1 hour'), schema: { tags: ['me'], body: LocationBody } }, async (req, reply) => {
    await service.setLocation(me(req), req.body);
    return reply.status(204).send();
  });

  app.delete('/me/location', { preHandler: requireAuth, schema: { tags: ['me'] } }, async (req, reply) => {
    await service.clearLocation(me(req));
    return reply.status(204).send();
  });

  // ---- Admin (Swagger is the temporary back office, decision Q-12) -----------------------------------------

  app.post(
    '/admin/users',
    { preHandler: [requireAuth, requireAdmin], schema: { tags: ['admin'], body: CreateStaffUserBody, response: { 201: Type.Object({ id: Type.String() }) } } },
    async (req, reply) => {
      const user = await service.createStaffUser(req.body);
      await audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action: 'user.create_staff', target: { type: 'user', id: user._id.toHexString() }, requestId: req.id });
      return reply.status(201).send({ id: user._id.toHexString() });
    },
  );

  app.put(
    '/admin/users/:id/platform-roles',
    { preHandler: [requireAuth, requireAdmin], schema: { tags: ['admin'], params: IdParams, body: PlatformRolesBody } },
    async (req, reply) => {
      const user = await service.setPlatformRoles(toObjectId(req.params.id), req.body.roles);
      await audit.record({
        actor: { type: 'user', id: actorOf(req).userId }, action: 'user.set_platform_roles',
        target: { type: 'user', id: user._id.toHexString() }, requestId: req.id, metadata: { roles: user.platformRoles },
      });
      return reply.status(204).send();
    },
  );
}
