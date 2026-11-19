"use client";
// Admin menu and category writes, matching the app's table calls and ids.

import { createBrowserClient, readPublicSupabaseConfig } from "../supabase";
import { mapCategoryRow, type MenuCategory } from "../menu";

export type AdminMenuItem = {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  /** Raw stored value: an https URL, a `menu/...` storage path or an app asset path. */
  imagePath: string;
  isAvailable: boolean;
  prepMinutes: number;
  spiceLevels: string[];
  addOns: { name: string; price: number }[];
};

export const DEFAULT_SPICE_LEVELS = ["Mild", "Medium", "Hot", "Extra Hot"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function mapAdminItem(row: Record<string, unknown>): AdminMenuItem {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    price: Number(row.price ?? 0),
    category: String(row.category ?? ""),
    imagePath: String(row.image_path ?? ""),
    isAvailable: (row.is_available as boolean) ?? true,
    prepMinutes: Number(row.prep_minutes ?? 25),
    spiceLevels: Array.isArray(row.spice_levels) ? (row.spice_levels as string[]) : DEFAULT_SPICE_LEVELS,
    addOns: (Array.isArray(row.add_ons) ? (row.add_ons as Record<string, unknown>[]) : [])
      .map((addOn) => ({ name: String(addOn?.name ?? ""), price: Number(addOn?.price ?? 0) })),
  };
}

export function itemToRow(item: AdminMenuItem) {
  return {
    id: item.id,
    name: item.name.trim(),
    description: item.description.trim(),
    price: item.price,
    category: item.category,
    image_path: item.imagePath.trim(),
    is_available: item.isAvailable,
    prep_minutes: item.prepMinutes,
    spice_levels: item.spiceLevels,
    add_ons: item.addOns.filter((addOn) => addOn.name.trim()).map((addOn) => ({ name: addOn.name.trim(), price: addOn.price })),
  };
}

export function validateMenuItem(item: AdminMenuItem): string | null {
  if (item.name.trim().length < 2) return "Enter the item name.";
  if (item.description.trim().length < 2) return "Enter a short description.";
  if (!Number.isFinite(item.price) || item.price < 0 || item.price > 100000) return "Enter a price of R0 or more.";
  if (!item.category) return "Choose a category.";
  if (!Number.isInteger(item.prepMinutes) || item.prepMinutes < 1 || item.prepMinutes > 240) return "Prep time must be between 1 and 240 minutes.";
  if (!item.imagePath.trim()) return "Upload a photo or keep the current one.";
  if (item.addOns.some((addOn) => addOn.name.trim() && (!Number.isFinite(addOn.price) || addOn.price < 0))) return "Add-on prices must be R0 or more.";
  return null;
}

export function imagePreviewUrl(path: string): string {
  const value = path.trim();
  if (value.startsWith("https://")) return value;
  const cfg = readPublicSupabaseConfig();
  if (cfg && value.startsWith("menu/")) return `${cfg.url.replace(/\/$/, "")}/storage/v1/object/public/menu-images/${value}`;
  return "/white-app-icon.png";
}

export const newMenuItemId = (now = Date.now()) => `menu-${now}`;

export function newCategoryId(name: string, now = Date.now()) {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "category";
  return `cat-${slug}-${now}`;
}

export function validateImageFile(file: { size: number; type: string }): string | null {
  if (!file.size || file.size > MAX_IMAGE_BYTES || !IMAGE_TYPES.includes(file.type)) {
    return "Choose a JPG, PNG or WebP image smaller than 5 MB.";
  }
  return null;
}

export function cleanFileName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-");
}

/** Uploads to menu-images and returns the public URL stored on the item, like the app. */
export async function uploadMenuImage(file: File, now = Date.now()): Promise<string> {
  const invalid = validateImageFile(file);
  if (invalid) throw new Error(invalid);
  const path = `menu/${now}-${cleanFileName(file.name)}`;
  const storage = createBrowserClient().storage.from("menu-images");
  const { error } = await storage.upload(path, file, { contentType: file.type, upsert: true });
  if (error) throw new Error("Could not upload the photo. Please try again.");
  return storage.getPublicUrl(path).data.publicUrl;
}

export async function fetchCatalog(): Promise<{ items: AdminMenuItem[]; categories: MenuCategory[] }> {
  const supa = createBrowserClient();
  const [items, categories] = await Promise.all([
    supa.from("menu_items").select("*").order("category").order("name"),
    supa.from("menu_categories").select("*").order("sort_order").order("name"),
  ]);
  if (items.error || categories.error) throw new Error("Could not load the menu. Please try again.");
  return {
    items: ((items.data ?? []) as Record<string, unknown>[]).map(mapAdminItem),
    categories: ((categories.data ?? []) as Record<string, unknown>[]).map(mapCategoryRow),
  };
}

function writeError(fallback: string) {
  return new Error(`${fallback} Check that your account has admin access and try again.`);
}

export async function saveMenuItem(item: AdminMenuItem, isNew: boolean): Promise<void> {
  const invalid = validateMenuItem(item);
  if (invalid) throw new Error(invalid);
  const table = createBrowserClient().from("menu_items");
  const { data, error } = isNew
    ? await table.insert(itemToRow(item)).select("id").maybeSingle()
    : await table.update(itemToRow(item)).eq("id", item.id).select("id").maybeSingle();
  if (error || !data) throw writeError("The item was not saved.");
}

export async function setItemAvailability(id: string, isAvailable: boolean): Promise<void> {
  const { data, error } = await createBrowserClient().from("menu_items")
    .update({ is_available: isAvailable }).eq("id", id).select("id").maybeSingle();
  if (error || !data) throw writeError("The item was not updated.");
}

export async function deleteMenuItem(id: string): Promise<void> {
  const { data, error } = await createBrowserClient().from("menu_items").delete().eq("id", id).select("id").maybeSingle();
  if (error || !data) throw writeError("The item was not deleted.");
}

/** Saves a category. On rename, moves that category's items to the new name (as the app does). */
export async function saveCategory(category: MenuCategory, isNew: boolean, previousName?: string): Promise<void> {
  const name = category.name.trim();
  if (name.length < 2 || name.length > 60) throw new Error("Enter a category name between 2 and 60 characters.");
  const row = { id: category.id, name, sort_order: Math.round(category.sortOrder) || 0, is_active: category.isActive };
  const table = createBrowserClient().from("menu_categories");
  const { data, error } = isNew
    ? await table.insert(row).select("id").maybeSingle()
    : await table.update(row).eq("id", category.id).select("id").maybeSingle();
  if (error?.code === "23505") throw new Error("A category with this name already exists.");
  if (error || !data) throw writeError("The category was not saved.");
  if (!isNew && previousName && previousName !== name) {
    const moved = await createBrowserClient().from("menu_items").update({ category: name }).eq("category", previousName);
    if (moved.error) throw writeError("The category was renamed, but its items still use the old name.");
  }
}

export function categoryInUse(category: MenuCategory, items: AdminMenuItem[]) {
  return items.filter((item) => item.category === category.name).length;
}

export async function deleteCategory(id: string): Promise<void> {
  const { data, error } = await createBrowserClient().from("menu_categories").delete().eq("id", id).select("id").maybeSingle();
  if (error || !data) throw writeError("The category was not deleted.");
}
