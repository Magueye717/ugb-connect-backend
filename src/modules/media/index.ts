import multipart from '@fastify/multipart';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from 'mongodb';
import { Type } from 'typebox';

import type { Config } from '../../config/env.js';
import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import { toObjectId } from '../../platform/http/schemas.js';
import type { Limiter } from '../../platform/security/limiter.js';
import { mediaCollections } from './media.collections.js';
import { MediaService } from './media.service.js';
import { contentTypeOf, createMediaStorage, LocalMediaStorage } from './media.storage.js';
import { MEDIA_PURPOSES } from './media.types.js';

export { mediaCollections };
export type { FileRef, MediaUsage } from './media.types.js';

export const MEDIA_SWEEP_QUEUE = 'media.sweep';

/** Uploaded files above this are refused before being read. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** The campus team's directory editors and the admins: no hourly limit on uploads. */
const UNLIMITED_ROLES = ['admin', 'place_editor', 'restaurant_editor', 'shop_editor', 'caravan_editor'];

export type MediaApi = Pick<MediaService, 'claim' | 'claimDocument' | 'release' | 'trackUsage'> & {
  registerRoutes(app: FastifyInstance): Promise<void>;
  processors(): Record<string, () => Promise<unknown>>;
  schedules: { queue: string; everyMs: number }[];
  /** Tests. */
  service: MediaService;
};

export function createMediaModule(d: { db: Db; clock: Clock; config: Config; limiter: Limiter }): MediaApi {
  const storage = createMediaStorage(d.config);
  const service = new MediaService(d.db, d.clock, storage, d.limiter);
  const apiBase = (req: FastifyRequest) => d.config.PUBLIC_API_URL ?? `${req.protocol}://${req.host}/api/v1`;

  const registerRoutes = async (root: FastifyInstance) => {
    await root.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2 } });
    const app = root.withTypeProvider<TypeBoxTypeProvider>();

    app.post(
      '/media/images',
      {
        preHandler: requireAuth,
        schema: {
          tags: ['media'],
          consumes: ['multipart/form-data'],
          description: 'Upload one picture (field `file`, up to 25 MB: JPEG, PNG, WebP, HEIC, AVIF, GIF, TIFF). It comes back re-encoded (WebP, ≤ 1600 px, no metadata); attach it by `id`.',
          querystring: Type.Object({ purpose: Type.Enum(MEDIA_PURPOSES) }, { additionalProperties: false }),
          response: { 201: Type.Object({ id: Type.String(), url: Type.String(), width: Type.Number(), height: Type.Number() }) },
        },
      },
      async (req, reply) => {
        const file = await req.file();
        if (!file) throw errors.validation('Ajoute une image.', { field: 'file' });
        const buf = await file.toBuffer().catch(() => {
          throw errors.validation(`Image trop lourde : ${MAX_UPLOAD_BYTES / 1024 / 1024} Mo au plus.`, { field: 'file' });
        });
        const actor = actorOf(req);
        const doc = await service.upload(toObjectId(actor.userId), req.query.purpose, buf, apiBase(req), { unlimited: actor.roles.some((r) => UNLIMITED_ROLES.includes(r)) });
        return reply.status(201).send({ id: doc._id.toHexString(), url: doc.url, width: doc.width!, height: doc.height! });
      },
    );

    app.post(
      '/media/files',
      {
        preHandler: requireAuth,
        schema: {
          tags: ['media'],
          consumes: ['multipart/form-data'],
          description: 'Upload one PDF (field `file`, up to 10 MB), for an announcement (purpose alert). Kept as sent; attach it by `id` (`attachmentId`).',
          querystring: Type.Object({ purpose: Type.Enum(MEDIA_PURPOSES) }, { additionalProperties: false }),
          response: { 201: Type.Object({ id: Type.String(), url: Type.String(), name: Type.String(), bytes: Type.Number(), pages: Type.Union([Type.Integer(), Type.Null()]) }) },
        },
      },
      async (req, reply) => {
        const file = await req.file();
        if (!file) throw errors.validation('Ajoute un fichier.', { field: 'file' });
        const buf = await file.toBuffer().catch(() => {
          throw errors.validation(`Fichier trop lourd : ${MAX_UPLOAD_BYTES / 1024 / 1024} Mo au plus.`, { field: 'file' });
        });
        const doc = await service.uploadDocument(toObjectId(actorOf(req).userId), req.query.purpose, buf, file.filename, apiBase(req));
        return reply.status(201).send({ id: doc._id.toHexString(), url: doc.url, name: doc.name!, bytes: doc.bytes, pages: doc.pages ?? null });
      },
    );

    // Development: the files themselves (production serves them from the bucket's domain).
    if (storage instanceof LocalMediaStorage) {
      app.get('/media/*', { schema: { hide: true } }, async (req, reply) => {
        const body = await storage.read((req.params as { '*': string })['*']);
        if (!body) throw errors.notFound();
        const key = (req.params as { '*': string })['*'];
        return reply.header('content-type', contentTypeOf(key)).header('cache-control', 'public, max-age=31536000, immutable').send(body);
      });
    }
  };

  return {
    claim: (o, ids) => service.claim(o, ids),
    claimDocument: (o, id) => service.claimDocument(o, id),
    release: (ids) => service.release(ids),
    trackUsage: (u) => service.trackUsage(u),
    registerRoutes,
    processors: () => ({ [MEDIA_SWEEP_QUEUE]: () => service.sweep() }),
    schedules: [{ queue: MEDIA_SWEEP_QUEUE, everyMs: 3600_000 }],
    service,
  };
}
