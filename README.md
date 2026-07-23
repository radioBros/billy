# Billy

**Self-hostable, open-source, multi-account invoicing & business-management app.**
One stack serves many separate companies — a global **sysadmin** creates accounts,
each with fully isolated data, and switches between them from the top bar. Clients,
quotes, invoices (+ payments), credit notes, proforma, recurring billing (incl.
**"every Nth of the month"** day-of-month schedules), time
tracking, expenses, contracts, subscriptions, optional **projects** to group any
document, and a period-driven analytics dashboard —
with a global **year selector** in the top bar and a per-page **month bar**
(per-month document count + € total, click or **click-drag** to select a run of
months) that re-scopes every list, KPI card and chart at once,
PDF documents (server-rendered, previewable + printable), transactional email
(send / resend / reminder with the document attached), in-app + real-time
notifications, **web push + installable PWA**, users & roles with **TOTP two-factor
auth**, a rich WYSIWYG for document/email headers & footers, **seven languages**
across UI, documents and email — **each client receives their invoices & emails in
their own language** (per-language notes/header/footer, recipient-resolved),
and a full white-label settings panel. All of it runs on your own hardware,
configured from a single `.env`, with a **bind-mount / updatable-without-rebuild**
Docker deployment.

- **Tech:** Vue 3 + Vuetify 3 (SPA/PWA) · Koa 2 REST + WebSocket · BullMQ worker ·
  MongoDB · Redis · MinIO · Traefik + nginx.
- **License:** [AGPL-3.0-or-later](./LICENSE)
- **Deploy:** one Docker Compose project named `billy`.

---

## Architecture at a glance

| Layer | What | Where |
| :--- | :--- | :--- |
| **Frontend** | Vue 3 + Vuetify 3 SPA/PWA. Runtime-configured (`config.js`), i18n, offline shell, notification bell over WebSocket. | `apps/web` → built to `apps/web/dist`, served by nginx |
| **API** | Koa 2 REST + WebSocket + `/health/*` + `/metrics`. Argon2 auth, MongoDB, Redis, MinIO. | `apps/api` → bundled to `apps/api/dist/index.js` |
| **Worker** | BullMQ consumers: email, **PDF (Playwright/Chromium)**, notifications, backup, cleanup, recurring. | `apps/worker` → bundled to `apps/worker/dist/index.js` |
| **Data** | MongoDB (primary), Redis (sessions/queues), MinIO (files/PDFs). | `./data/*` (bind-mounted host dirs) |
| **Edge** | Traefik reverse proxy (TLS, routing). nginx serves the static SPA. | `proxy` + `web` services |

### The deployment model (important)

Billy is built for the **operator, not a CI registry**. The governing rule:

> **Docker images are thin runtimes with _no application code_. The app
> artifacts, every config file, and all datastore data live on the host and are
> bind-mounted in — so they update without rebuilding any image.**

- You build the apps **locally** (`pnpm build`) into `apps/*/dist`.
- Compose bind-mounts those `dist/` folders (+ `nginx.conf`, `config.js`, `.env`,
  `./data`) into stock runtime images (`node`, `nginx`, `traefik`, `mongo`, …).
- **Update = rebuild locally → `docker compose restart <svc>`.** No `docker
  build`, no image push, no registry.
- The **one** exception that touches an image is a native runtime dependency:
  the **worker** image bakes Chromium (for PDF rendering) because a browser
  binary can't be bind-mounted. That's the only custom image.

The API/worker bundles are produced by esbuild ([`scripts/build-service.mjs`](./scripts/build-service.mjs))
as single ESM files. Everything is inlined **except** true native/binary deps:
`@node-rs/argon2` (api) and `playwright`/Chromium (worker). The api's one native
addon is supplied by a read-only bind mount of `apps/api/node_modules`.

---

## Quick start (development)

```sh
# 1. Prerequisites: Node >= 22, pnpm 11, Docker (with Compose v2).
corepack enable

# 2. Install + configure.
pnpm install
cp .env.example .env          # dev defaults boot out of the box

# 3a. Fastest inner loop — API on the host, data stores in Docker:
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d mongodb redis minio
pnpm dev:api                   # tsx watch, hot-reload on :3000
curl localhost:3000/health/live   # -> {"status":"ok"}

# 3b. Or the full dev stack (hot-reload web + api + worker + Mailpit):
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
#   web    → http://localhost:3480
#   API    → http://localhost:3480/api
#   Mailpit (captured dev email) → http://localhost:3480/mailpit  (or :3488)
```

