import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One fake Supabase client for every admin module.
const db = vi.hoisted(() => {
  const state = {
    auth: { user: null as null | { id: string; email?: string; is_anonymous?: boolean }, loading: false },
    role: null as string | null,
    roleError: null as unknown,
    ordersResult: { data: [] as unknown[], error: null as unknown },
    updateResult: { data: { id: "o1" } as unknown, error: null as unknown },
    updates: [] as { table: string; values: unknown; eq: [string, unknown] }[],
    channelStatus: "SUBSCRIBED",
    channelHandler: null as null | (() => void),
  };
  return state;
});

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/" }));
vi.mock("@/lib/customer-auth", () => ({ useCustomerAuth: () => db.auth }));
vi.mock("@/lib/cart", () => ({ useCart: () => ({ clear: vi.fn() }) }));
vi.mock("@/lib/customer-account", () => ({ signInCustomer: vi.fn(), signOutCustomer: vi.fn() }));
vi.mock("@/lib/supabase", () => {
  const client = {
    from: (table: string) => ({
      select: () => {
        if (table === "profiles") return { eq: () => ({ maybeSingle: async () => ({ data: db.role ? { role: db.role } : null, error: db.roleError }) }) };
        return { order: () => ({ limit: async () => db.ordersResult }) };
      },
      update: (values: unknown) => ({
        eq: (column: string, value: unknown) => {
          db.updates.push({ table, values, eq: [column, value] });
          return { select: () => ({ maybeSingle: async () => db.updateResult }) };
        },
      }),
    }),
    channel: () => {
      const channel = {
        on: (_event: string, _filter: unknown, handler: () => void) => { db.channelHandler = handler; return channel; },
        subscribe: (callback: (status: string) => void) => { callback(db.channelStatus); return channel; },
      };
      return channel;
    },
    removeChannel: async () => "ok",
  };
  return { createBrowserClient: () => client, isSupabaseConfigured: () => true, readPublicSupabaseConfig: () => ({ url: "https://example.supabase.co", publishableKey: "pk" }) };
});
const tone = vi.hoisted(() => ({ play: vi.fn(() => true), unlock: vi.fn(async () => true) }));
vi.mock("@/lib/admin/alert", () => ({
  playOrderTone: tone.play, unlockSound: tone.unlock, keepScreenAwake: async () => null,
  readSoundPreference: () => true, writeSoundPreference: vi.fn(),
}));

import { mapOrderRow, newOrderIds, nextActions, orderMetrics, updateOrderStatus, OrderMovedError, type AdminOrder } from "../lib/admin/orders";
import { categoryInUse, cleanFileName, newCategoryId, validateImageFile, validateMenuItem, type AdminMenuItem } from "../lib/admin/catalog";
import { mapSettingsRow, validateSettings } from "../lib/admin/settings";
import AdminShell from "../app/admin/admin-shell";
import OrdersClient, { OrderCard, POLL_MS } from "../app/admin/orders-client";

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "o1", order_number: 101, customer_name: "Thandi", customer_phone: "0712345678", order_type: "delivery",
  delivery_address: "12 Main Rd", delivery_fee: 35, delivery_distance_km: 4.2, total_price: 95, status: "pending",
  payment_status: "paid", payment_method: "yoco", yoco_mode: "live", estimated_minutes: 25,
  created_at: "2026-11-19T08:00:00Z",
  order_items: [{ id: "i1", item_name: "Wors Plate", quantity: 2, unit_price: 30, spice_level: "Hot", notes: "No onions", selected_add_ons: [{ name: "Extra Pap" }] }],
  ...overrides,
});
const order = (overrides: Record<string, unknown> = {}): AdminOrder => mapOrderRow(row(overrides));

