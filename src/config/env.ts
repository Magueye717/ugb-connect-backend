import { Type } from 'typebox';
import { Value } from 'typebox/value';

const Bool = Type.Union([Type.Boolean(), Type.Literal('true'), Type.Literal('false')], { default: false });

const EnvSchema = Type.Object({
  NODE_ENV: Type.Union([Type.Literal('development'), Type.Literal('test'), Type.Literal('production')], { default: 'development' }),
  /**
   * A test deployment built like production (NODE_ENV=production, real secrets, bucket, push) that may still use test
   * OTP codes, logged SMS and simulated payments, until the Orange and Wave accounts are live. Never on the students' server.
   */
  STAGING: Bool,
  HOST: Type.String({ default: '0.0.0.0' }),
  PORT: Type.Number({ default: 3000 }),
  LOG_LEVEL: Type.String({ default: 'info' }),
  // "Aide & support" in the app: who students call, message or write to.
  SUPPORT_PHONE: Type.String({ default: '777902880' }),
  SUPPORT_EMAIL: Type.String({ default: 'magueye.gueye.dev@gmail.com' }),
  /**
   * The first administrator, created by the deploy's migrate step when no account uses this phone (never changed
   * afterwards: an existing account keeps its password and roles). Both empty: nothing is created.
   */
  BOOTSTRAP_ADMIN_PHONE: Type.Optional(Type.String()),
  BOOTSTRAP_ADMIN_PASSWORD: Type.Optional(Type.String({ minLength: 8 })),
  BOOTSTRAP_ADMIN_FIRST_NAME: Type.String({ default: 'Admin' }),
  BOOTSTRAP_ADMIN_LAST_NAME: Type.String({ default: 'Campus' }),
  /**
   * The store reviewers' student account (« Student Test »), created by the deploy's migrate step when no account uses
   * this phone (never changed afterwards). REVIEW_STUDENT_PHONE empty: nothing is created.
   */
  REVIEW_STUDENT_PHONE: Type.String({ default: '770000000' }),
  REVIEW_STUDENT_PASSWORD: Type.String({ minLength: 8, default: 'Campus2026' }),
  /**
   * The rentrée, every year ("MM-DD", Dakar): once given, the student's UFR, region and card details stay as they are
   * until the next one (a filled field can't be changed in between; an empty one can always be filled).
   */
  ACADEMIC_YEAR_START: Type.String({ pattern: '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$', default: '10-01' }),
  /** Behind a reverse proxy: trust X-Forwarded-For so rate limits see the real client IP. */
  TRUST_PROXY: Bool,
  /**
   * Browser origins allowed to call the API (comma-separated). The mobile app doesn't need CORS; this is for the
   * Expo web build in development and a future admin web app. Empty = CORS closed.
   */
  CORS_ORIGINS: Type.String({ default: '' }),
  /** Swagger UI on /docs: the temporary back office (decision Q-12). */
  DOCS_ENABLED: Bool,

  MONGODB_URI: Type.String({ default: 'mongodb://localhost:27018/?replicaSet=rs0' }),
  // Kept from the first name (UGB Campus): the existing databases are called so.
  MONGODB_DB: Type.String({ default: 'ugb_campus' }),
  REDIS_URL: Type.String({ default: 'redis://localhost:6379' }),
  /** Namespaces Redis keys and BullMQ queues (tests use one per file). */
  REDIS_PREFIX: Type.String({ default: 'ugb' }),

  /** Ed25519 keys, PEM (PKCS#8 / SPKI), base64-encoded so they fit on one line. `npm run keys` generates them. */
  JWT_PRIVATE_KEY_B64: Type.Optional(Type.String()),
  JWT_PUBLIC_KEY_B64: Type.Optional(Type.String()),
  JWT_KID: Type.String({ default: 'dev-1' }),
  ACCESS_TOKEN_TTL_S: Type.Number({ default: 900 }),
  REFRESH_TOKEN_TTL_DAYS: Type.Number({ default: 30 }),
  REFRESH_TOKEN_ABSOLUTE_DAYS: Type.Number({ default: 90 }),

  /** Multiplies every rate limit. Tests raise it (one IP for everything); production must keep 1. */
  RATE_LIMIT_SCALE: Type.Number({ default: 1, minimum: 1 }),

  /** HMAC pepper for OTP codes. */
  OTP_PEPPER: Type.Optional(Type.String({ minLength: 32 })),
  OTP_LENGTH: Type.Number({ default: 4, minimum: 4, maximum: 8 }),
  /** Development only: fixed code (1234…), logged instead of sent. Refused in production. */
  OTP_DEV_MODE: Bool,
  /** `console` logs SMS (development); `twilio` sends them. Orange's SMS API comes once the account is approved. */
  SMS_PROVIDER: Type.Union([Type.Literal('console'), Type.Literal('twilio')], { default: 'console' }),
  /** Twilio: the account (AC…), then an API key (SK… + secret) or the auth token. */
  TWILIO_ACCOUNT_SID: Type.Optional(Type.String({ pattern: '^AC[0-9a-fA-F]{32}$' })),
  TWILIO_API_KEY_SID: Type.Optional(Type.String({ pattern: '^SK[0-9a-fA-F]{32}$' })),
  TWILIO_API_KEY_SECRET: Type.Optional(Type.String({ minLength: 16 })),
  TWILIO_AUTH_TOKEN: Type.Optional(Type.String({ minLength: 16 })),
  /** Sender: a Twilio number (+1…) or an approved sender name (≤ 11 letters/digits), or a Messaging Service (MG…). */
  TWILIO_FROM: Type.Optional(Type.String({ pattern: '^(\\+[1-9][0-9]{6,14}|[A-Za-z0-9 ]{1,11})$' })),
  TWILIO_MESSAGING_SERVICE_SID: Type.Optional(Type.String({ pattern: '^MG[0-9a-fA-F]{32}$' })),

  /**
   * Development only: Wave and Orange Money are simulated (checkout page + signed webhooks through the real code
   * path). Refused in production. Real adapters arrive with the merchant accounts (Q-1).
   */
  PAYMENTS_SIMULATOR: Bool,
  /**
   * Sunu Taxi seats paid in the app (Wave / Orange Money, refunds, the organizer's payout). Off: a seat is a
   * reservation, the fare is settled in the taxi. Each trip keeps the rule it was created with.
   */
  TAXI_ONLINE_PAYMENT: Bool,
  /** HMAC secret of the simulated provider's webhooks. */
  SIMULATOR_WEBHOOK_SECRET: Type.Optional(Type.String({ minLength: 32 })),
  /**
   * Public base URL of the API (e.g. https://api.ugb-connect.sn), used in checkout links. Without it, the host the
   * app called is used, which is what a phone on the same Wi-Fi needs in development.
   */
  PUBLIC_API_URL: Type.Optional(Type.String({ pattern: '^https?://[^/]+$' })),

  /**
   * Push notifications: `expo` sends through Expo's push service (phones register their Expo push token);
   * `log` only writes them to the worker log (tests, machines without internet).
   */
  PUSH_PROVIDER: Type.Union([Type.Literal('expo'), Type.Literal('log')], { default: 'log' }),
  /** Optional: Expo access token, if "enhanced push security" is on for the project. */
  EXPO_ACCESS_TOKEN: Type.Optional(Type.String()),

  /**
   * Uploaded images (banners, events): `local` writes them under MEDIA_DIR and serves them from /media
   * (development); `s3` puts them in an S3-compatible bucket (AWS S3, Cloudflare R2). Production requires `s3`.
   */
  MEDIA_STORAGE: Type.Union([Type.Literal('local'), Type.Literal('s3')], { default: 'local' }),
  MEDIA_DIR: Type.String({ default: './var/media' }),
  /** Lost student cards are read by OCR (Tesseract): its French language data is downloaded once into this folder. */
  OCR_CACHE_DIR: Type.String({ default: './var/ocr' }),
  /** Public base URL of the stored files (CDN or bucket domain), e.g. https://media.ugb-connect.sn. Local: the API's /media. */
  MEDIA_PUBLIC_URL: Type.Optional(Type.String({ pattern: '^https?://' })),
  S3_BUCKET: Type.Optional(Type.String()),
  S3_REGION: Type.String({ default: 'auto' }),
  /** R2 or another S3-compatible service; empty for AWS. */
  S3_ENDPOINT: Type.Optional(Type.String({ pattern: '^https?://' })),
  S3_ACCESS_KEY_ID: Type.Optional(Type.String()),
  S3_SECRET_ACCESS_KEY: Type.Optional(Type.String()),
});

