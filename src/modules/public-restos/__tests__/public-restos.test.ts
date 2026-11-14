import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, registerStudent, type TestApp } from '../../../../test/harness.js';
import { LogPushSender } from '../../notifications/push.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

type Who = { userId: string };
async function call(who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  const { accessToken } = await t.c.modules.identity.startSession({ _id: new ObjectId(who.userId), platformRoles: [] });
  return t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(accessToken), payload });
}
const ok = async (res: Promise<{ statusCode: number; body: string }>, status = 200) => {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return json(r);
};
/** Broadcast pushes queued for the worker. */
const broadcasts = async () =>
  (await t.c.queues.get('notifications.push').getJobs(['waiting', 'delayed'])).map((j) => j.data as { audience?: string; title: string; body: string; url: string; category: string }).filter((j) => j.audience === 'all');

let seq = 0;
/** A restaurant, staff and a student; the clock at 12:30 in Dakar on `day` (Dakar is UTC+0). */
async function setup(day = '2026-11-02') {
  t.clock.set(Date.parse(`${day}T09:00:00Z`));
  // The super admin creates the restaurant and gives it to a menu publisher.
  const admin = { userId: (await createStaff(t, ['admin', 'team_manager', 'payments_manager', 'notifications_sender'])).userId.toHexString() };
  const staff = await createStaff(t);
  const s = { userId: staff.userId.toHexString() };
  const resto = await ok(call(admin, 'POST', '/admin/public-restos', { slug: `resto-t${++seq}-${Date.now() % 1e5}`, name: `Resto ${seq}`, location: 'Campus 1', sortOrder: seq }), 201);
  expect((await call(admin, 'PUT', '/admin/team', { phone: staff.phone, roles: ['resto_u_staff'], restoIds: [resto.id] })).statusCode).toBe(204);
  const menu = await ok(
    call(s, 'PUT', `/admin/public-restos/${resto.id}/menus/${day}/lunch`, {
      dishes: [
        { name: 'Vermicelle', detail: 'Poulet · légumes' },
        { name: 'Mafé yap', detail: 'Riz · sauce arachide', status: 'low' },
        { name: 'Thiébou dieun', detail: 'Riz au poisson' },
      ],
    }),
  );
  return { staff: s, admin, resto, menu, day, student: await registerStudent(t) };
}

const types = (me: { spaces: { type: string }[] }) => me.spaces.map((x) => x.type);

describe('staff space', () => {
  it('each role opens its space; two roles, two spaces; admins get them all', async () => {
    const cases = [
      [['resto_u_staff'], ['resto']],
      [['content_editor'], ['alerts']],
      [['resto_u_staff', 'content_editor'], ['resto', 'alerts']],
      [['admin'], ['admin', 'resto', 'alerts', 'directory']],
      [['place_editor', 'shop_editor'], ['directory']],
      [['finance'], []],
    ] as const;
    for (const [roles, spaces] of cases) {
      const u = await createStaff(t, [...roles]);
      expect(types(json(await call({ userId: u.userId.toHexString() }, 'GET', '/me')))).toEqual(spaces);
    }
  });

  it('a student given a role stays a student first, with the role’s space next', async () => {
    const s = await registerStudent(t);
    await t.c.modules.accounts.setPlatformRoles(new ObjectId(s.userId), ['resto_u_staff']);
    const me = json(await call(s, 'GET', '/me'));
    expect(types(me)).toEqual(['student', 'resto']);
    expect(me.platformRoles).toEqual(['resto_u_staff']);
  });
});

