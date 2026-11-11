import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, nextPhone, registerStudent, type TestApp } from '../../../../test/harness.js';

let t: TestApp;
let admin: Awaited<ReturnType<typeof createStaff>>;
beforeAll(async () => {
  t = await createTestApp();
  admin = await createStaff(t, ['admin']);
});
afterAll(async () => {
  await t.close();
});

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token: string, payload?: object) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(token), payload });

let slugSeq = 0;
async function createOrg() {
  const res = await call('POST', '/admin/organizations', admin.tokens.accessToken, { slug: `org-${++slugSeq}`, name: `Transport ${slugSeq}`, category: 'Transporteur', capabilities: ['caravans'] });
  expect(res.statusCode).toBe(201);
  return json(res).id as string;
}

describe('admin back office', () => {
  it('is closed to students and to anonymous callers', async () => {
    const s = await registerStudent(t);
    expect((await call('GET', '/admin/organizations', s.tokens.accessToken)).statusCode).toBe(403);
    expect((await t.app.inject({ url: '/api/v1/admin/organizations' })).statusCode).toBe(401);
  });

  it('a revoked platform role stops working on the next request', async () => {
    const other = await createStaff(t, ['admin']);
    expect((await call('GET', '/admin/organizations', other.tokens.accessToken)).statusCode).toBe(200);
    await call('PUT', `/admin/users/${other.userId.toHexString()}/platform-roles`, admin.tokens.accessToken, { roles: [] });
    expect((await call('GET', '/admin/organizations', other.tokens.accessToken)).statusCode).toBe(403);
  });
});

const types = (me: { spaces: { type: string }[] }) => me.spaces.map((x) => x.type);

