import type { Db } from 'mongodb';

import type { CollectionSpec } from './platform/db/schema.js';
import { applyCollectionSpecs } from './platform/db/schema.js';
import { applyDataMigrations, type DataMigration } from './platform/db/migrations.js';
import { accountsCollections, accountsMigrations } from './modules/accounts/index.js';
import { auditCollections } from './modules/audit/index.js';
import { identityCollections } from './modules/identity/index.js';
import { organizationsCollections, organizationsMigrations } from './modules/organizations/index.js';
import { messagingCollections } from './modules/messaging/index.js';
import { notificationsCollections } from './modules/notifications/index.js';
import { paymentsCollections } from './modules/payments/index.js';
import { taxiCollections } from './modules/taxi/index.js';
import { ticketingCollections, ticketingMigrations } from './modules/ticketing/index.js';
import { caravansCollections, caravansMigrations } from './modules/caravans/index.js';
import { alertsCollections, alertsMigrations } from './modules/alerts/index.js';
import { mediaCollections } from './modules/media/index.js';
import { eventsCollections, eventsMigrations } from './modules/events/index.js';
import { bannersCollections } from './modules/banners/index.js';
import { publicRestosCollections, publicRestosMigrations } from './modules/public-restos/index.js';
import { housingCollections } from './modules/housing/index.js';
import { lostCollections } from './modules/lost/index.js';
import { commerceCollections, commerceMigrations } from './modules/commerce/index.js';
import { placesCollections, placesMigrations } from './modules/places/index.js';
import { ratingsCollections, ratingsMigrations } from './modules/ratings/index.js';

/** Every collection the application owns: validators and indexes. */
export const allCollections: CollectionSpec[] = [
  ...auditCollections, ...accountsCollections, ...identityCollections, ...organizationsCollections, ...paymentsCollections, ...messagingCollections, ...taxiCollections,
  ...ticketingCollections, ...caravansCollections, ...notificationsCollections, ...alertsCollections, ...publicRestosCollections, ...mediaCollections, ...eventsCollections, ...bannersCollections, ...lostCollections, ...housingCollections, ...commerceCollections, ...placesCollections, ...ratingsCollections,
];

/** One-time data changes, in the order they were written. */
export const allDataMigrations: DataMigration[] = [...organizationsMigrations, ...accountsMigrations, ...ticketingMigrations, ...caravansMigrations, ...publicRestosMigrations, ...alertsMigrations, ...eventsMigrations, ...commerceMigrations, ...ratingsMigrations, ...placesMigrations];

/**
 * Brings a database up to date (`npm run migrate`, the seed and the tests).
 * Validators first, then data: the new validator describes the migrated shape, and MongoDB only checks documents when they are written.
 */
export async function migrateDatabase(db: Db) {
  await applyCollectionSpecs(db, allCollections);
  return applyDataMigrations(db, allDataMigrations);
}
