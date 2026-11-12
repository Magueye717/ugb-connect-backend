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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
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
const at = (ms: number) => new Date(T0 + ms).toISOString();
/** The organizer validates a request (the cash handed over). */
const validate = (owner: Who, orgId: string, bookingId: string) => ok(call(owner, 'POST', `/org/${orgId}/events/requests/${bookingId}/validate`));

let seq = 0;
/** An organization verified for events, its owner, two uploaded pictures, and a published party in 5 days. */
async function setup(over: { capabilities?: ('events' | 'caravans')[]; free?: boolean } = {}) {
  t.clock.set(T0);
  const owner = await createStaff(t);
  const org = await t.c.modules.organizations.create({ slug: `bde-${++seq}-${Date.now() % 1e6}`, name: 'BDE SAT', category: 'Amicale', capabilities: over.capabilities ?? ['events'], level: 'confirme', payoutPhone: owner.phone });
  await t.c.modules.organizations.setOwner(org._id, owner.phone, null);
  const o = { userId: owner.userId.toHexString() };
  const imgs = await Promise.all([1, 2].map(async () => (await t.c.modules.media.service.upload(owner.userId, 'event', await picture(), 'http://test/api/v1'))._id.toHexString()));
  const body = {
    title: 'Soirée d’intégration SAT', category: 'soiree', description: 'DJ, buffet, ambiance.', imageIds: imgs, venue: { name: 'Esplanade Village E' },
    startsAt: at(5 * DAY), endsAt: at(5 * DAY + 6 * HOUR), maxPerStudent: 4,
    ticketTypes: over.free ? [{ name: 'Entrée', price: 0, capacity: 100 }] : [{ name: 'Standard', price: 2000, capacity: 3 }, { name: 'VIP', price: 5000, capacity: 2, description: 'Table et boisson' }],
  };
  return { owner: o, orgId: org._id.toHexString(), body };
}

