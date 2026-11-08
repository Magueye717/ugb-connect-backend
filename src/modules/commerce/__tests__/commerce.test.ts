import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, nextPhone, nextStudentNumber, registerStudent, T0, type TestApp } from '../../../../test/harness.js';
import { picture } from '../../../../test/upload.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ PAYMENTS_SIMULATOR: 'true' });
});
afterAll(async () => t.close());

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
const pay = (reference: string) => t.app.inject({ method: 'POST', url: `/api/v1/dev/payment-simulator/${reference}/pay`, headers: { 'content-type': 'text/plain' }, payload: '' });
const types = async (who: Who) => (await ok(call(who, 'GET', '/notifications'))).items.map((n: { type: string }) => n.type);

/** A business created by an admin, open all day (the test clock is 10:00 in Dakar). */
async function business(kind: 'restaurant' | 'shop', extra: object = {}) {
  t.clock.set(T0);
  const admin = await createStaff(t, ['admin']);
  const phone = nextPhone();
  const b = await ok(
    call(admin, 'POST', '/admin/businesses', {
      kind, name: kind === 'restaurant' ? 'Khoulé & Frère' : 'Papeterie du Campus', specialties: [kind === 'restaurant' ? 'Sénégalais' : 'Fournitures'],
      owner: { phone, firstName: 'Modou', lastName: 'Khoulé' }, address: 'Près du Village E', campus: 'campus1', location: { lat: 16.06, lng: -16.42 },
      services: [{ start: '08:00', end: '23:00' }], deliveryFees: { campus1: 200, campus2: 300, outside: null }, ...extra,
    }),
    201,
  );
  const owner = (await t.c.modules.accounts.findByPhone(`+221${phone}`))!;
  return { b, owner: { userId: owner._id }, orgId: b.orgId as string, admin, sp: kind };
}

