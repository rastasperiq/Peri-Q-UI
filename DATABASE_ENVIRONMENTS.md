# RastasperiQ database environments: LIVE and TEST

RastasperiQ runs as two independent environments. Each has its own Supabase
project (database, auth, storage), its own website deployment, its own Yoco
keys and webhook, and its own app build. Nothing is shared between them, and
nothing is ever copied from TEST into LIVE.

| | LIVE (production) | TEST (staging) |
|---|---|---|
| Supabase project | "Peri Q", ref `ovqvytkhznhmlxsfaqwh` | "Peri Q TEST", ref recorded below once created |
| Website | Vercel project for `rastasperiq.co.za`, branch `main` | Separate Vercel project for `staging.rastasperiq.co.za`, branch `staging` |
| Yoco | Live keys after go-live (test keys until then), webhook `https://rastasperiq.co.za/api/yoco/webhook/` | Test keys only, webhook `https://staging.rastasperiq.co.za/api/yoco/webhook/` |
| Android app | Release build with `release-config.json` | Build with `release-config.test.json` |
| Data | Real customers, orders and payments | Demo accounts and demo orders only |
| Indicators | Green "LIVE · PRODUCTION" badge in the owner dashboard | Orange TEST MODE banner everywhere, TEST tags on payment screens |

TEST project: "Peri Q TEST", ref `dgrudenflbdbddtcnbeg`, Central EU (Frankfurt),
organisation RastasperiQ (public identifiers, not secrets). Staging Vercel
project: `peri-q-ui-staging` (team RastasperiQ), production branch `staging`.
First built with `tools/environments/setup-test.ps1`.

Never write keys, passwords or connection strings in this file or anywhere in
Git. They live only in Vercel, in Supabase, in your password manager, or for
the length of one terminal session.

## 1. Existing architecture

- **Database:** Supabase (managed PostgreSQL 17). 19 public tables (orders,
  order_items, payments, payment_refunds, checkout_intents, delivery_quotes,
  menu, settings, profiles, push tokens, consent and privacy records, audit
  log, rate limits, webhook events), about 31 functions, 20 triggers and 38
  row-level-security policies. The full definition is
  `peri_q_app/supabase/schema.sql`; changes are the dated files in
  `peri_q_app/supabase/migrations/`.
- **Auth:** Supabase Auth with email/password and anonymous (guest) sign-in.
  Admins are profiles with `role = 'admin'`.
- **Storage:** `menu-images` (public) and `payment-proofs` (private).
- **Website:** Next.js on Vercel (`website/`). Server routes:
  `/api/yoco/checkout`, `/api/yoco/webhook`, `/api/delivery/quote`,
  `/api/environment`.
- **Payments:** Yoco hosted checkout, card only. Test or live is decided by the
  key prefix (`sk_test_` / `sk_live_`); every checkout, payment and refund row
  records its mode.
- **Background work:** pg_cron jobs `retention-daily` and
  `delivery-quotes-cleanup`; Supabase Edge Function `order-push` (Firebase
  push); Yoco webhooks; Google Routes API for delivery distance.

## 2. How each environment knows what it is

Three independent checks must agree before the website takes a payment or
writes data. If any disagrees, the payment and delivery-quote routes answer
503 and card payments show as unavailable.

1. **`APP_ENVIRONMENT`** (`test` or `live`), a server-only Vercel variable.
   Without it, only a Vercel *production* deployment of the production project
   counts as LIVE; everything else, including local development, is TEST.
2. **The Supabase project ref** in `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`.
   LIVE must be `ovqvytkhznhmlxsfaqwh`. TEST must not be. Optionally
   `TEST_SUPABASE_PROJECT_REF` pins TEST to its own project.
3. **The database's own marker**, the one-row table `public.app_environment`
   (`environment` = `test`/`live`). Only the database owner can write it; the
   website and the app can only read it.

Payment keys are checked too: TEST refuses `sk_live_` keys. LIVE refuses
`sk_test_` keys once `YOCO_REQUIRE_LIVE_KEYS=true` is set at go-live.

Inside the database, triggers on `orders`, `checkout_intents`, `payments` and
`payment_refunds` refuse live-mode payment rows in a TEST database, and
test-mode rows in a LIVE database once `allow_test_payments` is false. A
database without a marker row behaves exactly as before.

The app reads the same marker from the database it is connected to, so a TEST
build shows the TEST banner because its database says so, not because of a
setting a user could change.

## 3. Environment variables (names only)

**Website (Vercel, per project):**

| Variable | LIVE | TEST |
|---|---|---|
| `APP_ENVIRONMENT` | `live` | `test` |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL` | production project URL | TEST project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | production publishable key | TEST publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | production service-role key | TEST service-role key |
| `NEXT_PUBLIC_SITE_URL` | `https://rastasperiq.co.za` | `https://staging.rastasperiq.co.za` |
| `YOCO_SECRET_KEY` | `sk_live_…` after go-live | `sk_test_…` only |
| `YOCO_WEBHOOK_SECRET` | secret of the LIVE webhook | secret of the TEST webhook |
| `GOOGLE_ROUTES_API_KEY` | production key | separate restricted key |
| `TEST_SUPABASE_PROJECT_REF` | not set | TEST project ref |
| `YOCO_REQUIRE_LIVE_KEYS` | `true` after go-live | not set |

