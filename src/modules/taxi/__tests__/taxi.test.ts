import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createTestApp, json, registerStudent, T0, type TestApp } from '../../../../test/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ PAYMENTS_SIMULATOR: 'true', TAXI_ONLINE_PAYMENT: 'true' });
});
afterAll(async () => t.close());

const MIN = 60_000;
type Student = Awaited<ReturnType<typeof registerStudent>>;

/** Tests move the clock by hours: each call gets a fresh session instead of an access token that has expired. */
async function call(s: Student, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  const { accessToken } = await t.c.modules.identity.startSession({ _id: new ObjectId(s.userId), platformRoles: [] });
  return t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(accessToken), payload });
}

/** A fresh trip with the clock reset, so every test starts from the same moment. */
/** Non-refundable 30 minutes before departure unless said otherwise (`lockMinutes: undefined`: the default rule). */
async function newTrip(org: Student, over: Partial<{ leaveInMinutes: number; seats: number; fare: number; lockMinutes: number | undefined }> = {}) {
  const res = await call(org, 'POST', '/taxi/trips', { from: 'UGB · Village E', to: 'Saint-Louis · Gare routière', seats: 4, fare: 3000, leaveInMinutes: 60, lockMinutes: 30, ...over });
  expect(res.statusCode, res.body).toBe(201);
  return json(res);
}

/** Through the simulator page: the signed webhook goes through the real webhook route. */
const simulate = (reference: string, action: 'pay' | 'fail' | 'cancel' | 'duplicate') =>
  t.app.inject({ method: 'POST', url: `/api/v1/dev/payment-simulator/${reference}/${action}`, headers: { 'content-type': 'text/plain' }, payload: '' });

async function joinAndPay(s: Student, tripId: string) {
  const res = await call(s, 'POST', `/taxi/trips/${tripId}/join`, { method: 'wave', returnUrl: 'ugbconnect://paiement/retour' });
  expect(res.statusCode, res.body).toBe(201);
  const { payment } = json(res);
  const paid = await simulate(payment.reference, 'pay');
  expect(paid.statusCode).toBe(303);
  return payment.reference as string;
}

const payouts = () => t.c.mongo.db.collection('payouts');

describe('create', () => {
  it('computes the seat price and the lock on the server', async () => {
    t.clock.set(T0);
    const org = await registerStudent(t);
    const trip = await newTrip(org, { fare: 2500, seats: 4, leaveInMinutes: 60, lockMinutes: undefined });
    expect(trip).toMatchObject({ seatPrice: 650, seatsTaken: 1, status: 'open', me: { role: 'organizer', status: 'joined' } });
    // No delay chosen: non-refundable 10 minutes before departure.
    expect(Date.parse(trip.lockAt)).toBe(T0 + 50 * MIN);
    expect(trip.passengers).toHaveLength(1);
  });

  it('the organizer chooses when it stops being refundable, shorter than the time before departure', async () => {
    t.clock.set(T0);
    const org = await registerStudent(t);
    const trip = await newTrip(org, { leaveInMinutes: 60, lockMinutes: 20 });
    expect(Date.parse(trip.lockAt)).toBe(T0 + 40 * MIN);
    const late = await call(await registerStudent(t), 'POST', '/taxi/trips', { from: 'Village A', to: 'Gare routière', seats: 4, fare: 2000, leaveInMinutes: 30, lockMinutes: 30 });
    expect(json(late).field).toBe('lockMinutes');
  });

  it('locks half-way for trips proposed less than an hour ahead', async () => {
    t.clock.set(T0);
    const trip = await newTrip(await registerStudent(t), { leaveInMinutes: 15, lockMinutes: undefined });
    expect(Date.parse(trip.lockAt)).toBe(T0 + 7.5 * MIN);
  });

  it('rejects bad input', async () => {
    const org = await registerStudent(t);
    const post = (body: object) => call(org, 'POST', '/taxi/trips', { from: 'UGB', to: 'Gandon', seats: 4, fare: 3000, leaveInMinutes: 30, ...body });
    expect(json(await post({ leaveInMinutes: 5 })).code).toBe('DEPARTURE_TOO_SOON');
    expect((await post({ fare: 100 })).statusCode).toBe(400);
    expect((await post({ fare: 25_000 })).statusCode).toBe(400);
    expect((await post({ seats: 5 })).statusCode).toBe(400);
    expect((await post({ to: ' ugb ' })).statusCode).toBe(400);
  });

  it('a retried request returns the same trip; a different one is refused', async () => {
    const org = await registerStudent(t);
    const first = await newTrip(org);
    const again = await call(org, 'POST', '/taxi/trips', { from: 'UGB · Village E', to: 'Saint-Louis · Gare routière', seats: 4, fare: 3000, leaveInMinutes: 60 });
    expect(again.statusCode).toBe(200);
    expect(json(again).id).toBe(first.id);
    const other = await call(org, 'POST', '/taxi/trips', { from: 'UGB', to: 'Gandon', seats: 3, fare: 2000, leaveInMinutes: 60 });
    expect(json(other)).toMatchObject({ code: 'ALREADY_IN_TRIP', tripId: first.id });
  });
});