describe('spaces and organizer roles', () => {
  it('a student who is made organizer gets both spaces in /me', async () => {
    const s = await registerStudent(t);
    const orgId = await createOrg();
    expect(types(json(await call('GET', '/me', s.tokens.accessToken)))).toEqual(['student']);
    expect((await call('PUT', `/admin/organizations/${orgId}/members`, admin.tokens.accessToken, { phone: s.phone, roles: ['owner'] })).statusCode).toBe(204);
    const me = json(await call('GET', '/me', s.tokens.accessToken));
    expect(types(me)).toEqual(['student', 'organizer']);
    expect(me.spaces[1]).toMatchObject({ key: `organizer:${orgId}`, orgId, roles: ['owner'] });
    expect(me.organizations[0]).toMatchObject({ id: orgId, roles: ['owner'] });
  });

  it('an organizer-only account has no student space and cannot use student routes', async () => {
    const staff = await createStaff(t);
    const orgId = await createOrg();
    await call('PUT', `/admin/organizations/${orgId}/members`, admin.tokens.accessToken, { phone: staff.phone, roles: ['scanner'], space: 'organizer' });
    expect(types(json(await call('GET', '/me', staff.tokens.accessToken)))).toEqual(['organizer']);
    expect((await call('PATCH', '/me/student-profile', staff.tokens.accessToken, { onCampus: false })).statusCode).toBe(403);
  });

  it('another organization’s space answers 404, not 403', async () => {
    const owner = await registerStudent(t);
    const mine = await createOrg();
    const theirs = await createOrg();
    await call('PUT', `/admin/organizations/${mine}/members`, admin.tokens.accessToken, { phone: owner.phone, roles: ['owner'] });
    expect((await call('GET', `/org/${mine}`, owner.tokens.accessToken)).statusCode).toBe(200);
    expect((await call('GET', `/org/${theirs}`, owner.tokens.accessToken)).statusCode).toBe(404);
    expect((await call('GET', `/org/${theirs}/organizer/members`, owner.tokens.accessToken)).statusCode).toBe(404);
  });

  it('owners manage their team but cannot appoint owners; scanners cannot manage the team', async () => {
    const owner = await registerStudent(t);
    const scanner = await registerStudent(t);
    const orgId = await createOrg();
    await call('PUT', `/admin/organizations/${orgId}/members`, admin.tokens.accessToken, { phone: owner.phone, roles: ['owner'] });

    expect((await call('PUT', `/org/${orgId}/organizer/members`, owner.tokens.accessToken, { phone: scanner.phone, roles: ['owner'] })).statusCode).toBe(403);
    expect((await call('PUT', `/org/${orgId}/organizer/members`, owner.tokens.accessToken, { phone: scanner.phone, roles: ['scanner'] })).statusCode).toBe(204);
    expect((await call('GET', `/org/${orgId}`, scanner.tokens.accessToken)).statusCode).toBe(200);
    expect((await call('GET', `/org/${orgId}/organizer/members`, scanner.tokens.accessToken)).statusCode).toBe(404);

    const members = json(await call('GET', `/org/${orgId}/organizer/members`, owner.tokens.accessToken));
    expect(members.items).toHaveLength(2);
    expect(members.items[0]).not.toHaveProperty('phone');
    expect(members.roles).toEqual([{ value: 'manager', label: 'Gérant' }, { value: 'scanner', label: 'Contrôleur' }]);

    await call('DELETE', `/org/${orgId}/organizer/members/${scanner.userId}`, owner.tokens.accessToken);
    expect((await call('GET', `/org/${orgId}`, scanner.tokens.accessToken)).statusCode).toBe(404);
  });

  it('suspending an organization closes its space for every member', async () => {
    const owner = await registerStudent(t);
    const orgId = await createOrg();
    await call('PUT', `/admin/organizations/${orgId}/members`, admin.tokens.accessToken, { phone: owner.phone, roles: ['owner'] });
    await call('PATCH', `/admin/organizations/${orgId}`, admin.tokens.accessToken, { status: 'suspended' });
    expect((await call('GET', `/org/${orgId}`, owner.tokens.accessToken)).statusCode).toBe(404);
    expect(types(json(await call('GET', '/me', owner.tokens.accessToken)))).toEqual(['student']);
  });

  it('stores the category, the contact e-mail and an empty logo; the owner can update the e-mail', async () => {
    const created = await call('POST', '/admin/organizations', admin.tokens.accessToken, {
      slug: 'resto-fatou', name: 'Chez Fatou', category: 'Restaurant', capabilities: ['restaurant'], email: ' Contact@ChezFatou.SN ',
    });
    expect(created.statusCode).toBe(201);
    const org = json(created);
    expect(org).toMatchObject({ category: 'Restaurant', email: 'contact@chezfatou.sn', logoUrl: null });
    expect(org).not.toHaveProperty('kind');

    const owner = await registerStudent(t);
    const outsider = await registerStudent(t);
    await call('PUT', `/admin/organizations/${org.id}/members`, admin.tokens.accessToken, { phone: owner.phone, roles: ['owner'] });

    const patched = await call('PATCH', `/org/${org.id}`, owner.tokens.accessToken, { email: 'commandes@chezfatou.sn' });
    expect(patched.statusCode).toBe(200);
    expect(json(patched).email).toBe('commandes@chezfatou.sn');
    expect((await call('PATCH', `/org/${org.id}`, owner.tokens.accessToken, { email: 'pas-une-adresse' })).statusCode).toBe(400);
    expect((await call('PATCH', `/org/${org.id}`, outsider.tokens.accessToken, { email: 'x@y.sn' })).statusCode).toBe(404);

    // The admin can remove it.
    expect(json(await call('PATCH', `/admin/organizations/${org.id}`, admin.tokens.accessToken, { email: null })).email).toBeNull();
  });

  it('refuses the old "kind" field and unknown categories', async () => {
    const legacy = await call('POST', '/admin/organizations', admin.tokens.accessToken, { slug: 'old-api', name: 'Old API', kind: 'Entreprise', capabilities: ['caravans'] });
    expect(legacy.statusCode).toBe(400);
    const unknown = await call('POST', '/admin/organizations', admin.tokens.accessToken, { slug: 'bad-cat', name: 'Bad', category: 'Banque', capabilities: ['caravans'] });
    expect(unknown.statusCode).toBe(400);
  });

  it('audits membership changes', async () => {
    const s = await registerStudent(t);
    const orgId = await createOrg();
    await call('PUT', `/admin/organizations/${orgId}/members`, admin.tokens.accessToken, { phone: s.phone, roles: ['manager'], space: 'organizer' });
    const entry = await t.c.mongo.db.collection('auditLogs').findOne({ action: 'membership.set', 'target.id': orgId });
    expect(entry?.actor).toMatchObject({ type: 'user', id: admin.userId.toHexString() });
  });
});