The first admin: set `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` in
`.env` before first boot, or complete the first-run flow in the UI.

---

## Production deployment

```sh
# On the host, once per release:
pnpm install                   # provides the api's native @node-rs/argon2
pnpm build                     # → apps/{api,worker}/dist + apps/web/dist

# Configure:
cp .env.example .env                        # then edit — set EVERY secret to a strong value
cp deploy/config.js.example deploy/config.js  # then edit APP_URL/API_URL for the public origin
#   Set at minimum: SESSION_SECRET, JWT_SECRET, DATA_ENCRYPTION_KEY,
#   MINIO_ROOT_PASSWORD/MINIO_SECRET_KEY, REDIS_PASSWORD, PUBLIC_HOST, ACME_EMAIL.
#   Generate secrets with:  openssl rand -base64 32

# Bring it up (Traefik gets a Let's Encrypt cert for PUBLIC_HOST):
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
#   (--build builds ONLY the worker's Chromium image; the rest are stock images.)
```

### Updating without a rebuild

```sh
pnpm build                                   # new dist/ appears in the bind mounts
docker compose restart api worker            # api/worker pick up the new bundle
#   web is static — nginx serves the new apps/web/dist immediately (no restart).
#   Rebranding, SMTP, colors, logo → the in-app Settings (no restart).
```

### Rollback

Artifacts are versioned in git. `git checkout <ref> -- apps` → `pnpm build` →
`docker compose restart` — no image rollback.

---

## Configuration — the single `.env`

One file configures the whole stack ([`.env.example`](./.env.example) is the
canonical, commented list; keys map 1:1 to [`packages/config`](./packages/config/src/index.ts),
validated fail-fast at boot). Highlights:

| Group | Keys | Notes |
| :--- | :--- | :--- |
| **App** | `APP_ENV`, `APP_URL`, `API_URL`, `PORT`, `LOG_LEVEL` | |
| **Secrets (required in prod)** | `SESSION_SECRET`, `JWT_SECRET`, `DATA_ENCRYPTION_KEY` | `DATA_ENCRYPTION_KEY` loss = encrypted fields unrecoverable — back it up |
| **Data** | `MONGO_URI`, `REDIS_URL`, `MINIO_*` | in-cluster hostnames set by compose |
| **Email** | `SMTP_*` | unset host → dev jsonTransport; or set via the panel (encrypted) |
| **Deploy** | `PROXY_HTTP_PORT` (3480), `PROXY_HTTPS_PORT` (3481), `PUBLIC_HOST`, `ACME_EMAIL`, `REDIS_PASSWORD`, `PDF_CONCURRENCY`, `CLAMAV_ENABLED` | consumed by compose; host ports default into 3480–3490 |

**Config precedence:** DB setting (Settings) → `.env` → built-in
default. So you can drive everything from `.env` (immutable-infra style) or from
the friendly admin panel, or mix.

**Frontend config is runtime, not build-time:** `deploy/config.js` sets
`window.__APP_CONFIG__` (`APP_URL`, `API_URL`, `VAPID_PUBLIC_KEY`) and is
bind-mounted + served no-cache — repoint the SPA without rebuilding it.

---

## Bind-mount layout

```
./.env                      # single config file (git-ignored)
./deploy/nginx.conf         # web server config (editable, no rebuild)
./deploy/config.js          # runtime SPA config (editable, no rebuild)
./apps/api/dist/            # locally-built API bundle       (bind-mounted :ro)
./apps/api/node_modules/    # native @node-rs/argon2 only    (bind-mounted :ro)
./apps/worker/dist/         # locally-built worker bundle    (bind-mounted :ro)
./apps/web/dist/            # locally-built SPA              (bind-mounted :ro)
./data/mongodb  ./data/redis  ./data/minio  ./data/proxy  ./data/clamav
```

`dist/`, `data/`, and `.env` are git-ignored; `.env.example` is committed.

---

## Reference — credentials, URLs & ports

> Everything a self-hoster needs in one place. **All defaults below are for LOCAL
> DEV. Change every credential before exposing anything.** Secrets come from
> `.env` (copy `.env.example`); the values shown are that file's dev defaults.

### 🔑 Demo login credentials (created by `pnpm seed`)

Billy is **multi-account**: a global **sysadmin** manages any number of accounts
(companies), and every user + all data belongs to exactly one account. The seed
creates the sysadmin and **two** accounts so the account switcher and tenant
isolation are immediately testable.

