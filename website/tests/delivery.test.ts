// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeDrivingRoute, deliveryFeeFor, normalizeDeliveryAddress, quoteFromRow, routingDestination, type DeliveryQuote } from "../lib/delivery";

const db = vi.hoisted(() => ({
  rpc: {} as Record<string, { data: unknown; error: unknown }[]>,
  calls: [] as { name: string; args: unknown }[],
  settings: { data: { delivery_available: true, restaurant_address: "28 King Edward Rd, Bloemfontein, Free State 9301, South Africa" } as unknown, error: null as unknown },
  user: { id: "user-a" } as { id: string } | null,
}));
vi.mock("@/lib/supabase", () => ({
  readServerSupabaseConfig: () => ({ url: "https://example.supabase.co", serviceRoleKey: "test" }),
  createServiceClient: () => ({
    auth: { getUser: async () => ({ data: { user: db.user }, error: db.user ? null : { message: "bad" } }) },
    rpc: async (name: string, args: unknown) => {
      db.calls.push({ name, args });
      const queued = db.rpc[name]?.shift();
      if (queued) return queued;
      return name === "consume_rate_limit" ? { data: true, error: null } : { data: null, error: null };
    },
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) chain[m] = () => chain;
      chain.maybeSingle = async () => db.settings;
      return chain;
    },
  }),
}));
import { POST } from "../app/api/delivery/quote/route";

function quoteRow(km: number, fee: number, extra: Record<string, unknown> = {}) {
  return { id: "q-1", address: "12 Test Street, Bloemfontein", distance_km: km, duration_minutes: 9, delivery_fee: fee, base_fee: 15, price_per_km: 4, min_fee: 20, max_distance_km: 15, free_delivery_threshold: null, within_range: km <= 15, expires_at: "2026-11-17T14:00:00Z", ...extra };
}
function routesResponse(meters: number) {
  return new Response(JSON.stringify({ routes: [{ distanceMeters: meters, duration: "540s", legs: [{ endLocation: { latLng: { latitude: -29.1, longitude: 26.2 } } }] }] }));
}
function request(address: unknown, token: string | null = "tok") {
  return new Request("https://rastasperiq.co.za/api/delivery/quote/", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ address }),
  });
}

beforeEach(() => {
  db.rpc = {};
  db.calls = [];
  db.user = { id: "user-a" };
  db.settings = { data: { delivery_available: true, restaurant_address: "28 King Edward Rd, Bloemfontein, Free State 9301, South Africa" }, error: null };
  process.env.GOOGLE_ROUTES_API_KEY = "test-routes-key";
  vi.unstubAllGlobals();
});