type RawEnv = Type.Static<typeof EnvSchema>;

export type Config = Omit<RawEnv, 'STAGING' | 'TRUST_PROXY' | 'DOCS_ENABLED' | 'OTP_DEV_MODE' | 'PAYMENTS_SIMULATOR' | 'TAXI_ONLINE_PAYMENT' | 'SIMULATOR_WEBHOOK_SECRET' | 'JWT_PRIVATE_KEY_B64' | 'JWT_PUBLIC_KEY_B64' | 'OTP_PEPPER'> & {
  STAGING: boolean;
  TRUST_PROXY: boolean;
  DOCS_ENABLED: boolean;
  OTP_DEV_MODE: boolean;
  PAYMENTS_SIMULATOR: boolean;
  TAXI_ONLINE_PAYMENT: boolean;
  SIMULATOR_WEBHOOK_SECRET: string;
  jwt: { privateKeyPem?: string; publicKeyPem?: string };
  OTP_PEPPER: string;
  isProduction: boolean;
};

const toBool = (v: boolean | string) => v === true || v === 'true';
const decode = (b64?: string) => (b64 ? Buffer.from(b64, 'base64').toString('utf8') : undefined);

const DEV_PEPPER = 'dev-only-otp-pepper-change-me-0123456789';
const DEV_SIMULATOR_SECRET = 'dev-only-payment-simulator-secret-0123456789';