**App build (`--dart-define-from-file`):** `APP_ENVIRONMENT`, `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `CARD_CHECKOUT_URL`, `DELIVERY_QUOTE_URL`,
`ENVIRONMENT_STATUS_URL`. Template: `peri_q_app/release-config.test.example.json`.
Real files (`release-config*.json`) are git-ignored.

**Database tool (your terminal only, never saved):** `PERIQ_TEST_DB_URL`,
`PERIQ_LIVE_DB_URL`, `PERIQ_TEST_DEMO_PASSWORD`, optional `PERIQ_DB_CA_FILE`.

**Edge function secrets (Supabase, per project):** `FCM_PROJECT_ID`,
`FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`. TEST has none until push notifications
are needed there.

## 4. How to access each environment

- **LIVE website:** https://rastasperiq.co.za. **LIVE database:** Supabase
  dashboard → project "Peri Q".
- **TEST website:** https://staging.rastasperiq.co.za (orange banner on every
  page). **TEST database:** Supabase dashboard → project "Peri Q TEST".
- **Owner dashboard (app):** the badge next to "Owner Dashboard" says
  LIVE · PRODUCTION or TEST. The Environment panel underneath shows the
  environment, database provider and project, marker, connection status,
  application URL, Yoco mode, auth project and last database check.
- **Demo accounts (TEST only):** `admin@demo.rastasperiq.test`,
  `customer1@demo.rastasperiq.test`, `customer2@demo.rastasperiq.test`. Their
  password is whatever you set in `PERIQ_TEST_DEMO_PASSWORD` when seeding.
  `.test` addresses can never receive e-mail.

## 5. Switching environments safely

- **Local website development is always TEST.** Copy `website/.env.example`
  to `website/.env.local`, keep `APP_ENVIRONMENT=test`, and fill in TEST values
  only. If a LIVE URL ends up there, the website refuses payments and writes.
- **App:** build with `release-config.json` for LIVE and
  `release-config.test.json` for TEST. They are separate apps (flavours `live`
  and `staging`; the TEST package ends in `.test`), so both can be on one phone.
- **Database tool:** set only the URL you need, in a fresh terminal, and close
  the terminal when done:

  ```powershell
  $env:PERIQ_TEST_DB_URL = Read-Host 'TEST connection string'
  ```

## 6. The database tool

All database work goes through `tools/environments/db.mjs`. Install once:

```powershell
cd tools/environments
npx pnpm@11.9.0 install
```

Its safety rules (unit-tested in `guard.test.mjs`, run with `node --test guard.test.mjs`):

- The project ref is read from the connection URL and checked **before
  connecting**. `PERIQ_TEST_DB_URL` pointing at production is refused.
- TEST commands also need the database marker to say `test`.
- Anything that deletes or overwrites (`init-test`, `reset-test`,
  `seed-test`, `refresh-test`, `mark-test`) only runs against TEST, and starts
  with `select public.assert_app_environment('test')` inside its own transaction.
- LIVE commands need `--confirm-live ovqvytkhznhmlxsfaqwh` typed in full and a
  LIVE marker.
- Reading LIVE (`refresh-test`) uses a read-only transaction.

| Command | What it does |
|---|---|
| `node db.mjs status --env test` | Read-only: project, marker, row counts |
| `node db.mjs init-test` | Build an **empty** new TEST project from `schema.sql` and mark it TEST |
| `node db.mjs seed-test` | Add the demo accounts and up to 3 demo orders |
| `node db.mjs reset-test` | Delete all TEST customers, orders, payments and logs; keep menu and settings; re-seed |
| `node db.mjs refresh-test --confirm-live ovqvytkhznhmlxsfaqwh` | Copy menu, categories and settings from LIVE (read-only), then reset-test |
| `node db.mjs migrate --env test --file <file.sql>` | Apply one migration to TEST |
| `node db.mjs migrate --env live --confirm-live ovqvytkhznhmlxsfaqwh --file <file.sql> --dry-run` | Show what would run on LIVE |
| `node db.mjs mark-live --confirm-live ovqvytkhznhmlxsfaqwh --allow-test-payments true` | Mark production LIVE (before go-live) |

## 7. Creating the TEST environment (one-off)

1. **Supabase:** create project "Peri Q TEST" in the same organisation as
   "Peri Q" (Free plan: 2 free projects per organisation; Pro: about US$10 a
   month per extra project). Region: same as LIVE. Save its database password
   in your password manager.
2. **Auth settings (TEST project):** enable Email and Anonymous sign-ins. Site
   URL `https://staging.rastasperiq.co.za`; redirect URLs
   `https://staging.rastasperiq.co.za/auth/callback/`,
   `https://staging.rastasperiq.co.za/auth/callback/?recovery=1`,
   `http://localhost:3000/auth/callback/`, `rastasperiq-test://reset-password`.
