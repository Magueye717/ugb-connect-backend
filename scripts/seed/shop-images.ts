/**
 * `npm run seed:shop-images`: pictures for the shops and restaurants (their photo) and their articles, dishes and
 * drinks (2 photos each), found on
 * Wikimedia Commons by keyword (free licences), Picsum when nothing is found. Uploaded like the app does (resized to
 * WebP, stored in the bucket, recorded in `media`). Only what has no picture, or a picture that no longer loads, is
 * replaced: safe to run again, on any environment (.env). `--force`: replaces them all.
 * Commons limits automated clients: the calls are paced and retried when it says to slow down.
 */
import { ObjectId } from 'mongodb';

import { loadConfig } from '../../src/config/env.js';
import { createContainer } from '../../src/container.js';

const API_BASE = 'http://localhost:3000/api/v1';
const UA = 'ugb-connect-dev-seed/1.0 (seed script)';
const PER_ITEM = 2;
const FORCE = process.argv.includes('--force');
/** `--only "Savon,MGG fashion"`: just these shops / articles (by name), replaced even if their pictures load. */
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? new Set((process.argv[onlyArg + 1] ?? '').split(',').map((x) => x.trim())) : null;
const pick = (name: string, broken: () => Promise<boolean>) => (ONLY ? Promise.resolve(ONLY.has(name)) : FORCE ? Promise.resolve(true) : broken());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Commons call, paced (one per 1.5 s) and retried while it answers "too many requests". */
let last = 0;
async function politeFetch(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = last + 1500 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
      if (res.status !== 429 && res.status < 500) return res;
    } catch {
      // network hiccup: retried below
    }
    await sleep(5000 * (attempt + 1));
  }
  return null;
}

/** Search words per shop / article (English finds more on Commons). */
const SHOP_WORDS: Record<string, string> = {
  // Restaurants
  'Khoulé & Frère': 'Senegalese restaurant',
  'Chez Marie': 'grilled chicken restaurant',
  'Le Goût': 'restaurant table food plates',
  'Chez Fatou': 'rice and sauce restaurant Africa',
  'Le Coin du Village E': 'fast food counter',
  'Chez maman Sina': 'African food plate',
  // Shops
  'Papeterie du Campus': 'school supplies pencils notebooks',
  'Boutique du Village C': 'small grocery shop',
  'khoulé et Frères multiservice': 'photocopy shop',
  'Khoulé & frère Electronics': 'mobile phone shop',
  'MGG fashion': 'clothing rack shirts',
  'Ndaya élégance': 'cosmetics shop',
};
const ITEM_WORDS: Record<string, string> = {
  // Dishes and drinks
  'Mafé yap': 'peanut sauce stew',
  Mafé: 'groundnut stew',
  'Thiébou dieun': 'Thieboudienne',
  'Thiebou Dieun Blan': 'fish and rice Senegal',
  'Thiebou Dieun Rouge': 'jollof rice fish',
  'Yassa poulet': 'Yassa chicken',
  'Poulet braisé': 'grilled chicken plate',
  'Dibi agneau': 'grilled lamb meat',
  Domoda: 'tomato stew with rice',
  'Soupe kandia': 'okra stew',
  'Thiou carry': 'chicken curry rice',
  Chawarma: 'shawarma',
  'Burger frites': 'hamburger and fries',
  'Pain thon': 'tuna sandwich',
  Bissap: 'bissap drink',
  Gingembre: 'ginger drink bottle',
  'Eau minérale': 'mineral water bottle',
  'Jus d’orange': 'orange juice glass',
  'Crème glacé': 'ice cream',
  // Articles
  'Cahier 200 pages': 'school notebook',
  'Stylo bleu': 'blue ballpoint pen',
  'Calculatrice Casio fx-92': 'Casio scientific calculator',
  'Reliure mémoire': 'spiral binding',
  'Sac à main': 'leather handbag',
  'Lait en poudre': 'powdered milk tin',
  'Coca-Cola': 'Coca-Cola can',
  Savon: 'bar of soap',
  Ballet: 'broom',
  'Ordinateur HP': 'HP laptop',
  'IP TV abonnement': 'television remote control',
  'impression Page 100fr': 'laser printer',
  impression: 'printing paper ream',
  'Samsung A6': 'Samsung Galaxy A6',
  'Lips care': 'lip balm',
  'Mèche naturel': 'hair extensions',
  'Packe de 12 caleçons coton': 'folded clothes',
};

const used = new Set<string>();

