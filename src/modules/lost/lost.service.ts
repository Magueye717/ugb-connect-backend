import { ObjectId, type ClientSession, type Collection, type Db, type MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { isDuplicateKey, withTransaction } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import type { Limiter } from '../../platform/security/limiter.js';
import { CAMPUS_LABELS, STORED_STUDENT_NUMBER_RE, type AccountsApi, type StudentCard } from '../accounts/index.js';
import type { AlertsApi } from '../alerts/index.js';
import type { MediaApi } from '../media/index.js';
import type { ConversationMember, MessagingApi } from '../messaging/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { parseCard, parseIdentity, type CardReader, type CardType } from './lost.ocr.js';
import {
  CARD_ALERT_DAYS,
  RETURNED_VISIBLE_DAYS,
  type ClaimRole,
  type LostCategory,
  type LostClaimDoc,
  type LostHolder,
  type LostItemDoc,
  type LostKind,
  type LostStatus,
  type LostWhen,
  type Masked,
} from './lost.types.js';

const DAY = 24 * 3_600_000;
const OFFICE = 'au bureau des objets trouvés (Rectorat, rez-de-chaussée, 8h-16h en semaine)';

/** "+221771234567" → "77 123 45 67". */
const localPhone = (e164: string) => e164.replace(/^\+221/, '').replace(/^(\d{2})(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3 $4');
const mask = (n: { firstName: string; lastName: string }): Masked => ({
  name: n.lastName ? `${n.firstName} ${n.lastName[0]}.` : n.firstName,
  initials: `${n.firstName[0] ?? ''}${n.lastName[0] ?? ''}`.toUpperCase(),
});

export type NewLostItem = {
  status: LostStatus;
  category: LostCategory;
  name?: string;
  details?: string | null;
  secret?: string | null;
  where: string;
  spot?: string | null;
  when: LostWhen;
  holder?: LostHolder | null;
  imageId?: string | null;
  /** Identity cards: the name read on it ("Mariama S."). */
  ownerName?: string | null;
};

/** A student a found card may belong to, as the finder sees them: enough to recognise the photo on the card. */
export type StudentMatch = { ref: string; name: string; firstName: string; lastName: string; initials: string; ufr: string | null; campus: string | null; village: string | null; numberHint: string | null };

const KIND_OF: Record<LostCategory, LostKind> = {
  'student-card': 'student-card', 'id-card': 'id-card', 'bank-card': 'id-card', phone: 'object', keys: 'object', bag: 'object', wallet: 'object', earphones: 'object', glasses: 'object', clothes: 'object', calculator: 'object', other: 'object',
};
const DEFAULT_NAME: Partial<Record<LostCategory, string>> = { 'student-card': 'Carte étudiant', 'id-card': 'Carte d’identité', 'bank-card': 'Carte bancaire' };

/** A found card by type: what it's declared as, and how its owner is told ("Ta carte bancaire a été trouvée"). */
const CARD: Record<CardType, { category: LostCategory; kind: LostKind; name: string; your: string; yours: string }> = {
  student: { category: 'student-card', kind: 'student-card', name: 'Carte étudiant', your: 'ta carte étudiant', yours: 'Ta carte étudiant a été trouvée' },
  national_id: { category: 'id-card', kind: 'id-card', name: 'Carte d’identité', your: 'ta carte d’identité', yours: 'Ta carte d’identité a été trouvée' },
  driving_licence: { category: 'id-card', kind: 'id-card', name: 'Permis de conduire', your: 'ton permis de conduire', yours: 'Ton permis de conduire a été trouvé' },
  bank: { category: 'bank-card', kind: 'id-card', name: 'Carte bancaire', your: 'ta carte bancaire', yours: 'Ta carte bancaire a été trouvée' },
};

export class LostService {
  private readonly items: Collection<LostItemDoc>;
  private readonly claims: Collection<LostClaimDoc>;

  constructor(
    db: Db,
    private readonly mongo: MongoClient,
    private readonly clock: Clock,
    private readonly accounts: AccountsApi,
    private readonly messaging: MessagingApi,
    private readonly notifications: NotificationsApi,
    private readonly alerts: AlertsApi,
    private readonly media: MediaApi,
    private readonly limiter: Limiter,
    private readonly reader: CardReader,
  ) {
    this.items = db.collection('lostItems');
    this.claims = db.collection('lostClaims');
  }

  // ---- The board --------------------------------------------------------------------------------------------------

  /** Open items, those returned this week, and all of mine (declared, or my card), newest first. */
  async list(viewerId: ObjectId) {
    const since = new Date(this.clock.now().getTime() - RETURNED_VISIBLE_DAYS * DAY);
    const docs = await this.items
      .find({ $or: [{ state: 'open' }, { returnedAt: { $gt: since } }, { declaredBy: viewerId }, { 'owner.userId': viewerId }] })
      .sort({ createdAt: -1 })
      .limit(300)
      .toArray();
    return this.views(docs, viewerId);
  }

  async get(id: ObjectId) {
    const doc = await this.items.findOne({ _id: id });
    if (!doc) throw errors.notFound('Objet introuvable.');
    return doc;
  }

  /** One item, with the conversations the viewer can open: all of them for the declarer, theirs for the others. */
  async detail(id: ObjectId, viewerId: ObjectId) {
    const doc = await this.get(id);
    const [view] = await this.views([doc], viewerId);
    const claims = doc.declaredBy.equals(viewerId) ? await this.claims.find({ itemId: id }).sort({ createdAt: -1 }).toArray() : [];
    const names = await this.accounts.namesByIds(claims.map((c) => c.otherId));
    return {
      ...view!,
      conversations: claims.map((c) => ({ claimId: c._id.toHexString(), with: mask(names.get(c.otherId.toHexString()) ?? { firstName: 'Étudiant', lastName: '' }).name, role: c.role, createdAt: c.createdAt.toISOString() })),
    };
  }

  private async views(docs: LostItemDoc[], viewerId: ObjectId) {
    const mine = docs.length ? await this.claims.find({ itemId: { $in: docs.map((d) => d._id) }, otherId: viewerId }).toArray() : [];
    // Declarer: the conversations opened about each item (their chats' unread counts are shown on it).
    const claimsOf = new Map<string, string[]>();
    const declared = docs.filter((d) => d.declaredBy.equals(viewerId)).map((d) => d._id);
    if (declared.length) {
      for (const row of await this.claims.aggregate<{ _id: ObjectId; ids: ObjectId[] }>([{ $match: { itemId: { $in: declared } } }, { $group: { _id: '$itemId', ids: { $push: '$_id' } } }]).toArray()) {
        claimsOf.set(row._id.toHexString(), row.ids.map((id) => id.toHexString()));
      }
    }
    return docs.map((d) => {
      const isDeclarer = d.declaredBy.equals(viewerId);
      const isOwner = !!d.owner?.userId?.equals(viewerId);
      const my = mine.find((c) => c.itemId.equals(d._id));
      return {
        id: d._id.toHexString(),
        status: d.status,
        kind: d.kind,
        category: d.category,
        name: d.name,
        details: d.details,
        where: d.where,
        spot: d.spot,
        when: d.when,
        holder: d.holder,
        photo: d.photo?.url ?? null,
        by: d.declarer.name,
        owner: d.owner?.name ?? null,
        ownerNotified: !!d.ownerNotifiedAt,
        state: d.state,
        returned: d.state === 'returned',
        createdAt: d.createdAt.toISOString(),
        mine: isDeclarer,
        /** My student card, found by someone. */
        isOwner,
        secret: isDeclarer ? d.secret : null,
        myClaimId: my?._id.toHexString() ?? null,
        conversationsCount: isDeclarer ? (claimsOf.get(d._id.toHexString())?.length ?? 0) : 0,
        claimIds: isDeclarer ? (claimsOf.get(d._id.toHexString()) ?? []) : [],
      };
    });
  }

  // ---- Declaring ---------------------------------------------------------------------------------------------------

  /** A lost or found object or card. A found student card goes through the card flow (it warns its owner). */
  async declare(userId: ObjectId, input: NewLostItem) {
    await this.limiter.hit(`lost-declare:${userId.toHexString()}`, { limit: 20, windowS: 3600 });
    const kind = KIND_OF[input.category];
    const found = input.status === 'found';
    if (found && kind === 'student-card') throw errors.validation('Une carte étudiant trouvée se scanne : son propriétaire est prévenu tout de suite.', { field: 'category' });
    if (kind !== 'object' && input.imageId) throw errors.validation('Jamais de photo d’une carte : elle montre le nom, le visage et le numéro.', { field: 'imageId' });
    if (kind === 'object' && found && !input.imageId) throw errors.validation('Ajoute une photo de l’objet trouvé.', { field: 'imageId' });
    const photo = input.imageId ? (await this.media.claim(userId, [input.imageId]))[0]! : null;
    const me = await this.me(userId);
    const now = this.clock.now();
    const doc: LostItemDoc = {
      _id: new ObjectId(),
      status: input.status,
      kind,
      category: input.category,
      name: (kind === 'object' ? input.name?.trim() : '') || DEFAULT_NAME[input.category] || 'Objet',
      details: kind === 'object' ? input.details?.trim() || null : null,
      secret: found && kind === 'object' ? input.secret?.trim() || null : null,
      where: input.where.trim(),
      spot: input.spot?.trim() || null,
      when: input.when,
      holder: found ? (input.holder ?? 'office') : null,
      photo,
      declaredBy: userId,
      declarer: mask(me),
      // My own lost student card: mine. An identity card: the name read on it.
      owner: kind === 'student-card' ? { userId, name: mask(me).name } : kind === 'id-card' && input.ownerName?.trim() ? { userId: null, name: input.ownerName.trim() } : null,
      ownerNotifiedAt: null,
      state: 'open',
      returnedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.items.insertOne(doc);
    return doc;
  }

  private async me(userId: ObjectId) {
    const u = await this.accounts.findById(userId);
    if (!u) throw errors.unauthenticated();
    return u;
  }

  // ---- Conversations ----------------------------------------------------------------------------------------------

  /** "C'est à moi" on a found object kept by its finder: my proof goes first, the finder checks it. */
  claim(userId: ObjectId, itemId: ObjectId, proof: string) {
    return this.openClaim(userId, itemId, 'claim', proof.trim());
  }

  /** "Je l'ai trouvé" on a lost item: a conversation with its owner. */
  foundIt(userId: ObjectId, itemId: ObjectId) {
    return this.openClaim(userId, itemId, 'found_it', null);
  }

  private async openClaim(userId: ObjectId, itemId: ObjectId, role: Exclude<ClaimRole, 'card'>, proof: string | null) {
    await this.limiter.hit(`lost-claim:${userId.toHexString()}`, { limit: 20, windowS: 3600 });
    const item = await this.get(itemId);
    if (item.state !== 'open') throw errors.conflict('LOST_CLOSED', 'Cette annonce est fermée : l’objet a été rendu.');
    if (item.declaredBy.equals(userId)) throw errors.conflict('LOST_OWN_ITEM', 'C’est ton annonce.');
    if (role === 'claim' && (item.status !== 'found' || item.holder !== 'finder')) {
      throw errors.conflict('LOST_AT_OFFICE', item.holder === 'office' ? `Il est ${OFFICE} : présente-toi avec ta carte étudiant.` : 'Cet objet n’a pas été trouvé.');
    }
    if (role === 'found_it' && item.status !== 'lost') throw errors.conflict('LOST_NOT_LOST', 'Cet objet n’est pas déclaré perdu.');
    const existing = await this.claims.findOne({ itemId, otherId: userId });
    if (existing) return existing;

    const other = mask(await this.me(userId));
    const claim: LostClaimDoc = { _id: new ObjectId(), itemId, declarerId: item.declaredBy, otherId: userId, role, proof, createdAt: this.clock.now() };
    try {
      await withTransaction(this.mongo, async (session) => {
        await this.claims.insertOne(claim, { session });
        await this.syncChat(claim, item, session);
        await this.messaging.postSystem('lost_claim', claim._id, role === 'claim' ? `${other.name} pense que « ${item.name} » est à lui ou à elle.` : `${other.name} pense avoir trouvé « ${item.name} ».`, session);
        if (proof) await this.messaging.postSystem('lost_claim', claim._id, `Détail donné par ${other.name} pour prouver que c’est à lui ou à elle : ${proof}`, session);
      });
    } catch (err) {
      // Two taps at once: the first one won.
      if (isDuplicateKey(err)) return (await this.claims.findOne({ itemId, otherId: userId }))!;
      throw err;
    }
    await this.notifications.notify([item.declaredBy], {
      type: `lost.${role}`, category: 'social', icon: role === 'claim' ? 'help-circle-outline' : 'hand-left-outline', tone: 'primary',
      url: `/objet/discussion/${claim._id.toHexString()}`, dedupeKey: `lost-claim:${claim._id.toHexString()}`,
      title: role === 'claim' ? `« ${item.name} » : quelqu’un pense que c’est à lui` : `« ${item.name} » : quelqu’un l’a peut-être trouvé`,
      body: role === 'claim' ? `${other.name} t’a écrit. Vérifie son détail avant de le lui rendre.` : `${other.name} t’a écrit dans l’app.`,
    });
    return claim;
  }

  /** Members: the declarer and the other student. Writable while the item is open. */
  private async syncChat(claim: LostClaimDoc, item: LostItemDoc, session?: ClientSession) {
    const names = await this.accounts.namesByIds([claim.declarerId, claim.otherId]);
    const person = (userId: ObjectId, key: string, role: string): ConversationMember => ({
      userId, key, role, canWrite: item.state === 'open', ...mask(names.get(userId.toHexString()) ?? { firstName: 'Étudiant', lastName: '' }),
    });
    const finderIsDeclarer = item.status === 'found';
    await this.messaging.sync(
      'lost_claim',
      claim._id,
      {
        title: item.name,
        url: `/objet/discussion/${claim._id.toHexString()}`,
        members: [person(claim.declarerId, 'declarer', finderIsDeclarer ? 'finder' : 'owner'), person(claim.otherId, 'other', finderIsDeclarer ? 'owner' : 'finder')],
        writableUntil: null,
        status: item.state === 'open' ? 'open' : 'closed',
      },
      session,
    );
  }

  /** The chat screen: the item, who I'm talking to, and the conversation id. Members only. */
  async claimView(claimId: ObjectId, viewerId: ObjectId) {
    const claim = await this.claims.findOne({ _id: claimId, $or: [{ declarerId: viewerId }, { otherId: viewerId }] });
    if (!claim) throw errors.notFound('Discussion introuvable.');
    const [item] = await this.views([await this.get(claim.itemId)], viewerId);
    const otherId = claim.declarerId.equals(viewerId) ? claim.otherId : claim.declarerId;
    const names = await this.accounts.namesByIds([otherId]);
    const conversationId = (await this.messaging.idsFor('lost_claim', [claim._id])).get(claim._id.toHexString());
    return {
      id: claim._id.toHexString(),
      role: claim.role,
      conversationId: conversationId?.toHexString() ?? null,
      with: mask(names.get(otherId.toHexString()) ?? { firstName: 'Étudiant', lastName: '' }).name,
      item: item!,
    };
  }

  /** My conversations about items (for the list of chats). */
  async myClaims(userId: ObjectId) {
    return this.claims.find({ $or: [{ declarerId: userId }, { otherId: userId }] }).sort({ createdAt: -1 }).limit(100).toArray();
  }

  // ---- Closing -----------------------------------------------------------------------------------------------------

  /** Given back (or found again): the declarer, the card's owner, or the office closes it. Chats become read-only. */
  async markReturned(itemId: ObjectId, by: { userId: ObjectId; office: boolean }) {
    const item = await this.get(itemId);
    const allowed = by.office || item.declaredBy.equals(by.userId) || !!item.owner?.userId?.equals(by.userId);
    if (!allowed) throw errors.forbidden('Seul l’auteur de l’annonce peut la fermer.');
    if (item.state === 'returned') return item;
    const now = this.clock.now();
    const closed = (await this.items.findOneAndUpdate({ _id: itemId, state: 'open' }, { $set: { state: 'returned', returnedAt: now, updatedAt: now } }, { returnDocument: 'after' })) ?? (await this.get(itemId));
    for (const claim of await this.claims.find({ itemId }).toArray()) {
      await this.syncChat(claim, closed);
      await this.messaging.postSystem('lost_claim', claim._id, item.status === 'found' ? 'Objet rendu à son propriétaire ✓ Discussion fermée.' : 'Objet retrouvé ✓ Discussion fermée.');
    }
    await this.alerts.clear(`lost-card:${itemId.toHexString()}`);
    return closed;
  }

  // ---- Found student cards -----------------------------------------------------------------------------------------

  /**
   * A photo of a found card: OCR, then its student number (P232055) is looked up; without one (or unknown), the
   * names read on it are searched. The photo is read in memory and never stored.
   */
  async readCard(userId: ObjectId, image: Buffer) {
    await this.limiter.hit(`lost-card-read:${userId.toHexString()}`, { limit: 30, windowS: 3600 });
    let text: string;
    try {
      text = await this.reader.read(image);
    } catch {
      throw errors.validation('Impossible de lire cette photo. Réessaie bien à plat, avec de la lumière, ou saisis le numéro.', { field: 'file' });
    }
    // A student card's number gives its owner; otherwise (no number, another card) the names read are searched.
    const { cardType, studentNumber, names } = parseCard(text);
    const owner = studentNumber ? await this.accounts.studentByNumber(studentNumber) : null;
    // Without the number: only students with two of the names read (first and last name), never a single stray word.
    const candidates = owner || names.length < 2 ? [] : await this.accounts.searchStudents(names, 20, 2);
    if (owner) await this.warnOwnerEarly(userId, owner.userId);
    return { cardType, studentNumber, names, owner: owner ? this.match(owner) : null, candidates: candidates.filter((c) => !c.userId.equals(userId)).map((c) => this.match(c)) };
  }

  /**
   * The student's own card, to complete their profile: birth date, place of birth, nationality. Only their student
   * card: its number must be theirs (or, unread, their names must be on it). Nothing is saved here: the student
   * checks the details, then PUT /me/identity.
   */
  async readMyCard(userId: ObjectId, image: Buffer) {
    await this.limiter.hit(`my-card-read:${userId.toHexString()}`, { limit: 20, windowS: 3600 });
    let text: string;
    try {
      text = await this.reader.read(image);
    } catch {
      throw errors.validation('Impossible de lire cette photo. Réessaie bien à plat, avec de la lumière.', { field: 'file' });
    }
    const { cardType, studentNumber } = parseCard(text);
    if (cardType && cardType !== 'student') throw errors.conflict('NOT_STUDENT_CARD', 'Ce n’est pas une carte étudiant : photographie ta carte de l’UGB.');
    // The card's student number must be the student's own: then (only then) its details can fill their profile.
    if (!studentNumber) throw errors.validation('Numéro étudiant illisible : reprends la photo bien à plat, avec de la lumière.', { field: 'file' });
    const owner = await this.accounts.studentByNumber(studentNumber);
    const notMine = () => errors.conflict('NOT_YOUR_CARD', `Cette carte (${studentNumber}) n’est pas la tienne : scanne ta propre carte étudiant.`);
    if (owner && !owner.userId.equals(userId)) throw notMine();
    // A student who hasn't given their number yet: their own card gives it (only if no one else has it).
    if (!owner && (await this.accounts.claimStudentNumber(userId, studentNumber)) === 'has-other') throw notMine();
    await this.accounts.markCardRead(userId);
    return { matched: 'number' as const, studentNumber, ...parseIdentity(text, this.clock.now()) };
  }

  /** Typed number: "P232055", "p 232 055". */
  async lookupCard(userId: ObjectId, number: string) {
    await this.limiter.hit(`lost-card-lookup:${userId.toHexString()}`, { limit: 30, windowS: 3600 });
    const n = number.toUpperCase().replace(/\s/g, '');
    // A found card: any number already given (also under the previous, shorter rule).
    if (!STORED_STUDENT_NUMBER_RE.test(n)) throw errors.validation('Numéro étudiant invalide : P puis au moins 4 chiffres. Exemple : P232055', { field: 'number' });
    const owner = await this.accounts.studentByNumber(n);
    if (owner) await this.warnOwnerEarly(userId, owner.userId);
    return { studentNumber: n, owner: owner ? this.match(owner) : null };
  }

  /**
   * A card just matched its owner by its number (scanned or typed): they're told at once, before the finder even
   * saves the declaration, which then sends the second message (who, where, the chat). Once a day per finder and
   * owner: scanning again or retyping doesn't repeat it. Nothing about the finder yet.
   */
  private async warnOwnerEarly(finderId: ObjectId, ownerId: ObjectId) {
    if (ownerId.equals(finderId)) return;
    const day = this.clock.now().toISOString().slice(0, 10);
    await this.notifications.notify([ownerId], {
      type: 'lost.card_scanned', category: 'social', icon: 'card-outline', tone: 'warning', url: '/(tabs)/lieux?vue=objets',
      dedupeKey: `lost-card-scan:${finderId.toHexString()}:${ownerId.toHexString()}:${day}`,
      title: 'Ta carte étudiant a été retrouvée',
      body: 'Un étudiant vient de la scanner et la signale en ce moment. Tu recevras un second message avec où elle est et comment la récupérer.',
    });
  }

  /** Typed name, when the number can't be read: the students it may be. */
  async searchCardOwners(userId: ObjectId, q: string) {
    await this.limiter.hit(`lost-card-search:${userId.toHexString()}`, { limit: 30, windowS: 3600 });
    const words = q.split(/\s+/).filter((w) => w.length >= 2);
    if (!words.length) return [];
    return (await this.accounts.searchStudents(words)).filter((c) => !c.userId.equals(userId)).map((c) => this.match(c));
  }

  private match(c: StudentCard): StudentMatch {
    return {
      ref: c.userId.toHexString(),
      name: `${c.firstName} ${c.lastName}`,
      firstName: c.firstName,
      lastName: c.lastName,
      initials: `${c.firstName[0] ?? ''}${c.lastName[0] ?? ''}`.toUpperCase(),
      ufr: c.ufr,
      campus: c.campus ? CAMPUS_LABELS[c.campus] : null,
      village: c.village,
      // Enough to compare with the card in hand, not enough to copy it.
      numberHint: c.studentNumber ? `${c.studentNumber.slice(0, 3)}•••${c.studentNumber.slice(-2)}` : null,
    };
  }

  /**
   * The finder confirms: the card is declared (never in photo), and its owner gets a push and an alert on their home
   * screen with the finder's name and phone number, where it is, and a chat with the finder. Unknown owner: it goes
   * to the office.
   */
  async cardFound(finderId: ObjectId, input: { ownerRef: string | null; cardType?: CardType | null; where: string; spot?: string | null; holder: LostHolder }) {
    const card = CARD[input.cardType ?? 'student'];
    await this.limiter.hit(`lost-card-found:${finderId.toHexString()}`, { limit: 10, windowS: 3600 });
    const ownerId = input.ownerRef ? new ObjectId(input.ownerRef) : null;
    if (ownerId?.equals(finderId)) throw errors.conflict('LOST_OWN_CARD', 'C’est ta propre carte : rien à signaler.');
    const owner = ownerId ? await this.accounts.findById(ownerId) : null;
    if (ownerId && !owner) throw errors.validation('Étudiant introuvable.', { field: 'ownerRef' });
    const finder = await this.me(finderId);
    const now = this.clock.now();
    // Unknown owner: only the office can give it back.
    const holder: LostHolder = owner ? input.holder : 'office';
    const doc: LostItemDoc = {
      _id: new ObjectId(), status: 'found', kind: card.kind, category: card.category, name: card.name, details: null, secret: null,
      where: input.where.trim(), spot: input.spot?.trim() || null, when: 'today', holder, photo: null, declaredBy: finderId, declarer: mask(finder),
      owner: owner ? { userId: owner._id, name: mask(owner).name } : null, ownerNotifiedAt: owner ? now : null, state: 'open', returnedAt: null, createdAt: now, updatedAt: now,
    };
    const claim: LostClaimDoc | null = owner ? { _id: new ObjectId(), itemId: doc._id, declarerId: finderId, otherId: owner._id, role: 'card', proof: null, createdAt: now } : null;
    await withTransaction(this.mongo, async (session) => {
      await this.items.insertOne(doc, { session });
      if (claim) {
        await this.claims.insertOne(claim, { session });
        await this.syncChat(claim, doc, session);
        await this.messaging.postSystem('lost_claim', claim._id, `${mask(finder).name} a trouvé ${card.your} (${doc.where}). Écrivez-vous ici pour la récupérer.`, session);
      }
    });

    if (owner) {
      const who = `${finder.firstName} ${finder.lastName} (${localPhone(finder.phone)})`;
      const how = holder === 'office' ? `Elle sera déposée ${OFFICE}.` : 'Contacte cette personne pour la récupérer.';
      const body = `Trouvée à ${doc.where}${doc.spot ? ` (${doc.spot})` : ''} par ${who}. ${how}`;
      const href = `/objet/${doc._id.toHexString()}`;
      // Like a dish sold out: a push, and an alert on the owner's home screen (for them only).
      await this.alerts.raise(`lost-card:${doc._id.toHexString()}`, {
        kind: 'lost_card', title: card.yours, body, icon: 'card-outline', tone: 'warning', href,
        audience: { campuses: [], ufrs: [], regions: [] }, forUserId: owner._id, endsAt: new Date(now.getTime() + CARD_ALERT_DAYS * DAY),
      });
      await this.notifications.notify([owner._id], {
        type: 'lost.card_found', category: 'social', icon: 'card-outline', tone: 'warning', url: href, dedupeKey: `lost-card:${doc._id.toHexString()}`,
        title: card.yours, body,
      });
    }
    return { item: doc, claimId: claim?._id.toHexString() ?? null };
  }

  // ---- Lost and found office ---------------------------------------------------------------------------------------

  /** What the office holds (or should receive), with the owner's name and number for cards, to check at the desk. */
  async atOffice() {
    const docs = await this.items.find({ state: 'open', status: 'found', holder: 'office' }).sort({ createdAt: -1 }).limit(300).toArray();
    const ownerIds = docs.flatMap((d) => (d.owner?.userId ? [d.owner.userId] : []));
    const contacts = await this.accounts.contactsByIds(ownerIds);
    return docs.map((d) => {
      const c = d.owner?.userId ? contacts.get(d.owner.userId.toHexString()) : null;
      return {
        id: d._id.toHexString(), category: d.category, kind: d.kind, name: d.name, details: d.details, where: d.where, photo: d.photo?.url ?? null, by: d.declarer.name,
        owner: c ? { name: `${c.firstName} ${c.lastName}`, phone: localPhone(c.phone) } : d.owner ? { name: d.owner.name, phone: null } : null,
        createdAt: d.createdAt.toISOString(),
      };
    });
  }
}
