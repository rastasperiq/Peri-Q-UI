"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createBrowserClient } from "@/lib/supabase";
import {
  fetchAdminOrders, isActiveOrder, newOrderIds, nextActions, orderMetrics, OrderMovedError, updateOrderStatus,
  type AdminOrder, type OrderAction,
} from "@/lib/admin/orders";
import { keepScreenAwake, playOrderTone, readSoundPreference, unlockSound, writeSoundPreference } from "@/lib/admin/alert";

export const POLL_MS = 30_000;
const money = (value: number) => `R${value.toFixed(2)}`;
const time = (iso: string) => iso
  ? new Date(iso).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })
  : "";

type Toast = { id: string; text: string };

export default function OrdersClient() {
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState<"connecting" | "live" | "polling">("connecting");
  const [soundOn, setSoundOn] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const previous = useRef<AdminOrder[] | null>(null);
  const soundRef = useRef(false);
  const loading = useRef(false);
  const again = useRef(false);

  const alertNew = useCallback((fresh: AdminOrder[]) => {
    setToasts((current) => [...current, ...fresh.map((order) => ({ id: order.id, text: `New order #${order.orderNumber} · ${money(order.totalPrice)} · ${order.orderType === "delivery" ? "Delivery" : "Pickup"}` }))]);
    if (soundRef.current && !playOrderTone()) setSoundBlocked(true);
    flashTitle(fresh.length);
  }, []);

  const reload = useCallback(async () => {
    if (loading.current) { again.current = true; return; }
    loading.current = true;
    try {
      do {
        again.current = false;
        const next = await fetchAdminOrders();
        const freshIds = newOrderIds(previous.current, next);
        previous.current = next;
        setOrders(next);
        setLoadError(null);
        if (freshIds.length) alertNew(next.filter((order) => freshIds.includes(order.id)));
      } while (again.current);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Could not load orders.");
    } finally {
      loading.current = false;
    }
  }, [alertNew]);

  useEffect(() => {
    void reload();
    const supa = createBrowserClient();
    const channel = supa.channel("admin-orders")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => { void reload(); })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setLive("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setLive("polling");
      });
    const poll = setInterval(() => { void reload(); }, POLL_MS);
    return () => { clearInterval(poll); void supa.removeChannel(channel); };
  }, [reload]);

  // Sound: remembered per device, but browsers need one click per visit before it can play.
  useEffect(() => {
    if (!readSoundPreference()) return;
    soundRef.current = true; setSoundOn(true);
    void unlockSound().then((ok) => setSoundBlocked(!ok));
    const unlockOnClick = () => { void unlockSound().then((ok) => { if (ok) setSoundBlocked(false); }); };
    document.addEventListener("pointerdown", unlockOnClick);
    return () => document.removeEventListener("pointerdown", unlockOnClick);
  }, []);

  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    let active = true;
    const acquire = () => { void keepScreenAwake().then((value) => { if (active) lock = value; else void value?.release(); }); };
    acquire();
    const onVisible = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; document.removeEventListener("visibilitychange", onVisible); void lock?.release(); };
  }, []);

  const enableSound = async () => {
    const ok = await unlockSound();
    writeSoundPreference(true); soundRef.current = true; setSoundOn(true); setSoundBlocked(!ok);
    if (ok) playOrderTone();
  };
  const disableSound = () => { writeSoundPreference(false); soundRef.current = false; setSoundOn(false); setSoundBlocked(false); };

  if (!orders) {
    return loadError
      ? <p role="alert">{loadError} <button onClick={() => void reload()} className="underline">Try again</button></p>
      : <p role="status">Loading orders…</p>;
  }

  const metrics = orderMetrics(orders);
  const active = orders.filter(isActiveOrder).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const finished = orders.filter((order) => !isActiveOrder(order)).slice(0, 20);

  return <div className="grid gap-8">
    <div className="flex flex-wrap items-center gap-3">
      {!soundOn
        ? <button onClick={() => void enableSound()} className="button button-primary">Enable order sound</button>
        : soundBlocked
          ? <button onClick={() => void enableSound()} className="button button-primary">Click to turn the order sound back on</button>
          : <span className="flex items-center gap-3 text-sm font-bold">Sound on
              <button onClick={() => playOrderTone()} className="font-normal underline">Test sound</button>
              <button onClick={disableSound} className="font-normal underline">Turn off</button></span>}
      <span role="status" className="text-sm text-ash">
        {live === "live" ? "Live: new orders appear automatically." : live === "polling" ? `Reconnecting… checking every ${POLL_MS / 1000} seconds.` : "Connecting…"}
      </span>
    </div>
    {loadError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">{loadError}</p>}

    <div className="grid gap-4 sm:grid-cols-3">
      <Metric label="Active orders" value={String(metrics.active)} />
      <Metric label="Today's sales (paid)" value={money(metrics.todaysSales)} />
      <Metric label="Completed today" value={String(metrics.completedToday)} />
    </div>

    <section>
      <h2 className="font-display text-2xl font-bold uppercase">Incoming orders</h2>
      {!active.length ? <p className="mt-4 text-ash">No active orders in the queue right now.</p>
        : <ul className="mt-4 grid gap-4 lg:grid-cols-2">{active.map((order) => <li key={order.id}><OrderCard order={order} onChanged={reload} /></li>)}</ul>}
    </section>

    <section>
      <h2 className="font-display text-2xl font-bold uppercase">Recent finished orders</h2>
      {!finished.length ? <p className="mt-4 text-ash">No finished orders yet.</p>
        : <ul className="mt-4 divide-y divide-black/10 border-y border-black/10 bg-white">{finished.map((order) => <li key={order.id} className="flex flex-wrap justify-between gap-2 px-4 py-3 text-sm">
            <span><span className="font-bold">#{order.orderNumber}</span> · {order.customerName} · {time(order.createdAt)}</span>
            <span><StatusPill status={order.status} /> <PaymentPill status={order.paymentStatus} /> <span className="ml-2 font-bold">{money(order.totalPrice)}</span></span>
          </li>)}</ul>}
    </section>

    <div aria-live="assertive" className="fixed bottom-4 right-4 z-50 grid w-[min(24rem,calc(100vw-2rem))] gap-2">
      {toasts.map((toast) => <div key={toast.id} role="alert" className="flex items-start justify-between gap-3 rounded-xl bg-peri-red p-4 font-bold text-white shadow-xl">
        <span>{toast.text}</span>
        <button aria-label="Dismiss" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))} className="text-xl leading-none">×</button>
      </div>)}
    </div>
  </div>;
}

