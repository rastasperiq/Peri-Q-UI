import { NextResponse } from "next/server";
import { checkEnvironment } from "@/lib/environment-guard";
import { getSiteUrl } from "@/lib/yoco";
import { createServiceClient, readServerSupabaseConfig } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

// GET with an admin's session token. Returns non-secret environment details
// for the admin dashboard: no keys, passwords or connection strings.
export async function GET(req: Request) {
  if (!readServerSupabaseConfig()) {
    return NextResponse.json({ error: "Not configured." }, { status: 503, headers: noStore });
  }
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return NextResponse.json({ error: "Sign in as an administrator." }, { status: 401, headers: noStore });

  const svc = createServiceClient();
  const { data: auth, error: authError } = await svc.auth.getUser(token);
  if (authError || !auth.user) {
    return NextResponse.json({ error: "Sign in as an administrator." }, { status: 401, headers: noStore });
  }
  const { data: profile } = await svc.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Administrators only." }, { status: 403, headers: noStore });
  }

  const status = await checkEnvironment({ fresh: true });
  return NextResponse.json(
    {
      environment: status.environment,
      environmentInferred: status.inferred,
      databaseProvider: status.database.provider,
      databaseProjectRef: status.projectRef,
      databaseMarker: status.database.marker?.environment ?? null,
      databaseStatus: status.database.status,
      lastDatabaseCheckAt: status.database.lastSuccessAt,
      checkedAt: status.database.checkedAt,
      applicationUrl: getSiteUrl(),
      paymentGatewayMode: status.paymentMode,
      authEnvironment: status.projectRef ? `Supabase Auth (${status.projectRef})` : null,
      ok: status.ok,
      issues: status.issues,
    },
    { headers: noStore },
  );
}
