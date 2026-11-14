import { ObjectId, type ClientSession, type Collection, type Db, type MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { isDuplicateKey, withTransaction } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import type { Limiter } from '../../platform/security/limiter.js';
import { VILLAGES, type AccountsApi } from '../accounts/index.js';
import type { ConversationMember, MessagingApi } from '../messaging/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import {
  HOUSING_HIDE_AFTER,
  HOUSING_MAX_OPEN,
  HOUSING_TTL_DAYS,
  type HousingAdDoc,
  type HousingContactDoc,
  type HousingFor,
  type HousingKind,
  type Masked,
} from './housing.types.js';

const DAY = 24 * 3600_000;
const ALL_VILLAGES = [...VILLAGES.campus1, ...VILLAGES.campus2];

const mask = (n: { firstName: string; lastName: string }): Masked => ({
  name: n.lastName ? `${n.firstName} ${n.lastName[0]}.` : n.firstName,
  initials: `${n.firstName[0] ?? ''}${n.lastName[0] ?? ''}`.toUpperCase(),
});
const clean = (s: string | null | undefined) => {
  const v = s?.trim().replace(/\s+/g, ' ');
  return v ? v : null;
};

export type NewHousingAd = {
  kind: HousingKind;
  village?: string | null;
  room?: string | null;
  wants?: string[];
  area?: string | null;
  from?: string | null;
  to?: string | null;
  rent?: number | null;
  places?: number | null;
  for?: HousingFor;
  note?: string | null;
};

/** What each kind says in a chat's first line and in the author's notification. */
const ASKS: Record<HousingKind, string> = {
  swap: 'est intéressé(e) par ton échange de chambre',
  host_offer: 'aimerait être hébergé(e) chez toi',
  host_need: 'peut peut-être t’héberger',
  roommate: 'est intéressé(e) par ta colocation',
};

export class HousingService {
  private readonly ads: Collection<HousingAdDoc>;
  private readonly contacts: Collection<HousingContactDoc>;

  constructor(
    db: Db,
    private readonly mongo: MongoClient,
    private readonly clock: Clock,
    private readonly accounts: AccountsApi,
    private readonly messaging: MessagingApi,
    private readonly notifications: NotificationsApi,
    private readonly limiter: Limiter,
  ) {
    this.ads = db.collection('housingAds');
    this.contacts = db.collection('housingContacts');
  }

  private async me(userId: ObjectId) {
    const u = await this.accounts.findById(userId);
    if (!u) throw errors.unauthenticated();
    return u;
  }

  async get(id: ObjectId) {
    const ad = await this.ads.findOne({ _id: id });
    if (!ad) throw errors.notFound('Annonce introuvable.');
    return ad;
  }

  /** Two swaps that fit: what each one has is what the other one wants. */
  private static swapFits(a: HousingAdDoc, b: HousingAdDoc) {
    return a.kind === 'swap' && b.kind === 'swap' && !a.authorId.equals(b.authorId) && !!a.village && !!b.village && a.wants.includes(b.village) && b.wants.includes(a.village);
  }

  // ---- The board ---------------------------------------------------------------------------------------------------

  /** Open ads (not expired), newest first; mine whatever their state (closed ones a week). */
  async list(viewerId: ObjectId) {
    const now = this.clock.now();
    const docs = await this.ads
      .find({ $or: [{ state: 'open', expiresAt: { $gt: now } }, { authorId: viewerId, $or: [{ state: 'open' }, { closedAt: { $gt: new Date(now.getTime() - 7 * DAY) } }] }] })
      .sort({ createdAt: -1 })
      .limit(300)
      .toArray();
    return this.views(docs, viewerId);
  }

  async detail(id: ObjectId, viewerId: ObjectId) {
    const ad = await this.get(id);
    if (ad.state === 'hidden' && !ad.authorId.equals(viewerId)) throw errors.notFound('Annonce introuvable.');
    const [view] = await this.views([ad], viewerId);
    const contacts = ad.authorId.equals(viewerId) ? await this.contacts.find({ adId: id }).sort({ createdAt: -1 }).toArray() : [];
    const names = await this.accounts.namesByIds(contacts.map((c) => c.otherId));
    return {
      ...view!,
      conversations: contacts.map((c) => ({ contactId: c._id.toHexString(), with: mask(names.get(c.otherId.toHexString()) ?? { firstName: 'Étudiant', lastName: '' }).name, createdAt: c.createdAt.toISOString() })),
    };
  }

