// Server-only: refuse payment and data writes when this deployment's
// environment, database and payment keys do not agree.

import { NextResponse } from "next/server";
import { verifyEnvironment, type EnvironmentStatus } from "@/lib/environment";
import { createServiceClient, readServerSupabaseConfig } from "@/lib/supabase";

export function checkEnvironment(options?: { fresh?: boolean }): Promise<EnvironmentStatus> {
  return verifyEnvironment(() => (readServerSupabaseConfig() ? createServiceClient() : null), options);
}

/** null when it is safe to continue; otherwise the 503 response to return. */
export async function environmentBlock(): Promise<NextResponse | null> {
  const status = await checkEnvironment();
  if (status.ok) return null;
  return NextResponse.json(
    { error: "This service is temporarily unavailable. Please try again later.", code: "environment_mismatch" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