describe('menus', () => {
  it('staff publish the day’s menus; students see them; others can’t publish', async () => {
    const { resto, menu, day, student } = await setup();
    expect(menu.dishes.map((d: { name: string; status: string }) => `${d.name}:${d.status}`)).toEqual(['Vermicelle:available', 'Mafé yap:low', 'Thiébou dieun:available']);
    const today = await ok(call(student, 'GET', '/public-restos'));
    expect(today.date).toBe(day);
    const mine = today.restos.find((r: { id: string }) => r.id === resto.id);
    expect(mine).toMatchObject({ name: resto.name, services: { lunch: { start: '12:00', end: '15:00' } }, menus: { dinner: null } });
    expect(mine.menus.lunch.dishes).toHaveLength(3);
    expect((await call(student, 'PUT', `/admin/public-restos/${resto.id}/menus/${day}/dinner`, { dishes: [{ name: 'Niébé' }] })).statusCode).toBe(403);
    const admin = await createStaff(t, ['admin', 'team_manager', 'payments_manager', 'notifications_sender']);
    await ok(call({ userId: admin.userId.toHexString() }, 'PUT', `/admin/public-restos/${resto.id}/menus/${day}/dinner`, { dishes: [{ name: 'Niébé', detail: 'Haricots · pain' }] }));
    expect((await ok(call(student, 'GET', `/public-restos?date=${day}`))).restos.find((r: { id: string }) => r.id === resto.id).menus.dinner.dishes[0].name).toBe('Niébé');
  });

  it('publishing again keeps the stock level of dishes sent with their id; the week can be read back', async () => {
    const { staff, resto, menu, day } = await setup();
    const [v, , th] = menu.dishes;
    const again = await ok(call(staff, 'PUT', `/admin/public-restos/${resto.id}/menus/${day}/lunch`, { dishes: [{ id: v.id, name: 'Vermicelle' }, { id: th.id, name: 'Thiébou dieun', detail: 'Riz au poisson' }, { name: 'Yassa' }] }));
    expect(again.dishes.map((d: { id: string; status: string }) => [d.id === v.id || d.id === th.id, d.status])).toEqual([[true, 'available'], [true, 'available'], [false, 'available']]);
    expect((await call(staff, 'PUT', `/admin/public-restos/${resto.id}/menus/${day}/lunch`, { dishes: [{ name: 'Yassa' }, { name: 'yassa' }] })).statusCode).toBe(400);
    const week = await ok(call(staff, 'GET', `/admin/public-restos/${resto.id}/menus?from=${day}&to=2026-11-08`));
    expect(week.items).toHaveLength(1);
  });

  it('the dish catalogue: the usual dishes, plus every dish published (once per menu); a typo can be removed', async () => {
    const { staff, resto, day, student } = await setup();
    type C = { id: string; name: string; detail: string; meals: string[]; uses: number };
    const dinner = (await ok(call(staff, 'GET', '/admin/public-dishes?meal=dinner'))).items as C[];
    // Seeded: Niébé is a dinner dish, offered before the lunch-only ones.
    expect(dinner.findIndex((d) => d.name === 'Niébé')).toBeLessThan(dinner.findIndex((d) => d.name === 'Domoda'));
    const find = async (name: string) => ((await ok(call(staff, 'GET', '/admin/public-dishes'))).items as C[]).find((d) => d.name === name);
    const vermicelle = (await find('Vermicelle'))!.uses;
    // A new dish typed by hand joins it; republishing the same menu doesn't count it twice.
    const menu = await ok(call(staff, 'PUT', `/admin/public-restos/${resto.id}/menus/${day}/dinner`, { dishes: [{ name: 'Poulet braisé du chef', detail: 'Frites' }, { name: 'Vermicelle' }] }));
    await ok(call(staff, 'PUT', `/admin/public-restos/${resto.id}/menus/${day}/dinner`, { dishes: menu.dishes.map((d: { id: string; name: string }) => ({ id: d.id, name: d.name })) }));
    const added = (await find('Poulet braisé du chef'))!;
    expect(added).toMatchObject({ detail: '', meals: ['dinner'], uses: 1 });
    expect((await find('Vermicelle'))!.uses).toBe(vermicelle + 1);
    expect((await call(student, 'GET', '/admin/public-dishes')).statusCode).toBe(403);
    expect((await call(staff, 'DELETE', `/admin/public-dishes/${added.id}`)).statusCode).toBe(204);
    expect(await find('Poulet braisé du chef')).toBeUndefined();
  });

  it('a menu publisher works on their restaurants only; lunch and dinner are published separately', async () => {
    const { staff, resto, day } = await setup();
    const other = await setup();
    // Only theirs in the list; the other restaurant answers 404, and creating restaurants is the admin's.
    expect((await ok(call(staff, 'GET', '/admin/public-restos'))).items.map((r: { id: string }) => r.id)).toEqual([resto.id]);
    expect((await call(staff, 'PUT', `/admin/public-restos/${other.resto.id}/menus/${day}/dinner`, { dishes: [{ name: 'Niébé' }] })).statusCode).toBe(404);
    expect((await call(staff, 'POST', '/admin/public-restos', { slug: 'resto-x', name: 'Resto X' })).statusCode).toBe(403);
    // Dinner later in the day, lunch untouched.
    await ok(call(staff, 'PUT', `/admin/public-restos/${resto.id}/menus/${day}/dinner`, { dishes: [{ name: 'Niébé' }] }));
    const r = (await ok(call(staff, 'GET', `/public-restos?date=${day}`))).restos.find((x: { id: string }) => x.id === resto.id);
    expect([r.menus.lunch.dishes.length, r.menus.dinner.dishes.length]).toEqual([3, 1]);
  });
});

