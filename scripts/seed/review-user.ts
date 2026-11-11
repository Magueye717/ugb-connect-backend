/**
 * `npm run seed:review-user`: the store reviewers' student account (« Student Test », REVIEW_STUDENT_PHONE /
 * REVIEW_STUDENT_PASSWORD, 770000000 / Campus2026 by default) on the environment of `.env`. Every deploy already does
 * it (migrate step); this is for running it by hand.
 *
 * Only creates it. If the number already has an account, nothing is changed: it says what it found. Safe to run again.
 */
import { loadConfig } from '../../src/config/env.js';
import { ensureReviewStudent } from '../../src/modules/accounts/index.js';
import { TERMS_VERSION } from '../../src/modules/legal/index.js';
import { systemClock } from '../../src/platform/clock.js';
import { connectMongo } from '../../src/platform/db/mongo.js';

const config = loadConfig();
if (!config.REVIEW_STUDENT_PHONE) throw new Error('REVIEW_STUDENT_PHONE is empty: no review account to create.');
const { client, db } = await connectMongo(config.MONGODB_URI, config.MONGODB_DB);
try {
  const result = await ensureReviewStudent(client, db, systemClock, { phone: config.REVIEW_STUDENT_PHONE, password: config.REVIEW_STUDENT_PASSWORD, termsVersion: TERMS_VERSION });
  console.log(
    result === 'created'
      ? `Created « Student Test »: sign in with ${config.REVIEW_STUDENT_PHONE} / ${config.REVIEW_STUDENT_PASSWORD}.`
      : `${config.REVIEW_STUDENT_PHONE} already has an account: nothing changed.`,
  );
} finally {
  await client.close();
}
