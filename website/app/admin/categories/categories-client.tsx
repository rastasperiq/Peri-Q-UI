"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { categoryInUse, deleteCategory, fetchCatalog, newCategoryId, saveCategory, type AdminMenuItem } from "@/lib/admin/catalog";
import type { MenuCategory } from "@/lib/menu";
import { adminField } from "../admin-shell";

export default function CategoriesClient() {
  const [categories, setCategories] = useState<MenuCategory[] | null>(null);
  const [items, setItems] = useState<AdminMenuItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ category: MenuCategory; isNew: boolean; previousName: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const catalog = await fetchCatalog(); setCategories(catalog.categories); setItems(catalog.items); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load categories."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const perform = async (action: () => Promise<void>, done: string) => {
    setBusy(true); setError(null); setMessage(null);
    try { await action(); setMessage(done); setEditing(null); setConfirmDelete(null); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Something went wrong."); }
    finally { setBusy(false); }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const { category, isNew, previousName } = editing;
    const saved = isNew ? { ...category, id: newCategoryId(category.name) } : category;
    void perform(() => saveCategory(saved, isNew, previousName), `${category.name.trim()} saved.`);
  };

  if (!categories) return error ? <p role="alert">{error} <button onClick={() => void load()} className="underline">Try again</button></p> : <p role="status">Loading categories…</p>;
  const nextSort = Math.max(0, ...categories.map((category) => category.sortOrder)) + 10;

  return <div className="grid max-w-3xl gap-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-display text-2xl font-bold uppercase">Categories</h2>
      {!editing && <button onClick={() => setEditing({ category: { id: "", name: "", sortOrder: nextSort, isActive: true }, isNew: true, previousName: "" })} className="button button-primary">Add category</button>}
    </div>
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">{error}</p>}
    {message && <p role="status" className="rounded-xl border border-leaf/20 bg-leaf/10 p-4">{message}</p>}
    {editing && <form onSubmit={submit} className="grid gap-4 border border-black/10 bg-white p-6">
      <h3 className="font-bold">{editing.isNew ? "Add category" : `Edit ${editing.previousName}`}</h3>
      <label className="font-bold">Name<input className={adminField} required minLength={2} maxLength={60} value={editing.category.name} onChange={(e) => setEditing({ ...editing, category: { ...editing.category, name: e.target.value } })} /></label>
      <label className="font-bold">Order on the menu (lower shows first)<input className={adminField} type="number" step={1} value={editing.category.sortOrder} onChange={(e) => setEditing({ ...editing, category: { ...editing.category, sortOrder: e.target.valueAsNumber || 0 } })} /></label>
      <label className="flex items-center gap-3 font-bold"><input type="checkbox" checked={editing.category.isActive} onChange={(e) => setEditing({ ...editing, category: { ...editing.category, isActive: e.target.checked } })} />Show to customers</label>
      {!editing.isNew && editing.previousName !== editing.category.name.trim() && <p className="text-sm text-ash">Items in this category will move to the new name.</p>}
      <div className="flex gap-3"><button disabled={busy} className="button button-primary disabled:opacity-50">{busy ? "Saving…" : "Save category"}</button><button type="button" onClick={() => setEditing(null)} className="button">Cancel</button></div>
    </form>}
    <ul className="divide-y divide-black/10 border-y border-black/10 bg-white">
      {categories.map((category) => {
        const count = categoryInUse(category, items);
        return <li key={category.id} className="flex flex-wrap items-center gap-4 p-3">
          <div className="min-w-0 flex-1"><p className="font-bold">{category.name}</p><p className="text-sm text-ash">{count} item{count === 1 ? "" : "s"} · {category.isActive ? "Shown" : "Hidden"} · order {category.sortOrder}</p></div>
          <button onClick={() => setEditing({ category, isNew: false, previousName: category.name })} className="text-sm font-bold underline">Edit</button>
          {count > 0 ? <span className="text-sm text-ash">Move its items before deleting</span>
            : confirmDelete === category.id
              ? <span className="flex gap-2 text-sm"><button disabled={busy} onClick={() => void perform(() => deleteCategory(category.id), `${category.name} deleted.`)} className="font-bold text-red-800 underline">Delete {category.name}</button><button onClick={() => setConfirmDelete(null)} className="underline">Cancel</button></span>
              : <button onClick={() => setConfirmDelete(category.id)} className="text-sm text-red-800 underline">Delete</button>}
        </li>;
      })}
    </ul>
  </div>;
}
