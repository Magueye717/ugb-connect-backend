import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, registerStudent, T0, type TestApp } from '../../../../test/harness.js';
import { LogPushSender, type PushMessage, type PushSender } from '../push.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ PAYMENTS_SIMULATOR: 'true', TAXI_ONLINE_PAYMENT: 'true' });
});
afterAll(async () => t.close());

type Who = { userId: string };
async function call(who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  const { accessToken } = await t.c.modules.identity.startSession({ _id: new ObjectId(who.userId), platformRoles: [] });
  return t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(accessToken), payload });
}
/** Push jobs queued for the worker (not run in tests). */
const pushJobs = async () => (await t.c.queues.get('notifications.push').getJobs(['waiting', 'delayed'])).map((j) => j.data as { userIds: string[]; title: string; body: string; url: string | null; category: string });
const token = (n: number) => `ExponentPushToken[test-${n}-${Date.now()}]`;

describe('in-app list and push', () => {
  it('a notification once per event, an unread count, read', async () => {
    const s = await registerStudent(t);
    const n = { type: 'test', category: 'social' as const, title: 'Bonjour', body: 'Message de test', icon: 'megaphone-outline', dedupeKey: 'test:1' };
    await t.c.modules.notifications.notify([new ObjectId(s.userId)], n);
    await t.c.modules.notifications.notify([new ObjectId(s.userId)], n); // retried event
    const list = json(await call(s, 'GET', '/notifications'));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ title: 'Bonjour', read: false, category: 'social' });
    expect(json(await call(s, 'GET', '/notifications/unread-count'))).toEqual({ count: 1 });
    expect((await call(s, 'POST', '/notifications/read', { all: true })).statusCode).toBe(204);
    expect(json(await call(s, 'GET', '/notifications/unread-count'))).toEqual({ count: 0 });
    expect((await pushJobs()).filter((j) => j.userIds.includes(s.userId) && j.title === 'Bonjour')).toHaveLength(1);
  });

  it('push goes to the phone’s token, respects the category switch, and drops uninstalled phones', async () => {
    const s = await registerStudent(t);
    const [ok, gone] = [token(1), token(2)];
    expect((await call(s, 'PUT', '/me/push-tokens', { token: ok, platform: 'android' })).statusCode).toBe(204);
    await call(s, 'PUT', '/me/push-tokens', { token: gone, platform: 'ios' });
    expect((await call(s, 'PUT', '/me/push-tokens', { token: 'not-a-token', platform: 'ios' })).statusCode).toBe(400);

    const sent: PushMessage[] = [];
    const sender: PushSender = { send: async (ms) => (sent.push(...ms), ms.map((m) => (m.to === gone ? { ok: false as const, error: 'DeviceNotRegistered' } : { ok: true as const }))) };
    const job = { userIds: [s.userId], title: 'Billet', body: 'Test', url: '/billet/x', category: 'paiements' as const };
    expect(await t.c.modules.notifications.sendPush(job, sender)).toEqual({ sent: 1 });
    expect(sent.map((m) => m.to).sort()).toEqual([ok, gone].sort());
    expect(sent[0]).toMatchObject({ title: 'Billet', data: { url: '/billet/x' }, channelId: 'campus' });
    // A shop's new order rings on its own Android channel.
    const orders: PushMessage[] = [];
    await t.c.modules.notifications.sendPush({ ...job, channel: 'orders' }, { send: async (ms) => (orders.push(...ms), ms.map(() => ({ ok: true as const }))) });
    expect(orders[0]).toMatchObject({ channelId: 'commandes' });
    expect(await t.c.mongo.db.collection('pushTokens').findOne({ token: gone })).toMatchObject({ active: false, lastError: 'DeviceNotRegistered' });

    // "Paiements" switched off in the profile: nothing sent for that category.
    await call(s, 'PUT', '/me/notification-preferences', { social: true, cours: true, paiements: false });
    const log = new LogPushSender();
    expect(await t.c.modules.notifications.sendPush(job, log)).toEqual({ sent: 0 });
    expect(await t.c.modules.notifications.sendPush({ ...job, category: 'social' }, log)).toEqual({ sent: 1 });

    // Signing out on this phone stops its notifications.
    await call(s, 'POST', '/me/push-tokens/unregister', { token: ok });
    expect(await t.c.modules.notifications.sendPush({ ...job, category: 'social' }, log)).toEqual({ sent: 0 });
  });

  it('an admin can notify one account (testing push on a phone)', async () => {
    const s = await registerStudent(t);
    const admin = await createStaff(t, ['admin', 'team_manager', 'payments_manager', 'notifications_sender']);
    const res = await t.app.inject({
      method: 'POST', url: '/api/v1/admin/notifications', headers: bearer(admin.tokens.accessToken),
      payload: { phone: s.phone, title: 'Test push', body: 'Ça marche', category: 'social' },
    });
    expect(res.statusCode).toBe(202);
    expect(json(await call(s, 'GET', '/notifications')).items[0]).toMatchObject({ title: 'Test push', url: '/notifications' });
  });
});