describe('restaurants', () => {
  it('created by an admin; the owner gets a business space, adds staff and menus; staff only switch availability', async () => {
    const { b, owner, orgId, sp } = await business('restaurant');
    expect(b).toMatchObject({ kind: 'restaurant', name: 'Khoulé & Frère', open: true, statusLabel: 'Ouvert · jusqu’à 23h', deliveryFee: 200, campusLabel: 'Campus 1', location: { lat: 16.06, lng: -16.42 } });
    const me = await ok(call(owner, 'GET', '/me'));
    expect(me.spaces.find((x: { type: string }) => x.type === 'business')).toMatchObject({ key: `restaurant:${orgId}`, kind: 'restaurant', name: 'Khoulé & Frère', roles: ['owner'] });

    const staff = await createStaff(t);
    expect((await call(owner, 'PUT', `/org/${orgId}/${sp}/members`, { phone: staff.phone, roles: ['staff'] })).statusCode).toBe(204);
    const mafe = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'menu', name: 'Mafé yap', detail: 'Riz · sauce arachide', price: 1500 }), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'drink', name: 'Bissap', price: 300 }), 201);
    expect((await call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'article', name: 'Cahier', price: 300 })).statusCode).toBe(400);
    expect((await call(staff, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'menu', name: 'Yassa', price: 1700 })).statusCode).toBe(404);
    expect((await call(staff, 'PATCH', `/org/${orgId}/${sp}/catalog/${mafe.id}`, { price: 100 })).statusCode).toBe(403);
    expect((await ok(call(staff, 'PATCH', `/org/${orgId}/${sp}/catalog/${mafe.id}`, { available: false }))).available).toBe(false);
    await ok(call(staff, 'PATCH', `/org/${orgId}/${sp}/catalog/${mafe.id}`, { available: true }));

    const s = await registerStudent(t);
    const listed = (await ok(call(s, 'GET', '/businesses?kind=restaurant'))).items.find((x: { id: string }) => x.id === b.id);
    // « Dès » the cheapest dish (the Mafé), not the 300 F Bissap.
    expect(listed).toMatchObject({ open: true, minPrice: 1500, highlights: [expect.objectContaining({ name: 'Mafé yap' })] });
    expect((await ok(call(s, 'GET', `/businesses/${b.id}`))).items.map((i: { name: string }) => i.name)).toEqual(['Bissap', 'Mafé yap']);
  });

  it('an order: paid, the team notified; accepted, ready, completed (paid out); another refused (refunded)', async () => {
    const { b, owner, orgId, sp } = await business('restaurant');
    const staff = await createStaff(t);
    await call(owner, 'PUT', `/org/${orgId}/${sp}/members`, { phone: staff.phone, roles: ['staff'] });
    const mafe = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'menu', name: 'Mafé yap', price: 1500 }), 201);
    const bissap = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'drink', name: 'Bissap', price: 300 }), 201);
    const s = await registerStudent(t);

    expect(json(await call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 1 }], mode: 'delivery', method: 'wave' })).field).toBe('zone');
    // No delivery outside the campus for this one: refused, with the reason.
    expect(json(await call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 1 }], mode: 'delivery', zone: 'outside', address: 'Sanar', method: 'wave' })).field).toBe('zone');
    expect(json(await call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 1 }], mode: 'delivery', zone: 'campus1', method: 'wave' })).field).toBe('address');
    const { order, payment } = await ok(
      call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 2 }, { itemId: bissap.id, qty: 1 }], mode: 'delivery', zone: 'campus1', address: 'Village E, chambre 214', method: 'wave' }),
      201,
    );
    expect(order).toMatchObject({ status: 'pending_payment', subtotal: 3300, deliveryFee: 200, total: 3500, payment: { reference: payment.reference } });
    // Not paid yet: the business doesn't see it.
    expect((await ok(call(owner, 'GET', `/org/${orgId}/${sp}/orders`))).items).toEqual([]);
    await pay(payment.reference);
    const queue = (await ok(call(staff, 'GET', `/org/${orgId}/${sp}/orders`))).items;
    expect(queue[0]).toMatchObject({ id: order.id, status: 'placed', customer: { name: 'Awa Diop' }, address: 'Village E, chambre 214' });
    // Each line with its item's picture (none here).
    expect(queue[0].lines[0]).toEqual({ itemId: mafe.id, name: 'Mafé yap', price: 1500, qty: 2, photo: null });
    expect(await types(owner)).toContain('commerce.order_placed');
    expect(await types(staff)).toContain('commerce.order_placed');
    // The shop's space shows only its orders, not the owner's other notifications.
    await t.c.modules.notifications.notify([owner.userId], { type: 'ticket.transfer_offered', category: 'paiements', title: 'Billet', body: 'Pour toi', icon: 'ticket-outline', dedupeKey: `test:${order.id}` });
    expect((await ok(call(owner, 'GET', '/notifications?scope=orders'))).items.map((n: { type: string }) => n.type)).toEqual(['commerce.order_placed']);
    expect(await ok(call(owner, 'GET', '/notifications/unread-count?scope=orders'))).toEqual({ count: 1 });
    expect((await call(owner, 'POST', '/notifications/read', { all: true, scope: 'orders' })).statusCode).toBe(204);
    expect(await ok(call(owner, 'GET', '/notifications/unread-count?scope=orders'))).toEqual({ count: 0 });
    expect(await ok(call(owner, 'GET', '/notifications/unread-count'))).toEqual({ count: 1 });

    await ok(call(staff, 'POST', `/org/${orgId}/${sp}/orders/${order.id}/accept`));
    expect(json(await call(s, 'POST', `/me/orders/${order.id}/cancel`)).code).toBe('ORDER_ALREADY_TAKEN');
    await ok(call(staff, 'POST', `/org/${orgId}/${sp}/orders/${order.id}/ready`));
    expect(await types(s)).toEqual(expect.arrayContaining(['commerce.order_accepted', 'commerce.order_ready']));
    expect(json(await call(staff, 'POST', `/org/${orgId}/${sp}/orders/${order.id}/ready`)).code).toBe('ORDER_STEP');
    await ok(call(staff, 'POST', `/org/${orgId}/${sp}/orders/${order.id}/complete`));
    const done = await t.c.mongo.db.collection('commerceOrders').findOne({ _id: new ObjectId(order.id as string) });
    const payout = await t.c.mongo.db.collection('payouts').findOne({ _id: done!.payoutId });
    expect(payout).toMatchObject({ kind: 'organizer_claim', amount: 3500, reason: 'order_payout' });
    expect((await ok(call(s, 'GET', `/me/orders/${order.id}`))).history.map((h: { status: string }) => h.status)).toEqual(['pending_payment', 'placed', 'accepted', 'ready', 'completed']);
    expect(await types(s)).toContain('commerce.order_completed');

    // Picked up at the counter: the code given (or its QR scanned) hands it over.
    const pickup = await ok(call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 1 }], mode: 'pickup', method: 'wave' }), 201);
    await pay(pickup.payment.reference);
    expect(json(await call(staff, 'POST', `/org/${orgId}/${sp}/orders/handover`, { code: pickup.order.code })).code).toBe('ORDER_NOT_ACCEPTED');
    await ok(call(staff, 'POST', `/org/${orgId}/${sp}/orders/${pickup.order.id}/accept`));
    expect(await ok(call(staff, 'POST', `/org/${orgId}/${sp}/orders/handover`, { code: `UGBCMD:${pickup.order.code.toLowerCase()}` }))).toMatchObject({ id: pickup.order.id, status: 'completed' });
    expect(json(await call(staff, 'POST', `/org/${orgId}/${sp}/orders/handover`, { code: pickup.order.code })).code).toBe('ORDER_ALREADY_DONE');
    expect((await call(staff, 'POST', `/org/${orgId}/${sp}/orders/handover`, { code: 'CZZZZZZ' })).statusCode).toBe(404);

    // Refused: refunded, with the reason.
    const second = await ok(call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 1 }], mode: 'pickup', method: 'wave' }), 201);
    await pay(second.payment.reference);
    const refused = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/orders/${second.order.id}/refuse`, { reason: 'Plus de mafé ce soir.' }));
    expect(refused).toMatchObject({ status: 'refused', refusal: 'Plus de mafé ce soir.', refunded: true });
    expect(await types(s)).toContain('commerce.order_refused');
    // Other businesses can't touch it.
    const other = await business('restaurant');
    expect((await call(other.owner, 'GET', `/org/${orgId}/${sp}/orders/${order.id}`)).statusCode).toBe(404);
  });

  it('closed outside its hours, or paused by its owner', async () => {
    const { b, owner, orgId, sp } = await business('restaurant', { services: [{ start: '12:00', end: '15:00' }, { start: '19:00', end: '22:00' }] });
    const mafe = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'menu', name: 'Mafé', price: 1500 }), 201);
    const s = await registerStudent(t);
    expect(await ok(call(s, 'GET', `/businesses/${b.id}`))).toMatchObject({ open: false, statusLabel: 'Fermé · ouvre à 12h', hours: '12h-15h · 19h-22h' });
    expect(json(await call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 1 }], mode: 'pickup', method: 'wave' })).code).toBe('BUSINESS_CLOSED');
    t.clock.set(T0 + 3 * 3_600_000); // 13:00
    await ok(call(owner, 'PATCH', `/org/${orgId}/${sp}/business`, { acceptingOrders: false }));
    expect(await ok(call(s, 'GET', `/businesses/${b.id}`))).toMatchObject({ open: false, statusLabel: 'Commandes en pause' });
  });
});

describe('payment methods', () => {
  it('a business accepts cash: the order goes straight to it, paid by hand (no refund, no payout); only the methods it accepts', async () => {
    const { b, owner, orgId, sp, admin } = await business('restaurant');
    expect(b.paymentMethods.map((m: { value: string }) => m.value)).toEqual(['wave', 'orange_money']);
    expect((await call(owner, 'PATCH', `/org/${orgId}/${sp}/business`, { paymentMethods: [] })).statusCode).toBe(400);
    const set = await ok(call(owner, 'PATCH', `/org/${orgId}/${sp}/business`, { paymentMethods: ['wave', 'cash'] }));
    expect(set.paymentMethods).toEqual([{ value: 'cash', label: 'Espèces' }, { value: 'wave', label: 'Wave' }]);
    const mafe = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'menu', name: 'Mafé yap', price: 1500 }), 201);
    const s = await registerStudent(t);
    const line = { lines: [{ itemId: mafe.id, qty: 1 }], mode: 'pickup' };

    expect(json(await call(s, 'POST', `/businesses/${b.id}/orders`, { ...line, method: 'orange_money' })).field).toBe('method');
    const first = await ok(call(s, 'POST', `/businesses/${b.id}/orders`, { ...line, method: 'cash' }), 201);
    expect(first.payment).toBeNull();
    expect(first.order).toMatchObject({ status: 'placed', method: 'cash', methodLabel: 'Espèces', payment: null });
    expect((await ok(call(owner, 'GET', `/org/${orgId}/${sp}/orders`))).items.map((o: { id: string }) => o.id)).toEqual([first.order.id]);
    expect(await types(owner)).toContain('commerce.order_placed');
    // Cancelled before it's taken: nothing was paid, nothing to refund.
    expect((await ok(call(s, 'POST', `/me/orders/${first.order.id}/cancel`))).refunded).toBe(false);

    const second = (await ok(call(s, 'POST', `/businesses/${b.id}/orders`, { ...line, method: 'cash' }), 201)).order;
    for (const step of ['accept', 'ready', 'complete']) await ok(call(owner, 'POST', `/org/${orgId}/${sp}/orders/${second.id}/${step}`));
    // Served and paid by hand: no payout for this one.
    const doc = await t.c.mongo.db.collection('commerceOrders').findOne({ _id: new ObjectId(second.id) });
    expect(doc).toMatchObject({ status: 'completed', method: 'cash', payoutId: null, refundPayoutId: null });

    // Référencement sets them at creation, with several opening slots.
    const created = await ok(
      call(admin, 'POST', '/admin/businesses', {
        kind: 'shop', name: 'Kiosque Cash', specialties: ['Épicerie'], owner: { phone: nextPhone(), firstName: 'Ibou', lastName: 'Ndiaye' },
        paymentMethods: ['cash'], services: [{ start: '18:00', end: '22:00' }, { start: '08:00', end: '12:00' }],
      }),
      201,
    );
    expect(created.paymentMethods).toEqual([{ value: 'cash', label: 'Espèces' }]);
    expect(created.services).toEqual([{ start: '08:00', end: '12:00' }, { start: '18:00', end: '22:00' }]);
  });
});

describe('shops', () => {
  it('articles with stock: taken by an order, given back when cancelled or unpaid', async () => {
    const { b, owner, orgId, sp } = await business('shop');
    const pen = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'article', category: 'Fournitures', name: 'Stylo bleu', price: 200, stock: 2 }), 201);
    const a = await registerStudent(t);
    const c = await registerStudent(t);
    const first = await ok(call(a, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: pen.id, qty: 2 }], mode: 'pickup', method: 'wave' }), 201);
    expect(json(await call(c, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: pen.id, qty: 1 }], mode: 'pickup', method: 'wave' })).code).toBe('OUT_OF_STOCK');
    expect((await ok(call(c, 'GET', `/businesses/${b.id}`))).items[0]).toMatchObject({ stock: 0, soldOut: true });
    // Paid then cancelled before the shop takes it: refunded, the stock comes back.
    await pay(first.payment.reference);
    expect(await ok(call(a, 'POST', `/me/orders/${first.order.id}/cancel`))).toMatchObject({ status: 'cancelled', refunded: true });
    expect(await types(owner)).toContain('commerce.order_cancelled');
    expect((await ok(call(c, 'GET', `/businesses/${b.id}`))).items[0].stock).toBe(2);
    await ok(call(c, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: pen.id, qty: 1 }], mode: 'pickup', method: 'wave' }), 201);
    // The market: every shop's articles together, each with its shop.
    const market = await ok(call(c, 'GET', '/market?kind=shop'));
    expect(market.businesses.some((x: { id: string }) => x.id === b.id)).toBe(true);
    expect(market.items.find((i: { id: string }) => i.id === pen.id)).toMatchObject({ businessId: b.id, name: 'Stylo bleu', category: 'Fournitures' });
    expect((await ok(call(c, 'GET', '/businesses?kind=shop'))).items.find((x: { id: string }) => x.id === b.id).itemNames).toEqual(['Stylo bleu']);
    // Students list only shops here.
    expect((await ok(call(c, 'GET', '/businesses?kind=shop'))).items.some((x: { id: string }) => x.id === b.id)).toBe(true);
    expect((await ok(call(c, 'GET', '/businesses?kind=restaurant'))).items.some((x: { id: string }) => x.id === b.id)).toBe(false);
  });

  it('a service for information only (printing on the spot): shown with its price, no stock, never ordered', async () => {
    const { b, owner, orgId, sp } = await business('shop');
    const print = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'article', category: 'Services', name: 'Impression', detail: 'La page A4', price: 25, stock: 10, orderable: false }), 201);
    expect(print).toMatchObject({ orderable: false, stock: null, soldOut: false });
    const s = await registerStudent(t);
    expect((await ok(call(s, 'GET', `/businesses/${b.id}`))).items.find((i: { id: string }) => i.id === print.id)).toMatchObject({ name: 'Impression', price: 25, orderable: false });
    const refused = await call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: print.id, qty: 1 }], mode: 'pickup', method: 'wave' });
    expect([refused.statusCode, json(refused).code]).toEqual([422, 'ITEM_NOT_ORDERABLE']);
    // Made orderable again: it can be ordered.
    expect(await ok(call(owner, 'PATCH', `/org/${orgId}/${sp}/catalog/${print.id}`, { orderable: true }))).toMatchObject({ orderable: true });
    await ok(call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: print.id, qty: 1 }], mode: 'pickup', method: 'wave' }), 201);
  });

  it('a restaurant is « dès » its cheapest dish, never a drink', async () => {
    const { b, owner, orgId, sp } = await business('restaurant');
    await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'drink', name: 'Eau 50 cl', detail: '', price: 250 }), 201);
    await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'menu', name: 'Thiéboudienne', detail: 'Poisson', price: 1500 }), 201);
    const s = await registerStudent(t);
    const listed = (await ok(call(s, 'GET', '/businesses?kind=restaurant'))).items.find((x: { id: string }) => x.id === b.id);
    expect(listed.minPrice).toBe(1500);
  });

  it('« Intéressé » on a service done on the spot: the shop is told who (with the phone), once; never for an orderable article', async () => {
    const { b, owner, orgId, sp } = await business('shop');
    const print = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'article', category: 'Services', name: 'Reliure', detail: 'Spirale', price: 500, orderable: false }), 201);
    const pen = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'article', category: 'Fournitures', name: 'Stylo', detail: 'Bleu', price: 150 }), 201);
    const s = await registerStudent(t, { firstName: 'Mariama', lastName: 'Diallo' });
    expect(await ok(call(s, 'PUT', `/items/${print.id}/interest`))).toEqual({ interested: true });
    expect(await ok(call(s, 'PUT', `/items/${print.id}/interest`))).toEqual({ interested: true }); // twice: told once
    expect((await ok(call(s, 'GET', `/businesses/${b.id}`))).items.find((i: { id: string }) => i.id === print.id).interested).toBe(true);
    expect(json(await call(s, 'PUT', `/items/${pen.id}/interest`)).code).toBe('ORDERABLE');
    expect(json(await call(owner, 'PUT', `/items/${print.id}/interest`)).code).toBe('OWN_BUSINESS');

    const list = (await ok(call(owner, 'GET', `/org/${orgId}/${sp}/interests`))).items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ item: { name: 'Reliure' }, student: { name: 'Mariama Diallo' } });
    expect(list[0].student.phone).toMatch(/^\d{2} \d{3} \d{2} \d{2}$/);
    const told = await t.c.mongo.db.collection('notifications').countDocuments({ type: 'commerce.item_interest' });
    expect(told).toBeGreaterThanOrEqual(1);

    expect(await ok(call(s, 'DELETE', `/items/${print.id}/interest`))).toEqual({ interested: false });
    expect((await ok(call(owner, 'GET', `/org/${orgId}/${sp}/interests`))).items).toEqual([]);
  });
});

describe('one entity, several spaces', () => {
  it('a restaurant gets a shop: each space has its own team; members are added in two steps and told; only the owner edits the business', async () => {
    const { b, owner, orgId, admin } = await business('restaurant');
    // The same entity opens a shop: the owner holds both spaces.
    const shop = await ok(call(admin, 'POST', '/admin/businesses', { kind: 'shop', name: 'Khoulé Boutique', specialties: ['Épicerie'], orgId }), 201);
    expect(shop.orgId).toBe(orgId);
    expect(json(await call(admin, 'POST', '/admin/businesses', { kind: 'shop', name: 'Encore', specialties: ['Épicerie'], orgId })).code).toBe('BUSINESS_EXISTS');
    const keys = (await ok(call(owner, 'GET', '/me'))).spaces.map((x: { key: string }) => x.key);
    expect(keys).toEqual([`restaurant:${orgId}`, `shop:${orgId}`]);

    // Step 1: a number without an account. Step 2 then needs a first name, a last name and a password.
    const phone = nextPhone();
    expect(await ok(call(owner, 'POST', `/org/${orgId}/members/lookup`, { phone }))).toEqual({ exists: false });
    expect(json(await call(owner, 'PUT', `/org/${orgId}/shop/members`, { phone, roles: ['staff'], firstName: 'Awa', lastName: 'Sow' })).code).toBe('USER_NOT_FOUND');
    expect((await call(owner, 'PUT', `/org/${orgId}/shop/members`, { phone, roles: ['staff'], firstName: 'Awa', lastName: 'Sow', password: '  Campus2026  ' })).statusCode).toBe(204);
    expect(await ok(call(owner, 'POST', `/org/${orgId}/members/lookup`, { phone }))).toEqual({ exists: true, firstName: 'Awa', lastName: 'S.', assignments: [{ space: 'shop', roles: ['staff'] }] });
    // Only the shop's roles; never owner.
    expect((await call(owner, 'PUT', `/org/${orgId}/shop/members`, { phone, roles: ['scanner'] })).statusCode).toBe(403);

    // She signs in with her password (spaces trimmed), sees the shop only, and was told.
    const login = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: phone, password: 'Campus2026' } });
    expect(login.statusCode, login.body).toBe(200);
    const awa = { userId: json(login).userId as string };
    expect((await ok(call(awa, 'GET', '/me'))).spaces.map((x: { key: string }) => x.key)).toEqual([`shop:${orgId}`]);
    expect(await types(awa)).toContain('org.member_added');
    expect((await call(awa, 'GET', `/org/${orgId}/shop/orders`)).statusCode).toBe(200);
    expect((await call(awa, 'GET', `/org/${orgId}/restaurant/orders`)).statusCode).toBe(404);
    // Not the owner: no team, no profile changes (pausing orders is a manager's, not an employee's).
    expect((await call(awa, 'GET', `/org/${orgId}/shop/members`)).statusCode).toBe(404);
    expect((await call(awa, 'PATCH', `/org/${orgId}/shop/business`, { description: 'x' })).statusCode).toBe(404);

    const manager = await createStaff(t);
    expect((await call(owner, 'PUT', `/org/${orgId}/restaurant/members`, { phone: manager.phone, roles: ['manager'] })).statusCode).toBe(204);
    expect((await call(manager, 'PATCH', `/org/${orgId}/restaurant/business`, { description: 'Nouveau' })).statusCode).toBe(403);
    expect((await ok(call(manager, 'PATCH', `/org/${orgId}/restaurant/business`, { acceptingOrders: false }))).acceptingOrders).toBe(false);
    expect((await ok(call(owner, 'PATCH', `/org/${orgId}/restaurant/business`, { description: 'Nouveau', acceptingOrders: true }))).description).toBe('Nouveau');
    expect(json(await call(owner, 'PATCH', `/org/${orgId}/restaurant/business`, { specialties: ['Pizza du lundi'] })).field).toBe('specialties');

    // Removed: no space left, so signing in answers as for an unknown number.
    expect((await call(owner, 'DELETE', `/org/${orgId}/shop/members/${awa.userId}`)).statusCode).toBe(204);
    const again = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: phone, password: 'Campus2026' } });
    expect(json(again).code).toBe('ACCOUNT_NOT_FOUND');
    expect(b.id).toBeTruthy();
  });

  it('a student removed from a team keeps the student space only', async () => {
    const { owner, orgId } = await business('shop');
    const s = await registerStudent(t);
    expect((await call(owner, 'PUT', `/org/${orgId}/shop/members`, { phone: s.phone, roles: ['staff'] })).statusCode).toBe(204);
    expect((await ok(call(s, 'GET', '/me'))).spaces.map((x: { type: string }) => x.type)).toEqual(['student', 'business']);
    expect((await call(owner, 'DELETE', `/org/${orgId}/shop/members/${s.userId}`)).statusCode).toBe(204);
    expect((await ok(call(s, 'GET', '/me'))).spaces.map((x: { type: string }) => x.type)).toEqual(['student']);
  });

  it('lists the specialties and delivery zones the app offers', async () => {
    const ref = json(await t.app.inject({ method: 'GET', url: '/api/v1/reference/commerce' }));
    expect(ref.specialties.restaurant).toContain('Sénégalais');
    expect(ref.zones).toEqual([{ value: 'campus1', label: 'Campus 1' }, { value: 'campus2', label: 'Campus 2' }, { value: 'outside', label: 'Hors campus' }]);
  });
});

describe('mon équipe (the whole entity)', () => {
  it('one person, several roles across spaces; listed once; a role removed at a time; the owner untouched', async () => {
    const { orgId, owner, admin } = await business('restaurant');
    await ok(call(admin, 'POST', '/admin/businesses', { kind: 'shop', name: 'Khoulé Boutique', specialties: ['Épicerie'], orgId }), 201);

    const team0 = await ok(call(owner, 'GET', `/org/${orgId}/team`));
    expect(team0.spaces.map((x: { space: string; roles: { value: string }[] }) => [x.space, x.roles.map((r) => r.value)])).toEqual([['restaurant', ['manager', 'staff']], ['shop', ['manager', 'staff']]]);

    const phone = nextPhone();
    expect((await ok(call(owner, 'POST', `/org/${orgId}/members/lookup`, { phone }))).exists).toBe(false);
    const put = (body: object) => call(owner, 'PUT', `/org/${orgId}/team`, body);
    expect((await put({ phone, assignments: [{ space: 'restaurant', roles: ['scanner'] }] })).statusCode).toBe(403);
    expect((await put({ phone, assignments: [{ space: 'organizer', roles: ['scanner'] }] })).statusCode).toBe(422);
    expect((await put({ phone, firstName: 'Awa', lastName: 'Ndiaye', password: 'Campus2026', assignments: [{ space: 'restaurant', roles: ['manager', 'staff'] }, { space: 'shop', roles: ['staff'] }] })).statusCode).toBe(204);

    const awa = (await t.c.modules.accounts.findByPhone(`+221${phone}`))!;
    expect(await types({ userId: awa._id })).toContain('org.member_added');
    expect((await ok(call(owner, 'POST', `/org/${orgId}/members/lookup`, { phone }))).assignments).toEqual(
      expect.arrayContaining([{ space: 'restaurant', roles: ['manager', 'staff'] }, { space: 'shop', roles: ['staff'] }]),
    );
    const listed = (await ok(call(owner, 'GET', `/org/${orgId}/team`))).members;
    expect(listed[0]).toMatchObject({ owner: true });
    const row = listed.find((m: { userId: string }) => m.userId === awa._id.toHexString());
    expect(row.spaces.map((x: { label: string; roles: { label: string }[] }) => `${x.label}: ${x.roles.map((r) => r.label).join(', ')}`)).toEqual(['Restaurant: Gérant, Employé', 'Boutique: Employé']);
    // A member doesn't manage the team.
    expect((await call({ userId: awa._id }, 'GET', `/org/${orgId}/team`)).statusCode).toBe(404);

    // One role at a time: the shop's last role closes the shop for her.
    expect((await call(owner, 'DELETE', `/org/${orgId}/team/${awa._id}/restaurant/staff`)).statusCode).toBe(204);
    expect((await call(owner, 'DELETE', `/org/${orgId}/team/${awa._id}/shop/staff`)).statusCode).toBe(204);
    expect(await types({ userId: awa._id })).toContain('org.role_removed');
    expect((await call(owner, 'DELETE', `/org/${orgId}/team/${awa._id}/shop/staff`)).statusCode).toBe(404);
    const spaces = (await ok(call({ userId: awa._id }, 'GET', '/me'))).spaces.filter((x: { type: string }) => x.type === 'business');
    expect(spaces.map((x: { kind: string; roles: string[] }) => [x.kind, x.roles])).toEqual([['restaurant', ['manager']]]);

    // Edited by userId: the shop back, the restaurant taken away (no roles left there).
    expect((await put({ userId: awa._id.toHexString(), assignments: [{ space: 'restaurant', roles: [] }, { space: 'shop', roles: ['manager'] }] })).statusCode).toBe(204);
    expect((await ok(call(owner, 'GET', `/org/${orgId}/team`))).members.find((m: { userId: string }) => m.userId === awa._id.toHexString()).spaces.map((x: { space: string }) => x.space)).toEqual(['shop']);
    expect((await put({ userId: awa._id.toHexString(), assignments: [{ space: 'shop', roles: [] }] })).statusCode).toBe(400);

    // Out of the whole team at once.
    expect((await call(owner, 'DELETE', `/org/${orgId}/team/${awa._id}`)).statusCode).toBe(204);
    expect((await ok(call(owner, 'GET', `/org/${orgId}/team`))).members.some((m: { userId: string }) => m.userId === awa._id.toHexString())).toBe(false);
    expect((await call(owner, 'DELETE', `/org/${orgId}/team/${owner.userId}`)).statusCode).toBe(403);

    // The owner's roles aren't edited here.
    expect((await put({ userId: String(owner.userId), assignments: [{ space: 'shop', roles: ['staff'] }] })).statusCode).toBe(403);
    expect((await call(owner, 'DELETE', `/org/${orgId}/team/${owner.userId}/shop/owner`)).statusCode).toBe(403);
  });
});

describe('a team member becomes a student', () => {
  it('signs up with the same number: the account gets the student space, keeps its roles; a student number is still checked', async () => {
    const { orgId, owner } = await business('shop');
    const phone = nextPhone();
    expect((await call(owner, 'PUT', `/org/${orgId}/team`, { phone, firstName: 'Fatou', lastName: 'Sall', password: 'Campus2026', assignments: [{ space: 'shop', roles: ['staff'] }] })).statusCode).toBe(204);
    const before = (await t.c.modules.accounts.findByPhone(`+221${phone}`))!;

    // Step 1 says the number can be used, and that it completes an account.
    const check = json(await t.app.inject({ method: 'POST', url: '/api/v1/auth/register/check', payload: { phone, studentNumber: nextStudentNumber() } }));
    expect(check).toEqual({ available: true, existingAccount: true });

    const s = await registerStudent(t, { phone, firstName: 'Fatoumata', lastName: 'Sall', password: 'Etudiant2026' });
    expect(s.userId).toBe(before._id.toHexString());
    const me = await ok(call({ userId: s.userId }, 'GET', '/me'));
    expect(me.firstName).toBe('Fatoumata');
    expect(me.spaces.map((x: { type: string; kind: string | null; roles: string[] }) => [x.type, x.kind, x.roles])).toEqual(expect.arrayContaining([['student', null, expect.anything()], ['business', 'shop', ['staff']]]));
    // The new password is the one that works now.
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: phone, password: 'Campus2026' } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: phone, password: 'Etudiant2026' } })).statusCode).toBe(200);

    // Now a student: the number is taken for sign-up, as any student's.
    const again = json(await t.app.inject({ method: 'POST', url: '/api/v1/auth/register/check', payload: { phone, studentNumber: nextStudentNumber() } }));
    expect(again).toEqual({ available: false, conflict: 'phone' });
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/auth/otp', payload: { phone, purpose: 'register' } })).statusCode).toBe(409);
  });

  it('a student number already used is refused, and the account stays as it was', async () => {
    const taken = await registerStudent(t);
    const staff = await createStaff(t);
    await expect(registerStudent(t, { phone: staff.phone, studentNumber: taken.studentNumber })).rejects.toThrow(/409/);
    expect(await t.c.modules.accounts.hasStudentProfile(staff.userId)).toBe(false);
    expect((await t.c.modules.accounts.findById(staff.userId))!.firstName).toBe('Staff');
  });
});

describe('référencement', () => {
  it('editors update the businesses of their kind and their catalog; not the other kind', async () => {
    const { b, orgId, owner } = await business('shop');
    const shopEditor = await createStaff(t, ['shop_editor']);
    const restoEditor = await createStaff(t, ['restaurant_editor']);

    const placeEditor = await createStaff(t, ['place_editor']);
    // Each editor sees and edits what their roles give: places only, restaurants only, shops only.
    expect((await call(placeEditor, 'GET', '/admin/businesses')).statusCode).toBe(403);
    expect((await call(placeEditor, 'GET', `/admin/businesses/${b.id}`)).statusCode).toBe(403);
    expect((await ok(call(shopEditor, 'GET', '/admin/businesses'))).items.every((x: { kind: string }) => x.kind === 'shop')).toBe(true);
    expect((await ok(call(restoEditor, 'GET', '/admin/businesses'))).items.every((x: { kind: string }) => x.kind === 'restaurant')).toBe(true);
    expect((await call(restoEditor, 'GET', `/admin/businesses/${b.id}`)).statusCode).toBe(403);
    expect((await call(restoEditor, 'PATCH', `/admin/businesses/${b.id}`, { address: 'Ailleurs' })).statusCode).toBe(403);
    const updated = await ok(call(shopEditor, 'PATCH', `/admin/businesses/${b.id}`, { name: 'Papeterie UGB', address: 'Face au Village A', deliveryFees: { campus1: 0, campus2: null, outside: null } }));
    expect(updated).toMatchObject({ name: 'Papeterie UGB', address: 'Face au Village A', deliveryFees: { campus1: 0, campus2: null, outside: null } });
    expect((await ok(call(shopEditor, 'PATCH', `/admin/businesses/${b.id}`, { active: false }))).active).toBe(false);

    const cahier = await ok(call(shopEditor, 'POST', `/admin/businesses/${b.id}/catalog`, { section: 'article', category: 'Fournitures', name: 'Cahier 200 pages', price: 750, stock: 20 }), 201);
    expect((await call(shopEditor, 'POST', `/admin/businesses/${b.id}/catalog`, { section: 'menu', name: 'Yassa', price: 1500 })).statusCode).toBe(400);
    expect((await call(restoEditor, 'POST', `/admin/businesses/${b.id}/catalog`, { section: 'article', name: 'Stylo', price: 100 })).statusCode).toBe(403);
    expect((await ok(call(shopEditor, 'PATCH', `/admin/businesses/${b.id}/catalog/${cahier.id}`, { price: 800 }))).price).toBe(800);
    // Référencement isn't held to the owners' 6 photos per article.
    const editorId = new ObjectId(String(shopEditor.userId));
    const many = await Promise.all(Array.from({ length: 8 }, async () => (await t.c.modules.media.service.upload(editorId, 'business', await picture(), 'http://localhost/api/v1'))._id.toHexString()));
    expect((await ok(call(shopEditor, 'PATCH', `/admin/businesses/${b.id}/catalog/${cahier.id}`, { photoIds: many }))).photoIds).toEqual(many);
    expect((await ok(call(shopEditor, 'GET', '/reference/commerce'))).editorMaxItemPhotos).toBe(30);
    // 0 stays 0 (sold out), null stays null (no stock count): neither is coerced into the other.
    expect(await ok(call(shopEditor, 'PATCH', `/admin/businesses/${b.id}/catalog/${cahier.id}`, { stock: 0 }))).toMatchObject({ stock: 0, soldOut: true });
    expect((await ok(call(shopEditor, 'PATCH', `/admin/businesses/${b.id}/catalog/${cahier.id}`, { stock: null }))).stock).toBe(null);
    // The owner sees the same catalog in their space.
    expect((await ok(call(owner, 'GET', `/org/${orgId}/shop/catalog`))).items.map((i: { name: string; price: number }) => [i.name, i.price])).toEqual([['Cahier 200 pages', 800]]);
    expect((await call(shopEditor, 'DELETE', `/admin/businesses/${b.id}/catalog/${cahier.id}`)).statusCode).toBe(204);
    expect((await ok(call(shopEditor, 'GET', `/admin/businesses/${b.id}/catalog`))).items).toEqual([]);
  });
});

describe('référencement: who owns this number', () => {
  it('finds the account and the entities it owns, with what each runs, a student’s own shop too', async () => {
    const { orgId, owner } = await business('restaurant');
    const editor = await createStaff(t, ['shop_editor']);
    const phone = (await t.c.modules.accounts.findById(owner.userId))!.phone;
    expect(await ok(call(editor, 'POST', '/admin/businesses/owner-lookup', { phone }))).toEqual({
      account: { firstName: 'Modou', lastName: 'Khoulé' },
      entities: [{ orgId, name: 'Khoulé & Frère', personal: false, organizer: false, kinds: ['restaurant'], businesses: [{ id: expect.any(String), kind: 'restaurant', name: 'Khoulé & Frère' }] }],
    });
    expect(await ok(call(editor, 'POST', '/admin/businesses/owner-lookup', { phone: nextPhone() }))).toEqual({ account: null, entities: [] });

    const s = await registerStudent(t);
    await ok(call(s, 'POST', '/me/shop', { name: 'Tresses by Awa', specialties: ['Services'] }), 201);
    expect((await ok(call(editor, 'POST', '/admin/businesses/owner-lookup', { phone: s.phone }))).entities).toEqual([
      expect.objectContaining({ personal: true, kinds: ['shop'], businesses: [{ id: expect.any(String), kind: 'shop', name: 'Tresses by Awa' }] }),
    ]);
    expect((await call(s, 'POST', '/admin/businesses/owner-lookup', { phone })).statusCode).toBe(403);
  });

  it('one account, one entity: a shop for a number owning a restaurant joins its entity; never two restaurants', async () => {
    const { orgId, owner, admin } = await business('restaurant');
    const phone = (await t.c.modules.accounts.findById(owner.userId))!.phone;
    const shop = await ok(call(admin, 'POST', '/admin/businesses', { kind: 'shop', name: 'Khoulé Boutique', specialties: ['Épicerie'], owner: { phone, firstName: 'Modou', lastName: 'Khoulé' } }), 201);
    expect(shop.orgId).toBe(orgId);
    const again = await call(admin, 'POST', '/admin/businesses', { kind: 'restaurant', name: 'Khoulé Bis', specialties: ['Snacks'], owner: { phone, firstName: 'Modou', lastName: 'Khoulé' } });
    expect(again.statusCode).toBe(409);
    expect(json(again)).toMatchObject({ code: 'BUSINESS_EXISTS' });
    expect((await ok(call(owner, 'GET', '/me'))).spaces.filter((x: { type: string }) => x.type === 'business').map((x: { key: string }) => x.key)).toEqual([`restaurant:${orgId}`, `shop:${orgId}`]);
  });

  it('several specialties, from the list, 1 to 4', async () => {
    const { b, orgId, owner } = await business('restaurant');
    expect(b).toMatchObject({ specialties: ['Sénégalais'], specialty: 'Sénégalais' });
    const up = await ok(call(owner, 'PATCH', `/org/${orgId}/restaurant/business`, { specialties: ['Sénégalais', 'Grillades', 'Grillades'] }));
    expect(up).toMatchObject({ specialties: ['Sénégalais', 'Grillades'], specialty: 'Sénégalais · Grillades' });
    expect((await call(owner, 'PATCH', `/org/${orgId}/restaurant/business`, { specialties: ['Sénégalais', 'Papeterie'] })).statusCode).toBe(400);
    expect((await call(owner, 'PATCH', `/org/${orgId}/restaurant/business`, { specialties: [] })).statusCode).toBe(400);
    expect((await call(owner, 'PATCH', `/org/${orgId}/restaurant/business`, { specialties: ['Sénégalais', 'Grillades', 'Snacks', 'Africain', 'Végétarien'] })).statusCode).toBe(400);
    expect((await ok(call(owner, 'GET', '/reference/commerce'))).maxSpecialties).toBe(4);
  });
});

describe('student shops', () => {
  it('a student opens their own shop: its space, their articles in the market, orders paid to them', async () => {
    t.clock.set(T0);
    const s = await registerStudent(t);
    const shop = await ok(call(s, 'POST', '/me/shop', { name: 'Tresses by Awa', specialties: ['Services'], description: 'Tresses et nattes au Village H' }), 201);
    expect(shop).toMatchObject({ kind: 'shop', byStudent: true, specialties: ['Services'], deliveryFee: null });
    expect(json(await call(s, 'POST', '/me/shop', { name: 'Encore', specialties: ['Services'] })).code).toBe('SHOP_EXISTS');
    const me = await ok(call(s, 'GET', '/me'));
    expect(me.spaces.map((x: { key: string }) => x.key)).toEqual(['student', `shop:${shop.orgId}`]);
    // Its own space: the catalog.
    await ok(call(s, 'POST', `/org/${shop.orgId}/shop/catalog`, { section: 'article', category: 'Coiffure', name: 'Tresses africaines', price: 5000 }), 201);
    const buyer = await registerStudent(t);
    const market = await ok(call(buyer, 'GET', '/market?kind=shop'));
    expect(market.items.some((i: { name: string; businessId: string }) => i.name === 'Tresses africaines' && i.businessId === shop.id)).toBe(true);
    // Organizing an event later keeps the shop and opens the organizer space too.
    await t.c.modules.events.service.personalOrgOf(new ObjectId(s.userId), true);
    expect((await ok(call(s, 'GET', '/me'))).spaces.map((x: { type: string }) => x.type)).toEqual(['student', 'organizer', 'business']);
  });

  it('only students open a shop this way', async () => {
    const staff = await createStaff(t);
    expect((await call(staff, 'POST', '/me/shop', { name: 'Pas étudiant', specialties: ['Services'] })).statusCode).toBe(403);
  });
});

describe('article photos', () => {
  it('an article has several photos, the cover first; dropped ones leave the storage; older apps still send one', async () => {
    const { owner, orgId, sp } = await business('shop');
    const ownerId = new ObjectId(String(owner.userId));
    const upload = async () => (await t.c.modules.media.service.upload(ownerId, 'business', await picture(), 'http://localhost/api/v1'))._id.toHexString();
    const [a, b2, c] = [await upload(), await upload(), await upload()];

    const bag = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'article', name: 'Sac à dos', price: 9000, photoIds: [a, b2, c] }), 201);
    expect(bag.photoIds).toEqual([a, b2, c]);
    expect(bag.photos).toHaveLength(3);
    expect(bag.photo).toBe(bag.photos[0]);

    // c becomes the cover, b2 is dropped: its file goes.
    const edited = await ok(call(owner, 'PATCH', `/org/${orgId}/${sp}/catalog/${bag.id}`, { photoIds: [c, a] }));
    expect(edited.photoIds).toEqual([c, a]);
    expect(edited.photo).toBe(bag.photos[2]);
    expect(await t.c.mongo.db.collection('media').countDocuments({ _id: new ObjectId(b2) })).toBe(0);
    expect(await t.c.mongo.db.collection('media').countDocuments({ _id: new ObjectId(a) })).toBe(1);

    const seven = await Promise.all(Array.from({ length: 7 }, () => upload()));
    expect((await call(owner, 'PATCH', `/org/${orgId}/${sp}/catalog/${bag.id}`, { photoIds: seven })).statusCode).toBe(400);
    const stranger = await registerStudent(t);
    const theirs = (await t.c.modules.media.service.upload(new ObjectId(stranger.userId), 'business', await picture(), 'http://localhost/api/v1'))._id.toHexString();
    expect((await call(owner, 'PATCH', `/org/${orgId}/${sp}/catalog/${bag.id}`, { photoIds: [theirs] })).statusCode).toBe(400);

    // An older app: one picture.
    const one = await ok(call(owner, 'PATCH', `/org/${orgId}/${sp}/catalog/${bag.id}`, { photoId: a }));
    expect(one.photoIds).toEqual([a]);
    expect((await ok(call(owner, 'PATCH', `/org/${orgId}/${sp}/catalog/${bag.id}`, { photoId: null }))).photos).toEqual([]);
  });
});

describe('student shops and owners', () => {
  it('a student shop takes cash only until the team verifies it', async () => {
    const s = await registerStudent(t);
    const shop = await ok(call(s, 'POST', '/me/shop', { name: 'Tresses de Awa', specialties: ['Services'] }), 201);
    expect(shop).toMatchObject({ onlinePayments: false, paymentMethods: [{ value: 'cash', label: 'Espèces' }] });
    expect(json(await call(s, 'PATCH', `/org/${shop.orgId}/shop/business`, { paymentMethods: ['cash', 'wave'] }))).toMatchObject({ code: 'ONLINE_PAYMENTS_LOCKED' });

    // Verified by the team: Wave and Orange Money open; closed again, they go and cash stays.
    const admin = await createStaff(t, ['admin']);
    expect((await ok(call(admin, 'PATCH', `/admin/businesses/${shop.id}`, { onlinePayments: true }))).onlinePayments).toBe(true);
    const paid = await ok(call(s, 'PATCH', `/org/${shop.orgId}/shop/business`, { paymentMethods: ['wave'] }));
    expect(paid.paymentMethods).toEqual([{ value: 'wave', label: 'Wave' }]);
    const closed = await ok(call(admin, 'PATCH', `/admin/businesses/${shop.id}`, { onlinePayments: false }));
    expect(closed).toMatchObject({ onlinePayments: false, paymentMethods: [{ value: 'cash', label: 'Espèces' }] });
  });

  it('an owner sees their own business as editable and cannot order from it', async () => {
    const { b, owner, orgId, sp } = await business('restaurant', { paymentMethods: ['cash'] });
    const mafe = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'menu', name: 'Mafé yap', price: 1500 }), 201);
    expect((await ok(call(owner, 'GET', `/businesses/${b.id}`))).viewer).toEqual({ member: true, canEdit: true });
    const refused = await call(owner, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 1 }], mode: 'pickup', method: 'cash' });
    expect(refused.statusCode).toBe(422);
    expect(json(refused).code).toBe('OWN_BUSINESS');

    const s = await registerStudent(t);
    expect((await ok(call(s, 'GET', `/businesses/${b.id}`))).viewer).toEqual({ member: false, canEdit: false });
    await ok(call(s, 'POST', `/businesses/${b.id}/orders`, { lines: [{ itemId: mafe.id, qty: 1 }], mode: 'pickup', method: 'cash' }), 201);
  });
});


describe('likes', () => {
  it('a student likes an article once, sees it everywhere, takes it back; its own team cannot', async () => {
    const { b, owner, orgId, sp } = await business('shop');
    const cahier = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'article', name: 'Cahier', price: 300 }), 201);
    expect(cahier).toMatchObject({ likes: 0, liked: false });
    const s = await registerStudent(t);
    const other = await registerStudent(t);

    expect(await ok(call(s, 'PUT', `/items/${cahier.id}/like`))).toEqual({ liked: true, likes: 1 });
    // Twice counts once.
    expect(await ok(call(s, 'PUT', `/items/${cahier.id}/like`))).toEqual({ liked: true, likes: 1 });
    expect(await ok(call(other, 'PUT', `/items/${cahier.id}/like`))).toEqual({ liked: true, likes: 2 });

    const mine = (items: { id: string }[]) => items.find((i) => i.id === cahier.id);
    expect(mine((await ok(call(s, 'GET', `/businesses/${b.id}`))).items)).toMatchObject({ likes: 2, liked: true });
    expect(mine((await ok(call(s, 'GET', '/market?kind=shop'))).items)).toMatchObject({ likes: 2, liked: true });
    expect(mine((await ok(call(owner, 'GET', `/businesses/${b.id}`))).items)).toMatchObject({ likes: 2, liked: false });

    expect(await ok(call(s, 'DELETE', `/items/${cahier.id}/like`))).toEqual({ liked: false, likes: 1 });
    expect(await ok(call(s, 'DELETE', `/items/${cahier.id}/like`))).toEqual({ liked: false, likes: 1 });
    expect(mine((await ok(call(s, 'GET', '/market?kind=shop'))).items)).toMatchObject({ likes: 1, liked: false });

    expect(json(await call(owner, 'PUT', `/items/${cahier.id}/like`)).code).toBe('OWN_BUSINESS');
    expect((await call(s, 'PUT', `/items/${new ObjectId().toHexString()}/like`)).statusCode).toBe(404);
    expect((await ok(call(s, 'GET', `/businesses/${b.id}`))).itemLikes).toBe(true);
  });

  it('a restaurant’s dishes have no heart', async () => {
    const r = await business('restaurant');
    const mafe = await ok(call(r.owner, 'POST', `/org/${r.orgId}/${r.sp}/catalog`, { section: 'menu', name: 'Mafé yap', price: 1500 }), 201);
    const s = await registerStudent(t);
    expect((await ok(call(s, 'GET', `/businesses/${r.b.id}`))).itemLikes).toBe(false);
    expect(json(await call(s, 'PUT', `/items/${mafe.id}/like`)).code).toBe('NOT_LIKEABLE');
  });
});

describe('mes ventes', () => {
  it('totals completed orders for a period: by method, by day, best sellers, what is still owed; the rest apart; managers only', async () => {
    const { b, owner, orgId, sp } = await business('restaurant');
    await ok(call(owner, 'PATCH', `/org/${orgId}/${sp}/business`, { paymentMethods: ['cash', 'wave'] }));
    const staff = await createStaff(t);
    await call(owner, 'PUT', `/org/${orgId}/${sp}/members`, { phone: staff.phone, roles: ['staff'] });
    const mafe = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'menu', name: 'Mafé yap', price: 1500 }), 201);
    const bissap = await ok(call(owner, 'POST', `/org/${orgId}/${sp}/catalog`, { section: 'drink', name: 'Bissap', price: 300 }), 201);
    const s = await registerStudent(t);
    const order = (lines: { itemId: string; qty: number }[], method: 'cash' | 'wave') => ok(call(s, 'POST', `/businesses/${b.id}/orders`, { lines, mode: 'pickup', method }), 201);
    const serve = async (id: string) => {
      for (const step of ['accept', 'ready', 'complete']) await ok(call(owner, 'POST', `/org/${orgId}/${sp}/orders/${id}/${step}`));
    };

    // 31 Oct: two sales (cash, Wave), one refused, one still being served.
    const cash = await order([{ itemId: mafe.id, qty: 2 }], 'cash');
    await serve(cash.order.id);
    const wave = await order([{ itemId: mafe.id, qty: 1 }], 'wave');
    await pay(wave.payment.reference);
    await serve(wave.order.id);
    const refused = await order([{ itemId: bissap.id, qty: 4 }], 'cash');
    await ok(call(owner, 'POST', `/org/${orgId}/${sp}/orders/${refused.order.id}/refuse`, { reason: 'Plus de bissap.' }));
    await order([{ itemId: bissap.id, qty: 1 }], 'cash');
    // 1 Nov: one more.
    t.clock.set(T0 + 24 * 3600_000);
    const next = await order([{ itemId: bissap.id, qty: 1 }], 'cash');
    await serve(next.order.id);

    const sales = await ok(call(owner, 'GET', `/org/${orgId}/${sp}/sales?from=2026-10-31&to=2026-11-01`));
    expect(sales).toMatchObject({
      from: '2026-10-31', to: '2026-11-01', revenue: 4800, orders: 3, average: 1600,
      methods: [{ method: 'cash', label: 'Espèces', amount: 3300, orders: 2 }, { method: 'wave', label: 'Wave', amount: 1500, orders: 1 }],
      days: [{ date: '2026-10-31', revenue: 4500, orders: 2 }, { date: '2026-11-01', revenue: 300, orders: 1 }],
      inProgress: 1, refused: 1, cancelled: 0,
    });
    expect(sales.top[0]).toEqual({ itemId: mafe.id, name: 'Mafé yap', qty: 3, revenue: 4500 });
    // The Wave sale is paid out to the owner's number: owed until it arrives.
    const payout = await t.c.mongo.db.collection('payouts').findOne({ _id: (await t.c.mongo.db.collection('commerceOrders').findOne({ _id: new ObjectId(wave.order.id) }))!.payoutId });
    expect(sales.owed).toBe(payout!.status === 'succeeded' ? 0 : 1500);

    // One day only, and a day with nothing.
    expect(await ok(call(owner, 'GET', `/org/${orgId}/${sp}/sales?from=2026-11-01&to=2026-11-01`))).toMatchObject({ revenue: 300, orders: 1, days: [{ date: '2026-11-01', revenue: 300 }] });
    expect(await ok(call(owner, 'GET', `/org/${orgId}/${sp}/sales?from=2026-10-01&to=2026-10-01`))).toMatchObject({ revenue: 0, orders: 0, average: 0, methods: [], top: [] });
    // Bad periods, and the staff (they serve, they don't see the money).
    expect((await call(owner, 'GET', `/org/${orgId}/${sp}/sales?from=2026-11-02&to=2026-11-01`)).statusCode).toBe(400);
    expect((await call(owner, 'GET', `/org/${orgId}/${sp}/sales?from=2025-01-01&to=2026-11-01`)).statusCode).toBe(400);
    expect((await call(owner, 'GET', `/org/${orgId}/${sp}/sales?from=31-10-2026&to=2026-11-01`)).statusCode).toBe(400);
    // Not found for them, like the other managers-only pages.
    expect((await call(staff, 'GET', `/org/${orgId}/${sp}/sales?from=2026-10-31&to=2026-11-01`)).statusCode).toBe(404);
  });
});

describe('payout numbers', () => {
  it('each provider accepted pays out to its own number, which only the owner and Référencement see', async () => {
    const { b, owner, orgId, admin, sp } = await business('restaurant');
    const mine = await ok(call(owner, 'PATCH', `/org/${orgId}/${sp}/business`, { paymentMethods: ['cash', 'wave', 'orange_money'], payoutNumbers: { wave: '77 111 22 33', orange_money: '781112233' } }));
    expect(mine.payoutNumbers).toEqual({ wave: '+221771112233', orange_money: '+221781112233' });
    expect((await ok(call(admin, 'GET', `/admin/businesses/${b.id}`))).payoutNumbers).toEqual({ wave: '+221771112233', orange_money: '+221781112233' });
    // Never in what students get.
    const s = await registerStudent(t);
    expect((await ok(call(s, 'GET', `/businesses/${b.id}`))).payoutNumbers).toBeUndefined();
    // Each order is paid out to the number of the provider it was paid with.
    expect(await t.c.modules.organizations.payoutPhone(new ObjectId(orgId), 'wave')).toBe('+221771112233');
    expect(await t.c.modules.organizations.payoutPhone(new ObjectId(orgId), 'orange_money')).toBe('+221781112233');
    // A number that isn't one: refused, nothing changed.
    expect((await call(owner, 'PATCH', `/org/${orgId}/${sp}/business`, { payoutNumbers: { wave: '12' } })).statusCode).toBe(400);
    expect((await ok(call(owner, 'GET', `/org/${orgId}/${sp}/business`))).payoutNumbers.wave).toBe('+221771112233');
    // Taken off: back to the organization's number (the owner's, at creation).
    const back = await ok(call(admin, 'PATCH', `/admin/businesses/${b.id}`, { payoutNumbers: { orange_money: null } }));
    expect(back.payoutNumbers.orange_money).toMatch(/^\+221\d{9}$/);
    expect(back.payoutNumbers.orange_money).not.toBe('+221781112233');
    expect(back.payoutNumbers.wave).toBe('+221771112233');
  });
});
