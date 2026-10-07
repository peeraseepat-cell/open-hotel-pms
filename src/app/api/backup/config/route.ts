import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  BackupHttpError,
  canReadBackupConfigPinHash,
  getBackupConfigPublicPayload,
  requireAdminAccess,
  updateBackupConfig,
} from "@/lib/backup";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const patchSchema = z
  .object({
    retention_days: z.coerce.number().int().min(1).max(365).optional(),
    offline_pin: z.union([z.string().regex(/^\d{4}$/), z.null()]).optional(),
  })
  .refine((value) => value.retention_days !== undefined || value.offline_pin !== undefined, {
    message: "Provide retention_days or offline_pin.",
  });

export async function GET(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const includePinHash = await canReadBackupConfigPinHash(supabase, request);
    const config = await getBackupConfigPublicPayload(supabase, { includePinHash });
    return NextResponse.json({ success: true, data: config });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load backup config.";
    console.error("api/backup/config GET failed", error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    await requireAdminAccess(supabase, request);

    const config = await updateBackupConfig(supabase, parsed.data);
    return NextResponse.json({
      success: true,
      data: {
        retention_days: config.retention_days,
        r2_bucket: config.r2_bucket,
        updated_at: config.updated_at,
        pin_hash: config.offline_pin,
        has_pin: Boolean(config.offline_pin),
        device_pairing_required: true,
      },
    });
  } catch (error) {
    const status = error instanceof BackupHttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Failed to update backup config.";
    console.error("api/backup/config PATCH failed", error);
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
