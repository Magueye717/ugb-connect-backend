import { ObjectId, type ClientSession, type Collection, type Db, type MongoClient } from 'mongodb';

import type { Config } from '../../config/env.js';
import type { Clock } from '../../platform/clock.js';
import { isDuplicateKey, withTransaction } from '../../platform/db/mongo.js';
import { AppError, errors } from '../../platform/http/errors.js';
import { maskPhone } from '../../platform/phone.js';
import type { Queues } from '../../platform/queue/queues.js';
import { randomCode } from '../../platform/security/crypto.js';
import type { AccountsApi } from '../accounts/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type {
  NewPayout,
  PaymentDoc,
  MethodStatus,
  PaymentEventDoc,
  PaymentMethod,
  PaymentSettingsDoc,
  PaymentPurpose,
  PaymentStatus,
  PayoutDoc,
  ProviderId,
  PurposeHandler,
} from './payments.types.js';
import { PAYMENT_METHODS } from './payments.types.js';
import type { PaymentProvider, ProviderEvent } from './providers.js';

export const PAYOUT_QUEUE = 'payments.payout';
export const PAYMENTS_SWEEP_QUEUE = 'payments.sweep';
const MAX_PAYOUT_ATTEMPTS = 5;
/** The switches are read on every payment: kept this long in memory (each API instance), refreshed on change here. */
const SETTINGS_TTL_MS = 10_000;
export const METHOD_LABEL: Record<PaymentMethod, string> = { wave: 'Wave', orange_money: 'Orange Money' };

/** Deep links the checkout page may send the student back to: the app's scheme, and Expo Go in development. */
// The app's link scheme (ugbconnect://); the old one stays accepted for builds installed before the rename.
const RETURN_SCHEMES = ['ugbconnect:', 'ugbcampus:'];
const DEV_RETURN_SCHEMES = ['exp:', 'exps:'];

export type NewPayment = {
  userId: ObjectId;
  purpose: PaymentPurpose;
  purposeRef: ObjectId;
  amount: number;
  method: PaymentMethod;
  description: string;
  expiresAt: Date;
  returnUrl?: string | null;
};

export const paymentView = (p: PaymentDoc) => ({
  reference: p.reference,
  status: p.status,
  fulfillment: p.fulfillment,
  amount: p.amount,
  currency: p.currency,
  method: p.method,
  purpose: p.purpose,
  purposeRef: p.purposeRef.toHexString(),
  checkoutUrl: p.status === 'created' || p.status === 'pending' ? p.checkoutUrl : null,
  expiresAt: p.expiresAt.toISOString(),
});

export const payoutView = (p: PayoutDoc) => ({
  id: p._id.toHexString(),
  kind: p.kind,
  reason: p.reason,
  amount: p.amount,
  method: p.method,
  status: p.status,
  phoneMasked: maskPhone(p.phone),
  createdAt: p.createdAt.toISOString(),
});

export class PaymentsService {
  private readonly payments: Collection<PaymentDoc>;
  private readonly events: Collection<PaymentEventDoc>;
  private readonly payouts: Collection<PayoutDoc>;
  private readonly settings: Collection<PaymentSettingsDoc>;
  private readonly handlers = new Map<PaymentPurpose, PurposeHandler>();
  private cached: { at: number; doc: PaymentSettingsDoc | null } | null = null;

  constructor(
    db: Db,
    private readonly mongo: MongoClient,
    private readonly clock: Clock,
    private readonly config: Config,
    private readonly queues: Queues,
    private readonly accounts: AccountsApi,
    private readonly providers: Partial<Record<ProviderId, PaymentProvider>>,
    private readonly notifications: NotificationsApi,
    /** Owners and managers of every active business and organizer: told when a method is switched off or back on. */
    private readonly teamLeads: () => Promise<ObjectId[]> = async () => [],
  ) {
    this.settings = db.collection('paymentSettings');
    this.payments = db.collection('payments');
    this.events = db.collection('paymentEvents');
    this.payouts = db.collection('payouts');
  }

  registerPurpose(purpose: PaymentPurpose, handler: PurposeHandler) {
    this.handlers.set(purpose, handler);
  }

