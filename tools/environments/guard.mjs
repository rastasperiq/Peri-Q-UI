// Pure safety rules for the database tool. No I/O here, so they are unit-tested
// (guard.test.mjs) without touching any database.

/** Production Supabase project ("Peri Q"). Public identifier, not a secret. */
export const LIVE_PROJECT_REF = "ovqvytkhznhmlxsfaqwh";

const REF = /^[a-z0-9]{20}$/;

/**
 * Supabase project ref from a Postgres connection URL. Handles the direct host
 * (db.<ref>.supabase.co) and the pooler user (postgres.<ref>@...pooler...).
 */
export function projectRefFromDbUrl(dbUrl) {
  let url;
  try {
    url = new URL(dbUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
  const host = url.hostname.toLowerCase();
  const direct = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(host);
  if (direct) return direct[1];
  const user = decodeURIComponent(url.username).toLowerCase();
  const pooled = /^[a-z_]+\.([a-z0-9]{20})$/.exec(user);
  if (pooled && host.endsWith(".pooler.supabase.com")) return pooled[1];
  return null;
}

/**
 * Decide whether a command may run against a database. Throws with a plain
 * explanation when it may not. `marker` is the app_environment row's
 * environment ('test' | 'live') or null when the database is not marked.
 */
export function checkTarget({ env, ref, marker, confirmLive, allowUnmarked = false }) {
  if (env !== "test" && env !== "live") {
    throw new Error("Choose an environment: --env test or --env live.");
  }
  if (!ref || !REF.test(ref)) {
    throw new Error("Could not read a Supabase project ref from the connection URL. Refusing to continue.");
  }
  if (env === "test") {
    if (ref === LIVE_PROJECT_REF) {
      throw new Error("This connection points at the LIVE project. TEST commands never run against production.");
    }
    if (marker === "live") {
      throw new Error("This database is marked LIVE. Refusing to run a TEST command.");
    }
    if (marker !== "test" && !allowUnmarked) {
      throw new Error("This database is not marked as TEST. Run `mark-test` on the new TEST project first.");
    }
    return;
  }
  // LIVE: the ref must be production, typed out by the person running it.
  if (ref !== LIVE_PROJECT_REF) {
    throw new Error(`--env live only accepts the production project (${LIVE_PROJECT_REF}).`);
  }
  if (confirmLive !== LIVE_PROJECT_REF) {
    throw new Error(`LIVE needs --confirm-live ${LIVE_PROJECT_REF} typed out in full.`);
  }
  if (marker === "test") {
    throw new Error("The production project is marked TEST. Stop and investigate before doing anything.");
  }
  if (marker !== "live" && !allowUnmarked) {
    throw new Error("The production project is not marked LIVE yet. Run `mark-live` first.");
  }
}

/** Commands that delete or overwrite data. Never allowed on LIVE. */
export const TEST_ONLY_COMMANDS = new Set(["init-test", "mark-test", "reset-test", "seed-test", "refresh-test"]);

export function assertCommandAllowed(command, env) {
  if (TEST_ONLY_COMMANDS.has(command) && env !== "test") {
    throw new Error(`\`${command}\` only runs against TEST.`);
  }
}
