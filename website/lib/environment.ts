// Which environment is this deployment, and is it wired to the right
// database and payment keys? Server-only: it reads server environment
// variables and must never be imported into a client component.
//
// The environment is decided by trusted server configuration, never by the
// browser:
//   APP_ENVIRONMENT            'test' | 'live' (Vercel / .env.local)
//   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL   must point at that environment's project
//   YOCO_SECRET_KEY            sk_test_ in TEST; sk_live_ in LIVE
//   YOCO_ALLOW_TEST_KEYS_UNTIL LIVE only, before go-live: YYYY-MM-DD, at most 60 days ahead
//   app_environment row        the database's own marker (see migration 20261118120000)

import type { SupabaseClient } from "@supabase/supabase-js";

export type AppEnvironment = "test" | "live";

/** Production Supabase project ("Peri Q"). Public identifier, not a secret. */
export const LIVE_SUPABASE_PROJECT_REF = "ovqvytkhznhmlxsfaqwh";

type Env = Record<string, string | undefined>;

export type EnvironmentIssue = {
  /** block: payments and writes are refused. warn: shown to admins only. */
  level: "block" | "warn";
  message: string;
};

export type EnvironmentConfig = {
  environment: AppEnvironment;
  /** True when APP_ENVIRONMENT was not set and the value was inferred. */
  inferred: boolean;
  projectRef: string | null;
  paymentMode: "test" | "live" | null;
  issues: EnvironmentIssue[];
};

export function projectRefFromSupabaseUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(new URL(url.trim()).hostname.toLowerCase());
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function paymentModeFromKey(key: string | undefined): "test" | "live" | null {
  const value = (key ?? "").trim();
  if (value.startsWith("sk_live_")) return "live";
  if (value.startsWith("sk_test_")) return "test";
  return null;
}

/**
 * Resolve and validate the configured environment. Pure: pass `env` in tests.
 *
 * Without APP_ENVIRONMENT, only a Vercel production deployment of the
 * production project counts as LIVE; everything else (local development,
 * previews, unknown projects) is TEST. Local development therefore defaults
 * to TEST, and TEST is refused the production database below.
 */
export function readEnvironmentConfig(env: Env = process.env, now: Date = new Date()): EnvironmentConfig {
  const issues: EnvironmentIssue[] = [];
  const serverRef = projectRefFromSupabaseUrl(env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL);
  const publicRef = projectRefFromSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL);
  const projectRef = serverRef ?? publicRef;

  const declared = (env.APP_ENVIRONMENT ?? "").trim().toLowerCase();
  let environment: AppEnvironment;
  let inferred = false;
  if (declared === "test" || declared === "live") {
    environment = declared;
  } else {
    inferred = true;
    environment = env.VERCEL_ENV === "production" && projectRef === LIVE_SUPABASE_PROJECT_REF ? "live" : "test";
    issues.push({
      level: declared ? "block" : "warn",
      message: declared
        ? "APP_ENVIRONMENT must be 'test' or 'live'."
        : `APP_ENVIRONMENT is not set; treating this deployment as ${environment.toUpperCase()}.`,
    });
  }

  if (serverRef && publicRef && serverRef !== publicRef) {
    issues.push({ level: "block", message: "The server and browser Supabase URLs point at different projects." });
  }
  if (environment === "live" && projectRef && projectRef !== LIVE_SUPABASE_PROJECT_REF) {
    issues.push({ level: "block", message: "LIVE must use the production Supabase project." });
  }
  if (environment === "test" && (serverRef === LIVE_SUPABASE_PROJECT_REF || publicRef === LIVE_SUPABASE_PROJECT_REF)) {
    issues.push({ level: "block", message: "TEST must never use the production Supabase project." });
  }
  const expectedTestRef = (env.TEST_SUPABASE_PROJECT_REF ?? "").trim();
  if (environment === "test" && expectedTestRef && projectRef && projectRef !== expectedTestRef) {
    issues.push({ level: "block", message: "TEST is not using the expected TEST Supabase project." });
  }

  const paymentMode = paymentModeFromKey(env.YOCO_SECRET_KEY);
  if (environment === "test" && paymentMode === "live") {
    issues.push({ level: "block", message: "TEST refuses live Yoco keys." });
  }
  if (environment === "live" && paymentMode === "test") {
    // Test keys on LIVE only under an explicit, dated exception (audit SA-012).
    const until = testKeyExceptionEnd(env.YOCO_ALLOW_TEST_KEYS_UNTIL, now);
    issues.push(
      until
        ? { level: "warn", message: `LIVE is using Yoco test keys until ${until} (before go-live).` }
        : { level: "block", message: "LIVE refuses Yoco test keys. Set live keys, or YOCO_ALLOW_TEST_KEYS_UNTIL=YYYY-MM-DD (at most 60 days ahead) before go-live." },
    );
  }

  return { environment, inferred, projectRef, paymentMode, issues };
}

