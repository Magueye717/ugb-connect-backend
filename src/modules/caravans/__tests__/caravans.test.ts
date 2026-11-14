import { createPublicKey, verify } from 'node:crypto';

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
type Who = { userId: string };

async function call(who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  const { accessToken } = await t.c.modules.identity.startSession({ _id: new ObjectId(who.userId), platformRoles: [] });
  return t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(accessToken), payload });
}
const ok = async (res: Promise<{ statusCode: number; body: string }>, status = 200) => {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return json(r);
};
const at = (ms: number) => new Date(T0 + ms).toISOString();

let seq = 0;
/** Each departure's organizer, to validate the requests made on it. */
const organizerOf = new Map<string, { owner: Who; orgId: string }>();
/** An organization with an owner and a scanner, a 12-seat minibus, and a published departure in 3 days. */
async function setup(over: { minPassengers?: number; departIn?: number; paymentMethods?: string[] } = {}) {
  t.clock.set(T0);
  const owner = await createStaff(t);
  const scanner = await createStaff(t);
  const org = await t.c.modules.organizations.create({ slug: `org-${++seq}-${Date.now() % 1e6}`, name: 'Khoulé & Frère', category: 'Entreprise', capabilities: ['caravans'], level: 'confirme', payoutPhone: owner.phone });
  await t.c.modules.organizations.setOwner(org._id, owner.phone, null);
  await t.c.modules.organizations.setMember(org._id, 'organizer', { phone: scanner.phone, roles: ['scanner'] }, null);
  const o = { userId: owner.userId.toHexString() };
  const orgId = org._id.toHexString();
  const vehicle = await ok(call(o, 'POST', `/org/${orgId}/vehicles`, { label: 'Minibus 12 places', plate: `DK ${1000 + seq} AB`, capacity: 12 }), 201);
  const start = over.departIn ?? 3 * DAY;
  const draft = await ok(
    call(o, 'POST', `/org/${orgId}/departures`, {
      vehicleId: vehicle.id, direction: 'aller', from: 'UGB', to: 'Dakar', price: 3500, minPassengers: over.minPassengers ?? 2, ...(over.paymentMethods ? { paymentMethods: over.paymentMethods } : {}),
      pickups: [{ place: 'UGB · Village E', at: at(start) }, { place: 'Saint-Louis · Gare routière', at: at(start + 40 * MIN) }],
      dropoffs: [{ place: 'Thiès · Mairie', at: at(start + 4 * HOUR) }, { place: 'Dakar · Colobane', at: at(start + 5.5 * HOUR) }],
    }),
    201,
  );
  expect(draft.status).toBe('draft');
  const dep = await ok(call(o, 'POST', `/org/${orgId}/departures/${draft.id}/publish`));
  organizerOf.set(dep.id, { owner: o, orgId });
  return { owner: o, scanner: { userId: scanner.userId.toHexString() }, orgId, dep };
}

/** The order a booking belongs to (all its seats are validated or refused together). */
const orderOf = async (bookingId: string) => ((await t.c.mongo.db.collection('bookings').findOne({ _id: new ObjectId(bookingId) }))!.orderId as ObjectId).toHexString();
/** The organizer validates a request (the cash handed over), as the departure's owner. */
async function validate(depId: string, bookingId: string) {
  const { owner, orgId } = organizerOf.get(depId)!;
  return ok(call(owner, 'POST', `/org/${orgId}/departures/requests/${await orderOf(bookingId)}/validate`));
}

