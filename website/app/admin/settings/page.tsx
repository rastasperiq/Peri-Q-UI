"use client";

import type { FormEvent } from "react";
import { adminField } from "../admin-shell";
import { useSettingsForm } from "../use-settings-form";

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex items-start gap-3 border-b border-black/10 py-4 last:border-0">
    <input type="checkbox" className="mt-1 h-5 w-5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span><span className="block font-bold">{label}</span><span className="block text-sm text-ash">{hint}</span></span>
  </label>;
}

function NumberField({ label, value, onChange, min, max, step = "0.01" }: { label: string; value: number; onChange: (value: number) => void; min: number; max: number; step?: string }) {
  return <label className="font-bold">{label}<input className={adminField} type="number" min={min} max={max} step={step} required value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(e.target.valueAsNumber)} /></label>;
}

export default function AdminSettingsPage() {
  const { settings, set, save, error, message, busy, reload } = useSettingsForm();
  if (!settings) return error ? <p role="alert">{error} <button onClick={() => void reload()} className="underline">Try again</button></p> : <p role="status">Loading store settings…</p>;
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void save("Store settings saved."); };

  return <form onSubmit={submit} className="grid max-w-2xl gap-6">
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">{error}</p>}
    {message && <p role="status" className="rounded-xl border border-leaf/20 bg-leaf/10 p-4">{message}</p>}
    <section className="border border-black/10 bg-white px-6 py-2">
      <h2 className="pt-4 font-display text-2xl font-bold uppercase">Store availability</h2>
      <Toggle label="Store accepting orders" hint={settings.storeOpen ? "Customers can order now (within opening hours)." : "Closed: customers cannot place orders."} checked={settings.storeOpen} onChange={(v) => set("storeOpen", v)} />
      <Toggle label="Pickup available" hint="Customers can collect their order at the shop." checked={settings.pickupAvailable} onChange={(v) => set("pickupAvailable", v)} />
      <Toggle label="Delivery available" hint="Customers can ask for delivery to their address." checked={settings.deliveryAvailable} onChange={(v) => set("deliveryAvailable", v)} />
    </section>
    <section className="grid gap-5 border border-black/10 bg-white p-6">
      <h2 className="font-display text-2xl font-bold uppercase">Delivery pricing</h2>
      <p className="text-sm text-ash">Fee = base fee + price per km of driving distance, never below the minimum fee.</p>
      <div className="grid gap-5 sm:grid-cols-2">
        <NumberField label="Base fee (R)" value={settings.deliveryBaseFee} min={0} max={1000} onChange={(v) => set("deliveryBaseFee", v)} />
        <NumberField label="Price per km (R)" value={settings.deliveryPricePerKm} min={0} max={1000} onChange={(v) => set("deliveryPricePerKm", v)} />
        <NumberField label="Minimum fee (R)" value={settings.deliveryMinFee} min={0} max={1000} onChange={(v) => set("deliveryMinFee", v)} />
        <NumberField label="Maximum distance (km)" value={settings.deliveryMaxDistanceKm} min={0.1} max={100} step="0.1" onChange={(v) => set("deliveryMaxDistanceKm", v)} />
      </div>
      <label className="flex items-center gap-3 font-bold"><input type="checkbox" checked={settings.deliveryFreeThreshold !== null} onChange={(e) => set("deliveryFreeThreshold", e.target.checked ? 500 : null)} />Free delivery above an order amount</label>
      {settings.deliveryFreeThreshold !== null && <NumberField label="Free delivery from (R)" value={settings.deliveryFreeThreshold} min={0} max={100000} onChange={(v) => set("deliveryFreeThreshold", v)} />}
    </section>
    <section className="grid gap-5 border border-black/10 bg-white p-6">
      <h2 className="font-display text-2xl font-bold uppercase">Opening hours</h2>
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="font-bold">Opening time<input className={adminField} type="time" required value={settings.openingTime} onChange={(e) => set("openingTime", e.target.value)} /></label>
        <label className="font-bold">Closing time<input className={adminField} type="time" required value={settings.closingTime} onChange={(e) => set("closingTime", e.target.value)} /></label>
      </div>
    </section>
    <button disabled={busy} className="button button-primary justify-self-start disabled:opacity-50">{busy ? "Saving…" : "Save store settings"}</button>
  </form>;
}