function flashTitle(count: number) {
  if (typeof document === "undefined") return;
  const original = document.title.replace(/^\(\d+ new\) /, "");
  document.title = `(${count} new) ${original}`;
  const reset = () => { document.title = original; window.removeEventListener("focus", reset); };
  if (document.hasFocus()) setTimeout(reset, 8000);
  else window.addEventListener("focus", reset);
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="border border-black/10 bg-white p-5"><p className="text-sm text-ash">{label}</p><p className="mt-1 font-display text-3xl font-black">{value}</p></div>;
}

const STATUS_LABEL: Record<string, string> = { pending: "New", preparing: "Cooking", ready: "Ready", completed: "Completed", cancelled: "Rejected" };
function StatusPill({ status }: { status: string }) {
  return <span className="rounded-full bg-black/10 px-2 py-0.5 text-xs font-bold uppercase">{STATUS_LABEL[status] ?? status}</span>;
}
function PaymentPill({ status }: { status: string }) {
  const tone = status === "paid" ? "bg-leaf/15 text-leaf" : status === "refunded" ? "bg-black/10" : "bg-red-100 text-red-900";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase ${tone}`}>{status}</span>;
}

export function OrderCard({ order, onChanged }: { order: AdminOrder; onChanged: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<OrderAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: OrderAction) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await updateOrderStatus(order.id, action.to); setConfirming(null); await onChanged(); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the order.");
      if (cause instanceof OrderMovedError) await onChanged();
    } finally { setBusy(false); }
  };

  return <article className={`h-full border bg-white p-5 ${order.status === "pending" ? "border-peri-red border-2" : "border-black/10"}`}>
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 className="font-display text-2xl font-black">#{order.orderNumber}</h3>
        <p className="text-sm text-ash">{time(order.createdAt)} · about {order.estimatedMinutes} min</p>
      </div>
      <div className="flex flex-wrap gap-2"><StatusPill status={order.status} /><PaymentPill status={order.paymentStatus} />
        {order.yocoMode === "test" && <span className="rounded-full bg-[#ff7a00] px-2 py-0.5 text-xs font-bold uppercase text-black">Test payment</span>}</div>
    </header>
    <dl className="mt-4 grid gap-2 text-sm">
      <div><dt className="inline font-bold">Customer: </dt><dd className="inline">{order.customerName}</dd></div>
      <div><dt className="inline font-bold">Phone: </dt><dd className="inline"><a href={`tel:${order.customerPhone}`} className="underline">{order.customerPhone}</a></dd></div>
      {order.orderType === "delivery"
        ? <div><dt className="inline font-bold">Delivery: </dt><dd className="inline">{order.deliveryAddress}{order.deliveryDistanceKm != null && ` (${order.deliveryDistanceKm.toFixed(1)} km)`}</dd></div>
        : <div><dt className="inline font-bold">Collection: </dt><dd className="inline">Customer collects at the shop</dd></div>}
    </dl>
    <ul className="mt-4 divide-y divide-black/10 border-y border-black/10 text-sm">
      {order.items.map((item) => <li key={item.id} className="py-2">
        <div className="flex justify-between gap-3"><span className="font-bold">{item.quantity} × {item.name}</span><span>{money(item.unitPrice * item.quantity)}</span></div>
        {(item.spiceLevel || item.addOns.length > 0) && <p className="text-ash">{[item.spiceLevel, ...item.addOns].filter(Boolean).join(" · ")}</p>}
        {item.notes && <p className="text-ash">Note: {item.notes}</p>}
      </li>)}
    </ul>
    <p className="mt-3 flex justify-between text-sm">{order.deliveryFee != null && order.orderType === "delivery" ? <span>Delivery fee {money(order.deliveryFee)}</span> : <span />}<span className="text-base font-black">Total {money(order.totalPrice)}</span></p>

    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}
    {confirming ? <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
      <p className="font-bold">Reject order #{order.orderNumber}?</p>
      {order.paymentStatus === "paid" && <p className="mt-1">The customer has paid. Rejecting does <strong>not</strong> refund them: refund the payment in the Yoco dashboard as well.</p>}
      <div className="mt-3 flex gap-3">
        <button disabled={busy} onClick={() => void run(confirming)} className="button bg-red-700 text-white disabled:opacity-50">Reject order</button>
        <button disabled={busy} onClick={() => setConfirming(null)} className="button">Keep order</button>
      </div>
    </div> : <div className="mt-4 flex flex-wrap gap-3">
      {nextActions(order.status).map((action) => <button key={action.to} disabled={busy}
        onClick={() => action.confirm ? setConfirming(action) : void run(action)}
        className={`button disabled:opacity-50 ${action.tone === "primary" ? "button-primary" : "border border-red-700 text-red-800"}`}>
        {busy && !action.confirm ? "Saving…" : action.label}</button>)}
    </div>}
  </article>;
}