| Role | Email | Password | What it demonstrates |
| :--- | :--- | :--- | :--- |
| **Sysadmin** (global) | `sysadmin@billy.local` | `demo-Sysadmin-123` | Manages accounts (Settings → Accounts) and switches between them via the **top-bar account switcher**. Belongs to no single account. |
| **Demo Company** — Admin | `admin@billy.local` | `demo-Admin-123` | Full access within its account — every capability, all financial totals, settings, user mgmt. Owns the rich demo dataset. |
| **Demo Company** — Member | `member@billy.local` | `demo-Member-123` | Role split: operational CRUD only. `canViewFinancialTotals=false`, so the API strips all money fields — a live demo of field-level authorization. |
| **Second Co** — Admin | `admin@second.local` | `demo-Admin2-123` | A separate account with its own isolated data (its clients/invoices never appear in Demo Company, and vice-versa). |

To test multi-account: sign in as the **sysadmin**, use the account switcher to
enter either account, or manage accounts under **Settings → Accounts** (create,
edit, and the secure multi-step delete). Signing in as an account admin shows
only that account's data.

**First install** — run `scripts/setup.sh`, which prompts for the initial
sysadmin's email + password (written to `.env` as `BOOTSTRAP_ADMIN_*`) and
generates strong secrets. On first boot the sysadmin is created automatically; on
an existing single-tenant install the tenancy migration backfills a `"default"`
account and promotes the existing admin to sysadmin. You can also complete the
first-run flow in the UI.

_(These are demo credentials in a demo DB. `pnpm seed` refuses to run when
`APP_ENV=production`. Wipe `./data` before any real deployment.)_

### 🌐 URLs (default local dev)

> **Billy uses the port range `3480–3490`** for everything it publishes to the
> host. The primary entry is **`http://localhost:3480`**.

| What | URL | Notes |
| :--- | :--- | :--- |
| **Web app (SPA)** | http://localhost:3480 | Served by nginx behind Traefik. `pnpm dev` serves it at **http://localhost:3489** instead. |
| **API** | http://localhost:3480/api | e.g. `…/api/v1/auth/login`. Behind the proxy; routed by `PathPrefix(/api)`. |
| **Public share links** | http://localhost:3480/public/… | Unauthenticated quote/invoice views (`/public/quotes/:token`). |
| **WebSocket (realtime)** | ws://localhost:3480/socket.io | Notification push; session-cookie authed. |
| **Health — liveness** | api `/health/live` | `{"status":"ok"}`. Also `/health/ready` (all deps, 503 if any down) and `/health/dependencies` (per-dep detail). Not routed publicly. |
| **Metrics (Prometheus)** | api `:3000/metrics` — **internal only** | Deliberately **not** routed through the proxy. Scrape it on the internal network. |
| **Mailpit (dev email UI)** | http://localhost:3488 or http://localhost:3480/mailpit | Captures all outbound email in dev — nothing is really sent. Dev overlay only. |
| **MinIO console (dev)** | http://localhost:3485 | Object-storage admin UI. Dev overlay only; login = MinIO root creds below. |

### 🔌 Ports (all host-published ports live in 3480–3490)

| Service | Internal (container) | Host-published | When |
| :--- | :--- | :--- | :--- |
| **proxy** (Traefik) | 80 (+443 prod) | **3480** (`PROXY_HTTP_PORT`) → 80; prod also **3481** (`PROXY_HTTPS_PORT`) → 443 | always |
| **web** (nginx) | 80 | — (via proxy only) | always (skip when using `pnpm dev`) |
| **web via `pnpm dev`** (Vite) | 3489 | **3489** | dev workflow |
| **api** (Koa) | 3000 | **3483** (dev overlay only) | always |
| **worker** | — (no listener) | — | always |
| **mongodb** | 27017 | **3487** (dev overlay only) | always |
| **redis** | 6379 | **3486** (dev overlay only) | always |
| **minio** (S3 API) | 9000 | **3484** (dev overlay only) | always |
| **minio** (console) | 9001 | **3485** (dev overlay only) | always |
| **mailpit** | 1025 (SMTP), 8025 (UI) | **3488** (UI) | **dev only** |
| **clamav** | 3310 | — | **prod only** (`CLAMAV_ENABLED`) |

Dev host bindings are all on `127.0.0.1` (localhost only), for host tooling.
In **base/prod**, data-store ports are **not** published at all — only the proxy
is reachable from outside; `api`/`worker`/`mongodb`/`redis`/`minio`/`clamav` live
on the private `internal` Docker network. **On a real public host,** set
`PROXY_HTTP_PORT=80` + `PROXY_HTTPS_PORT=443` in `.env` (Let's Encrypt needs the
standard ports), or forward 80/443 → 3480/3481 at your edge.

