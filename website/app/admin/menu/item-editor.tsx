"use client";

import { useState, type FormEvent } from "react";
import { imagePreviewUrl, uploadMenuImage, validateImageFile, validateMenuItem, type AdminMenuItem } from "@/lib/admin/catalog";
import type { MenuCategory } from "@/lib/menu";
import { adminField } from "../admin-shell";

export function ItemEditor({ initial, isNew, categories, onSave, onCancel }: {
  initial: AdminMenuItem; isNew: boolean; categories: MenuCategory[];
  onSave: (item: AdminMenuItem) => Promise<void>; onCancel: () => void;
}) {
  const [item, setItem] = useState(initial);
  const [spice, setSpice] = useState(initial.spiceLevels.join(", "));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof AdminMenuItem>(key: K, value: AdminMenuItem[K]) => setItem((current) => ({ ...current, [key]: value }));
  const categoryNames = categories.map((category) => category.name);
  const options = item.category && !categoryNames.includes(item.category) ? [item.category, ...categoryNames] : categoryNames;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const invalid = validateImageFile(file);
    if (invalid) { setError(invalid); return; }
    setUploading(true); setError(null);
    try { set("imagePath", await uploadMenuImage(file)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not upload the photo."); }
    finally { setUploading(false); }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = { ...item, spiceLevels: spice.split(",").map((level) => level.trim()).filter(Boolean) };
    const invalid = validateMenuItem(next);
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError(null);
    try { await onSave(next); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The item was not saved."); setBusy(false); }
  };

  return <form onSubmit={(event) => void submit(event)} className="grid max-w-2xl gap-5 border border-black/10 bg-white p-6">
    <h2 className="font-display text-2xl font-bold uppercase">{isNew ? "Add menu item" : `Edit ${initial.name}`}</h2>
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">{error}</p>}
    <div className="flex flex-wrap items-center gap-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imagePreviewUrl(item.imagePath)} alt="" className="h-24 w-24 rounded-xl object-cover" />
      <label className="font-bold">Photo (JPG, PNG or WebP, under 5 MB)
        <input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} className="mt-2 block text-sm font-normal" onChange={(event) => void upload(event.target.files?.[0])} />
        {uploading && <span role="status" className="mt-1 block text-sm font-normal">Uploading…</span>}
      </label>
    </div>
    <label className="font-bold">Name<input className={adminField} required maxLength={100} value={item.name} onChange={(e) => set("name", e.target.value)} /></label>
    <label className="font-bold">Description<textarea className={adminField} required rows={3} maxLength={500} value={item.description} onChange={(e) => set("description", e.target.value)} /></label>
    <div className="grid gap-5 sm:grid-cols-3">
      <label className="font-bold">Price (R)<input className={adminField} type="number" min={0} step="0.01" required value={Number.isFinite(item.price) ? item.price : ""} onChange={(e) => set("price", e.target.valueAsNumber)} /></label>
      <label className="font-bold">Prep time (minutes)<input className={adminField} type="number" min={1} max={240} step={1} required value={Number.isFinite(item.prepMinutes) ? item.prepMinutes : ""} onChange={(e) => set("prepMinutes", e.target.valueAsNumber)} /></label>
      <label className="font-bold">Category<select className={adminField} required value={item.category} onChange={(e) => set("category", e.target.value)}>
        <option value="" disabled>Choose…</option>
        {options.map((name) => <option key={name} value={name}>{name}</option>)}
      </select></label>
    </div>
    <label className="font-bold">Spice levels (comma separated, leave empty for none)<input className={adminField} value={spice} onChange={(e) => setSpice(e.target.value)} /></label>
    <fieldset className="grid gap-3">
      <legend className="font-bold">Add-ons</legend>
      {item.addOns.map((addOn, index) => <div key={index} className="flex flex-wrap items-end gap-3">
        <label className="flex-1 text-sm">Name<input className={adminField} value={addOn.name} onChange={(e) => set("addOns", item.addOns.map((a, i) => i === index ? { ...a, name: e.target.value } : a))} /></label>
        <label className="w-32 text-sm">Price (R)<input className={adminField} type="number" min={0} step="0.01" value={Number.isFinite(addOn.price) ? addOn.price : ""} onChange={(e) => set("addOns", item.addOns.map((a, i) => i === index ? { ...a, price: e.target.valueAsNumber } : a))} /></label>
        <button type="button" onClick={() => set("addOns", item.addOns.filter((_, i) => i !== index))} className="pb-3 text-sm text-red-800 underline">Remove</button>
      </div>)}
      <button type="button" onClick={() => set("addOns", [...item.addOns, { name: "", price: 0 }])} className="justify-self-start text-sm font-bold underline">Add an add-on</button>
    </fieldset>
    <label className="flex items-center gap-3 font-bold"><input type="checkbox" checked={item.isAvailable} onChange={(e) => set("isAvailable", e.target.checked)} />Available to customers</label>
    <div className="flex gap-3">
      <button disabled={busy || uploading} className="button button-primary disabled:opacity-50">{busy ? "Saving…" : "Save item"}</button>
      <button type="button" disabled={busy} onClick={onCancel} className="button">Cancel</button>
    </div>
  </form>;
}
