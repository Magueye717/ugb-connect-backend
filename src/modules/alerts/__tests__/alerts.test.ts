import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, registerStudent, type TestApp } from '../../../../test/harness.js';
import { multipart, picture } from '../../../../test/upload.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ MEDIA_DIR: mkdtempSync(join(tmpdir(), 'ugb-alerts-')) });
});
afterAll(async () => t.close());

type Who = { tokens: { accessToken: string } };
const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(who.tokens.accessToken), payload });
const send = (who: Who, url: string, file: Buffer, name: string, type: string) => {
  const body = multipart(file, name, type);
  return t.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { ...bearer(who.tokens.accessToken), ...body.headers }, payload: body.payload });
};
const pdf = (text: string, pages = 2) =>
  Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj << /Type /Pages /Count ${pages} >> endobj\n${Array.from({ length: pages }, (_, i) => `${i + 2} 0 obj << /Type /Page /Parent 1 0 R >> endobj`).join('\n')}\n%%EOF\n`);
const inAWeek = () => new Date(t.clock.now().getTime() + 7 * 24 * 3_600_000).toISOString();

describe('"À la une" with a picture and a PDF', () => {
  it('an announcement has its page: the whole text, a picture and a PDF; replaced files leave the storage', async () => {
    const editor = await createStaff(t, ['content_editor']);
    const s = await registerStudent(t);

    // Only a real PDF, and only for announcements.
    expect((await send(editor, '/media/files?purpose=alert', Buffer.from('not a pdf'), 'x.pdf', 'application/pdf')).statusCode).toBe(400);
    expect((await send(editor, '/media/files?purpose=banner', pdf('a'), 'x.pdf', 'application/pdf')).statusCode).toBe(400);
    const doc = json(await send(editor, '/media/files?purpose=alert', pdf('calendrier'), '../../Calendrier des examens.pdf', 'application/pdf'));
    expect(doc).toMatchObject({ name: 'Calendrier des examens.pdf', url: expect.stringMatching(/\.pdf$/) });
    const file = await t.app.inject({ url: new URL(doc.url).pathname });
    expect(file.headers['content-type']).toBe('application/pdf');
    const image = json(await send(editor, '/media/images?purpose=alert', await picture(), 'affiche.png', 'image/png'));
    // A PDF is not a picture, and a picture is not a document.
    const wrong = await call(editor, 'POST', '/admin/alerts', { placement: 'headline', tag: 'Examens', title: 'Calendrier', body: 'Résumé', endsAt: inAWeek(), imageIds: [doc.id] });
    expect(wrong.statusCode).toBe(400);

    const head = { placement: 'headline', tag: 'Examens', title: 'Calendrier des examens', body: 'Du 10 au 21 novembre', endsAt: inAWeek() };
    // One PDF, or photos: not both.
    const both = await call(editor, 'POST', '/admin/alerts', { ...head, imageIds: [image.id], attachmentId: doc.id });
    expect(both.statusCode).toBe(400);

    const created = json(
      await call(editor, 'POST', '/admin/alerts', { ...head, details: 'Toutes les UFR. Les salles sont affichées devant le rectorat.', attachmentId: doc.id }),
    );
    expect(created).toMatchObject({ details: 'Toutes les UFR. Les salles sont affichées devant le rectorat.', images: [], image: null, attachment: { url: doc.url, name: 'Calendrier des examens.pdf', label: 'Document officiel', pages: 2 } });

    const page = await call(s, 'GET', `/alerts/${created.id}`);
    expect(page.statusCode, page.body).toBe(200);
    // Students read what it is, its size and pages: not its file name.
    expect(json(page)).toMatchObject({ title: 'Calendrier des examens', attachment: { label: 'Document officiel', pages: 2 } });
    expect(json(page).attachment.name).toBeUndefined();
    expect((await call(s, 'GET', `/alerts/${new ObjectId().toHexString()}`)).statusCode).toBe(404);

    // The PDF replaced: the old one goes.
    const v2 = json(await send(editor, '/media/files?purpose=alert', pdf('v2'), 'Calendrier v2.pdf', 'application/pdf'));
    const updated = json(await call(editor, 'PUT', `/admin/alerts/${created.id}`, { ...head, body: 'Mis à jour', attachmentId: v2.id, attachmentLabel: '  Calendrier officiel ' }));
    expect(updated).toMatchObject({ images: [], attachmentLabel: 'Calendrier officiel', attachment: { name: 'Calendrier v2.pdf', label: 'Calendrier officiel' } });
    // Left out: unchanged.
    expect(json(await call(editor, 'PUT', `/admin/alerts/${created.id}`, { ...head, body: 'Encore' })).attachmentLabel).toBe('Calendrier officiel');
    const media = t.c.mongo.db.collection('media');
    expect(await media.countDocuments({ _id: new ObjectId(doc.id) })).toBe(0);

    // Photos on top of the PDF: refused; instead of it: fine, and the PDF goes.
    expect((await call(editor, 'PUT', `/admin/alerts/${created.id}`, { ...head, imageIds: [image.id] })).statusCode).toBe(400);
    const second = json(await send(editor, '/media/images?purpose=alert', await picture(), 'salles.png', 'image/png'));
    const photos = json(await call(editor, 'PUT', `/admin/alerts/${created.id}`, { ...head, imageIds: [image.id, second.id], attachmentId: null }));
    expect(photos).toMatchObject({ images: [image.url, second.url], imageIds: [image.id, second.id], image: image.url, attachment: null });
    expect(await media.countDocuments({ _id: new ObjectId(v2.id) })).toBe(0);
    // Three at most.
    const four = await call(editor, 'PUT', `/admin/alerts/${created.id}`, { ...head, imageIds: [image.id, second.id, image.id, second.id] });
    expect(four.statusCode).toBe(400);
    // One photo dropped: it leaves the storage, the other stays.
    json(await call(editor, 'PUT', `/admin/alerts/${created.id}`, { ...head, imageIds: [second.id] }));
    expect(await media.countDocuments({ _id: new ObjectId(image.id) })).toBe(0);
    expect(await media.countDocuments({ _id: new ObjectId(second.id) })).toBe(1);
    expect(json(await call(editor, 'GET', '/admin/alerts')).limits).toEqual({ images: 3, documentMb: 25 });
  });
});