### 🛠️ Services — what each one does + default credentials

| Service | Image | Role | Default credentials (dev) |
| :--- | :--- | :--- | :--- |
| **proxy** | `traefik:v3.1` | Sole public entry; routes `/`→web, `/api`+`/public`+`/socket.io`→api; TLS in prod (Let's Encrypt). No dashboard exposed. | — |
| **web** | `nginx:1.27-alpine` | Serves the built Vue SPA/PWA + runtime `config.js`. No app code baked in (bind-mounts `apps/web/dist`). | — |
| **api** | `node:24-slim` (+ argon2) | REST + WebSocket + health + metrics. Runs the bundled `apps/api/dist`. **Self-provisions the MinIO bucket on boot.** | — (app users only) |
| **worker** | Playwright base (+ Chromium) | BullMQ consumers: email, **PDF render**, notifications, backup, cleanup, recurring. | — |
| **scheduler** | same as worker | Optional dedicated repeatable-job runner. Off by default; enable with `--profile scale`. | — |
| **mongodb** | `mongo:7` | Primary datastore (all business data). | no auth in dev; set creds/`MONGO_URI` for prod |
| **redis** | `redis:7` | Sessions + BullMQ queues + idempotency. | no pass in dev; **prod uses `REDIS_PASSWORD`** |
| **minio** | `minio/minio` | S3-compatible object storage (attachments, PDFs, backups). Private bucket `billy-files`. | **user** `billy-admin` / **pass** `change-me-in-env` (`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`) |
| **mailpit** | `axllent/mailpit` | Dev SMTP sink + web inbox (nothing leaves your machine). | none (open UI on localhost) |
| **clamav** | `clamav/clamav` | Upload antivirus scanning. Prod; toggle `CLAMAV_ENABLED=false` to omit. | — |

**GUIs available:** the **web app** (`:3480`), **Mailpit inbox** (`:3488`, dev),
and the **MinIO console** (`:3485`, dev — log in with the MinIO root creds).
Traefik's dashboard is intentionally off. Mongo/Redis have no GUI (use
`mongosh` / `redis-cli`, or the dev-published ports with your own tool).

### 📦 What `pnpm seed` populates

Every module gets realistic demo data (idempotent — re-run anytime; prod-gated):

- **2 users** (admin + restricted member, above)
- **3 clients**: Acme S.p.A. + Globex Srl (companies) + Jane Roe (individual)
- **Quotes** in all states: draft / sent (+ public share link) / accepted / declined
- **Invoices** in every state: draft / finalized / partially-paid / paid / **overdue**, with payments
- **1 credit note**, **1 proforma**, **1 recurring profile**, **1 subscription**
- **Time entries** (billable + non-billable), **1 expense with a receipt file**
- **1 contract with a document**, branding **logo** + SMTP config
- **Read + unread notifications** (the bell shows a badge)
- **Worker-rendered invoice PDFs** stored in MinIO
- Records are backdated so the **dashboard** looks populated

Run it against a running stack: `pnpm seed` (or `bash scripts/seed/run.sh`).

---

## Services topology (short form)

`proxy` (Traefik), `web` (nginx), `api`, `worker`, `scheduler` (opt-in
`--profile scale`), `mongodb`, `redis`, `minio`, `mailpit` (dev only), `clamav`
(prod, toggle `CLAMAV_ENABLED`). Only `proxy` is publicly exposed; datastores +
worker live on the private `internal` network. No `minio-init` — the API creates
its bucket on boot.

---

## Development

```sh
pnpm typecheck      # tsc across all workspace projects
pnpm test           # vitest across api / worker / web / validation
pnpm build          # esbuild bundles (api, worker) + vite build (web)
```

Monorepo: `apps/{api,web,worker}` + `packages/{config,shared,types,validation}`
(pnpm workspaces, ESM + TypeScript strict).

---

## Languages & translations

Billy ships **7 languages** and is localized on three layers:

1. **UI** — the app interface (vue-i18n catalogs in `apps/web/src/locales/<code>.json`).
2. **Documents & emails (structural labels)** — the fixed words on PDFs/emails
   (“Invoice no.”, “of”, “Subtotal”, “Total”…), rendered in the **recipient’s**
   language via the server-side table in `packages/shared/src/doc-labels.ts`.
3. **Company free-text** — notes, document/email header & footer: the admin writes
   each **per language** in Settings (a language dropdown next to every field);
   the recipient sees their language, falling back to the company default, then
   English.

