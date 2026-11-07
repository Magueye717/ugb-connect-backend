# 02 — Architecture, modules, folder structure, infrastructure

## 1. Shape of the system

One deployable backend application, run in two **process roles** from the same image and codebase:

```
                 ┌──────────────── Expo app (iOS / Android) ────────────────┐
                 │  REST /api/v1 (HTTPS)        WebSocket /ws (WSS)        │
                 └───────────────┬───────────────────────┬─────────────────┘
                                 │                       │
                         ┌───────▼───────────────────────▼───────┐
                         │      Load balancer / reverse proxy     │
                         └───────┬───────────────────────┬───────┘
                       ┌─────────▼────────┐    ┌─────────▼────────┐
                       │  api  (Fastify)  │ …  │  api  (Fastify)  │   stateless, N replicas
                       └───┬───────┬──────┘    └───┬───────┬──────┘
                           │       │  enqueue / pub-sub    │
             ┌─────────────▼─┐   ┌─▼───────────────────────▼─┐   ┌──────────────────┐
             │ MongoDB (RS)  │◄──┤          Redis            ├──►│ worker (BullMQ)  │ N replicas
             │ primary store │   │ rate limit · queues ·     │   │ same codebase    │
             └───────▲───────┘   │ pub/sub · short cache     │   └───┬──────────────┘
                     │           └───────────────────────────┘       │
                     └───────────────────────────────────────────────┘
                     Object storage (S3-compatible) · Wave / Orange Money · SMS · Expo Push
```

- `api` serves HTTP and WebSocket traffic only. Anything slow or external (SMS, push, provider calls, image processing) is handed to a queue.
- `worker` runs the BullMQ processors and the repeatable sweepers.
- This is still **one modular monolith**: one repository, one build, one artifact. The `main.ts` entry point takes `api` or `worker` as an argument. Splitting the roles exists so a burst of push notifications cannot slow down seat bookings. It is not a split into services.

## 2. Technology choices (each one justified)

| Choice | Why | Rejected alternative |
|---|---|---|
| **Node 22 LTS + TypeScript (strict)** | Mandated by the spec; one language shared with the frontend. Node 22 is the version installed locally (see 09). | — |
| **Fastify 5** | Mandated. Native JSON-schema validation and serialization, hooks, plugins, `inject()` for tests. | — |
| **TypeBox** schemas | They are JSON Schema, which Fastify validates and serializes natively and which feeds **OpenAPI** generation. The same schema yields the TS type. `additionalProperties: false` everywhere blocks `$`-operator injection. | Zod would need adapters and runs slower in Fastify. |
| **Official `mongodb` driver** (no Mongoose) | We need exact control over atomic conditional updates, transactions, partial unique indexes and `$jsonSchema` validators. Mongoose's middleware and change-tracking get in the way of those. Repositories give us typed access. | Mongoose |
| **MongoDB replica set** (single node in dev, 3 nodes in prod) | **Transactions require a replica set.** We need them for booking confirmation, cancellation and transfer (see `03-database.md` §5). | Standalone `mongod` (no transactions) |
| **Redis** | Required by three cross-instance features: distributed **rate limiting** (`@fastify/rate-limit` Redis store), the **BullMQ** backend, and **pub/sub** for WebSocket fan-out. Also a short-lived cache (home, menus, departure list) and the session-revocation cache. Without Redis, these would rely on per-instance memory, which the spec forbids. | — |
| **BullMQ** | Durable jobs with retries, exponential backoff, delayed jobs (hold expiry, `confirmBy`, reminders), repeatable sweepers, deterministic job IDs (dedupe) and a failed-job set for monitoring. | Agenda (Mongo-based, weaker semantics), cron inside API pods |
| **WebSocket** (`@fastify/websocket`, raw `ws`) | Taxi chat, lost-item chat, live order status, live boarding counts across an organizer's phones. React Native has `WebSocket` built in, so no client library is needed. | Socket.IO: heavier client and protocol, and we only need a small subset. SSE is one-way only. |
| **Expo Push Service** | The app already uses `expo-notifications` and Expo push tokens. Expo wraps FCM and APNs, so there is no Firebase SDK to integrate on the client. | Direct FCM/APNs: it would need native config changes and an extra client SDK. Stays possible later behind the same adapter. |
| **S3-compatible object storage** (MinIO in dev) | Lost-item, place and restaurant photos. Keeps API pods stateless. | Local disk (not stateless), GridFS (bloats the primary DB) |
| **`sharp`** | Re-encodes uploaded images (to WebP), **strips EXIF/GPS** and caps dimensions. | — |
| **`argon2`** | Argon2id password hashing. | bcrypt |
| **`jose`** | EdDSA JWTs for access tokens. The Node `crypto` module handles Ed25519 signing of ticket QR codes. | — |
| **pino** (Fastify default) | Structured JSON logs, with redaction. | — |
| **prom-client** | Prometheus `/metrics`: HTTP, Mongo pool, queue depth. | — |
| **Sentry** (optional, DSN-gated) | Error tracking. | — |
| **Vitest + mongodb-memory-server (replica set) + Redis via Docker** | Fast unit tests. Integration tests run against real transactions. | Jest |

