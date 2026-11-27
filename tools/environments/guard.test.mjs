import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_PROJECT_REF, assertCommandAllowed, assertNoTlsOverride, checkTarget, projectRefFromDbUrl, tlsOptions } from "./guard.mjs";

const TEST_REF = "abcdefghijklmnopqrst";

test("reads the ref from direct and pooler URLs", () => {
  assert.equal(projectRefFromDbUrl(`postgresql://postgres:x@db.${TEST_REF}.supabase.co:5432/postgres`), TEST_REF);
  assert.equal(
    projectRefFromDbUrl(`postgresql://postgres.${TEST_REF}:x@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`),
    TEST_REF,
  );
  assert.equal(projectRefFromDbUrl("postgresql://postgres:x@localhost:5432/postgres"), null);
  assert.equal(projectRefFromDbUrl(`postgresql://postgres.${TEST_REF}:x@evil.example.com/postgres`), null);
  assert.equal(projectRefFromDbUrl("not a url"), null);
});

test("TEST commands refuse the LIVE project, even if it is unmarked", () => {
  assert.throws(() => checkTarget({ env: "test", ref: LIVE_PROJECT_REF, marker: null, allowUnmarked: true }), /LIVE project/);
  assert.throws(() => checkTarget({ env: "test", ref: LIVE_PROJECT_REF, marker: "test" }), /LIVE project/);
});

test("TEST commands refuse a database marked LIVE and need a TEST marker", () => {
  assert.throws(() => checkTarget({ env: "test", ref: TEST_REF, marker: "live" }), /marked LIVE/);
  assert.throws(() => checkTarget({ env: "test", ref: TEST_REF, marker: null }), /not marked as TEST/);
  assert.doesNotThrow(() => checkTarget({ env: "test", ref: TEST_REF, marker: "test" }));
  assert.doesNotThrow(() => checkTarget({ env: "test", ref: TEST_REF, marker: null, allowUnmarked: true }));
});

test("LIVE needs the production ref, typed confirmation and a LIVE marker", () => {
  assert.throws(() => checkTarget({ env: "live", ref: TEST_REF, marker: "live", confirmLive: TEST_REF }), /only accepts/);
  assert.throws(() => checkTarget({ env: "live", ref: LIVE_PROJECT_REF, marker: "live" }), /confirm-live/);
  assert.throws(
    () => checkTarget({ env: "live", ref: LIVE_PROJECT_REF, marker: "test", confirmLive: LIVE_PROJECT_REF }),
    /marked TEST/,
  );
  assert.throws(
    () => checkTarget({ env: "live", ref: LIVE_PROJECT_REF, marker: null, confirmLive: LIVE_PROJECT_REF }),
    /not marked LIVE/,
  );
  assert.doesNotThrow(() =>
    checkTarget({ env: "live", ref: LIVE_PROJECT_REF, marker: "live", confirmLive: LIVE_PROJECT_REF }),
  );
});

test("destructive commands are TEST-only", () => {
  for (const command of ["init-test", "reset-test", "seed-test", "refresh-test", "mark-test"]) {
    assert.throws(() => assertCommandAllowed(command, "live"), /only runs against TEST/);
    assert.doesNotThrow(() => assertCommandAllowed(command, "test"));
  }
  assert.doesNotThrow(() => assertCommandAllowed("migrate", "live"));
});

test("an unknown environment is refused", () => {
  assert.throws(() => checkTarget({ env: "prod", ref: TEST_REF, marker: "test" }), /Choose an environment/);
});

test("TLS always verifies the server certificate and has no unverified fallback (SA-001)", () => {
  const ca = ["-----BEGIN CERTIFICATE-----", "MIIB", "-----END CERTIFICATE-----", ""].join("\n");
  assert.deepEqual(tlsOptions(ca), { ca, rejectUnauthorized: true });
  for (const missing of [null, undefined, "", "not a certificate"]) {
    assert.throws(() => tlsOptions(missing), /PERIQ_DB_CA_FILE/);
  }
});

test("connection URLs cannot carry their own TLS settings (SA-001)", () => {
  const base = `postgresql://postgres.${TEST_REF}:x@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`;
  assert.doesNotThrow(() => assertNoTlsOverride(base));
  assert.doesNotThrow(() => assertNoTlsOverride(`${base}?application_name=x`));
  for (const query of ["sslmode=no-verify", "sslmode=disable", "ssl=false", "SSLMODE=require", "sslrootcert=/tmp/x.pem", "uselibpqcompat=true"]) {
    assert.throws(() => assertNoTlsOverride(`${base}?${query}`), /TLS is configured by PERIQ_DB_CA_FILE only/, query);
  }
});
