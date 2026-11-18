#!/usr/bin/env node
// Guarded TEST/LIVE database tool for RastasperiQ.
//
// Connection strings come only from environment variables set in your own
// terminal for the session; they are never read from or written to files:
//   PERIQ_TEST_DB_URL   TEST project  (Supabase → Connect → Session pooler)
//   PERIQ_LIVE_DB_URL   LIVE project  (only for status, migrate, mark-live and
//                                      the read-only catalogue copy in refresh-test)
//   PERIQ_TEST_DEMO_PASSWORD  password given to the demo accounts (seed-test)
//
// Every command checks the project ref inside the URL and the app_environment
// marker inside the database before it does anything. See
// DATABASE_ENVIRONMENTS.md for the procedures.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { LIVE_PROJECT_REF, assertCommandAllowed, checkTarget, projectRefFromDbUrl } from "./guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const SCHEMA_FILE = resolve(repoRoot, "peri_q_app/supabase/schema.sql");
const DEMO_DOMAIN = "demo.rastasperiq.test"; // .test never receives e-mail

const USAGE = `Usage: node db.mjs <command> [options]

Read-only:
  status        --env test|live [--confirm-live ${LIVE_PROJECT_REF}]

TEST only (refuse the LIVE project):
  init-test     Build an EMPTY new TEST project from schema.sql and mark it TEST
  mark-test     Mark the TEST project (after a manual schema load)
  seed-test     Add labelled demo accounts and demo orders
  reset-test    Delete all TEST customers/orders/payments, then seed-test
  refresh-test  Copy menu, categories and settings from LIVE (read-only), then reset-test

Both (LIVE needs --confirm-live ${LIVE_PROJECT_REF}):
  migrate       --env test|live --file <migration.sql> [--dry-run]
  mark-live     --confirm-live ${LIVE_PROJECT_REF} --allow-test-payments true|false
`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      i++;
    }
  }
  return { command, options };
}

function dbUrlFor(env) {
  const name = env === "live" ? "PERIQ_LIVE_DB_URL" : "PERIQ_TEST_DB_URL";
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`Set ${name} in this terminal first (see DATABASE_ENVIRONMENTS.md).`);
  return value;
}

function sslOptions() {
  const caFile = (process.env.PERIQ_DB_CA_FILE ?? "").trim();
  if (caFile) return { ca: readFileSync(caFile, "utf8"), rejectUnauthorized: true };
  // Supabase signs with its own CA. Download it (Database settings → SSL) and
  // set PERIQ_DB_CA_FILE to verify the server certificate as well.
  return { rejectUnauthorized: false };
}

async function connect(env, { readOnly = false } = {}) {
  const url = dbUrlFor(env);
  const ref = projectRefFromDbUrl(url);
  // Refuse a wrong project before opening any connection to it.
  if (!ref) throw new Error("Could not read a Supabase project ref from the connection URL. Refusing to connect.");
  if (env === "test" && ref === LIVE_PROJECT_REF) {
    throw new Error("PERIQ_TEST_DB_URL points at the LIVE project. Refusing to connect.");
  }
  if (env === "live" && ref !== LIVE_PROJECT_REF) {
    throw new Error(`PERIQ_LIVE_DB_URL must point at the production project (${LIVE_PROJECT_REF}). Refusing to connect.`);
  }
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(), application_name: `periq-db-${env}` });
  await client.connect();
  if (readOnly) await client.query("set session characteristics as transaction read only");
  return { client, ref };
}

