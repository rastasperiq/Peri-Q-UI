"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAdminAccess } from "@/lib/admin/use-admin";
import { signInCustomer, signOutCustomer } from "@/lib/customer-account";
import { useCart } from "@/lib/cart";
import type { AppEnvironment } from "@/lib/environment";

export const adminField = "mt-2 w-full rounded-xl border border-black/20 bg-white px-4 py-3 text-base focus:border-peri-red focus:outline-none focus:ring-2 focus:ring-peri-red/20";

const TABS = [
  { href: "/admin/", label: "Orders" },
  { href: "/admin/menu/", label: "Menu" },
  { href: "/admin/categories/", label: "Categories" },
  { href: "/admin/special/", label: "Today's Special" },
  { href: "/admin/settings/", label: "Store settings" },
];

function isCurrent(pathname: string, href: string) {
  const path = pathname.endsWith("/") ? pathname : `${pathname}/`;
  return href === "/admin/" ? path === "/admin/" : path.startsWith(href);
}

export default function AdminShell({ environment, children }: { environment: AppEnvironment; children: React.ReactNode }) {
  const { state, email, retry } = useAdminAccess();
  const pathname = usePathname() ?? "/admin/";
  const { clear } = useCart();
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const signOut = async () => {
    setSignOutError(null);
    try { await signOutCustomer(); clear(); }
    catch { setSignOutError("Could not sign out. Please try again."); }
  };

  return <main id="main-content" className="min-h-[70vh] bg-cream">
    <section className="stage py-6"><div className="site-shell flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="font-display text-3xl font-black uppercase sm:text-4xl">Owner dashboard</h1>
        {email && state === "admin" && <p className="mt-1 break-all text-sm text-white/70">{email}</p>}
      </div>
      <span data-testid="admin-environment" className={`rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide ${environment === "live" ? "bg-leaf text-white" : "bg-[#ff7a00] text-black"}`}>
        {environment === "live" ? "Live · real orders" : "Test · not real orders"}
      </span>
    </div></section>
    {state === "admin" && <nav aria-label="Admin sections" className="border-b border-black/10 bg-white">
      <div className="site-shell flex items-center gap-1 overflow-x-auto py-2">
        {TABS.map((tab) => <Link key={tab.href} href={tab.href} aria-current={isCurrent(pathname, tab.href) ? "page" : undefined}
          className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold ${isCurrent(pathname, tab.href) ? "bg-peri-red text-white" : "hover:bg-black/5"}`}>{tab.label}</Link>)}
        <button onClick={() => void signOut()} className="ml-auto whitespace-nowrap px-3 py-2 text-sm underline">Sign out</button>
      </div>
    </nav>}
    <div className="site-shell py-8">
      {signOutError && <p role="alert" className="mb-4 text-red-800">{signOutError}</p>}
      {state === "loading" && <p role="status">Checking your account…</p>}
      {state === "unconfigured" && <p role="alert">The dashboard is unavailable: the database is not configured for this site.</p>}
      {state === "error" && <p role="alert">Could not check your account. <button onClick={retry} className="underline">Try again</button></p>}
      {state === "signed-out" && <AdminSignIn />}
      {state === "not-admin" && <div role="alert" className="max-w-lg border border-black/10 bg-white p-6">
        <p className="font-bold">This account is not an admin.</p>
        <p className="mt-2 text-sm text-ash">Sign in with the owner&apos;s admin account to use the dashboard.</p>
        <button onClick={() => void signOut()} className="button button-primary mt-5">Sign out</button>
      </div>}
      {state === "admin" && children}
    </div>
  </main>;
}

function AdminSignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try { await signInCustomer(email, password); setPassword(""); }
    catch { setError("Sign-in failed. Check the email and password and try again."); }
    finally { setBusy(false); }
  };
  return <form onSubmit={(event) => void submit(event)} className="grid max-w-lg gap-5 border border-black/10 bg-white p-6 sm:p-8">
    <h2 className="font-display text-2xl font-bold uppercase">Admin sign in</h2>
    <p className="text-sm text-ash">Use the same admin email and password as the mobile app.</p>
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">{error}</p>}
    <label className="font-bold">Email address<input className={adminField} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    <label className="font-bold">Password<input className={adminField} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    <button disabled={busy} className="button button-primary justify-center disabled:opacity-50">{busy ? "Signing in…" : "Sign in"}</button>
    <Link href="/account/" className="text-sm underline">Forgot password? Reset it on the account page</Link>
  </form>;
}
