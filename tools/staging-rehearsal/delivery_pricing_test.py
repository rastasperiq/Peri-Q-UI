#!/usr/bin/env python3
"""Rehearsal for 20261117120000_distance_delivery_pricing.sql.

Run on a disposable database built from stub.sql + schema.sql + seed.sql with
the migration applied (see README). No network or routing calls: quotes are
recorded with fixed distances, exactly as the website server would after
calling the routing service.

    REHEARSAL_DSN="host=... user=postgres dbname=..." python3 delivery_pricing_test.py
"""
import json
import os
import sys
import traceback
import uuid
from decimal import Decimal

import psycopg

DSN = os.environ.get("REHEARSAL_DSN", "host=/tmp/pg user=postgres dbname=periq")
ALICE = "11111111-1111-1111-1111-111111111111"
BOB = "22222222-2222-2222-2222-222222222222"
ADDRESS = "12 Main Road, Heidedal, Bloemfontein"
ITEMS = json.dumps([{"menu_item_id": "kota-1", "quantity": 1, "spice_level": "Hot", "notes": ""}])  # R45
results = []


def connect():
    return psycopg.connect(DSN, autocommit=False)


def as_user(cur, uid):
    cur.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": uid, "role": "authenticated"}),))
    cur.execute("set local role authenticated")


def as_service(cur):
    cur.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"role": "service_role"}),))
    cur.execute("set local role service_role")


def reset_settings(cur, **overrides):
    values = dict(delivery_base_fee=15, delivery_price_per_km=4, delivery_min_fee=20,
                  delivery_max_distance_km=15, delivery_free_threshold=None,
                  store_open=True, delivery_available=True, opening_time="00:00", closing_time="23:59")
    values.update(overrides)
    sets = ", ".join(f"{k} = %s" for k in values)
    cur.execute(f"update public.app_settings set {sets} where id = 'default'", list(values.values()))


def quote(cur, uid, meters, address=ADDRESS):
    cur.execute("reset role")
    as_service(cur)
    cur.execute("select public.record_delivery_quote(%s, %s, %s, %s, %s, %s)", (uid, address, meters, 600, -29.1, 26.2))
    out = cur.fetchone()[0]
    cur.execute("reset role")
    return out


def prepare(cur, uid, expected, quote_id, address=ADDRESS, order_type="delivery", request_id=None):
    cur.execute("reset role")
    as_user(cur, uid)
    cur.execute(
        "select public.prepare_card_checkout(%s,%s,%s,'yoco',%s,%s::numeric,%s,%s::jsonb,%s::uuid)",
        ("Alice Test", "0712345678", order_type, address, expected, request_id or f"req-{uuid.uuid4()}", ITEMS, quote_id),
    )
    out = cur.fetchone()[0]
    cur.execute("reset role")
    return out


def check(name):
    def wrap(fn):
        conn = connect()
        try:
            with conn.cursor() as cur:
                reset_settings(cur)
                fn(cur)
            results.append((name, True, ""))
        except Exception as e:  # noqa: BLE001
            results.append((name, False, f"{e}\n{traceback.format_exc(limit=2)}"))
        finally:
            conn.rollback()
            conn.close()
        return fn
    return wrap


def refused(cur, fn, contains):
    cur.execute("savepoint s")
    try:
        fn()
    except psycopg.Error as e:
        cur.execute("rollback to savepoint s")
        assert contains.lower() in str(e).lower(), f"wrong error: {e}"
        return
    raise AssertionError("was allowed")


# Fee table from the brief: R15 + km x R4, minimum R20.
CASES = [(1000, "1.00", "20.00"), (3000, "3.00", "27.00"), (5000, "5.00", "35.00"),
         (10000, "10.00", "55.00"), (15000, "15.00", "75.00"), (3270, "3.27", "28.08"), (0, "0.00", "20.00")]

for meters, km, fee in CASES:
    @check(f"{km} km -> R{fee} quoted, charged and snapshotted")
    def _(cur, meters=meters, km=km, fee=fee):
        q = quote(cur, ALICE, meters)
        assert q["distance_km"] == float(km) and Decimal(str(q["delivery_fee"])) == Decimal(fee), q
        assert q["within_range"] is True
        total = Decimal("45.00") + Decimal(fee)
        draft = prepare(cur, ALICE, total, q["id"])
        cur.execute("select total_price, delivery_fee, delivery_distance_km, delivery_quote_id::text, payment_amount_cents, delivery_pricing from public.checkout_intents where id = %s", (draft["id"],))
        tp, df, dk, qid, cents, pricing = cur.fetchone()
        assert tp == total and df == Decimal(fee) and dk == Decimal(km) and qid == q["id"], (tp, df, dk)
        assert cents == int(total * 100)
        assert pricing["base_fee"] == 15 and pricing["price_per_km"] == 4 and pricing["min_fee"] == 20


@check("minimum fee applies below 1.25 km")
def _(cur):
    q = quote(cur, ALICE, 1240)
    assert Decimal(str(q["delivery_fee"])) == Decimal("20.00"), q


@check("15.01 km is outside the area and cannot be checked out")
def _(cur):
    q = quote(cur, ALICE, 15010)
    assert q["within_range"] is False
    refused(cur, lambda: prepare(cur, ALICE, Decimal("45") + Decimal(str(q["delivery_fee"])), q["id"]), "outside the delivery area")


@check("manipulated total (old R30 flat fee) is rejected")
def _(cur):
    q = quote(cur, ALICE, 10000)  # true fee R55
    refused(cur, lambda: prepare(cur, ALICE, Decimal("75.00"), q["id"]), "price changed")


@check("delivery without a quote is rejected")
def _(cur):
    refused(cur, lambda: prepare(cur, ALICE, Decimal("65.00"), None), "needs recalculating")