beforeEach(() => {
  db.auth = { user: { id: "admin-1", email: "owner@example.invalid" }, loading: false };
  db.role = "admin"; db.roleError = null;
  db.ordersResult = { data: [], error: null };
  db.updateResult = { data: { id: "o1" }, error: null };
  db.updates = []; db.channelStatus = "SUBSCRIBED"; db.channelHandler = null;
  tone.play.mockClear(); tone.unlock.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("order rules", () => {
  it("offers only the moves the database allows", () => {
    expect(nextActions("pending").map((a) => [a.to, a.label, !!a.confirm])).toEqual([
      ["preparing", "Accept & start cooking", false], ["cancelled", "Reject", true],
    ]);
    expect(nextActions("preparing").map((a) => a.to)).toEqual(["ready"]);
    expect(nextActions("ready").map((a) => a.to)).toEqual(["completed"]);
    expect(nextActions("completed")).toEqual([]);
    expect(nextActions("cancelled")).toEqual([]);
  });

  it("maps order rows with items, add-ons and delivery details", () => {
    const mapped = order();
    expect(mapped).toMatchObject({ orderNumber: 101, orderType: "delivery", deliveryFee: 35, totalPrice: 95, paymentStatus: "paid" });
    expect(mapped.items[0]).toMatchObject({ name: "Wors Plate", quantity: 2, unitPrice: 30, spiceLevel: "Hot", addOns: ["Extra Pap"], notes: "No onions" });
  });

  it("alerts nothing on the first load and only new pending orders after", () => {
    const first = [order({ id: "a" })];
    expect(newOrderIds(null, first)).toEqual([]);
    const next = [order({ id: "b" }), order({ id: "c", status: "completed" }), ...first];
    expect(newOrderIds(first, next)).toEqual(["b"]);
  });

  it("counts today's sales from paid, not-rejected orders on the South African day", () => {
    const now = new Date("2026-11-19T21:30:00Z"); // 23:30 in Johannesburg
    const orders = [
      order({ id: "1", total_price: 100, created_at: "2026-11-19T06:00:00Z", status: "completed" }),
      order({ id: "2", total_price: 50, created_at: "2026-11-19T21:00:00Z" }),
      order({ id: "3", total_price: 70, created_at: "2026-11-19T07:00:00Z", status: "cancelled" }),
      order({ id: "4", total_price: 40, created_at: "2026-11-19T07:00:00Z", payment_status: "refunded", status: "completed" }),
      order({ id: "5", total_price: 999, created_at: "2026-11-18T21:59:00Z" }), // 23:59 on the 18th
    ];
    expect(orderMetrics(orders, now)).toEqual({ active: 2, todaysSales: 150, completedToday: 2 });
  });

  it("explains a refused status change when another admin already moved the order", async () => {
    db.updateResult = { data: null, error: { code: "22023", message: "Invalid order status transition." } };
    await expect(updateOrderStatus("o1", "preparing")).rejects.toBeInstanceOf(OrderMovedError);
    db.updateResult = { data: null, error: { code: "42501" } };
    await expect(updateOrderStatus("o1", "preparing")).rejects.toThrow("not allowed");
  });
});

describe("menu and settings validation", () => {
  const item: AdminMenuItem = { id: "menu-1", name: "Wors Plate", description: "Wors and pap", price: 50, category: "Wors Meals", imagePath: "https://x/y.png", isAvailable: true, prepMinutes: 25, spiceLevels: [], addOns: [] };

  it("checks menu items and photos like the app", () => {
    expect(validateMenuItem(item)).toBeNull();
    expect(validateMenuItem({ ...item, price: -1 })).toMatch("price");
    expect(validateMenuItem({ ...item, category: "" })).toMatch("category");
    expect(validateImageFile({ size: 5 * 1024 * 1024 + 1, type: "image/png" })).toMatch("5 MB");
    expect(validateImageFile({ size: 10, type: "image/gif" })).toMatch("JPG");
    expect(validateImageFile({ size: 10, type: "image/webp" })).toBeNull();
    expect(cleanFileName("My Photo (1).JPG")).toBe("my-photo-1-.jpg");
    expect(newCategoryId("Cold Drinks!", 123)).toBe("cat-cold-drinks-123");
    expect(categoryInUse({ id: "c", name: "Wors Meals", sortOrder: 0, isActive: true }, [item])).toBe(1);
  });

  it("mirrors the database's delivery and time limits", () => {
    const base = mapSettingsRow({ todays_special_label: "L", todays_special_title: "T", todays_special_subtitle: "S", todays_special_image_path: "x" });
    expect(validateSettings(base)).toBeNull();
    expect(validateSettings({ ...base, deliveryBaseFee: 1001 })).toMatch("R1000");
    expect(validateSettings({ ...base, deliveryMaxDistanceKm: 0 })).toMatch("100 km");
    expect(validateSettings({ ...base, deliveryFreeThreshold: -5 })).toMatch("free-delivery");
    expect(validateSettings({ ...base, openingTime: "9am" })).toMatch("HH:MM");
    expect(validateSettings({ ...base, specialTitle: " " })).toMatch("headline");
  });
});

describe("admin access gate", () => {
  const mount = async () => { await act(async () => { render(<AdminShell environment="live"><p>Secret admin content</p></AdminShell>); }); };

  it("shows the sign-in form to signed-out visitors and anonymous guests", async () => {
    db.auth = { user: { id: "guest", is_anonymous: true }, loading: false };
    await mount();
    expect(screen.getByRole("heading", { name: "Admin sign in" })).toBeInTheDocument();
    expect(screen.queryByText("Secret admin content")).toBeNull();
  });

  it("refuses customer accounts", async () => {
    db.role = "customer";
    await mount();
    expect(screen.getByText("This account is not an admin.")).toBeInTheDocument();
    expect(screen.queryByText("Secret admin content")).toBeNull();
  });

  it("shows the dashboard and LIVE badge to admins", async () => {
    await mount();
    expect(screen.getByText("Secret admin content")).toBeInTheDocument();
    expect(screen.getByTestId("admin-environment")).toHaveTextContent("Live");
    expect(screen.getByRole("link", { name: "Orders" })).toHaveAttribute("aria-current", "page");
  });

  it("shows a retry when the role check fails", async () => {
    db.roleError = { message: "network" };
    await mount();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not check your account");
  });
});

describe("orders page", () => {
  it("rejects only after confirming, with the Yoco refund reminder for paid orders", async () => {
    const changed = vi.fn();
    render(<OrderCard order={order()} onChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(db.updates).toEqual([]);
    expect(screen.getByText(/refund the payment in the Yoco dashboard/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reject order" })); });
    expect(db.updates).toEqual([{ table: "orders", values: { status: "cancelled" }, eq: ["id", "o1"] }]);
    expect(changed).toHaveBeenCalled();
  });

  it("reloads and explains when the order already moved on", async () => {
    db.updateResult = { data: null, error: { code: "22023" } };
    const changed = vi.fn();
    render(<OrderCard order={order()} onChanged={changed} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Accept & start cooking" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("already moved on");
    expect(changed).toHaveBeenCalled();
  });

  it("plays the sound and shows a pop-up for a new order, not for existing ones", async () => {
    db.ordersResult = { data: [row({ id: "old", status: "preparing" })], error: null };
    await act(async () => { render(<OrdersClient />); });
    expect(screen.getByText("Live: new orders appear automatically.")).toBeInTheDocument();
    expect(tone.play).not.toHaveBeenCalled();
    db.ordersResult = { data: [row({ id: "new", order_number: 202 }), row({ id: "old", status: "preparing" })], error: null };
    await act(async () => { db.channelHandler?.(); });
    expect(tone.play).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/New order #202/)).toBeInTheDocument();
  });

  it("falls back to polling when the live connection fails", async () => {
    vi.useFakeTimers();
    db.channelStatus = "CHANNEL_ERROR";
    await act(async () => { render(<OrdersClient />); });
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
    db.ordersResult = { data: [row({ id: "late", order_number: 303 })], error: null };
    await act(async () => { vi.advanceTimersByTime(POLL_MS); });
    expect(screen.getByText(/New order #303/)).toBeInTheDocument();
  });
});