/** Reads and validates the environment once. Throws on anything invalid or unsafe for production. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const input = Object.fromEntries(Object.entries(env).filter(([k, v]) => k in EnvSchema.properties && v !== '' && v !== undefined));
  const candidate = Value.Default(EnvSchema, Value.Convert(EnvSchema, input));
  if (!Value.Check(EnvSchema, candidate)) {
    // Field names and rules only: values may be secrets (keys, pepper) and must never reach the logs.
    const problems = Value.Errors(EnvSchema, candidate).map((e) => `${e.instancePath.slice(1) || '(root)'} ${e.message}`);
    throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  }
  const raw = candidate;
  const isProduction = raw.NODE_ENV === 'production';
  const config: Config = {
    ...raw,
    STAGING: toBool(raw.STAGING),
    TRUST_PROXY: toBool(raw.TRUST_PROXY),
    DOCS_ENABLED: toBool(raw.DOCS_ENABLED),
    OTP_DEV_MODE: toBool(raw.OTP_DEV_MODE),
    PAYMENTS_SIMULATOR: toBool(raw.PAYMENTS_SIMULATOR),
    TAXI_ONLINE_PAYMENT: toBool(raw.TAXI_ONLINE_PAYMENT),
    SIMULATOR_WEBHOOK_SECRET: raw.SIMULATOR_WEBHOOK_SECRET ?? DEV_SIMULATOR_SECRET,
    jwt: { privateKeyPem: decode(raw.JWT_PRIVATE_KEY_B64), publicKeyPem: decode(raw.JWT_PUBLIC_KEY_B64) },
    OTP_PEPPER: raw.OTP_PEPPER ?? DEV_PEPPER,
    isProduction,
    ...overrides,
  };
  assertSmsSettings(config);
  assertMediaSettings(config);
  assertProductionSafety(config);
  return config;
}

/** A provider named without its settings would only fail at the first SMS: refuse to boot instead (names only, no values). */
function assertSmsSettings(c: Config) {
  if (c.SMS_PROVIDER !== 'twilio') return;
  const missing: string[] = [];
  if (!c.TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
  if (c.TWILIO_API_KEY_SID ? !c.TWILIO_API_KEY_SECRET : !c.TWILIO_AUTH_TOKEN) missing.push(c.TWILIO_API_KEY_SID ? 'TWILIO_API_KEY_SECRET' : 'TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET (or TWILIO_AUTH_TOKEN)');
  if (!c.TWILIO_FROM && !c.TWILIO_MESSAGING_SERVICE_SID) missing.push('TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID)');
  if (missing.length) throw new Error(`Invalid configuration: SMS_PROVIDER=twilio needs ${missing.join(', ')}`);
}

/** S3 storage without its keys would boot, then fail every upload with a 500: refuse to boot instead (names only). */
function assertMediaSettings(c: Config) {
  if (c.MEDIA_STORAGE !== 's3') return;
  const missing = (['S3_BUCKET', 'MEDIA_PUBLIC_URL', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const).filter((k) => !c[k]);
  if (missing.length) throw new Error(`Invalid configuration: MEDIA_STORAGE=s3 needs ${missing.join(', ')} (or MEDIA_STORAGE=local)`);
}

/** Development conveniences must never reach production: refuse to boot instead. */
function assertProductionSafety(c: Config) {
  if (!c.isProduction) return;
  const problems: string[] = [];
  // Staging only: test codes, logged SMS and the payment simulator; every other rule stays.
  if (c.OTP_DEV_MODE && !c.STAGING) problems.push('OTP_DEV_MODE must be false');
  if (c.MEDIA_STORAGE !== 's3') problems.push('MEDIA_STORAGE must be s3');
  if (c.MEDIA_STORAGE === 's3' && (!c.S3_BUCKET || !c.MEDIA_PUBLIC_URL || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY)) problems.push('S3_BUCKET, MEDIA_PUBLIC_URL and S3 keys must be set');
  if (c.OTP_PEPPER === DEV_PEPPER) problems.push('OTP_PEPPER must be set');
  if (!c.jwt.privateKeyPem || !c.jwt.publicKeyPem) problems.push('JWT keys must be set');
  if (c.SMS_PROVIDER === 'console' && !c.STAGING) problems.push('a real SMS_PROVIDER is required');
  if (c.RATE_LIMIT_SCALE !== 1) problems.push('RATE_LIMIT_SCALE must be 1');
  if (c.PAYMENTS_SIMULATOR && !c.STAGING) problems.push('PAYMENTS_SIMULATOR must be false');
  if (c.PUSH_PROVIDER === 'log') problems.push('PUSH_PROVIDER must be expo');
  if (problems.length) throw new Error(`Unsafe production configuration: ${problems.join('; ')}`);
}