const MAX_TEST_KEY_EXCEPTION_DAYS = 60;

/** The exception's last day (YYYY-MM-DD) while it is valid and current, else null. */
function testKeyExceptionEnd(value: string | undefined, now: Date): string | null {
  const day = (value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const end = Date.parse(`${day}T23:59:59Z`);
  if (!Number.isFinite(end) || new Date(end).toISOString().slice(0, 10) !== day) return null;
  const remaining = end - now.getTime();
  return remaining >= 0 && remaining <= (MAX_TEST_KEY_EXCEPTION_DAYS + 1) * 86_400_000 ? day : null;
}

/** Environment for display (banner, metadata). Synchronous, no database call. */
export function currentEnvironment(env: Env = process.env): AppEnvironment {
  return readEnvironmentConfig(env).environment;
}

export type DatabaseMarker = { environment: AppEnvironment | null; projectRef: string | null; label: string | null };

export type EnvironmentStatus = EnvironmentConfig & {
  database: {
    provider: "Supabase";
    status: "connected" | "error" | "not_configured";
    marker: DatabaseMarker | null;
    checkedAt: string;
    lastSuccessAt: string | null;
  };
  ok: boolean;
};

/** Compare the configuration with the database's own marker. Pure. */
export function combineWithMarker(
  config: EnvironmentConfig,
  database: EnvironmentStatus["database"],
): EnvironmentStatus {
  const issues = [...config.issues];
  const marker = database.marker;
  if (database.status === "error") {
    issues.push({ level: "block", message: "The database could not be reached for the environment check." });
  }
  if (database.status === "connected") {
    if (!marker?.environment) {
      // Unmarked databases are refused in both environments (audit SA-012).
      issues.push({
        level: "block",
        message: `The ${config.environment.toUpperCase()} database is not marked as ${config.environment.toUpperCase()}.`,
      });
    } else if (marker.environment !== config.environment) {
      issues.push({
        level: "block",
        message: `This deployment is ${config.environment.toUpperCase()} but its database is marked ${marker.environment.toUpperCase()}.`,
      });
    }
    if (marker?.projectRef && config.projectRef && marker.projectRef !== config.projectRef) {
      issues.push({ level: "block", message: "The database marker belongs to a different Supabase project." });
    }
  }
  return { ...config, issues, database, ok: !issues.some((issue) => issue.level === "block") };
}

let cached: { at: number; status: EnvironmentStatus } | null = null;
let lastSuccessAt: string | null = null;
const CACHE_MS = 60_000;

/**
 * Full check, including the database marker. Cached for a minute per server
 * instance so payment routes do not query it on every request.
 */
export async function verifyEnvironment(
  createClient: () => SupabaseClient | null,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<EnvironmentStatus> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  const config = readEnvironmentConfig();
  const checkedAt = new Date().toISOString();
  let database: EnvironmentStatus["database"];
  const client = createClient();
  if (!client) {
    database = { provider: "Supabase", status: "not_configured", marker: null, checkedAt, lastSuccessAt };
  } else {
    const { data, error } = await client
      .from("app_environment")
      .select("environment,project_ref,label")
      .maybeSingle();
    // 42P01: the marker table does not exist yet (guard migration not applied).
    if (error && error.code !== "42P01" && error.code !== "PGRST205") {
      database = { provider: "Supabase", status: "error", marker: null, checkedAt, lastSuccessAt };
    } else {
      lastSuccessAt = checkedAt;
      const row = (data ?? null) as { environment?: string; project_ref?: string; label?: string } | null;
      const environment = row?.environment === "test" || row?.environment === "live" ? row.environment : null;
      database = {
        provider: "Supabase",
        status: "connected",
        marker: row ? { environment, projectRef: row.project_ref ?? null, label: row.label ?? null } : null,
        checkedAt,
        lastSuccessAt,
      };
    }
  }
  const status = combineWithMarker(config, database);
  if (!status.ok) {
    // Messages only: never log keys or URLs.
    console.error("Environment check failed:", status.issues.filter((i) => i.level === "block").map((i) => i.message));
  }
  cached = { at: Date.now(), status };
  return status;
}

/** For tests. */
export function resetEnvironmentCache() {
  cached = null;
  lastSuccessAt = null;
}