async function readMarker(client) {
  const { rows } = await client.query("select to_regclass('public.app_environment') is not null as present");
  if (!rows[0].present) return { table: false, environment: null, row: null };
  const result = await client.query(
    "select environment, project_ref, label, allow_test_payments from public.app_environment where id",
  );
  const row = result.rows[0] ?? null;
  return { table: true, environment: row?.environment ?? null, row };
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function inTransaction(client, work) {
  await client.query("begin");
  try {
    const result = await work();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function tableExists(client, name) {
  const { rows } = await client.query("select to_regclass($1) is not null as present", [`public.${name}`]);
  return rows[0].present;
}

// ---------------------------------------------------------------- commands

async function status({ env, confirmLive }) {
  const { client, ref } = await connect(env, { readOnly: true });
  try {
    if (env === "live" && confirmLive !== LIVE_PROJECT_REF) {
      throw new Error(`Reading LIVE needs --confirm-live ${LIVE_PROJECT_REF}.`);
    }
    const marker = await readMarker(client);
    const { rows } = await client.query("select current_database() as db, now() as checked_at");
    const counts = {};
    for (const table of ["menu_items", "orders", "payments", "profiles"]) {
      if (await tableExists(client, table)) {
        const r = await client.query(`select count(*)::int as n from public.${table}`);
        counts[table] = r.rows[0].n;
      }
    }
    log(`Requested environment: ${env.toUpperCase()}`);
    log(`Project ref from URL:  ${ref ?? "unknown"}${ref === LIVE_PROJECT_REF ? "  (PRODUCTION)" : ""}`);
    log(`Database marker:       ${marker.environment ?? (marker.table ? "not set" : "no app_environment table")}`);
    if (marker.row) log(`Marker project ref:    ${marker.row.project_ref}  label: ${marker.row.label}  allow_test_payments: ${marker.row.allow_test_payments}`);
    log(`Row counts:            ${JSON.stringify(counts)}`);
    log(`Checked at:            ${rows[0].checked_at.toISOString()}`);
    if (marker.row && marker.row.project_ref !== ref) log("WARNING: the marker's project ref does not match the URL.");
  } finally {
    await client.end();
  }
}

async function markTest(client, ref) {
  await inTransaction(client, async () => {
    const marker = await readMarker(client);
    if (!marker.table) throw new Error("app_environment table is missing. Apply schema.sql / the environment_guard migration first.");
    checkTarget({ env: "test", ref, marker: marker.environment, allowUnmarked: true });
    await client.query(
      `insert into public.app_environment (id, environment, project_ref, label, allow_test_payments)
       values (true, 'test', $1, 'TEST', false)
       on conflict (id) do update set environment = 'test', project_ref = excluded.project_ref,
         label = 'TEST', allow_test_payments = false, updated_at = timezone('utc', now())
       where public.app_environment.environment = 'test'`,
      [ref],
    );
  });
  log(`Marked project ${ref} as TEST.`);
}

async function initTest() {
  const { client, ref } = await connect("test");
  try {
    const marker = await readMarker(client);
    checkTarget({ env: "test", ref, marker: marker.environment, allowUnmarked: true });
    if (await tableExists(client, "orders")) {
      throw new Error("This project already has tables. init-test only builds an empty project; use reset-test instead.");
    }
    log(`Loading ${SCHEMA_FILE} into TEST project ${ref} ...`);
    await client.query(readFileSync(SCHEMA_FILE, "utf8"));
    await markTest(client, ref);
    log("TEST schema loaded. Next: node db.mjs seed-test");
  } finally {
    await client.end();
  }
}

async function migrate({ env, file, confirmLive, dryRun }) {
  if (!file || file === true) throw new Error("migrate needs --file <path to migration .sql>.");
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) throw new Error(`Migration not found: ${path}`);
  const { client, ref } = await connect(env);
  try {
    const marker = await readMarker(client);
    // Only the very first guard migration may run before the marker table exists.
    checkTarget({ env, ref, marker: marker.environment, confirmLive, allowUnmarked: env === "live" && !marker.table });
    log(`Target: ${env.toUpperCase()} project ${ref}, marker ${marker.environment ?? "none"}`);
    log(`Migration: ${path}`);
    if (dryRun) {
      log("Dry run: nothing executed.");
      return;
    }
    if (marker.table) {
      await client.query("select public.assert_app_environment($1)", [env]);
    }
    await client.query(readFileSync(path, "utf8"));
    log("Migration applied.");
  } finally {
    await client.end();
  }
}

async function markLive({ confirmLive, allowTestPayments }) {
  if (allowTestPayments !== "true" && allowTestPayments !== "false") {
    throw new Error("mark-live needs --allow-test-payments true (before go-live) or false (after go-live).");
  }
  const { client, ref } = await connect("live");
  try {
    await inTransaction(client, async () => {
      const marker = await readMarker(client);
      if (!marker.table) throw new Error("Apply the environment_guard migration to LIVE first.");
      checkTarget({ env: "live", ref, marker: marker.environment, confirmLive, allowUnmarked: true });
      await client.query(
        `insert into public.app_environment (id, environment, project_ref, label, allow_test_payments)
         values (true, 'live', $1, 'LIVE', $2)
         on conflict (id) do update set allow_test_payments = excluded.allow_test_payments,
           updated_at = timezone('utc', now())
         where public.app_environment.environment = 'live' and public.app_environment.project_ref = excluded.project_ref`,
        [ref, allowTestPayments === "true"],
      );
    });
    log(`Marked project ${ref} as LIVE (allow_test_payments = ${allowTestPayments}).`);
  } finally {
    await client.end();
  }
}

// Tables cleared by reset-test, children first. Menu, categories, settings and
// retention_settings are kept.
const RESET_TABLES = [
  "yoco_webhook_events",
  "payment_refunds",
  "payments",
  "order_items",
  "orders",
  "checkout_intent_items",
  "checkout_intents",
  "delivery_quotes",
  "policy_acceptances",
  "privacy_requests",
  "push_notification_dispatches",
  "push_tokens",
  "api_rate_limits",
];

async function resetTest() {
  const { client, ref } = await connect("test");
  try {
    await inTransaction(client, async () => {
      const marker = await readMarker(client);
      checkTarget({ env: "test", ref, marker: marker.environment });
      await client.query("select public.assert_app_environment('test')");
      for (const table of RESET_TABLES) {
        if (await tableExists(client, table)) await client.query(`delete from public.${table}`);
      }
      const users = await client.query("delete from auth.users");
      if (await tableExists(client, "admin_audit_log")) await client.query("delete from public.admin_audit_log");
      log(`Cleared TEST data and ${users.rowCount} TEST user(s).`);
    });
  } finally {
    await client.end();
  }
  await seedTest();
}

const DEMO_USERS = [
  { key: "admin", email: `admin@${DEMO_DOMAIN}`, name: "Demo Admin (TEST)", phone: "+27000000000", role: "admin" },
  { key: "customer1", email: `customer1@${DEMO_DOMAIN}`, name: "Demo Customer One (TEST)", phone: "+27000000001", role: "customer" },
  { key: "customer2", email: `customer2@${DEMO_DOMAIN}`, name: "Demo Customer Two (TEST)", phone: "+27000000002", role: "customer" },
];

async function createDemoUser(client, user, password) {
  const existing = await client.query("select id from auth.users where email = $1", [user.email]);
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await client.query(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       confirmation_token, recovery_token, email_change_token_new, email_change)
     values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
       $1, extensions.crypt($2, extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('full_name', $3::text),
       now(), now(), '', '', '', '')
     returning id`,
    [user.email, password, user.name],
  );
  const id = rows[0].id;
  await client.query(
    `insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
     values (gen_random_uuid(), $1::uuid, $1::uuid::text, 'email',
       jsonb_build_object('sub', $1::uuid::text, 'email', $2::text, 'email_verified', true), now(), now(), now())`,
    [id, user.email],
  );
  return id;
}

async function seedTest() {
  const password = (process.env.PERIQ_TEST_DEMO_PASSWORD ?? "").trim();
  if (password.length < 12) {
    throw new Error("Set PERIQ_TEST_DEMO_PASSWORD (12+ characters) in this terminal. It becomes the demo accounts' password.");
  }
  const { client, ref } = await connect("test");
  try {
    await inTransaction(client, async () => {
      const marker = await readMarker(client);
      checkTarget({ env: "test", ref, marker: marker.environment });
      await client.query("select public.assert_app_environment('test')");

      const ids = {};
      for (const user of DEMO_USERS) ids[user.key] = await createDemoUser(client, user, password);

      // Labelled profile details; the role guard is bypassed only inside this
      // TEST transaction (the trigger is re-enabled before commit).
      await client.query("alter table public.profiles disable trigger profiles_protect_role");
      for (const user of DEMO_USERS) {
        await client.query("update public.profiles set full_name = $2, phone = $3, role = $4 where id = $1", [
          ids[user.key],
          user.name,
          user.phone,
          user.role,
        ]);
      }
      await client.query("alter table public.profiles enable trigger profiles_protect_role");

      const item = await client.query(
        "select id, name, description, image_path, category, price from public.menu_items order by price limit 1",
      );
      if (!item.rows[0]) {
        log("No menu items found: demo accounts created, demo orders skipped.");
        return;
      }
      const menu = item.rows[0];
      // Orders may only be inserted as service_role with a verified test payment.
      await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true),
                                 set_config('request.jwt.claim.role', 'service_role', true)`);
      const demoOrders = [
        { user: "customer1", n: 1, type: "pickup", status: "completed", address: null },
        { user: "customer1", n: 2, type: "delivery", status: "pending", address: "1 Demo Street, Test Town (TEST ADDRESS)" },
        { user: "customer2", n: 3, type: "pickup", status: "pending", address: null },
      ];
      for (const order of demoOrders) {
        const user = DEMO_USERS.find((u) => u.key === order.user);
        const requestId = `demo-order-${order.n}`;
        const exists = await client.query(
          "select 1 from public.orders where user_id = $1 and client_request_id = $2",
          [ids[order.user], requestId],
        );
        if (exists.rows[0]) continue;
        const total = Number(menu.price);
        const { rows } = await client.query(
          `insert into public.orders (user_id, customer_name, customer_phone, order_type, payment_method, total_price,
             status, estimated_minutes, delivery_address, client_request_id, yoco_checkout_id, payment_status, paid_at,
             payment_amount_cents, yoco_payment_id, yoco_mode)
           values ($1, $2, $3, $4, 'yoco', $5, $6, 25, $7, $8, $9, 'paid', now(), $10, $11, 'test')
           returning id`,
          [
            ids[order.user], user.name, user.phone, order.type, total, order.status, order.address, requestId,
            `demo-checkout-${order.n}`, Math.round(total * 100), `demo-payment-${order.n}`,
          ],
        );
        await client.query(
          `insert into public.order_items (order_id, menu_item_id, item_name, item_description, item_image_path,
             item_category, unit_price, quantity)
           values ($1, $2, $3, $4, $5, $6, $7, 1)`,
          [rows[0].id, menu.id, menu.name, menu.description, menu.image_path, menu.category, menu.price],
        );
      }
    });
    log(`Seeded TEST project ${ref}: ${DEMO_USERS.map((u) => u.email).join(", ")} and up to 3 demo orders.`);
  } finally {
    await client.end();
  }
}

