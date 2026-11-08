import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { IdParams, Nullable, toObjectId } from '../../platform/http/schemas.js';
import { CAMPUSES } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { PlacesService } from './places.service.js';
import { CAMPUS_BOUNDS, CAMPUS_OUTLINE, CAMPUS_START } from './places.campus.js';
import { PLACE_CATEGORIES, PLACE_MAX_PHOTOS } from './places.types.js';

const PlaceView = Type.Object({
  id: Type.String(),
  name: Type.String(),
  category: Type.String({ description: PLACE_CATEGORIES.join(' | ') }),
  description: Type.String(),
  area: Type.String(),
  campus: Nullable(Type.String()),
  campusLabel: Nullable(Type.String()),
  location: Type.Object({ lat: Type.Number(), lng: Type.Number() }),
  hours: Nullable(Type.String()),
  icon: Type.String({ description: 'Ionicons name.' }),
  photos: Type.Array(Type.String(), { description: 'Picture URLs; the first is the cover.' }),
  photoRefs: Type.Array(Type.String(), { description: 'Editing: send them back as `photos` to keep these pictures.' }),
  active: Type.Boolean(),
  sortOrder: Type.Number(),
});
const PlaceFields = {
  name: Type.String({ minLength: 2, maxLength: 60 }),
  category: Type.Enum(PLACE_CATEGORIES),
  description: Type.Optional(Type.String({ maxLength: 600 })),
  area: Type.Optional(Type.String({ maxLength: 80 })),
  campus: Type.Optional(Nullable(Type.Enum(CAMPUSES))),
  location: Type.Object({ lat: Type.Number({ minimum: -90, maximum: 90 }), lng: Type.Number({ minimum: -180, maximum: 180 }) }, { additionalProperties: false }),
  hours: Type.Optional(Nullable(Type.String({ maxLength: 60 }))),
  icon: Type.Optional(Type.String({ pattern: '^[a-z-]+$', maxLength: 40 })),
  photos: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: PLACE_MAX_PHOTOS, description: 'Upload ids (POST /media/images?purpose=place) or photoRefs to keep; the first is the cover.' })),
  active: Type.Optional(Type.Boolean()),
  sortOrder: Type.Optional(Type.Number()),
};

type Deps = { service: PlacesService; audit: AuditApi; requireEditor: preHandlerHookHandler };

export function registerPlacesRoutes(root: FastifyInstance, { service, audit, requireEditor }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const me = (req: FastifyRequest) => toObjectId(actorOf(req).userId);
  const tags = ['places'];
  const trace = (req: FastifyRequest, action: string, id: string) => audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action, target: { type: 'place', id }, requestId: req.id });

  app.get('/places', { preHandler: requireAuth, schema: { tags, description: 'The places of the campus, for the list and the map.', response: { 200: Type.Object({ items: Type.Array(PlaceView) }) } } }, async () => ({
    items: (await service.list()).map((p) => service.view(p)),
  }));

  const Point = Type.Object({ lat: Type.Number(), lng: Type.Number() });
  app.get(
    '/places/campus',
    {
      preHandler: requireAuth,
      schema: {
        tags,
        description: 'The UGB campus outline (from OpenStreetMap, © OpenStreetMap contributors) and its box: the map draws it and stays inside.',
        response: { 200: Type.Object({ outline: Type.Array(Point), bounds: Type.Object({ south: Type.Number(), west: Type.Number(), north: Type.Number(), east: Type.Number() }), start: Type.Object({ lat: Type.Number(), lng: Type.Number(), delta: Type.Number() }), attribution: Type.String() }) },
      },
    },
    async () => ({ outline: CAMPUS_OUTLINE, bounds: CAMPUS_BOUNDS, start: CAMPUS_START, attribution: '© OpenStreetMap' }),
  );

  app.get('/places/:id', { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: PlaceView } } }, async (req) => service.view(await service.get(toObjectId(req.params.id))));

  // ---- The communication team ------------------------------------------------------------------------------------

  const editor = { preHandler: [requireAuth, requireEditor] };
  app.get('/admin/places', { ...editor, schema: { tags, description: 'Hidden ones included.', response: { 200: Type.Object({ items: Type.Array(PlaceView) }) } } }, async () => ({
    items: (await service.list(true)).map((p) => service.view(p)),
  }));

  app.post('/admin/places', { ...editor, schema: { tags, body: Type.Object(PlaceFields, { additionalProperties: false }), response: { 201: PlaceView } } }, async (req, reply) => {
    const p = await service.create(me(req), req.body);
    await trace(req, 'place.create', p._id.toHexString());
    return reply.status(201).send(service.view(p));
  });

  app.patch('/admin/places/:id', { ...editor, schema: { tags, params: IdParams, body: Type.Partial(Type.Object(PlaceFields, { additionalProperties: false })), response: { 200: PlaceView } } }, async (req) => {
    const p = await service.update(me(req), toObjectId(req.params.id), req.body);
    await trace(req, 'place.update', req.params.id);
    return service.view(p);
  });

  app.delete('/admin/places/:id', { ...editor, schema: { tags, params: IdParams } }, async (req, reply) => {
    await service.remove(toObjectId(req.params.id));
    await trace(req, 'place.delete', req.params.id);
    return reply.status(204).send();
  });
}
