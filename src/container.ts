import type { Redis } from 'ioredis';

import type { Config } from './config/env.js';
import { ACCOUNTS_MEDIA_USAGE, createAccountsModule, type AccountsApi } from './modules/accounts/index.js';
import { ALERTS_MEDIA_USAGE, createAlertsModule, type AlertsApi } from './modules/alerts/index.js';
import { createMediaModule, type MediaApi } from './modules/media/index.js';
import { createEventsModule, EVENTS_MEDIA_USAGE, type EventsApi } from './modules/events/index.js';
import { BANNERS_MEDIA_USAGE, createBannersModule, type BannersApi } from './modules/banners/index.js';
import { createPublicRestosModule, type PublicRestosApi } from './modules/public-restos/index.js';
import { createHousingModule, type HousingApi } from './modules/housing/index.js';
import { createLostModule, LOST_MEDIA_USAGE, TesseractCardReader, type CardReader, type LostApi } from './modules/lost/index.js';
import { COMMERCE_MEDIA_USAGE, createCommerceModule, type CommerceApi } from './modules/commerce/index.js';
import { createPlacesModule, PLACES_MEDIA_USAGE, type PlacesApi } from './modules/places/index.js';
import { createRatingsModule, type RatingsApi } from './modules/ratings/index.js';
import { createAuditModule, type AuditApi } from './modules/audit/index.js';
import { createIdentityModule, type IdentityApi } from './modules/identity/index.js';
import { createOrganizationsModule, ORGANIZATIONS_MEDIA_USAGE, type OrganizationsApi } from './modules/organizations/index.js';
import { createCaravansModule, type CaravansApi } from './modules/caravans/index.js';
import { createMessagingModule, type MessagingApi } from './modules/messaging/index.js';
import { createNotificationsModule, type NotificationsApi } from './modules/notifications/index.js';
import { createPaymentsModule, type PaymentsApi } from './modules/payments/index.js';
import { createTaxiModule, type TaxiApi } from './modules/taxi/index.js';
import { createTicketingModule, type TicketingApi } from './modules/ticketing/index.js';
import { SessionDenylist } from './platform/auth/auth.js';
import { systemClock, type Clock } from './platform/clock.js';
import { connectMongo, type Mongo } from './platform/db/mongo.js';
import { Queues, redisConnection } from './platform/queue/queues.js';
import { RealtimeHub } from './platform/realtime/hub.js';
import { createRedis } from './platform/redis.js';
import { Limiter } from './platform/security/limiter.js';
import { TokenService } from './platform/security/tokens.js';

export type Container = {
  config: Config;
  clock: Clock;
  mongo: Mongo;
  redis: Redis;
  queues: Queues;
  tokens: TokenService;
  denylist: SessionDenylist;
  hub: RealtimeHub;
  modules: { audit: AuditApi; accounts: AccountsApi; organizations: OrganizationsApi; identity: IdentityApi; payments: PaymentsApi; messaging: MessagingApi; taxi: TaxiApi; ticketing: TicketingApi; caravans: CaravansApi; notifications: NotificationsApi; alerts: AlertsApi; publicRestos: PublicRestosApi; media: MediaApi; events: EventsApi; banners: BannersApi; lost: LostApi; housing: HousingApi; commerce: CommerceApi; places: PlacesApi; ratings: RatingsApi };
  close(): Promise<void>;
};

