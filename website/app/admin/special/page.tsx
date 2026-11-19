"use client";

import { useEffect, useState, type FormEvent } from "react";
import { fetchCatalog, imagePreviewUrl, uploadMenuImage, validateImageFile, type AdminMenuItem } from "@/lib/admin/catalog";
import { adminField } from "../admin-shell";
import { useSettingsForm } from "../use-settings-form";

export default function AdminSpecialPage() {
  const { settings, set, save, error, message, busy, reload } = useSettingsForm();
  const [items, setItems] = useState<AdminMenuItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  useEffect(() => { void fetchCatalog().then((catalog) => setItems(catalog.items), () => setItems([])); }, []);

  if (!settings) return error ? <p role="alert">{error} <button onClick={() => void reload()} className="underline">Try again</button></p> : <p role="status">Loading Today&apos;s Special…</p>;
  const linked = items.find((item) => item.id === settings.specialMenuItemId);
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void save("Today's Special saved."); };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    const invalid = validateImageFile(file);
    if (invalid) { setUploadError(invalid); return; }
    setUploading(true); setUploadError(null);
    try { set("specialImagePath", await uploadMenuImage(file)); }
    catch (cause) { setUploadError(cause instanceof Error ? cause.message : "Could not upload the photo."); }
    finally { setUploading(false); }
  };

  return <form onSubmit={submit} className="grid max-w-2xl gap-5 border border-black/10 bg-white p-6">
    <h2 className="font-display text-2xl font-bold uppercase">Today&apos;s Special</h2>
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">{error}</p>}
    {uploadError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">{uploadError}</p>}
    {message && <p role="status" className="rounded-xl border border-leaf/20 bg-leaf/10 p-4">{message}</p>}
    <label className="flex items-center gap-3 font-bold"><input type="checkbox" checked={settings.specialEnabled} onChange={(e) => set("specialEnabled", e.target.checked)} />Show the Today&apos;s Special banner</label>
    <label className="font-bold">Promo label<input className={adminField} required maxLength={40} value={settings.specialLabel} onChange={(e) => set("specialLabel", e.target.value)} /></label>
    <label className="font-bold">Headline<input className={adminField} required maxLength={100} value={settings.specialTitle} onChange={(e) => set("specialTitle", e.target.value)} /></label>
    <label className="font-bold">Supporting text<input className={adminField} required maxLength={160} value={settings.specialSubtitle} onChange={(e) => set("specialSubtitle", e.target.value)} /></label>
    <label className="font-bold">Menu item it opens
      <select className={adminField} value={settings.specialMenuItemId ?? ""} onChange={(e) => set("specialMenuItemId", e.target.value || null)}>
        <option value="">First available item</option>
        {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    <div className="flex flex-wrap items-center gap-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imagePreviewUrl(settings.specialImagePath)} alt="" className="h-24 w-24 rounded-xl object-cover" />
      <div className="grid gap-2 text-sm">
        <label className="font-bold">Upload a photo<input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} className="mt-1 block font-normal" onChange={(e) => void upload(e.target.files?.[0])} /></label>
        {uploading && <span role="status">Uploading…</span>}
        {linked && <button type="button" onClick={() => set("specialImagePath", linked.imagePath)} className="justify-self-start underline">Use the photo of {linked.name}</button>}
      </div>
    </div>
    <button disabled={busy || uploading} className="button button-primary justify-self-start disabled:opacity-50">{busy ? "Saving…" : "Save Today's Special"}</button>
  </form>;
}