**The recipient’s language** is resolved per document/email:
`client.preferredLanguage` → the company default (`Settings → Localization`) →
`en` (see `resolveDocumentLocale` in `packages/shared/src/locales.ts`).

### Adding a language

The supported-language list has **one source of truth**:
`packages/shared/src/locales.ts` → the `LOCALES` array. To add a language (say
Dutch, `nl`):

1. **`packages/shared/src/locales.ts`** — add `{ code: "nl", englishName: "Dutch", nativeName: "Nederlands" }` to `LOCALES`.
2. **`packages/shared/src/doc-labels.ts`** — add an `nl` block with every `DocLabels` key (copy `EN` and translate). Missing keys fall back to English, so a partial translation still renders.
3. **`apps/web/src/locales/nl.json`** — add the UI catalog (copy `en.json`, translate). The parity test (`apps/web/src/test/locales/parity.test.ts`) enforces every locale has the exact same key set.
4. **`apps/web/src/plugins/i18n.ts`** — import and register `nl` (and add its `numberFormats`/`datetimeFormats` entries).
5. **`apps/api/src/modules/settings/schema.ts`** — add `"nl"` to `LANGUAGE_CODES` (a boot-time guard asserts it matches `LOCALE_CODES`).
6. **`apps/api/src/modules/email/i18n.ts`** — add an `nl` block for each transactional email template.

Everything else — the client language dropdown, the per-language settings
editors, the document/email language resolution — is driven off `LOCALES` and
picks up the new language automatically.

---

## Roles & permissions — admin vs normal user

Billy has two roles: **administrator** and **member**. Access is enforced
server-side by five **capabilities** (an admin has all of them; a member has none
by default, and an admin can grant any of them to a member individually in
**Settings → Users**):

| Capability | What it unlocks | Admin | Member (default) |
| :--- | :--- | :---: | :---: |
| `canManageSettings` | Edit company/branding/email/localization/documents/advanced settings (the admin Settings tabs) | ✅ | ❌ |
| `canManageUsers` | Add / edit / disable / delete users, assign roles + capabilities (Settings → Users) | ✅ | ❌ |
| `canViewFinancialTotals` | See money totals — dashboard financials, invoice/quote amounts | ✅ | ❌ |
| `canExportData` | Export data (import/export module) | ✅ | ❌ |
| `canPermanentlyDelete` | Hard-delete records (vs. soft-delete) | ✅ | ❌ |

**Every authenticated user — regardless of role — can:** use their own **User
Settings** tab to change their password and enable/disable **two-factor auth
(TOTP)**; and use the core app features their role allows (creating and managing
invoices, quotes, clients, etc.).

**What a normal member can't do** (unless an admin grants the capability): change
any global/company settings, manage other users, see financial totals, export
data, or permanently delete records. The Settings page shows a member **only**
their User Settings tab; the admin tabs (and Users) appear solely when the
matching capability is present — and the server rejects the underlying writes
regardless of what the UI shows. The **last active administrator** cannot be
demoted, disabled, or deleted (a safety invariant).

---

## Security notes & known limitations

Billy ships with Argon2 password hashing, server-side session cookies, optional
TOTP two-factor auth (secrets encrypted at rest), capability-gated authorization,
enumeration-safe login with per-account lockout, presigned/streamed file access,
and strict security headers. A few hardening items are **not yet enforced** and are
worth knowing before you expose an instance publicly:

- **CSRF tokens** are not yet verified on state-changing requests. Session cookies
  are `SameSite`, which mitigates the common cross-site cases, but a dedicated
  CSRF token check is not implemented.
- **Rate limiting** is coarse; there is no per-IP request window on the public
  surface beyond the per-account login lockout.
- **Antivirus scanning of uploads is opt-in.** Without a configured ClamAV
  scanner, uploaded files are treated as clean. Enable ClamAV (`CLAMAV_ENABLED`)
  for untrusted-upload environments.
- **TLS termination** is delegated to the reverse proxy (Traefik + Let's Encrypt in
  the prod overlay); the app trusts `X-Forwarded-Proto` from it.

Contributions hardening these are welcome. Run behind a trusted reverse proxy and
keep every secret in `.env` strong and private.

---

## Testing

Run `pnpm test` (api + worker + web + validation + config), or `pnpm typecheck`
for a full-workspace type check. Auth uses a real Argon2 round-trip and the TOTP
login challenge; invoice/money math is server-recomputed in integer minor units;
the PDF template, realtime WebSocket handshake, and settings flows are covered.