/** Composition root: builds infrastructure, then modules in dependency order, by hand (no DI framework). */
export async function createContainer(config: Config, opts: { clock?: Clock; warn?: (msg: string) => void; cardReader?: CardReader } = {}): Promise<Container> {
  const clock = opts.clock ?? systemClock;
  const mongo = await connectMongo(config.MONGODB_URI, config.MONGODB_DB);
  const redis = createRedis(config.REDIS_URL);
  const queues = new Queues(redisConnection(config.REDIS_URL), config.REDIS_PREFIX);
  const limiter = new Limiter(redis, config.REDIS_PREFIX, config.RATE_LIMIT_SCALE);
  const tokens = new TokenService(config, clock, () =>
    opts.warn?.('JWT keys not configured: using ephemeral keys (tokens are lost on restart). Run `npm run keys`.'),
  );
  const denylist = new SessionDenylist(redis, config.REDIS_PREFIX, tokens.accessTtlS);
  const hub = new RealtimeHub(redis, config.REDIS_URL, config.REDIS_PREFIX);

  const audit = createAuditModule(mongo.db, clock);
  // accounts needs organization memberships for /me, organizations needs accounts: the port is resolved lazily.
  const late: { organizations?: OrganizationsApi; notifications?: NotificationsApi; media?: MediaApi } = {};
  const accounts = createAccountsModule({ db: mongo.db, clock, rentree: config.ACADEMIC_YEAR_START, audit, organizations: () => late.organizations!, notifications: () => late.notifications!, media: () => late.media! });
  const organizations = (late.organizations = createOrganizationsModule({ db: mongo.db, clock, accounts, audit, notifications: () => late.notifications! }));
  const identity = createIdentityModule({ db: mongo.db, mongo: mongo.client, config, clock, queues, limiter, tokens, denylist, accounts, audit });
  const notifications = (late.notifications = createNotificationsModule({ db: mongo.db, clock, hub, queues, accounts, config }));
  const payments = createPaymentsModule({ db: mongo.db, mongo: mongo.client, clock, config, queues, accounts, notifications, organizations });
  const messaging = createMessagingModule({ db: mongo.db, clock, hub, limiter, audit, notifications });
  const ticketing = createTicketingModule({ db: mongo.db, mongo: mongo.client, clock, tokens, accounts, organizations, payments, hub, limiter, audit, notifications });
  const caravans = createCaravansModule({ db: mongo.db, mongo: mongo.client, clock, accounts, organizations, payments, ticketing, hub, limiter, audit, notifications });
  const taxi = createTaxiModule({ db: mongo.db, mongo: mongo.client, clock, config, accounts, payments, messaging, limiter, notifications });
  const media = (late.media = createMediaModule({ db: mongo.db, clock, config, limiter }));
  const events = createEventsModule({ db: mongo.db, mongo: mongo.client, clock, accounts, organizations, payments, ticketing, media, limiter, audit, notifications });
  const banners = createBannersModule({ db: mongo.db, mongo: mongo.client, clock, payments, media, events, organizations, limiter, audit, notifications });
  const alerts = createAlertsModule({ db: mongo.db, clock, audit, notifications, accounts, media });
  const publicRestos = createPublicRestosModule({ db: mongo.db, clock, audit, alerts, notifications });
  const commerce = createCommerceModule({ db: mongo.db, mongo: mongo.client, clock, accounts, organizations, payments, media, notifications, limiter, audit });
  const places = createPlacesModule({ db: mongo.db, clock, media, audit });
  const ratings = createRatingsModule({
    db: mongo.db, clock, notifications,
    targets: { setOrgRating: (o, a, n) => organizations.setRating(o, a, n), setBusinessRating: (b, a, n) => commerce.service.setRating(b, a, n) },
  });
  const lost = createLostModule({
    db: mongo.db, mongo: mongo.client, clock, accounts, messaging, notifications, alerts, media, limiter, audit, reader: opts.cardReader ?? new TesseractCardReader(config.OCR_CACHE_DIR),
  });
  const housing = createHousingModule({ db: mongo.db, mongo: mongo.client, clock, accounts, messaging, notifications, limiter, audit });
  // Where pictures are kept: one that none of these reference any more is deleted from the storage.
  media.trackUsage([...ACCOUNTS_MEDIA_USAGE, ...ORGANIZATIONS_MEDIA_USAGE, ...COMMERCE_MEDIA_USAGE, ...BANNERS_MEDIA_USAGE, ...EVENTS_MEDIA_USAGE, ...PLACES_MEDIA_USAGE, ...LOST_MEDIA_USAGE, ...ALERTS_MEDIA_USAGE]);

  return {
    config,
    clock,
    mongo,
    redis,
    queues,
    tokens,
    denylist,
    hub,
    modules: { audit, accounts, organizations, identity, payments, messaging, taxi, ticketing, caravans, notifications, alerts, publicRestos, media, events, banners, lost, housing, commerce, places, ratings },
    async close() {
      await lost.close();
      await hub.close();
      await queues.close();
      redis.disconnect();
      await mongo.client.close();
    },
  };
}