What we deliberately do **not** add: Kafka, an event-sourcing framework, GraphQL, a DI container, an ORM, Kubernetes manifests (only Docker), or Elasticsearch (MongoDB text search is enough at this size).

## 3. Modules

Each module owns its collections. Other modules call it only through its **public facade** (`modules/<name>/index.ts`). The facades are wired by hand in a composition root (`src/container.ts`), without a framework.

| Module | Responsibility | Owns collections |
|---|---|---|
| `identity` | OTP challenges, password hashing, login / lockout, sessions, refresh rotation, password reset | `otpChallenges`, `sessions` |
| `accounts` | Users, student profiles, platform roles, notification preferences, user blocks, student registry lookup | `users`, `studentProfiles`, `studentRegistry`, `userBlocks` |
| `organizations` | Organizations (caravan operators, restaurants), verification level, memberships and roles | `organizations`, `memberships` |
| `content` | Headlines, campus alerts, ads (scheduling, audience, expiry) | `announcements` |
| `places` | Campus locations | `places` |
| `food` | Resto U menus and stock status; private restaurants, menu items; order lifecycle | `restaurants`, `menuItems`, `universityMenus`, `orders` |
| `payments` | Payment intents, provider adapters (Wave, Orange Money, **Simulated**), webhook inbox, reconciliation, refunds, payouts ledger | `payments`, `paymentEvents`, `refunds`, `payouts` |
| `caravans` | Vehicles, departures, seat holds / bookings, tickets, QR signing, transfers, cancellation, boarding, manifests | `vehicles`, `departures`, `bookings`, `tickets`, `ticketTransfers`, `boardingEvents` |
| `taxi` | Taxi trips, participants, seat allocation, lock, strikes, hand-over, check-in, departure | `taxiTrips`, `taxiParticipants`, `taxiStrikes` |
| `lostfound` | Items, card scans, claims, moderation reports | `lostItems`, `lostClaims`, `cardScans`, `lostReports` |
| `messaging` | Conversations, messages, read markers, real-time delivery. **Access decided by the owning module** through a policy interface. | `conversations`, `messages`, `conversationReads` |
| `notifications` | Inbox, device tokens, push delivery and receipts, broadcasts | `notifications`, `deviceTokens`, `pushDeliveries`, `broadcasts` |
| `media` | Upload validation, processing, storage, signed URLs | `media` |
| `academics` | Academic groups, timetable entries, schedule changes (→ notifications), CSV import | `academicGroups`, `timetableEntries` |
| `scholarships` | Published payment schedule (global, not per student) | `scholarshipSchedules` |
| `audit` | Append-only audit log of sensitive actions | `auditLogs` |

Changes compared with the spec's module list, and why:

- **Users / students / roles** are split into `identity` (credentials and sessions) and `accounts` (who you are). **Organizers** get their own `organizations` module, because organizations own departures and restaurants and have staff.
- **Conversations / messages** form one shared `messaging` module. Taxi chats and lost-item chats share storage, real-time delivery, unread counts and blocking, but differ in *who* may read or write. Each owning module registers that rule as a policy, so `messaging` never imports `taxi` or `lostfound`.
- **Cart** gets **no server module.** The cart is single-device and ephemeral (`CartContext`). The server prices and validates everything at `POST /orders/quote` and `POST /orders`, so a server cart would add writes without adding safety. *Trade-off: no cross-device cart. Easy to add later.*
- **Resto U entitlements / ticket consumption are not built.** The frontend shows that Resto U is paid at the counter with paper tickets and the student card. The app only displays menus and stock. See question Q-11 in `08-risks-and-questions.md`.

### 3.1 Allowed dependencies (acyclic)

```
identity ──► accounts
organizations ──► accounts
content ──► media            places ──► media
food ──► organizations, payments, notifications, media
caravans ──► organizations, accounts, payments, notifications
taxi ──► accounts, payments, messaging, notifications
lostfound ──► accounts, messaging, notifications, media
academics ──► accounts, notifications
messaging ──► accounts            notifications ──► accounts
payments ──► (nothing)            scholarships, media, audit ──► (nothing)
every module ──► audit (write only), platform/*
```