// Non-personal catalogue tables copied from LIVE. Nothing with customer data.
const CATALOGUE_TABLES = ["menu_categories", "menu_items", "app_settings"];

async function refreshTest({ confirmLive }) {
  if (confirmLive !== LIVE_PROJECT_REF) {
    throw new Error(`refresh-test reads LIVE: add --confirm-live ${LIVE_PROJECT_REF}.`);
  }
  const live = await connect("live", { readOnly: true });
  const snapshot = {};
  try {
    checkTarget({ env: "live", ref: live.ref, marker: "live", confirmLive });
    await live.client.query("begin transaction read only");
    for (const table of CATALOGUE_TABLES) {
      const { rows } = await live.client.query(`select * from public.${table}`);
      snapshot[table] = rows;
    }
    await live.client.query("commit");
  } finally {
    await live.client.end();
  }

  const { client, ref } = await connect("test");
  try {
    await inTransaction(client, async () => {
      const marker = await readMarker(client);
      checkTarget({ env: "test", ref, marker: marker.environment });
      await client.query("select public.assert_app_environment('test')");
      for (const table of CATALOGUE_TABLES) {
        const rows = snapshot[table];
        if (!rows.length) continue;
        const columns = Object.keys(rows[0]);
        const updates = columns.filter((c) => c !== "id").map((c) => `"${c}" = excluded."${c}"`);
        for (const row of rows) {
          const values = columns.map((c) => row[c]);
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
          await client.query(
            `insert into public.${table} (${columns.map((c) => `"${c}"`).join(", ")}) values (${placeholders})
             on conflict (id) do update set ${updates.join(", ")}`,
            values,
          );
        }
        log(`Copied ${rows.length} ${table} row(s) from LIVE.`);
      }
    });
  } finally {
    await client.end();
  }
  await resetTest();
}

// -------------------------------------------------------------------- main

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || options.help) {
    log(USAGE);
    return;
  }
  const env = options.env ?? (command.endsWith("-test") ? "test" : command === "mark-live" ? "live" : undefined);
  if (env !== "test" && env !== "live") throw new Error(`\`${command}\` needs --env test or --env live.`);
  assertCommandAllowed(command, env);
  const confirmLive = typeof options["confirm-live"] === "string" ? options["confirm-live"] : undefined;
  switch (command) {
    case "status":
      return status({ env, confirmLive });
    case "init-test":
      return initTest();
    case "mark-test": {
      const { client, ref } = await connect("test");
      try {
        return await markTest(client, ref);
      } finally {
        await client.end();
      }
    }
    case "seed-test":
      return seedTest();
    case "reset-test":
      return resetTest();
    case "refresh-test":
      return refreshTest({ confirmLive });
    case "migrate":
      return migrate({ env, file: options.file, confirmLive, dryRun: options["dry-run"] === true });
    case "mark-live":
      return markLive({ confirmLive, allowTestPayments: options["allow-test-payments"] });
    default:
      throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  }
}

main().catch((error) => {
  process.stderr.write(`STOPPED: ${error.message}\n`);
  process.exitCode = 1;
});
