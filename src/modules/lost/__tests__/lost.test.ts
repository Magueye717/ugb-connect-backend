import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, registerStudent, type TestApp } from '../../../../test/harness.js';
import { multipart, picture } from '../../../../test/upload.js';
import { parseCard } from '../lost.ocr.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ MEDIA_DIR: mkdtempSync(join(tmpdir(), 'ugb-media-')) });
});
afterAll(async () => t.close());

type Who = { tokens: { accessToken: string } };
const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: object) => t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(who.tokens.accessToken), payload });
const ok = async (res: Promise<{ statusCode: number; body: string }>, status = 200) => {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return json(r);
};
const readCard = async (who: Who) => {
  const body = multipart(await picture(), 'carte.jpg', 'image/jpeg');
  return t.app.inject({ method: 'POST', url: '/api/v1/lost/cards/read', headers: { ...bearer(who.tokens.accessToken), ...body.headers }, payload: body.payload });
};
const local = (e164: string) => e164.replace(/^\+221/, '').replace(/^(\d{2})(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3 $4');

describe('reading a card', () => {
  it('a student card: its number, look-alike letters forgiven, and the labelled names', () => {
    expect(parseCard('UNIVERSITÉ GASTON BERGER\nCARTE D’ÉTUDIANT\nNom : NDIAYE\nPrénom(s) : Fatou Bintou\nN° étudiant : P 232 O55')).toEqual({ cardType: 'student', studentNumber: 'P232055', names: ['NDIAYE', 'Fatou', 'Bintou'] });
    // No labels, no number: the words left are candidates.
    expect(parseCard('UNIVERSITE GASTON BERGER\nCARTE ETUDIANT\nSOW Ibrahima\nUFR SAT')).toEqual({ cardType: 'student', studentNumber: null, names: ['SOW', 'Ibrahima'] });
  });

  it('an identity card (labels at the top, values under them), a licence (numbered fields), a bank card (name in capitals at the bottom)', () => {
    expect(parseCard('REPUBLIQUE DU SENEGAL\nCARTE D’IDENTITE CEDEAO\nPrénoms / Given names\nFATOU BINTOU\nNom / Surname\nNDIAYE\nDate de naissance 12/03/2002')).toEqual({ cardType: 'national_id', studentNumber: null, names: ['FATOU', 'BINTOU', 'NDIAYE'] });
    expect(parseCard('REPUBLIQUE DU SENEGAL\nPERMIS DE CONDUIRE\n1. NDIAYE\n2. FATOU BINTOU\n3. 12.03.2002 DAKAR')).toEqual({ cardType: 'driving_licence', studentNumber: null, names: ['NDIAYE', 'FATOU', 'BINTOU'] });
    expect(parseCard('ECOBANK\nVISA DEBIT\n4532 1234 5678 9012\nVALID THRU 08/28\nFATOU NDIAYE')).toEqual({ cardType: 'bank', studentNumber: null, names: ['FATOU', 'NDIAYE'] });
  });
});

describe('a found student card', () => {
  it('read by OCR: its owner is matched by number and warned (push + home alert with the finder’s phone), a chat opens', async () => {
    const owner = await registerStudent(t, { firstName: 'Fatou', lastName: 'Ndiaye' });
    const finder = await registerStudent(t, { firstName: 'Moussa', lastName: 'Sarr' });
    const someone = await registerStudent(t);

    t.ocr.text = `UNIVERSITE GASTON BERGER\nNom : NDIAYE\nPrénom : Fatou\nN° : ${owner.studentNumber}`;
    const read = await ok(readCard(finder));
    expect(read).toMatchObject({ studentNumber: owner.studentNumber, owner: { name: 'Fatou Ndiaye', ufr: 'SAT', campus: 'Campus 1', village: 'Village E' }, candidates: [] });
    expect(read.owner.numberHint).toBe(`${owner.studentNumber.slice(0, 3)}•••${owner.studentNumber.slice(-2)}`);

    const { item, claimId } = await ok(call(finder, 'POST', '/lost/cards/found', { ownerRef: read.owner.ref, where: 'BU', spot: '2e étage', holder: 'finder' }), 201);
    expect(item).toMatchObject({ kind: 'student-card', status: 'found', owner: 'Fatou N.', ownerNotified: true, photo: null, by: 'Moussa S.', mine: true });

    // The owner: a push…
    const notif = (await ok(call(owner, 'GET', '/notifications'))).items[0];
    expect(notif).toMatchObject({ type: 'lost.card_found', title: 'Ta carte étudiant a été trouvée', url: `/objet/${item.id}` });
    expect(notif.body).toContain(`Moussa Sarr (${local(finder.phone)})`);
    expect(notif.body).toContain('Trouvée à BU (2e étage)');
    // …and an alert on their home screen only, like a dish sold out.
    const alert = (await ok(call(owner, 'GET', '/alerts'))).items.find((a: { title: string }) => a.title === 'Ta carte étudiant a été trouvée');
    expect(alert).toMatchObject({ placement: 'banner', tone: 'warning', href: `/objet/${item.id}` });
    expect((await ok(call(someone, 'GET', '/alerts'))).items.some((a: { title: string }) => a.title === 'Ta carte étudiant a été trouvée')).toBe(false);

    // The chat between them.
    const chat = await ok(call(owner, 'GET', `/lost/claims/${claimId}`));
    expect(chat).toMatchObject({ role: 'card', with: 'Moussa S.', item: { id: item.id, isOwner: true } });
    const messages = (await ok(call(owner, 'GET', `/conversations/${chat.conversationId}/messages`))).items;
    expect(messages[0].body).toContain('Moussa S. a trouvé ta carte étudiant (BU)');
    expect((await call(someone, 'GET', `/lost/claims/${claimId}`)).statusCode).toBe(404);

    // Got it back: the owner closes it, the alert goes away, the chat is read-only.
    await ok(call(owner, 'POST', `/lost/items/${item.id}/returned`));
    expect((await ok(call(owner, 'GET', '/alerts'))).items.some((a: { title: string }) => a.title === 'Ta carte étudiant a été trouvée')).toBe(false);
    expect((await ok(call(owner, 'GET', `/conversations/${chat.conversationId}`))).canWrite).toBe(false);
  });

  it('no number read: the names are searched, then by hand; unknown owner goes to the office', async () => {
    const fatou = await registerStudent(t, { firstName: 'Fatou', lastName: 'Ndiaye', campus: 'campus2' });
    await registerStudent(t, { firstName: 'Aminata', lastName: 'Ndiaye' });
    const finder = await registerStudent(t, { firstName: 'Khadim', lastName: 'Fall' });

    t.ocr.text = 'UNIVERSITE GASTON BERGER\nNom : NDIAYE\nPrénom : Fatou\n(numéro illisible)';
    const read = await ok(readCard(finder));
    expect(read.owner).toBeNull();
    // Only the Fatou Ndiayes (both names on the card; namesakes are told apart by UFR, campus and number hint).
    expect(read.candidates[0].name).toBe('Fatou Ndiaye');
    expect(read.candidates.find((c: { ref: string }) => c.ref === fatou.userId)).toMatchObject({ name: 'Fatou Ndiaye', campus: 'Campus 2', village: 'Village H' });
    // Another Ndiaye shares one name only: not offered from a card (she still comes up when typing « ndiaye »).
    expect(read.candidates.some((c: { name: string }) => c.name === 'Aminata Ndiaye')).toBe(false);

    // The camera pointed at anything but a card (noise read as words): nobody is offered.
    t.ocr.text = 'FALL NDIAYE\nwxq lmn\nTABLE';
    expect(await ok(readCard(finder))).toMatchObject({ cardType: null, names: [], owner: null, candidates: [] });

    expect((await ok(call(finder, 'GET', '/lost/cards/search?q=fatou%20ndiaye'))).items.map((c: { ref: string }) => c.ref)).toContain(fatou.userId);
    // Pieces of names are enough: "ndiay" finds every Ndiaye.
    const pieces = (await ok(call(finder, 'GET', '/lost/cards/search?q=ndiay'))).items.map((c: { name: string }) => c.name);
    expect(pieces).toEqual(expect.arrayContaining(['Fatou Ndiaye', 'Aminata Ndiaye']));
    expect((await ok(call(finder, 'GET', '/lost/cards/search?q=zzqx'))).items).toEqual([]);
    expect((await ok(call(finder, 'GET', `/lost/cards/lookup?number=${fatou.studentNumber.toLowerCase()}`))).owner.ref).toBe(fatou.userId);
    expect((await ok(call(finder, 'GET', '/lost/cards/lookup?number=P000001'))).owner).toBeNull();
    expect((await call(finder, 'GET', '/lost/cards/lookup?number=12345678')).statusCode).toBe(400);
    // One's own card isn't "found".
    expect(json(await call(fatou, 'POST', '/lost/cards/found', { ownerRef: fatou.userId, where: 'BU', holder: 'office' })).code).toBe('LOST_OWN_CARD');

    const { item, claimId } = await ok(call(finder, 'POST', '/lost/cards/found', { ownerRef: null, where: 'Resto 1', holder: 'finder' }), 201);
    expect(item).toMatchObject({ holder: 'office', owner: null, ownerNotified: false });
    expect(claimId).toBeNull();

    // The office sees it, and hands it over.
    expect((await call(finder, 'GET', '/admin/lost/items')).statusCode).toBe(403);
    const office = await createStaff(t, ['lost_office']);
    expect((await ok(call(office, 'GET', '/admin/lost/items'))).items.some((i: { id: string }) => i.id === item.id)).toBe(true);
    expect((await call(office, 'POST', `/admin/lost/items/${item.id}/handed-over`)).statusCode).toBe(204);
    expect((await ok(call(finder, 'GET', `/lost/items/${item.id}`))).returned).toBe(true);
  });
});

describe('my own student card', () => {
  it('fills birth date, place of birth and nationality, checked by the student, then saved on the profile', async () => {
    const me = await registerStudent(t, { firstName: 'Aissatou', lastName: 'Ba' });
    const other = await registerStudent(t, { firstName: 'Moussa', lastName: 'Sarr' });
    t.ocr.text = `UNIVERSITE GASTON BERGER\nNom : BA\nPrénom : Aissatou\nDate de naissance : 12/03/2002\nLieu de naissance : SAINT-LOUIS\nNationalité : SENEGALAISE\nN° : ${me.studentNumber}`;
    const card = multipart(await picture());
    const read = (who: Who) => t.app.inject({ method: 'POST', url: '/api/v1/me/student-card/read', headers: { ...bearer(who.tokens.accessToken), ...card.headers }, payload: card.payload });
    expect(await ok(read(me))).toEqual({ matched: 'number', studentNumber: me.studentNumber, birthDate: '2002-03-12', birthPlace: 'Saint-Louis', nationality: 'Sénégalaise' });
    // Someone else's card is refused.
    expect(json(await read(other)).code).toBe('NOT_YOUR_CARD');
    // Number unreadable: names alone are not enough, the number must be mine.
    t.ocr.text = 'UNIVERSITE GASTON BERGER\nNom : BA\nPrénom : Aissatou\nNé(e) le 12/03/2002 à Saint-Louis';
    expect(json(await read(me)).field).toBe('file');
    // Only a student card.
    t.ocr.text = 'REPUBLIQUE DU SENEGAL\nCARTE D’IDENTITE CEDEAO\nPrénoms\nAISSATOU\nNom\nBA';
    expect(json(await read(me)).code).toBe('NOT_STUDENT_CARD');

    expect((await call(me, 'GET', '/me')).statusCode).toBe(200);
    expect(json(await t.app.inject({ method: 'PUT', url: '/api/v1/me/identity', headers: bearer(me.tokens.accessToken), payload: { birthDate: '2030-01-01', birthPlace: null, nationality: null } })).field).toBe('birthDate');
    const put = (who: Who) => t.app.inject({ method: 'PUT', url: '/api/v1/me/identity', headers: bearer(who.tokens.accessToken), payload: { birthDate: '2002-03-12', birthPlace: 'Saint-Louis', nationality: 'Sénégalaise', fromCard: true } });
    // Without a scan of their own card: refused.
    expect(json(await put(other)).code).toBe('CARD_SCAN_REQUIRED');
    expect((await put(me)).statusCode).toBe(204);
    // Saved this year: a filled detail can't change before the next rentrée.
    const change = await t.app.inject({ method: 'PUT', url: '/api/v1/me/identity', headers: bearer(me.tokens.accessToken), payload: { birthDate: '2002-03-12', birthPlace: 'Dakar', nationality: 'Sénégalaise', fromCard: true } });
    expect(json(change).code).toBe('IDENTITY_LOCKED');
    const mine = (await ok(call(me, 'GET', '/me'))).student;
    expect(mine.identity).toMatchObject({ birthDate: '2002-03-12', birthPlace: 'Saint-Louis', nationality: 'Sénégalaise', fromCard: true });
    expect(mine.identityEditableFrom).toBe('2027-10-01T00:00:00.000Z');
  });
});

describe('other cards', () => {
  it('an identity card read by OCR: its owner is searched by name and told it’s their identity card', async () => {
    const owner = await registerStudent(t, { firstName: 'Ndeye', lastName: 'Thiaw' });
    const finder = await registerStudent(t);
    t.ocr.text = 'REPUBLIQUE DU SENEGAL\nCARTE D’IDENTITE CEDEAO\nPrénoms\nNDEYE\nNom\nTHIAW\nNé le 01/02/2003';
    const read = await ok(readCard(finder));
    expect(read).toMatchObject({ cardType: 'national_id', studentNumber: null, owner: null });
    const match = read.candidates.find((c: { ref: string }) => c.ref === owner.userId);
    expect(match).toMatchObject({ name: 'Ndeye Thiaw' });
    const { item } = await ok(call(finder, 'POST', '/lost/cards/found', { ownerRef: match.ref, cardType: 'national_id', where: 'Bibliothèque universitaire', holder: 'office' }), 201);
    expect(item).toMatchObject({ category: 'id-card', kind: 'id-card', name: 'Carte d’identité', photo: null });
    expect((await ok(call(owner, 'GET', '/notifications'))).items[0]).toMatchObject({ title: 'Ta carte d’identité a été trouvée' });
  });
});

describe('objects', () => {
  it('a found object: photo required, the owner proves it in a chat with the finder, then it’s returned', async () => {
    const finder = await registerStudent(t, { firstName: 'Moussa', lastName: 'Sarr' });
    const owner = await registerStudent(t, { firstName: 'Awa', lastName: 'Fall' });
    const bag = { status: 'found', category: 'bag', name: 'Sac à dos bleu', details: 'Logo jaune', secret: 'Un cahier de maths dedans', where: 'Amphi A', when: 'today', holder: 'finder' };
    expect(json(await call(finder, 'POST', '/lost/items', bag)).field).toBe('imageId');
    const upload = multipart(await picture());
    const photo = json(await t.app.inject({ method: 'POST', url: '/api/v1/media/images?purpose=lost', headers: { ...bearer(finder.tokens.accessToken), ...upload.headers }, payload: upload.payload }));
    const item = await ok(call(finder, 'POST', '/lost/items', { ...bag, imageId: photo.id }), 201);
    expect(item).toMatchObject({ name: 'Sac à dos bleu', by: 'Moussa S.', mine: true, secret: 'Un cahier de maths dedans', photo: expect.stringMatching(/\.webp$/) });
    // Cards: never in photo; a found student card is scanned instead.
    expect(json(await call(finder, 'POST', '/lost/items', { ...bag, category: 'id-card', imageId: photo.id })).field).toBe('imageId');
    expect(json(await call(finder, 'POST', '/lost/items', { status: 'found', category: 'student-card', where: 'BU', when: 'today' })).field).toBe('category');

    // On the board, the secret stays with the finder.
    const seen = (await ok(call(owner, 'GET', '/lost/items'))).items.find((i: { id: string }) => i.id === item.id);
    expect(seen).toMatchObject({ mine: false, secret: null, myClaimId: null });

    const claim = await ok(call(owner, 'POST', `/lost/items/${item.id}/claim`, { proof: 'Il y a un cahier de maths' }));
    expect(claim).toMatchObject({ role: 'claim', with: 'Moussa S.', item: { id: item.id, myClaimId: claim.id } });
    // Tapping again opens the same conversation.
    expect((await ok(call(owner, 'POST', `/lost/items/${item.id}/claim`, { proof: 'encore' }))).id).toBe(claim.id);
    expect((await ok(call(finder, 'GET', '/notifications'))).items[0]).toMatchObject({ type: 'lost.claim', url: `/objet/discussion/${claim.id}` });
    const detail = await ok(call(finder, 'GET', `/lost/items/${item.id}`));
    expect(detail.conversations).toEqual([expect.objectContaining({ claimId: claim.id, with: 'Awa F.', role: 'claim' })]);
    const lines = (await ok(call(finder, 'GET', `/conversations/${claim.conversationId}/messages`))).items.map((m: { body: string }) => m.body);
    expect(lines.some((b: string) => b.includes('Il y a un cahier de maths'))).toBe(true);
    await ok(call(owner, 'POST', `/conversations/${claim.conversationId}/messages`, { body: 'Je passe à la BU à 16h ?', kind: 'text', clientMessageId: 'lost-chat-0001' }), 201);

    // Only the finder closes it.
    expect((await call(owner, 'POST', `/lost/items/${item.id}/returned`)).statusCode).toBe(403);
    expect(await ok(call(finder, 'POST', `/lost/items/${item.id}/returned`))).toMatchObject({ returned: true, state: 'returned' });
    expect((await ok(call(owner, 'GET', `/conversations/${claim.conversationId}`))).canWrite).toBe(false);
    expect(json(await call(owner, 'POST', `/lost/items/${item.id}/claim`, { proof: 'encore' })).code).toBe('LOST_CLOSED');
  });

  it('a lost object: "je l’ai trouvé" opens a chat with its owner; at the office, no chat', async () => {
    const owner = await registerStudent(t, { firstName: 'Ibrahima', lastName: 'Diallo' });
    const finder = await registerStudent(t);
    const lost = await ok(call(owner, 'POST', '/lost/items', { status: 'lost', category: 'calculator', name: 'Casio fx-92', where: 'Amphi A', when: 'yesterday' }), 201);
    const chat = await ok(call(finder, 'POST', `/lost/items/${lost.id}/found-it`));
    expect(chat).toMatchObject({ role: 'found_it', with: 'Ibrahima D.' });
    expect((await ok(call(owner, 'GET', '/notifications'))).items[0]).toMatchObject({ type: 'lost.found_it' });
    expect(json(await call(owner, 'POST', `/lost/items/${lost.id}/found-it`)).code).toBe('LOST_OWN_ITEM');

    const upload = multipart(await picture());
    const photo = json(await t.app.inject({ method: 'POST', url: '/api/v1/media/images?purpose=lost', headers: { ...bearer(finder.tokens.accessToken), ...upload.headers }, payload: upload.payload }));
    const atOffice = await ok(call(finder, 'POST', '/lost/items', { status: 'found', category: 'phone', imageId: photo.id, where: 'Resto 1', when: 'today', holder: 'office' }), 201);
    expect(json(await call(owner, 'POST', `/lost/items/${atOffice.id}/claim`, { proof: 'Fond d’écran bleu' })).code).toBe('LOST_AT_OFFICE');
  });
});

describe('student number given after sign-up', () => {
  it('signs up without it, adds it on the profile once, or gets it from their own card; never someone else’s', async () => {
    const put = (who: Who, studentNumber: string) => t.app.inject({ method: 'PUT', url: '/api/v1/me/student-number', headers: bearer(who.tokens.accessToken), payload: { studentNumber } });
    const taken = await registerStudent(t);
    const a = await registerStudent(t, { studentNumber: null, firstName: 'Ndeye', lastName: 'Gaye' });
    expect((await ok(call(a, 'GET', '/me'))).student.studentNumber).toBeNull();
    // Two students without a number: no clash.
    const b = await registerStudent(t, { studentNumber: null });

    expect(json(await put(a, taken.studentNumber)).code).toBe('STUDENT_NUMBER_TAKEN');
    expect((await put(a, 'p 777 001')).statusCode).toBe(204);
    expect((await ok(call(a, 'GET', '/me'))).student.studentNumber).toBe('P777001');
    // A typo: correctable for 3 days after it was first given…
    expect((await ok(call(a, 'GET', '/me'))).student.studentNumberEditableUntil).toBeTruthy();
    expect((await put(a, 'P777002')).statusCode).toBe(204);
    expect((await ok(call(a, 'GET', '/me'))).student.studentNumber).toBe('P777002');
    // …then it doesn't change here (the team fixes it). Given 4 days ago (moving the clock would end the session).
    await t.c.mongo.db.collection('studentProfiles').updateOne({ studentNumber: 'P777002' }, { $set: { studentNumberSetAt: new Date(t.clock.now().getTime() - 4 * 24 * 3_600_000) } });
    expect((await ok(call(a, 'GET', '/me'))).student.studentNumberEditableUntil).toBeNull();
    expect(json(await put(a, 'P777003')).code).toBe('STUDENT_NUMBER_SET');

    // Their own card gives the number: free → saved; someone else's → refused.
    const card = multipart(await picture());
    const read = (who: Who) => t.app.inject({ method: 'POST', url: '/api/v1/me/student-card/read', headers: { ...bearer(who.tokens.accessToken), ...card.headers }, payload: card.payload });
    t.ocr.text = `UNIVERSITE GASTON BERGER\nNom : GAYE\nN° : ${taken.studentNumber}`;
    expect(json(await read(b)).code).toBe('NOT_YOUR_CARD');
    t.ocr.text = 'UNIVERSITE GASTON BERGER\nNom : DIOP\nN° : P888123';
    expect(await ok(read(b))).toMatchObject({ matched: 'number', studentNumber: 'P888123' });
    expect((await ok(call(b, 'GET', '/me'))).student.studentNumber).toBe('P888123');
  });
});