describe('Référencement: caravan organizers', () => {
  it('a caravan editor registers an organizer and its owner, who gets the organizer space; others are refused', async () => {
    const editor = await createStaff(t, ['caravan_editor']);
    const shopEditor = await createStaff(t, ['shop_editor']);
    const tok = editor.tokens.accessToken;
    expect((await call('GET', '/admin/caravan-organizers', shopEditor.tokens.accessToken)).statusCode).toBe(403);

    const phone = nextPhone();
    expect(json(await call('POST', '/admin/caravan-organizers/owner-lookup', tok, { phone }))).toEqual({ account: null, organizer: null });
    // A new number: the name is needed to create the account.
    expect((await call('POST', '/admin/caravan-organizers', tok, { name: 'Ndiambour Voyages', category: 'Transporteur', owner: { phone } })).statusCode).toBe(400);
    const res = await call('POST', '/admin/caravan-organizers', tok, { name: 'Ndiambour Voyages', category: 'Transporteur', owner: { phone, firstName: 'Ibrahima', lastName: 'Fall' } });
    expect(res.statusCode).toBe(201);
    const org = json(res);
    // No badge given: it starts « Nouveau » and earns its badge with the trips.
    expect(org).toMatchObject({ name: 'Ndiambour Voyages', category: 'Transporteur', capabilities: ['caravans'], level: 'nouveau', levelGiven: 'nouveau', hasPayoutAccount: true, owner: { firstName: 'Ibrahima', lastName: 'Fall' } });
    expect(json(await call('GET', '/admin/caravan-organizers', tok)).items.map((x: { id: string }) => x.id)).toContain(org.id);
    for (let i = 0; i < 5; i++) await t.c.modules.organizations.countTrip(new ObjectId(org.id));
    const earned = json(await call('GET', '/admin/caravan-organizers', tok)).items.find((x: { id: string }) => x.id === org.id);
    expect(earned).toMatchObject({ trips: 5, level: 'verifie', levelGiven: 'nouveau' });

    // Same number again: it already runs caravans.
    expect(json(await call('POST', '/admin/caravan-organizers', tok, { name: 'Autre', category: 'Entreprise', owner: { phone } })).code).toBe('ALREADY_ORGANIZER');
    expect(json(await call('POST', '/admin/caravan-organizers/owner-lookup', tok, { phone }))).toMatchObject({ account: { firstName: 'Ibrahima' }, organizer: { name: 'Ndiambour Voyages' } });

    const edited = json(await call('PATCH', `/admin/caravan-organizers/${org.id}`, tok, { name: 'Ndiambour Voyages SA', category: 'Entreprise', level: 'confirme' }));
    expect(edited).toMatchObject({ name: 'Ndiambour Voyages SA', category: 'Entreprise', level: 'confirme' });
  });

  it('a caravan organizer is its own organization: never joined to the shop its owner runs, and a shop never joins it', async () => {
    const editor = await createStaff(t, ['caravan_editor', 'shop_editor']);
    const tok = editor.tokens.accessToken;
    const phone = nextPhone();
    const shop = await call('POST', '/admin/businesses', tok, {
      kind: 'shop', name: 'Papeterie du Campus', specialties: ['Fournitures'], owner: { phone, firstName: 'Awa', lastName: 'Sarr' },
    });
    expect(shop.statusCode).toBe(201);
    expect(json(await call('POST', '/admin/caravan-organizers/owner-lookup', tok, { phone }))).toEqual({ account: { firstName: 'Awa', lastName: 'Sarr' }, organizer: null });
    const org = json(await call('POST', '/admin/caravan-organizers', tok, { name: 'Sarr Voyages', category: 'Transporteur', owner: { phone } }));
    expect(org).toMatchObject({ name: 'Sarr Voyages', capabilities: ['caravans'] });
    expect(org.id).not.toBe(json(shop).orgId);
    // The shop side doesn't see the caravan organizer as an entity to join.
    const lookup = json(await call('POST', '/admin/businesses/owner-lookup', tok, { phone }));
    expect(lookup.entities.map((e: { name: string }) => e.name)).not.toContain('Sarr Voyages');
  });
});
