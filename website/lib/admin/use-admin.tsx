"use client";
// Who may see the admin pages. This is for the page only: the database's
// is_admin() rules are what actually protect every read and write.

import { useEffect, useState } from "react";
import { useCustomerAuth } from "../customer-auth";
import { createBrowserClient, isSupabaseConfigured } from "../supabase";

export type AdminAccessState = "loading" | "signed-out" | "not-admin" | "admin" | "error" | "unconfigured";

export function useAdminAccess(): { state: AdminAccessState; email: string | null; retry: () => void } {
  const { user, loading } = useCustomerAuth();
  const [role, setRole] = useState<{ userId: string; value: string | null | "error" } | null>(null);
  const [revision, setRevision] = useState(0);
  const userId = user && !user.is_anonymous ? user.id : null;

  useEffect(() => {
    if (!userId) return;
    let active = true;
    void createBrowserClient().from("profiles").select("role").eq("id", userId).maybeSingle()
      .then(({ data, error }) => {
        if (active) setRole({ userId, value: error ? "error" : ((data?.role as string | undefined) ?? null) });
      }, () => { if (active) setRole({ userId, value: "error" }); });
    return () => { active = false; };
  }, [userId, revision]);

  const retry = () => { setRole(null); setRevision((value) => value + 1); };
  const email = userId ? (user?.email ?? null) : null;
  if (!isSupabaseConfigured()) return { state: "unconfigured", email, retry };
  if (loading) return { state: "loading", email, retry };
  if (!userId) return { state: "signed-out", email, retry };
  if (!role || role.userId !== userId) return { state: "loading", email, retry };
  if (role.value === "error") return { state: "error", email, retry };
  return { state: role.value === "admin" ? "admin" : "not-admin", email, retry };
}
