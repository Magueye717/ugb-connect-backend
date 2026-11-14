import { ObjectId, type Collection, type Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import type { Audience, AudienceProfile } from '../accounts/index.js';
import type { MediaApi } from '../media/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { ALERT_MAX_IMAGES, DEFAULT_DOCUMENT_LABEL, type AlertDoc, type AlertInput, type AlertKind, type AlertStatus, type AlertTone, type RaisedAlert } from './alerts.types.js';

const everyone = (a: Audience) => !a.campuses.length && !a.ufrs.length && !a.regions.length;

/**
 * Is this alert for this viewer? Each non-empty list must contain the viewer's value. Accounts without a student
 * profile see whole-university alerts only; a student who hasn't given their UFR (or region) doesn't see alerts
 * targeted by UFR (or region).
 */
export function isFor(a: Audience, p: AudienceProfile) {
  if (everyone(a)) return true;
  if (!p) return false;
  return (!a.campuses.length || a.campuses.includes(p.campus)) && (!a.ufrs.length || (!!p.ufr && a.ufrs.includes(p.ufr))) && (!a.regions.length || (!!p.region && a.regions.includes(p.region)));
}

const TONE_ORDER: Record<AlertTone, number> = { danger: 0, warning: 1, info: 2, success: 3 };

/** Who may write what: the communication team handles everything posted by hand, the academic team its own. */
export type Editor = { userId: ObjectId; roles: readonly string[] };
const isCommunication = (e: Editor) => e.roles.includes('admin') || e.roles.includes('content_editor');
const canEdit = (e: Editor, kind: AlertKind) => kind !== 'resto_stock' && kind !== 'lost_card' && (isCommunication(e) || (kind === 'academic' && e.roles.includes('academic_editor')));
/** A restaurant's "rupture" can be taken down by the communication team (it can't be edited: it follows the stock). */
const canWithdraw = (e: Editor, kind: AlertKind) => canEdit(e, kind) || (kind === 'resto_stock' && isCommunication(e));

export const alertView = (a: AlertDoc) => ({
  id: a._id.toHexString(),
  kind: a.kind,
  placement: a.placement,
  tag: a.tag,
  title: a.title,
  body: a.body,
  details: a.details ?? '',
  images: (a.images ?? []).map((i) => i.url),
  /** Apps before multiple photos: the first one. */
  image: a.images?.[0]?.url ?? null,
  // Students get what it is, its size and pages, not its file name (kept for the team, in adminView).
  attachment: a.attachment ? { url: a.attachment.url, label: a.attachmentLabel || DEFAULT_DOCUMENT_LABEL, bytes: a.attachment.bytes, pages: a.attachment.pages ?? null } : null,
  icon: a.icon,
  tone: a.tone,
  href: a.href,
  eventAt: a.eventAt?.toISOString() ?? null,
  audience: a.audience,
  startsAt: a.startsAt.toISOString(),
  endsAt: a.endsAt.toISOString(),
});

export class AlertsService {
  private readonly alerts: Collection<AlertDoc>;

  constructor(
    db: Db,
    private readonly clock: Clock,
    private readonly notifications: NotificationsApi,
    private readonly media: Pick<MediaApi, 'release'>,
  ) {
    this.alerts = db.collection('alerts');
  }

  /** The server's clock (a fake one in tests): defaults like "starts now" are taken from it. */
  now() {
    return this.clock.now();
  }

  status(a: AlertDoc, now = this.clock.now()): AlertStatus {
    if (a.withdrawnAt) return 'withdrawn';
    if (a.endsAt <= now) return 'ended';
    return a.startsAt > now ? 'scheduled' : 'live';
  }

  /** Back office view: the status and what this editor may do with it. */
  adminView(a: AlertDoc, editor: Editor) {
    const status = this.status(a);
    const open = status === 'scheduled' || status === 'live';
    return {
      ...alertView(a),
      attachment: a.attachment ? { url: a.attachment.url, label: a.attachmentLabel || DEFAULT_DOCUMENT_LABEL, bytes: a.attachment.bytes, pages: a.attachment.pages ?? null, name: a.attachment.name } : null,
      attachmentLabel: a.attachmentLabel ?? null,
      imageIds: (a.images ?? []).map((i) => i.mediaId.toHexString()),
      status,
      push: a.push,
      pushedAt: a.pushedAt?.toISOString() ?? null,
      editable: open && canEdit(editor, a.kind),
      withdrawable: open && canWithdraw(editor, a.kind),
    };
  }

  /** What this viewer's home screen shows now, banner and "À la une" alike: most serious first, then newest. */
  async active(viewer: AudienceProfile, viewerId?: ObjectId) {
    const now = this.clock.now();
    // Personal alerts only reach their user.
    const list = await this.alerts.find({ startsAt: { $lte: now }, endsAt: { $gt: now }, withdrawnAt: null, forUserId: { $in: viewerId ? [null, viewerId] : [null] } }).sort({ startsAt: -1 }).limit(200).toArray();
    return list.filter((a) => isFor(a.audience, viewer)).slice(0, 50).sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
  }

  /** One alert, for its page: only if this viewer sees it on their home screen now. */
  async one(id: ObjectId, viewer: AudienceProfile, viewerId: ObjectId) {
    const a = (await this.active(viewer, viewerId)).find((x) => x._id.equals(id));
    if (!a) throw errors.notFound('Cette annonce n’est plus en ligne.');
    return a;
  }

  /** Back office: scheduled, live and recently ended or withdrawn alerts, newest first. */
  recent() {
    return this.alerts.find({ endsAt: { $gt: new Date(this.clock.now().getTime() - 14 * 24 * 3_600_000) }, forUserId: null }).sort({ startsAt: -1 }).limit(200).toArray();
  }

  async create(input: AlertInput, editor: Editor) {
    if (!canEdit(editor, input.kind)) throw errors.forbidden('Tu ne peux publier que les annonces de ton équipe.');
    this.check(input);
    const now = this.clock.now();
    const doc: AlertDoc = { _id: new ObjectId(), ...input, details: input.details ?? '', images: input.images ?? [], attachment: input.attachment ?? null, attachmentLabel: input.attachmentLabel ?? null, sourceKey: null, pushedAt: null, withdrawnAt: null, createdBy: editor.userId, updatedBy: editor.userId, createdAt: now, updatedAt: now };
    await this.alerts.insertOne(doc);
    await this.pushIfDue(doc);
    return (await this.alerts.findOne({ _id: doc._id }))!;
  }

  /** Changes a scheduled or live alert. A push that already left isn't sent again. */
  async update(id: ObjectId, input: Omit<AlertInput, 'kind'>, editor: Editor) {
    const a = await this.alerts.findOne({ _id: id });
    if (!a) throw errors.notFound('Alerte introuvable.');
    if (a.kind === 'resto_stock') throw errors.conflict('ALERT_FOLLOWS_STOCK', 'Cette alerte suit le stock du restaurant : elle se modifie depuis « Menus du jour ».');
    if (!canEdit(editor, a.kind)) throw errors.forbidden('Cette annonce est gérée par une autre équipe.');
    const status = this.status(a);
    if (status === 'ended' || status === 'withdrawn') throw errors.conflict('ALERT_CLOSED', 'Cette alerte est terminée ou retirée.');
    // Already online: it stays online from when it started.
    const startsAt = status === 'live' ? a.startsAt : input.startsAt;
    const { images, attachment, ...rest } = input;
    this.check({ ...input, images: images ?? a.images ?? [], attachment: attachment !== undefined ? attachment : (a.attachment ?? null), startsAt });
    const now = this.clock.now();
    const set = { ...rest, ...(images !== undefined ? { images } : {}), ...(attachment !== undefined ? { attachment } : {}), startsAt, updatedBy: editor.userId, updatedAt: now };
    const updated = (await this.alerts.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' }))!;
    // A picture or a PDF replaced or removed: the old file leaves the storage.
    const dropped = (next: { mediaId: ObjectId } | null | undefined, old: { mediaId: ObjectId } | null | undefined) => (next !== undefined && old && !next?.mediaId.equals(old.mediaId) ? old.mediaId : null);
    const goneImages = images === undefined ? [] : (a.images ?? []).filter((o) => !images.some((n) => n.mediaId.equals(o.mediaId))).map((o) => o.mediaId);
    await this.media.release([...goneImages, dropped(attachment, a.attachment)]);
    await this.pushIfDue(updated);
    return (await this.alerts.findOne({ _id: id }))!;
  }

  async withdraw(id: ObjectId, editor: Editor) {
    const a = await this.alerts.findOne({ _id: id });
    if (!a) throw errors.notFound('Alerte introuvable.');
    if (!canWithdraw(editor, a.kind)) throw errors.forbidden('Cette annonce est gérée par une autre équipe.');
    const now = this.clock.now();
    return (await this.alerts.findOneAndUpdate({ _id: id }, { $set: { withdrawnAt: a.withdrawnAt ?? now, updatedBy: editor.userId, updatedAt: now } }, { returnDocument: 'after' }))!;
  }

  private check(input: Omit<AlertInput, 'kind'>) {
    if (input.endsAt <= input.startsAt || input.endsAt <= this.clock.now()) throw errors.validation('La fin doit être après le début, et à venir.', { field: 'endsAt' });
    if (input.placement === 'headline' && !input.tag) throw errors.validation('Une annonce « À la une » a une étiquette (Élections, Bourses…).', { field: 'tag' });
    if ((input.images?.length ?? 0) > ALERT_MAX_IMAGES) throw errors.validation(`${ALERT_MAX_IMAGES} photos au plus.`, { field: 'imageIds' });
    if (input.images?.length && input.attachment) throw errors.validation('Un PDF ou des photos, pas les deux.', { field: 'attachmentId' });
  }

  /**
   * Raised by a feature: one alert per `sourceKey`, put back on (and updated) if it was withdrawn. Returns true
   * when it wasn't showing before, so the caller notifies only once.
   */
  async raise(sourceKey: string, input: RaisedAlert) {
    const now = this.clock.now();
    const before = await this.alerts.findOneAndUpdate(
      { sourceKey },
      {
        $set: { ...input, forUserId: input.forUserId ?? null, placement: 'banner', startsAt: input.startsAt ?? now, withdrawnAt: null, updatedAt: now },
        $setOnInsert: { _id: new ObjectId(), sourceKey, tag: null, eventAt: null, push: false, pushedAt: null, createdBy: null, updatedBy: null, createdAt: now },
      },
      { upsert: true, returnDocument: 'before' },
    );
    return !before || !!before.withdrawnAt || before.endsAt <= now;
  }

  /** The feature's reason is over (the dish is back): the alert leaves the home screen. */
  async clear(sourceKey: string) {
    const now = this.clock.now();
    await this.alerts.updateOne({ sourceKey, withdrawnAt: null }, { $set: { withdrawnAt: now, updatedAt: now } });
  }

  /** Worker, every minute: the pushes asked for alerts that went online since. */
  async sweep() {
    const now = this.clock.now();
    const due = await this.alerts.find({ push: true, pushedAt: null, withdrawnAt: null, startsAt: { $lte: now }, endsAt: { $gt: now } }).limit(50).toArray();
    for (const a of due) await this.pushIfDue(a);
    return due.length;
  }

  /** Online, push asked, not sent yet: claimed atomically, so it leaves once even with several workers. */
  private async pushIfDue(a: AlertDoc) {
    const now = this.clock.now();
    if (!a.push || a.pushedAt || this.status(a, now) !== 'live') return;
    const claimed = await this.alerts.findOneAndUpdate({ _id: a._id, pushedAt: null }, { $set: { pushedAt: now } });
    if (!claimed) return;
    // Only the students it's for.
    await this.notifications.broadcast({ title: a.title, body: a.body, url: a.href ?? '/(tabs)', category: 'campus', dedupeKey: `alert:${a._id.toHexString()}`, segment: a.audience });
  }
}
