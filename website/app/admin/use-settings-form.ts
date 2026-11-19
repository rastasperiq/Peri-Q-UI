"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAdminSettings, saveAdminSettings, validateSettings, type AdminSettings } from "@/lib/admin/settings";

/** Loads the settings row and saves the whole row, for the Special and Settings pages. */
export function useSettingsForm() {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setSettings(await fetchAdminSettings()); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load the store settings."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const set = <K extends keyof AdminSettings>(key: K, value: AdminSettings[K]) =>
    setSettings((current) => (current ? { ...current, [key]: value } : current));

  const save = async (done: string) => {
    if (!settings || busy) return;
    const invalid = validateSettings(settings);
    if (invalid) { setError(invalid); setMessage(null); return; }
    setBusy(true); setError(null); setMessage(null);
    try { await saveAdminSettings(settings); setMessage(done); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The settings were not saved."); }
    finally { setBusy(false); }
  };

  return { settings, set, save, error, message, busy, reload: load };
}