3. **Schema and marker:** set `PERIQ_TEST_DB_URL` (Supabase → Connect →
   Session pooler) and run `node db.mjs init-test`. It refuses any project
   that already has tables.
4. **Catalogue and demo data:** set `PERIQ_TEST_DEMO_PASSWORD`, then either
   `node db.mjs seed-test` (the catalogue from `schema.sql`) or
   `refresh-test --confirm-live …` (today's LIVE menu and settings).
5. **Vercel:** create a second project from the same GitHub repository, root
   `website`, production branch `staging`. Add the TEST variables from
   section 3 to it. Add the domain `staging.rastasperiq.co.za` (Vercel shows
   the DNS record to add at the domain registrar). Optionally protect it with
   Vercel Deployment Protection.
6. **Yoco (TEST keys):** register the TEST webhook with
   `website/scripts/register-yoco-webhook.ps1 -WebhookUrl https://staging.rastasperiq.co.za/api/yoco/webhook/ -Name rastasperiq-staging`,
   entering the **test** secret key (the script refuses a live key for staging). Save the shown `whsec_…` as `YOCO_WEBHOOK_SECRET` in the TEST
   Vercel project only. Redeploy.
7. **Check:** `https://staging.rastasperiq.co.za/api/yoco/checkout/` returns
   `"mode":"test"`; the orange banner shows; the owner dashboard (signed in as
   the demo admin in a TEST app build) shows TEST and no issues.

## 8. Migrations: TEST first, then LIVE

1. Write the change as a new dated file in `peri_q_app/supabase/migrations/`,
   idempotent (`if not exists`, `create or replace`), wrapped in
   `begin; … commit;`. Append the same SQL to `schema.sql`.
2. Optional local rehearsal: `tools/staging-rehearsal/`.
3. Apply to TEST: `node db.mjs migrate --env test --file <file>`.
4. Test on staging (website and a TEST app build).
5. Get approval. Then, with the approved file only:
   `node db.mjs migrate --env live --confirm-live ovqvytkhznhmlxsfaqwh --file <file> --dry-run`,
   then the same without `--dry-run`.
6. Never re-run `schema.sql` on LIVE, and apply migrations in date order only.

**First time for this guard itself:** apply
`20261118120000_environment_guard.sql` to LIVE as above (the tool allows this
one step before LIVE has a marker), then run
`mark-live --confirm-live ovqvytkhznhmlxsfaqwh --allow-test-payments true`.
At go-live, run `mark-live … --allow-test-payments false` and set
`YOCO_REQUIRE_LIVE_KEYS=true` on the LIVE Vercel project.

## 9. Deploying approved code changes

1. Work on a feature branch; open a pull request into `staging`.
2. Merge into `staging` → the TEST Vercel project deploys. Test there.
3. When approved, open a pull request from `staging` (or the feature branch)
   into `main` → the LIVE project deploys.
4. Before merging anything that needs new Vercel variables, add them to LIVE
   first (for this change: `APP_ENVIRONMENT=live`).

## 10. Testing payments

- Only on TEST, with Yoco **test** keys and Yoco's test cards. TEST refuses
  live keys, so a real card can never be charged there.
- Refunds of test payments are made in the Yoco dashboard's test mode; the
  TEST webhook records them in the TEST database only. LIVE's webhook secret
  is different, so a TEST event can never be accepted by LIVE, and the reverse.
- Never create real orders or real payments on LIVE for testing, except the
  one agreed go-live verification in `GO_LIVE_CLIENT_CHECKLIST.md`.

## 11. Refreshing and resetting TEST

- `reset-test`: wipes TEST customers, auth users, orders, checkout drafts,
  payments, refunds, webhook events, delivery quotes, consent and privacy
  records, push tokens, rate limits and the audit log. Keeps menu, categories,
  settings and retention settings. Re-seeds demo data.
- `refresh-test`: copies **only** non-personal catalogue data (menu items,
  categories, app settings) from LIVE in a read-only transaction, then runs
  `reset-test`. No customer, order, payment or auth data is ever copied, so
  there is nothing personal to anonymise.
- Storage files (menu photos) are not copied; menu rows keep their image
  paths and URLs.

## 12. Backup and recovery

- **LIVE:** Supabase takes daily backups (Free: 1 day kept; Pro: 7 days; PITR
  is a paid add-on). Before any LIVE migration, download a backup from
  Supabase → Database → Backups, or run `pg_dump` with the LIVE connection
  string from your own terminal.
- **TEST:** disposable. To recover, `reset-test` or `refresh-test`; to start
  over, delete and recreate the TEST project and repeat section 7.
- If a LIVE migration fails, it rolls back as one transaction. Fix the file,
  try it on TEST again, then retry.

## Outstanding

- Push notifications in TEST need their own Firebase credentials on the TEST
  Supabase project.
- Website unit tests must run with `NODE_OPTIONS=--no-experimental-webstorage`
  on Node 26 (Node's own `localStorage` hides the test DOM's one).
