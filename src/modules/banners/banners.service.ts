import { ObjectId, type Collection, type Db, type MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { afterCommit, withTransaction } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { EventsApi } from '../events/index.js';
import type { MediaApi } from '../media/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type { OrganizationsApi } from '../organizations/index.js';
import type { PaymentMethod, PaymentsApi, PurposeHandler } from '../payments/index.js';
import { MAX_BANNERS_PER_DAY, PAY_WITHIN_MIN, type BannerDoc, type BannerKind, type BannerPackageDoc, type CtaTarget } from './banners.types.js';

const DAY = 24 * 3_600_000;
const dakarDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Dakar', year: 'numeric', month: '2-digit', day: '2-digit' });
/** "2026-11-05" → midnight in Dakar (UTC+0 all year). */
const midnight = (date: string) => new Date(`${date}T00:00:00.000Z`);
const MY_BANNERS = '/mes-publicites';
/** Statuses that hold a place on the carousel's calendar. */
const HOLDING = ['pending_payment', 'pending_review', 'approved'] as const;

export type NewBanner = {
  kind: BannerKind;
  orgId?: string;
  eventId?: string;
  title?: string;
  description?: string;
  imageId?: string;
  cta?: { label: string; target: CtaTarget; value: string } | null;
  packageCode: string;
  startsOn: string;
  method: PaymentMethod;
  returnUrl?: string | null;
};

export class BannersService {
  private readonly banners: Collection<BannerDoc>;
  private readonly packages: Collection<BannerPackageDoc>;

  constructor(
    db: Db,
    private readonly mongo: MongoClient,
    private readonly clock: Clock,
    private readonly payments: PaymentsApi,
    private readonly media: MediaApi,
    private readonly events: EventsApi,
    private readonly organizations: OrganizationsApi,
    private readonly limiter: Limiter,
    private readonly notifications: NotificationsApi,
  ) {
    this.banners = db.collection('banners');
    this.packages = db.collection('bannerPackages');
  }

  // ---- Packages (admin) -----------------------------------------------------------------------------------------

  listPackages(all = false) {
    return this.packages.find(all ? {} : { active: true }).sort({ sortOrder: 1, days: 1 }).toArray();
  }

  async putPackage(code: string, input: { name: string; days: number; price: number; active: boolean; sortOrder?: number }) {
    const now = this.clock.now();
    return (await this.packages.findOneAndUpdate(
      { code },
      { $set: { name: input.name.trim(), days: input.days, price: input.price, active: input.active, sortOrder: input.sortOrder ?? input.days, updatedAt: now }, $setOnInsert: { _id: new ObjectId(), code, createdAt: now } },
      { upsert: true, returnDocument: 'after' },
    ))!;
  }

  // ---- Home carousel --------------------------------------------------------------------------------------------

  /** Approved banners running now, with what the carousel shows of their event. */
  async live() {
    const now = this.clock.now();
    const docs = await this.banners.find({ status: 'approved', startsAt: { $lte: now }, endsAt: { $gt: now } }).sort({ startsAt: 1, createdAt: 1 }).limit(MAX_BANNERS_PER_DAY).toArray();
    const events = await this.events.summaries(docs.flatMap((b) => (b.eventId ? [b.eventId] : [])));
    // An event cancelled or over in the meantime leaves the carousel.
    return docs
      .map((b) => ({ b, event: b.eventId ? (events.get(b.eventId.toHexString()) ?? null) : null }))
      .filter(({ b, event }) => b.kind === 'ad' || (event && event.status === 'published'));
  }

  // ---- Publishers -----------------------------------------------------------------------------------------------

  /**
   * Books a slot and opens the payment. Ads: anyone. Events: an owner or manager of the organization, for one of its
   * published events (cover and title taken from the event unless given). The banner then waits for the review.
   */
  async create(ownerId: ObjectId, input: NewBanner, baseUrl: string) {
    await this.limiter.hit(`banner-create:${ownerId.toHexString()}`, { limit: 10, windowS: 3600 });
    await this.payments.assertAvailable(input.method);
    const returnUrl = this.payments.validateReturnUrl(input.returnUrl);
    const pkg = await this.packages.findOne({ code: input.packageCode, active: true });
    if (!pkg) throw errors.validation('Choisis une formule.', { field: 'packageCode' });
    const now = this.clock.now();
    // From today: validated later in the day, it runs from then until the end of its period.
    const today = dakarDay.format(now);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn) || input.startsOn < today) {
      throw errors.validation('La diffusion commence au plus tôt aujourd’hui.', { field: 'startsOn' });
    }
    const startsAt = midnight(input.startsOn);
    if (startsAt.getTime() > now.getTime() + 90 * DAY) throw errors.validation('Trois mois à l’avance au plus.', { field: 'startsOn' });
    const endsAt = new Date(startsAt.getTime() + pkg.days * DAY);

    let orgId: ObjectId | null = null;
    let eventId: ObjectId | null = null;
    let title = input.title?.trim() ?? '';
    let image = input.imageId ? (await this.media.claim(ownerId, [input.imageId]))[0]! : null;
    let cta = input.cta ?? null;
    if (input.kind === 'event') {
      if (!input.orgId || !input.eventId || !ObjectId.isValid(input.orgId) || !ObjectId.isValid(input.eventId)) throw errors.validation('Choisis ton événement.', { field: 'eventId' });
      orgId = new ObjectId(input.orgId);
      if (!(await this.organizations.roleIn(orgId, ownerId, ['owner', 'manager'], 'organizer'))) throw errors.forbidden('Seuls les responsables de l’organisation peuvent promouvoir ses événements.');
      const e = await this.events.promotable(orgId, new ObjectId(input.eventId));
      eventId = e._id;
      // One banner at a time per event: a new one once the current one has ended (or was refused, cancelled…).
      const running = await this.banners.findOne(
        { eventId, endsAt: { $gt: now }, $or: [{ status: { $in: ['pending_review', 'approved'] } }, { status: 'pending_payment', createdAt: { $gt: new Date(now.getTime() - PAY_WITHIN_MIN * 60_000) } }] },
        { sort: { endsAt: -1 } },
      );
      if (running) {
        throw errors.conflict('EVENT_ALREADY_PROMOTED', `Cet événement est déjà en bannière jusqu’au ${running.endsAt.toLocaleDateString('fr-FR', { timeZone: 'Africa/Dakar', day: 'numeric', month: 'long' })}. Tu pourras en reprendre une après.`);
      }
      title ||= e.title.slice(0, 40);
      image ??= e.images[0]!;
      // The event page is the details.
      cta = null;
      if (endsAt.getTime() > e.endsAt.getTime() + DAY) throw errors.validation('La diffusion dépasse la date de l’événement : choisis une formule plus courte.', { field: 'packageCode' });
    } else {
      if (!image) throw errors.validation('Ajoute une image.', { field: 'imageId' });
      if (cta) this.checkCta(cta);
    }
    if (title.length < 3) throw errors.validation('Ajoute un titre court.', { field: 'title' });
    await this.checkRoom(startsAt, endsAt);

    const bannerId = new ObjectId();
    const created = await withTransaction(this.mongo, async (session) => {
      const payment = await this.payments.create(
        { userId: ownerId, purpose: 'banner', purposeRef: bannerId, amount: pkg.price, method: input.method, description: `Bannière « ${title} » · ${pkg.name}`, expiresAt: new Date(now.getTime() + PAY_WITHIN_MIN * 60_000), returnUrl },
        session,
      );
      const doc: BannerDoc = {
        _id: bannerId, kind: input.kind, ownerId, orgId, eventId, title, description: input.description?.trim() ?? '', image: image!, ownImage: !!input.imageId, cta,
        packageCode: pkg.code, days: pkg.days, price: pkg.price, method: input.method, startsAt, endsAt, status: 'pending_payment', paymentId: payment._id,
        review: null, refundPayoutId: null, createdAt: now, updatedAt: now,
      };
      await this.banners.insertOne(doc, { session });
      return { banner: doc, payment };
    });
    return { banner: created.banner, payment: await this.payments.openCheckout(created.payment, baseUrl) };
  }

  private checkCta(cta: { target: CtaTarget; value: string }) {
    const ok = {
      app: /^\/[A-Za-z0-9/_?=&().-]*$/.test(cta.value),
      url: /^https:\/\/[^\s]+$/.test(cta.value),
      whatsapp: /^\+?221\s?7[05678](\s?\d){7}$/.test(cta.value) || /^7[05678](\s?\d){7}$/.test(cta.value),
      phone: /^\+?221\s?7[05678](\s?\d){7}$/.test(cta.value) || /^7[05678](\s?\d){7}$/.test(cta.value),
    }[cta.target];
    if (!ok) throw errors.validation(cta.target === 'url' ? 'Le lien doit commencer par https://' : cta.target === 'app' ? 'Écran de l’app invalide.' : 'Numéro invalide.', { field: 'cta' });
  }

  /** Is there room on the carousel every day of the period? */
  private async checkRoom(startsAt: Date, endsAt: Date) {
    const now = this.clock.now();
    const overlapping = await this.banners
      .find({ status: { $in: [...HOLDING] }, startsAt: { $lt: endsAt }, endsAt: { $gt: startsAt }, $or: [{ status: { $ne: 'pending_payment' } }, { createdAt: { $gt: new Date(now.getTime() - PAY_WITHIN_MIN * 60_000) } }] }, { projection: { startsAt: 1, endsAt: 1 } })
      .toArray();
    for (let d = startsAt.getTime(); d < endsAt.getTime(); d += DAY) {
      const count = overlapping.filter((b) => b.startsAt.getTime() <= d && b.endsAt.getTime() > d).length;
      if (count >= MAX_BANNERS_PER_DAY) {
        throw errors.conflict('NO_BANNER_SLOT', `Plus de place sur l’accueil le ${new Date(d).toLocaleDateString('fr-FR', { timeZone: 'Africa/Dakar', day: 'numeric', month: 'long' })}. Choisis une autre date.`);
      }
    }
  }

  mine(ownerId: ObjectId) {
    return this.banners.find({ ownerId, removedAt: { $exists: false } }).sort({ createdAt: -1 }).limit(50).toArray();
  }

  /**
   * « Supprimer » from « Mes publicités » (swipe): only once it's settled (refused, cancelled, withdrawn, or its
   * diffusion over). Taken off the owner's list only: the paid record stays for the team and the accounts.
   * Waiting (payment, review): cancel it first (refunded). Showing now: it runs to its end.
   */
  async remove(ownerId: ObjectId, id: ObjectId) {
    const b = await this.banners.findOne({ _id: id, ownerId });
    if (!b) throw errors.notFound('Bannière introuvable.');
    const now = this.clock.now();
    if (b.status === 'pending_payment' || b.status === 'pending_review') throw errors.conflict('BANNER_PENDING', 'Annule d’abord cette bannière (elle t’est remboursée si tu l’as payée).');
    if (b.status === 'approved' && b.endsAt > now) throw errors.conflict('BANNER_RUNNING', 'Cette bannière est en diffusion : elle disparaît de ta liste après sa fin.');
    await this.banners.updateOne({ _id: id, ownerId }, { $set: { removedAt: now, updatedAt: now } });
  }

  /** Before the review: given up, refunded. Unpaid: the slot goes back. */
  async cancel(ownerId: ObjectId, id: ObjectId) {
    const b = await this.banners.findOne({ _id: id, ownerId });
    if (!b) throw errors.notFound('Bannière introuvable.');
    if (b.status === 'pending_payment') {
      await withTransaction(this.mongo, async (session) => {
        const res = await this.banners.updateOne({ _id: id, status: 'pending_payment' }, { $set: { status: 'cancelled', updatedAt: this.clock.now() } }, { session });
        if (res.modifiedCount && b.paymentId) await this.payments.cancelInSession(b.paymentId, session);
      });
      return this.get(id);
    }
    if (b.status !== 'pending_review') throw errors.conflict('BANNER_REVIEWED', 'Cette bannière a déjà été examinée : elle ne peut plus être annulée.');
    return this.closeWithRefund(id, 'pending_review', 'cancelled', null, null);
  }

  private async get(id: ObjectId) {
    return (await this.banners.findOne({ _id: id }))!;
  }

  /** Paid, then refused or given up: the payment goes back to the owner's number. */
  private async closeWithRefund(id: ObjectId, from: BannerDoc['status'], to: 'rejected' | 'cancelled', by: ObjectId | null, reason: string | null) {
    const payoutIds: ObjectId[] = [];
    await withTransaction(this.mongo, async (session) => {
      payoutIds.length = 0;
      const now = this.clock.now();
      const b = await this.banners.findOneAndUpdate(
        { _id: id, status: from },
        { $set: { status: to, updatedAt: now, ...(by ? { review: { by, at: now, reason } } : {}) } },
        { session, returnDocument: 'after' },
      );
      if (!b) throw errors.conflict('BANNER_CHANGED', 'Cette bannière a changé entre-temps. Recharge la liste.');
      const payout = await this.payments.createPayout(
        { kind: 'refund', beneficiaryUserId: b.ownerId, method: b.method, amount: b.price, reason: 'banner_rejected', source: { type: 'banner', id: b._id }, idempotencyKey: `banner:${b._id.toHexString()}:refund` },
        session,
      );
      payoutIds.push(payout._id);
      await this.banners.updateOne({ _id: id }, { $set: { refundPayoutId: payout._id } }, { session });
    });
    await this.payments.schedulePayouts(payoutIds);
    return this.get(id);
  }

  readonly bannerPayment: PurposeHandler = {
    // An ad waits for the communication team; an event (already checked when it was published) goes live at once.
    onSucceeded: async (payment, session) => {
      const b = await this.banners.findOneAndUpdate(
        { _id: payment.purposeRef, status: 'pending_payment', paymentId: payment._id },
        [{ $set: { status: { $cond: [{ $eq: ['$kind', 'event'] }, 'approved', 'pending_review'] }, updatedAt: this.clock.now() } }],
        { session, returnDocument: 'after' },
      );
      if (b) {
        if (b.status === 'approved') {
          afterCommit(session, () =>
            this.notifications.notify([b.ownerId], {
              type: 'banner.approved', category: 'paiements', icon: 'checkmark-circle-outline', tone: 'success', url: MY_BANNERS, dedupeKey: `banner:${b._id.toHexString()}:reviewed`,
              title: 'Bannière en ligne', body: `« ${b.title} » s’affiche sur l’accueil ${this.fromDay(b.startsAt)}.`,
            }),
          );
        }
        return 'fulfilled';
      }
      const cur = await this.banners.findOne({ _id: payment.purposeRef }, { session });
      return cur && cur.status !== 'cancelled' && cur.paymentId?.equals(payment._id) ? 'fulfilled' : 'unfulfillable';
    },
    onClosed: async (payment, session) => {
      await this.banners.updateOne({ _id: payment.purposeRef, status: 'pending_payment', paymentId: payment._id }, { $set: { status: 'cancelled', updatedAt: this.clock.now() } }, { session });
    },
  };

  /** "dès aujourd'hui", or "à partir du 5 novembre". */
  private fromDay(startsAt: Date) {
    return startsAt <= this.clock.now() ? 'dès maintenant' : `à partir du ${startsAt.toLocaleDateString('fr-FR', { timeZone: 'Africa/Dakar', day: 'numeric', month: 'long' })}`;
  }

  // ---- Communication team ---------------------------------------------------------------------------------------

  listForReview(status?: BannerDoc['status']) {
    return this.banners.find(status ? { status } : { status: { $ne: 'pending_payment' } }).sort({ status: 1, startsAt: 1 }).limit(200).toArray();
  }

  async approve(id: ObjectId, by: ObjectId) {
    const now = this.clock.now();
    const b = await this.banners.findOneAndUpdate({ _id: id, status: 'pending_review' }, { $set: { status: 'approved', review: { by, at: now, reason: null }, updatedAt: now } }, { returnDocument: 'after' });
    if (!b) throw errors.conflict('BANNER_CHANGED', 'Cette bannière n’attend plus de validation.');
    await this.notifications.notify([b.ownerId], {
      type: 'banner.approved', category: 'paiements', icon: 'checkmark-circle-outline', tone: 'success', url: MY_BANNERS, dedupeKey: `banner:${b._id.toHexString()}:reviewed`,
      title: 'Bannière validée', body: `« ${b.title} » s’affiche sur l’accueil à partir du ${b.startsAt.toLocaleDateString('fr-FR', { timeZone: 'Africa/Dakar', day: 'numeric', month: 'long' })}.`,
    });
    return b;
  }

  async reject(id: ObjectId, by: ObjectId, reason: string) {
    const b = await this.closeWithRefund(id, 'pending_review', 'rejected', by, reason);
    await this.notifications.notify([b.ownerId], {
      type: 'banner.rejected', category: 'paiements', icon: 'close-circle-outline', tone: 'danger', url: MY_BANNERS, dedupeKey: `banner:${b._id.toHexString()}:reviewed`,
      title: 'Bannière refusée', body: `« ${b.title} » : ${reason} Tu es remboursé sur ton numéro.`,
    });
    return b;
  }

  /** Taken down after approval (complaint, event cancelled…). No refund: it ran. */
  async withdraw(id: ObjectId, by: ObjectId, reason: string) {
    const now = this.clock.now();
    const b = await this.banners.findOneAndUpdate({ _id: id, status: 'approved' }, { $set: { status: 'withdrawn', review: { by, at: now, reason }, updatedAt: now } }, { returnDocument: 'after' });
    if (!b) throw errors.conflict('BANNER_CHANGED', 'Cette bannière n’est pas en diffusion.');
    return b;
  }
}