describe('join and pay', () => {
  it('holds the seat while paying, then joins on the provider’s confirmation only', async () => {
    t.clock.set(T0);
    const [org, s] = [await registerStudent(t), await registerStudent(t)];
    const trip = await newTrip(org);
    const res = await call(s, 'POST', `/taxi/trips/${trip.id}/join`, { method: 'orange_money' });
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.payment).toMatchObject({ amount: 750, status: 'pending', purpose: 'taxi_seat' });
    expect(body.payment.checkoutUrl).toMatch(/\/api\/v1\/dev\/payment-simulator\/PAY_/);
    expect(body.trip).toMatchObject({ seatsTaken: 2, me: { status: 'pending_payment' } });

    // Coming back to pay gives the same payment, not a second seat.
    const again = await call(s, 'POST', `/taxi/trips/${trip.id}/join`, { method: 'orange_money' });
    expect(again.statusCode).toBe(200);
    expect(json(again).payment.reference).toBe(body.payment.reference);

    expect((await simulate(body.payment.reference, 'pay')).statusCode).toBe(200); // no returnUrl: a page
    const after = json(await call(s, 'GET', `/taxi/trips/${trip.id}`));
    expect(after).toMatchObject({ seatsTaken: 2, me: { status: 'joined' } });
    expect(after.passengers.map((p: { role: string }) => p.role)).toEqual(['organizer', 'passenger']);
    expect(json(await call(s, 'GET', `/payments/${body.payment.reference}`))).toMatchObject({ status: 'succeeded', fulfillment: 'fulfilled' });
  });

  it('never sells the last seat twice', async () => {
    const org = await registerStudent(t);
    const trip = await newTrip(org, { seats: 2 });
    const [a, b] = [await registerStudent(t), await registerStudent(t)];
    const results = await Promise.all([a, b].map((s) => call(s, 'POST', `/taxi/trips/${trip.id}/join`, { method: 'wave' })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(json(results.find((r) => r.statusCode === 409)!).code).toBe('TRIP_FULL');
  });

  it('one trip at a time per student', async () => {
    const s = await registerStudent(t);
    const [t1, t2] = [await newTrip(await registerStudent(t)), await newTrip(await registerStudent(t))];
    await joinAndPay(s, t1.id);
    expect(json(await call(s, 'POST', `/taxi/trips/${t2.id}/join`, { method: 'wave' }))).toMatchObject({ code: 'ALREADY_IN_TRIP', tripId: t1.id });
  });

  it('refuses a return link outside the app', async () => {
    const trip = await newTrip(await registerStudent(t));
    const res = await call(await registerStudent(t), 'POST', `/taxi/trips/${trip.id}/join`, { method: 'wave', returnUrl: 'https://evil.example/steal' });
    expect(res.statusCode).toBe(400);
  });

  it('releases an unpaid seat after 10 minutes; a late payment keeps it only if still free', async () => {
    t.clock.set(T0);
    const trip = await newTrip(await registerStudent(t), { seats: 2 });
    const late = await registerStudent(t);
    const { payment } = json(await call(late, 'POST', `/taxi/trips/${trip.id}/join`, { method: 'wave' }));
    t.clock.advance(11 * MIN);
    await t.c.modules.payments.sweep();
    expect(json(await call(late, 'GET', `/taxi/trips/${trip.id}`))).toMatchObject({ seatsTaken: 1, me: { status: 'expired' } });

    // Someone else takes the seat, then the late payment arrives: refunded automatically.
    await joinAndPay(await registerStudent(t), trip.id);
    await simulate(payment.reference, 'pay');
    expect(json(await call(late, 'GET', `/payments/${payment.reference}`))).toMatchObject({ status: 'succeeded', fulfillment: 'unfulfillable' });
    const refund = await payouts().findOne({ idempotencyKey: { $regex: ':unfulfillable$' }, amount: 1500 });
    expect(refund).toMatchObject({ kind: 'refund', reason: 'late_payment_unfulfillable', status: 'requested' });
  });
});

describe('webhooks', () => {
  it('a duplicate event is processed once; a bad signature is refused and never processed', async () => {
    t.clock.set(T0);
    const trip = await newTrip(await registerStudent(t));
    const s = await registerStudent(t);
    const { payment } = json(await call(s, 'POST', `/taxi/trips/${trip.id}/join`, { method: 'wave' }));
    await simulate(payment.reference, 'duplicate');
    const events = await t.c.mongo.db.collection('paymentEvents').find({ 'payload.reference': payment.reference }).toArray();
    expect(events).toHaveLength(1);
    expect(json(await call(s, 'GET', `/taxi/trips/${trip.id}`)).seatsTaken).toBe(2);

    const forged = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/simulated',
      headers: { 'content-type': 'application/json', 'x-simulator-signature': `t=${Math.floor(T0 / 1000)},v1=${'0'.repeat(64)}` },
      payload: JSON.stringify({ id: 'evt_forged', type: 'checkout.completed', data: { reference: payment.reference, amount: 750, currency: 'XOF' } }),
    });
    expect(forged.statusCode).toBe(401);
  });

  it('a failed payment releases the seat at once', async () => {
    const trip = await newTrip(await registerStudent(t));
    const s = await registerStudent(t);
    const { payment } = json(await call(s, 'POST', `/taxi/trips/${trip.id}/join`, { method: 'wave' }));
    await simulate(payment.reference, 'fail');
    expect(json(await call(s, 'GET', `/taxi/trips/${trip.id}`))).toMatchObject({ seatsTaken: 1, me: { status: 'expired' } });
  });
});