/** Requests a seat (auto or chosen), then the organizer validates it (paid in cash); returns the ticket. */
async function buy(s: Who, depId: string, body: object = {}) {
  const { booking, payment } = await ok(call(s, 'POST', `/caravans/departures/${depId}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd2', ...body }), 201);
  expect(booking.status).toBe('held');
  expect(payment).toBeNull();
  await validate(depId, booking.id);
  const done = await ok(call(s, 'GET', `/caravans/bookings/${booking.id}`));
  expect(done).toMatchObject({ status: 'confirmed' });
  return ok(call(s, 'GET', `/tickets/${done.ticketId}`));
}

describe('browse and book', () => {
  it('a seat is a request: paid to the organizer in cash, who validates it; nothing to collect at boarding', async () => {
    const { dep, owner, orgId } = await setup();
    expect(dep.paymentMethods).toEqual(['cash']);
    const s = await registerStudent(t);
    const { booking, payment } = await ok(call(s, 'POST', `/caravans/departures/${dep.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd2', method: 'wave' }), 201);
    expect(payment).toBeNull();
    expect(new Date((await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).myBooking.holdExpiresAt).getTime()).toBe(T0 + DAY);
    const pending = (await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).myBooking;
    expect(pending).toMatchObject({ awaitingValidation: true, total: 3500, code: expect.stringMatching(/^[0-9A-Z]{6}$/), organizer: { name: expect.any(String), phone: expect.any(String) } });
    // Its QR code (or the code typed) finds it at the organizer's, nowhere else.
    expect((await ok(call(owner, 'GET', `/org/${orgId}/departures/requests/by-code/UGBREQ:${pending.code}`))).request).toMatchObject({ id: await orderOf(booking.id), title: 'UGB → Dakar', total: 3500 });
    const otherOrg = await setup();
    expect((await ok(call(otherOrg.owner, 'GET', `/org/${otherOrg.orgId}/departures/requests/by-code/${pending.code}`))).request).toBeNull();
    // The organizer is told, and sees who, which seat, which stops.
    const list = (await ok(call(owner, 'GET', `/org/${orgId}/departures/${dep.id}/requests`))).items;
    expect(list).toEqual([expect.objectContaining({ total: 3500, student: expect.objectContaining({ phone: expect.any(String) }), seats: [expect.objectContaining({ pickup: 'UGB · Village E', dropoff: 'Dakar · Colobane' })] })]);
    // A second request for the same departure: refused while one waits.
    expect(json(await call(s, 'POST', `/caravans/departures/${dep.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd2' })).code).toBe('REQUEST_PENDING');
    // Someone else can't validate it.
    const stranger = await registerStudent(t);
    expect((await call(stranger, 'POST', `/org/${orgId}/departures/requests/${await orderOf(booking.id)}/validate`)).statusCode).toBe(404);
    await validate(dep.id, booking.id);
    const done = await ok(call(s, 'GET', `/caravans/bookings/${booking.id}`));
    expect(await ok(call(s, 'GET', `/tickets/${done.ticketId}`))).toMatchObject({ status: 'active', paidWith: 'cash', cashDue: 0 });
    expect((await ok(call(owner, 'GET', `/org/${orgId}/departures/${dep.id}/requests`))).items).toEqual([]);
  });

  it('refused, or not validated within 24 h: cancelled, the seat back on sale; 3 requests at most at once', async () => {
    const deps = [await setup(), await setup(), await setup(), await setup()];
    const s = await registerStudent(t);
    const ask = (i: number) => call(s, 'POST', `/caravans/departures/${deps[i]!.dep.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd2' });
    const first = (await ok(ask(0), 201)).booking;
    const second = (await ok(ask(1), 201)).booking;
    await ok(ask(2), 201);
    expect(json(await ask(3)).code).toBe('TOO_MANY_REQUESTS');
    // Refused with a reason: the student is told, the seat is free again.
    const { owner, orgId } = organizerOf.get(deps[0]!.dep.id)!;
    expect((await call(owner, 'POST', `/org/${orgId}/departures/requests/${await orderOf(first.id)}/refuse`, { reason: 'Paiement non reçu' })).statusCode).toBe(204);
    expect(await ok(call(s, 'GET', `/caravans/bookings/${first.id}`))).toMatchObject({ status: 'cancelled' });
    expect((await ok(call(s, 'GET', `/caravans/departures/${deps[0]!.dep.id}`))).seatsFree).toBe(12);
    expect((await ok(call(s, 'GET', '/notifications'))).items.map((n: { body: string }) => n.body)).toContain('Paiement non reçu');
    // 24 h later, nobody validated the others: expired, seats back.
    t.clock.advance(DAY + MIN);
    await t.c.modules.caravans.service.sweep();
    expect(await ok(call(s, 'GET', `/caravans/bookings/${second.id}`))).toMatchObject({ status: 'expired' });
    expect((await ok(call(s, 'GET', `/caravans/departures/${deps[1]!.dep.id}`))).seatsFree).toBe(12);
    expect(json(await call(owner, 'POST', `/org/${orgId}/departures/requests/${await orderOf(second.id)}/validate`)).code).toBeDefined();
  });

  it('lists published departures; the plate is for ticket holders only', async () => {
    const { dep } = await setup();
    const s = await registerStudent(t);
    const listed = (await ok(call(s, 'GET', '/caravans/departures?direction=aller'))).items.find((d: { id: string }) => d.id === dep.id);
    expect(listed).toMatchObject({ from: 'UGB', to: 'Dakar', price: 3500, totalSeats: 12, seatsFree: 12, confirmed: false, bookingOpen: true, myTicketId: null, vehicle: { plate: null } });
    expect(listed.pickups.map((p: { stopId: string }) => p.stopId)).toEqual(['p1', 'p2']);
    const seats = await ok(call(s, 'GET', `/caravans/departures/${dep.id}/seats`));
    expect(seats).toMatchObject({ capacity: 12, seatsPerRow: 4, firstRowSeats: 2, taken: [], suggested: 2 });

    const ticket = await buy(s, dep.id);
    expect(ticket).toMatchObject({ kind: 'caravan_seat', status: 'active', seat: 2, price: 3500, event: { title: 'UGB → Dakar' }, details: { pickup: { place: 'UGB · Village E' }, dropoff: { place: 'Dakar · Colobane' } } });
    expect(ticket.code).toMatch(/^[0-9A-Z]{6}$/);
    expect(ticket.qr).toBeTruthy();
    const after = await ok(call(s, 'GET', `/caravans/departures/${dep.id}`));
    expect(after).toMatchObject({ myTicketId: ticket.id, seatsFree: 11, seatsBooked: 1, vehicle: { plate: expect.stringMatching(/^DK-/) } });
  });

  it('auto-pick takes window seats front to back; a chosen seat taken a moment ago is refused', async () => {
    const { dep } = await setup();
    const [a, b, c] = [await registerStudent(t), await registerStudent(t), await registerStudent(t)];
    // Row 1 is seats 1-2 on the right: 2 is its window seat, then 3 (left window of row 2).
    expect((await buy(a, dep.id)).seat).toBe(2);
    expect((await buy(b, dep.id)).seat).toBe(3);
    const race = await Promise.all([c, await registerStudent(t)].map((s) => call(s, 'POST', `/caravans/departures/${dep.id}/bookings`, { seat: 6, pickupStopId: 'p1', dropoffStopId: 'd1', method: 'wave' })));
    expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(json(race.find((r) => r.statusCode === 409)!).code).toBe('SEAT_TAKEN');
    expect((await ok(call(c, 'GET', `/caravans/departures/${dep.id}/seats`))).taken).toEqual([2, 3, 6]);
  });

  it('one seat for yourself per departure; bad stops refused', async () => {
    const { dep } = await setup();
    const s = await registerStudent(t);
    await buy(s, dep.id);
    expect(json(await call(s, 'POST', `/caravans/departures/${dep.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd1', method: 'wave' })).code).toBe('ALREADY_BOOKED');
    const other = await registerStudent(t);
    expect((await call(other, 'POST', `/caravans/departures/${dep.id}/bookings`, { pickupStopId: 'd1', dropoffStopId: 'p1', method: 'wave' })).statusCode).toBe(400);
  });

  it('the student withdraws a request: the seat is free at once', async () => {
    const { dep } = await setup();
    const s = await registerStudent(t);
    const again = await ok(call(s, 'POST', `/caravans/departures/${dep.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd1' }), 201);
    expect((await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).seatsFree).toBe(11);
    expect((await call(s, 'DELETE', `/caravans/bookings/${again.booking.id}`)).statusCode).toBe(204);
    expect((await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).seatsFree).toBe(12);
  });

  it('the departure is confirmed once the minimum is paid', async () => {
    const { dep } = await setup({ minPassengers: 2 });
    const [a, b] = [await registerStudent(t), await registerStudent(t)];
    await buy(a, dep.id);
    expect((await ok(call(a, 'GET', `/caravans/departures/${dep.id}`))).confirmed).toBe(false);
    await buy(b, dep.id);
    expect(await ok(call(a, 'GET', `/caravans/departures/${dep.id}`))).toMatchObject({ confirmed: true, status: 'confirmed' });
  });
});

describe('a departure soon', () => {
  it('in 20 minutes: allowed, on sale until it leaves, its minimum checked then (not cancelled at once)', async () => {
    const { owner, orgId, dep } = await setup({ departIn: 20 * MIN, minPassengers: 2 });
    const mine = await ok(call(owner, 'GET', `/org/${orgId}/departures/${dep.id}`));
    expect(mine.bookingClosesAt).toBe(at(20 * MIN));
    expect(mine.confirmBy).toBe(at(20 * MIN));
    await t.c.modules.caravans.service.sweep();
    const s = await registerStudent(t);
    expect(await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).toMatchObject({ status: 'published', bookingOpen: true });
    await buy(s, dep.id);
  });

  it('in 5 hours: on sale until it leaves, its minimum checked then (not 24 h before)', async () => {
    const { owner, orgId, dep } = await setup({ departIn: 5 * HOUR, minPassengers: 2 });
    const mine = await ok(call(owner, 'GET', `/org/${orgId}/departures/${dep.id}`));
    expect(mine.confirmBy).toBe(at(5 * HOUR));
    expect(mine.bookingClosesAt).toBe(at(5 * HOUR));
    await t.c.modules.caravans.service.sweep();
    expect((await ok(call(owner, 'GET', `/org/${orgId}/departures/${dep.id}`))).status).toBe('published');
  });
});

describe('cancel', () => {
  it('below the minimum again: no longer confirmed before the deadline; after it, it stays confirmed', async () => {
    const { dep } = await setup({ minPassengers: 2 });
    const [a, b, c] = [await registerStudent(t), await registerStudent(t), await registerStudent(t)];
    const ta = await buy(a, dep.id);
    await buy(b, dep.id);
    expect((await ok(call(a, 'GET', `/caravans/departures/${dep.id}`))).confirmed).toBe(true);
    await ok(call(a, 'POST', `/tickets/${ta.id}/cancel`));
    expect(await ok(call(b, 'GET', `/caravans/departures/${dep.id}`))).toMatchObject({ confirmed: false, status: 'published' });
    const tc = await buy(c, dep.id);
    expect((await ok(call(b, 'GET', `/caravans/departures/${dep.id}`))).confirmed).toBe(true);
    // Past the deadline (24 h before): one cancellation doesn't undo the trip.
    t.clock.advance(2 * DAY + HOUR);
    await ok(call(c, 'POST', `/tickets/${tc.id}/cancel`));
    expect((await ok(call(b, 'GET', `/caravans/departures/${dep.id}`))).confirmed).toBe(true);
  });


  it('cancelling: nothing refunded by the app (paid to the organizer in cash); refused once the bus has left; the seat is sold again', async () => {
    const { dep } = await setup();
    const early = await registerStudent(t);
    const t1 = await buy(early, dep.id);
    expect(t1.cancellationQuote).toMatchObject({ allowed: true, fee: 0, refund: 0 });
    expect(await ok(call(early, 'POST', `/tickets/${t1.id}/cancel`))).toEqual({ refundAmount: 0, fee: 0 });
    expect(await t.c.mongo.db.collection('payouts').countDocuments({ idempotencyKey: `ticket:${t1.id}:cancel` })).toBe(0);
    expect((await ok(call(early, 'GET', `/tickets/${t1.id}`))).status).toBe('cancelled');
    expect((await buy(early, dep.id)).seat).toBe(2); // can book again after cancelling
    t.clock.advance(3 * DAY + HOUR);
    const t3 = (await ok(call(early, 'GET', '/tickets'))).items.find((x: { status: string }) => x.status === 'active');
    expect(json(await call(early, 'POST', `/tickets/${t3.id}/cancel`)).code).toBe('CANCELLATION_REFUSED');
  });
});

describe('transfer to a friend', () => {
  it('the friend must be a student, accepts, and gets a new QR; the old one is refused', async () => {
    const { dep, orgId, scanner } = await setup();
    const [from, friend] = [await registerStudent(t), await registerStudent(t)];
    const ticket = await buy(from, dep.id);
    expect(json(await call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: nextPhone() })).code).toBe('RECIPIENT_NOT_FOUND');
    expect(json(await call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: from.phone })).code).toBe('SELF_TRANSFER');

    const offer = await ok(call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: friend.phone }), 201);
    expect(offer).toMatchObject({ status: 'pending', to: { name: 'Awa D.' } });
    const incoming = (await ok(call(friend, 'GET', '/ticket-transfers?direction=incoming'))).items;
    expect(incoming[0]).toMatchObject({ id: offer.id, seat: 2, event: { title: 'UGB → Dakar' } });
    expect(await ok(call(friend, 'POST', `/ticket-transfers/${offer.id}/accept`))).toEqual({ status: 'accepted', ticketId: ticket.id });

    const mine = await ok(call(friend, 'GET', `/tickets/${ticket.id}`));
    expect(mine).toMatchObject({ status: 'active', seat: 2 });
    expect(mine.qr).not.toBe(ticket.qr);
    expect(await ok(call(from, 'GET', `/tickets/${ticket.id}`))).toMatchObject({ status: 'transferred', qr: null, transfer: { status: 'accepted' } });
    // The given ticket still counts in the 2 purchases allowed: one more seat, then no more.
    await buy(from, dep.id);
    expect(json(await call(from, 'POST', `/caravans/departures/${dep.id}/bookings`, { seats: [{ passenger: { name: 'Ami Trois', phone: nextPhone() } }], pickupStopId: 'p1', dropoffStopId: 'd1', method: 'wave' })).code).toBe('SEAT_LIMIT');

    t.clock.set(T0 + 3 * DAY - HOUR);
    const stale = await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: ticket.qr, clientScanId: 'scan-stale-0001' }));
    expect(stale).toMatchObject({ result: 'rejected', reason: 'stale_version' });
    expect(await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: mine.qr, clientScanId: 'scan-new-0001' }))).toMatchObject({ result: 'admitted' });
  });

  it('declined, withdrawn, or too late', async () => {
    const { dep } = await setup();
    const [from, friend] = [await registerStudent(t), await registerStudent(t)];
    const ticket = await buy(from, dep.id);
    const o1 = await ok(call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: friend.phone }), 201);
    expect(json(await call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: friend.phone })).code).toBe('TRANSFER_PENDING');
    await ok(call(friend, 'POST', `/ticket-transfers/${o1.id}/decline`));
    const o2 = await ok(call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: friend.phone }), 201);
    expect((await call(from, 'POST', `/ticket-transfers/${o2.id}/cancel`)).statusCode).toBe(204);
    expect(json(await call(friend, 'POST', `/ticket-transfers/${o2.id}/accept`)).code).toBe('TRANSFER_EXPIRED');
    t.clock.set(T0 + 3 * DAY - HOUR);
    expect(json(await call(from, 'POST', `/tickets/${ticket.id}/transfers`, { recipientPhone: friend.phone })).code).toBe('TRANSFER_CLOSED');
  });
});

