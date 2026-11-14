import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, registerStudent, T0, type TestApp } from '../../../../test/harness.js';
import { picture } from '../../../../test/upload.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ PAYMENTS_SIMULATOR: 'true', MEDIA_DIR: mkdtempSync(join(tmpdir(), 'ugb-media-')) });
});
afterAll(async () => t.close());

const DAY = 24 * 3_600_000;
type Who = { userId: string };
async function call(who: Who, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) {
  const { accessToken } = await t.c.modules.identity.startSession({ _id: new ObjectId(who.userId), platformRoles: [] });
  return t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(accessToken), payload });
}
const ok = async (res: Promise<{ statusCode: number; body: string }>, status = 200) => {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return json(r);
};
const pay = (reference: string) => t.app.inject({ method: 'POST', url: `/api/v1/dev/payment-simulator/${reference}/pay`, headers: { 'content-type': 'text/plain' }, payload: '' });
const day = (n: number) => new Date(T0 + n * DAY).toISOString().slice(0, 10);
const image = async (who: Who) => (await t.c.modules.media.service.upload(new ObjectId(who.userId), 'banner', await picture(), 'http://test/api/v1'))._id.toHexString();

let admin: Who;
let editor: Who;
beforeAll(async () => {
  t.clock.set(T0);
  admin = { userId: (await createStaff(t, ['admin'])).userId.toHexString() };
  editor = { userId: (await createStaff(t, ['content_editor'])).userId.toHexString() };
  await ok(call(admin, 'PUT', '/admin/banner-packages/jour', { name: 'Une journée', days: 1, price: 1000, active: true }));
  await ok(call(admin, 'PUT', '/admin/banner-packages/semaine', { name: 'Une semaine', days: 7, price: 5000, active: true }));
});

const ad = async (who: Who, startsOn: string, packageCode = 'jour') =>
  call(who, 'POST', '/banners', {
    kind: 'ad', title: '-20 % sur ton forfait', description: 'Offre étudiants jusqu’au 30 nov.', imageId: await image(who),
    cta: { label: 'J’en profite', target: 'url', value: 'https://example.com/offre' }, packageCode, startsOn, method: 'wave',
  });

describe('ads', () => {
  it('paid, reviewed by the communication team, then shown on its days', async () => {
    t.clock.set(T0);
    const s = await registerStudent(t);
    expect((await call(s, 'GET', '/banner-packages')).statusCode).toBe(200);
    expect((await call(s, 'PUT', '/admin/banner-packages/jour', { name: 'x x', days: 1, price: 100, active: true })).statusCode).toBe(403);
    expect(json(await ad(s, day(-1))).field).toBe('startsOn'); // from today at the earliest

    const { banner, payment } = await ok(ad(s, day(2)), 201);
    expect(banner).toMatchObject({ status: 'pending_payment', price: 1000, packageName: 'Une journée', cta: { target: 'url' } });
    expect(payment.amount).toBe(1000);
    await pay(payment.reference);
    expect((await ok(call(s, 'GET', '/me/banners'))).items[0]).toMatchObject({ id: banner.id, status: 'pending_review' });

    const queue = await ok(call(editor, 'GET', '/admin/banners?status=pending_review'));
    expect(queue.items.some((b: { id: string }) => b.id === banner.id)).toBe(true);
    expect((await call(s, 'POST', `/admin/banners/${banner.id}/approve`)).statusCode).toBe(403);
    expect(await ok(call(editor, 'POST', `/admin/banners/${banner.id}/approve`))).toMatchObject({ status: 'approved' });
    expect((await ok(call(s, 'GET', '/notifications'))).items[0]).toMatchObject({ type: 'banner.approved' });

    expect((await ok(call(s, 'GET', '/banners'))).items.some((b: { id: string }) => b.id === banner.id)).toBe(false);
    t.clock.set(T0 + 2 * DAY + 3_600_000);
    const live = (await ok(call(s, 'GET', '/banners'))).items.find((b: { id: string }) => b.id === banner.id);
    expect(live).toMatchObject({ kind: 'ad', title: '-20 % sur ton forfait', image: expect.stringMatching(/\.webp$/), cta: { label: 'J’en profite' }, event: null });
    t.clock.set(T0 + 3 * DAY + 1);
    expect((await ok(call(s, 'GET', '/banners'))).items.some((b: { id: string }) => b.id === banner.id)).toBe(false);
  });

  it('refused: refunded with the reason; given up before the review: refunded too', async () => {
    t.clock.set(T0);
    const s = await registerStudent(t);
    const a = await ok(ad(s, day(3)), 201);
    await pay(a.payment.reference);
    expect(await ok(call(editor, 'POST', `/admin/banners/${a.banner.id}/reject`, { reason: 'Image trompeuse.' }))).toMatchObject({ status: 'rejected', reviewReason: 'Image trompeuse.', refunded: true });
    expect(await t.c.mongo.db.collection('payouts').findOne({ idempotencyKey: `banner:${a.banner.id}:refund` })).toMatchObject({ amount: 1000, reason: 'banner_rejected' });
    expect((await ok(call(s, 'GET', '/notifications'))).items[0]).toMatchObject({ type: 'banner.rejected', title: 'Bannière refusée' });

    const b = await ok(ad(s, day(4)), 201);
    await pay(b.payment.reference);
    expect(await ok(call(s, 'POST', `/me/banners/${b.banner.id}/cancel`))).toMatchObject({ status: 'cancelled', refunded: true });
    expect((await call(s, 'POST', `/me/banners/${b.banner.id}/cancel`)).statusCode).toBe(409);

    // Settled (refused, cancelled): off « Mes publicités » with a swipe. Waiting for its review: cancel first.
    const c = await ok(ad(s, day(5)), 201);
    await pay(c.payment.reference);
    expect(json(await call(s, 'DELETE', `/me/banners/${c.banner.id}`)).code).toBe('BANNER_PENDING');
    expect((await call(s, 'DELETE', `/me/banners/${a.banner.id}`)).statusCode).toBe(204);
    expect((await call(s, 'DELETE', `/me/banners/${b.banner.id}`)).statusCode).toBe(204);
    const left = (await ok(call(s, 'GET', '/me/banners'))).items.map((x: { id: string }) => x.id);
    expect(left).toEqual([c.banner.id]);
    // Someone else's: not found.
    expect((await call(await registerStudent(t), 'DELETE', `/me/banners/${c.banner.id}`)).statusCode).toBe(404);
  });

  it('a bad link is refused; the carousel has room for 6 banners a day', async () => {
    t.clock.set(T0);
    const s = await registerStudent(t);
    expect((await call(s, 'POST', '/banners', { kind: 'ad', title: 'Promo', imageId: await image(s), cta: { label: 'Voir', target: 'url', value: 'http://insecure.example' }, packageCode: 'jour', startsOn: day(20), method: 'wave' })).statusCode).toBe(400);
    for (let i = 0; i < 6; i++) await ok(ad(await registerStudent(t), day(20)), 201);
    expect(json(await ad(s, day(20))).code).toBe('NO_BANNER_SLOT');
    // A week starting the day before overlaps the full day too.
    expect(json(await ad(s, day(19), 'semaine')).code).toBe('NO_BANNER_SLOT');
  });
});

