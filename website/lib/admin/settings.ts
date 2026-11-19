"use client";
// Store settings and Today's Special: the single app_settings row "default".

import { createBrowserClient } from "../supabase";

export type AdminSettings = {
  storeOpen: boolean;
  pickupAvailable: boolean;
  deliveryAvailable: boolean;
  deliveryBaseFee: number;
  deliveryPricePerKm: number;
  deliveryMinFee: number;
  deliveryMaxDistanceKm: number;
  deliveryFreeThreshold: number | null;
  openingTime: string;
  closingTime: string;
  specialEnabled: boolean;
  specialLabel: string;
  specialTitle: string;
  specialSubtitle: string;
  specialImagePath: string;
  specialMenuItemId: string | null;
};

const COLUMNS =
  "store_open,pickup_available,delivery_available,delivery_base_fee,delivery_price_per_km,delivery_min_fee,delivery_max_distance_km,delivery_free_threshold,opening_time,closing_time,todays_special_enabled,todays_special_label,todays_special_title,todays_special_subtitle,todays_special_image_path,todays_special_menu_item_id";

export function mapSettingsRow(row: Record<string, unknown>): AdminSettings {
  return {
    storeOpen: (row.store_open as boolean) ?? true,
    pickupAvailable: (row.pickup_available as boolean) ?? true,
    deliveryAvailable: (row.delivery_available as boolean) ?? true,
    deliveryBaseFee: Number(row.delivery_base_fee ?? 15),
    deliveryPricePerKm: Number(row.delivery_price_per_km ?? 4),
    deliveryMinFee: Number(row.delivery_min_fee ?? 20),
    deliveryMaxDistanceKm: Number(row.delivery_max_distance_km ?? 15),
    deliveryFreeThreshold: row.delivery_free_threshold == null ? null : Number(row.delivery_free_threshold),
    openingTime: String(row.opening_time ?? "10:00"),
    closingTime: String(row.closing_time ?? "21:00"),
    specialEnabled: (row.todays_special_enabled as boolean) ?? true,
    specialLabel: String(row.todays_special_label ?? ""),
    specialTitle: String(row.todays_special_title ?? ""),
    specialSubtitle: String(row.todays_special_subtitle ?? ""),
    specialImagePath: String(row.todays_special_image_path ?? ""),
    specialMenuItemId: (row.todays_special_menu_item_id as string | null) ?? null,
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const fee = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1000;

/** Mirrors app_settings_delivery_pricing_check so mistakes are caught before saving. */
export function validateSettings(s: AdminSettings): string | null {
  if (!fee(s.deliveryBaseFee) || !fee(s.deliveryPricePerKm) || !fee(s.deliveryMinFee)) return "Delivery fees must be between R0 and R1000.";
  if (!Number.isFinite(s.deliveryMaxDistanceKm) || s.deliveryMaxDistanceKm <= 0 || s.deliveryMaxDistanceKm > 100) return "Maximum delivery distance must be more than 0 and at most 100 km.";
  if (s.deliveryFreeThreshold !== null && (!Number.isFinite(s.deliveryFreeThreshold) || s.deliveryFreeThreshold < 0 || s.deliveryFreeThreshold > 100000)) return "The free-delivery amount must be between R0 and R100000.";
  if (!TIME.test(s.openingTime) || !TIME.test(s.closingTime)) return "Enter opening and closing times as HH:MM, for example 10:00.";
  if (!s.specialLabel.trim()) return "Enter a promo label.";
  if (!s.specialTitle.trim()) return "Enter the headline text.";
  if (!s.specialSubtitle.trim()) return "Enter the supporting text.";
  if (!s.specialImagePath.trim()) return "Choose an image for Today's Special.";
  return null;
}

export function settingsToRow(s: AdminSettings) {
  return {
    id: "default",
    store_open: s.storeOpen,
    pickup_available: s.pickupAvailable,
    delivery_available: s.deliveryAvailable,
    delivery_base_fee: s.deliveryBaseFee,
    delivery_price_per_km: s.deliveryPricePerKm,
    delivery_min_fee: s.deliveryMinFee,
    delivery_max_distance_km: s.deliveryMaxDistanceKm,
    delivery_free_threshold: s.deliveryFreeThreshold,
    opening_time: s.openingTime,
    closing_time: s.closingTime,
    todays_special_enabled: s.specialEnabled,
    todays_special_label: s.specialLabel.trim(),
    todays_special_title: s.specialTitle.trim(),
    todays_special_subtitle: s.specialSubtitle.trim(),
    todays_special_image_path: s.specialImagePath.trim(),
    todays_special_menu_item_id: s.specialMenuItemId || null,
  };
}

export async function fetchAdminSettings(): Promise<AdminSettings> {
  const { data, error } = await createBrowserClient().from("app_settings").select(COLUMNS).eq("id", "default").maybeSingle();
  if (error || !data) throw new Error("Could not load the store settings. Please try again.");
  return mapSettingsRow(data as Record<string, unknown>);
}

export async function saveAdminSettings(s: AdminSettings): Promise<void> {
  const invalid = validateSettings(s);
  if (invalid) throw new Error(invalid);
  const fields: Partial<ReturnType<typeof settingsToRow>> = settingsToRow(s);
  delete fields.id;
  const { data, error } = await createBrowserClient().from("app_settings").update(fields).eq("id", "default").select("id").maybeSingle();
  if (error || !data) throw new Error("The settings were not saved. Check that your account has admin access and try again.");
}
