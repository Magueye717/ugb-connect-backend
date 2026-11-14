import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, registerStudent, type TestApp } from '../../../../test/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

type Who = { userId: string };
async function call(who: Who, method: 'GET' | 'POST', url: string, payload?: object) {
  const { accessToken } = await t.c.modules.identity.startSession({ _id: new ObjectId(who.userId), platformRoles: [] });
  return t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(accessToken), payload });
}
const ok = async (res: Promise<{ statusCode: number; body: string }>, status = 200) => {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return json(r);
};
const student = async () => ({ userId: String((await registerStudent(t)).userId) });
const notes = (userId: string) => t.c.mongo.db.collection('notifications').find({ userId: new ObjectId(userId), type: { $regex: '^housing' } }).toArray();

describe('housing', () => {
  it('two room swaps that fit are told to each other, and shown « Échange possible »', async () => {
    const awa = await student();
    const bob = await student();
    const a = await ok(call(awa, 'POST', '/housing/ads', { kind: 'swap', village: 'Village E', room: 'b 12', wants: ['Village A', 'Village C'], for: 'girls' }), 201);
    expect(a).toMatchObject({ kind: 'swap', village: 'Village E', room: 'B 12', mine: true, match: false });
    const b = await ok(call(bob, 'POST', '/housing/ads', { kind: 'swap', village: 'Village A', room: '7', wants: ['Village E'] }), 201);
    // Both told at once.
    expect((await notes(awa.userId)).map((n) => n.type)).toContain('housing.swap_match');
    expect((await notes(bob.userId)).map((n) => n.type)).toContain('housing.swap_match');
    const board = (await ok(call(awa, 'GET', '/housing/ads'))).items;
    expect(board.find((x: { id: string }) => x.id === b.id).match).toBe(true);
    // Refused: wanting one's own village, an unknown village, a swap without room.
    const cid = await student();
    expect(json(await call(cid, 'POST', '/housing/ads', { kind: 'swap', village: 'Village A', room: '7', wants: ['Village A'] })).field).toBe('wants');
    expect(json(await call(cid, 'POST', '/housing/ads', { kind: 'swap', village: 'Village Z', room: '7', wants: ['Village E'] })).field).toBe('village');
    expect(json(await call(cid, 'POST', '/housing/ads', { kind: 'swap', village: 'Village A', wants: ['Village E'] })).field).toBe('room');
  });

  it('writing to an author opens one private chat; « Trouvé ! » closes the ad and its chats', async () => {
    const host = await student();
    const newcomer = await student();
    const ad = await ok(call(host, 'POST', '/housing/ads', { kind: 'host_offer', village: 'Village H', from: new Date(Date.now() + 86_400_000).toISOString(), to: new Date(Date.now() + 10 * 86_400_000).toISOString(), note: 'Deux semaines, le temps que tu trouves.' }), 201);
    expect(Date.parse(ad.expiresAt)).toBeLessThan(Date.now() + 12 * 86_400_000);
    const c = await ok(call(newcomer, 'POST', `/housing/ads/${ad.id}/contact`));
    expect(c).toMatchObject({ with: expect.any(String), conversationId: expect.any(String) });
    // Same chat the second time; never with oneself.
    expect((await ok(call(newcomer, 'POST', `/housing/ads/${ad.id}/contact`))).id).toBe(c.id);
    expect(json(await call(host, 'POST', `/housing/ads/${ad.id}/contact`)).code).toBe('HOUSING_OWN_AD');
    expect((await notes(host.userId)).map((n) => n.type)).toContain('housing.contact');
    const detail = await ok(call(host, 'GET', `/housing/ads/${ad.id}`));
    expect(detail.conversations).toHaveLength(1);
    expect(detail.contactIds).toEqual([c.id]);
    // Only its author closes it.
    expect((await call(newcomer, 'POST', `/housing/ads/${ad.id}/close`)).statusCode).toBe(403);
    expect((await ok(call(host, 'POST', `/housing/ads/${ad.id}/close`))).state).toBe('closed');
    expect((await ok(call(newcomer, 'GET', '/housing/ads'))).items.some((x: { id: string }) => x.id === ad.id)).toBe(false);
    expect(json(await call(await student(), 'POST', `/housing/ads/${ad.id}/contact`)).code).toBe('HOUSING_CLOSED');
  });

  it('one ad of each kind, three at most; reported by three students: off the board', async () => {
    const s = await student();
    const ads: { id: string }[] = [];
    ads.push(await ok(call(s, 'POST', '/housing/ads', { kind: 'roommate', area: 'Sanar', rent: 15000, places: 1 }), 201));
    expect(json(await call(s, 'POST', '/housing/ads', { kind: 'roommate', area: 'Sor' })).code).toBe('HOUSING_SAME_KIND');
    ads.push(await ok(call(s, 'POST', '/housing/ads', { kind: 'host_need' }), 201));
    ads.push(await ok(call(s, 'POST', '/housing/ads', { kind: 'host_offer', area: 'Sanar' }), 201));
    expect(json(await call(s, 'POST', '/housing/ads', { kind: 'swap', village: 'Village B', room: '3', wants: ['Village C'] })).code).toBe('HOUSING_TOO_MANY');
    // Closed: the same kind can be posted again.
    await ok(call(s, 'POST', `/housing/ads/${ads[1]!.id}/close`));
    await ok(call(s, 'POST', '/housing/ads', { kind: 'host_need', village: 'Village H' }), 201);
    for (let i = 0; i < 3; i++) expect((await call(await student(), 'POST', `/housing/ads/${ads[0]!.id}/report`)).statusCode).toBe(204);
    const viewer = await student();
    expect((await ok(call(viewer, 'GET', '/housing/ads'))).items.some((x: { id: string }) => x.id === ads[0]!.id)).toBe(false);
    expect((await call(viewer, 'GET', `/housing/ads/${ads[0]!.id}`)).statusCode).toBe(404);
  });

  it('reported ads reach the team: kept (back on the board) or removed (author told)', async () => {
    const admin = { userId: (await createStaff(t, ['admin'])).userId.toHexString() };
    const a = await student();
    const b = await student();
    const adA = await ok(call(a, 'POST', '/housing/ads', { kind: 'roommate', area: 'Sanar', rent: 15000, places: 1 }), 201);
    const adB = await ok(call(b, 'POST', '/housing/ads', { kind: 'host_need' }), 201);
    for (let i = 0; i < 3; i++) await call(await student(), 'POST', `/housing/ads/${adA.id}/report`);
    await call(await student(), 'POST', `/housing/ads/${adB.id}/report`);
    // Students can't read the list.
    expect((await call(a, 'GET', '/admin/housing/reports')).statusCode).toBe(403);
    const list = (await ok(call(admin, 'GET', '/admin/housing/reports'))).items as { id: string; reports: number; state: string }[];
    expect(list.find((x) => x.id === adA.id)).toMatchObject({ reports: 3, state: 'hidden' });
    expect(list.find((x) => x.id === adB.id)).toMatchObject({ reports: 1, state: 'open' });

    expect((await call(admin, 'POST', `/admin/housing/ads/${adA.id}/keep`)).statusCode).toBe(204);
    expect((await ok(call(await student(), 'GET', `/housing/ads/${adA.id}`))).state).toBe('open');
    expect((await call(admin, 'POST', `/admin/housing/ads/${adB.id}/remove`)).statusCode).toBe(204);
    const left = (await ok(call(admin, 'GET', '/admin/housing/reports'))).items as { id: string }[];
    expect(left.some((x) => x.id === adA.id || x.id === adB.id)).toBe(false);
    expect((await notes(b.userId)).map((n) => n.type)).toContain('housing.removed');
  });
});
