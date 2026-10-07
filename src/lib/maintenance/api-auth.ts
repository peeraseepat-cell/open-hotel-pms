import { getAuthenticatedUser } from "@/lib/server-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasMaintenancePagePermission } from "./page-permission";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

// The maintenance API wall. Modelled on src/lib/linen/api-auth.ts.
//
// This is the ONLY role wall on /api/maintenance/*, not defense-in-depth:
// middleware.ts requires a session on mutating /api and 403s only `owner`, and its
// GET branch checks no role at all. The maid/mobile walls there are page-scoped
// (/pms, /maid, /linen-mobile) and never cover /api/maintenance/*.

export type MaintenanceAction = "read" | "write" | "delete";

export type MaintenanceActor = {
  userId: string;
  role: string | null;
  name: string | null;
  isAdmin: boolean;
  canWrite: boolean;
};

const READ_ROLES = new Set(["admin", "supervisor", "frontdesk"]);
const WRITE_ROLES = new Set(["admin", "supervisor"]);

// The page-permission predicate lives in ./page-permission.ts — ALIAS-FREE, so its
// contract test EXECUTES it rather than grepping this file for a regex. That move is
// the point: the previous source-grep pin here asserted `page === "*"` was present
// and could never answer "what does this return for a '*'-only profile?".
//
// ⚠ It no longer admits a blanket '*'. Product decision, 2026-07-18.

export async function requireMaintenanceAccess(
  request: NextRequest,
  action: MaintenanceAction = "read"
): Promise<{ supabase: SupabaseClient; actor: MaintenanceActor }> {
  const supabase = createServerSupabaseClient();
  const user = await getAuthenticatedUser(supabase, request);
  if (!user) {
    const error = new Error("Unauthorized");
    (error as any).status = 401;
    throw error;
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role, allowed_pages, full_name")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const role = String((profile as any)?.role ?? "").trim().toLowerCase() || null;

  // allowed_pages grants READ only. Write/delete stay role-gated, so a page grant can
  // never widen into a mutation right.
  const canRead = (role !== null && READ_ROLES.has(role)) || hasMaintenancePagePermission((profile as any)?.allowed_pages);
  const canWrite = role !== null && WRITE_ROLES.has(role);
  const isAdmin = role === "admin";

  let allowed: boolean;
  switch (action) {
    case "read":
      allowed = canRead;
      break;
    case "write":
      allowed = canWrite;
      break;
    case "delete":
      allowed = isAdmin;
      break;
    default:
      // Unknown action fails closed rather than falling through to read.
      allowed = false;
  }

  if (!allowed) {
    const error = new Error("Forbidden");
    (error as any).status = 403;
    throw error;
  }

  return {
    supabase,
    actor: {
      userId: user.id,
      role,
      name: String((profile as any)?.full_name ?? user.email ?? "").trim() || null,
      isAdmin,
      canWrite,
    },
  };
}

export function maintenanceApiError(error: unknown, fallback = "Internal server error") {
  const status = typeof (error as any)?.status === "number" ? (error as any).status : 500;
  const message = error instanceof Error ? error.message : fallback;
  return { status, message };
}