describe('leave, cancel, hand over', () => {
  it('leaving before the lock is refunded and reopens the seat; after the lock it is not', async () => {
    t.clock.set(T0);
    const trip = await newTrip(await registerStudent(t), { leaveInMinutes: 60 });
    const [early, late] = [await registerStudent(t), await registerStudent(t)];
    await joinAndPay(early, trip.id);
    await joinAndPay(late, trip.id);

    expect(json(await call(early, 'GET', `/taxi/trips/${trip.id}/leave-quote`))).toEqual({ refundAmount: 750, locked: false });
    expect(json(await call(early, 'POST', `/taxi/trips/${trip.id}/leave`))).toEqual({ refundAmount: 750, forfeited: false });
    const refund = await payouts().findOne({ beneficiaryUserId: new ObjectId(early.userId) });
    expect(refund).toMatchObject({ kind: 'refund', reason: 'taxi_left', amount: 750, status: 'requested', phone: `+221${early.phone}` });
    expect(await t.c.modules.payments.executePayout(refund!._id)).toBe('succeeded');

    t.clock.advance(31 * MIN);
    expect(json(await call(late, 'POST', `/taxi/trips/${trip.id}/leave`))).toEqual({ refundAmount: 0, forfeited: true });
    expect(json(await call(late, 'GET', `/taxi/trips/${trip.id}`)).seatsTaken).toBe(2); // organizer + the forfeited seat
  });

  it('the organizer can’t just leave', async () => {
    const org = await registerStudent(t);
    const trip = await newTrip(org);
    expect(json(await call(org, 'POST', `/taxi/trips/${trip.id}/leave`)).code).toBe('ORGANIZER_CANNOT_LEAVE');
  });

  it('cancelling refunds everyone; late with passengers is a strike, 3 strikes suspend for 7 days', async () => {
    t.clock.set(T0);
    const org = await registerStudent(t);
    for (let i = 0; i < 3; i++) {
      const trip = await newTrip(org, { leaveInMinutes: 60 });
      const s = await registerStudent(t);
      await joinAndPay(s, trip.id);
      t.clock.advance(35 * MIN); // past the lock
      const res = json(await call(org, 'POST', `/taxi/trips/${trip.id}/cancel`));
      expect(res).toMatchObject({ refunded: 1, strike: true, strikes: i + 1, limit: 3 });
      expect(await payouts().findOne({ beneficiaryUserId: new ObjectId(s.userId), reason: 'taxi_cancelled' })).toMatchObject({ amount: 750 });
      t.clock.advance(60 * MIN);
    }
    const blocked = await call(org, 'POST', '/taxi/trips', { from: 'UGB', to: 'Gandon', seats: 4, fare: 2000, leaveInMinutes: 30 });
    expect(blocked.statusCode).toBe(403);
    expect(json(blocked).code).toBe('TAXI_SUSPENDED');
    t.clock.advance(7 * 24 * 60 * MIN);
    expect((await call(org, 'POST', '/taxi/trips', { from: 'UGB', to: 'Gandon', seats: 4, fare: 2000, leaveInMinutes: 30 })).statusCode).toBe(201);
  });

  it('cancelling early or with nobody in is free', async () => {
    t.clock.set(T0);
    const org = await registerStudent(t);
    const trip = await newTrip(org);
    expect(json(await call(org, 'POST', `/taxi/trips/${trip.id}/cancel`))).toMatchObject({ refunded: 0, strike: false, strikes: 0 });
  });

  it('handing over: the first passenger organizes, gets their seat back, no strike', async () => {
    t.clock.set(T0);
    const org = await registerStudent(t);
    const trip = await newTrip(org);
    const [first, second] = [await registerStudent(t), await registerStudent(t)];
    await joinAndPay(first, trip.id);
    await joinAndPay(second, trip.id);
    t.clock.advance(40 * MIN);
    expect((await call(org, 'POST', `/taxi/trips/${trip.id}/handover`)).statusCode).toBe(200);
    const seen = json(await call(first, 'GET', `/taxi/trips/${trip.id}`));
    expect(seen).toMatchObject({ seatsTaken: 2, me: { role: 'organizer' } });
    expect(await payouts().findOne({ beneficiaryUserId: new ObjectId(first.userId), reason: 'taxi_handover' })).toMatchObject({ amount: 750 });
    expect(json(await call(org, 'GET', '/taxi/me'))).toMatchObject({ strikes: 0, activeTripId: null });
  });
});

