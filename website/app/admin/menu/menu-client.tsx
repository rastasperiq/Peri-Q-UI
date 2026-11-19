"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_SPICE_LEVELS, deleteMenuItem, fetchCatalog, imagePreviewUrl, newMenuItemId, saveMenuItem, setItemAvailability,
  type AdminMenuItem,
} from "@/lib/admin/catalog";
import type { MenuCategory } from "@/lib/menu";
import { ItemEditor } from "./item-editor";

export default function MenuAdminClient() {
  const [items, setItems] = useState<AdminMenuItem[] | null>(null);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ item: AdminMenuItem; isNew: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const catalog = await fetchCatalog(); setItems(catalog.items); setCategories(catalog.categories); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load the menu."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (id: string, action: () => Promise<void>, done: string) => {
    setBusyId(id); setError(null); setMessage(null);
    try { await action(); setMessage(done); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Something went wrong."); }
    finally { setBusyId(null); setConfirmDelete(null); }
  };

  if (editing) {
    return <ItemEditor initial={editing.item} isNew={editing.isNew} categories={categories}
      onCancel={() => setEditing(null)}
      onSave={async (item) => { await saveMenuItem(item, editing.isNew); setEditing(null); setMessage(`${item.name} saved.`); await load(); }} />;
  }
  if (!items) return error ? <p role="alert">{error} <button onClick={() => void load()} className="underline">Try again</button></p> : <p role="status">Loading the menu…</p>;

  const blank = (): AdminMenuItem => ({
    id: newMenuItemId(), name: "", description: "", price: 0,
    category: categories.find((category) => category.isActive)?.name ?? "", imagePath: "",
    isAvailable: true, prepMinutes: 25, spiceLevels: DEFAULT_SPICE_LEVELS, addOns: [],
  });
  const groups = [...new Set(items.map((item) => item.category))];

  return <div className="grid gap-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-display text-2xl font-bold uppercase">Menu items ({items.length})</h2>
      <button onClick={() => setEditing({ item: blank(), isNew: true })} className="button button-primary">Add menu item</button>
    </div>
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">{error}</p>}
    {message && <p role="status" className="rounded-xl border border-leaf/20 bg-leaf/10 p-4">{message}</p>}
    {groups.map((group) => <section key={group}>
      <h3 className="font-bold uppercase text-ash">{group || "No category"}</h3>
      <ul className="mt-2 divide-y divide-black/10 border-y border-black/10 bg-white">
        {items.filter((item) => item.category === group).map((item) => <li key={item.id} className="flex flex-wrap items-center gap-4 p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imagePreviewUrl(item.imagePath)} alt="" className="h-14 w-14 rounded-lg object-cover" />
          <div className="min-w-0 flex-1">
            <p className="font-bold">{item.name}</p>
            <p className="text-sm text-ash">R{item.price.toFixed(2)} · {item.isAvailable ? "Shown to customers" : "Hidden"}</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={item.isAvailable} disabled={busyId === item.id}
              onChange={(event) => void act(item.id, () => setItemAvailability(item.id, event.target.checked), `${item.name} is now ${event.target.checked ? "shown" : "hidden"}.`)} />
            Available
          </label>
          <button onClick={() => setEditing({ item, isNew: false })} className="text-sm font-bold underline">Edit</button>
          {confirmDelete === item.id
            ? <span className="flex gap-2 text-sm"><button disabled={busyId === item.id} onClick={() => void act(item.id, () => deleteMenuItem(item.id), `${item.name} deleted.`)} className="font-bold text-red-800 underline">Delete {item.name}</button><button onClick={() => setConfirmDelete(null)} className="underline">Cancel</button></span>
            : <button onClick={() => setConfirmDelete(item.id)} className="text-sm text-red-800 underline">Delete</button>}
        </li>)}
      </ul>
    </section>)}
  </div>;
}
