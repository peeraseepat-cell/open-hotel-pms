import { extractScanOrderFromOcrRaw, requireDesktopGroupOcrAuth } from "@/lib/group-ocr";
import { ensureWizardStep, mergeDraftJson, pickBusinessDate } from "@/lib/group-checkin-wizard";
import { getBusinessDate, getWizardDraft, updateWizardDraftAtRevision, WizardDraftRevisionConflictError } from "@/lib/group-checkin-wizard-service";
import { MobileCheckinError } from "@/lib/mobile-checkin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const bodySchema = z.object({
  scan_ids: z.array(z.string().min(1)).optional(),
  business_date: z.string().optional(),
});

type ScanRow = {
  id: string;
  guest_profile_id: string | null;
  pool_status: "ready" | "ocr_failed" | "assigned";
  reservation_id: string | null;
  matched_reservation_id: string | null;
  guest_index: number | null;
  ocr_raw: unknown;
  created_at: string | null;
};

function rowsFromMutation(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"));
  return data && typeof data === "object" ? [data as Record<string, unknown>] : [];
}

function applyNullableFilter(query: any, column: string, value: unknown) {
  return value === null || value === undefined
    ? query.is(column, null)
    : query.eq(column, value);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ groupId: string }> }
) {
  try {
    const supabase = createServerSupabaseClient();
    await requireDesktopGroupOcrAuth(supabase, request);

    const { groupId } = await context.params;
    const normalizedGroupId = String(groupId ?? "").trim();
    if (!normalizedGroupId) {
      throw new MobileCheckinError("Missing group id.", 400, "GROUP_ID_REQUIRED");
    }

    const { data: group, error: groupError } = await supabase
      .from("booking_groups")
      .select("id")
      .eq("id", normalizedGroupId)
      .maybeSingle();

    if (groupError) {
      throw new MobileCheckinError(groupError.message, 500, "GROUP_READ_FAILED");
    }
    if (!group) {
      throw new MobileCheckinError("Group not found.", 404, "GROUP_NOT_FOUND");
    }

    const json = await request.json().catch(() => ({}));
    const parsedBody = bodySchema.safeParse(json);
    if (!parsedBody.success) {
      throw new MobileCheckinError("Invalid payload.", 400, "INVALID_PAYLOAD");
    }

    const requestedScanIds = Array.from(
      new Set((parsedBody.data.scan_ids ?? []).map((value) => String(value).trim()).filter(Boolean))
    );

    const fallbackBusinessDate = await getBusinessDate(supabase, null);
    const businessDate = pickBusinessDate(parsedBody.data.business_date, fallbackBusinessDate);

    const draft = await getWizardDraft(supabase, normalizedGroupId, businessDate);
    if (!draft || String(draft.status ?? "") !== "draft") {
      throw new MobileCheckinError(
        "Open Group Wizard on Desktop first.",
        409,
        "WIZARD_DRAFT_REQUIRED"
      );
    }

    let scanQuery = supabase
      .from("passport_scans")
      .select("id, guest_profile_id, pool_status, reservation_id, matched_reservation_id, guest_index, ocr_raw, created_at")
      .eq("booking_group_id", normalizedGroupId)
      .not("pool_status", "is", null)
      .order("created_at", { ascending: true });

    if (requestedScanIds.length > 0) {
      scanQuery = scanQuery.in("id", requestedScanIds);
    } else {
      scanQuery = scanQuery.eq("pool_status", "ready");
    }

    const { data: scanRowsRaw, error: scanError } = await scanQuery;
    if (scanError) {
      throw new MobileCheckinError(scanError.message, 500, "SCAN_READ_FAILED");
    }

    const scanRows: ScanRow[] = (scanRowsRaw ?? [])
      .map((row: any) => ({
        id: String(row.id ?? ""),
        guest_profile_id: row.guest_profile_id ? String(row.guest_profile_id) : null,
        pool_status: String(row.pool_status ?? "") as "ready" | "ocr_failed" | "assigned",
        reservation_id: row.reservation_id ? String(row.reservation_id) : null,
        matched_reservation_id: row.matched_reservation_id ? String(row.matched_reservation_id) : null,
        guest_index: row.guest_index === null || row.guest_index === undefined ? null : Number(row.guest_index),
        ocr_raw: row.ocr_raw ?? null,
        created_at: row.created_at ? String(row.created_at) : null,
      }))
      .filter((row) => row.id);

    const skippedReasons: string[] = [];

    if (requestedScanIds.length > 0) {
      const foundSet = new Set(scanRows.map((row) => row.id));
      requestedScanIds.forEach((id) => {
        if (!foundSet.has(id)) skippedReasons.push(`scan ${id}: not found in this group`);
      });
    }

    const draftJson = draft?.draft_json && typeof draft.draft_json === "object"
      ? (draft.draft_json as Record<string, any>)
      : {};

    const existingScannedPool = Array.isArray((draftJson as any)?.step2?.scanned_pool)
      ? (draftJson as any).step2.scanned_pool
      : [];

    const existingGuestIds = new Set<string>();
    existingScannedPool.forEach((item: any) => {
      const id = String(item?.guest_profile_id ?? "").trim();
      if (id) existingGuestIds.add(id);
    });

    const legacyIds = Array.isArray((draftJson as any)?.step2?.scanned_guest_profile_ids)
      ? (draftJson as any).step2.scanned_guest_profile_ids
      : [];
    legacyIds.forEach((value: unknown) => {
      const id = String(value ?? "").trim();
      if (id) existingGuestIds.add(id);
    });

    const dedupeByGuest = new Map<string, ScanRow>();
    const candidateRows = scanRows;

    for (const scan of candidateRows) {
      if (scan.pool_status !== "ready") {
        skippedReasons.push(`scan ${scan.id}: status ${scan.pool_status}`);
        continue;
      }
      if (!scan.guest_profile_id) {
        skippedReasons.push(`scan ${scan.id}: missing guest_profile_id`);
        continue;
      }
      if (existingGuestIds.has(scan.guest_profile_id)) {
        skippedReasons.push(`scan ${scan.id}: guest already in wizard pool`);
        continue;
      }

      const existing = dedupeByGuest.get(scan.guest_profile_id);
      if (!existing) {
        dedupeByGuest.set(scan.guest_profile_id, scan);
        continue;
      }

      const existingCreated = existing.created_at ?? "";
      const nextCreated = scan.created_at ?? "";
      if (nextCreated && (!existingCreated || nextCreated < existingCreated)) {
        skippedReasons.push(`scan ${existing.id}: duplicate guest profile`);
        dedupeByGuest.set(scan.guest_profile_id, scan);
      } else {
        skippedReasons.push(`scan ${scan.id}: duplicate guest profile`);
      }
    }

    const importRows = Array.from(dedupeByGuest.values()).sort((a, b) => {
      const aDate = a.created_at ?? "";
      const bDate = b.created_at ?? "";
      return aDate.localeCompare(bDate);
    });

    const importGuestIds = importRows
      .map((row) => row.guest_profile_id)
      .filter((value): value is string => Boolean(value));

    const profileById = new Map<string, any>();
    if (importGuestIds.length > 0) {
      const { data: profileRows, error: profileError } = await supabase
        .from("guest_profiles")
        .select("id, first_name, last_name, member_no, profile_status, nationality_code")
        .in("id", importGuestIds);

      if (profileError) {
        throw new MobileCheckinError(profileError.message, 500, "PROFILE_READ_FAILED");
      }

      for (const profile of profileRows ?? []) {
        const id = String((profile as any).id ?? "").trim();
        if (!id) continue;
        profileById.set(id, profile as any);
      }
    }

    const candidateEntries = importRows
      .map((scan, index) => {
        const guestId = String(scan.guest_profile_id ?? "").trim();
        const profile = profileById.get(guestId);
        if (!guestId || !profile) {
          skippedReasons.push(`scan ${scan.id}: guest profile not found`);
          return null;
        }

        const first = String(profile.first_name ?? "").trim();
        const last = String(profile.last_name ?? "").trim();
        const memberNo = String(profile.member_no ?? "").trim();
        const fullName = `${first} ${last}`.trim();
        const displayName = fullName || (memberNo ? `Member ${memberNo}` : guestId);

        return {
          scan_id: scan.id,
          guest_profile_id: guestId,
          source: "passport_ocr" as const,
          scan_order: extractScanOrderFromOcrRaw(scan.ocr_raw, index + 1),
          display_name: displayName,
          profile_status: profile.profile_status ? String(profile.profile_status) : null,
          nationality_code: profile.nationality_code ? String(profile.nationality_code) : null,
        };
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value));

    const importedEntries = candidateEntries;

    const mergedScannedPool = [
      ...existingScannedPool,
      ...importedEntries,
    ];

    const mergedGuestIds = Array.from(
      new Set([
        ...existingGuestIds,
        ...importedEntries.map((entry) => entry.guest_profile_id),
      ])
    );

    const mergedDraftJson = mergeDraftJson(
      draftJson,
      {
        step2: {
          scanned_pool: mergedScannedPool,
          scanned_guest_profile_ids: mergedGuestIds,
        },
      }
    );

    const importedScanIds = importedEntries
      .map((entry) => entry.scan_id)
      .filter((value): value is string => Boolean(value));
    let savedDraft: any = null;
    try {
      savedDraft = await updateWizardDraftAtRevision({
        supabase,
        groupId: normalizedGroupId,
        businessDate,
        expectedRevision: String(draft.updated_at ?? ""),
        status: "draft",
        currentStep: ensureWizardStep(draft.current_step ?? 2, 2),
        draftJson: mergedDraftJson,
        touchCommittedAt: true,
      });
      if (importedScanIds.length > 0) {
        const { data: markedData, error: markError } = await supabase
          .from("passport_scans")
          .update({ pool_status: "assigned" })
          .in("id", importedScanIds)
          .eq("booking_group_id", normalizedGroupId)
          .eq("pool_status", "ready")
          .select("id, pool_status, guest_profile_id");

        const markedRows = rowsFromMutation(markedData);
        const expectedById = new Map(importRows.map((row) => [row.id, row]));
        const markedIds = new Set(markedRows.map((row) => String(row.id ?? "")).filter(Boolean));
        const markMatchesExactly = !markError
          && markedRows.length === importedScanIds.length
          && markedIds.size === importedScanIds.length
          && importedScanIds.every((scanId) => {
            const row = markedRows.find((candidate) => String(candidate.id ?? "") === scanId);
            const expected = expectedById.get(scanId);
            return Boolean(
              row
              && expected
              && String(row.pool_status ?? "") === "assigned"
              && String(row.guest_profile_id ?? "") === String(expected.guest_profile_id ?? ""),
            );
          });

        if (!markMatchesExactly) {
          const scanRollbackOk = await Promise.all(
            Array.from(markedIds).map(async (scanId) => {
              const expected = expectedById.get(scanId);
              if (!expected) return false;
              let rollbackQuery = supabase
                .from("passport_scans")
                .update({ pool_status: "ready" })
                .eq("id", scanId)
                .eq("booking_group_id", normalizedGroupId)
                .eq("guest_profile_id", expected.guest_profile_id)
                .eq("pool_status", "assigned");
              rollbackQuery = applyNullableFilter(rollbackQuery, "reservation_id", expected.reservation_id);
              rollbackQuery = applyNullableFilter(rollbackQuery, "matched_reservation_id", expected.matched_reservation_id);
              rollbackQuery = rollbackQuery.eq("guest_index", expected.guest_index ?? 0);
              const { data, error } = await rollbackQuery
                .select("id, pool_status, guest_profile_id, reservation_id, matched_reservation_id, guest_index");
              const rows = rowsFromMutation(data);
              return !error
                && rows.length === 1
                && String(rows[0]?.id ?? "") === scanId
                && String(rows[0]?.pool_status ?? "") === "ready";
            }),
          ).then((results) => results.every(Boolean));

          let draftRollbackOk = true;
          try {
            await updateWizardDraftAtRevision({
              supabase,
              groupId: normalizedGroupId,
              businessDate,
              expectedRevision: String(savedDraft.updated_at ?? ""),
              status: "draft",
              currentStep: ensureWizardStep(draft.current_step ?? 2, 2),
              draftJson,
              touchCommittedAt: true,
            });
          } catch {
            draftRollbackOk = false;
          }
          if (!scanRollbackOk || !draftRollbackOk) {
            throw new MobileCheckinError(
              "Import could not mark scans assigned or restore the Wizard Pool.",
              500,
              "SCAN_MARK_ASSIGNED_ROLLBACK_FAILED",
            );
          }
          throw new MobileCheckinError(
            markError?.message ?? "One or more scans changed before import completed.",
            markError ? 500 : 409,
            markError ? "SCAN_MARK_ASSIGNED_FAILED" : "SCAN_MARK_ASSIGNED_CONFLICT",
          );
        }
      }
    } catch (error) {
      if (error instanceof WizardDraftRevisionConflictError) throw error;
      throw error;
    }

    return NextResponse.json({
      success: true,
      draft_revision: savedDraft?.updated_at ?? null,
      imported_count: importedScanIds.length,
      imported_scan_ids: importedScanIds,
      skipped_count: skippedReasons.length,
      skipped_reasons: skippedReasons,
    });
  } catch (error) {
    if (error instanceof WizardDraftRevisionConflictError) {
      return NextResponse.json(
        { success: false, error: error.message, code: "DRAFT_REVISION_CONFLICT" },
        { status: 409 },
      );
    }
    if (error instanceof MobileCheckinError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          code: error.code,
        },
        { status: error.status }
      );
    }

    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
