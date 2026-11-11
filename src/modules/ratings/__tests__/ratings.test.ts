import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, nextPhone, registerStudent, T0, type TestApp } from '../../../../test/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ PAYMENTS_SIMULATOR: 'true' });
});
afterAll(async () => t.close());

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
type Who = { userId: string | ObjectId };
async function call(who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  const { accessToken } = await t.c.modules.identity.startSession({ _id: new ObjectId(String(who.userId)), platformRoles: [] });
  return t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(accessToken), payload });
}
const ok = async (res: Promise<{ statusCode: number; body: string }>, status = 200) => {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return json(r);
};
const at = (ms: number) => new Date(T0 + ms).toISOString();
const pending = async (who: Who) => (await ok(call(who, 'GET', '/me/ratings/pending'))).items as { subject: string; id: string; title: string; ratedName: string }[];

let seq = 0;

/** A shop paid in cash, an order handed over: completed. */
async function completedOrder() {
  t.clock.set(T0);
  const admin = await createStaff(t, ['admin']);
  const phone = nextPhone();
  const b = await ok(
    call(admin, 'POST', '/admin/businesses', {
      kind: 'shop', name: `Papeterie ${++seq}`, specialties: ['Fournitures'], owner: { phone, firstName: 'Modou', lastName: 'Khoulé' }, address: 'Village E', campus: 'campus1',
      location: { lat: 16.06, lng: -16.42 }, services: [{ start: '08:00', end: '23:00' }], deliveryFees: { campus1: null, campus2: null, outside: null }, paymentMethods: ['cash'],
    }),
    201,
  );
  const owner = { userId: (await t.c.modules.accounts.findByPhone(`+221${phone}`))!._id };
  const pen = await ok(call(owner, 'POST', `/org/${b.orgId}/shop/catalog`, { section: 'article', name: 'Stylo', price: 200 }), 201);
  const s = await registerStudent(t);
  const { order } = await ok(call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: pen.id, qty: 1 }], mode: 'pickup', method: 'cash' }), 201);
  await ok(call(owner, 'POST', `/org/${b.orgId}/shop/orders/${order.id}/accept`));
  await ok(call(owner, 'POST', `/org/${b.orgId}/shop/orders/handover`, { code: order.code }));
  return { b, order, student: s };
}