describe('boarding', () => {
  it('scan, duplicate, typed code, manual, unboard; other organizers and early scans refused', async () => {
    const { dep, orgId, owner, scanner } = await setup();
    const [a, b, c] = [await registerStudent(t), await registerStudent(t), await registerStudent(t)];
    const ta = await buy(a, dep.id);
    const tb = await buy(b, dep.id, { pickupStopId: 'p2' });
    const tc = await buy(c, dep.id);

    expect(await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: ta.qr, clientScanId: 'early-scan-01' }))).toMatchObject({ result: 'rejected', reason: 'too_early' });
    t.clock.set(T0 + 3 * DAY - 30 * MIN);

    const first = await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: ta.qr, clientScanId: 'scan-a-000001' }));
    expect(first).toMatchObject({ result: 'admitted', tone: 'success', title: 'Awa Diop · place 2', ticket: { id: ta.id } });
    expect(first.text).toContain('Descend à Dakar · Colobane');
    expect(await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: ta.qr, clientScanId: 'scan-a-000001' }))).toMatchObject({ result: 'admitted', text: 'Scan déjà enregistré.' });
    expect(await ok(call(owner, 'POST', `/org/${orgId}/admissions`, { qr: ta.qr, clientScanId: 'scan-a-000002' }))).toMatchObject({ result: 'duplicate', title: 'Déjà à bord' });

    // b booked Saint-Louis but gets on at the first stop: boarded, with a warning.
    const typed = await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { code: tb.code.toLowerCase(), clientScanId: 'scan-b-000001' }));
    expect(typed).toMatchObject({ result: 'admitted', tone: 'warning' });
    expect(typed.text).toContain('au lieu de Saint-Louis · Gare routière');
    expect(await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { ticketId: tc.id, eventId: dep.id }))).toMatchObject({ result: 'admitted' });
    expect((await call(scanner, 'POST', `/org/${orgId}/tickets/${tc.id}/admission/void`, { reason: 'erreur' })).statusCode).toBe(204);

    const manifest = await ok(call(scanner, 'GET', `/org/${orgId}/departures/${dep.id}/manifest`));
    expect(manifest.departure.counts).toEqual({ booked: 3, buyers: 3, admitted: 2 });
    expect(manifest.passengers.find((p: { ticketId: string }) => p.ticketId === tc.id)).toMatchObject({ admitted: false, name: 'Awa Diop', phone: expect.stringMatching(/^\+221 7/) });

    const rival = await setup();
    t.clock.set(T0 + 3 * DAY - 30 * MIN);
    expect(await ok(call(rival.scanner, 'POST', `/org/${rival.orgId}/admissions`, { qr: tb.qr, clientScanId: 'rival-scan-01' }))).toMatchObject({ result: 'rejected', reason: 'wrong_org' });
    expect((await call(rival.scanner, 'GET', `/org/${rival.orgId}/departures/${dep.id}/manifest`)).statusCode).toBe(404);
    expect((await call(scanner, 'GET', `/org/${rival.orgId}/departures`)).statusCode).toBe(404);
    expect(await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: 'not.a.ticket', clientScanId: 'junk-scan-01' }))).toMatchObject({ result: 'rejected', reason: 'bad_signature' });
  });

  it('leaving the first stop starts the trip; who wasn’t scanned there is absent; nothing to claim (paid in cash)', async () => {
    const { dep, orgId, owner, scanner } = await setup({ minPassengers: 1 });
    const [a, b] = [await registerStudent(t), await registerStudent(t)];
    const ta = await buy(a, dep.id);
    const tb = await buy(b, dep.id);
    t.clock.set(T0 + 3 * DAY);
    await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: ta.qr, clientScanId: 'leave-scan-1' }));
    const left = await ok(call(scanner, 'POST', `/org/${orgId}/departures/${dep.id}/stops/p1/leave`));
    expect(left.absent).toEqual([{ ticketId: tb.id, seat: tb.seat }]);
    expect((await ok(call(owner, 'GET', `/org/${orgId}/departures/${dep.id}`))).status).toBe('departed');

    // The seats were paid to the organizer in cash: the app has nothing to pay out.
    expect(json(await call(owner, 'POST', `/org/${orgId}/departures/${dep.id}/claim`, { method: 'wave' })).code).toBe('NOTHING_TO_CLAIM');
  });
});

