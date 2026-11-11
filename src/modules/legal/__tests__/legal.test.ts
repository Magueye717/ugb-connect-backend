import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, json, type TestApp } from '../../../../test/harness.js';
import { TERMS_VERSION } from '../index.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

describe('legal', () => {
  it('serves the terms and the privacy policy publicly, with the version accepted at sign-up', async () => {
    for (const doc of ['conditions', 'confidentialite']) {
      const res = await t.app.inject({ url: `/api/v1/reference/legal/${doc}` });
      expect(res.statusCode).toBe(200);
      const d = json(res);
      expect(d).toMatchObject({ doc, version: TERMS_VERSION });
      expect(d.sections.length).toBeGreaterThan(3);
      // The support contacts come from the configuration.
      expect(JSON.stringify(d)).toContain(t.c.config.SUPPORT_EMAIL);
    }
    expect((await t.app.inject({ url: '/api/v1/reference/legal/autre' })).statusCode).toBe(404);
  });

  it('the same documents as public pages, for the store listing: /confidentialite, /privacy, /conditions, /terms', async () => {
    for (const [url, title] of [['/confidentialite', 'Politique de confidentialité'], ['/privacy', 'Politique de confidentialité'], ['/conditions', 'Conditions d’utilisation'], ['/terms', 'Conditions d’utilisation']] as const) {
      const res = await t.app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain(`<h1>${title}</h1>`);
      expect(res.body).toContain(t.c.config.SUPPORT_EMAIL);
    }
    // The account deletion link points at its section.
    const del = await t.app.inject({ url: '/suppression-compte' });
    expect(del.statusCode).toBe(302);
    expect(del.headers.location).toBe('/confidentialite#supprimer-ton-compte');
    expect((await t.app.inject({ url: '/confidentialite' })).body).toContain('id="supprimer-ton-compte"');
  });
});