describe('events', () => {
  it('only an organization verified for events creates them; nothing is sold before publishing', async () => {
    const { owner, orgId, body } = await setup({ capabilities: ['caravans'] });
    expect((await call(owner, 'POST', `/org/${orgId}/events`, body)).statusCode).toBe(403);
    const v = await setup();
    const draft = await ok(call(v.owner, 'POST', `/org/${v.orgId}/events`, v.body), 201);
    expect(draft).toMatchObject({ status: 'draft', salesOpen: false, minPrice: 2000, images: [expect.stringMatching(/\.webp$/), expect.stringMatching(/\.webp$/)] });
    const s = await registerStudent(t);
    expect((await call(s, 'GET', `/events/${draft.id}`)).statusCode).toBe(404);
    // Someone else's pictures can't be attached.
    const other = await createStaff(t);
    const stranger = (await t.c.modules.media.service.upload(other.userId, 'event', await picture(), 'http://test/api/v1'))._id.toHexString();
    expect((await call(v.owner, 'POST', `/org/${v.orgId}/events`, { ...v.body, imageIds: [stranger] })).statusCode).toBe(400);
  });

  it('it may start in a few minutes, never in the past', async () => {
    const { owner, orgId, body } = await setup();
    const soon = { ...body, startsAt: at(10 * 60_000), endsAt: at(4 * HOUR) };
    const e = await ok(call(owner, 'POST', `/org/${orgId}/events`, soon), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/events/${e.id}/publish`));
    const past = await call(owner, 'POST', `/org/${orgId}/events`, { ...body, startsAt: at(-HOUR), endsAt: at(3 * HOUR) });
    expect(json(past).code).toBe('EVENT_IN_PAST');
  });

  it('once published, the organizer reorders the pictures, picks the cover or takes some off, never adds new ones', async () => {
    const { owner, orgId, body } = await setup();
    const e = await ok(call(owner, 'POST', `/org/${orgId}/events`, body), 201);
    const [first, second] = e.imageIds as string[];
    // Before publishing, the pictures change with the rest of the event.
    expect(json(await call(owner, 'PUT', `/org/${orgId}/events/${e.id}/photos`, { imageIds: [second, first], fixedCover: true })).code).toBe('EVENT_NOT_PUBLISHED');
    await ok(call(owner, 'POST', `/org/${orgId}/events/${e.id}/publish`));

    const swapped = await ok(call(owner, 'PUT', `/org/${orgId}/events/${e.id}/photos`, { imageIds: [second, first], fixedCover: true }));
    expect(swapped).toMatchObject({ status: 'published', imageIds: [second, first], fixedCover: true, images: [e.images[1], e.images[0]] });
    const s = await registerStudent(t);
    expect((await ok(call(s, 'GET', `/events/${e.id}`))).images).toEqual([e.images[1], e.images[0]]);

    // A picture the team never saw, or one twice: refused.
    const fresh = (await t.c.modules.media.service.upload(new ObjectId(owner.userId), 'event', await picture(), 'http://test/api/v1'))._id.toHexString();
    expect((await call(owner, 'PUT', `/org/${orgId}/events/${e.id}/photos`, { imageIds: [fresh, first], fixedCover: false })).statusCode).toBe(400);
    expect((await call(owner, 'PUT', `/org/${orgId}/events/${e.id}/photos`, { imageIds: [first, first], fixedCover: false })).statusCode).toBe(400);
    expect((await call(owner, 'PUT', `/org/${orgId}/events/${e.id}/photos`, { imageIds: [], fixedCover: false })).statusCode).toBe(400);

    // One left: no cover to fix.
    expect(await ok(call(owner, 'PUT', `/org/${orgId}/events/${e.id}/photos`, { imageIds: [first], fixedCover: true }))).toMatchObject({ imageIds: [first], fixedCover: false });
    // Someone outside the organization can't touch it.
    expect((await call(s, 'PUT', `/org/${orgId}/events/${e.id}/photos`, { imageIds: [first], fixedCover: false })).statusCode).toBe(404);
  });

  it('several tickets of several types in one request; the buyer can give the extra ones; places are counted', async () => {
    const { owner, orgId, body } = await setup();
    const ev = await ok(call(owner, 'POST', `/org/${orgId}/events`, body), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/events/${ev.id}/publish`));
    const [std, vip] = ev.ticketTypes;
    const s = await registerStudent(t);
    const listed = await ok(call(s, 'GET', `/events/${ev.id}`));
    expect(listed).toMatchObject({ salesOpen: true, myTicketsLeft: 4, ticketTypes: [{ name: 'Standard', remaining: 3 }, { name: 'VIP', remaining: 2, description: 'Table et boisson' }] });

    const { booking, payment } = await ok(call(s, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: std.typeId, qty: 2 }, { typeId: vip.typeId, qty: 1 }] }), 201);
    expect(payment).toBeNull();
    expect(booking).toMatchObject({ status: 'held', total: 9000 });
    expect(booking.tickets.map((x: { name: string }) => x.name)).toEqual(['Standard', 'Standard', 'VIP']);
    await validate(owner, orgId, booking.id);
    const done = await ok(call(s, 'GET', `/events/bookings/${booking.id}`));
    expect(done.status).toBe('confirmed');
    const tickets = (await ok(call(s, 'GET', '/tickets'))).items.filter((x: { kind: string }) => x.kind === 'event_entry');
    expect(tickets).toHaveLength(3);
    expect(tickets[0]).toMatchObject({ event: { title: 'Soirée d’intégration SAT' }, details: { venue: { name: 'Esplanade Village E' } }, status: 'active' });
    expect(tickets.every((x: { qr: string | null }) => !!x.qr)).toBe(true);

    // Limits: one Standard left, VIP one left; 4 tickets max per student (3 already).
    expect(json(await call(s, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: std.typeId, qty: 2 }], method: 'wave' })).code).toBe('TICKET_LIMIT');
    const other = await registerStudent(t);
    expect(json(await call(other, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: std.typeId, qty: 2 }], method: 'wave' })).code).toBe('SOLD_OUT');

    // An extra ticket goes to a friend: it becomes theirs.
    const extra = tickets.find((x: { id: string }) => x.id !== tickets[tickets.length - 1].id);
    const friend = await registerStudent(t);
    const offer = await ok(call(s, 'POST', `/tickets/${extra.id}/transfers`, { recipientPhone: friend.phone }), 201);
    await ok(call(friend, 'POST', `/ticket-transfers/${offer.id}/accept`));
    expect(await ok(call(friend, 'GET', `/tickets/${extra.id}`))).toMatchObject({ status: 'active', kind: 'event_entry' });

    // A cancelled ticket goes back on sale.
    const vipTicket = tickets.find((x: { details: { typeName: string } }) => x.details.typeName === 'VIP');
    expect(await ok(call(s, 'POST', `/tickets/${vipTicket.id}/cancel`))).toEqual({ refundAmount: 0, fee: 0 });
    expect((await ok(call(s, 'GET', `/events/${ev.id}`))).ticketTypes[1].remaining).toBe(2);
  });

  it('a request of several tickets: each has its own code; one paid and validated, the others keep waiting (then expire alone)', async () => {
    const { owner, orgId, body } = await setup();
    const ev = await ok(call(owner, 'POST', `/org/${orgId}/events`, body), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/events/${ev.id}/publish`));
    const [std] = ev.ticketTypes;
    const s = await registerStudent(t);
    const req = (await ok(call(s, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: std.typeId, qty: 2 }] }), 201)).booking;
    const mine = (await ok(call(s, 'GET', `/events/${ev.id}`))).myBooking;
    expect(mine.units).toHaveLength(2);
    const [u1, u2] = mine.units;
    expect(u1.code).toMatch(/^[0-9A-Z]{6}$/);
    expect(u1.code).not.toBe(u2.code);
    expect(u1.code).not.toBe(mine.code);
    // Scanned: one ticket's own code finds the request, that ticket picked.
    const found = (await ok(call(owner, 'GET', `/org/${orgId}/events/requests/by-code/UGBREQ:${u2.code}`))).request;
    expect(found).toMatchObject({ id: req.id, matched: u2.id, total: 4000, units: [expect.objectContaining({ id: u1.id }), expect.objectContaining({ id: u2.id })] });
    // Paid for one: only that ticket is issued; the other still waits, for the rest of the amount.
    const after = await ok(call(owner, 'POST', `/org/${orgId}/events/requests/${req.id}/validate`, { unitIds: [u2.id] }));
    expect(after).toMatchObject({ total: 2000, validated: 1, units: [expect.objectContaining({ id: u1.id })] });
    let view = await ok(call(s, 'GET', `/events/${ev.id}`));
    expect(view.myTickets).toHaveLength(1);
    expect(view.myBooking).toMatchObject({ count: 1, total: 2000, units: [expect.objectContaining({ id: u1.id })] });
    // The validated ticket's code no longer finds anything to validate on its own.
    expect((await ok(call(owner, 'GET', `/org/${orgId}/events/requests/by-code/${u2.code}`))).request).toBeNull();
    expect(json(await call(owner, 'POST', `/org/${orgId}/events/requests/${req.id}/validate`, { unitIds: [u2.id] })).code).toBe('TICKET_NOT_WAITING');
    // Not paid in time: the waiting one expires, the validated one stays valid; its place goes back on sale.
    t.clock.advance(DAY + 60_000);
    await t.c.modules.events.processors()['events.sweep']!();
    view = await ok(call(s, 'GET', `/events/${ev.id}`));
    expect(view.myBooking).toBeNull();
    expect(view.myTickets).toHaveLength(1);
    expect(view.ticketTypes[0].remaining).toBe(2);
    expect((await ok(call(s, 'GET', `/events/bookings/${req.id}`))).status).toBe('confirmed');
  });

  it('a request: paid to the organizer in cash, who validates it within 24 h (then nothing to collect at the door); else it expires', async () => {
    const { owner, orgId, body } = await setup();
    const ev = await ok(call(owner, 'POST', `/org/${orgId}/events`, { ...body, paymentMethods: ['wave'] }), 201);
    expect(ev.paymentMethods).toEqual(['cash']);
    await ok(call(owner, 'POST', `/org/${orgId}/events/${ev.id}/publish`));
    const [std, vip] = ev.ticketTypes;
    const s = await registerStudent(t);
    const req = await ok(call(s, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: std.typeId, qty: 2 }], method: 'wave' }), 201);
    expect(req.payment).toBeNull();
    expect(await t.c.mongo.db.collection('payments').countDocuments({ userId: new ObjectId(s.userId) })).toBe(0);
    const mine = (await ok(call(s, 'GET', `/events/${ev.id}`))).myBooking;
    expect(mine).toMatchObject({ awaitingValidation: true, total: 4000, count: 2, code: expect.stringMatching(/^[0-9A-Z]{6}$/), organizer: { phone: expect.any(String) } });
    expect((await ok(call(owner, 'GET', `/org/${orgId}/events/requests/by-code/${mine.code.toLowerCase()}`))).request).toMatchObject({ id: req.booking.id, total: 4000 });
    expect(new Date(mine.holdExpiresAt).getTime()).toBe(T0 + DAY);
    expect(json(await call(s, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: vip.typeId, qty: 1 }] })).code).toBe('REQUEST_PENDING');
    // The organizer is told, and sees who and how much.
    expect((await ok(call(owner, 'GET', '/notifications'))).items.map((n: { type: string }) => n.type)).toContain('event.request');
    expect((await ok(call(owner, 'GET', `/org/${orgId}/events/${ev.id}/requests`))).items).toEqual([
      expect.objectContaining({ id: req.booking.id, total: 4000, tickets: [{ name: 'Standard', qty: 2 }], student: expect.objectContaining({ name: 'Awa Diop' }) }),
    ]);
    await validate(owner, orgId, req.booking.id);
    const ticket = (await ok(call(s, 'GET', '/tickets'))).items.find((x: { kind: string }) => x.kind === 'event_entry');
    expect(ticket).toMatchObject({ paidWith: 'cash', cashDue: 0, status: 'active' });
    expect((await ok(call(owner, 'GET', `/org/${orgId}/events/${ev.id}/requests`))).items).toEqual([]);

    // Refused with a reason; another not validated within 24 h: both back on sale.
    const [a, b] = [await registerStudent(t), await registerStudent(t)];
    const ra = (await ok(call(a, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: vip.typeId, qty: 1 }] }), 201)).booking;
    const rb = (await ok(call(b, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: vip.typeId, qty: 1 }] }), 201)).booking;
    expect((await ok(call(owner, 'GET', `/events/${ev.id}`))).ticketTypes[1].remaining).toBe(0);
    expect((await call(owner, 'POST', `/org/${orgId}/events/requests/${ra.id}/refuse`, { reason: 'Paiement non reçu' })).statusCode).toBe(204);
    expect((await ok(call(a, 'GET', '/notifications'))).items[0]).toMatchObject({ type: 'event.request_refused', body: 'Paiement non reçu' });
    t.clock.advance(DAY + 60_000);
    await t.c.modules.events.processors()['events.sweep']!();
    expect((await ok(call(b, 'GET', `/events/bookings/${rb.id}`))).status).toBe('expired');
    expect((await ok(call(b, 'GET', '/notifications'))).items[0].type).toBe('event.request_expired');
    expect((await ok(call(owner, 'GET', `/events/${ev.id}`))).ticketTypes[1].remaining).toBe(2);
  });

  it('three requests waiting at most per student', async () => {
    const s = await registerStudent(t);
    for (let i = 0; i < 4; i++) {
      const { owner, orgId, body } = await setup();
      const ev = await ok(call(owner, 'POST', `/org/${orgId}/events`, body), 201);
      await ok(call(owner, 'POST', `/org/${orgId}/events/${ev.id}/publish`));
      const res = await call(s, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: ev.ticketTypes[0].typeId, qty: 1 }] });
      if (i < 3) expect(res.statusCode).toBe(201);
      else expect(json(res).code).toBe('TOO_MANY_REQUESTS');
    }
  });

  it('its organizing team (owner, door staff…) books no ticket for its own event; students do', async () => {
    const { owner, orgId, body } = await setup({ free: true });
    const ev = await ok(call(owner, 'POST', `/org/${orgId}/events`, body), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/events/${ev.id}/publish`));
    const scanner = await createStaff(t);
    await t.c.modules.organizations.setMember(new ObjectId(orgId), 'organizer', { phone: scanner.phone, roles: ['scanner'] }, null);
    const order = { items: [{ typeId: ev.ticketTypes[0].typeId, qty: 1 }], method: 'wave' };
    for (const who of [owner, { userId: scanner.userId.toHexString() }]) {
      expect((await ok(call(who, 'GET', `/events/${ev.id}`))).organizedByMe).toBe(true);
      expect(json(await call(who, 'POST', `/events/${ev.id}/bookings`, order)).code).toBe('OWN_EVENT');
    }
    const s = await registerStudent(t);
    expect((await ok(call(s, 'GET', `/events/${ev.id}`))).organizedByMe).toBe(false);
    await ok(call(s, 'POST', `/events/${ev.id}/bookings`, order), 201);

    // For friends: allowed, and none of the tickets is the organizer's own (all to give from the ticket).
    const gift = await ok(call(owner, 'POST', `/events/${ev.id}/bookings`, { ...order, items: [{ typeId: ev.ticketTypes[0].typeId, qty: 2 }], forFriends: true }), 201);
    expect(gift.booking).toMatchObject({ status: 'confirmed' });
    const tickets = await t.c.mongo.db.collection('tickets').find({ eventId: new ObjectId(ev.id), holderUserId: new ObjectId(owner.userId) }).toArray();
    expect(tickets).toHaveLength(2);
    expect(tickets.every((x) => x.holderTravels === false)).toBe(true);
  });

  it('for a friend by phone (they paid the organizer): refused if not on UGB Connect; the tickets are theirs at once', async () => {
    const { owner, orgId, body } = await setup();
    const ev = await ok(call(owner, 'POST', `/org/${orgId}/events`, body), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/events/${ev.id}/publish`));
    const standard = ev.ticketTypes[0].typeId;
    const order = (friendPhone: string, qty = 2) => call(owner, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: standard, qty }], friendPhone });

    // Not on the system: nothing is held.
    expect(json(await order('781234599')).code).toBe('FRIEND_NOT_FOUND');
    expect((await ok(call(owner, 'GET', `/events/${ev.id}`))).ticketTypes[0].remaining).toBe(3);
    // A student can't order for someone else this way.
    const friend = await registerStudent(t, { firstName: 'Fatou', lastName: 'Ndiaye' });
    const stranger = await registerStudent(t);
    expect(json(await call(stranger, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: standard, qty: 1 }], friendPhone: friend.phone })).code).toBe('FRIEND_ORDER_ORGANIZER');

    const made = await ok(order(friend.phone), 201);
    expect(made.booking).toMatchObject({ status: 'confirmed', total: 4000 });
    const tickets = await t.c.mongo.db.collection('tickets').find({ eventId: new ObjectId(ev.id), holderUserId: new ObjectId(friend.userId) }).toArray();
    expect(tickets).toHaveLength(2);
    expect(tickets.every((x) => x.paidWith === 'cash' && x.cashCollectedAt)).toBe(true);
    expect(await t.c.mongo.db.collection('tickets').countDocuments({ eventId: new ObjectId(ev.id), holderUserId: new ObjectId(owner.userId) })).toBe(0);
    expect((await ok(call(friend, 'GET', '/notifications'))).items.map((n: { type: string }) => n.type)).toContain('event.friend_gift');
    // It opens the tickets themselves.
    expect((await ok(call(friend, 'GET', '/notifications'))).items.find((n: { type: string }) => n.type === 'event.friend_gift').url).toMatch(/^\/billet\/[0-9a-f]{24}$/);
  });

  it('a free event issues its tickets at once', async () => {
    const { owner, orgId, body } = await setup({ free: true });
    const ev = await ok(call(owner, 'POST', `/org/${orgId}/events`, { ...body, title: 'Conférence IA', category: 'conference' }), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/events/${ev.id}/publish`));
    const s = await registerStudent(t);
    const res = await ok(call(s, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: ev.ticketTypes[0].typeId, qty: 1 }], method: 'wave' }), 201);
    expect(res.payment).toBeNull();
    expect(res.booking).toMatchObject({ status: 'confirmed', total: 0 });
    expect((await ok(call(s, 'GET', `/events/${ev.id}`))).myTickets).toHaveLength(1);
  });

  it('scanned at the entrance; the attendee list; cancelling the event tells everyone; nothing to claim (paid in cash)', async () => {
    const { owner, orgId, body } = await setup();
    const ev = await ok(call(owner, 'POST', `/org/${orgId}/events`, body), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/events/${ev.id}/publish`));
    const s = await registerStudent(t);
    const { booking } = await ok(call(s, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: ev.ticketTypes[0].typeId, qty: 1 }] }), 201);
    await validate(owner, orgId, booking.id);
    const ticket = (await ok(call(s, 'GET', '/tickets'))).items.find((x: { kind: string }) => x.kind === 'event_entry');

    expect(await ok(call(owner, 'POST', `/org/${orgId}/admissions`, { qr: ticket.qr }))).toMatchObject({ result: 'rejected', reason: 'too_early' });
    t.clock.set(T0 + 5 * DAY - HOUR);
    expect(await ok(call(owner, 'POST', `/org/${orgId}/admissions`, { qr: ticket.qr }))).toMatchObject({ result: 'admitted', text: expect.stringContaining('Billet Standard') });
    expect(await ok(call(owner, 'POST', `/org/${orgId}/admissions`, { qr: ticket.qr }))).toMatchObject({ result: 'duplicate', title: 'Déjà entré' });
    const list = await ok(call(owner, 'GET', `/org/${orgId}/events/${ev.id}/attendees`));
    expect(list.attendees).toEqual([expect.objectContaining({ typeName: 'Standard', name: 'Awa Diop', admitted: true })]);

    t.clock.set(T0 + 5 * DAY + 9 * HOUR);
    // The cash went to the organizer: the app has nothing to pay out.
    expect((await call(owner, 'POST', `/org/${orgId}/events/${ev.id}/claim`, { method: 'wave' })).statusCode).toBe(422);

    // Another event, cancelled before it starts: refunded.
    const e2 = await setup();
    const ev2 = await ok(call(e2.owner, 'POST', `/org/${e2.orgId}/events`, e2.body), 201);
    await ok(call(e2.owner, 'POST', `/org/${e2.orgId}/events/${ev2.id}/publish`));
    const b = await registerStudent(t);
    const p2 = await ok(call(b, 'POST', `/events/${ev2.id}/bookings`, { items: [{ typeId: ev2.ticketTypes[1].typeId, qty: 1 }] }), 201);
    await validate(e2.owner, e2.orgId, p2.booking.id);
    expect(await ok(call(e2.owner, 'POST', `/org/${e2.orgId}/events/${ev2.id}/cancel`, { reason: 'Salle indisponible' }))).toEqual({ refunded: 0 });
    expect((await ok(call(b, 'GET', '/notifications'))).items[0]).toMatchObject({ title: 'Annulé par l’organisateur : Soirée d’intégration SAT' });
  });
});

describe('students’ events', () => {
  it('a student creates an event in their name; the admins approve it, or ask for corrections with a message', async () => {
    t.clock.set(T0);
    const s = await registerStudent(t);
    const admin = { userId: (await createStaff(t, ['admin'])).userId.toHexString() };
    expect((await ok(call(s, 'GET', '/me/events'))).items).toEqual([]);
    // The price of the publication is known before creating anything.
    expect(await ok(call(s, 'GET', '/me/events/publication-fee'))).toEqual({ perPlace: 40, minimum: 500 });
    const pic = (await t.c.modules.media.service.upload(new ObjectId(s.userId), 'event', await picture(), 'http://test/api/v1'))._id.toHexString();
    const body = {
      title: 'Soirée karaoké Village E', category: 'soiree', description: 'Micro ouvert.', imageIds: [pic], venue: { name: 'Foyer Village E' },
      startsAt: at(4 * DAY), endsAt: at(4 * DAY + 4 * HOUR), ticketTypes: [{ name: 'Entrée', price: 500, capacity: 80 }],
    };
    const draft = await ok(call(s, 'POST', '/me/events', body), 201);
    expect(draft).toMatchObject({ status: 'draft', organizer: { name: 'Awa Diop', category: 'Étudiant' } });
    // The student now owns their own organization, managed from the student space (« Mes événements »): no organizer space.
    expect(json(await call(s, 'GET', '/me')).spaces.map((x: { type: string }) => x.type)).toEqual(['student']);
    // Yet they run its door: the organization's routes accept them (requests by code, scans).
    expect((await call(s, 'GET', `/org/${draft.organizer.id}/events/requests/by-code/NOPE00`)).statusCode).toBe(200);

    const submitted = await ok(call(s, 'POST', `/me/events/${draft.id}/submit`));
    expect(submitted.status).toBe('pending_review');
    expect((await call(s, 'GET', `/events/${draft.id}`)).statusCode).toBe(404); // not public yet
    expect(json(await call(s, 'PUT', `/me/events/${draft.id}`, body)).code).toBe('EVENT_IN_REVIEW');

    expect((await call(s, 'GET', '/admin/events')).statusCode).toBe(403);
    expect((await ok(call(admin, 'GET', '/admin/events'))).items.some((e: { id: string }) => e.id === draft.id)).toBe(true);
    const sent = await ok(call(admin, 'POST', `/admin/events/${draft.id}/request-changes`, { message: 'Précise l’heure de fin et ajoute une vraie photo du lieu.' }));
    expect(sent).toMatchObject({ status: 'changes_requested', review: { message: 'Précise l’heure de fin et ajoute une vraie photo du lieu.' } });
    expect((await ok(call(s, 'GET', '/notifications'))).items[0]).toMatchObject({ type: 'event.changes_requested', title: 'Corrections demandées · Soirée karaoké Village E', url: `/mes-evenements/${draft.id}` });

    // Corrected, then submitted again: approved, still not on sale.
    await ok(call(s, 'PUT', `/me/events/${draft.id}`, { ...body, endsAt: at(4 * DAY + 5 * HOUR) }));
    await ok(call(s, 'POST', `/me/events/${draft.id}/submit`));
    const approved = await ok(call(admin, 'POST', `/admin/events/${draft.id}/approve`));
    expect(approved).toMatchObject({ status: 'approved', review: null, salesOpen: false, publication: null, publicationFee: { perPlace: 40, minimum: 500 } });
    expect(approved.reviewLog.map((r: { action: string }) => r.action)).toEqual(['submitted', 'changes_requested', 'submitted', 'approved']);
    expect((await ok(call(s, 'GET', '/notifications'))).items[0]).toMatchObject({ type: 'event.approved' });
    const buyer = await registerStudent(t); // Campus 1, Village E, SAT
    const elsewhere = await registerStudent(t, { campus: 'campus2' }); // Village H
    expect((await call(buyer, 'GET', `/events/${draft.id}`)).statusCode).toBe(404);
    // Approved: the date and the prices can't change any more.
    expect(json(await call(s, 'PUT', `/me/events/${draft.id}`, body)).code).toBe('EVENT_PUBLISHED');

    // The owner chooses who sees it and how many places to sell, then pays per place.
    const typeId = approved.ticketTypes[0].typeId;
    const publication = { audience: { campuses: [], ufrs: ['SAT'], regions: [], villages: ['Village E'] }, places: [{ typeId, capacity: 60 }], description: 'Micro ouvert, jus offert.', method: 'wave' };
    expect((await call(s, 'POST', `/me/events/${draft.id}/publish`, { ...publication, audience: { ...publication.audience, villages: ['Village Z'] } })).statusCode).toBe(400);
    const first = await ok(call(s, 'POST', `/me/events/${draft.id}/publish`, { ...publication, places: [{ typeId, capacity: 5 }] }));
    expect(first.payment.amount).toBe(500); // the minimum
    const { event: paying, payment } = await ok(call(s, 'POST', `/me/events/${draft.id}/publish`, publication));
    expect(payment.amount).toBe(2400); // 60 × 40
    expect(paying).toMatchObject({ status: 'approved', description: 'Micro ouvert, jus offert.', publication: { places: 60, fee: 2400, paid: false, payment: { reference: payment.reference } } });
    // The replaced payment, paid late anyway, publishes nothing: it is refunded.
    await pay(first.payment.reference);
    expect((await ok(call(s, 'GET', `/payments/${first.payment.reference}`))).fulfillment).toBe('unfulfillable');
    expect((await ok(call(s, 'GET', `/me/events/${draft.id}`))).status).toBe('approved');
    expect((await pay(payment.reference)).statusCode).toBe(200);
    const live = await ok(call(s, 'GET', `/me/events/${draft.id}`));
    expect(live).toMatchObject({ status: 'published', salesOpen: true, audience: { ufrs: ['SAT'], villages: ['Village E'] }, publication: { paid: true, payment: null } });
    // The admins' « En cours »: what's validated or on sale and not over yet.
    expect((await ok(call(admin, 'GET', '/admin/events?status=live'))).items.map((x: { id: string }) => x.id)).toContain(draft.id);
    expect((await ok(call(admin, 'GET', '/admin/events?status=pending_review'))).items.map((x: { id: string }) => x.id)).not.toContain(draft.id);
    expect(live.ticketTypes[0]).toMatchObject({ capacity: 60, remaining: 60 });
    expect((await ok(call(s, 'GET', '/notifications'))).items[0]).toMatchObject({ type: 'event.published' });
    // Published: its pictures may still be reordered (only those the team saw).
    expect(await ok(call(s, 'PUT', `/me/events/${draft.id}/photos`, { imageIds: [pic], fixedCover: false }))).toMatchObject({ imageIds: [pic], status: 'published' });
    // On the home screen of the students it targets only (the page itself opens for anyone with the link).
    expect((await ok(call(buyer, 'GET', '/events'))).items.map((e: { id: string }) => e.id)).toContain(draft.id);
    // Students don't see the owner's name (their personal entity is named after them).
    expect((await ok(call(buyer, 'GET', `/events/${draft.id}`))).organizer).toMatchObject({ name: '', category: 'Étudiant' });
    expect((await ok(call(elsewhere, 'GET', '/events'))).items.map((e: { id: string }) => e.id)).not.toContain(draft.id);
    expect((await ok(call(buyer, 'GET', `/events/${draft.id}`))).salesOpen).toBe(true);
    // Its creator runs it: no ticket for them (students may).
    expect(await ok(call(s, 'GET', `/events/${draft.id}`))).toMatchObject({ organizedByMe: true });
    expect((await ok(call(buyer, 'GET', `/events/${draft.id}`))).organizedByMe).toBe(false);
    const own = await call(s, 'POST', `/events/${draft.id}/bookings`, { items: [{ typeId, qty: 1 }], method: 'wave' });
    expect(own.statusCode).toBe(422);
    expect(json(own).code).toBe('OWN_EVENT');

    // Refused: with its reason.
    const other = await ok(call(s, 'POST', '/me/events', { ...body, title: 'Sortie plage' }), 201);
    await ok(call(s, 'POST', `/me/events/${other.id}/submit`));
    expect(await ok(call(admin, 'POST', `/admin/events/${other.id}/reject`, { message: 'Sortie hors campus non encadrée.' }))).toMatchObject({ status: 'rejected' });
    expect((await call(s, 'POST', `/me/events/${other.id}/submit`)).statusCode).toBe(409);
    // Another student can't touch it.
    expect((await call(buyer, 'PUT', `/me/events/${draft.id}`, body)).statusCode).toBe(404);
  });
});

