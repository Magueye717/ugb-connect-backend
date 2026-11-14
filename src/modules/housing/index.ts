import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db, MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { AccountsApi } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { MessagingApi } from '../messaging/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { housingCollections } from './housing.collections.js';
import { registerHousingRoutes } from './housing.routes.js';
import { HousingService } from './housing.service.js';

export { housingCollections };

export type HousingApi = {
  registerRoutes(app: FastifyInstance, requireAdmin: preHandlerHookHandler): void;
  /** Tests and the seed. */
  service: HousingService;
};

/** Campus housing between students: room swaps, hosting, roommates; private chats with the authors. */
export function createHousingModule(d: { db: Db; mongo: MongoClient; clock: Clock; accounts: AccountsApi; messaging: MessagingApi; notifications: NotificationsApi; limiter: Limiter; audit: AuditApi }): HousingApi {
  const service = new HousingService(d.db, d.mongo, d.clock, d.accounts, d.messaging, d.notifications, d.limiter);
  return {
    registerRoutes: (app, requireAdmin) => registerHousingRoutes(app, { service, audit: d.audit, requireStudent: d.accounts.requireStudent, requireAdmin }),
    service,
  };
}