Two inversions keep the graph acyclic:

1. **Payment purpose handlers.** `payments` defines this interface:

   ```ts
   interface PaymentPurposeHandler {
     onSucceeded(p): Promise<'fulfilled' | 'unfulfillable'>;
     onFailed(p): Promise<void>;
   }
   ```

   `food`, `caravans` and `taxi` register handlers for `food_order`, `caravan_booking` and `taxi_seat`. `payments` never imports them.
2. **Conversation access policies.** `messaging` defines `ConversationPolicy { canRead(userId, conv), canWrite(userId, conv) }`. `taxi` and `lostfound` register implementations.

Boundaries are enforced in CI with **dependency-cruiser** rules: no imports into `modules/*/` except through `modules/*/index.ts`, and no cycles.

### 3.2 Layers inside a module

```
routes.ts      → URL + schema + guards → calls controller (no logic)
controller.ts  → maps HTTP ↔ DTO, extracts the actor, calls service
service.ts     → business rules, transactions, authorization on resources, emits events
repository.ts  → the only code that touches the collections; returns domain types, never raw documents
schemas.ts     → TypeBox request/response schemas (= DTOs, = OpenAPI)
types.ts       → domain types
jobs.ts        → BullMQ processors this module owns
policies.ts    → resource-level authorization helpers
index.ts       → public facade (the only export other modules may use)
__tests__/     → unit + integration tests
```

## 4. Folder structure

```
ugb-connect-backend/
├── src/
│   ├── main.ts                 # `node dist/main.js api|worker`
│   ├── app.ts                  # buildApp(): Fastify instance + plugins + module routes
│   ├── worker.ts               # registers module job processors + sweepers
│   ├── container.ts            # composition root: builds repositories, services, facades
│   ├── config/                 # env schema (TypeBox), loaded once, fails fast; prod safety checks
│   ├── platform/               # shared infrastructure, no business rules
│   │   ├── db/                 # Mongo client, withTransaction(), collection bootstrap
│   │   ├── redis/              # ioredis clients (cmd, sub, bullmq)
│   │   ├── queue/              # queue factory, job naming, default retry policies
│   │   ├── http/               # error handler (problem+json), pagination, idempotency, request-id
│   │   ├── auth/               # access-token verification plugin, guards (requireAuth, requireOrgRole…)
│   │   ├── security/           # argon2, HMAC, AES-GCM field encryption, Ed25519 signer, key ring
│   │   ├── realtime/           # WebSocket gateway, topic auth registry, Redis pub/sub bridge
│   │   ├── storage/            # S3 client, signed URLs
│   │   ├── events/             # in-process typed event bus (sync side effects within a request)
│   │   ├── clock/              # Clock interface (server time; fakeable in tests)
│   │   ├── observability/      # logger config, metrics, health checks, Sentry
│   │   └── sms/ push/          # outbound adapters (SMS provider, Expo push)
│   ├── modules/
│   │   ├── identity/ accounts/ organizations/ content/ places/ food/
│   │   ├── payments/
│   │   │   └── providers/ { wave/, orange-money/, simulated/ }
│   │   ├── caravans/ taxi/ lostfound/ messaging/ notifications/
│   │   └── media/ academics/ scholarships/ audit/
│   └── types/                  # global ambient types only
├── migrations/                 # versioned: collection validators + indexes (run on deploy)
├── scripts/
│   ├── seed/                   # dev seed (refuses NODE_ENV=production), mirrors constants/data.ts
│   └── keys/                   # generate Ed25519 keys for JWT + QR
├── test/                       # integration harness (replica set, Redis, app factory, fixtures)
├── docker/                     # mongo replica-set init, MinIO bucket init
├── docs/                       # this documentation + ADRs
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json  tsconfig.json  vitest.config.ts  eslint.config.js  .dependency-cruiser.cjs
```

## 5. Cross-cutting conventions