/** A caravan trip bought by a student, then over (completed, as the caravans worker leaves it after arrival). */
async function completedTrip() {
  t.clock.set(T0);
  const owner = await createStaff(t);
  const org = await t.c.modules.organizations.create({ slug: `rate-${++seq}-${Date.now() % 1e6}`, name: 'Sunu Voyage', category: 'Entreprise', capabilities: ['caravans'], level: 'confirme', payoutPhone: owner.phone });
  await t.c.modules.organizations.setOwner(org._id, owner.phone, null);
  const o = { userId: owner.userId.toHexString() };
  const orgId = org._id.toHexString();
  const vehicle = await ok(call(o, 'POST', `/org/${orgId}/vehicles`, { label: 'Minibus', plate: `DK ${5000 + seq} RT`, capacity: 12 }), 201);
  const draft = await ok(
    call(o, 'POST', `/org/${orgId}/departures`, {
      vehicleId: vehicle.id, direction: 'aller', from: 'UGB', to: 'Dakar', price: 3500, minPassengers: 1,
      pickups: [{ place: 'UGB · Village E', at: at(3 * DAY) }], dropoffs: [{ place: 'Dakar · Colobane', at: at(3 * DAY + 5 * HOUR) }],
    }),
    201,
  );
  await ok(call(o, 'POST', `/org/${orgId}/departures/${draft.id}/publish`));
  const s = await registerStudent(t);
  // A request, then validated by the organizer (paid in cash).
  const { booking } = await ok(call(s, 'POST', `/caravans/departures/${draft.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd1' }), 201);
  const orderId = (await t.c.mongo.db.collection('bookings').findOne({ _id: new ObjectId(booking.id) }))!.orderId.toHexString();
  await ok(call(o, 'POST', `/org/${orgId}/departures/requests/${orderId}/validate`));
  // Arrived: the trip is over.
  t.clock.set(T0 + 3 * DAY + 6 * HOUR);
  await t.c.mongo.db.collection('departures').updateOne({ _id: new ObjectId(draft.id) }, { $set: { status: 'completed', completedAt: t.clock.now() } });
  return { orgId, depId: draft.id, student: s };
}

describe('ratings', () => {
  it('an order handed over: asked about it; stars and a word; the shop’s average follows; then no more asking', async () => {
    const { b, order, student } = await completedOrder();
    expect(await pending(student)).toEqual([expect.objectContaining({ subject: 'order', id: order.id, title: `Commande chez ${b.name}`, ratedName: b.name })]);
    // Someone else can't rate it.
    const other = await registerStudent(t);
    expect((await call(other, 'PUT', `/me/ratings/order/${order.id}`, { stars: 1 })).statusCode).toBe(404);
    expect((await call(student, 'PUT', `/me/ratings/order/${order.id}`, { stars: 6 })).statusCode).toBe(400);
    expect(await ok(call(student, 'PUT', `/me/ratings/order/${order.id}`, { stars: 4, comment: ' Rapide ' }))).toEqual({ stars: 4, comment: 'Rapide' });
    expect(await pending(student)).toEqual([]);
    expect(await ok(call(student, 'GET', `/me/ratings/order/${order.id}`))).toMatchObject({ stars: 4, comment: 'Rapide', rateable: { ratedName: b.name } });
    expect(await ok(call(student, 'GET', `/businesses/${b.id}`))).toMatchObject({ rating: 4, ratingCount: 1 });
    // Changed later: replaced, not added.
    await ok(call(student, 'PUT', `/me/ratings/order/${order.id}`, { stars: 5 }));
    expect(await ok(call(student, 'GET', `/businesses/${b.id}`))).toMatchObject({ rating: 5, ratingCount: 1 });
    // Its page: anonymous reviews, per star and the latest words.
    const reviews = await ok(call(other, 'GET', `/businesses/${b.id}/reviews`));
    expect(reviews).toMatchObject({ avg: 5, count: 1, comments: 1, items: [{ stars: 5, comment: 'Rapide' }] });
    expect(reviews.distribution.map((d: { stars: number; count: number }) => `${d.stars}:${d.count}`)).toEqual(['5:1', '4:0', '3:0', '2:0', '1:0']);
    expect(JSON.stringify(reviews)).not.toContain(String(student.userId));
  });

  it('optional and asked once: after « Plus tard » it isn’t asked again (the page still offers it)', async () => {
    const first = await completedOrder();
    expect(await pending(first.student)).toHaveLength(1);
    expect((await call(first.student, 'POST', `/me/ratings/order/${first.order.id}/later`)).statusCode).toBe(204);
    expect(await pending(first.student)).toEqual([]);
    // Still rateable from the order's page.
    expect((await ok(call(first.student, 'GET', `/me/ratings/order/${first.order.id}`))).rateable).not.toBeNull();

    const second = await completedOrder();
    expect((await call(second.student, 'POST', `/me/ratings/order/${second.order.id}/decline`)).statusCode).toBe(204);
    expect(await pending(second.student)).toEqual([]);
    t.clock.set(T0 + 31 * DAY);
    expect((await ok(call(second.student, 'GET', `/me/ratings/order/${second.order.id}`))).rateable).toBeNull();
    expect((await call(second.student, 'PUT', `/me/ratings/order/${second.order.id}`, { stars: 3 })).statusCode).toBe(404);
  });

  it('one review per restaurant or shop: a second order isn’t asked about, and rating it changes the same review', async () => {
    const { b, order, student } = await completedOrder();
    await ok(call(student, 'PUT', `/me/ratings/order/${order.id}`, { stars: 2, comment: 'Lent' }));
    // Another order at the same shop.
    t.clock.set(T0 + HOUR);
    const owner = { userId: (await t.c.mongo.db.collection('memberships').findOne({ orgId: new ObjectId(b.orgId), roles: 'owner' }))!.userId };
    const pen = (await ok(call(student, 'GET', `/businesses/${b.id}`))).items[0];
    const { order: again } = await ok(call(student, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: pen.id, qty: 1 }], mode: 'pickup', method: 'cash' }), 201);
    await ok(call(owner, 'POST', `/org/${b.orgId}/shop/orders/${again.id}/accept`));
    await ok(call(owner, 'POST', `/org/${b.orgId}/shop/orders/handover`, { code: again.code }));
    expect(await pending(student)).toEqual([]);
    // Its page shows the review already given; changing it doesn't add one.
    expect(await ok(call(student, 'GET', `/me/ratings/order/${again.id}`))).toMatchObject({ stars: 2, comment: 'Lent' });
    await ok(call(student, 'PUT', `/me/ratings/order/${again.id}`, { stars: 4 }));
    expect(await ok(call(student, 'GET', `/businesses/${b.id}/reviews`))).toMatchObject({ count: 1, avg: 4, items: [{ stars: 4, comment: 'Lent' }] });
  });

  it('a caravan trip over: its traveller is notified once, rates it, and the organizer’s rating shows on its trips', async () => {
    const { orgId, depId, student } = await completedTrip();
    expect(await t.c.modules.ratings.service.sweep()).toBeGreaterThanOrEqual(1);
    await t.c.modules.ratings.service.sweep();
    const asks = (await ok(call(student, 'GET', '/notifications'))).items.filter((n: { type: string }) => n.type === 'rating.ask');
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ url: `/noter/caravan/${depId}` });
    expect(await pending(student)).toEqual([expect.objectContaining({ subject: 'caravan', id: depId, title: 'UGB → Dakar', ratedName: 'Sunu Voyage' })]);
    await ok(call(student, 'PUT', `/me/ratings/caravan/${depId}`, { stars: 3 }));
    const org = await t.c.mongo.db.collection('organizations').findOne({ _id: new ObjectId(orgId) });
    expect(org?.stats).toMatchObject({ ratingAvg: 3, ratingCount: 1 });
  });
});
