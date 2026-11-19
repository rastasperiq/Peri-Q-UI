"use client";
// Admin order data: the signed-in admin's own session and the database's
// is_admin() rules. Never the service-role key.

import { createBrowserClient } from "../supabase";

export type OrderStatus = "pending" | "preparing" | "ready" | "completed" | "cancelled";

export type AdminOrderItem = {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  spiceLevel: string | null;
  notes: string;
  addOns: string[];
};

export type AdminOrder = {
  id: string;
  orderNumber: number;
  customerName: string;
  customerPhone: string;
  orderType: "pickup" | "delivery";
  deliveryAddress: string | null;
  deliveryFee: number | null;
  deliveryDistanceKm: number | null;
  totalPrice: number;
  status: OrderStatus;
  paymentStatus: string;
  paymentMethod: string;
  yocoMode: string | null;
  estimatedMinutes: number;
  createdAt: string;
  items: AdminOrderItem[];
};

export const ORDER_SELECT =
  "id,order_number,customer_name,customer_phone,order_type,delivery_address,delivery_fee,delivery_distance_km,total_price,status,payment_status,payment_method,yoco_mode,estimated_minutes,created_at,order_items(id,item_name,quantity,unit_price,spice_level,notes,selected_add_ons)";

const STATUSES: OrderStatus[] = ["pending", "preparing", "ready", "completed", "cancelled"];

export function mapOrderRow(row: Record<string, unknown>): AdminOrder {
  const status = String(row.status ?? "pending") as OrderStatus;
  const items = Array.isArray(row.order_items) ? (row.order_items as Record<string, unknown>[]) : [];
  const num = (value: unknown) => (value == null ? null : Number(value));
  return {
    id: String(row.id ?? ""),
    orderNumber: Number(row.order_number ?? 0),
    customerName: String(row.customer_name ?? ""),
    customerPhone: String(row.customer_phone ?? ""),
    orderType: row.order_type === "delivery" ? "delivery" : "pickup",
    deliveryAddress: (row.delivery_address as string | null) ?? null,
    deliveryFee: num(row.delivery_fee),
    deliveryDistanceKm: num(row.delivery_distance_km),
    totalPrice: Number(row.total_price ?? 0),
    status: STATUSES.includes(status) ? status : "pending",
    paymentStatus: String(row.payment_status ?? "unpaid"),
    paymentMethod: String(row.payment_method ?? ""),
    yocoMode: (row.yoco_mode as string | null) ?? null,
    estimatedMinutes: Number(row.estimated_minutes ?? 0),
    createdAt: String(row.created_at ?? ""),
    items: items.map((item) => ({
      id: String(item.id ?? ""),
      name: String(item.item_name ?? ""),
      quantity: Number(item.quantity ?? 1),
      unitPrice: Number(item.unit_price ?? 0),
      spiceLevel: (item.spice_level as string | null) ?? null,
      notes: String(item.notes ?? ""),
      addOns: (Array.isArray(item.selected_add_ons) ? (item.selected_add_ons as Record<string, unknown>[]) : [])
        .map((addOn) => String(addOn?.name ?? "")).filter(Boolean),
    })),
  };
}

export async function fetchAdminOrders(limit = 100): Promise<AdminOrder[]> {
  const { data, error } = await createBrowserClient()
    .from("orders").select(ORDER_SELECT)
    .order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error("Could not load orders. Check your connection and try again.");
  return ((data ?? []) as Record<string, unknown>[]).map(mapOrderRow);
}

export type OrderAction = { to: OrderStatus; label: string; confirm?: boolean; tone: "primary" | "danger" };

/** The moves the database allows (validate_order_status_transition). */
export function nextActions(status: OrderStatus): OrderAction[] {
  switch (status) {
    case "pending":
      return [
        { to: "preparing", label: "Accept & start cooking", tone: "primary" },
        { to: "cancelled", label: "Reject", confirm: true, tone: "danger" },
      ];
    case "preparing":
      return [{ to: "ready", label: "Mark ready", tone: "primary" }];
    case "ready":
      return [{ to: "completed", label: "Mark completed", tone: "primary" }];
    default:
      return [];
  }
}

export class OrderMovedError extends Error {}

export async function updateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
  const { data, error } = await createBrowserClient()
    .from("orders").update({ status }).eq("id", orderId).select("id").maybeSingle();
  if (error) {
    if (error.code === "22023") throw new OrderMovedError("This order has already moved on. Refreshing the list.");
    if (error.code === "42501") throw new Error("This account is not allowed to change orders.");
    throw new Error("Could not update the order. Please try again.");
  }
  if (!data) throw new OrderMovedError("This order could not be found. Refreshing the list.");
}

export const isActiveOrder = (order: AdminOrder) =>
  order.status === "pending" || order.status === "preparing" || order.status === "ready";

/** Ids in `next` that weren't in `previous`. A first load (previous null) alerts nothing. */
export function newOrderIds(previous: AdminOrder[] | null, next: AdminOrder[]): string[] {
  if (previous === null) return [];
  const seen = new Set(previous.map((order) => order.id));
  return next.filter((order) => !seen.has(order.id) && order.status === "pending").map((order) => order.id);
}

function sastDay(value: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(value);
}

export function orderMetrics(orders: AdminOrder[], now = new Date()) {
  const today = sastDay(now);
  const todays = orders.filter((order) => order.createdAt && sastDay(new Date(order.createdAt)) === today);
  return {
    active: orders.filter(isActiveOrder).length,
    todaysSales: todays
      .filter((order) => order.paymentStatus === "paid" && order.status !== "cancelled")
      .reduce((sum, order) => sum + order.totalPrice, 0),
    completedToday: todays.filter((order) => order.status === "completed").length,
  };
}