- **Time:** every timestamp is stored as a UTC `Date`. Business clock = `Africa/Dakar`, which is UTC+0 with no daylight saving time. We still compute it explicitly with `Intl`/Temporal, so a future change cannot break things silently. Every service reads time from the injected `Clock`, never `Date.now()`, so the 24 h / 30 min / 2 h rules are testable.
- **Money:** integers in **XOF**, which has no minor unit. The `currency: 'XOF'` field is stored anyway.
- **IDs:** MongoDB ObjectIds are exposed as strings. Human-facing codes are generated separately: ticket codes, order codes and payment references. Authorization never depends on an ID being unguessable.
- **Errors:** RFC 9457 `application/problem+json` with a stable machine `code` (e.g. `SEAT_TAKEN`), a French `message` ready to display, and the `requestId`. Never a stack trace.
- **Idempotency:** the `Idempotency-Key` header is **required** on order creation, booking, join-taxi, cancel-ticket and transfer. Keys are stored in `idempotencyKeys` (24 h TTL, keyed by user + route + key + request hash) and the first response is replayed.
- **Pagination:** cursor-based (an opaque cursor over `sortKey,_id`). `limit` defaults to 20, maximum 100.
- **Events:** an in-process event bus handles synchronous side effects inside a request (e.g. "ticket confirmed" → create notification). Durable work always goes through the DB and the queue, following the rule "**DB is the source of truth, the queue is a hint**": every queued action has a sweeper that re-enqueues anything left pending.

## 6. Scalability strategy

**Workload assumptions** (to be confirmed with real usage):

- 15 k students, about 40 % daily active (6 k).
- Peaks:
  - Lunch (menus): a few thousand app opens in 30 min, about 5–20 req/s on average and **≤ 100 req/s** in bursts.
  - Caravan sales opening before holidays: a few hundred students hitting the same departures. Seat holds could reach **50–100 writes/s** for a few minutes, contended on 64 seats.
  - Announcement broadcast: 15 k pushes, which batch to 150 Expo requests (100 tokens each).

**Conclusions:**

- One Fastify instance handles this comfortably. We run **2 API replicas for availability**, not for load, plus 1–2 workers.
- MongoDB: a 3-node replica set, small instance class. The working set is tiny (< 5 GB the first year).
- The hot spots are **correctness under contention** (seats, stock, payments), not throughput. They are solved with unique indexes and conditional updates, not with locks or bigger machines.
- **Caching** (Redis, short TTL): `GET /home` 30 s, menus 15 s, departure list 5 s, places 5 min. **Never** cached: seat maps beyond 1–2 s, payments, tickets.
- Connection pools: Mongo `maxPoolSize` 20 per API pod; Redis uses separate connections for commands, subscriptions and BullMQ.
- **Graceful degradation:**
  - If Redis is down: rate limiting fails *closed* for auth endpoints and open for reads; queues buffer in the DB thanks to the sweepers.
  - If push fails: notifications stay in the inbox.
  - If a payment provider is down: checkout returns `PAYMENT_PROVIDER_UNAVAILABLE` and holds expire normally.

## 7. Docker and deployment

- **Dockerfile** (multi-stage):
  1. `deps` runs `npm ci`.
  2. `build` runs `tsc` and prunes dev dependencies.
  3. `runtime` uses `node:24-alpine` with `tini`, `USER node` (non-root) and a read-only filesystem. It copies only `dist/`, production `node_modules` and `package.json`. `HEALTHCHECK` calls `/health/live`.
- **docker-compose.yml** (development):
  - `mongo` (single-node replica set `rs0`, init script, named volume)
  - `redis` (AOF volume)
  - `minio`, plus a one-shot job that creates the bucket
  - `api` (watch mode)
  - `worker`
- **Using the existing `localhost:27017`** (your requirement): the compose `mongo` service sits behind a profile, so it can be skipped. `MONGODB_URI=mongodb://localhost:27017/ugb_connect?replicaSet=rs0`, or `host.docker.internal` from inside containers. **The local `mongod` must run as a replica set** (`mongod --replSet rs0`, then `rs.initiate()` once). Otherwise transactions fail. See Q-18.
- **Health checks:**
  - `/health/live`: the process is up.
  - `/health/ready`: Mongo ping, Redis ping, migrations applied. The load balancer only routes to ready pods.
- **Graceful shutdown:** on `SIGTERM`:
  1. Stop accepting connections and fail readiness.
  2. Drain in-flight HTTP requests (with a 10 s timeout) and close WebSockets with code 1012 (clients reconnect).
  3. Workers call `worker.close()`, which finishes the current job.
  4. Close Mongo and Redis.
- **Config:** 12-factor environment variables, validated at boot. Secrets come from Docker/K8s secrets or the provider's secret manager, never from the image. At boot in production, the app **refuses to start** if any of these hold: the simulated payment provider is enabled, the dev OTP is enabled, seeding is enabled, or a default key is in use.
- **Logs:** JSON on stdout, collected by the host. Fields: `requestId` and `correlationId` (propagated into jobs), `userId` when known, `module`. Redacted: `authorization`, `password`, `code`, `refreshToken`, `secret`, `proof`, `cardNumber`, `phone` (masked).
