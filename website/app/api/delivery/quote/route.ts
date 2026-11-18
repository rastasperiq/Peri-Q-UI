import { NextResponse } from "next/server";
import { createServiceClient, readServerSupabaseConfig } from "@/lib/supabase";
import { environmentBlock } from "@/lib/environment-guard";
import { allowRequest, clientIp, DELIVERY_QUOTE_LIMITS, ipBucket } from "@/lib/rate-limit";
import { computeDrivingRoute, quoteFromRow, routingDestination, type DeliveryQuoteError } from "@/lib/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, body: DeliveryQuoteError, headers?: Record<string, string>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/** Server-side Google Routes key. Never NEXT_PUBLIC_: it must stay on the server. */
function routesApiKey(): string | null {
  const key = (process.env.GOOGLE_ROUTES_API_KEY ?? "").trim();
  return key ? key : null;
}

// POST { address } with the customer's session token.
// Returns the driving distance and delivery fee, recorded as a quote that
// checkout must present. The fee itself is recalculated by the database.
export async function POST(req: Request) {
  if (!readServerSupabaseConfig()) {
    return fail(503, { error: "Delivery pricing is temporarily unavailable. Please try again later.", code: "routing_not_configured" });
  }
  const blocked = await environmentBlock();
  if (blocked) return blocked;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, { error: "Enter your delivery address.", code: "bad_request" });
  }
  const raw = (body as { address?: unknown })?.address;
  const address = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (address.length < 8 || address.length > 300) {
    return fail(400, { error: "Enter a full delivery address (house number, street and area).", code: "bad_request" });
  }
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return fail(401, { error: "Your session has expired. Please refresh and try again.", code: "unauthorized" });

  const svc = createServiceClient();
  const ip = clientIp(req);
  const serviceKey = readServerSupabaseConfig()!.serviceRoleKey;
  if (ip && !(await allowRequest(svc, { bucket: ipBucket("delivery-quote", ip, serviceKey), ...DELIVERY_QUOTE_LIMITS.perIp }))) {
    return fail(429, { error: "Too many address checks. Please wait a few minutes and try again.", code: "rate_limited" }, { "Retry-After": String(DELIVERY_QUOTE_LIMITS.perIp.windowSeconds) });
  }
  const { data: auth, error: authError } = await svc.auth.getUser(token);
  if (authError || !auth.user) return fail(401, { error: "Your session has expired. Please refresh and try again.", code: "unauthorized" });
  const userId = auth.user.id;

  const { data: settings, error: settingsError } = await svc
    .from("app_settings")
    .select("delivery_available,restaurant_address")
    .eq("id", "default")
    .maybeSingle();
  if (settingsError || !settings) {
    return fail(503, { error: "Delivery pricing is temporarily unavailable. Please try again or choose pickup.", code: "routing_unavailable" });
  }
  if (!settings.delivery_available) {
    return fail(409, { error: "Delivery is unavailable right now. Please choose pickup.", code: "delivery_unavailable" });
  }

  // Reuse a recent quote for the same address: no second routing call.
  const cached = await svc.rpc("find_delivery_quote", { p_user_id: userId, p_address: address });
  if (!cached.error && cached.data) return respond(quoteFromRow(cached.data as Record<string, unknown>));

  const key = routesApiKey();
  if (!key) {
    console.error("GOOGLE_ROUTES_API_KEY is not set");
    return fail(503, { error: "Delivery pricing is temporarily unavailable. Please try again later or choose pickup.", code: "routing_not_configured" });
  }
  if (!(await allowRequest(svc, { bucket: `delivery-quote:user:${userId}`, ...DELIVERY_QUOTE_LIMITS.perUser }))) {
    return fail(429, { error: "Too many address checks. Please wait a few minutes and try again.", code: "rate_limited" }, { "Retry-After": String(DELIVERY_QUOTE_LIMITS.perUser.windowSeconds) });
  }

  const route = await computeDrivingRoute(String(settings.restaurant_address), routingDestination(address), key);
  if (!route.ok) {
    if (route.reason === "not_found") {
      return fail(422, { error: "We couldn't find that address. Add the house number, street and suburb, then try again.", code: "address_not_found" });
    }
    return fail(503, { error: "We couldn't calculate the delivery fee right now. Please try again in a moment or choose pickup.", code: "routing_unavailable" });
  }

  const recorded = await svc.rpc("record_delivery_quote", {
    p_user_id: userId,
    p_address: address,
    p_distance_meters: route.distanceMeters,
    p_duration_seconds: route.durationSeconds,
    p_destination_lat: route.lat,
    p_destination_lng: route.lng,
  });
  if (recorded.error || !recorded.data) {
    console.error("record_delivery_quote failed", recorded.error?.message);
    return fail(503, { error: "We couldn't calculate the delivery fee right now. Please try again in a moment or choose pickup.", code: "routing_unavailable" });
  }
  return respond(quoteFromRow(recorded.data as Record<string, unknown>));
}

function respond(quote: ReturnType<typeof quoteFromRow>) {
  if (!quote.withinRange) {
    return fail(422, {
      error: `Sorry, that address is ${quote.distanceKm.toFixed(1)} km away. We deliver up to ${quote.maxDistanceKm.toFixed(0)} km from the restaurant. You can still choose pickup.`,
      code: "out_of_range",
      distanceKm: quote.distanceKm,
      maxDistanceKm: quote.maxDistanceKm,
    });
  }
  return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
}