describe('event banners', () => {
  it('an organization promotes its published event; tapping it opens the event', async () => {
    t.clock.set(T0);
    const owner = await createStaff(t);
    const org = await t.c.modules.organizations.create({ slug: `bde-banner-${Date.now() % 1e6}`, name: 'BDE SJP', category: 'Amicale', capabilities: ['events'], level: 'confirme', payoutPhone: owner.phone });
    await t.c.modules.organizations.setOwner(org._id, owner.phone, null);
    const o = { userId: owner.userId.toHexString() };
    const [cover, second] = await Promise.all([1, 2].map(async () => (await t.c.modules.media.service.upload(owner.userId, 'event', await picture(), 'http://test/api/v1'))._id.toHexString()));
    const ev = await ok(
      call(o, 'POST', `/org/${org._id.toHexString()}/events`, {
        title: 'Gala de fin d’année', category: 'soiree', description: 'Tenue de soirée.', imageIds: [cover, second], venue: { name: 'Salle polyvalente' },
        startsAt: new Date(T0 + 10 * DAY).toISOString(), endsAt: new Date(T0 + 10 * DAY + 5 * 3_600_000).toISOString(), ticketTypes: [{ name: 'Entrée', price: 3000, capacity: 200 }],
      }),
      201,
    );
    const body = { kind: 'event', orgId: org._id.toHexString(), eventId: ev.id, packageCode: 'semaine', startsOn: day(2), method: 'wave' };
    expect(json(await call(o, 'POST', '/banners', body)).field).toBe('eventId'); // not published yet
    await ok(call(o, 'POST', `/org/${org._id.toHexString()}/events/${ev.id}/publish`));
    const stranger = await registerStudent(t);
    expect((await call(stranger, 'POST', '/banners', body)).statusCode).toBe(403);

    const { banner, payment } = await ok(call(o, 'POST', '/banners', body), 201);
    expect(banner).toMatchObject({ kind: 'event', title: 'Gala de fin d’année', eventId: ev.id, cta: null });
    // No review for an event: paid, it's on.
    await pay(payment.reference);
    // Not twice at the same time: a new banner once this one has ended.
    expect(json(await call(o, 'POST', '/banners', { ...body, packageCode: 'jour', startsOn: day(3) })).code).toBe('EVENT_ALREADY_PROMOTED');
    expect((await ok(call(o, 'GET', '/me/banners'))).items[0]).toMatchObject({ id: banner.id, status: 'approved' });
    expect((await ok(call(o, 'GET', '/notifications'))).items[0]).toMatchObject({ type: 'banner.approved', title: 'Bannière en ligne' });
    t.clock.set(T0 + 3 * DAY);
    const live = (await ok(call(stranger, 'GET', '/banners'))).items.find((b: { id: string }) => b.id === banner.id);
    expect(live).toMatchObject({ kind: 'event', event: { id: ev.id, venue: 'Salle polyvalente', priceLabel: 'Dès 3 000 FCFA', categoryLabel: 'Soirée' } });
    // No cover chosen: one of the event's pictures, at random.
    expect(ev.images).toContain(live.image);
    await t.c.mongo.db.collection('events').updateOne({ _id: new ObjectId(ev.id) }, { $set: { fixedCover: true } });
    for (let i = 0; i < 5; i++) expect((await ok(call(stranger, 'GET', '/banners'))).items.find((b: { id: string }) => b.id === banner.id).image).toBe(ev.images[0]);
    // The week is over: the event can go back on the carousel for its last day.
    t.clock.set(T0 + 9 * DAY + 3_600_000);
    expect((await call(o, 'POST', '/banners', { ...body, packageCode: 'jour', startsOn: day(9) })).statusCode).toBe(201);
    // The event cancelled: its banner leaves the carousel.
    await ok(call(o, 'POST', `/org/${org._id.toHexString()}/events/${ev.id}/cancel`, { reason: 'Report' }));
    expect((await ok(call(stranger, 'GET', '/banners'))).items.some((b: { id: string }) => b.id === banner.id)).toBe(false);
  });
});
