import { buildApp } from '../../src/app.js';
import { migrateDatabase } from '../../src/collections.js';
import { loadConfig } from '../../src/config/env.js';
import { createContainer } from '../../src/container.js';
import { withTransaction } from '../../src/platform/db/mongo.js';
import { normalizePhone } from '../../src/platform/phone.js';
import { hashPassword } from '../../src/platform/security/passwords.js';
import { localDate } from '../../src/modules/public-restos/public-restos.service.js';
import { networkInterfaces } from 'node:os';

import { ObjectId } from 'mongodb';
import sharp from 'sharp';

import { bannerPackages, businesses, campusPlaces, demoAds, demoPictures, DEMO_PASSWORD, departures, organizations, publicRestos, restoAssignments, retiredPlaces, seedAlerts, staff, students, taxiTrips, vehicles } from './data.js';

// Development data mirroring ugb-connect/constants/data.ts. Idempotent; refuses to run against production.
const config = loadConfig();
if (config.isProduction) throw new Error('The seed never runs in production.');

const c = await createContainer(config);
const { accounts, organizations: orgs } = c.modules;
const log = (msg: string) => console.log(`  ${msg}`);

try {
  await migrateDatabase(c.mongo.db);
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  console.log('Organizations');
  const orgIds = new Map<string, import('mongodb').ObjectId>();
  for (const o of organizations) {
    const existing = await c.mongo.db.collection('organizations').findOne({ slug: o.slug });
    const id = existing?._id ?? (await orgs.create({ slug: o.slug, name: o.name, category: o.category, capabilities: o.capabilities, level: o.level, payoutPhone: o.payoutPhone, email: o.email }))._id;
    // Seed-only: ratings and trip counts have no write path yet (no rating flow, Q-22).
    await c.mongo.db.collection('organizations').updateOne({ _id: id }, { $set: { stats: o.stats, capabilities: o.capabilities, ...(o.email ? { email: o.email } : {}) } });
    orgIds.set(o.slug, id);
    log(`${o.name} (${o.level})`);
  }

  console.log('Students');
  for (const s of students) {
    const phone = normalizePhone(s.phone)!;
    let user = await accounts.findByPhone(phone);
    if (!user) {
      user = await withTransaction(c.mongo.client, (session) =>
        accounts.createStudentAccount({ phone, studentNumber: s.studentNumber, firstName: s.firstName, lastName: s.lastName, campus: s.campus, onCampus: s.village !== null, village: s.village, room: s.room, ufr: s.ufr, region: s.region, passwordHash, termsVersion: '2026-01' }, session),
      );
    }
    // Demo accounts created before UFR and region were asked at sign-up.
    await c.mongo.db.collection('studentProfiles').updateOne({ userId: user._id, ufr: null }, { $set: { ufr: s.ufr, region: s.region } });
    for (const m of s.memberships ?? []) await (m.roles.includes('owner') ? orgs.setOwner(orgIds.get(m.org)!, phone, null) : orgs.setMember(orgIds.get(m.org)!, 'organizer', { phone, roles: m.roles }, null));
    if (s.platformRoles) await accounts.setPlatformRoles(user._id, s.platformRoles);
    log(`${s.firstName} ${s.lastName} · ${s.phone} · ${s.studentNumber} · UFR ${s.ufr} · ${s.region}${s.memberships ? ` · ${s.memberships.map((m) => `${m.org}:${m.roles.join('+')}`).join(', ')}` : ''}${s.platformRoles ? ` · ${s.platformRoles.join('+')}` : ''}`);
  }

  console.log('Staff (no student space)');
  for (const s of staff) {
    const phone = normalizePhone(s.phone)!;
    let user = await accounts.findByPhone(phone);
    if (!user) {
      user = await accounts.createStaffUser({ phone, firstName: s.firstName, lastName: s.lastName });
      await accounts.setPassword(user._id, passwordHash);
    }
    if (s.platformRoles) await accounts.setPlatformRoles(user._id, s.platformRoles);
    for (const m of s.memberships ?? []) await (m.roles.includes('owner') ? orgs.setOwner(orgIds.get(m.org)!, phone, null) : orgs.setMember(orgIds.get(m.org)!, 'organizer', { phone, roles: m.roles }, null));
    log(`${s.firstName} ${s.lastName} · ${s.phone}${s.platformRoles ? ` · ${s.platformRoles.join('+')}` : ''}${s.memberships ? ` · ${s.memberships.map((m) => `${m.org}:${m.roles.join('+')}`).join(', ')}` : ''}`);
  }

  console.log('Campus places (added when missing, by name)');
  log(`${await c.modules.places.service.retire(retiredPlaces)} retired, ${await c.modules.places.service.seed(campusPlaces)} added`);

  console.log('Public restaurants (menus for the next 7 days; existing menus kept)');
  {
    const svc = c.modules.publicRestos.service;
    const agent = (await accounts.findByPhone(normalizePhone('770000004')!))!;
    const existing = await svc.listRestos();
    for (const [i, r] of publicRestos.entries()) {
      const found = existing.find((x) => x.slug === r.slug);
      const resto = found ? await svc.updateResto(found._id, { location: r.location, campus: r.campus, coords: r.coords }) : await svc.createResto({ slug: r.slug, name: r.name, location: r.location, campus: r.campus, coords: r.coords, sortOrder: i + 1 });
      let added = 0;
      for (let day = 0; day < 7; day++) {
        const date = localDate(new Date(Date.now() + day * 24 * 3_600_000));
        for (const meal of ['lunch', 'dinner'] as const) {
          if (await c.mongo.db.collection('publicMenus').findOne({ restoId: resto._id, date, meal })) continue;
          const sets = r[meal];
          await svc.putMenu(resto._id, date, meal, sets[day % sets.length]!.map((d) => ({ ...d, status: day === 0 ? d.status : undefined })), agent._id);
          added++;
        }
      }
      log(`${r.name}: ${added} menus added`);
    }
    // Each menu publisher works on the restaurants the super admin gave them.
    const bySlug = new Map((await svc.listRestos()).map((r) => [r.slug, r._id]));
    for (const [phone, slugs] of Object.entries(restoAssignments)) {
      const u = await accounts.findByPhone(normalizePhone(phone)!);
      if (!u) continue;
      await c.mongo.db.collection('users').updateOne({ _id: u._id }, { $set: { restoIds: slugs.map((s) => bySlug.get(s)).filter(Boolean) } });
      log(`${u.firstName} ${u.lastName} publishes the menus of ${slugs.join(', ')}`);
    }
  }

  console.log('Alerts and "À la une" (each one unless it is already running or scheduled)');
  {
    const now = new Date();
    const editor = async (phone: string) => {
      const u = (await accounts.findByPhone(normalizePhone(phone)!))!;
      return { userId: u._id, roles: u.platformRoles };
    };
    const [comm, scolarite] = [await editor('770000005'), await editor('770000006')];
    for (const { who, a } of seedAlerts(now)) {
      // Already there (from an earlier seed): give it this audience and text.
      const there = await c.mongo.db.collection('alerts').findOne({ title: a.title, endsAt: { $gt: now }, withdrawnAt: null });
      if (there) {
        await c.mongo.db.collection('alerts').updateOne({ _id: there._id }, { $set: { audience: a.audience, body: a.body } });
        continue;
      }
      await c.modules.alerts.service.create(a, who === 'academic' ? scolarite : comm);
      log(`${a.placement === 'headline' ? `À la une · ${a.tag}` : 'Bandeau'} · ${a.title}${a.startsAt > now ? ' (programmée)' : ''}`);
    }
  }

  console.log('Banners and events (packages always; events and banners when none is running)');
  {
    const { banners: bannersMod, events: eventsMod, media } = c.modules;
    for (const p of bannerPackages) await bannersMod.service.putPackage(p.code, { ...p, active: true });
    log(bannerPackages.map((p) => `${p.name} ${p.price} FCFA`).join(' · '));
    // Picture URLs are stored absolute: the Mac's Wi-Fi address, so a phone on the same network loads them.
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? 'localhost';
    const apiBase = config.PUBLIC_API_URL ? `${config.PUBLIC_API_URL}/api/v1` : `http://${lan}:${config.PORT}/api/v1`;
    const art = (colors: readonly [string, string]) =>
      sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs><rect width="1200" height="675" fill="url(#g)"/><circle cx="1010" cy="120" r="230" fill="#fff" fill-opacity="0.12"/><circle cx="160" cy="610" r="190" fill="#fff" fill-opacity="0.08"/><circle cx="760" cy="520" r="90" fill="#fff" fill-opacity="0.1"/></svg>`,
        ),
      )
        .png()
        .toBuffer();
    const upload = async (owner: ObjectId, purpose: 'banner' | 'event', key: keyof typeof demoPictures) => media.service.upload(owner, purpose, await art(demoPictures[key]), apiBase);

    const now = new Date();
    const awa = (await accounts.findByPhone(normalizePhone('770000002')!))!;
    const adminUser = (await accounts.findByPhone(normalizePhone('770000099')!))!;
    const amicale = orgIds.get('amicale-zig')!;
    const db = c.mongo.db;
    let soiree = await db.collection('events').findOne({ orgId: amicale, status: 'published', endsAt: { $gt: now } });
    if (!soiree) {
      const at = (days: number, h: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, h));
      const pics = [await upload(awa._id, 'event', 'soiree1'), await upload(awa._id, 'event', 'soiree2'), await upload(awa._id, 'event', 'soiree3')];
      const party = await eventsMod.service.create(amicale, awa._id, {
        title: 'Soirée culturelle casamançaise', category: 'soiree',
        description: 'Danses traditionnelles, kora, buffet de spécialités de Casamance et DJ jusqu’à 2h. Ouvert à tous les étudiants de l’UGB.',
        imageIds: pics.map((p) => p._id.toHexString()), venue: { name: 'Esplanade du Village E', address: 'Campus 1' },
        startsAt: at(6, 20).toISOString(), endsAt: at(7, 2).toISOString(), maxPerStudent: 4,
        ticketTypes: [{ name: 'Standard', price: 2000, capacity: 150 }, { name: 'VIP', description: 'Table réservée et une boisson', price: 5000, capacity: 30 }],
      });
      await eventsMod.service.publish(amicale, party._id);
      const conf = await eventsMod.service.create(amicale, awa._id, {
        title: 'Conférence : entreprendre au Sénégal', category: 'conference', description: 'Trois jeunes entrepreneurs racontent leur parcours. Questions-réponses.',
        imageIds: [(await upload(awa._id, 'event', 'conference'))._id.toHexString()], venue: { name: 'Amphi UFR SEG' },
        startsAt: at(9, 15).toISOString(), endsAt: at(9, 18).toISOString(), ticketTypes: [{ name: 'Entrée libre', price: 0, capacity: 200 }],
      });
      await eventsMod.service.publish(amicale, conf._id);
      soiree = await db.collection('events').findOne({ _id: party._id });
      log('Events: Soirée culturelle casamançaise (2 000 / 5 000 FCFA), Conférence (gratuite)');
    }
    // Seed-only: approved banners running from today (the real flow pays, waits for review and starts tomorrow at the earliest).
    if (!(await db.collection('banners').findOne({ status: 'approved', endsAt: { $gt: now } }))) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const end = new Date(start.getTime() + 7 * 24 * 3_600_000);
      const base = { packageCode: 'semaine', days: 7, price: 5000, method: 'wave', startsAt: start, endsAt: end, status: 'approved', paymentId: null, review: { by: adminUser._id, at: now, reason: null }, refundPayoutId: null, createdAt: now, updatedAt: now };
      for (const a of demoAds) {
        const img = await upload(adminUser._id, 'banner', a.picture);
        await db.collection('banners').insertOne({ _id: new ObjectId(), kind: 'ad', ownerId: adminUser._id, orgId: null, eventId: null, title: a.title, description: a.description, image: { mediaId: img._id, url: img.url }, cta: a.cta, ...base });
      }
      if (soiree) {
        await db.collection('banners').insertOne({ _id: new ObjectId(), kind: 'event', ownerId: awa._id, orgId: amicale, eventId: soiree._id, title: soiree.title as string, description: 'Kora, danses et buffet · Esplanade du Village E', image: (soiree.images as { mediaId: ObjectId; url: string }[])[0], cta: null, ...base });
      }
      log(`Banners: ${demoAds.length} ads + the soirée, until ${end.toISOString().slice(0, 10)}`);
    }
  }

  if (config.PAYMENTS_SIMULATOR) {
    console.log('Caravans (new departures only when an organizer has none to come)');
    const caravans = c.modules.caravans.service;
    const caravanApp = await buildApp(c);
    await caravanApp.ready();
    await caravans.sweep();
    const vehicleIds = new Map<string, import('mongodb').ObjectId>();
    for (const v of vehicles) {
      const orgId = orgIds.get(v.org)!;
      const existing = await c.mongo.db.collection('vehicles').findOne({ plate: v.plate });
      if (existing) {
        vehicleIds.set(v.plate, existing._id);
        continue;
      }
      const created = await caravans.createVehicle(orgId, { label: v.label, plate: v.plate, capacity: v.capacity, airConditioned: v.airConditioned });
      // A catalog vehicle: its plan, as when an organizer picks it in the app.
      const model = v.model ? await c.mongo.db.collection('vehicle_models').findOne({ key: v.model }) : null;
      if (model) await c.mongo.db.collection('vehicles').updateOne({ _id: created._id }, { $set: { model: model.key, layout: model.layout, capacity: model.capacity } });
      vehicleIds.set(v.plate, created._id);
    }
    const now = Date.now();
    const iso = (min: number) => new Date(now + min * 60_000).toISOString();
    for (const d of departures) {
      const vehicle = (await c.mongo.db.collection('vehicles').findOne({ _id: vehicleIds.get(d.plate) }))!;
      // Idempotent: a route already coming up on this vehicle isn't seeded again.
      const exists = await c.mongo.db.collection('departures').findOne({
        vehicleId: vehicle._id, direction: d.direction, from: d.from, to: d.to, status: { $in: ['published', 'confirmed'] }, departureAt: { $gt: new Date(now) },
      });
      if (exists) continue;
      const orgId = vehicle.orgId;
      const created = await caravans.createDeparture(orgId, {
        vehicleId: vehicle._id.toHexString(), direction: d.direction, from: d.from, to: d.to, price: d.price, minPassengers: d.minPassengers,
        pickups: d.pickups.map(([place, off]) => ({ place, at: iso(d.inMinutes + off) })),
        dropoffs: d.dropoffs.map(([place, off]) => ({ place, at: iso(d.inMinutes + off) })),
        ...(d.confirmByMinutesBefore ? { confirmBy: iso(d.inMinutes - d.confirmByMinutesBefore) } : {}),
      });
      await caravans.publish(orgId, created._id);
      const buyers: string[] = [];
      for (const [phone, pi, di] of d.tickets ?? []) {
        const u = (await accounts.findByPhone(normalizePhone(phone)!))!;
        // A request, then validated by the organizer (the cash handed over).
        const { booking } = await caravans.book(u._id, created._id, { pickupStopId: `p${pi + 1}`, dropoffStopId: `d${di + 1}` });
        await caravans.validateRequest(orgId, booking.orderId);
        buyers.push(u.firstName);
      }
      log(`${d.from} → ${d.to} in ${Math.round(d.inMinutes / 60)} h · ${vehicle.plate}${buyers.length ? ` · tickets: ${buyers.join(', ')}` : ''}`);
    }
    await caravanApp.close();

    console.log('Private restaurants and shops (created when missing, by name)');
    {
      const commerce = c.modules.commerce.service;
      const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? 'localhost';
      const apiBase = config.PUBLIC_API_URL ? `${config.PUBLIC_API_URL}/api/v1` : `http://${lan}:${config.PORT}/api/v1`;
      const cover = (colors: readonly [string, string]) =>
        sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs><rect width="1200" height="600" fill="url(#g)"/><circle cx="980" cy="120" r="210" fill="#fff" fill-opacity="0.12"/><circle cx="180" cy="560" r="170" fill="#fff" fill-opacity="0.08"/></svg>`))
          .png()
          .toBuffer();
      const existing = new Set((await commerce.listAll()).map((b) => b.name));
      for (const biz of businesses) {
        if (existing.has(biz.name)) {
          log(`${biz.name}: already there`);
          continue;
        }
        const created = await commerce.create({ kind: biz.kind, name: biz.name, specialties: biz.specialties, owner: biz.owner, address: biz.address, campus: biz.campus, location: biz.location, services: biz.services, deliveryFees: biz.deliveryFees });
        const owner = (await accounts.findByPhone(normalizePhone(biz.owner.phone)!))!;
        await accounts.setPassword(owner._id, passwordHash);
        const photo = await c.modules.media.service.upload(owner._id, 'business', await cover(biz.colors), apiBase);
        await commerce.update({ orgId: created.orgId, kind: created.kind }, owner._id, { photoId: photo._id.toHexString(), description: biz.description });
        for (const [i, item] of biz.items.entries()) await commerce.addItem({ orgId: created.orgId, kind: created.kind }, owner._id, { ...item, sortOrder: i });
        log(`${biz.kind === 'restaurant' ? 'Resto' : 'Boutique'} ${biz.name} · owner ${biz.owner.firstName} ${biz.owner.phone} · ${biz.items.length} items`);
      }
    }

    console.log('Lost and found (demo items when the board is empty)');
    if (!(await c.mongo.db.collection('lostItems').countDocuments({}, { limit: 1 }))) {
      const lost = c.modules.lost.service;
      const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? 'localhost';
      const apiBase = config.PUBLIC_API_URL ? `${config.PUBLIC_API_URL}/api/v1` : `http://${lan}:${config.PORT}/api/v1`;
      const who = async (phone: string) => (await accounts.findByPhone(normalizePhone(phone)!))!._id;
      const photo = async (owner: ObjectId, color: string) =>
        (await c.modules.media.service.upload(owner, 'lost', await sharp({ create: { width: 900, height: 900, channels: 3, background: color } }).png().toBuffer(), apiBase))._id.toHexString();
      const moussa = await who('771234567');
      const fatou = await who('781112233');
      const ibrahima = await who('761234500');
      await lost.declare(moussa, { status: 'found', category: 'bag', name: 'Sac à dos bleu', details: 'Bleu nuit, logo jaune', secret: 'Un cahier de maths dedans', where: 'Resto 1', when: 'yesterday', holder: 'finder', imageId: await photo(moussa, '#1F3A8A') });
      await lost.declare(fatou, { status: 'found', category: 'phone', name: 'Téléphone', details: 'Coque transparente', where: 'Village E', spot: 'Banc devant le pavillon', when: 'today', holder: 'office', imageId: await photo(fatou, '#222831') });
      await lost.declare(moussa, { status: 'found', category: 'id-card', where: 'BU', when: 'today', holder: 'office', ownerName: 'Mariama S.' });
      await lost.declare(ibrahima, { status: 'lost', category: 'calculator', name: 'Calculatrice Casio', details: 'fx-92, nom au dos', where: 'Amphi A', when: 'yesterday' });
      await lost.declare(fatou, { status: 'lost', category: 'glasses', name: 'Lunettes de vue', details: 'Monture écaille, étui noir', where: 'Resto 2', when: 'this_week' });
      log('2 found objects (bag with Moussa, phone at the office), an identity card at the office, 2 lost (calculator, glasses)');
    } else log('board not empty: skipped');

    console.log('Sunu Taxi (skipped for organizers who already have a trip)');
    const taxi = c.modules.taxi.service;
    const app = await buildApp(c);
    await app.ready();
    await taxi.sweep();
    const backfilled = await taxi.backfillChats();
    if (backfilled) log(`${backfilled} existing trip(s) got their chat`);
    for (const tr of taxiTrips) {
      const org = (await accounts.findByPhone(normalizePhone(tr.organizer)!))!;
      if (await taxi.activeTripOf(org._id)) {
        log(`${org.firstName}: already in a trip`);
        continue;
      }
      const { trip } = await taxi.create(org._id, { from: tr.from, to: tr.to, seats: tr.seats, fare: tr.fare, leaveInMinutes: tr.leaveInMinutes });
      const joined: string[] = [];
      for (const phone of tr.passengers) {
        const u = (await accounts.findByPhone(normalizePhone(phone)!))!;
        if (await taxi.activeTripOf(u._id)) continue;
        const { payment } = await taxi.join(u._id, trip._id, { method: 'wave' }, `http://localhost:${config.PORT}`);
        // Paid through the simulator page, like a student would (a reservation without payment needs nothing more).
        if (payment) await app.inject({ method: 'POST', url: `/api/v1/dev/payment-simulator/${payment.reference}/pay`, headers: { 'content-type': 'text/plain' }, payload: '' });
        joined.push(u.firstName);
      }
      log(`${org.firstName}: ${tr.from} → ${tr.to} in ${tr.leaveInMinutes} min, ${trip.seatPrice} FCFA/place${joined.length ? `, with ${joined.join(', ')}` : ''}`);
    }
    await app.close();
  }

  console.log(`\nDone. Every demo account uses the password "${DEMO_PASSWORD}". OTP code in development: 1234.`);
} finally {
  await c.close();
}