@check("another customer's quote is rejected")
def _(cur):
    q = quote(cur, BOB, 1000)
    refused(cur, lambda: prepare(cur, ALICE, Decimal("65.00"), q["id"]), "needs recalculating")


@check("changed address invalidates the quote; spacing/case changes do not")
def _(cur):
    q = quote(cur, ALICE, 3000)
    refused(cur, lambda: prepare(cur, ALICE, Decimal("72.00"), q["id"], address="99 Other Street, Bloemfontein"), "needs recalculating")
    prepare(cur, ALICE, Decimal("72.00"), q["id"], address="  12 MAIN road,   Heidedal, Bloemfontein ")


@check("expired quote is rejected")
def _(cur):
    q = quote(cur, ALICE, 3000)
    cur.execute("update public.delivery_quotes set expires_at = now() - interval '1 minute' where id = %s", (q["id"],))
    refused(cur, lambda: prepare(cur, ALICE, Decimal("72.00"), q["id"]), "needs recalculating")


@check("admin price change after quoting: server uses new settings, old total refused")
def _(cur):
    q = quote(cur, ALICE, 5000)  # R35 at R4/km
    reset_settings(cur, delivery_price_per_km=5)  # now R40
    refused(cur, lambda: prepare(cur, ALICE, Decimal("80.00"), q["id"]), "price changed")
    prepare(cur, ALICE, Decimal("85.00"), q["id"])


@check("lowering max distance after quoting is enforced at checkout")
def _(cur):
    q = quote(cur, ALICE, 12000)
    reset_settings(cur, delivery_max_distance_km=10)
    refused(cur, lambda: prepare(cur, ALICE, Decimal("108.00"), q["id"]), "outside the delivery area")


@check("free delivery threshold (when enabled) makes delivery R0")
def _(cur):
    reset_settings(cur, delivery_free_threshold=40)
    q = quote(cur, ALICE, 5000)
    d = prepare(cur, ALICE, Decimal("45.00"), q["id"])
    cur.execute("select delivery_fee, delivery_pricing->>'free_delivery_applied' from public.checkout_intents where id = %s", (d["id"],))
    assert cur.fetchone() == (Decimal("0.00"), "true")


@check("free threshold disabled by default (null)")
def _(cur):
    cur.execute("select delivery_free_threshold from public.app_settings where id = 'default'")
    assert cur.fetchone()[0] is None


@check("pickup ignores delivery quotes and still works with the 8 old arguments")
def _(cur):
    cur.execute("reset role")
    as_user(cur, ALICE)
    cur.execute("select public.prepare_card_checkout(p_customer_name=>'Alice Test',p_customer_phone=>'0712345678',p_order_type=>'pickup',p_payment_method=>'yoco',p_delivery_address=>null,p_expected_total=>45::numeric,p_client_request_id=>'req-pickup-0001',p_items=>%s::jsonb)", (ITEMS,))
    d = cur.fetchone()[0]
    cur.execute("reset role")
    cur.execute("select delivery_fee, total_price from public.checkout_intents where id = %s", (d["id"],))
    assert cur.fetchone() == (None, Decimal("45.00"))


@check("customers cannot read, write or forge quotes")
def _(cur):
    as_user(cur, ALICE)
    refused(cur, lambda: cur.execute("select * from public.delivery_quotes"), "permission denied")
    refused(cur, lambda: cur.execute("insert into public.delivery_quotes (user_id,address,address_key,distance_meters,distance_km) values (%s,'12 Main Road x','x',0,0)", (ALICE,)), "permission denied")
    refused(cur, lambda: cur.execute("select public.record_delivery_quote(%s,'12 Main Road, Bloemfontein',0,0,null,null)", (ALICE,)), "permission denied")
    refused(cur, lambda: cur.execute("select public.find_delivery_quote(%s,'12 Main Road, Bloemfontein')", (ALICE,)), "permission denied")


@check("find_delivery_quote reuses a fresh quote and recomputes fee from current settings")
def _(cur):
    q = quote(cur, ALICE, 3000)
    reset_settings(cur, delivery_base_fee=10)
    as_service(cur)
    cur.execute("select public.find_delivery_quote(%s, %s)", (ALICE, " 12 main road, heidedal, bloemfontein"))
    found = cur.fetchone()[0]
    assert found["id"] == q["id"] and Decimal(str(found["delivery_fee"])) == Decimal("22.00"), found


@check("paid checkout copies the delivery snapshot onto the order")
def _(cur):
    q = quote(cur, ALICE, 5000)
    d = prepare(cur, ALICE, Decimal("80.00"), q["id"])
    cur.execute("update public.checkout_intents set yoco_checkout_id='ch_test_1', yoco_mode='test' where id=%s", (d["id"],))
    as_service(cur)
    cur.execute("select public.finalize_card_checkout('ch_test_1','p_test_1',8000,'test')")
    cur.execute("select delivery_fee, delivery_distance_km, total_price, delivery_pricing->>'origin' from public.orders where id=%s", (d["id"],))
    assert cur.fetchone() == (Decimal("35.00"), Decimal("5.00"), Decimal("80.00"), "28 King Edward Rd, Bloemfontein, Free State 9301, South Africa")


@check("settings constraint rejects invalid pricing")
def _(cur):
    refused(cur, lambda: reset_settings(cur, delivery_max_distance_km=0), "app_settings_delivery_pricing_check")
    refused(cur, lambda: reset_settings(cur, delivery_price_per_km=-1), "app_settings_delivery_pricing_check")


passed = sum(1 for _, ok, _ in results if ok)
for name, ok, err in results:
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "\n   " + err))
print(f"{passed} passed, {len(results) - passed} failed")
sys.exit(0 if passed == len(results) else 1)
