import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  LIVE_SUPABASE_PROJECT_REF,
  combineWithMarker,
  projectRefFromSupabaseUrl,
  readEnvironmentConfig,
  resetEnvironmentCache,
  verifyEnvironment,
  type EnvironmentStatus,
} from "@/lib/environment";
import { EnvironmentBanner, TestPaymentNotice } from "@/components/environment-banner";

const TEST_REF = "abcdefghijklmnopqrst";
const liveUrl = `https://${LIVE_SUPABASE_PROJECT_REF}.supabase.co`;
const testUrl = `https://${TEST_REF}.supabase.co`;

function blocking(env: Record<string, string>) {
  return readEnvironmentConfig(env).issues.filter((i) => i.level === "block").map((i) => i.message);
}

function connected(environment: "test" | "live" | null, projectRef: string | null): EnvironmentStatus["database"] {
  return {
    provider: "Supabase",
    status: "connected",
    marker: environment ? { environment, projectRef, label: environment.toUpperCase() } : null,
    checkedAt: "2026-11-18T00:00:00.000Z",
    lastSuccessAt: "2026-11-18T00:00:00.000Z",
  };
}

describe("environment configuration", () => {
  it("reads project refs only from real Supabase hosts", () => {
    expect(projectRefFromSupabaseUrl(testUrl)).toBe(TEST_REF);
    expect(projectRefFromSupabaseUrl("https://example.com")).toBeNull();
    expect(projectRefFromSupabaseUrl(`https://${TEST_REF}.supabase.co.evil.com`)).toBeNull();
    expect(projectRefFromSupabaseUrl(undefined)).toBeNull();
  });

  it("defaults local development to TEST and refuses the LIVE database there", () => {
    const config = readEnvironmentConfig({ NEXT_PUBLIC_SUPABASE_URL: liveUrl });
    expect(config.environment).toBe("test");
    expect(config.inferred).toBe(true);
    expect(blocking({ NEXT_PUBLIC_SUPABASE_URL: liveUrl })).toContain(
      "TEST must never use the production Supabase project.",
    );
  });

  it("infers LIVE only for a Vercel production deployment of the production project", () => {
    const env = { VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: liveUrl, SUPABASE_URL: liveUrl };
    expect(readEnvironmentConfig(env).environment).toBe("live");
    expect(blocking(env)).toEqual([]);
    expect(readEnvironmentConfig({ ...env, VERCEL_ENV: "preview" }).environment).toBe("test");
  });

  it("LIVE cannot use another project; TEST cannot use production", () => {
    expect(blocking({ APP_ENVIRONMENT: "live", SUPABASE_URL: testUrl, NEXT_PUBLIC_SUPABASE_URL: testUrl })).toContain(
      "LIVE must use the production Supabase project.",
    );
    expect(blocking({ APP_ENVIRONMENT: "test", SUPABASE_URL: liveUrl, NEXT_PUBLIC_SUPABASE_URL: testUrl })).toEqual(
      expect.arrayContaining(["TEST must never use the production Supabase project."]),
    );
    expect(blocking({ APP_ENVIRONMENT: "test", SUPABASE_URL: testUrl, NEXT_PUBLIC_SUPABASE_URL: testUrl })).toEqual([]);
  });

  it("refuses mismatched server and browser projects", () => {
    expect(
      blocking({ APP_ENVIRONMENT: "test", SUPABASE_URL: testUrl, NEXT_PUBLIC_SUPABASE_URL: "https://zyxwvutsrqponmlkjihg.supabase.co" }),
    ).toContain("The server and browser Supabase URLs point at different projects.");
  });

  it("pins TEST to the expected TEST project when configured", () => {
    expect(
      blocking({ APP_ENVIRONMENT: "test", NEXT_PUBLIC_SUPABASE_URL: testUrl, TEST_SUPABASE_PROJECT_REF: "zyxwvutsrqponmlkjihg" }),
    ).toContain("TEST is not using the expected TEST Supabase project.");
  });

  it("TEST refuses live payment keys", () => {
    expect(blocking({ APP_ENVIRONMENT: "test", NEXT_PUBLIC_SUPABASE_URL: testUrl, YOCO_SECRET_KEY: "sk_live_x" })).toContain(
      "TEST refuses live Yoco keys.",
    );
    const config = readEnvironmentConfig({ APP_ENVIRONMENT: "test", NEXT_PUBLIC_SUPABASE_URL: testUrl, YOCO_SECRET_KEY: "sk_test_x" });
    expect(config.paymentMode).toBe("test");
    expect(config.issues).toEqual([]);
  });

  it("LIVE warns about test keys until YOCO_REQUIRE_LIVE_KEYS is switched on", () => {
    const base = { APP_ENVIRONMENT: "live", NEXT_PUBLIC_SUPABASE_URL: liveUrl, YOCO_SECRET_KEY: "sk_test_x" };
    expect(blocking(base)).toEqual([]);
    expect(readEnvironmentConfig(base).issues[0]?.level).toBe("warn");
    expect(blocking({ ...base, YOCO_REQUIRE_LIVE_KEYS: "true" })).toContain(
      "LIVE refuses Yoco test keys (YOCO_REQUIRE_LIVE_KEYS=true).",
    );
    expect(blocking({ ...base, YOCO_SECRET_KEY: "sk_live_x", YOCO_REQUIRE_LIVE_KEYS: "true" })).toEqual([]);
  });

  it("an invalid APP_ENVIRONMENT blocks", () => {
    expect(blocking({ APP_ENVIRONMENT: "production", NEXT_PUBLIC_SUPABASE_URL: testUrl })).toContain(
      "APP_ENVIRONMENT must be 'test' or 'live'.",
    );
  });
});