  private handler(purpose: PaymentPurpose) {
    const h = this.handlers.get(purpose);
    if (!h) throw new Error(`No payment handler registered for ${purpose}`);
    return h;
  }

  /** Wave and Orange Money both go through the simulator in development; real adapters are not wired yet (Q-1). */
  private providerFor(_method: PaymentMethod): PaymentProvider {
    const p = this.config.PAYMENTS_SIMULATOR ? this.providers.simulated : undefined;
    if (!p) throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'Le paiement est momentanément indisponible. Réessaie plus tard.');
    return p;
  }

  /** Throws when no provider can take payments (or the admins switched this method off), before anything is reserved. */
  async assertAvailable(method: PaymentMethod) {
    this.providerFor(method);
    const off = (await this.settingsDoc())?.off[method];
    if (off) {
      const other = PAYMENT_METHODS.filter((m) => m !== method).map((m) => METHOD_LABEL[m]).join(' ou ');
      throw new AppError(503, 'METHOD_OFF', `${METHOD_LABEL[method]} est momentanément désactivé. Paie avec ${other}, ou en espèces quand c’est possible.`, { method });
    }
  }

  private async settingsDoc() {
    const now = Date.now();
    if (!this.cached || now - this.cached.at > SETTINGS_TTL_MS) this.cached = { at: now, doc: await this.settings.findOne({ _id: 'methods' }) };
    return this.cached.doc;
  }

  /** Each method: on, or off since when (shown in the app: banner on the home, greyed choice). */
  async methods(): Promise<MethodStatus[]> {
    const off = (await this.settingsDoc())?.off ?? {};
    return PAYMENT_METHODS.map((method) => ({ method, available: !off[method], offSince: off[method]?.since.toISOString() ?? null, note: off[method]?.note ?? null }));
  }

  /**
   * The admins switch a method off (an outage at Wave…) or back on. Off: businesses and organizers are told (their
   * clients can't pay that way), and so are students whose payment with it is still waiting. Back on: businesses and
   * organizers again. Everyone else sees the banner on the home.
   */
  async setMethod(method: PaymentMethod, enabled: boolean, by: ObjectId, note: string | null) {
    const now = this.clock.now();
    const current = (await this.settings.findOne({ _id: 'methods' }))?.off[method];
    if (!enabled === !!current) return this.methods();
    const clean = note?.trim().replace(/\s+/g, ' ').slice(0, 200) || null;
    await this.settings.updateOne(
      { _id: 'methods' },
      enabled ? { $unset: { [`off.${method}`]: '' }, $set: { updatedAt: now } } : { $set: { [`off.${method}`]: { since: now, by, note: clean }, updatedAt: now } },
      { upsert: true },
    );
    this.cached = null;
    const name = METHOD_LABEL[method];
    const stamp = now.getTime();
    const leads = await this.teamLeads();
    if (!enabled) {
      const waiting = await this.payments.distinct('userId', { method, status: { $in: ['created', 'pending'] }, expiresAt: { $gt: now } });
      await this.notifications.notify(leads, {
        type: 'payments.method_off', category: 'paiements', icon: 'alert-circle', tone: 'warning', dedupeKey: `payments.method_off:${method}:${stamp}`,
        title: `${name} momentanément désactivé`,
        body: `Tes clients ne peuvent plus payer avec ${name} pour l’instant : les autres moyens et les espèces restent possibles.${clean ? ` ${clean}` : ''}`,
      });
      await this.notifications.notify(waiting as ObjectId[], {
        type: 'payments.method_off_pending', category: 'paiements', icon: 'time', tone: 'warning', dedupeKey: `payments.method_off_pending:${method}:${stamp}`,
        title: `${name} momentanément désactivé`,
        body: `Ton paiement ${name} en attente risque de ne pas aboutir. S’il échoue, recommence avec un autre moyen de paiement.`,
      });
    } else {
      await this.notifications.notify(leads, {
        type: 'payments.method_on', category: 'paiements', icon: 'checkmark-circle', tone: 'success', dedupeKey: `payments.method_on:${method}:${stamp}`,
        title: `${name} est de retour`,
        body: `Tes clients peuvent de nouveau payer avec ${name}.`,
      });
    }
    return this.methods();
  }

  validateReturnUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw errors.validation('Adresse de retour invalide.', { field: 'returnUrl' });
    }
    // Staging is tested from Expo Go too.
    const allowed = this.config.isProduction && !this.config.STAGING ? RETURN_SCHEMES : [...RETURN_SCHEMES, ...DEV_RETURN_SCHEMES];
    if (!allowed.includes(parsed.protocol)) throw errors.validation('Adresse de retour invalide.', { field: 'returnUrl' });
    return url;
  }

  /** Inside the caller's transaction, next to what the payment reserves (a seat…). Checkout is opened after commit. */
  async create(input: NewPayment, session: ClientSession): Promise<PaymentDoc> {
    const now = this.clock.now();
    const provider = this.providerFor(input.method);
    const doc: PaymentDoc = {
      _id: new ObjectId(),
      reference: `PAY_${randomCode(20)}`,
      userId: input.userId,
      purpose: input.purpose,
      purposeRef: input.purposeRef,
      amount: input.amount,
      currency: 'XOF',
      method: input.method,
      provider: provider.id,
      description: input.description,
      providerSessionId: null,
      providerTxnId: null,
      checkoutUrl: null,
      returnUrl: this.validateReturnUrl(input.returnUrl),
      status: 'created',
      fulfillment: 'pending',
      expiresAt: input.expiresAt,
      statusHistory: [{ status: 'created', at: now, source: 'system' }],
      createdAt: now,
      updatedAt: now,
    };
    await this.payments.insertOne(doc, { session });
    return doc;
  }

  /** Opens the provider checkout. On failure the payment closes and its handler releases what it held. */
  async openCheckout(payment: PaymentDoc, baseUrl: string): Promise<PaymentDoc> {
    if (payment.checkoutUrl) return payment;
    try {
      const { sessionId, checkoutUrl } = await this.providerFor(payment.method).createCheckout({
        reference: payment.reference,
        amount: payment.amount,
        description: payment.description,
        expiresAt: payment.expiresAt,
        baseUrl: this.config.PUBLIC_API_URL ?? baseUrl,
      });
      const now = this.clock.now();
      const updated = await this.payments.findOneAndUpdate(
        { _id: payment._id, status: 'created' },
        { $set: { status: 'pending', providerSessionId: sessionId, checkoutUrl, updatedAt: now }, $push: { statusHistory: { status: 'pending', at: now, source: 'system' } } },
        { returnDocument: 'after' },
      );
      return updated ?? (await this.payments.findOne({ _id: payment._id }))!;
    } catch (err) {
      await this.close(payment.reference, 'failed', 'system');
      throw err;
    }
  }

  async getForUser(reference: string, userId: ObjectId) {
    const p = await this.payments.findOne({ reference, userId });
    if (!p) throw errors.notFound('Paiement introuvable.');
    return p;
  }

  findByReference(reference: string) {
    return this.payments.findOne({ reference });
  }

  findById(id: ObjectId, session?: ClientSession) {
    return this.payments.findOne({ _id: id }, { session });
  }

  // ---- Webhooks ------------------------------------------------------------------------------------------------

  /**
   * Stores the event (invalid ones too, never processed), then processes it once. A duplicate of an event that
   * was already processed is a no-op; a duplicate of one that failed half-way is processed again.
   */
  async receiveWebhook(providerId: ProviderId, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ status: 200 | 401; outcome: string }> {
    const provider = this.providers[providerId];
    if (!provider) return { status: 401, outcome: 'unknown_provider' };
    const now = this.clock.now();
    const event = provider.verifyWebhook(rawBody, headers);
    if (!event) {
      await this.events.insertOne({
        _id: new ObjectId(), provider: providerId, providerEventId: `invalid_${new ObjectId().toHexString()}`, type: 'invalid',
        payload: { size: rawBody.length }, signatureValid: false, receivedAt: now, processedAt: now, outcome: 'invalid_signature',
      });
      return { status: 401, outcome: 'invalid_signature' };
    }

    let doc: PaymentEventDoc | null = {
      _id: new ObjectId(), provider: providerId, providerEventId: event.eventId, type: event.type,
      payload: { reference: event.reference, outcome: event.outcome, amount: event.amount, currency: event.currency, transactionId: event.transactionId },
      signatureValid: true, receivedAt: now, processedAt: null, outcome: null,
    };
    try {
      await this.events.insertOne(doc);
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      doc = await this.events.findOne({ provider: providerId, providerEventId: event.eventId });
      if (!doc || doc.processedAt) return { status: 200, outcome: 'duplicate' };
    }

    const outcome = await this.apply(event);
    await this.events.updateOne({ _id: doc._id }, { $set: { processedAt: this.clock.now(), outcome } });
    return { status: 200, outcome };
  }

  private async apply(event: ProviderEvent): Promise<string> {
    const payment = await this.payments.findOne({ reference: event.reference });
    if (!payment) return 'unknown_reference';
    if (event.outcome !== 'succeeded') {
      await this.close(payment.reference, event.outcome, 'webhook');
      return event.outcome;
    }
    // Never trust the amount on our side of the checkout only: the provider must confirm exactly what we asked.
    if (event.amount !== payment.amount || event.currency !== payment.currency) return 'amount_mismatch';
    return this.succeed(payment, event.transactionId);
  }

  /**
   * Money arrived. Also accepted after expiry or cancellation (late payment): the handler decides whether it can
   * still deliver, otherwise the student is refunded.
   */
  private async succeed(payment: PaymentDoc, txnId: string | null): Promise<string> {
    const payoutIds: ObjectId[] = [];
    const result = await withTransaction(this.mongo, async (session) => {
      payoutIds.length = 0;
      const now = this.clock.now();
      const updated = await this.payments.findOneAndUpdate(
        { _id: payment._id, status: { $in: ['created', 'pending', 'expired', 'cancelled'] } },
        { $set: { status: 'succeeded', providerTxnId: txnId, updatedAt: now }, $push: { statusHistory: { status: 'succeeded', at: now, source: 'webhook' } } },
        { returnDocument: 'after', session },
      );
      if (!updated) return 'already_settled';
      const fulfillment = await this.handler(updated.purpose).onSucceeded(updated, session);
      await this.payments.updateOne({ _id: updated._id }, { $set: { fulfillment } }, { session });
      if (fulfillment === 'unfulfillable') {
        const payout = await this.createPayout(
          {
            kind: 'refund', beneficiaryUserId: updated.userId, method: updated.method, amount: updated.amount,
            reason: 'late_payment_unfulfillable', source: { type: 'payment', id: updated._id }, idempotencyKey: `payment:${updated._id.toHexString()}:unfulfillable`,
          },
          session,
        );
        payoutIds.push(payout._id);
      }
      return fulfillment === 'fulfilled' ? 'succeeded' : 'refunded';
    });
    await this.schedulePayouts(payoutIds);
    return result;
  }

  /** Ends a payment that brought no money; the purpose handler releases its hold. Idempotent. */
  async close(reference: string, status: Extract<PaymentStatus, 'failed' | 'cancelled' | 'expired'>, source: PaymentDoc['statusHistory'][number]['source']) {
    await withTransaction(this.mongo, async (session) => {
      const now = this.clock.now();
      const updated = await this.payments.findOneAndUpdate(
        { reference, status: { $in: ['created', 'pending'] } },
        { $set: { status, updatedAt: now }, $push: { statusHistory: { status, at: now, source } } },
        { returnDocument: 'after', session },
      );
      if (updated) await this.handler(updated.purpose).onClosed(updated, session);
    });
  }

  /**
   * For the owning module, inside its own transaction (the student left before paying): no handler call, the
   * caller already released what the payment held.
   */
  async cancelInSession(paymentId: ObjectId, session: ClientSession) {
    const now = this.clock.now();
    await this.payments.updateOne(
      { _id: paymentId, status: { $in: ['created', 'pending'] } },
      { $set: { status: 'cancelled', updatedAt: now }, $push: { statusHistory: { status: 'cancelled', at: now, source: 'user' } } },
      { session },
    );
  }

  /** Pending payments past their expiry (the student never paid): closed, holds released. */
  async sweep() {
    const now = this.clock.now();
    const stale = await this.payments.find({ status: { $in: ['created', 'pending'] }, expiresAt: { $lte: now } }, { projection: { reference: 1 } }).limit(500).toArray();
    for (const p of stale) await this.close(p.reference, 'expired', 'system');
    return stale.length;
  }

  // ---- Payouts -------------------------------------------------------------------------------------------------

  /**
   * Records money owed to someone, inside the business transaction that decided it. The idempotency key makes a
   * retried request or job return the existing payout instead of paying twice. Execution is a job (schedulePayouts).
   */
  async createPayout(input: NewPayout, session: ClientSession): Promise<PayoutDoc> {
    const existing = await this.payouts.findOne({ idempotencyKey: input.idempotencyKey }, { session });
    if (existing) return existing;
    const user = await this.accounts.findById(input.beneficiaryUserId);
    if (!user) throw errors.notFound();
    const now = this.clock.now();
    const { payTo, ...rest } = input;
    const doc: PayoutDoc = {
      _id: new ObjectId(),
      ...rest,
      beneficiaryOrgId: payTo?.orgId ?? null,
      phone: payTo?.phone ?? user.payoutAccount.phone,
      provider: this.config.PAYMENTS_SIMULATOR ? 'simulated' : input.method,
      status: 'requested',
      providerTransferId: null,
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.payouts.insertOne(doc, { session });
    return doc;
  }

  /** After commit: one job per payout, keyed by its id so a retried request doesn't queue it twice. */
  async schedulePayouts(ids: ObjectId[]) {
    for (const id of ids) await this.queues.add(PAYOUT_QUEUE, { payoutId: id.toHexString() }, { jobId: `payout-${id.toHexString()}` });
  }

  /** Worker: sends the money. Without a provider able to disburse, the payout waits for finance (manual). */
  async executePayout(id: ObjectId) {
    const now = this.clock.now();
    const payout = await this.payouts.findOneAndUpdate(
      { _id: id, status: { $in: ['requested', 'failed'] } },
      { $set: { status: 'processing', updatedAt: now }, $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    if (!payout) return null;
    const provider = this.providers[payout.provider];
    if (!provider) {
      await this.payouts.updateOne({ _id: id }, { $set: { status: 'manual_required', lastError: 'no provider', updatedAt: this.clock.now() } });
      return 'manual_required';
    }
    try {
      const { transferId } = await provider.disburse({ phone: payout.phone, amount: payout.amount, idempotencyKey: payout.idempotencyKey });
      await this.payouts.updateOne({ _id: id }, { $set: { status: 'succeeded', providerTransferId: transferId, lastError: null, updatedAt: this.clock.now() } });
      const amount = `${String(payout.amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
      const where = payout.method === 'wave' ? 'Wave' : 'Orange Money';
      await this.notifications.notify([payout.beneficiaryUserId], {
        type: `payout.${payout.kind}`, category: 'paiements', icon: 'wallet-outline', tone: 'success', url: null, dedupeKey: `payout:${id.toHexString()}`,
        title: payout.kind === 'refund' ? `Remboursement de ${amount} envoyé` : `Versement de ${amount} envoyé`,
        body: payout.beneficiaryOrgId ? `Sur le ${where} de l’organisation (${maskPhone(payout.phone)}).` : `Sur ton ${where} (${maskPhone(payout.phone)}).`,
      });
      return 'succeeded';
    } catch (err) {
      const status = payout.attempts >= MAX_PAYOUT_ATTEMPTS ? 'manual_required' : 'failed';
      await this.payouts.updateOne({ _id: id }, { $set: { status, lastError: (err as Error).message.slice(0, 200), updatedAt: this.clock.now() } });
      if (status === 'failed') throw err; // BullMQ retries with backoff
      return status;
    }
  }

  findPayout(id: ObjectId) {
    return this.payouts.findOne({ _id: id });
  }

  listPayouts(filter: { status?: PayoutDoc['status']; userId?: ObjectId }, limit = 50) {
    return this.payouts
      .find({ ...(filter.status ? { status: filter.status } : {}), ...(filter.userId ? { beneficiaryUserId: filter.userId } : {}) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }
}
