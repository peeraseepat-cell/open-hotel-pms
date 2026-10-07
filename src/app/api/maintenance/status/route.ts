import { maintenanceApiError, requireMaintenanceAccess } from "@/lib/maintenance/api-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  task_id: z.string().uuid().optional(),
  include_renovation: z
    .enum(["1", "0", "true", "false"])
    .optional()
    .transform((value) => value === "1" || value === "true"),
});

type RpcRow = {
  room_id: string;
  room_number: string;
  room_type_code: string;
  task_id: string;
  task_name: string;
  threshold_count: number;
  warning_count: number | null;
  applicable_room_types: string[] | null;
  total_stays: number;
  last_stay_at: string | null;
  last_done_at: string | null;
  last_done_at_stay: number;
  stays_since_last: number;
  status: "OK" | "WARNING" | "OVERDUE";
};

type TaskDefinitionRow = {
  id: string;
  sync_to_housekeeper: boolean | null;
  checklist_items: string[] | null;
};

function roomNumberSortKey(roomNumber: string): string {
  return roomNumber ?? "";
}

function getStatusRank(status: "OK" | "WARNING" | "OVERDUE") {
  if (status === "OVERDUE") return 3;
  if (status === "WARNING") return 2;
  return 1;
}

function deriveFloorNumber(roomNumber: string): number {
  const firstDigit = roomNumber.trim().charAt(0);
  const floor = Number(firstDigit);
  if (!Number.isFinite(floor) || floor <= 0) return 0;
  return floor;
}

function isRenovationRoom(meta: { is_sellable: boolean; closure_reason: string | null } | undefined): boolean {
  if (!meta) return false;
  if (meta.is_sellable === false) return true;
  const reason = String(meta.closure_reason ?? "").toLowerCase();
  return /reno|renovat|ปรับปรุง|ซ่อม/.test(reason);
}

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await requireMaintenanceAccess(request, "read");
    const parsedQuery = querySchema.safeParse({
      task_id: request.nextUrl.searchParams.get("task_id") ?? undefined,
      include_renovation: request.nextUrl.searchParams.get("include_renovation") ?? undefined,
    });

    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: "Invalid query.", details: parsedQuery.error.flatten() },
        { status: 400 }
      );
    }

    const { data, error } = await supabase.rpc("get_room_maintenance_status");

    if (error) {
      console.error("maintenance/status GET rpc failed", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = ((data ?? []) as RpcRow[]).filter((row) => {
      if (!parsedQuery.data.task_id) return true;
      return row.task_id === parsedQuery.data.task_id;
    });

    const taskDefinitionById = new Map<
      string,
      {
        sync_to_housekeeper: boolean;
        checklist_items: string[] | null;
      }
    >();

    const taskIds = Array.from(new Set(rows.map((row) => row.task_id)));
    if (taskIds.length > 0) {
      const { data: taskRows, error: taskError } = await supabase
        .from("maintenance_tasks")
        .select("id, sync_to_housekeeper, checklist_items")
        .in("id", taskIds);

      if (taskError) {
        console.error("maintenance/status GET task definitions failed", taskError);
        return NextResponse.json({ error: taskError.message }, { status: 500 });
      }

      for (const row of (taskRows ?? []) as TaskDefinitionRow[]) {
        taskDefinitionById.set(String(row.id), {
          sync_to_housekeeper: Boolean(row.sync_to_housekeeper),
          checklist_items: Array.isArray(row.checklist_items) ? row.checklist_items : null,
        });
      }
    }

    const roomMap = new Map<
      string,
      {
        room_id: string;
        room_number: string;
        room_type_code: string;
        floor_number: number;
        tasks: Array<
          Omit<RpcRow, "room_id" | "room_number" | "room_type_code"> & {
            status: "OK" | "WARNING" | "OVERDUE";
            sync_to_housekeeper: boolean;
            checklist_items: string[] | null;
          }
        >;
      }
    >();

    for (const row of rows) {
      const roomId = row.room_id;
      if (!roomMap.has(roomId)) {
        roomMap.set(roomId, {
          room_id: roomId,
          room_number: row.room_number,
          room_type_code: row.room_type_code,
          floor_number: deriveFloorNumber(row.room_number),
          tasks: [],
        });
      }

      roomMap.get(roomId)?.tasks.push({
        task_id: row.task_id,
        task_name: row.task_name,
        threshold_count: row.threshold_count,
        warning_count: row.warning_count,
        applicable_room_types: row.applicable_room_types,
        total_stays: Number(row.total_stays ?? 0),
        last_stay_at: row.last_stay_at,
        last_done_at: row.last_done_at,
        last_done_at_stay: Number(row.last_done_at_stay ?? 0),
        stays_since_last: Number(row.stays_since_last ?? 0),
        status: row.status,
        sync_to_housekeeper: taskDefinitionById.get(String(row.task_id))?.sync_to_housekeeper ?? false,
        checklist_items: taskDefinitionById.get(String(row.task_id))?.checklist_items ?? null,
      });
    }

    const roomIds = Array.from(roomMap.keys());
    const roomMetaById = new Map<string, { is_sellable: boolean; closure_reason: string | null }>();
    if (roomIds.length > 0) {
      const { data: roomMetaRows, error: roomMetaError } = await supabase
        .from("rooms")
        .select("id, is_sellable, closure_reason")
        .in("id", roomIds);

      if (roomMetaError) {
        console.error("maintenance/status GET room meta failed", roomMetaError);
        return NextResponse.json({ error: roomMetaError.message }, { status: 500 });
      }

      for (const meta of roomMetaRows ?? []) {
        roomMetaById.set(String(meta.id), {
          is_sellable: Boolean(meta.is_sellable),
          closure_reason: meta.closure_reason ?? null,
        });
      }
    }

    const includeRenovation = Boolean(parsedQuery.data.include_renovation);
    const allRooms = Array.from(roomMap.values());
    const renovationHiddenCount = includeRenovation
      ? 0
      : allRooms.filter((room) => isRenovationRoom(roomMetaById.get(room.room_id))).length;

    const rooms = allRooms
      .filter((room) => {
        if (includeRenovation) return true;
        return !isRenovationRoom(roomMetaById.get(room.room_id));
      })
      .map((room) => {
        const meta = roomMetaById.get(room.room_id);
        return {
          ...room,
          is_sellable: meta?.is_sellable ?? true,
          closure_reason: meta?.closure_reason ?? null,
          is_renovation: isRenovationRoom(meta),
        };
      })
      .sort((a, b) => {
      if (a.floor_number !== b.floor_number) return a.floor_number - b.floor_number;
      return roomNumberSortKey(a.room_number).localeCompare(roomNumberSortKey(b.room_number), undefined, {
        numeric: true,
      });
    });

    const summary = { overdue: 0, warning: 0, ok: 0 };
    for (const room of rooms) {
      const worst = room.tasks.reduce<"OK" | "WARNING" | "OVERDUE">((acc, task) => {
        return getStatusRank(task.status) > getStatusRank(acc) ? task.status : acc;
      }, "OK");

      if (worst === "OVERDUE") summary.overdue += 1;
      else if (worst === "WARNING") summary.warning += 1;
      else summary.ok += 1;
    }

    return NextResponse.json({
      success: true,
      rooms,
      summary,
      filters: {
        include_renovation: includeRenovation,
        renovation_hidden_count: renovationHiddenCount,
      },
    });
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/status GET unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}