describe("database marker", () => {
  const testConfig = readEnvironmentConfig({ APP_ENVIRONMENT: "test", NEXT_PUBLIC_SUPABASE_URL: testUrl });
  const liveConfig = readEnvironmentConfig({ APP_ENVIRONMENT: "live", NEXT_PUBLIC_SUPABASE_URL: liveUrl });

  it("passes when the marker matches", () => {
    expect(combineWithMarker(testConfig, connected("test", TEST_REF)).ok).toBe(true);
    expect(combineWithMarker(liveConfig, connected("live", LIVE_SUPABASE_PROJECT_REF)).ok).toBe(true);
  });

  it("blocks when TEST points at a database marked LIVE, and the reverse", () => {
    expect(combineWithMarker(testConfig, connected("live", TEST_REF)).ok).toBe(false);
    expect(combineWithMarker(liveConfig, connected("test", LIVE_SUPABASE_PROJECT_REF)).ok).toBe(false);
  });

  it("an unmarked TEST database blocks; an unmarked LIVE database only warns", () => {
    expect(combineWithMarker(testConfig, connected(null, null)).ok).toBe(false);
    const live = combineWithMarker(liveConfig, connected(null, null));
    expect(live.ok).toBe(true);
    expect(live.issues.map((i) => i.message)).toContain("The LIVE database is not marked as LIVE yet.");
  });

  it("blocks a marker from another project and an unreachable database", () => {
    expect(combineWithMarker(testConfig, connected("test", "zyxwvutsrqponmlkjihg")).ok).toBe(false);
    expect(
      combineWithMarker(testConfig, { ...connected(null, null), status: "error", lastSuccessAt: null }).ok,
    ).toBe(false);
  });
});

describe("verifyEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvironmentCache();
  });

  function clientReturning(result: { data: unknown; error: unknown }) {
    const maybeSingle = vi.fn().mockResolvedValue(result);
    return { from: () => ({ select: () => ({ maybeSingle }) }) } as never;
  }

  it("reads the marker and caches the result", async () => {
    vi.stubEnv("APP_ENVIRONMENT", "test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", testUrl);
    vi.stubEnv("SUPABASE_URL", testUrl);
    vi.stubEnv("YOCO_SECRET_KEY", "sk_test_x");
    const factory = vi.fn(() => clientReturning({ data: { environment: "test", project_ref: TEST_REF, label: "TEST" }, error: null }));
    const first = await verifyEnvironment(factory);
    expect(first.ok).toBe(true);
    expect(first.database.marker?.environment).toBe("test");
    await verifyEnvironment(factory);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("treats a missing marker table as an unmarked database", async () => {
    vi.stubEnv("APP_ENVIRONMENT", "live");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", liveUrl);
    vi.stubEnv("SUPABASE_URL", liveUrl);
    const status = await verifyEnvironment(() => clientReturning({ data: null, error: { code: "PGRST205" } }));
    expect(status.database.status).toBe("connected");
    expect(status.ok).toBe(true);
  });
});

describe("environment banner", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("shows the orange TEST MODE banner and payment notice on TEST", () => {
    vi.stubEnv("APP_ENVIRONMENT", "test");
    render(
      <>
        <EnvironmentBanner />
        <TestPaymentNotice />
      </>,
    );
    expect(screen.getByText("TEST MODE")).toBeInTheDocument();
    expect(screen.getByText(/Every account, order and payment here is a test record/)).toBeInTheDocument();
    expect(screen.getByText("TEST MODE payment.")).toBeInTheDocument();
  });

  it("shows nothing on LIVE", () => {
    vi.stubEnv("APP_ENVIRONMENT", "live");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", liveUrl);
    const { container } = render(
      <>
        <EnvironmentBanner />
        <TestPaymentNotice />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