describe('cash', () => {
  it('a validated seat is already paid: nothing to collect at boarding; nothing refunded nor paid out by the app', async () => {
    const { dep, orgId, scanner } = await setup({ minPassengers: 1 });
    const a = await registerStudent(t);
    const ta = await buy(a, dep.id);
    expect(ta).toMatchObject({ paidWith: 'cash', cashDue: 0, status: 'active' });
    t.clock.set(T0 + 3 * DAY - 30 * MIN);
    const scan = await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: ta.qr, clientScanId: 'cash-scan-01' }));
    expect(scan).toMatchObject({ result: 'admitted', cashDue: 0 });
    expect(scan.text).not.toContain('À encaisser');
  });
});

describe('cancelled departures', () => {
  it('minimum not reached at the deadline: cancelled (paid in cash: the organizer refunds, not the app)', async () => {
    const { dep } = await setup({ minPassengers: 3 });
    const s = await registerStudent(t);
    const ticket = await buy(s, dep.id);
    t.clock.set(T0 + 2 * DAY + MIN);
    await t.c.modules.caravans.service.sweep();
    expect(await ok(call(s, 'GET', `/tickets/${ticket.id}`))).toMatchObject({ status: 'cancelled', cancellation: { reason: 'min_not_reached', refundAmount: 0, fee: 0 } });
  });

  it('the organizer cancels: tickets cancelled, waiting requests released, nothing left to sell', async () => {
    const { dep, orgId, owner } = await setup();
    const [a, b] = [await registerStudent(t), await registerStudent(t)];
    const ta = await buy(a, dep.id);
    const waiting = (await ok(call(b, 'POST', `/caravans/departures/${dep.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd1' }), 201)).booking;
    expect(await ok(call(owner, 'POST', `/org/${orgId}/departures/${dep.id}/cancel`, { reason: 'Panne du bus' }))).toEqual({ refunded: 0 });
    expect((await ok(call(a, 'GET', `/tickets/${ta.id}`))).cancellation).toMatchObject({ reason: 'event_cancelled', refundAmount: 0 });
    expect(await ok(call(b, 'GET', `/caravans/bookings/${waiting.id}`))).toMatchObject({ status: 'cancelled' });
    expect((await ok(call(a, 'GET', '/caravans/departures'))).items.some((d: { id: string }) => d.id === dep.id)).toBe(false);
  });
});

describe('offline scanning', () => {
  it('the pack verifies QR codes without the server; scans synced later count once', async () => {
    const { dep, orgId, scanner, owner } = await setup();
    const [a, b] = [await registerStudent(t), await registerStudent(t)];
    const ta = await buy(a, dep.id);
    const tb = await buy(b, dep.id);
    const pack = await ok(call(scanner, 'GET', `/org/${orgId}/departures/${dep.id}/offline-pack`));
    expect(pack.versions).toMatchObject({ [ta.id]: 1, [tb.id]: 1 });
    expect(pack.codes[tb.code]).toBe(tb.id);
    expect(pack.manifest.passengers).toHaveLength(2);

    // What the phone does offline: check the Ed25519 signature with the pack's public key only.
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pack.key.x }, format: 'jwk' });
    const [h, p, sig] = ta.qr.split('.');
    expect(verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({ sub: ta.id, e: dep.id, v: 1, aud: 'ticket' });

    // Two phones boarded `a` offline; synced later: the first one wins, the second is a duplicate.
    t.clock.set(T0 + 3 * DAY - 20 * MIN);
    const synced = await ok(
      call(scanner, 'POST', `/org/${orgId}/admissions/batch`, {
        items: [
          { qr: ta.qr, eventId: dep.id, clientScanId: 'offline-a-1', scannedAt: at(3 * DAY - 40 * MIN) },
          { code: tb.code, eventId: dep.id, clientScanId: 'offline-b-1', scannedAt: at(3 * DAY - 35 * MIN) },
        ],
      }),
    );
    expect(synced.items.map((r: { result: string }) => r.result)).toEqual(['admitted', 'admitted']);
    const other = await ok(call(owner, 'POST', `/org/${orgId}/admissions/batch`, { items: [{ qr: ta.qr, eventId: dep.id, clientScanId: 'offline-a-2' }] }));
    expect(other.items[0]).toMatchObject({ result: 'duplicate' });
    // Re-sent by a phone that didn't get the answer: same result, nothing recorded twice.
    const again = await ok(call(scanner, 'POST', `/org/${orgId}/admissions/batch`, { items: [{ qr: ta.qr, eventId: dep.id, clientScanId: 'offline-a-1' }] }));
    expect(again.items[0]).toMatchObject({ result: 'admitted', text: 'Scan déjà enregistré.' });
    expect((await ok(call(scanner, 'GET', `/org/${orgId}/departures/${dep.id}`))).counts).toEqual({ booked: 2, buyers: 2, admitted: 2 });
  });
});

describe('a seat for a companion', () => {
  const companion = (name: string, phone: string, seat?: number) => ({ ...(seat ? { seat } : {}), passenger: { name, phone } });
  const bookSeats = (s: Who, depId: string, seats: object[]) => call(s, 'POST', `/caravans/departures/${depId}/bookings`, { seats, pickupStopId: 'p1', dropoffStopId: 'd2', method: 'wave' });

  it('two seats, each with its own code: the companion’s paid and validated alone, mine keeps waiting', async () => {
    const { dep, owner, orgId } = await setup({ minPassengers: 2 });
    const s = await registerStudent(t);
    const { booking } = await ok(bookSeats(s, dep.id, [{ seat: 7 }, companion('Awa Ndiaye', nextPhone(), 8)]), 201);
    const mine = (await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).myBooking;
    const [me, awa] = mine.seats;
    expect(me.code).toMatch(/^[0-9A-Z]{6}$/);
    expect(me.code).not.toBe(awa.code);
    expect(awa.code).not.toBe(mine.code);
    // Awa's seat scanned: the request is found, her seat picked.
    const found = (await ok(call(owner, 'GET', `/org/${orgId}/departures/requests/by-code/UGBREQ:${awa.code}`))).request;
    expect(found).toMatchObject({ matched: awa.id, total: 7000, seats: [expect.objectContaining({ id: me.id, seat: 7 }), expect.objectContaining({ id: awa.id, seat: 8 })] });
    const order = await orderOf(booking.id);
    const left = await ok(call(owner, 'POST', `/org/${orgId}/departures/requests/${order}/validate`, { bookingIds: [awa.id] }));
    expect(left).toMatchObject({ total: 3500, seats: [expect.objectContaining({ id: me.id })] });
    const tickets = (await ok(call(s, 'GET', '/tickets'))).items.filter((x: { kind: string; status: string }) => x.kind === 'caravan_seat' && x.status === 'active');
    expect(tickets.map((x: { seat: number }) => x.seat)).toEqual([8]);
    expect((await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).myBooking).toMatchObject({ total: 3500, seats: [{ seat: 7 }] });
    expect(json(await call(owner, 'POST', `/org/${orgId}/departures/requests/${order}/validate`, { bookingIds: [awa.id] })).code).toBe('SEAT_NOT_WAITING');
    // Mine paid later: validated with the request's code, the request is done.
    await ok(call(owner, 'POST', `/org/${orgId}/departures/requests/${order}/validate`));
    expect((await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).myBooking).toBeNull();
  });

  it('two seats, one request: the companion’s ticket carries their name and stays in the buyer’s app', async () => {
    const { dep } = await setup({ minPassengers: 2 });
    const s = await registerStudent(t);
    const awaPhone = nextPhone();
    const { booking, payment } = await ok(bookSeats(s, dep.id, [{ seat: 7 }, companion('  Awa   Ndiaye ', awaPhone, 8)]), 201);
    expect(payment).toBeNull();
    expect(booking.seats).toEqual([
      { seat: 7, passenger: null, status: 'held', ticketId: null },
      { seat: 8, passenger: { name: 'Awa Ndiaye', phone: expect.stringMatching(/^\+221 /) }, status: 'held', ticketId: null },
    ]);
    const held = await ok(call(s, 'GET', `/caravans/departures/${dep.id}`));
    expect(held).toMatchObject({ seatsFree: 10, mySeatsLeft: 0, maxSeatsPerStudent: 2, myBooking: { seats: [{ seat: 7 }, { seat: 8, passenger: { name: 'Awa Ndiaye' } }] } });

    await validate(dep.id, booking.id);
    const done = await ok(call(s, 'GET', `/caravans/bookings/${booking.id}`));
    expect(done.seats.map((x: { status: string }) => x.status)).toEqual(['confirmed', 'confirmed']);
    // Two paid seats: the minimum of 2 is reached.
    expect(await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).toMatchObject({ seatsBooked: 2, confirmed: true, myTicketId: done.seats[0].ticketId });
    const tickets = (await ok(call(s, 'GET', '/tickets'))).items.sort((a: { seat: number }, b: { seat: number }) => a.seat - b.seat);
    expect(tickets).toHaveLength(2);
    expect(tickets[0]).toMatchObject({ seat: 7, passenger: null, purchaser: { isMe: true } });
    expect(tickets[1]).toMatchObject({ seat: 8, status: 'active', passenger: { name: 'Awa Ndiaye' }, purchaser: { isMe: true } });
    expect(tickets[1].qr).toBeTruthy();
    expect(tickets[1].code).not.toBe(tickets[0].code);

    // A third seat: over the limit.
    expect(json(await bookSeats(s, dep.id, [companion('Ami Trois', nextPhone())])).code).toBe('SEAT_LIMIT');
    // Cancelling the companion's ticket frees a slot (paid to the organizer in cash: nothing refunded by the app).
    expect(await ok(call(s, 'POST', `/tickets/${tickets[1].id}/cancel`))).toEqual({ refundAmount: 0, fee: 0 });
    expect((await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).mySeatsLeft).toBe(1);
  });

  it('a companion may board and get off at other stops than the buyer', async () => {
    const { dep } = await setup();
    const s = await registerStudent(t);
    expect(json(await bookSeats(s, dep.id, [{}, { ...companion('Awa Ndiaye', nextPhone()), pickupStopId: 'p9' }])).field).toBe('pickupStopId');
    const { booking } = await ok(bookSeats(s, dep.id, [{}, { ...companion('Awa Ndiaye', nextPhone()), pickupStopId: 'p2', dropoffStopId: 'd1' }]), 201);
    await validate(dep.id, booking.id);
    const done = await ok(call(s, 'GET', `/caravans/bookings/${booking.id}`));
    const [mine, hers] = await Promise.all(done.seats.map((x: { ticketId: string }) => ok(call(s, 'GET', `/tickets/${x.ticketId}`))));
    expect(mine.details).toMatchObject({ pickup: { place: 'UGB · Village E' }, dropoff: { place: 'Dakar · Colobane' } });
    expect(hers.details).toMatchObject({ pickup: { place: 'Saint-Louis · Gare routière' }, dropoff: { place: 'Thiès · Mairie' } });
  });

  it('refuses two seats for yourself, your own number, a number already travelling, and a third seat', async () => {
    const { dep } = await setup();
    const [s, other] = [await registerStudent(t), await registerStudent(t)];
    expect((await bookSeats(s, dep.id, [{}, {}])).statusCode).toBe(400);
    expect(json(await bookSeats(s, dep.id, [{}, companion('Moi Même', s.phone)])).fields?.[0]?.path ?? 'passenger.phone').toBe('passenger.phone');
    expect((await bookSeats(s, dep.id, [{}, companion('Moi Même', s.phone)])).statusCode).toBe(400);
    const p = nextPhone();
    expect((await bookSeats(s, dep.id, [companion('Awa', p), companion('Awa bis', p)])).statusCode).toBe(400);
    expect((await bookSeats(s, dep.id, [{}, companion('A', p)])).statusCode).toBe(400);
    expect(json(await bookSeats(s, dep.id, [{}, companion('Un', nextPhone()), companion('Deux', nextPhone())])).code).toBe('SEAT_LIMIT');

    await buy(other, dep.id);
    // Already has their own ticket, or is someone's companion already.
    expect(json(await bookSeats(s, dep.id, [{}, companion('Awa Diop', other.phone)])).code).toBe('PASSENGER_HAS_SEAT');
    const fatou = (await ok(bookSeats(other, dep.id, [companion('Fatou Sow', p)]), 201)).booking;
    await validate(dep.id, fatou.id);
    expect(json(await bookSeats(s, dep.id, [{}, companion('Fatou Sow', p)])).code).toBe('PASSENGER_HAS_SEAT');
  });

  it('a departure limited to 1 seat per student; releasing an order frees all its seats', async () => {
    const { dep, orgId, owner } = await setup();
    const s = await registerStudent(t);
    const { booking } = await ok(bookSeats(s, dep.id, [{}, companion('Awa Ndiaye', nextPhone())]), 201);
    expect((await ok(call(s, 'GET', `/caravans/departures/${dep.id}/seats`))).taken).toEqual([2, 3]);
    expect((await call(s, 'DELETE', `/caravans/bookings/${booking.id}`)).statusCode).toBe(204);
    expect(await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).toMatchObject({ seatsFree: 12, mySeatsLeft: 2, myBooking: null });

    // Not validated within 24 h: the whole request goes back.
    const late = await ok(bookSeats(s, dep.id, [{ seat: 2 }, companion('Awa Ndiaye', nextPhone(), 3)]), 201);
    t.clock.advance(DAY + MIN);
    await t.c.modules.caravans.service.sweep();
    expect((await ok(call(s, 'GET', `/caravans/bookings/${late.booking.id}`))).seats.map((x: { status: string }) => x.status)).toEqual(['expired', 'expired']);
    expect((await ok(call(s, 'GET', `/caravans/departures/${dep.id}`))).seatsFree).toBe(12);

    const vehicle = (await ok(call(owner, 'GET', `/org/${orgId}/vehicles`))).items[0];
    const strict = await ok(
      call(owner, 'POST', `/org/${orgId}/departures`, {
        vehicleId: vehicle.id, direction: 'aller', from: 'UGB', to: 'Dakar', price: 3500, minPassengers: 0, maxSeatsPerStudent: 1,
        pickups: [{ place: 'UGB · Village E', at: at(5 * DAY) }], dropoffs: [{ place: 'Thiès · Mairie', at: at(5 * DAY + 4 * HOUR) }, { place: 'Dakar · Colobane', at: at(5 * DAY + 5 * HOUR) }],
      }),
      201,
    );
    await ok(call(owner, 'POST', `/org/${orgId}/departures/${strict.id}/publish`));
    expect(json(await bookSeats(s, strict.id, [{}, companion('Awa Ndiaye', nextPhone())])).code).toBe('SEAT_LIMIT');
    expect(json(await bookSeats(s, strict.id, [{}, companion('Awa Ndiaye', nextPhone())])).message).toBe('Une seule place par étudiant sur ce départ.');
  });

  it('two purchases at the same moment can’t go over the limit', async () => {
    const { dep } = await setup();
    const s = await registerStudent(t);
    await buy(s, dep.id);
    const race = await Promise.all([1, 2].map((i) => bookSeats(s, dep.id, [companion(`Ami ${i}`, nextPhone())])));
    expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(json(race.find((r) => r.statusCode === 409)!).code).toBe('SEAT_LIMIT');
  });

  it('a companion with an account is offered the ticket; accepting makes it theirs, the group stays visible', async () => {
    const { dep, orgId, scanner } = await setup();
    const [moussa, awa] = [await registerStudent(t), await registerStudent(t)];
    const { booking } = await ok(bookSeats(moussa, dep.id, [{ seat: 7 }, companion('Awa Ndiaye', awa.phone, 8)]), 201);
    await validate(dep.id, booking.id);
    await new Promise((r) => setTimeout(r, 100)); // after-commit offer
    const incoming = (await ok(call(awa, 'GET', '/ticket-transfers?direction=incoming'))).items;
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ seat: 8, from: { name: 'Awa D.' } });
    expect((await ok(call(awa, 'GET', '/notifications'))).items[0]).toMatchObject({ type: 'ticket.transfer_offered', title: 'Awa D. t’a réservé une place' });

    const done = await ok(call(moussa, 'GET', `/caravans/bookings/${booking.id}`));
    const companionTicket = done.seats[1].ticketId;
    expect(await ok(call(awa, 'POST', `/ticket-transfers/${incoming[0].id}/accept`))).toMatchObject({ status: 'accepted', ticketId: companionTicket });
    expect(await ok(call(awa, 'GET', `/tickets/${companionTicket}`))).toMatchObject({ status: 'active', passenger: null, purchaser: { isMe: false } });
    expect(await ok(call(awa, 'GET', `/caravans/departures/${dep.id}`))).toMatchObject({ myTicketId: companionTicket });

    // On the list: still Moussa's group of 2, Awa now under her own account.
    const manifest = await ok(call(scanner, 'GET', `/org/${orgId}/departures/${dep.id}/manifest`));
    expect(manifest.departure.counts).toEqual({ booked: 2, buyers: 1, admitted: 0 });
    const seat8 = manifest.passengers.find((p: { seat: number }) => p.seat === 8);
    expect(seat8).toMatchObject({ companionOf: null, transferred: true, purchaser: { id: moussa.userId }, groupSize: 2 });
  });

  it('on the list and at the scanner: the companion’s name, who booked, and the group to board together', async () => {
    const { dep, orgId, scanner } = await setup({ departIn: 2 * HOUR });
    const moussa = await registerStudent(t);
    const phone = nextPhone();
    const moussaBooking = (await ok(bookSeats(moussa, dep.id, [{ seat: 7 }, companion('Awa Ndiaye', phone, 8)]), 201)).booking;
    await validate(dep.id, moussaBooking.id);
    const manifest = await ok(call(scanner, 'GET', `/org/${orgId}/departures/${dep.id}/manifest`));
    expect(manifest.passengers).toEqual([
      expect.objectContaining({ seat: 7, name: 'Awa Diop', companionOf: null, groupSize: 2, purchaser: { id: moussa.userId, name: 'Awa Diop' } }),
      expect.objectContaining({ seat: 8, name: 'Awa Ndiaye', phone: expect.stringMatching(/^\+221 /), companionOf: 'Awa Diop', transferred: false, groupSize: 2 }),
    ]);
    const tickets = (await ok(call(moussa, 'GET', '/tickets'))).items;
    const t8 = tickets.find((x: { seat: number }) => x.seat === 8);
    const t7 = tickets.find((x: { seat: number }) => x.seat === 7);
    const scan = await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: t8.qr, eventId: dep.id, locationId: 'p1' }));
    expect(scan).toMatchObject({
      result: 'admitted', title: 'Awa Ndiaye · place 8', holder: { name: 'Awa Ndiaye' }, companionOf: 'Awa Diop',
      group: { size: 2, purchaser: 'Awa Diop', others: [{ ticketId: t7.id, seat: 7, name: 'Awa Diop', admitted: false }] },
    });
    expect(scan.text).toContain('Accompagnant de Awa Diop.');
    expect(scan.text).toContain('pièce d’identité');
    // "Faire monter les 2": the other ticket by id.
    expect(await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { ticketId: scan.group.others[0].ticketId, eventId: dep.id }))).toMatchObject({
      result: 'admitted', group: { others: [{ seat: 8, admitted: true }] },
    });
    const pack = await ok(call(scanner, 'GET', `/org/${orgId}/departures/${dep.id}/offline-pack`));
    expect(pack.manifest.passengers.every((p: { admitted: boolean }) => p.admitted)).toBe(true);
  });
});

describe('creating a departure from the app', () => {
  it('the form gets the limits, a draft comes back with what it needs to be edited, then is locked once published', async () => {
    const { owner, scanner, orgId } = await setup();
    const { items, limits } = await ok(call(owner, 'GET', `/org/${orgId}/vehicles`));
    expect(limits).toEqual({ maxSeatsPerStudent: 10, defaultSeatsPerStudent: 2 });
    const body = {
      vehicleId: items[0].id, direction: 'retour', from: 'Dakar', to: 'UGB', price: 4000, minPassengers: 0, paymentMethods: ['wave', 'cash'],
      pickups: [{ place: 'Dakar · Colobane', at: at(4 * DAY) }], dropoffs: [{ place: 'UGB · Village E', at: at(4 * DAY + 5 * HOUR) }],
    };
    // A scanner checks tickets; creating is for the owner and managers (refused like any route outside one's role).
    expect((await call(scanner, 'POST', `/org/${orgId}/departures`, body)).statusCode).toBe(404);
    const draft = await ok(call(owner, 'POST', `/org/${orgId}/departures`, body), 201);
    // Seats are paid to the organizer in cash, whatever the form sends.
    expect(draft).toMatchObject({ status: 'draft', vehicleId: items[0].id, bookingClosesAt: at(4 * DAY), paymentMethods: ['cash'] });
    const edited = await ok(call(owner, 'PUT', `/org/${orgId}/departures/${draft.id}`, { ...body, price: 4500 }));
    expect(edited.price).toBe(4500);
    expect((await ok(call(owner, 'POST', `/org/${orgId}/departures/${draft.id}/publish`))).status).toBe('confirmed');
    expect(json(await call(owner, 'PUT', `/org/${orgId}/departures/${draft.id}`, body)).code).toBe('DEPARTURE_PUBLISHED');
  });
});

describe('vehicles', () => {
  it('no plate needed (several vehicles without one), air conditioning shown to students, a plate given twice is refused', async () => {
    const { owner, orgId } = await setup();
    const a = await ok(call(owner, 'POST', `/org/${orgId}/vehicles`, { label: 'Car climatisé', capacity: 60, airConditioned: true }), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/vehicles`, { label: 'Car ordinaire', capacity: 60 }), 201);
    expect(a).toMatchObject({ plate: null, airConditioned: true });
    const taken = await ok(call(owner, 'POST', `/org/${orgId}/vehicles`, { label: 'Car A', plate: 'TH 9999 ZZ', capacity: 40 }), 201);
    expect(taken.plate).toBe('TH-9999-ZZ');
    expect(json(await call(owner, 'POST', `/org/${orgId}/vehicles`, { label: 'Car B', plate: 'TH-9999-ZZ', capacity: 40 })).code).toBe('PLATE_TAKEN');

    const draft = await ok(
      call(owner, 'POST', `/org/${orgId}/departures`, {
        vehicleId: a.id, direction: 'aller', from: 'UGB', to: 'Dakar', price: 3500, minPassengers: 0,
        pickups: [{ place: 'UGB · Village E', at: at(5 * DAY) }], dropoffs: [{ place: 'Dakar · Colobane', at: at(5 * DAY + 5 * HOUR) }],
      }),
      201,
    );
    await ok(call(owner, 'POST', `/org/${orgId}/departures/${draft.id}/publish`));
    const s = await registerStudent(t);
    expect((await ok(call(s, 'GET', `/caravans/departures/${draft.id}`))).vehicle).toEqual({ label: 'Car climatisé', airConditioned: true, plate: null });
  });
});

describe('the vehicle catalog', () => {
  it('buses and Cheikhou Cherif minibuses with their plans; picking one gives the organization its vehicle, once; the plan reaches students', async () => {
    const { owner, scanner, orgId } = await setup();
    const { models } = await ok(call(owner, 'GET', `/org/${orgId}/vehicles`));
    expect(models.map((m: { label: string; capacity: number }) => [m.label, m.capacity])).toEqual([
      ['Cheikhou Cherif 14 places', 13], ['Cheikhou Cherif 15 places', 14], ['Bus 45 places', 45], ['Bus 49 places', 49], ['Bus 53 places', 53], ['Bus 57 places', 57],
    ]);
    const bus53 = models.find((m: { key: string }) => m.key === 'bus-53');
    // Every seat once, numbered 1..53; the door on the right after the 7th row; the back bench of 5.
    const seats = bus53.layout.flat().filter((c: unknown) => typeof c === 'number').sort((a: number, b: number) => a - b);
    expect(seats).toEqual(Array.from({ length: 53 }, (_, i) => i + 1));
    expect(bus53.layout[7]).toEqual([28, 27, null, 'door', 'door']);
    expect(bus53.layout[bus53.layout.length - 1]).toEqual([53, 52, 51, 50, 49]);
    expect(models[0].layout[1]).toEqual([4, 3, 2, 'door']);

    // A manager (here: refused to a scanner) picks it; the second time, the same vehicle.
    expect((await call(scanner, 'POST', `/org/${orgId}/vehicles/models/bus-53`)).statusCode).toBe(404);
    const v = await ok(call(owner, 'POST', `/org/${orgId}/vehicles/models/bus-53`));
    expect(v).toMatchObject({ label: 'Bus 53 places', capacity: 53, model: 'bus-53', plate: null });
    expect((await ok(call(owner, 'POST', `/org/${orgId}/vehicles/models/bus-53`))).id).toBe(v.id);
    expect((await call(owner, 'POST', `/org/${orgId}/vehicles/models/bus-99`)).statusCode).toBe(404);
    // Renamed and air-conditioned: its plan (and seats) stay.
    const edited = await ok(call(owner, 'PUT', `/org/${orgId}/vehicles/${v.id}`, { label: 'Bus Khoulé 53', capacity: 20, airConditioned: true }));
    expect(edited).toMatchObject({ label: 'Bus Khoulé 53', capacity: 53, airConditioned: true, model: 'bus-53' });

    const draft = await ok(
      call(owner, 'POST', `/org/${orgId}/departures`, {
        vehicleId: v.id, direction: 'aller', from: 'UGB', to: 'Dakar', price: 3500, minPassengers: 0,
        pickups: [{ place: 'UGB · Village E', at: at(5 * DAY) }], dropoffs: [{ place: 'Dakar · Colobane', at: at(5 * DAY + 5 * HOUR) }],
      }),
      201,
    );
    await ok(call(owner, 'POST', `/org/${orgId}/departures/${draft.id}/publish`));
    const s = await registerStudent(t);
    const map = await ok(call(s, 'GET', `/caravans/departures/${draft.id}/seats`));
    expect(map).toMatchObject({ capacity: 53, rows: bus53.layout });
    // « Choisis pour moi »: the front-most window seat (1, on the right of the driver).
    expect(map.suggested).toBe(1);
  });
});

describe('editing and deleting a vehicle', () => {
  it('a draft takes the change, a published trip keeps its vehicle; deleting waits until no trip is planned with it', async () => {
    const { owner, scanner, orgId, dep } = await setup();
    const vehicleId = (await ok(call(owner, 'GET', `/org/${orgId}/vehicles`))).items[0].id;
    const draft = await ok(
      call(owner, 'POST', `/org/${orgId}/departures`, {
        vehicleId, direction: 'aller', from: 'UGB', to: 'Dakar', price: 3500, minPassengers: 0,
        pickups: [{ place: 'UGB · Village E', at: at(5 * DAY) }], dropoffs: [{ place: 'Dakar · Colobane', at: at(5 * DAY + 5 * HOUR) }],
      }),
      201,
    );
    const body = { label: 'Minibus climatisé', capacity: 14, airConditioned: true };
    expect((await call(scanner, 'PUT', `/org/${orgId}/vehicles/${vehicleId}`, body)).statusCode).toBe(404);
    expect(await ok(call(owner, 'PUT', `/org/${orgId}/vehicles/${vehicleId}`, body))).toMatchObject(body);
    expect((await ok(call(owner, 'GET', `/org/${orgId}/departures/${draft.id}`))).vehicle).toMatchObject({ label: 'Minibus climatisé', airConditioned: true });
    expect(await ok(call(owner, 'GET', `/org/${orgId}/departures/${dep.id}`))).toMatchObject({ vehicle: { label: 'Minibus 12 places', airConditioned: false }, totalSeats: 12 });

    expect(json(await call(owner, 'DELETE', `/org/${orgId}/vehicles/${vehicleId}`)).message).toBe('Ce véhicule a 2 départs prévus (brouillons compris). Annule-les ou change de véhicule d’abord.');
    for (const id of [draft.id, dep.id]) await ok(call(owner, 'POST', `/org/${orgId}/departures/${id}/cancel`, { reason: 'Panne' }));
    expect((await call(owner, 'DELETE', `/org/${orgId}/vehicles/${vehicleId}`)).statusCode).toBe(204);
    expect((await ok(call(owner, 'GET', `/org/${orgId}/vehicles`))).items).toEqual([]);
  });
});

describe('rows of 5 (with the folding middle seat)', () => {
  it('the layout is kept and editable; « choisis pour moi » takes the middle seat last', async () => {
    const { owner, orgId } = await setup();
    const v = await ok(call(owner, 'POST', `/org/${orgId}/vehicles`, { label: 'Car 5 de front', capacity: 10, seatsPerRow: 5 }), 201);
    expect(v.seatsPerRow).toBe(5);
    expect((await ok(call(owner, 'PUT', `/org/${orgId}/vehicles/${v.id}`, { label: 'Car 4 de front', capacity: 10, airConditioned: false, seatsPerRow: 4 }))).seatsPerRow).toBe(4);
    await ok(call(owner, 'PUT', `/org/${orgId}/vehicles/${v.id}`, { label: 'Car 5 de front', capacity: 10, airConditioned: false, seatsPerRow: 5 }));
    const d = await ok(
      call(owner, 'POST', `/org/${orgId}/departures`, {
        vehicleId: v.id, direction: 'aller', from: 'UGB', to: 'Dakar', price: 3500, minPassengers: 0,
        pickups: [{ place: 'UGB · Village E', at: at(5 * DAY) }], dropoffs: [{ place: 'Dakar · Colobane', at: at(5 * DAY + 5 * HOUR) }],
      }),
      201,
    );
    await ok(call(owner, 'POST', `/org/${orgId}/departures/${d.id}/publish`));
    const s = await registerStudent(t);
    const map = await ok(call(s, 'GET', `/caravans/departures/${d.id}/seats`));
    expect(map.seatsPerRow).toBe(5);
    // From the front: row 1 is seats 1-2 on the right, then 3-7 and 8-10. Windows 2, 3, 7, 8, then aisles 1, 4, 6, 9,
    // the middle (versailler) 5 and 10 last.
    expect(map.firstRowSeats).toBe(2);
    for (const seat of [2, 3, 7, 8, 1, 4, 6, 9]) {
      // A request already holds its seat.
      const { booking } = await ok(call(await registerStudent(t), 'POST', `/caravans/departures/${d.id}/bookings`, { pickupStopId: 'p1', dropoffStopId: 'd1' }), 201);
      expect(booking.seat).toBe(seat);
    }
    expect((await ok(call(s, 'GET', `/caravans/departures/${d.id}/seats`))).suggested).toBe(5);
  });
});

describe('editing a published departure', () => {
  it('adds stops and a bigger bus once seats are sold; never removes, moves or shrinks', async () => {
    const { owner, scanner, orgId, dep } = await setup();
    const s = await registerStudent(t);
    const ticket = await buy(s, dep.id);
    const start = 3 * DAY;
    const url = `/org/${orgId}/departures/${dep.id}`;
    expect((await call(scanner, 'PATCH', url, { pickups: [{ place: 'Louga · Gare', at: at(start + 2 * HOUR) }] })).statusCode).toBe(404);

    const extended = await ok(call(owner, 'PATCH', url, { pickups: [{ place: 'Louga · Gare', at: at(start + 2 * HOUR) }], dropoffs: [{ place: 'Rufisque · Gare', at: at(start + 5 * HOUR) }] }));
    expect(extended.pickups.map((p: { stopId: string; place: string }) => `${p.stopId} ${p.place}`)).toEqual(['p1 UGB · Village E', 'p2 Saint-Louis · Gare routière', 'p3 Louga · Gare']);
    expect(extended.dropoffs.map((p: { stopId: string }) => p.stopId)).toEqual(['d1', 'd3', 'd2']);
    expect(extended.departureAt).toBe(at(start));
    // The student's ticket keeps its stops.
    expect((await ok(call(s, 'GET', `/tickets/${ticket.id}`))).details).toMatchObject({ pickup: { stopId: 'p1' }, dropoff: { stopId: 'd2' } });

    expect(json(await call(owner, 'PATCH', url, { pickups: [{ place: 'Avant', at: at(start - HOUR) }] })).message).toBe('Une nouvelle montée doit être après le départ.');
    expect(json(await call(owner, 'PATCH', url, { pickups: [{ place: 'louga · gare', at: at(start + 3 * HOUR) }] })).message).toBe('« louga · gare » est déjà un arrêt de ce départ.');
    expect(json(await call(owner, 'PATCH', url, { pickups: [{ place: 'Après Thiès', at: at(start + 4.5 * HOUR) }] })).message).toBe('Les montées doivent précéder les arrêts.');

    const small = await ok(call(owner, 'POST', `/org/${orgId}/vehicles`, { label: 'Minibus 8', capacity: 8 }), 201);
    expect(json(await call(owner, 'PATCH', url, { vehicleId: small.id })).field).toBe('vehicleId');
    const big = await ok(call(owner, 'POST', `/org/${orgId}/vehicles`, { label: 'Bus 62', capacity: 62, seatsPerRow: 5 }), 201);
    expect(await ok(call(owner, 'PATCH', url, { vehicleId: big.id }))).toMatchObject({ totalSeats: 62, seatsFree: 61, vehicle: { label: 'Bus 62' } });
    expect((await ok(call(s, 'GET', `/caravans/departures/${dep.id}/seats`))).taken).toEqual([ticket.seat]);

    // Removing: the stops nobody booked go; the student's stops (p1, d2) and the departure stay.
    expect((await ok(call(owner, 'GET', url))).bookedStopIds.sort()).toEqual(['d2', 'p1']);
    expect(json(await call(owner, 'PATCH', url, { remove: ['d2'] })).code).toBe('STOP_BOOKED');
    expect(json(await call(owner, 'PATCH', url, { remove: ['p1'] })).field).toBe('remove');
    const trimmed = await ok(call(owner, 'PATCH', url, { remove: ['p3', 'd3', 'd1'] }));
    expect(trimmed.pickups.map((p: { stopId: string }) => p.stopId)).toEqual(['p1', 'p2']);
    expect(trimmed.dropoffs.map((p: { stopId: string }) => p.stopId)).toEqual(['d2']);
  });
});

describe('offline scanning', () => {
  it('the pack has nothing to collect (validated seats are paid); a stop left offline keeps the time it was left', async () => {
    const { owner, scanner, orgId, dep } = await setup();
    await buy(await registerStudent(t), dep.id);
    const pack = await ok(call(scanner, 'GET', `/org/${orgId}/departures/${dep.id}/offline-pack`));
    expect(pack.cash).toEqual({});

    t.clock.set(T0 + 3 * DAY + 10 * MIN);
    const leftAt = at(3 * DAY + 2 * MIN);
    await ok(call(owner, 'POST', `/org/${orgId}/departures/${dep.id}/stops/p1/leave`, { leftAt }));
    const d = await t.c.mongo.db.collection('departures').findOne({ code: dep.code });
    expect(d!.stopsLeft[0].at.toISOString()).toBe(leftAt);
    expect(d!.departedAt.toISOString()).toBe(leftAt);
  });

  it('a scan whose answer timed out, then queued offline with the same id, counts once: no false « déjà à bord »', async () => {
    const { scanner, orgId, dep } = await setup();
    const ticket = await buy(await registerStudent(t), dep.id);
    t.clock.set(T0 + 3 * DAY - 30 * MIN);
    // The request reached the server, but the phone never got the answer (weak network)…
    await ok(call(scanner, 'POST', `/org/${orgId}/admissions`, { qr: ticket.qr, clientScanId: 'weak-net-0001' }));
    // …so it boarded the passenger offline with the same id, and sends it when the network is back.
    const batch = await ok(call(scanner, 'POST', `/org/${orgId}/admissions/batch`, { items: [{ qr: ticket.qr, eventId: dep.id, clientScanId: 'weak-net-0001', scannedAt: at(3 * DAY - 30 * MIN) }] }));
    expect(batch.items.map((x: { result: string }) => x.result)).toEqual(['admitted']);
  });
});
