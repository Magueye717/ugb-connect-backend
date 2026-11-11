import type { Job } from 'bullmq';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { ObjectId, type Db, type MongoClient } from 'mongodb';

import type { Config } from '../../config/env.js';
import type { Clock } from '../../platform/clock.js';
import type { Queues } from '../../platform/queue/queues.js';
import type { AccountsApi } from '../accounts/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type { OrganizationsApi } from '../organizations/index.js';
import { paymentsCollections } from './payments.collections.js';
import { registerPaymentsRoutes } from './payments.routes.js';
import { PAYMENTS_SWEEP_QUEUE, PAYOUT_QUEUE, PaymentsService } from './payments.service.js';
import { SimulatedProvider } from './providers.js';

export { paymentsCollections };
export { PaymentView, PayoutView } from './payments.routes.js';
export { paymentView, payoutView } from './payments.service.js';
export { PAYMENT_METHODS } from './payments.types.js';
export type { MethodStatus, PaymentDoc, PaymentMethod, PayoutDoc, PurposeHandler } from './payments.types.js';

/** Public surface of payments: other modules reserve, pay and refund through this, never through the collections. */
export type PaymentsApi = Pick<
  PaymentsService,
  'registerPurpose' | 'assertAvailable' | 'validateReturnUrl' | 'create' | 'openCheckout' | 'cancelInSession' | 'createPayout' | 'schedulePayouts' | 'findById' | 'findPayout'
> & {
  registerRoutes(app: FastifyInstance, requireFinance: preHandlerHookHandler, requireAdmin: preHandlerHookHandler): void;
  processors(): Record<string, (job: Job) => Promise<unknown>>;
  /** Repeating jobs the worker keeps scheduled. */
  schedules: { queue: string; everyMs: number }[];
  /** Used by tests and the worker. */
  sweep(): Promise<number>;
  executePayout(id: ObjectId): ReturnType<PaymentsService['executePayout']>;
};

export function createPaymentsModule(d: { db: Db; mongo: MongoClient; clock: Clock; config: Config; queues: Queues; accounts: AccountsApi; notifications: NotificationsApi; organizations?: Pick<OrganizationsApi, 'teamLeadIds'> }): PaymentsApi {
  const simulated = d.config.PAYMENTS_SIMULATOR ? new SimulatedProvider(d.config.SIMULATOR_WEBHOOK_SECRET, d.clock) : undefined;
  const service = new PaymentsService(d.db, d.mongo, d.clock, d.config, d.queues, d.accounts, { simulated }, d.notifications, () => d.organizations?.teamLeadIds() ?? Promise.resolve([]));
  return {
    registerPurpose: (p, h) => service.registerPurpose(p, h),
    assertAvailable: (m) => service.assertAvailable(m),
    validateReturnUrl: (u) => service.validateReturnUrl(u),
    create: (i, s) => service.create(i, s),
    openCheckout: (p, b) => service.openCheckout(p, b),
    cancelInSession: (id, s) => service.cancelInSession(id, s),
    createPayout: (i, s) => service.createPayout(i, s),
    schedulePayouts: (ids) => service.schedulePayouts(ids),
    findById: (id, s) => service.findById(id, s),
    findPayout: (id) => service.findPayout(id),
    sweep: () => service.sweep(),
    executePayout: (id) => service.executePayout(id),
    registerRoutes: (app, requireFinance, requireAdmin) => registerPaymentsRoutes(app, { service, config: d.config, clock: d.clock, requireFinance, requireAdmin }),
    processors: () => ({
      [PAYOUT_QUEUE]: async (job: Job) => service.executePayout(new ObjectId(String(job.data.payoutId))),
      [PAYMENTS_SWEEP_QUEUE]: async () => service.sweep(),
    }),
    schedules: [{ queue: PAYMENTS_SWEEP_QUEUE, everyMs: 30_000 }],
  };
}