describe("delivery helpers", () => {
  it("normalises addresses the same way as the database", () => {
    expect(normalizeDeliveryAddress("  12 MAIN road,   Heidedal ")).toBe("12 main road, heidedal");
  });
  it("adds the city and country only when missing", () => {
    expect(routingDestination("12 Main Rd, Heidedal")).toBe("12 Main Rd, Heidedal, Bloemfontein, Free State, South Africa");
    expect(routingDestination("5 Kellner St, Bloemfontein, South Africa")).toBe("5 Kellner St, Bloemfontein, South Africa");
  });
  it("applies the free-delivery threshold only when enabled", () => {
    const q = quoteFromRow(quoteRow(5, 35)) as DeliveryQuote;
    expect(deliveryFeeFor(q, 500)).toBe(35);
    expect(deliveryFeeFor({ ...q, freeDeliveryThreshold: 300 }, 299.99)).toBe(35);
    expect(deliveryFeeFor({ ...q, freeDeliveryThreshold: 300 }, 300)).toBe(0);
  });
  it("reads distance, duration and destination from the Routes response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(routesResponse(3270)) as unknown as typeof fetch;
    expect(await computeDrivingRoute("origin", "dest", "k", fetchImpl)).toEqual({ ok: true, distanceMeters: 3270, durationSeconds: 540, lat: -29.1, lng: 26.2 });
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ travelMode: "DRIVE", routingPreference: "TRAFFIC_UNAWARE", regionCode: "ZA" });
    expect((init.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe("routes.distanceMeters,routes.duration,routes.legs.endLocation");
  });
  it("treats an empty response as an unknown address and outages as unavailable", async () => {
    expect(await computeDrivingRoute("o", "d", "k", vi.fn().mockResolvedValue(new Response("{}")) as unknown as typeof fetch)).toEqual({ ok: false, reason: "not_found" });
    expect(await computeDrivingRoute("o", "d", "k", vi.fn().mockResolvedValue(new Response("x", { status: 500 })) as unknown as typeof fetch)).toEqual({ ok: false, reason: "unavailable" });
    expect(await computeDrivingRoute("o", "d", "k", vi.fn().mockResolvedValue(new Response("x", { status: 403 })) as unknown as typeof fetch)).toEqual({ ok: false, reason: "unavailable" });
    expect(await computeDrivingRoute("o", "d", "k", vi.fn().mockRejectedValue(new Error("timeout")) as unknown as typeof fetch)).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("POST /api/delivery/quote", () => {
  it("quotes the driving distance and records it for checkout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(routesResponse(3270));
    vi.stubGlobal("fetch", fetchMock);
    db.rpc.record_delivery_quote = [{ data: quoteRow(3.27, 28.08), error: null }];
    const res = await POST(request("12 Test Street, Bloemfontein"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ quoteId: "q-1", distanceKm: 3.27, deliveryFee: 28.08, withinRange: true });
    const rec = db.calls.find((c) => c.name === "record_delivery_quote")!.args as Record<string, unknown>;
    expect(rec).toMatchObject({ p_user_id: "user-a", p_address: "12 Test Street, Bloemfontein", p_distance_meters: 3270, p_duration_seconds: 540 });
    // The key goes only to Google, in a header; never in the response.
    expect(fetchMock.mock.calls[0][0]).toBe("https://routes.googleapis.com/directions/v2:computeRoutes");
    expect(JSON.stringify(await POST(request("12 Test Street, Bloemfontein")).then((r) => r.json()))).not.toContain("test-routes-key");
  });

  it("reuses a cached quote without calling the routing service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    db.rpc.find_delivery_quote = [{ data: quoteRow(5, 35), error: null }];
    const res = await POST(request("12 Test Street, Bloemfontein"));
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses addresses beyond the maximum distance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(routesResponse(18268)));
    db.rpc.record_delivery_quote = [{ data: quoteRow(18.27, 88.08), error: null }];
    const res = await POST(request("12 Main Road, Heidedal"));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "out_of_range", distanceKm: 18.27, maxDistanceKm: 15 });
  });

  it("reports unknown addresses without recording a quote", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    const res = await POST(request("qwzxv plkjh nowhere"));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("address_not_found");
    expect(db.calls.some((c) => c.name === "record_delivery_quote")).toBe(false);
  });

  it("fails closed when the routing service is down or the key is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("err", { status: 503 })));
    expect((await (await POST(request("12 Test Street, Bloemfontein"))).json()).code).toBe("routing_unavailable");
    delete process.env.GOOGLE_ROUTES_API_KEY;
    const res = await POST(request("12 Test Street, Bloemfontein"));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("routing_not_configured");
  });

  it("validates input, session, availability and rate limits", async () => {
    expect((await POST(request("short"))).status).toBe(400);
    expect((await POST(request("12 Test Street, Bloemfontein", null))).status).toBe(401);
    db.user = null;
    expect((await POST(request("12 Test Street, Bloemfontein"))).status).toBe(401);
    db.user = { id: "user-a" };
    db.settings = { data: { delivery_available: false, restaurant_address: "x" }, error: null };
    expect((await POST(request("12 Test Street, Bloemfontein"))).status).toBe(409);
    db.settings = { data: { delivery_available: true, restaurant_address: "28 King Edward Rd, Bloemfontein" }, error: null };
    db.rpc.consume_rate_limit = [{ data: false, error: null }]; // no IP header: only the per-user limit runs
    vi.stubGlobal("fetch", vi.fn());
    const limited = await POST(request("12 Test Street, Bloemfontein"));
    expect(limited.status).toBe(429);
  });
});
