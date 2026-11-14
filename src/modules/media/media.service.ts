import { ObjectId, type Collection, type Db } from 'mongodb';
import sharp, { type Metadata } from 'sharp';

import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import type { ImageRef } from '../../platform/media.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { MediaStorage } from './media.storage.js';
import type { FileRef, MediaDoc, MediaPurpose, MediaUsage } from './media.types.js';

/** Longest side after re-encoding: sharp on a phone, light on mobile data. */
const MAX_SIDE = 1600;
/** Smallest accepted side: below that it's an icon, not a photo. Small pictures are kept as they are (never blown up). */
const MIN_SIDE = 120;
/** Every photo format a phone or a computer gives (an animated GIF keeps its first frame); all re-encoded to WebP. */
const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'heif', 'avif', 'gif', 'tiff']);
/** An upload is attached by a second request (the form is saved after the picture is sent): left alone this long. */
const UNATTACHED_GRACE_MS = 24 * 3600_000;
/** A picture found in use is checked again this much later (its entity may have been deleted since). */
const RECHECK_MS = 7 * 24 * 3600_000;
const SWEEP_BATCH = 200;
/** Who may attach a document, and to what: announcements only. */
export const DOCUMENT_PURPOSES: MediaPurpose[] = ['alert'];
/** "Calendrier des examens.pdf": no path, no control characters, one line, a sane length. */
const cleanName = (raw: string | undefined) => {
  const base = (raw ?? '').split(/[\\/]/).pop()!.split('').filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join('').trim().slice(0, 100);
  return base ? (base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`) : 'document.pdf';
};

/**
 * A PDF's page count, read from its page objects (or its page tree's count). Null when it can't be told (pages kept
 * in compressed object streams): the app then just doesn't show it.
 */
export function pdfPages(input: Buffer): number | null {
  const text = input.toString('latin1');
  const pages = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  if (pages) return pages;
  const counts = [...text.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return counts.length ? Math.max(...counts) || null : null;
}

export class MediaService {
  private readonly media: Collection<MediaDoc>;
  private readonly usages: MediaUsage[] = [];

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly storage: MediaStorage,
    private readonly limiter: Limiter,
  ) {
    this.media = db.collection('media');
  }

  /**
   * Checks an uploaded picture and keeps a clean copy: the real format is read from the bytes (not the file name),
   * the photo is turned upright, resized, re-encoded to WebP and stripped of its metadata (GPS position…).
   */
  async upload(ownerId: ObjectId, purpose: MediaPurpose, input: Buffer, apiBase: string, opts: { unlimited?: boolean } = {}): Promise<MediaDoc> {
    // The campus team filling the directory (dozens of photos per place, per menu) isn't held to the hourly limit.
    if (!opts.unlimited) await this.limiter.hit(`media-upload:${ownerId.toHexString()}`, { limit: 60, windowS: 3600 }, 'Trop d’images envoyées. Réessaie dans une heure.');
    let meta: Metadata;
    try {
      meta = await sharp(input).metadata();
    } catch {
      throw errors.validation('Ce fichier n’est pas une image.', { field: 'file' });
    }
    if (!meta.format || !ACCEPTED.has(meta.format)) throw errors.validation('Ce format d’image n’est pas accepté : choisis une photo (JPEG, PNG, WebP, HEIC).', { field: 'file' });
    if ((meta.width ?? 0) < MIN_SIDE && (meta.height ?? 0) < MIN_SIDE) throw errors.validation(`Image trop petite : au moins ${MIN_SIDE} pixels de côté.`, { field: 'file' });
    // Lenient on slightly damaged files (a photo cut short by a messaging app still opens): only unreadable ones fail.
    const { data, info } = await sharp(input, { failOn: 'none', limitInputPixels: false, pages: 1 })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    const now = this.clock.now();
    const _id = new ObjectId();
    const key = `${purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${_id.toHexString()}.webp`;
    await this.storage.put(key, data, 'image/webp');
    const doc: MediaDoc = { _id, ownerId, purpose, key, url: this.storage.url(key, apiBase), contentType: 'image/webp', width: info.width, height: info.height, bytes: info.size, createdAt: now };
    await this.media.insertOne(doc);
    return doc;
  }

  /**
   * A PDF (an announcement's timetable, a form): checked to be one (by its first bytes, not its name), kept as sent.
   * Images go through `upload`.
   */
  async uploadDocument(ownerId: ObjectId, purpose: MediaPurpose, input: Buffer, fileName: string | undefined, apiBase: string): Promise<MediaDoc> {
    if (!DOCUMENT_PURPOSES.includes(purpose)) throw errors.validation('Document non accepté ici.', { field: 'purpose' });
    await this.limiter.hit(`media-upload:${ownerId.toHexString()}`, { limit: 40, windowS: 3600 }, 'Trop de fichiers envoyés. Réessaie dans une heure.');
    if (input.subarray(0, 5).toString('latin1') !== '%PDF-') throw errors.validation('Ce fichier n’est pas un PDF.', { field: 'file' });
    const now = this.clock.now();
    const _id = new ObjectId();
    const key = `${purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${_id.toHexString()}.pdf`;
    await this.storage.put(key, input, 'application/pdf');
    const pages = pdfPages(input);
    const doc: MediaDoc = { _id, ownerId, purpose, key, url: this.storage.url(key, apiBase), contentType: 'application/pdf', name: cleanName(fileName), ...(pages ? { pages } : {}), bytes: input.length, createdAt: now };
    await this.media.insertOne(doc);
    return doc;
  }

  /** A document the user sent (`uploadDocument`), to attach. Another person's, an image or a made-up id: refused. */
  async claimDocument(ownerId: ObjectId, id: string): Promise<FileRef> {
    const m = ObjectId.isValid(id) ? await this.media.findOne({ _id: new ObjectId(id), ownerId, contentType: 'application/pdf' }) : null;
    if (!m) throw errors.validation('Document inconnu : envoie-le d’abord.', { field: 'attachmentId' });
    return { mediaId: m._id, url: m.url, name: m.name ?? 'document.pdf', bytes: m.bytes, pages: m.pages ?? null };
  }

  /**
   * The pictures a user attaches to their banner or event: theirs, in the given order. Anything else (another
   * person's upload, a document, a made-up id) is refused.
   */
  async claim(ownerId: ObjectId, ids: string[]): Promise<ImageRef[]> {
    const oids = ids.map((id) => (ObjectId.isValid(id) ? new ObjectId(id) : null));
    if (oids.some((x) => !x)) throw errors.validation('Image inconnue.', { field: 'images' });
    const found = await this.media.find({ _id: { $in: oids as ObjectId[] }, ownerId, contentType: 'image/webp' }).toArray();
    return (oids as ObjectId[]).map((id) => {
      const m = found.find((f) => f._id.equals(id));
      if (!m) throw errors.validation('Image inconnue : envoie-la d’abord.', { field: 'images' });
      return { mediaId: m._id, url: m.url };
    });
  }

  /** Each module that keeps pictures says where: a picture referenced in none of these places can be deleted. */
  trackUsage(usages: MediaUsage[]) {
    this.usages.push(...usages);
  }

  private async inUse(id: ObjectId) {
    for (const u of this.usages) if (await this.db.collection(u.collection).findOne({ [u.path]: id }, { projection: { _id: 1 } })) return true;
    return false;
  }

  /**
   * After an entity dropped pictures (replaced, removed, entity deleted), once that change is saved: each one that
   * nothing else references (a banner may reuse its event's picture) is deleted from the storage, then forgotten.
   * Never throws: what fails here is retried by the sweep.
   */
  async release(ids: (ObjectId | null | undefined)[]): Promise<number> {
    const unique = [...new Map(ids.filter((x): x is ObjectId => !!x).map((id) => [id.toHexString(), id])).values()];
    let deleted = 0;
    for (const id of unique) deleted += await this.remove(id).catch(() => 0);
    return deleted;
  }

  private async remove(id: ObjectId): Promise<number> {
    if (await this.inUse(id)) return 0;
    const doc = await this.media.findOne({ _id: id });
    if (!doc) return 0;
    await this.storage.delete(doc.key);
    await this.media.deleteOne({ _id: id });
    return 1;
  }

  /**
   * Worker, hourly: uploads never attached (after a day) and pictures left behind by something that didn't release
   * them (an entity deleted). The ones still in use are marked and looked at again a week later.
   */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    const due = await this.media
      .find(
        { createdAt: { $lte: new Date(now.getTime() - UNATTACHED_GRACE_MS) }, $or: [{ checkedAt: { $exists: false } }, { checkedAt: { $lte: new Date(now.getTime() - RECHECK_MS) } }] },
        { projection: { _id: 1 } },
      )
      .sort({ checkedAt: 1, createdAt: 1 })
      .limit(SWEEP_BATCH)
      .toArray();
    let deleted = 0;
    for (const { _id } of due) {
      if (await this.inUse(_id)) await this.media.updateOne({ _id }, { $set: { checkedAt: now } });
      else deleted += await this.remove(_id).catch(() => 0); // the storage failed: next sweep
    }
    return deleted;
  }
}
