/**
 * `npm run seed:review-user`: the student account the store reviewers (Google Play, App Store) sign in with —
 * 770000000 / Campus2026 — on the environment of `.env` (production included: it's the one they test).
 *
 * Only creates it. If the number already has an account, nothing is changed (not its password, not its profile): it
 * says what it found. Safe to run again.
 */
import { loadConfig } from '../../src/config/env.js';
import { createContainer } from '../../src/container.js';
import { TERMS_VERSION } from '../../src/modules/legal/index.js';
import { withTransaction } from '../../src/platform/db/mongo.js';
import { normalizePhone } from '../../src/platform/phone.js';
import { hashPassword } from '../../src/platform/security/passwords.js';

const PHONE = '770000000';
const PASSWORD = 'Campus2026';

const config = loadConfig();
const c = await createContainer(config);
const { accounts } = c.modules;

try {
  const phone = normalizePhone(PHONE);
  if (!phone) throw new Error(`Invalid phone number: ${PHONE}`);
  console.log(`Review account ${PHONE} (${config.isProduction ? 'production' : 'non-production'} database)`);

  // Always checked first: an existing account is never overwritten.
  const existing = await accounts.findByPhone(phone);
  if (existing) {
    const profile = await c.mongo.db.collection('studentProfiles').findOne({ userId: existing._id }, { projection: { _id: 1 } });
    console.log(`  Already exists: ${existing.firstName} ${existing.lastName} · ${existing.status}${profile ? ' · student' : ' · NOT a student (no student profile)'}. Nothing changed.`);
    if (!profile) console.log('  This number belongs to a non-student account: pick another number for the review account.');
  } else {
    const passwordHash = await hashPassword(PASSWORD);
    const user = await withTransaction(c.mongo.client, (session) =>
      accounts.createStudentAccount(
        {
          phone, studentNumber: null, firstName: 'Compte', lastName: 'Test', campus: 'campus1', onCampus: true, village: 'Village E', room: '101',
          ufr: 'SAT', region: 'Saint-Louis', niveau: 'Licence 1', passwordHash, termsVersion: TERMS_VERSION,
        },
        session,
      ),
    );
    console.log(`  Created: Compte Test · student · campus 1, Village E · UFR SAT (id ${user._id.toHexString()}).`);
    console.log(`  Sign in with ${PHONE} / ${PASSWORD}.`);
  }
} finally {
  await c.close();
}