describe('what triggers them', () => {
  it('a ticket offered, accepted; a departure confirmed; a chat message (push only)', async () => {
    t.clock.set(T0);
    const owner = await createStaff(t);
    const org = await t.c.modules.organizations.create({ slug: `notif-${Date.now() % 1e6}`, name: 'Globe One', category: 'Entreprise', capabilities: ['caravans'], level: 'confirme', payoutPhone: owner.phone });
    await t.c.modules.organizations.setOwner(org._id, owner.phone, null);
    const o = { userId: owner.userId.toHexString() };
    const orgId = org._id.toHexString();
    const v = json(await call(o, 'POST', `/org/${orgId}/vehicles`, { label: 'Minibus', plate: `NT ${Date.now() % 10000} XY`, capacity: 12 }));
    const at = (h: number) => new Date(T0 + h * 3_600_000).toISOString();
    const draft = json(await call(o, 'POST', `/org/${orgId}/departures`, {
      vehicleId: v.id, direction: 'aller', from: 'UGB', to: 'Dakar', price: 3000, minPassengers: 2,
      pickups: [{ place: 'UGB · Village E', at: at(72) }], dropoffs: [{ place: 'Dakar · Colobane', at: at(78) }],
    }));
    await call(o, 'POST', `/org/${orgId}/departures/${draft.id}/publish`);

    const buy = async (s: Who) => {
      // A request, then validated by the organizer (paid in cash).
      const { booking } = json(await call(s, 'POST', `/caravans/departures/${draft.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd1' }));
      const orderId = (await t.c.mongo.db.collection('bookings').findOne({ _id: new ObjectId(booking.id) }))!.orderId.toHexString();
      await call(o, 'POST', `/org/${orgId}/departures/requests/${orderId}/validate`);
      return json(await call(s, 'GET', `/caravans/bookings/${booking.id}`)).ticketId as string;
    };
    const [a, b, friend] = [await registerStudent(t), await registerStudent(t), await registerStudent(t)];
    const ticketA = await buy(a);
    await buy(b); // minimum reached: confirmed
    await new Promise((r) => setTimeout(r, 50)); // after-commit effects
    for (const s of [a, b]) {
      expect(json(await call(s, 'GET', '/notifications')).items[0]).toMatchObject({ type: 'caravan.confirmed', title: 'Départ confirmé · UGB → Dakar', category: 'paiements' });
    }

    const offer = json(await call(a, 'POST', `/tickets/${ticketA}/transfers`, { recipientPhone: friend.phone }));
    expect(json(await call(friend, 'GET', '/notifications')).items[0]).toMatchObject({ type: 'ticket.transfer_offered', title: 'Awa D. t’offre son billet', url: expect.stringMatching(/^\/cadeau\/[0-9a-f]{24}\?ticket=[0-9a-f]{24}$/) });
    await call(friend, 'POST', `/ticket-transfers/${offer.id}/accept`);
    expect(json(await call(a, 'GET', '/notifications')).items[0]).toMatchObject({ type: 'ticket.transfer_accepted', url: `/billet/${ticketA}` });

    // Taxi chat: the other member gets a push, not a line in the bell list.
    const org2 = await registerStudent(t);
    const trip = json(await call(org2, 'POST', '/taxi/trips', { from: 'UGB', to: 'Gandon', seats: 4, fare: 2000, leaveInMinutes: 60 }));
    const rider = await registerStudent(t);
    const { payment } = json(await call(rider, 'POST', `/taxi/trips/${trip.id}/join`, { method: 'wave' }));
    await t.app.inject({ method: 'POST', url: `/api/v1/dev/payment-simulator/${payment.reference}/pay`, headers: { 'content-type': 'text/plain' }, payload: '' });
    await new Promise((r) => setTimeout(r, 50));
    expect(json(await call(org2, 'GET', '/notifications')).items[0]).toMatchObject({ type: 'taxi.joined', title: 'Awa a rejoint ton trajet' });
    const conversationId = json(await call(rider, 'GET', `/taxi/trips/${trip.id}`)).conversationId;
    await call(rider, 'POST', `/conversations/${conversationId}/messages`, { body: 'J’arrive dans 5 min', clientMessageId: `push-${Date.now()}` });
    await new Promise((r) => setTimeout(r, 50));
    const chatPush = (await pushJobs()).find((j) => j.body === 'J’arrive dans 5 min');
    expect(chatPush).toMatchObject({ userIds: [org2.userId], title: 'Awa D. · UGB → Gandon', url: `/trajet/${trip.id}`, category: 'social' });
    expect(json(await call(org2, 'GET', '/notifications')).items.some((n: { type: string }) => n.type === 'chat.message')).toBe(false);
  });
});
