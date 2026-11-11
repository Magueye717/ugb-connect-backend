import type { Logger } from 'pino';

import { allCollections, migrateDatabase } from './collections.js';
import type { Config } from './config/env.js';
import { ensureBootstrapAdmin, ensureReviewStudent } from './modules/accounts/index.js';
import { TERMS_VERSION } from './modules/legal/index.js';
import { systemClock } from './platform/clock.js';
import { connectMongo } from './platform/db/mongo.js';

/**
 * What every deploy runs before the new version starts (Render's pre-deploy command, `npm run migrate` locally):
 * collections, validators and indexes, pending one-time data migrations, then the first administrator if configured
 * and missing, and the store reviewers' student account if missing. Idempotent, and needs only MongoDB.
 */
export async function runMigrate(config: Config, log: Pick<Logger, 'info'>) {
  const { client, db } = await connectMongo(config.MONGODB_URI, config.MONGODB_DB);
  try {
    const applied = await migrateDatabase(db);
    log.info({ specs: allCollections.length, db: config.MONGODB_DB, migrations: applied }, applied.length ? 'migrations applied' : 'no pending migration');
    if (config.BOOTSTRAP_ADMIN_PHONE && config.BOOTSTRAP_ADMIN_PASSWORD) {
      const result = await ensureBootstrapAdmin(db, systemClock, {
        phone: config.BOOTSTRAP_ADMIN_PHONE, password: config.BOOTSTRAP_ADMIN_PASSWORD, firstName: config.BOOTSTRAP_ADMIN_FIRST_NAME, lastName: config.BOOTSTRAP_ADMIN_LAST_NAME,
      });
      log.info({ admin: result }, result === 'created' ? 'administrator created' : 'administrator already exists: left unchanged');
    }
    // The store reviewers' student account (Google Play, App Store).
    if (config.REVIEW_STUDENT_PHONE) {
      const result = await ensureReviewStudent(client, db, systemClock, { phone: config.REVIEW_STUDENT_PHONE, password: config.REVIEW_STUDENT_PASSWORD, termsVersion: TERMS_VERSION });
      log.info({ reviewStudent: result }, result === 'created' ? 'review student created (Student Test)' : 'review student already exists: left unchanged');
    }
  } finally {
    await client.close();
  }
}