/** Photo URLs (JPEG/PNG, at least 600 px) on Commons for these words, not used yet in this run. */
async function commons(words: string, n: number): Promise<string[]> {
  const q = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: '20', gsrsearch: `${words} filetype:bitmap`,
    prop: 'imageinfo', iiprop: 'url|mime|size', iiurlwidth: '1000',
  });
  try {
    const res = await politeFetch(`https://commons.wikimedia.org/w/api.php?${q}`);
    if (!res) return [];
    const pages = Object.values(((await res.json()) as { query?: { pages?: Record<string, { index: number; imageinfo?: { thumburl?: string; mime: string; width: number }[] }> } }).query?.pages ?? {});
    return pages
      .sort((a, b) => a.index - b.index)
      .map((p) => p.imageinfo?.[0])
      .filter((i): i is { thumburl: string; mime: string; width: number } => !!i?.thumburl && /jpeg|png/.test(i.mime) && i.width >= 600 && !used.has(i.thumburl))
      .slice(0, n)
      .map((i) => i.thumburl);
  } catch {
    return [];
  }
}

async function download(url: string): Promise<Buffer | null> {
  try {
    const res = url.includes('wikimedia.org') ? await politeFetch(url) : await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    if (!res || !res.ok || !/^image\//.test(res.headers.get('content-type') ?? '')) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

const loads = async (url: string) => {
  try {
    return (await fetch(url, { method: 'HEAD' })).ok;
  } catch {
    return false;
  }
};

const config = loadConfig();
const c = await createContainer(config);
const db = c.mongo.db;

/** `n` uploaded pictures for these words (Commons first, Picsum to fill up). */
async function pictures(owner: ObjectId, words: string, n: number, seed: string) {
  const urls = await commons(words, n + 3);
  const out: { mediaId: ObjectId; url: string }[] = [];
  for (const url of urls) {
    if (out.length >= n) break;
    const buf = await download(url);
    if (!buf) continue;
    try {
      const m = await c.modules.media.service.upload(owner, 'business', buf, API_BASE);
      used.add(url);
      out.push({ mediaId: m._id, url: m.url });
    } catch (err) {
      console.warn(`  skipped ${url}: ${(err as Error).message}`);
    }
  }
  for (let i = 0; out.length < n && i < 5; i++) {
    const buf = await download(`https://picsum.photos/seed/${encodeURIComponent(`${seed}-${i}`)}/1000/750`);
    if (!buf) continue;
    const m = await c.modules.media.service.upload(owner, 'business', buf, API_BASE);
    out.push({ mediaId: m._id, url: m.url });
    console.warn(`  « ${words} »: nothing usable on Commons, a random Picsum photo instead`);
  }
  return out;
}

/** Who the pictures belong to: the shop's owner (else the first admin). */
async function ownerOf(orgId: ObjectId): Promise<ObjectId> {
  const m = await db.collection('memberships').findOne({ orgId, status: 'active', roles: 'owner' });
  if (m) return m.userId as ObjectId;
  const admin = await db.collection('users').findOne({ platformRoles: 'admin' });
  if (!admin) throw new Error('No owner nor admin to own the pictures.');
  return admin._id as ObjectId;
}

let shops = 0;
let items = 0;
try {
  for (const b of await db.collection('businesses').find({ kind: { $in: ['shop', 'restaurant'] } }).toArray()) {
    const owner = await ownerOf(b.orgId);
    if (await pick(b.name, async () => !b.photo?.url || !(await loads(b.photo.url)))) {
      const [photo] = await pictures(owner, SHOP_WORDS[b.name] ?? `${b.specialties?.[0] ?? ''} ${b.kind === 'restaurant' ? 'restaurant' : 'shop'}`, 1, `shop-${b._id}`);
      if (photo) {
        await db.collection('businesses').updateOne({ _id: b._id }, { $set: { photo, updatedAt: new Date() } });
        shops++;
        console.log(`${b.kind === 'restaurant' ? 'resto' : 'shop '} ${b.name}`);
      }
    }
    for (const it of await db.collection('catalogItems').find({ businessId: b._id }).toArray()) {
      const current = (it.photos ?? []) as { url: string }[];
      const broken = async () => !current.length || (await Promise.all(current.map((p) => loads(p.url)))).some((ok) => !ok);
      if (!(await pick(it.name, broken))) continue;
      const photos = await pictures(owner, ITEM_WORDS[it.name] ?? it.name, PER_ITEM, `item-${it._id}`);
      if (!photos.length) continue;
      await db.collection('catalogItems').updateOne({ _id: it._id }, { $set: { photos, updatedAt: new Date() } });
      items++;
      console.log(`item  ${b.name} · ${it.name} (${photos.length})`);
    }
  }
  console.log(`\nDone: ${shops} business photo(s), ${items} item(s) updated.`);
} finally {
  await c.close();
}
