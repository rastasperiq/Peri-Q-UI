// Distance-based delivery pricing shared by the checkout page and the
// /api/delivery/quote server route. The database decides the real fee
// (prepare_card_checkout); these helpers only display it.

export type DeliveryQuote = {
  quoteId: string;
  address: string;
  distanceKm: number;
  durationMinutes: number;
  deliveryFee: number;
  baseFee: number;
  pricePerKm: number;
  minFee: number;
  maxDistanceKm: number;
  freeDeliveryThreshold: number | null;
  withinRange: boolean;
  expiresAt: string;
};

export type DeliveryQuoteError = {
  error: string;
  code:
    | "bad_request"
    | "unauthorized"
    | "rate_limited"
    | "limiter_unavailable"
    | "delivery_unavailable"
    | "address_not_found"
    | "out_of_range"
    | "routing_unavailable"
    | "routing_not_configured";
  distanceKm?: number;
  maxDistanceKm?: number;
};

/** Same normalisation as public.normalize_delivery_address in the database. */
export function normalizeDeliveryAddress(address: string): string {
  return address.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Delivery fee for this cart: free above the threshold when one is set. */
export function deliveryFeeFor(quote: DeliveryQuote, itemsSubtotal: number): number {
  if (quote.freeDeliveryThreshold != null && itemsSubtotal >= quote.freeDeliveryThreshold) return 0;
  return quote.deliveryFee;
}

export function roundRand(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Map the database's snake_case quote JSON to the API response. */
export function quoteFromRow(row: Record<string, unknown>): DeliveryQuote {
  const threshold = row["free_delivery_threshold"];
  return {
    quoteId: String(row["id"] ?? ""),
    address: String(row["address"] ?? ""),
    distanceKm: Number(row["distance_km"] ?? 0),
    durationMinutes: Number(row["duration_minutes"] ?? 0),
    deliveryFee: Number(row["delivery_fee"] ?? 0),
    baseFee: Number(row["base_fee"] ?? 0),
    pricePerKm: Number(row["price_per_km"] ?? 0),
    minFee: Number(row["min_fee"] ?? 0),
    maxDistanceKm: Number(row["max_distance_km"] ?? 0),
    freeDeliveryThreshold: threshold == null ? null : Number(threshold),
    withinRange: row["within_range"] === true,
    expiresAt: String(row["expires_at"] ?? ""),
  };
}

/**
 * The address sent to the routing service. Customers often leave out the
 * city; adding it keeps "12 Main Rd" from resolving to another town.
 */
export function routingDestination(address: string): string {
  let value = address.trim().replace(/\s+/g, " ");
  if (!/bloemfontein|mangaung|free state/i.test(value)) value += ", Bloemfontein, Free State";
  if (!/south africa/i.test(value)) value += ", South Africa";
  return value;
}

export type RouteResult =
  | { ok: true; distanceMeters: number; durationSeconds: number; lat: number | null; lng: number | null }
  | { ok: false; reason: "not_found" | "unavailable" };

/**
 * Driving distance from the restaurant using the Google Routes API
 * (Compute Routes, Essentials: no live traffic). Server-only: the key must
 * never reach a browser or the app.
 */
export async function computeDrivingRoute(
  origin: string,
  destination: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RouteResult> {
  let res: Response;
  try {
    res = await fetchImpl("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.legs.endLocation",
      },
      body: JSON.stringify({
        origin: { address: origin },
        destination: { address: destination },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
        regionCode: "ZA",
        languageCode: "en-ZA",
        units: "METRIC",
      }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (res.status === 400 || res.status === 404) return { ok: false, reason: "not_found" };
  if (!res.ok) return { ok: false, reason: "unavailable" };
  const body = (await res.json().catch(() => null)) as {
    routes?: { distanceMeters?: number; duration?: string; legs?: { endLocation?: { latLng?: { latitude?: number; longitude?: number } } }[] }[];
  } | null;
  const route = body?.routes?.[0];
  if (!route) return { ok: false, reason: "not_found" };
  const distanceMeters = Number(route.distanceMeters ?? 0);
  const durationSeconds = Number.parseInt(String(route.duration ?? "0").replace(/s$/, ""), 10) || 0;
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return { ok: false, reason: "unavailable" };
  const latLng = route.legs?.[0]?.endLocation?.latLng;
  return {
    ok: true,
    distanceMeters: Math.round(distanceMeters),
    durationSeconds,
    lat: typeof latLng?.latitude === "number" ? latLng.latitude : null,
    lng: typeof latLng?.longitude === "number" ? latLng.longitude : null,
  };
}