  async views(docs: HousingAdDoc[], viewerId: ObjectId) {
    const now = this.clock.now();
    const mySwaps = await this.ads.find({ authorId: viewerId, kind: 'swap', state: 'open', expiresAt: { $gt: now } }).toArray();
    const ids = docs.map((d) => d._id);
    const mine = await this.contacts.find({ adId: { $in: ids }, otherId: viewerId }).toArray();
    const myContact = new Map(mine.map((c) => [c.adId.toHexString(), c._id.toHexString()]));
    const authored = docs.filter((d) => d.authorId.equals(viewerId)).map((d) => d._id);
    const received = authored.length ? await this.contacts.find({ adId: { $in: authored } }).toArray() : [];
    const receivedBy = new Map<string, string[]>();
    for (const c of received) receivedBy.set(c.adId.toHexString(), [...(receivedBy.get(c.adId.toHexString()) ?? []), c._id.toHexString()]);
    return docs.map((d) => {
      const isMine = d.authorId.equals(viewerId);
      const contactIds = isMine ? (receivedBy.get(d._id.toHexString()) ?? []) : [];
      return {
        id: d._id.toHexString(),
        kind: d.kind,
        by: d.author.name,
        initials: d.author.initials,
        village: d.village,
        room: d.room,
        wants: d.wants,
        area: d.area,
        from: d.from?.toISOString() ?? null,
        to: d.to?.toISOString() ?? null,
        rent: d.rent,
        places: d.places,
        for: d.for,
        note: d.note,
        state: d.state,
        createdAt: d.createdAt.toISOString(),
        expiresAt: d.expiresAt.toISOString(),
        mine: isMine,
        // « Échange possible » : one of my swaps fits this one.
        match: !isMine && mySwaps.some((s) => HousingService.swapFits(s, d)),
        myContactId: myContact.get(d._id.toHexString()) ?? null,
        contactIds,
      };
    });
  }

  // ---- Publishing --------------------------------------------------------------------------------------------------

  async create(userId: ObjectId, input: NewHousingAd) {
    await this.limiter.hit(`housing-post:${userId.toHexString()}`, { limit: 10, windowS: 24 * 3600 }, 'Trop d’annonces publiées aujourd’hui. Réessaie demain.');
    const now = this.clock.now();
    const open = await this.ads.countDocuments({ authorId: userId, state: 'open', expiresAt: { $gt: now } });
    if (open >= HOUSING_MAX_OPEN) throw errors.conflict('HOUSING_TOO_MANY', `Tu as déjà ${HOUSING_MAX_OPEN} annonces en ligne : ferme-en une d’abord.`);
    // One ad of each kind at a time: change it by closing the one online.
    if (await this.ads.countDocuments({ authorId: userId, kind: input.kind, state: 'open', expiresAt: { $gt: now } })) {
      throw errors.conflict('HOUSING_SAME_KIND', 'Tu as déjà une annonce de ce type en ligne : ferme-la avant d’en publier une autre.');
    }

    const village = clean(input.village);
    const room = clean(input.room)?.toUpperCase() ?? null;
    const area = clean(input.area);
    const wants = [...new Set((input.wants ?? []).map((w) => w.trim()))];
    if ((village && !ALL_VILLAGES.includes(village)) || wants.some((w) => !ALL_VILLAGES.includes(w))) throw errors.validation('Village inconnu.', { field: 'village' });
    const from = input.from ? new Date(input.from) : null;
    const to = input.to ? new Date(input.to) : null;
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) throw errors.validation('Date invalide.', { field: 'from' });
    if (from && to && to < from) throw errors.validation('La date de fin est avant celle du début.', { field: 'to' });

    switch (input.kind) {
      case 'swap':
        if (!village) throw errors.validation('Indique ton village.', { field: 'village' });
        if (!room) throw errors.validation('Indique ta chambre.', { field: 'room' });
        if (!wants.length) throw errors.validation('Choisis au moins un village où tu voudrais aller.', { field: 'wants' });
        if (wants.includes(village)) throw errors.validation('Tu cherches un autre village que le tien.', { field: 'wants' });
        break;
      case 'host_offer':
        if (!village && !area) throw errors.validation('Indique où tu peux héberger.', { field: 'village' });
        break;
      case 'roommate':
        if (!area && !village) throw errors.validation('Indique le quartier ou le village.', { field: 'area' });
        break;
      case 'host_need':
        break;
    }