describe('rupture', () => {
  it('a dish sold out: alert on the home screen until the end of lunch, one push; back in stock clears it', async () => {
    const { staff, resto, menu, day, student } = await setup();
    const th = menu.dishes[2];
    const url = `/admin/public-restos/${resto.id}/menus/${day}/lunch/dishes/${th.id}`;
    // Only the meal being served (from 30 min before it opens): not lunch at 10h, nor while dinner is served.
    t.clock.set(Date.parse(`${day}T10:00:00Z`));
    expect(json(await call(staff, 'PATCH', url, { status: 'out' })).code).toBe('MEAL_NOT_SERVING');
    t.clock.set(Date.parse(`${day}T19:30:00Z`));
    expect(json(await call(staff, 'PATCH', url, { status: 'out' })).code).toBe('MEAL_NOT_SERVING');
    t.clock.set(Date.parse(`${day}T11:40:00Z`));
    await ok(call(staff, 'PATCH', url, { status: 'low' }));
    t.clock.set(Date.parse(`${day}T12:30:00Z`));
    const before = (await broadcasts()).length;
    expect((await ok(call(staff, 'PATCH', url, { status: 'out', notify: true }))).dishes[2].status).toBe('out');
    const alerts = (await ok(call(student, 'GET', '/alerts'))).items;
    const a = alerts.find((x: { title: string }) => x.title === `Rupture · Thiébou dieun · ${resto.name}`);
    expect(a).toMatchObject({ kind: 'resto_stock', tone: 'warning', href: '/(tabs)', endsAt: `${day}T15:00:00.000Z` });
    expect(a.body).toBe(`Plus de Thiébou dieun au ${resto.name} pour le déjeuner. Encore au menu : Vermicelle, Mafé yap.`);
    // Jobs aren't listed in creation order: find it by title.
    expect((await broadcasts()).length - before).toBe(1);
    expect((await broadcasts()).find((j) => j.title === a.title)).toMatchObject({ category: 'campus', url: '/(tabs)' });

    // Reported twice: still one alert, no second push.
    await ok(call(staff, 'PATCH', url, { status: 'out' }));
    expect((await ok(call(student, 'GET', '/alerts'))).items.filter((x: { title: string }) => x.title === a.title)).toHaveLength(1);
    expect((await broadcasts()).length - before).toBe(1);

    await ok(call(staff, 'PATCH', url, { status: 'available' }));
    expect((await ok(call(student, 'GET', '/alerts'))).items.some((x: { title: string }) => x.title === a.title)).toBe(false);

    // Sold out again later, this time without a notification: the alert only. Then the service ends: gone.
    t.clock.set(Date.parse(`${day}T13:30:00Z`));
    await ok(call(staff, 'PATCH', url, { status: 'out' }));
    expect((await ok(call(student, 'GET', '/alerts'))).items.some((x: { title: string }) => x.title === a.title)).toBe(true);
    expect((await broadcasts()).length - before).toBe(1);
    t.clock.set(Date.parse(`${day}T15:01:00Z`));
    expect((await ok(call(student, 'GET', '/alerts'))).items.some((x: { title: string }) => x.title === a.title)).toBe(false);
  });

  it('removing a sold-out dish from the menu clears its alert; a rupture on another day isn’t news', async () => {
    const { staff, resto, menu, day, student } = await setup();
    t.clock.set(Date.parse(`${day}T12:30:00Z`));
    const [v, m, th] = menu.dishes;
    await ok(call(staff, 'PATCH', `/admin/public-restos/${resto.id}/menus/${day}/lunch/dishes/${th.id}`, { status: 'out' }));
    await ok(call(staff, 'PUT', `/admin/public-restos/${resto.id}/menus/${day}/lunch`, { dishes: [{ id: v.id, name: v.name }, { id: m.id, name: m.name }] }));
    expect((await ok(call(student, 'GET', '/alerts'))).items.some((x: { title: string }) => x.title.includes(resto.name))).toBe(false);

    const tomorrow = await ok(call(staff, 'PUT', `/admin/public-restos/${resto.id}/menus/2026-11-03/lunch`, { dishes: [{ name: 'Yassa', status: 'out' }] }));
    expect(tomorrow.dishes[0].status).toBe('out');
    expect((await ok(call(student, 'GET', '/alerts'))).items.some((x: { title: string }) => x.title.includes(resto.name))).toBe(false);
    expect((await call(staff, 'PATCH', `/admin/public-restos/${resto.id}/menus/${day}/lunch/dishes/NOPE1234`, { status: 'out' })).statusCode).toBe(404);
  });

  it('the broadcast reaches every phone whose “Campus” switch is on', async () => {
    const [on, off] = [await registerStudent(t), await registerStudent(t)];
    await call(on, 'PUT', '/me/push-tokens', { token: `ExponentPushToken[on-${Date.now()}]`, platform: 'android' });
    await call(off, 'PUT', '/me/push-tokens', { token: `ExponentPushToken[off-${Date.now()}]`, platform: 'ios' });
    await call(off, 'PUT', '/me/notification-preferences', { social: true, cours: true, paiements: true, campus: false });
    const sent: string[] = [];
    const sender = { send: async (ms: { to: string }[]) => (sent.push(...ms.map((m) => m.to)), ms.map(() => ({ ok: true as const }))) };
    await t.c.modules.notifications.sendPush({ userIds: [], audience: 'all', title: 'Rupture', body: 'x', url: '/', category: 'campus' }, sender);
    expect(sent.some((x) => x.startsWith('ExponentPushToken[on-'))).toBe(true);
    expect(sent.some((x) => x.startsWith('ExponentPushToken[off-'))).toBe(false);
    expect((await t.c.modules.notifications.sendPush({ userIds: [], audience: 'all', title: 'x', body: 'x', url: '/', category: 'campus' }, new LogPushSender())).sent).toBeGreaterThan(0);
  });
});

