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

  it('several tickets of several types in one payment; the buyer can give the extra ones; places are counted', async () => {
    const { owner, orgId, body } = await setup();
    const ev = await ok(call(owner, 'POST', `/org/${orgId}/events`, body), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/events/${ev.id}/publish`));
    const [std, vip] = ev.ticketTypes;
    const s = await registerStudent(t);
    const listed = await ok(call(s, 'GET', `/events/${ev.id}`));
    expect(listed).toMatchObject({ salesOpen: true, myTicketsLeft: 4, ticketTypes: [{ name: 'Standard', remaining: 3 }, { name: 'VIP', remaining: 2, description: 'Table et boisson' }] });

    const { booking, payment } = await ok(call(s, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: std.typeId, qty: 2 }, { typeId: vip.typeId, qty: 1 }], method: 'wave' }), 201);
    expect(payment.amount).toBe(9000);
    expect(booking.tickets.map((x: { name: string }) => x.name)).toEqual(['Standard', 'Standard', 'VIP']);
    await pay(payment.reference);
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
    expect(await ok(call(s, 'POST', `/tickets/${vipTicket.id}/cancel`))).toEqual({ refundAmount: 5000, fee: 0 });
    expect((await ok(call(s, 'GET', `/events/${ev.id}`))).ticketTypes[1].remaining).toBe(2);
  });

  it('the organizer chooses how to pay; cash at the door: tickets at once, nothing paid in the app', async () => {
    const { owner, orgId, body } = await setup();
    // Not said: Wave and Orange Money, as before.
    const classic = await ok(call(owner, 'POST', `/org/${orgId}/events`, body), 201);
    expect(classic.paymentMethods).toEqual(['wave', 'orange_money']);
    const ev = await ok(call(owner, 'POST', `/org/${orgId}/events`, { ...body, paymentMethods: ['cash', 'wave'] }), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/events/${ev.id}/publish`));
    const s = await registerStudent(t);
    expect((await ok(call(s, 'GET', `/events/${ev.id}`))).paymentMethods).toEqual(['cash', 'wave']);
    const [std] = ev.ticketTypes;
    expect(json(await call(s, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: std.typeId, qty: 1 }], method: 'orange_money' })).field).toBe('method');
    const booked = await ok(call(s, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: std.typeId, qty: 2 }], method: 'cash' }), 201);
    expect(booked.payment).toBeNull();
    expect(booked.booking.status).toBe('confirmed');
    const ticket = await ok(call(s, 'GET', `/tickets/${booked.booking.tickets[0].ticketId}`));
    expect(ticket).toMatchObject({ paidWith: 'cash', cashDue: 2000 });
    expect(await t.c.mongo.db.collection('payments').countDocuments({ userId: new ObjectId(s.userId) })).toBe(0);
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

  it('scanned at the entrance; the attendee list; cancelling the event refunds everyone; claim after the end', async () => {
    const { owner, orgId, body } = await setup();
    const ev = await ok(call(owner, 'POST', `/org/${orgId}/events`, body), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/events/${ev.id}/publish`));
    const s = await registerStudent(t);
    const { payment } = await ok(call(s, 'POST', `/events/${ev.id}/bookings`, { items: [{ typeId: ev.ticketTypes[0].typeId, qty: 1 }], method: 'wave' }), 201);
    await pay(payment.reference);
    const ticket = (await ok(call(s, 'GET', '/tickets'))).items.find((x: { kind: string }) => x.kind === 'event_entry');

    expect(await ok(call(owner, 'POST', `/org/${orgId}/admissions`, { qr: ticket.qr }))).toMatchObject({ result: 'rejected', reason: 'too_early' });
    t.clock.set(T0 + 5 * DAY - HOUR);
    expect(await ok(call(owner, 'POST', `/org/${orgId}/admissions`, { qr: ticket.qr }))).toMatchObject({ result: 'admitted', text: expect.stringContaining('Billet Standard') });
    expect(await ok(call(owner, 'POST', `/org/${orgId}/admissions`, { qr: ticket.qr }))).toMatchObject({ result: 'duplicate', title: 'Déjà entré' });
    const list = await ok(call(owner, 'GET', `/org/${orgId}/events/${ev.id}/attendees`));
    expect(list.attendees).toEqual([expect.objectContaining({ typeName: 'Standard', name: 'Awa Diop', admitted: true })]);

    t.clock.set(T0 + 5 * DAY + 9 * HOUR);
    const payout = await ok(call(owner, 'POST', `/org/${orgId}/events/${ev.id}/claim`, { method: 'wave' }));
    expect(payout).toMatchObject({ amount: 2000 });

    // Another event, cancelled before it starts: refunded.
    const e2 = await setup();
    const ev2 = await ok(call(e2.owner, 'POST', `/org/${e2.orgId}/events`, e2.body), 201);
    await ok(call(e2.owner, 'POST', `/org/${e2.orgId}/events/${ev2.id}/publish`));
    const b = await registerStudent(t);
    const p2 = await ok(call(b, 'POST', `/events/${ev2.id}/bookings`, { items: [{ typeId: ev2.ticketTypes[1].typeId, qty: 1 }], method: 'wave' }), 201);
    await pay(p2.payment.reference);
    expect(await ok(call(e2.owner, 'POST', `/org/${e2.orgId}/events/${ev2.id}/cancel`, { reason: 'Salle indisponible' }))).toEqual({ refunded: 1 });
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
    // The student now owns their own organization: the organizer space (scanning, attendees).
    expect(json(await call(s, 'GET', '/me')).spaces.map((x: { type: string }) => x.type)).toEqual(['student', 'organizer']);

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