    const author = mask(await this.me(userId));
    // A hosting ad ends the day after its last night (at most the usual two months).
    const ttl = new Date(now.getTime() + HOUSING_TTL_DAYS * DAY);
    const expiresAt = to && (input.kind === 'host_offer' || input.kind === 'host_need') ? new Date(Math.min(ttl.getTime(), to.getTime() + DAY)) : ttl;
    if (expiresAt <= now) throw errors.validation('Ces dates sont déjà passées.', { field: 'to' });
    const doc: HousingAdDoc = {
      _id: new ObjectId(), kind: input.kind, authorId: userId, author,
      village, room: input.kind === 'swap' ? room : null, wants: input.kind === 'swap' ? wants : [], area,
      from: input.kind === 'host_offer' || input.kind === 'host_need' ? from : null, to: input.kind === 'host_offer' || input.kind === 'host_need' ? to : null,
      rent: input.kind === 'roommate' ? (input.rent ?? null) : null, places: input.kind === 'roommate' ? (input.places ?? null) : null,
      for: input.for ?? 'any', note: clean(input.note)?.slice(0, 300) ?? null,
      state: 'open', reports: [], expiresAt, closedAt: null, createdAt: now, updatedAt: now,
    };
    await this.ads.insertOne(doc);

    // A swap that fits mine: both students are told at once (the reason to post here rather than in a group).
    if (doc.kind === 'swap') {
      const fits = (await this.ads.find({ kind: 'swap', state: 'open', expiresAt: { $gt: now }, authorId: { $ne: userId }, village: { $in: doc.wants }, wants: doc.village! }).limit(20).toArray()).filter((o) => HousingService.swapFits(doc, o));
      for (const o of fits) {
        await this.notifications.notify([o.authorId], {
          type: 'housing.swap_match', category: 'social', icon: 'swap-horizontal', tone: 'success', url: `/logement/${doc._id.toHexString()}`, dedupeKey: `housing-match:${o._id.toHexString()}:${doc._id.toHexString()}`,
          title: 'Échange de chambre possible !', body: `${author.name} a une chambre au ${doc.village} et cherche le ${o.village}. Écris-lui.`,
        });
      }
      if (fits.length) {
        const first = fits[0]!;
        await this.notifications.notify([userId], {
          type: 'housing.swap_match', category: 'social', icon: 'swap-horizontal', tone: 'success', url: `/logement/${first._id.toHexString()}`, dedupeKey: `housing-match:${doc._id.toHexString()}:${first._id.toHexString()}`,
          title: 'Échange de chambre possible !', body: fits.length > 1 ? `${fits.length} étudiants cherchent ton village et ont ce que tu veux.` : `${first.author.name} a une chambre au ${first.village} et cherche le ${doc.village}.`,
        });
      }
    }
    return doc;
  }

  /** « Trouvé ! » (or simply removed) by its author: off the board, its chats read-only. */
  async close(userId: ObjectId, id: ObjectId) {
    const ad = await this.get(id);
    if (!ad.authorId.equals(userId)) throw errors.forbidden();
    if (ad.state === 'closed') return ad;
    const now = this.clock.now();
    await this.ads.updateOne({ _id: id }, { $set: { state: 'closed', closedAt: now, updatedAt: now } });
    const closed = { ...ad, state: 'closed' as const, closedAt: now };
    for (const c of await this.contacts.find({ adId: id }).toArray()) {
      await this.syncChat(c, closed);
      await this.messaging.postSystem('housing_contact', c._id, 'Annonce fermée par son auteur ✓ Discussion fermée.');
    }
    return closed;
  }

  /** Reported: after a few different students, off the board until the team looks. */
  async report(userId: ObjectId, id: ObjectId) {
    const ad = await this.get(id);
    if (ad.authorId.equals(userId)) throw errors.conflict('HOUSING_OWN_AD', 'C’est ton annonce.');
    const after = await this.ads.findOneAndUpdate({ _id: id }, { $addToSet: { reports: userId }, $set: { updatedAt: this.clock.now() } }, { returnDocument: 'after' });
    if (after && after.state === 'open' && after.reports.length >= HOUSING_HIDE_AFTER) await this.ads.updateOne({ _id: id }, { $set: { state: 'hidden' } });
  }

  // ---- The team: reported ads ------------------------------------------------------------------------------------

  /** Reported ads still waiting for the team (on the board or hidden by the reports), most reported first. */
  async reported() {
    const ads = await this.ads.find({ 'reports.0': { $exists: true }, state: { $in: ['open', 'hidden'] } }).sort({ updatedAt: -1 }).limit(200).toArray();
    return ads.sort((a, b) => b.reports.length - a.reports.length);
  }

  /** The team looked: nothing wrong. Back on the board (if not expired), the reports forgotten. */
  async keepReported(id: ObjectId) {
    const ad = await this.get(id);
    if (ad.state === 'closed') throw errors.conflict('HOUSING_CLOSED', 'Cette annonce est déjà fermée.');
    await this.ads.updateOne({ _id: id }, { $set: { state: 'open', reports: [], updatedAt: this.clock.now() } });
  }

  /** The team takes a reported ad down: off the board, its chats read-only, its author told. */
  async removeReported(id: ObjectId) {
    const ad = await this.get(id);
    if (ad.state === 'closed') return;
    const now = this.clock.now();
    await this.ads.updateOne({ _id: id }, { $set: { state: 'closed', closedAt: now, updatedAt: now } });
    const closed = { ...ad, state: 'closed' as const, closedAt: now };
    for (const c of await this.contacts.find({ adId: id }).toArray()) {
      await this.syncChat(c, closed);
      await this.messaging.postSystem('housing_contact', c._id, 'Annonce retirée par l’équipe UGB Connect. Discussion fermée.');
    }
    await this.notifications.notify([ad.authorId], {
      type: 'housing.removed', category: 'social', icon: 'flag-outline', tone: 'warning', url: null, dedupeKey: `housing-removed:${id.toHexString()}`,
      title: 'Annonce retirée', body: 'Ton annonce de logement a été signalée et retirée par l’équipe UGB Connect.',
    });
  }

  // ---- Conversations -----------------------------------------------------------------------------------------------

  /** « Écrire » on someone's ad: one private chat with its author (never the phone number). */
  async contact(userId: ObjectId, id: ObjectId) {
    await this.limiter.hit(`housing-contact:${userId.toHexString()}`, { limit: 30, windowS: 3600 });
    const ad = await this.get(id);
    if (ad.state !== 'open' || ad.expiresAt <= this.clock.now()) throw errors.conflict('HOUSING_CLOSED', 'Cette annonce n’est plus en ligne.');
    if (ad.authorId.equals(userId)) throw errors.conflict('HOUSING_OWN_AD', 'C’est ton annonce.');
    const existing = await this.contacts.findOne({ adId: id, otherId: userId });
    if (existing) return existing;
    const other = mask(await this.me(userId));
    const contact: HousingContactDoc = { _id: new ObjectId(), adId: id, authorId: ad.authorId, otherId: userId, createdAt: this.clock.now() };
    try {
      await withTransaction(this.mongo, async (session) => {
        await this.contacts.insertOne(contact, { session });
        await this.syncChat(contact, ad, session);
        await this.messaging.postSystem('housing_contact', contact._id, `${other.name} ${ASKS[ad.kind]}.`, session);
      });
    } catch (err) {
      if (isDuplicateKey(err)) return (await this.contacts.findOne({ adId: id, otherId: userId }))!;
      throw err;
    }
    await this.notifications.notify([ad.authorId], {
      type: 'housing.contact', category: 'social', icon: 'chatbubbles-outline', tone: 'primary', url: `/logement/discussion/${contact._id.toHexString()}`, dedupeKey: `housing-contact:${contact._id.toHexString()}`,
      title: 'Logement : quelqu’un t’a écrit', body: `${other.name} ${ASKS[ad.kind]}.`,
    });
    return contact;
  }

  private async syncChat(c: HousingContactDoc, ad: HousingAdDoc, session?: ClientSession) {
    const names = await this.accounts.namesByIds([c.authorId, c.otherId]);
    const open = ad.state === 'open';
    const person = (userId: ObjectId, key: string, role: string): ConversationMember => ({
      userId, key, role, canWrite: open, ...mask(names.get(userId.toHexString()) ?? { firstName: 'Étudiant', lastName: '' }),
    });
    await this.messaging.sync(
      'housing_contact',
      c._id,
      { title: 'Logement', url: `/logement/discussion/${c._id.toHexString()}`, members: [person(c.authorId, 'author', 'author'), person(c.otherId, 'other', 'other')], writableUntil: null, status: open ? 'open' : 'closed' },
      session,
    );
  }

  /** The chat screen: the ad, who I'm talking to, the conversation. Members only. */
  async contactView(contactId: ObjectId, viewerId: ObjectId) {
    const c = await this.contacts.findOne({ _id: contactId, $or: [{ authorId: viewerId }, { otherId: viewerId }] });
    if (!c) throw errors.notFound('Discussion introuvable.');
    const [ad] = await this.views([await this.get(c.adId)], viewerId);
    const otherId = c.authorId.equals(viewerId) ? c.otherId : c.authorId;
    const names = await this.accounts.namesByIds([otherId]);
    const conversationId = (await this.messaging.idsFor('housing_contact', [c._id])).get(c._id.toHexString());
    return { id: c._id.toHexString(), conversationId: conversationId?.toHexString() ?? null, with: mask(names.get(otherId.toHexString()) ?? { firstName: 'Étudiant', lastName: '' }).name, ad: ad! };
  }
}