describe('campus alerts and "À la une"', () => {
  const editorOf = async (roles: ('content_editor' | 'academic_editor')[]) => ({ userId: (await createStaff(t, roles)).userId.toHexString() });

  it('the communication team posts a banner (optionally pushed), and withdraws it', async () => {
    t.clock.set(Date.parse('2026-11-02T08:00:00Z'));
    const editor = await editorOf(['content_editor']);
    const student = await registerStudent(t);
    const before = (await broadcasts()).length;
    const body = { title: 'Coupure d’eau · Village E', body: 'Aujourd’hui de 10h à 16h', endsAt: '2026-11-02T16:00:00Z', push: true };
    expect((await call(student, 'POST', '/admin/alerts', body)).statusCode).toBe(403);
    const a = await ok(call(editor, 'POST', '/admin/alerts', body), 201);
    expect(a).toMatchObject({ kind: 'campus', placement: 'banner', status: 'live', tone: 'warning', icon: 'warning-outline', href: null, push: true, editable: true });
    expect(a.pushedAt).toBeTruthy();
    expect((await broadcasts()).length - before).toBe(1);
    expect((await ok(call(student, 'GET', '/alerts'))).items.some((x: { id: string }) => x.id === a.id)).toBe(true);
    expect(await ok(call(editor, 'DELETE', `/admin/alerts/${a.id}`))).toMatchObject({ status: 'withdrawn', editable: false });
    expect((await ok(call(student, 'GET', '/alerts'))).items.some((x: { id: string }) => x.id === a.id)).toBe(false);
    expect((await call(editor, 'PUT', `/admin/alerts/${a.id}`, body)).statusCode).toBe(409);
    expect((await call(editor, 'POST', '/admin/alerts', { ...body, endsAt: '2026-11-01T00:00:00Z' })).statusCode).toBe(400);
  });

  it('“À la une”, prepared ahead: hidden until it starts, its push leaves then (once); editable meanwhile', async () => {
    t.clock.set(Date.parse('2026-11-01T09:00:00Z'));
    const editor = await editorOf(['content_editor']);
    const student = await registerStudent(t);
    const headline = { placement: 'headline', title: 'Paiement des bourses', body: 'Virement sur Wave et Orange Money', eventAt: '2026-11-05T08:00:00Z', startsAt: '2026-11-03T08:00:00Z', endsAt: '2026-11-06T00:00:00Z', push: true };
    expect((await call(editor, 'POST', '/admin/alerts', headline)).statusCode).toBe(400); // a tag is required
    const before = (await broadcasts()).length;
    const a = await ok(call(editor, 'POST', '/admin/alerts', { ...headline, tag: 'Bourses' }), 201);
    expect(a).toMatchObject({ placement: 'headline', tag: 'Bourses', status: 'scheduled', tone: 'info', icon: 'megaphone-outline', eventAt: '2026-11-05T08:00:00.000Z', pushedAt: null });
    expect((await ok(call(student, 'GET', '/alerts'))).items.some((x: { id: string }) => x.id === a.id)).toBe(false);
    const edited = await ok(call(editor, 'PUT', `/admin/alerts/${a.id}`, { ...headline, tag: 'Bourses', title: 'Paiement des bourses le 05 nov.' }));
    expect(edited.title).toBe('Paiement des bourses le 05 nov.');

    t.clock.set(Date.parse('2026-11-03T08:01:00Z'));
    expect(await t.c.modules.alerts.service.sweep()).toBe(1);
    expect(await t.c.modules.alerts.service.sweep()).toBe(0);
    expect((await broadcasts()).length - before).toBe(1);
    expect((await broadcasts()).filter((j) => j.title === 'Paiement des bourses le 05 nov.')).toEqual([expect.objectContaining({ category: 'campus' })]);
    const live = (await ok(call(student, 'GET', '/alerts'))).items.find((x: { id: string }) => x.id === a.id);
    expect(live).toMatchObject({ placement: 'headline', tag: 'Bourses', eventAt: '2026-11-05T08:00:00.000Z' });
    // Edited once online: it keeps its start, and isn't pushed again.
    await ok(call(editor, 'PUT', `/admin/alerts/${a.id}`, { ...headline, tag: 'Bourses', body: 'Virement Wave, Orange Money, et guichet', startsAt: '2026-11-04T00:00:00Z' }));
    expect((await ok(call(student, 'GET', '/alerts'))).items.find((x: { id: string }) => x.id === a.id).startsAt).toBe('2026-11-03T08:00:00.000Z');
    expect((await broadcasts()).length - before).toBe(1);
  });

  it('the academic team publishes and manages its own announcements; the communication team handles all', async () => {
    t.clock.set(Date.parse('2026-11-01T09:00:00Z'));
    const [comm, academic] = [await editorOf(['content_editor']), await editorOf(['academic_editor'])];
    const exam = { placement: 'headline', tag: 'Examens', title: 'Examens du 1er semestre', body: 'Calendrier affiché à la scolarité', endsAt: '2026-11-20T00:00:00Z' };
    const a = await ok(call(academic, 'POST', '/admin/alerts', exam), 201);
    expect(a).toMatchObject({ kind: 'academic', editable: true });
    expect((await call(academic, 'POST', '/admin/alerts', { ...exam, kind: 'campus' })).statusCode).toBe(403);
    const c = await ok(call(comm, 'POST', '/admin/alerts', { ...exam, tag: 'Élections', title: 'Élections des délégués' }), 201);
    expect(c.kind).toBe('campus');
    // Each sees everything; the academic team can't touch the communication team's items.
    const seen = (await ok(call(academic, 'GET', '/admin/alerts'))).items;
    expect(seen.find((x: { id: string }) => x.id === c.id)).toMatchObject({ editable: false, withdrawable: false });
    expect((await call(academic, 'DELETE', `/admin/alerts/${c.id}`)).statusCode).toBe(403);
    expect((await ok(call(comm, 'GET', '/admin/alerts'))).items.find((x: { id: string }) => x.id === a.id)).toMatchObject({ editable: true });
    await ok(call(comm, 'PUT', `/admin/alerts/${a.id}`, { ...exam, body: 'Calendrier en ligne' }));
    // The academic team opens the communication space too.
    expect(json(await call(academic, 'GET', '/me')).spaces.map((x: { type: string }) => x.type)).toEqual(['alerts']);
  });

  it('a restaurant’s rupture can be taken down by the communication team, not edited', async () => {
    const { staff, resto, menu, day } = await setup();
    t.clock.set(Date.parse(`${day}T12:30:00Z`));
    await ok(call(staff, 'PATCH', `/admin/public-restos/${resto.id}/menus/${day}/lunch/dishes/${menu.dishes[2].id}`, { status: 'out' }));
    const comm = await editorOf(['content_editor']);
    const r = (await ok(call(comm, 'GET', '/admin/alerts'))).items.find((x: { title: string }) => x.title.includes(resto.name));
    expect(r).toMatchObject({ kind: 'resto_stock', placement: 'banner', editable: false, withdrawable: true });
    expect((await call(comm, 'PUT', `/admin/alerts/${r.id}`, { title: 'x x x', body: '', endsAt: `${day}T15:00:00Z` })).statusCode).toBe(409);
    await ok(call(comm, 'DELETE', `/admin/alerts/${r.id}`));
  });
});

