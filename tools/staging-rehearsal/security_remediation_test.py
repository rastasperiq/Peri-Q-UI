"""Database checks for the November 2026 security-audit remediation:
SA-002 (checkout draft quotas and request bounds), SA-008 (current policy
acceptance required for payment) and SA-012 (unmarked databases refuse live
payments). Run against a throwaway database with stub.sql, the full schema.sql,
seed.sql and migrations/20261127120000_security_audit_remediation.sql.

    REHEARSAL_DSN="host=... user=... dbname=..." python3 security_remediation_test.py"""
import json
import os
import sys
import traceback
import uuid

import psycopg

DSN = os.environ.get("REHEARSAL_DSN", "host=localhost port=54329 user=postgres dbname=rehearsal connect_timeout=10")
ITEM = [{"menu_item_id": "kota-1", "quantity": 1}]
VERSION = "2026-11-03-draft"
results = []


def conn():
    # Supabase sessions run in UTC; created_at defaults to timezone('utc', now()),
    # which only reads back as "now" in a UTC session.
    return psycopg.connect(DSN, autocommit=False, options="-c timezone=UTC")


def claims(c, role, uid=None):
    payload = {"role": role}
    if uid:
        payload["sub"] = uid
    c.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps(payload),))
    c.execute(f"set local role {role}")


def one(c, sql, args=()):
    return c.execute(sql, args).fetchone()


def raises(c, sql, args=(), contains=None):
    c.execute("savepoint s")
    try:
        c.execute(sql, args)
    except psycopg.Error as e:
        c.execute("rollback to savepoint s")
        if contains and contains.lower() not in str(e).lower():
            raise AssertionError(f"wrong error: {e}") from e
        return
    c.execute("rollback to savepoint s")
    raise AssertionError(f"allowed: {sql[:80]}")


def new_user(c):
    uid = str(uuid.uuid4())
    c.execute("insert into auth.users (id, email, raw_user_meta_data) values (%s, %s, '{}'::jsonb)", (uid, f"{uid[:8]}@example.test"))
    return uid


PREPARE = "select public.prepare_card_checkout('Erin','0821234567','pickup','yoco',null,45::numeric,%s,%s::jsonb,null)"


def draft(c, request_id, items=ITEM):
    return one(c, PREPARE, (request_id, json.dumps(items)))[0]["id"]


def test(name):
    def deco(fn):
        results.append((name, fn))
        return fn
    return deco


@test("SA-002: one account cannot open more than 10 checkouts in 10 minutes, even calling the database directly")
def _(c):
    uid = new_user(c)
    claims(c, "authenticated", uid)
    first = draft(c, "req-quota-00")
    for i in range(1, 10):
        draft(c, f"req-quota-{i:02d}")
    raises(c, PREPARE, ("req-quota-10", json.dumps(ITEM)), contains="too many checkouts")
    assert draft(c, "req-quota-00") == first, "a retried request must still return its draft"


@test("SA-002: the daily cap counts older drafts too")
def _(c):
    uid = new_user(c)
    c.execute("""insert into public.checkout_intents (user_id, customer_name, customer_phone, order_type, payment_method,
                 total_price, status, estimated_minutes, client_request_id, payment_status, created_at)
                 select %s, 'Erin', '0821234567', 'pickup', 'yoco', 45, 'pending', 20, 'old-' || g, 'pending', now() - interval '2 hours'
                 from generate_series(1, 40) g""", (uid,))
    claims(c, "authenticated", uid)
    raises(c, PREPARE, ("req-daily-01", json.dumps(ITEM)), contains="too many checkouts")


@test("SA-002: oversized requests and add-on floods are refused before any work")
def _(c):
    claims(c, "authenticated", new_user(c))
    flood = [{"menu_item_id": "kota-1", "quantity": 1, "selected_add_ons": [{"name": "Cheese"}] * 21}]
    raises(c, PREPARE, ("req-addons-01", json.dumps(flood)), contains="too many add-ons")
    huge = [{"menu_item_id": "kota-1", "quantity": 1, "notes": "x" * 400, "selected_add_ons": [{"name": "y" * 2000}] * 20}] * 3
    raises(c, PREPARE, ("req-huge-01", json.dumps(huge)), contains="too large")
    assert one(c, "select count(*) from public.checkout_intents")[0] == 0, "a refused request left a draft"


@test("SA-008: only current policy versions can be accepted")
def _(c):
    claims(c, "authenticated", new_user(c))
    d = draft(c, "req-policy-01")
    raises(c, "select public.record_policy_acceptance('1999-old', 'checkout', 'website', %s)", (d,), contains="out of date")
    one(c, "select public.record_policy_acceptance(%s, 'checkout', 'website', %s)", (VERSION, d))


@test("SA-008: payment needs this caller's acceptance for this exact draft")
def _(c):
    alice, bob = new_user(c), new_user(c)
    claims(c, "authenticated", alice)
    accepted = draft(c, "req-accept-01")
    skipped = draft(c, "req-accept-02")
    one(c, "select public.record_policy_acceptance(%s, 'checkout', 'website', %s)", (VERSION, accepted))
    claims(c, "service_role")
    check = "select public.checkout_policy_accepted(%s, %s)"
    assert one(c, check, (alice, accepted))[0] is True
    assert one(c, check, (alice, skipped))[0] is False, "a draft without acceptance passed"
    assert one(c, check, (bob, accepted))[0] is False, "another user's acceptance counted"
    c.execute("reset role")
    c.execute("update public.policy_versions set accepting = false where version = %s", (VERSION,))
    claims(c, "service_role")
    assert one(c, check, (alice, accepted))[0] is False, "a retired version still counts"
    c.execute("reset role")
    c.execute("update public.policy_versions set accepting = true where version = %s", (VERSION,))


@test("SA-008: customers cannot run the payment check or change the version list")
def _(c):
    assert one(c, "select has_function_privilege('authenticated', 'public.checkout_policy_accepted(uuid,uuid)', 'execute')")[0] is False
    assert one(c, "select has_function_privilege('anon', 'public.checkout_policy_accepted(uuid,uuid)', 'execute')")[0] is False
    claims(c, "authenticated", new_user(c))
    raises(c, "insert into public.policy_versions (version) values ('my-own-terms')")
    raises(c, "update public.policy_versions set accepting = true")


@test("SA-012: an unmarked database refuses live-mode payments but still allows test mode")
def _(c):
    c.execute("delete from public.app_environment")
    claims(c, "authenticated", new_user(c))
    d = draft(c, "req-mode-01")
    claims(c, "service_role")
    raises(c, "update public.checkout_intents set yoco_mode = 'live' where id = %s", (d,), contains="not marked live")
    c.execute("update public.checkout_intents set yoco_mode = 'test' where id = %s", (d,))


def run():
    passed = failed = 0
    for name, fn in results:
        c = conn()
        try:
            fn(c)
            c.rollback()  # every test leaves the database as it found it
            print(f"PASS  {name}")
            passed += 1
        except Exception as e:  # noqa: BLE001 - report every failure and keep going
            c.rollback()
            print(f"FAIL  {name}: {type(e).__name__}: {e}")
            traceback.print_exc()
            failed += 1
        finally:
            c.close()
    print(f"\n{passed} passed, {failed} failed, {len(results)} total")
    return failed


if __name__ == "__main__":
    sys.exit(1 if run() else 0)