describe('meeting point, departure and claim', () => {
  it('check-in, vehicle for the trip’s people only, depart from the lock, claim once', async () => {
    t.clock.set(T0);
    const org = await registerStudent(t);
    const trip = await newTrip(org, { leaveInMinutes: 60, fare: 3000 });
    const [a, b, outsider] = [await registerStudent(t), await registerStudent(t), await registerStudent(t)];
    await joinAndPay(a, trip.id);
    await joinAndPay(b, trip.id);
    await call(org, 'PUT', `/taxi/trips/${trip.id}/vehicle`, { label: 'Peugeot 406 jaune · DK-1234-A' });
    expect(json(await call(a, 'GET', `/taxi/trips/${trip.id}`)).vehicle).toBe('Peugeot 406 jaune · DK-1234-A');
    expect(json(await call(outsider, 'GET', `/taxi/trips/${trip.id}`)).vehicle).toBeNull();

    expect(json(await call(org, 'POST', `/taxi/trips/${trip.id}/depart`)).code).toBe('TOO_EARLY_TO_DEPART');
    t.clock.advance(31 * MIN);
    await call(b, 'POST', `/taxi/trips/${trip.id}/leave`); // after the lock: the seat stays paid
    const checked = json(await call(a, 'POST', `/taxi/trips/${trip.id}/check-in`));
    expect(checked.passengers.find((p: { key: string }) => p.key === checked.me.key).checkedIn).toBe(true);

    const departed = json(await call(org, 'POST', `/taxi/trips/${trip.id}/depart`));
    expect(departed).toMatchObject({ status: 'departed', claim: { amount: 1500, payout: null } });
    expect(json(await call(org, 'GET', '/taxi/me')).activeTripId).toBeNull();
    expect((await call(outsider, 'GET', `/taxi/trips/${trip.id}`)).statusCode).toBe(404);

    expect((await call(a, 'POST', `/taxi/trips/${trip.id}/claim`, { method: 'wave' })).statusCode).toBe(404);
    const claim = json(await call(org, 'POST', `/taxi/trips/${trip.id}/claim`, { method: 'wave' }));
    expect(claim).toMatchObject({ kind: 'organizer_claim', amount: 1500, status: 'requested' });
    expect(json(await call(org, 'POST', `/taxi/trips/${trip.id}/claim`, { method: 'orange_money' })).id).toBe(claim.id);
  });

  it('a trip 15 min past its time frees its people, departed or not', async () => {
    t.clock.set(T0);
    const org = await registerStudent(t);
    const trip = await newTrip(org, { leaveInMinutes: 30, lockMinutes: undefined });
    t.clock.advance(46 * MIN);
    await t.c.modules.taxi.service.sweep();
    expect(json(await call(org, 'GET', '/taxi/me')).activeTripId).toBeNull();
    expect(trip.id).toBeTruthy();
  });

  it('without the sweep: a trip of mine past its time no longer stops me proposing or joining another', async () => {
    t.clock.set(T0);
    const org = await registerStudent(t);
    const old = await newTrip(org, { leaveInMinutes: 30, lockMinutes: undefined });
    // Still within its grace: it blocks.
    t.clock.advance(40 * MIN);
    expect(json(await call(org, 'POST', '/taxi/trips', { from: 'UGB · Village A', to: 'Saint-Louis · Sor', seats: 3, fare: 2000, leaveInMinutes: 60 }))).toMatchObject({ code: 'ALREADY_IN_TRIP', tripId: old.id });
    // Its time has come (no sweep ran): it left by itself. Still on my board, departed (its chat stays open); gone
    // from everyone else's; and I'm free to propose another.
    t.clock.advance(10 * MIN);
    expect(json(await call(org, 'GET', '/taxi/trips')).items.find((x: { id: string }) => x.id === old.id)).toMatchObject({ status: 'departed' });
    expect((await call(await registerStudent(t), 'GET', '/taxi/trips')).body).not.toContain(old.id);
    const fresh = await newTrip(org, { leaveInMinutes: 60 });
    expect(json(await call(org, 'GET', '/taxi/me')).activeTripId).toBe(fresh.id);

    // Same when joining someone else's.
    const passenger = await registerStudent(t);
    const first = await newTrip(await registerStudent(t), { leaveInMinutes: 20, lockMinutes: undefined });
    await joinAndPay(passenger, first.id);
    t.clock.advance(40 * MIN);
    const other = await newTrip(await registerStudent(t), { leaveInMinutes: 60 });
    await joinAndPay(passenger, other.id);
    expect(json(await call(passenger, 'GET', '/taxi/me')).activeTripId).toBe(other.id);
  });
});

describe('privacy', () => {
  it('lists show first names and initials, never ids or phone numbers', async () => {
    t.clock.set(T0);
    const org = await registerStudent(t);
    const trip = await newTrip(org);
    const s = await registerStudent(t);
    await joinAndPay(s, trip.id);
    const body = (await call(await registerStudent(t), 'GET', '/taxi/trips')).body;
    expect(body).toContain(trip.id);
    for (const secret of [org.userId, s.userId, org.phone, s.phone]) expect(body).not.toContain(secret);
    const seen = json(await call(s, 'GET', `/taxi/trips/${trip.id}`));
    expect(seen.organizer).toMatchObject({ name: 'Awa D.', initials: 'AD', trips: 0 });
  });
});