describe('who an alert is for', () => {
  const ids = async (who: Who) => (await ok(call(who, 'GET', '/alerts'))).items.map((x: { id: string }) => x.id);

  it('a UFR, a campus, a region, or the whole university; combined lists narrow', async () => {
    t.clock.set(Date.parse('2026-11-01T09:00:00Z'));
    const comm = { userId: (await createStaff(t, ['content_editor'])).userId.toHexString() };
    const sjp = await registerStudent(t, { ufr: 'SJP', region: 'Dakar' });
    const sat1 = await registerStudent(t, { ufr: 'SAT', campus: 'campus1', region: 'Kolda' });
    const sat2 = await registerStudent(t, { ufr: 'SAT', campus: 'campus2', region: 'Ziguinchor' });
    const unknown = await registerStudent(t, { ufr: 'SAT' });
    await t.c.mongo.db.collection('studentProfiles').updateOne({ userId: new ObjectId(unknown.userId) }, { $set: { ufr: null, region: null } }); // signed up before it was asked
    const staffOnly = { userId: (await createStaff(t, ['resto_u_staff'])).userId.toHexString() };
    const post = (title: string, audience?: object) =>
      ok(call(comm, 'POST', '/admin/alerts', { placement: 'headline', tag: 'Test', title, body: '', endsAt: '2026-11-10T00:00:00Z', ...(audience ? { audience } : {}) }), 201);

    const all = await post('Pour tous');
    const elections = await post('Élections UFR SJP', { campuses: [], ufrs: ['SJP'], regions: [] });
    const exams = await post('Examens UFR SAT, campus 1', { campuses: ['campus1'], ufrs: ['SAT'], regions: [] });
    const amicale = await post('Amicale de Ziguinchor', { campuses: [], ufrs: [], regions: ['Ziguinchor'] });
    expect(elections.audience).toEqual({ campuses: [], ufrs: ['SJP'], regions: [] });
    expect((await call(comm, 'POST', '/admin/alerts', { placement: 'headline', tag: 'x', title: 'Mauvais', body: '', endsAt: '2026-11-10T00:00:00Z', audience: { campuses: [], ufrs: ['UFR SAT'], regions: [] } })).statusCode).toBe(400);

    const sees = async (who: Who) => {
      const list = await ids(who);
      return [all, elections, exams, amicale].filter((a) => list.includes(a.id)).map((a) => a.title);
    };
    expect(await sees(sjp)).toEqual(['Pour tous', 'Élections UFR SJP']);
    expect(await sees(sat1)).toEqual(['Pour tous', 'Examens UFR SAT, campus 1']);
    expect(await sees(sat2)).toEqual(['Pour tous', 'Amicale de Ziguinchor']);
    expect(await sees(unknown)).toEqual(['Pour tous']);
    expect(await sees(staffOnly)).toEqual(['Pour tous']);
  });

  it('its push goes to the students it targets only', async () => {
    const [sat, seg] = [await registerStudent(t, { ufr: 'SAT' }), await registerStudent(t, { ufr: 'SEG' })];
    await call(sat, 'PUT', '/me/push-tokens', { token: `ExponentPushToken[sat-${Date.now()}]`, platform: 'android' });
    await call(seg, 'PUT', '/me/push-tokens', { token: `ExponentPushToken[seg-${Date.now()}]`, platform: 'android' });
    const sent: string[] = [];
    const sender = { send: async (ms: { to: string }[]) => (sent.push(...ms.map((m) => m.to)), ms.map(() => ({ ok: true as const }))) };
    await t.c.modules.notifications.sendPush(
      { userIds: [], audience: 'all', segment: { campuses: [], ufrs: ['SAT'], regions: [] }, title: 'Examens', body: 'x', url: '/', category: 'campus' },
      sender,
    );
    expect(sent.some((x) => x.startsWith('ExponentPushToken[sat-'))).toBe(true);
    expect(sent.some((x) => x.startsWith('ExponentPushToken[seg-'))).toBe(false);
  });

  it('a restaurant’s rupture reaches its campus only', async () => {
    const { staff, admin, resto, menu, day } = await setup();
    await ok(call(admin, 'PATCH', `/admin/public-restos/${resto.id}`, { campus: 'campus2' }));
    t.clock.set(Date.parse(`${day}T12:30:00Z`));
    await ok(call(staff, 'PATCH', `/admin/public-restos/${resto.id}/menus/${day}/lunch/dishes/${menu.dishes[0].id}`, { status: 'out' }));
    const [c1, c2] = [await registerStudent(t, { campus: 'campus1' }), await registerStudent(t, { campus: 'campus2' })];
    const titled = async (who: Who) => (await ok(call(who, 'GET', '/alerts'))).items.some((x: { title: string }) => x.title.includes(resto.name));
    expect(await titled(c1)).toBe(false);
    expect(await titled(c2)).toBe(true);
  });
});

