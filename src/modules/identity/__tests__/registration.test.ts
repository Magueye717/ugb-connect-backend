import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createTestApp, json, nextPhone, nextStudentNumber, registerStudent, type TestApp } from '../../../../test/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const post = (url: string, payload: object) => t.app.inject({ method: 'POST', url: `/api/v1${url}`, payload });

async function verified(phone: string, purpose: 'register' | 'reset_password' = 'register') {
  const { challengeId } = json(await post('/auth/otp', { phone, purpose }));
  return json(await post(`/auth/otp/${challengeId}/verify`, { code: '1234' })).verificationToken as string;
}

const profile = (over: object = {}) => ({
  studentNumber: nextStudentNumber(), firstName: 'Fatou', lastName: 'Ndiaye', campus: 'campus2', onCampus: true,
  village: 'Village H', room: 'C12', ufr: 'SEG', region: 'Ziguinchor', password: 'Bonjour2026', termsVersion: '2026-01', ...over,
});

describe('sign-up', () => {
  it('step 1 tells whether the phone or the student number already has an account', async () => {
    const s = await registerStudent(t);
    expect(json(await post('/auth/register/check', { phone: s.phone, studentNumber: 'P999998' }))).toEqual({ available: false, conflict: 'phone' });
    expect(json(await post('/auth/register/check', { phone: nextPhone(), studentNumber: s.studentNumber }))).toEqual({ available: false, conflict: 'student_number' });
    expect(json(await post('/auth/register/check', { phone: nextPhone(), studentNumber: 'P999997' }))).toEqual({ available: true });
  });

  it('rejects numbers that are not Senegalese mobiles', async () => {
    const res = await post('/auth/otp', { phone: '331234567', purpose: 'register' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an OTP for registration when the phone already has an account', async () => {
    const s = await registerStudent(t);
    const res = await post('/auth/otp', { phone: s.phone, purpose: 'register' });
    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe('PHONE_TAKEN');
  });

  it('counts wrong codes and locks the challenge after 5 attempts', async () => {
    const { challengeId } = json(await post('/auth/otp', { phone: nextPhone(), purpose: 'register' }));
    for (let left = 4; left >= 1; left--) {
      const res = await post(`/auth/otp/${challengeId}/verify`, { code: '9999' });
      expect(res.statusCode).toBe(400);
      expect(json(res)).toMatchObject({ code: 'OTP_INVALID', attemptsLeft: left });
    }
    expect(json(await post(`/auth/otp/${challengeId}/verify`, { code: '9999' })).code).toBe('OTP_LOCKED');
    // Even the right code is refused once locked.
    expect((await post(`/auth/otp/${challengeId}/verify`, { code: '1234' })).statusCode).toBe(423);
  });

  it('parallel guesses cannot exceed the attempt limit', async () => {
    const { challengeId } = json(await post('/auth/otp', { phone: nextPhone(), purpose: 'register' }));
    const results = await Promise.all(Array.from({ length: 12 }, () => post(`/auth/otp/${challengeId}/verify`, { code: '0000' })));
    const invalid = results.filter((r) => json(r).code === 'OTP_INVALID').length;
    expect(invalid).toBeLessThanOrEqual(4);
    expect((await post(`/auth/otp/${challengeId}/verify`, { code: '1234' })).statusCode).toBe(423);
  });

  it('expires codes after 5 minutes (server time)', async () => {
    const { challengeId } = json(await post('/auth/otp', { phone: nextPhone(), purpose: 'register' }));
    t.clock.advance(5 * 60_000 + 1);
    const res = await post(`/auth/otp/${challengeId}/verify`, { code: '1234' });
    expect(res.statusCode).toBe(410);
    expect(json(res).code).toBe('OTP_EXPIRED');
  });

  it('enforces the 60 s resend delay', async () => {
    const { challengeId } = json(await post('/auth/otp', { phone: nextPhone(), purpose: 'register' }));
    expect((await post(`/auth/otp/${challengeId}/resend`, {})).statusCode).toBe(429);
    t.clock.advance(61_000);
    expect((await post(`/auth/otp/${challengeId}/resend`, {})).statusCode).toBe(202);
  });

  it('only offers SMS until WhatsApp and e-mail providers exist, on first send and on resend', async () => {
    expect(json(await post('/auth/otp', { phone: nextPhone(), purpose: 'register', channel: 'whatsapp' })).code).toBe('CHANNEL_UNAVAILABLE');
    const { challengeId } = json(await post('/auth/otp', { phone: nextPhone(), purpose: 'register' }));
    t.clock.advance(61_000);
    const res = await post(`/auth/otp/${challengeId}/resend`, { channel: 'whatsapp' });
    expect(res.statusCode).toBe(422);
    expect(json(res).code).toBe('CHANNEL_UNAVAILABLE');
  });

  it('uses each verification token once', async () => {
    const verificationToken = await verified(nextPhone());
    expect((await post('/auth/register', { verificationToken, ...profile() })).statusCode).toBe(201);
    const again = await post('/auth/register', { verificationToken, ...profile() });
    expect(again.statusCode).toBe(410);
  });

  it('validates the residence against the campus and normalizes inputs', async () => {
    const bad = await post('/auth/register', { verificationToken: await verified(nextPhone()), ...profile({ campus: 'campus1', village: 'Village H' }) });
    expect(bad.statusCode).toBe(400);
    expect(json(bad).field).toBe('village');

    const res = await post('/auth/register', { verificationToken: await verified(nextPhone()), ...profile({ studentNumber: ' p  777001', room: 'c 12' }) });
    expect(res.statusCode).toBe(201);
    const me = json(await t.app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${json(res).tokens.accessToken}` } }));
    expect(me.student).toMatchObject({ studentNumber: 'P777001', room: 'C12', ufr: 'SEG', region: 'Ziguinchor', verified: false });
    expect(me.spaces).toEqual([{ key: 'student', type: 'student', kind: null, orgId: null, name: 'Étudiant', roles: [], logoUrl: null, personal: false }]);
    // Short or long (P then digits, 4 to 20 characters); anything else: refused.
    const long = `P${String(Date.now()).slice(-11)}`;
    expect((await post('/auth/register', { verificationToken: await verified(nextPhone()), ...profile({ studentNumber: long.toLowerCase() }) })).statusCode).toBe(201);
    const short = `P${String(Date.now()).slice(-3)}`;
    expect((await post('/auth/register', { verificationToken: await verified(nextPhone()), ...profile({ studentNumber: short }) })).statusCode).toBe(201);
    for (const n of ['P12', 'P-232-055', 'A2320551', `P${'1'.repeat(20)}`]) {
      const r = json(await post('/auth/register', { verificationToken: await verified(nextPhone()), ...profile({ studentNumber: n }) }));
      expect(r.field, `${n} ${JSON.stringify(r)}`).toBe('studentNumber');
    }
    expect(json(await t.app.inject({ url: '/api/v1/reference/student' })).studentNumber).toEqual({ pattern: '^P\\d{3,19}$', maxLength: 20, example: 'P232055' });
  });

  it('asks the UFR and the home region; given, they change at the next rentrée only; the lists are public', async () => {
    const ref = json(await t.app.inject({ url: '/api/v1/reference/student' }));
    expect(ref.ufrs.map((u: { code: string }) => u.code)).toEqual(['SAT', 'LSH', 'SJP', 'SEG', 'S2ATA', '2S', 'SEFS', 'CRAC']);
    expect(ref.regions).toHaveLength(15);
    expect(ref.campuses).toEqual([
      expect.objectContaining({ key: 'campus1', villages: expect.arrayContaining(['Village A', 'Village G', 'Village M', 'Village P', 'Village Q']) }),
      expect.objectContaining({ key: 'campus2', villages: ['Village H', 'Village I', 'Village J', 'Village K', 'Village L', 'Village N', 'Village O'] }),
    ]);
    for (const [field, over] of [['ufr', { ufr: 'UFR SAT' }], ['region', { region: 'Paris' }]] as const) {
      expect((await post('/auth/register', { verificationToken: await verified(nextPhone()), ...profile(over) })).statusCode, field).toBe(400);
    }
    const res = await post('/auth/register', { verificationToken: await verified(nextPhone()), ...profile() });
    const auth = { authorization: `Bearer ${json(res).tokens.accessToken}` };
    const meNow = json(await t.app.inject({ url: '/api/v1/me', headers: auth }));
    const before = meNow.student;
    // Given at sign-up: locked until the next rentrée (1 October), said in the error and on /me.
    expect(before.originEditableFrom).toBe('2027-10-01T00:00:00.000Z');
    const locked = await t.app.inject({ method: 'PUT', url: '/api/v1/me/origin', headers: auth, payload: { ufr: 'SJP', region: 'Kolda' } });
    expect([locked.statusCode, json(locked).code]).toEqual([409, 'ORIGIN_LOCKED']);
    // Sending the same again changes nothing and is accepted.
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/me/origin', headers: auth, payload: { ufr: before.ufr, region: before.region } })).statusCode).toBe(204);
    // The rentrée came: free to change, then locked for the new year.
    const was = t.clock.now().getTime();
    t.clock.set(Date.parse('2027-10-02T08:00:00Z'));
    // A year later: a fresh session (the first one has expired).
    const { accessToken } = await t.c.modules.identity.startSession({ _id: new ObjectId(meNow.id), platformRoles: [] });
    auth.authorization = `Bearer ${accessToken}`;
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/me/origin', headers: auth, payload: { ufr: 'SJP', region: 'Kolda' } })).statusCode).toBe(204);
    expect(json(await t.app.inject({ url: '/api/v1/me', headers: auth })).student).toMatchObject({ ufr: 'SJP', region: 'Kolda', originEditableFrom: '2028-10-01T00:00:00.000Z' });
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/me/origin', headers: auth, payload: { ufr: 'SAT', region: 'Kolda' } })).statusCode).toBe(409);
    t.clock.set(was);
  });

  it('the niveau is asked with the UFR; each of UFR, niveau and région can be given alone', async () => {
    const res = await post('/auth/register', { verificationToken: await verified(nextPhone()), ...profile({ niveau: 'Licence 2' }) });
    expect(res.statusCode).toBe(201);
    const auth = bearer(json(res).tokens.accessToken);
    expect(json(await t.app.inject({ url: '/api/v1/me', headers: auth })).student).toMatchObject({ niveau: 'Licence 2' });
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/me/origin', headers: auth, payload: { niveau: 'Doctorat' } })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/me/origin', headers: auth, payload: { niveau: 'Bac+9' } })).statusCode).toBe(400);
    // An older account without a niveau fills it in alone (the rest stays).
    const old = await post('/auth/register', { verificationToken: await verified(nextPhone()), ...profile() });
    const auth2 = bearer(json(old).tokens.accessToken);
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/me/origin', headers: auth2, payload: { niveau: 'Master 1' } })).statusCode).toBe(204);
    const me = json(await t.app.inject({ url: '/api/v1/me', headers: auth2 })).student;
    expect(me).toMatchObject({ niveau: 'Master 1', ufr: profile().ufr, region: profile().region });
  });

  it('applies the password rules of the app', async () => {
    const res = await post('/auth/register', { verificationToken: await verified(nextPhone()), ...profile({ password: 'abcdefgh' }) });
    expect(res.statusCode).toBe(400);
  });

  it('two sign-ups racing for the same student number: exactly one wins', async () => {
    const studentNumber = 'P888001';
    const [a, b] = await Promise.all([verified(nextPhone()), verified(nextPhone())]);
    const results = await Promise.all([
      post('/auth/register', { verificationToken: a, ...profile({ studentNumber }) }),
      post('/auth/register', { verificationToken: b, ...profile({ studentNumber }) }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(json(results.find((r) => r.statusCode === 409)!).code).toBe('STUDENT_NUMBER_TAKEN');
  });
});

describe('forgot password', () => {
  it('sends no code to a number without an account', async () => {
    const res = await post('/auth/otp', { phone: nextPhone(), purpose: 'reset_password' });
    expect(res.statusCode).toBe(404);
    expect(json(res)).toMatchObject({ code: 'ACCOUNT_NOT_FOUND', message: 'Aucun compte sur ce numéro.' });
  });

  it('resets the password and ends every session', async () => {
    const s = await registerStudent(t);
    const verificationToken = await verified(s.phone, 'reset_password');
    expect((await post('/auth/password/reset', { verificationToken, newPassword: 'Nouveau2026' })).statusCode).toBe(204);

    expect((await t.app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${s.tokens.accessToken}` } })).statusCode).toBe(401);
    expect((await post('/auth/refresh', { refreshToken: s.tokens.refreshToken })).statusCode).toBe(401);
    expect((await post('/auth/login', { identifier: s.phone, password: 'Bonjour2026' })).statusCode).toBe(401);
    expect((await post('/auth/login', { identifier: s.phone, password: 'Nouveau2026' })).statusCode).toBe(200);
  });

  it('a register token cannot reset a password', async () => {
    const s = await registerStudent(t);
    const { challengeId } = json(await post('/auth/otp', { phone: nextPhone(), purpose: 'register' }));
    const token = json(await post(`/auth/otp/${challengeId}/verify`, { code: '1234' })).verificationToken;
    expect((await post('/auth/password/reset', { verificationToken: token, newPassword: 'Nouveau2026' })).statusCode).toBe(410);
    expect((await post('/auth/login', { identifier: s.phone, password: 'Bonjour2026' })).statusCode).toBe(200);
  });
});
