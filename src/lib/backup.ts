import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";
import { NextRequest } from "next/server";
import {
  applyVisibleTotal,
  fetchReservationOutstandingBalances,
  fetchReservationVisibleTotals,
} from "@/lib/reservation-visible-total";
import { getAuthenticatedUser, getUserRole, type AuthUser } from "@/lib/server-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

type SupabaseServerClient = ReturnType<typeof createServerSupabaseClient>;

export type BackupLogRow = {
  id: string;
  backup_type: "daily_cloud" | "offline_snapshot";
  status: "started" | "success" | "failed";
  file_name: string | null;
  file_size_bytes: number | null;
  record_count: number | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  duration_ms: number | null;
};

export type BackupConfigRow = {
  id: number;
  offline_pin: string | null;
  r2_bucket: string;
  retention_days: number;
  updated_at: string;
};

type TableDump = {
  row_count: number;
  rows: Array<Record<string, unknown>>;
};

export type DailyCloudBackupMode = "auto" | "full" | "incremental";
type ResolvedDailyCloudBackupMode = Exclude<DailyCloudBackupMode, "auto">;
type BackupTimestampColumn = "updated_at" | "created_at";

type SkippedBackupTable = {
  table: string;
  reason: string;
};

type BackupTableExportResult =
  | { kind: "exported"; entry: { table: string; dump: TableDump } }
  | { kind: "skipped"; skipped: SkippedBackupTable };

type DailyBackupPayload = {
  version: 2;
  backup_mode: ResolvedDailyCloudBackupMode;
  base_full_started_at: string | null;
  watermark_started_at: string | null;
  skipped_tables: SkippedBackupTable[];
  exported_at: string;
  exported_timezone: string;
  schema: "public";
  tables: Record<string, TableDump>;
};

type SnapshotReservation = {
  id: string;
  booking_code: string | null;
  guest_name: string | null;
  guest_phone: string | null;
  guest_email: string | null;
  room_number: string | null;
  room_numbers: string[];
  checkin_date: string;
  checkout_date: string;
  status: string;
  adults: number;
  children: number;
  total_price: number;
  outstanding_balance: number;
  category: "arrival" | "in_house" | "departure";
};

type SnapshotRoom = {
  id: string;
  room_number: string;
  room_type: string;
  floor: number;
  is_sellable: boolean;
  closure_reason: string | null;
};

type SnapshotHousekeepingStatus = {
  room_id: string;
  room_number: string;
  status: string;
  maid_name: string | null;
};

type SnapshotRoomStatus = {
  room_id: string;
  room_number: string;
  floor: number;
  room_type: string;
  occupancy_status: "vacant" | "arrival" | "in_house" | "departure";
  housekeeping_status: string | null;
  maid_name: string | null;
  guest_name: string | null;
  booking_code: string | null;
  checkin_date: string | null;
  checkout_date: string | null;
  total_price: number;
  outstanding_balance: number;
};

export type OfflineSnapshotData = {
  generated_at: string;
  date_range: { from: string; to: string };
  business_date: string;
  rooms: SnapshotRoom[];
  reservations: SnapshotReservation[];
  arrivals: SnapshotReservation[];
  in_house: SnapshotReservation[];
  departures: SnapshotReservation[];
  hk_status: SnapshotHousekeepingStatus[];
  room_status: SnapshotRoomStatus[];
};

export type OfflineSnapshotRow = {
  id: string;
  snapshot_date: string;
  snapshot_data: OfflineSnapshotData;
  record_count: number;
  created_at: string;
};

export type BackupStorageSummary = {
  bucket: string;
  file_count: number;
  total_bytes: number;
  oldest_file_key: string | null;
  oldest_file_date: string | null;
};

export type UiEventLogArchiveRunRow = {
  id: string;
  status: "started" | "succeeded" | "failed";
  archive_cutoff_at: string;
  row_count: number;
  archived_count: number;
  deleted_count: number;
  r2_keys: string[];
  event_counts: Record<string, number>;
  category_counts: Record<string, number>;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
};

export type BackupStatusPayload = {
  config: {
    retention_days: number;
    r2_bucket: string;
    updated_at: string;
    has_pin: boolean;
    device_pairing_required: boolean;
  };
  pin_hash: string | null;
  latest_cloud_backup: BackupLogRow | null;
  latest_offline_sync: BackupLogRow | null;
  history: BackupLogRow[];
  activity_log_archives: UiEventLogArchiveRunRow[];
  storage: BackupStorageSummary;
};

export type PairingTokenIssueResult = {
  pairing_token: string;
  device_name: string;
  expires_at: string;
};

export type DevicePairingResult = {
  device_id: string;
  device_name: string;
  device_token: string;
  paired_at: string;
};

export type DailyBackupRunResult = {
  log_id: string;
  object_key: string;
  backup_mode: ResolvedDailyCloudBackupMode;
  base_full_started_at: string | null;
  watermark_started_at: string | null;
  skipped_tables: SkippedBackupTable[];
  file_size_bytes: number;
  record_count: number;
  storage: BackupStorageSummary;
  deleted_keys: string[];
};

export type SnapshotRunResult = {
  log_id: string;
  snapshot_id: string;
  snapshot_date: string;
  record_count: number;
  created_at: string;
};

const BANGKOK_TIME_ZONE = "Asia/Bangkok";
const BACKUP_EXPORT_BATCH_SIZE = 1000;
const BACKUP_HISTORY_LIMIT = 30;
const BACKUP_STALE_STARTED_MINUTES = 30;
const FULL_BACKUP_INTERVAL_DAYS = 7;
const BACKUP_WATERMARK_OVERLAP_MINUTES = 5;
const SNAPSHOT_KEEP_ROWS = 3;
const DAILY_BACKUP_PREFIX = "daily/";
const DAILY_FULL_BACKUP_PREFIX = `${DAILY_BACKUP_PREFIX}full/`;
const DAILY_INCREMENTAL_BACKUP_PREFIX = `${DAILY_BACKUP_PREFIX}incremental/`;
const DAILY_BACKUP_TABLES = [
  "profiles",
  "room_types",
  "rooms",
  "room_layouts",
  "rate_templates",
  "reservations",
  "reservation_nights",
  "housekeeping_tasks",
  "housekeeping_logs",
  "audit_logs",
  "hotel_settings",
  "daily_snapshots",
  "folio_payments",
  "rate_change_log",
  "room_features",
  "room_feature_mapping",
  "reservation_preferences",
  "room_blocks",
  "guest_profiles",
  "alert_codes",
  "reservation_alerts",
  "loan_items",
  "reservation_traces",
  "bed_types",
  "room_beds",
  "room_detail",
  "condition_deduction_templates",
  "room_condition_deductions",
  "room_stay_history",
  "scoring_config",
  "booking_groups",
  "rate_plans",
  "checklist_templates",
  "daily_plans",
  "extra_task_templates",
  "extra_task_assignments",
  "stock_items",
  "maid_cart_items",
  "stock_transactions",
  "maintenance_tasks",
  "maintenance_logs",
  "maintenance_notes",
  "maintenance_task_times",
  "maintenance_assignments",
  "maintenance_assignment_checklist_results",
  "products",
  "main_stock",
  "floor_stock",
  "stock_transactions_v2",
  "pos_orders",
  "pos_order_items",
  "fo_prepare_batches",
  "fo_prepare_batch_items",
  "boat_companies",
  "boat_piers",
  "boat_routes",
  "drivers",
  "vehicles",
  "transfers",
  "driver_ratings",
  "transfer_notifications",
  "transfer_vouchers",
  "transfer_transactions",
  "commission_ledger",
  "tip_ledger",
  "profile_match_scores",
  "reservation_guests",
  "departments",
  "staff",
  "line_binding_tokens",
  "hk_staff_lanes",
  "staff_shifts",
  "logbook_notes",
  "logbook_note_links",
  "logbook_note_mentions",
  "reservation_room_plans",
  "group_checkin_wizard_drafts",
  "extra_fee_templates",
  "rate_plan_tiers",
  "rate_plan_profiles",
  "alert_templates",
  "trace_templates",
  "bug_reports",
  "roster_config",
  "monthly_audit_periods",
  "monthly_audit_entries",
  "monthly_audit_corrections",
  "admin_corrections",
  "guest_tax_profiles",
  "invoices",
  "receipts",
  "passport_scans",
  "legacy_stays",
  "cleanup_logs",
  "scb_payment_requests",
  "scb_payment_transactions",
  "scb_recheck_logs",
  "scb_payment_notifications",
  "scb_notification_reads",
  "guest_profile_conflict_events",
  "tm30_report_exclusions",
  "guest_profile_booking_names",
  "ui_event_logs",
  "lost_found_items",
  "guest_vehicles",
  "housekeeping_amenity_ledger",
  "backup_logs",
  "backup_snapshots",
  "backup_config",
] as const;

export class BackupHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function asDateString(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function asTimeString(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}${minute}`;
}

function shiftDateString(baseDate: string, dayDelta: number): string {
  const parsed = new Date(`${baseDate}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + dayDelta);
  return parsed.toISOString().slice(0, 10);
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toFloorNumber(roomNumber: string | null, floorNumber: unknown): number {
  const parsedFloor = Number(floorNumber ?? Number.NaN);
  if (Number.isFinite(parsedFloor)) return parsedFloor;
  if (!roomNumber) return 0;
  const digits = roomNumber.replace(/\D+/g, "");
  return digits.length >= 3 ? toNumber(digits.slice(0, digits.length - 2)) : 0;
}

function toRoomSortKey(roomNumber: string): string {
  return roomNumber.padStart(6, "0");
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("hex");
}

function normalizeDeviceName(value: string | null | undefined, fallback = "FO Device"): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, 80) : fallback;
}

function parseObjectDate(key: string): string | null {
  const match = key.match(/(\d{4}-\d{2}-\d{2})_/);
  return match?.[1] ?? null;
}

function isLegacyFullBackupFile(fileName: string): boolean {
  return /^daily\/\d{4}-\d{2}-\d{2}_\d{4}\.json\.gz$/.test(fileName);
}

function isFullBackupFile(fileName: string | null): boolean {
  if (!fileName) return false;
  return fileName.startsWith(DAILY_FULL_BACKUP_PREFIX) || isLegacyFullBackupFile(fileName);
}

function subtractMinutes(dateString: string, minutes: number): string {
  const parsed = new Date(dateString);
  if (Number.isNaN(parsed.getTime())) return dateString;
  return new Date(parsed.getTime() - minutes * 60 * 1000).toISOString();
}

function isOlderThanDays(dateString: string, days: number): boolean {
  const parsed = new Date(dateString);
  if (Number.isNaN(parsed.getTime())) return true;
  return Date.now() - parsed.getTime() >= days * 24 * 60 * 60 * 1000;
}

function normalizeBackupLogRow(row: any): BackupLogRow {
  const startedAt = String(row?.started_at ?? row?.created_at ?? "");
  const completedAt = row?.completed_at ? String(row.completed_at) : null;
  return {
    id: String(row?.id ?? ""),
    backup_type: String(row?.backup_type ?? "daily_cloud") as BackupLogRow["backup_type"],
    status: String(row?.status ?? "started") as BackupLogRow["status"],
    file_name: row?.file_name ? String(row.file_name) : null,
    file_size_bytes: row?.file_size_bytes === null || row?.file_size_bytes === undefined ? null : Number(row.file_size_bytes),
    record_count: row?.record_count === null || row?.record_count === undefined ? null : Number(row.record_count),
    error_message: row?.error_message ? String(row.error_message) : null,
    started_at: startedAt,
    completed_at: completedAt,
    created_at: String(row?.created_at ?? startedAt),
    duration_ms:
      startedAt && completedAt
        ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
        : null,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function requireEnv(name: string): string {
  const value = String(process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function getR2Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: requireEnv("R2_ENDPOINT"),
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
  });
}

async function listAllObjects(client: S3Client, bucket: string): Promise<_Object[]> {
  const objects: _Object[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      })
    );
    objects.push(...(response.Contents ?? []));
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

async function uploadBufferToR2(params: {
  bucket: string;
  key: string;
  buffer: Buffer;
}): Promise<void> {
  const client = getR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: params.buffer,
      ContentType: "application/json",
      ContentEncoding: "gzip",
    })
  );
}

async function getStorageSummary(bucket: string): Promise<BackupStorageSummary> {
  const objects = await listAllObjects(getR2Client(), bucket);
  const sorted = [...objects].sort((left, right) => {
    const leftTime = left.LastModified?.getTime() ?? 0;
    const rightTime = right.LastModified?.getTime() ?? 0;
    return leftTime - rightTime;
  });
  const oldest = sorted[0] ?? null;
  return {
    bucket,
    file_count: objects.length,
    total_bytes: objects.reduce((sum, item) => sum + Number(item.Size ?? 0), 0),
    oldest_file_key: oldest?.Key ?? null,
    oldest_file_date: oldest?.Key ? parseObjectDate(oldest.Key) : null,
  };
}

async function cleanupExpiredBackups(bucket: string, retentionDays: number): Promise<string[]> {
  const client = getR2Client();
  const objects = await listAllObjects(client, bucket);
  const cutoffDate = shiftDateString(asDateString(new Date()), -Math.max(1, retentionDays));
  const expired = objects
    .filter((item) => String(item.Key ?? "").startsWith(DAILY_BACKUP_PREFIX))
    .filter((item) => {
      const fileDate = item.Key ? parseObjectDate(item.Key) : null;
      return Boolean(fileDate && fileDate < cutoffDate);
    });

  if (expired.length === 0) return [];

  await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: expired
          .map((item) => item.Key)
          .filter((key): key is string => Boolean(key))
          .map((key) => ({ Key: key })),
        Quiet: true,
      },
    })
  );

  return expired
    .map((item) => item.Key)
    .filter((key): key is string => Boolean(key));
}

async function ensureBackupConfig(supabase: SupabaseServerClient): Promise<BackupConfigRow> {
  const { error: insertError } = await supabase
    .from("backup_config")
    .upsert(
      {
        id: 1,
        r2_bucket: String(process.env.R2_BUCKET_NAME ?? "pms-backups").trim() || "pms-backups",
        retention_days: 60,
      },
      { onConflict: "id" }
    );
  if (insertError) {
    throw new Error(insertError.message);
  }

  const { data, error } = await supabase
    .from("backup_config")
    .select("id, offline_pin, r2_bucket, retention_days, updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    throw new Error("backup_config row is missing.");
  }

  return {
    id: Number(data.id ?? 1),
    offline_pin: data.offline_pin ? String(data.offline_pin) : null,
    r2_bucket: String(data.r2_bucket ?? process.env.R2_BUCKET_NAME ?? "pms-backups"),
    retention_days: Number(data.retention_days ?? 60),
    updated_at: String(data.updated_at ?? new Date().toISOString()),
  };
}

async function createBackupLog(
  supabase: SupabaseServerClient,
  backupType: "daily_cloud" | "offline_snapshot"
): Promise<string> {
  const { data, error } = await supabase
    .from("backup_logs")
    .insert({
      backup_type: backupType,
      status: "started",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error("Failed to create backup log.");
  return String(data.id);
}

async function markStaleStartedBackupLogsFailed(
  supabase: SupabaseServerClient,
  backupType: "daily_cloud" | "offline_snapshot"
): Promise<void> {
  const cutoff = new Date(Date.now() - BACKUP_STALE_STARTED_MINUTES * 60 * 1000).toISOString();
  const { error } = await supabase
    .from("backup_logs")
    .update({
      status: "failed",
      error_message: `Backup run was interrupted before completion after ${BACKUP_STALE_STARTED_MINUTES} minutes.`,
      completed_at: new Date().toISOString(),
    })
    .eq("backup_type", backupType)
    .eq("status", "started")
    .is("completed_at", null)
    .lt("started_at", cutoff);
  if (error) throw new Error(error.message);
}

async function markBackupLogSuccess(
  supabase: SupabaseServerClient,
  logId: string,
  payload: {
    file_name?: string | null;
    file_size_bytes?: number | null;
    record_count?: number | null;
  }
): Promise<void> {
  const { error } = await supabase
    .from("backup_logs")
    .update({
      status: "success",
      file_name: payload.file_name ?? null,
      file_size_bytes: payload.file_size_bytes ?? null,
      record_count: payload.record_count ?? null,
      completed_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("id", logId);
  if (error) throw new Error(error.message);
}

async function markBackupLogFailed(
  supabase: SupabaseServerClient,
  logId: string,
  errorMessage: string
): Promise<void> {
  await supabase
    .from("backup_logs")
    .update({
      status: "failed",
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
    })
    .eq("id", logId);
}

async function fetchRecentSuccessfulCloudBackups(supabase: SupabaseServerClient): Promise<BackupLogRow[]> {
  const { data, error } = await supabase
    .from("backup_logs")
    .select("id, backup_type, status, file_name, file_size_bytes, record_count, error_message, started_at, completed_at, created_at")
    .eq("backup_type", "daily_cloud")
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return ((data ?? []) as any[]).map(normalizeBackupLogRow);
}

function isMissingColumnError(error: { code?: string; message?: string; details?: string | null }): boolean {
  const text = `${error.code ?? ""} ${error.message ?? ""} ${error.details ?? ""}`;
  return (
    text.includes("PGRST204") ||
    text.includes("42703") ||
    /could not find .* column/i.test(text) ||
    /column .* does not exist/i.test(text)
  );
}

async function tableHasColumn(
  supabase: SupabaseServerClient,
  table: string,
  column: BackupTimestampColumn
): Promise<boolean> {
  const { error } = await supabase.from(table).select(column).limit(1);
  if (!error) return true;
  if (isMissingColumnError(error)) return false;
  throw new Error(`Failed to inspect ${table}.${column}: ${error.message}`);
}

async function resolveIncrementalTimestampColumn(
  supabase: SupabaseServerClient,
  table: string
): Promise<BackupTimestampColumn | null> {
  if (await tableHasColumn(supabase, table, "updated_at")) return "updated_at";
  if (await tableHasColumn(supabase, table, "created_at")) return "created_at";
  return null;
}

async function resolveDailyCloudBackupMode(
  supabase: SupabaseServerClient,
  requestedMode: DailyCloudBackupMode
): Promise<{
  mode: ResolvedDailyCloudBackupMode;
  baseFullBackup: BackupLogRow | null;
  latestSuccessfulBackup: BackupLogRow | null;
  watermarkStartedAt: string | null;
}> {
  const successfulBackups = await fetchRecentSuccessfulCloudBackups(supabase);
  const latestSuccessfulBackup = successfulBackups[0] ?? null;
  const baseFullBackup = successfulBackups.find((row) => isFullBackupFile(row.file_name)) ?? null;

  const shouldRunFull =
    requestedMode === "full" ||
    !baseFullBackup ||
    (requestedMode === "auto" && isOlderThanDays(baseFullBackup.started_at, FULL_BACKUP_INTERVAL_DAYS));

  if (shouldRunFull) {
    return {
      mode: "full",
      baseFullBackup,
      latestSuccessfulBackup,
      watermarkStartedAt: null,
    };
  }

  const watermarkSource = latestSuccessfulBackup ?? baseFullBackup;
  return {
    mode: "incremental",
    baseFullBackup,
    latestSuccessfulBackup,
    watermarkStartedAt: watermarkSource ? subtractMinutes(watermarkSource.started_at, BACKUP_WATERMARK_OVERLAP_MINUTES) : null,
  };
}

async function exportSingleTable(
  supabase: SupabaseServerClient,
  table: string,
  options: {
    timestampColumn?: BackupTimestampColumn;
    watermarkStartedAt?: string | null;
  } = {}
): Promise<{ table: string; dump: TableDump }> {
  const rows: Array<Record<string, unknown>> = [];

  for (let offset = 0; ; offset += BACKUP_EXPORT_BATCH_SIZE) {
    let query = supabase
      .from(table)
      .select("*")
      .range(offset, offset + BACKUP_EXPORT_BATCH_SIZE - 1);

    if (options.timestampColumn && options.watermarkStartedAt) {
      query = query.gte(options.timestampColumn, options.watermarkStartedAt);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to export ${table}: ${error.message}`);
    }

    const page = ((data ?? []) as Array<Record<string, unknown>>).map((row) => row);
    rows.push(...page);
    if (page.length < BACKUP_EXPORT_BATCH_SIZE) break;
  }

  return {
    table,
    dump: {
      row_count: rows.length,
      rows,
    },
  };
}

async function buildDailyBackupPayload(
  supabase: SupabaseServerClient,
  options: {
    mode: ResolvedDailyCloudBackupMode;
    baseFullStartedAt: string | null;
    watermarkStartedAt: string | null;
  }
): Promise<{
  payload: DailyBackupPayload;
  recordCount: number;
  skippedTables: SkippedBackupTable[];
}> {
  const tableResults: BackupTableExportResult[] = await mapWithConcurrency(DAILY_BACKUP_TABLES, 4, async (table) => {
    if (options.mode === "full") {
      return { kind: "exported" as const, entry: await exportSingleTable(supabase, table) };
    }

    const timestampColumn = await resolveIncrementalTimestampColumn(supabase, table);
    if (!timestampColumn || !options.watermarkStartedAt) {
      return {
        kind: "skipped" as const,
        skipped: {
          table,
          reason: "No updated_at or created_at column; covered by weekly full backup.",
        },
      };
    }

    return {
      kind: "exported" as const,
      entry: await exportSingleTable(supabase, table, {
        timestampColumn,
        watermarkStartedAt: options.watermarkStartedAt,
      }),
    };
  });
  const tableExports = tableResults
    .filter((result): result is { kind: "exported"; entry: { table: string; dump: TableDump } } => result.kind === "exported")
    .map((result) => result.entry);
  const skippedTables = tableResults
    .filter((result): result is { kind: "skipped"; skipped: SkippedBackupTable } => result.kind === "skipped")
    .map((result) => result.skipped);
  const tables = Object.fromEntries(tableExports.map((entry) => [entry.table, entry.dump]));
  const recordCount = tableExports.reduce((sum, entry) => sum + entry.dump.row_count, 0);

  return {
    payload: {
      version: 2,
      backup_mode: options.mode,
      base_full_started_at: options.baseFullStartedAt,
      watermark_started_at: options.watermarkStartedAt,
      skipped_tables: skippedTables,
      exported_at: new Date().toISOString(),
      exported_timezone: BANGKOK_TIME_ZONE,
      schema: "public",
      tables,
    },
    recordCount,
    skippedTables,
  };
}

function buildBackupFileName(mode: ResolvedDailyCloudBackupMode, now: Date = new Date()): string {
  const prefix = mode === "full" ? DAILY_FULL_BACKUP_PREFIX : DAILY_INCREMENTAL_BACKUP_PREFIX;
  return `${prefix}${asDateString(now)}_${asTimeString(now)}.json.gz`;
}

async function resolveBusinessDate(supabase: SupabaseServerClient): Promise<string> {
  const { data, error } = await supabase
    .from("hotel_settings")
    .select("business_date")
    .eq("id", 1)
    .maybeSingle();

  if (!error && /^\d{4}-\d{2}-\d{2}$/.test(String(data?.business_date ?? ""))) {
    return String(data?.business_date);
  }

  return asDateString(new Date());
}

function classifyReservation(checkinDate: string, checkoutDate: string, businessDate: string): SnapshotReservation["category"] {
  if (checkinDate === businessDate) return "arrival";
  if (checkoutDate === businessDate) return "departure";
  return "in_house";
}

function getRoomNumberFromNight(night: any): string | null {
  const roomRef = Array.isArray(night?.rooms) ? night.rooms[0] : night?.rooms;
  return roomRef?.room_number ? String(roomRef.room_number) : null;
}

function shouldHideOfflineRoom(row: { is_sellable?: unknown; closure_reason?: unknown }): boolean {
  if (row.is_sellable === false) return true;
  const reason = String(row.closure_reason ?? "").toLowerCase();
  const roomTypeName = String((row as any).room_types?.name_en ?? (row as any).room_type ?? "").toLowerCase();
  return /block|reno|renovat|ปรับปรุง|ซ่อม/.test(reason) || /closed room|close room/.test(roomTypeName);
}

async function buildOfflineSnapshotData(supabase: SupabaseServerClient): Promise<{
  snapshotDate: string;
  snapshotData: OfflineSnapshotData;
  recordCount: number;
}> {
  const businessDate = await resolveBusinessDate(supabase);
  const fromDate = shiftDateString(businessDate, -1);
  const toDate = shiftDateString(businessDate, 1);

  const [roomsResult, reservationsResult, housekeepingResult] = await Promise.all([
    supabase
      .from("rooms")
      .select("id, room_number, floor_number, is_dayuse, is_sellable, closure_reason, room_types(name_en, code)")
      .eq("is_dayuse", false)
      .order("floor_number", { ascending: true, nullsFirst: false })
      .order("room_number", { ascending: true }),
    supabase
      .from("reservations")
      .select(
        "id, booking_code, guest_name, guest_profile_id, checkin_date, checkout_date, status, adults, children, deposit_amount, total_price, discount_type, discount_value, discount_percent, reservation_nights(room_id, stay_date, cancelled_at, rooms(room_number)), guest_profiles(phone, email, line_id)"
      )
      .lte("checkin_date", toDate)
      .gte("checkout_date", fromDate)
      .neq("status", "cancelled")
      .order("checkin_date", { ascending: true }),
    supabase
      .from("housekeeping_tasks")
      .select("room_id, status, assigned_maid_name, task_seq")
      .eq("stay_date", businessDate)
      .order("task_seq", { ascending: false }),
  ]);

  if (roomsResult.error) throw new Error(roomsResult.error.message);
  if (reservationsResult.error) throw new Error(reservationsResult.error.message);
  if (housekeepingResult.error) throw new Error(housekeepingResult.error.message);

  const rooms = ((roomsResult.data ?? []) as any[])
    .filter((row) => !shouldHideOfflineRoom(row))
    .map((row) => ({
      id: String(row.id),
      room_number: String(row.room_number ?? ""),
      room_type: String(row.room_types?.name_en ?? row.room_types?.code ?? "Unknown"),
      floor: toFloorNumber(row.room_number ? String(row.room_number) : null, row.floor_number),
      is_sellable: Boolean(row.is_sellable ?? true),
      closure_reason: row.closure_reason ? String(row.closure_reason) : null,
    })) satisfies SnapshotRoom[];

  rooms.sort((left, right) => toRoomSortKey(left.room_number).localeCompare(toRoomSortKey(right.room_number)));

  const hkByRoomId = new Map<string, SnapshotHousekeepingStatus>();
  for (const row of (housekeepingResult.data ?? []) as any[]) {
    const roomId = String(row.room_id ?? "");
    if (!roomId || hkByRoomId.has(roomId)) continue;
    hkByRoomId.set(roomId, {
      room_id: roomId,
      room_number: "",
      status: String(row.status ?? "pending"),
      maid_name: row.assigned_maid_name ? String(row.assigned_maid_name) : null,
    });
  }

  const roomMetaById = new Map<string, SnapshotRoom>(rooms.map((room) => [room.id, room]));
  const rawReservations = ((reservationsResult.data ?? []) as any[]).filter((row) => {
    const status = String(row?.status ?? "").toLowerCase();
    return status !== "cancelled" && status !== "no_show";
  });

  const reservationIds = rawReservations.map((row) => String(row.id ?? "")).filter(Boolean);
  const visibleExtraByReservationId = await fetchReservationVisibleTotals(supabase, reservationIds);
  const outstandingBalanceByReservationId = await fetchReservationOutstandingBalances(
    supabase,
    rawReservations.map((row) => ({
      id: String(row.id ?? ""),
      total_price: row.total_price,
      deposit_amount: row.deposit_amount,
      discount_type: row.discount_type,
      discount_value: row.discount_value,
      discount_percent: row.discount_percent,
      checkin_date: row.checkin_date,
      checkout_date: row.checkout_date,
    }))
  );

  const reservationByActiveRoomId = new Map<string, SnapshotReservation>();
  const reservations = rawReservations
    .map((row) => {
      const nights = Array.isArray(row.reservation_nights) ? row.reservation_nights : [];
      const activeNight = nights.find(
        (night: any) => String(night?.stay_date ?? "") === businessDate && !night?.cancelled_at
      );
      const roomNumbers: string[] = Array.from(
        new Set<string>(
          nights
            .filter((night: any) => !night?.cancelled_at)
            .map((night: any) => getRoomNumberFromNight(night))
            .filter((roomNumber: string | null): roomNumber is string => Boolean(roomNumber))
        )
      );
      const primaryRoomNumber = getRoomNumberFromNight(activeNight);
      const guestProfile = Array.isArray(row.guest_profiles) ? row.guest_profiles[0] : row.guest_profiles;
      const reservation = {
        id: String(row.id),
        booking_code: row.booking_code ? String(row.booking_code) : null,
        guest_name: row.guest_name ? String(row.guest_name) : null,
        guest_phone: guestProfile?.phone ? String(guestProfile.phone) : null,
        guest_email: guestProfile?.email ? String(guestProfile.email) : null,
        room_number: primaryRoomNumber ?? roomNumbers[0] ?? null,
        room_numbers: roomNumbers,
        checkin_date: String(row.checkin_date ?? ""),
        checkout_date: String(row.checkout_date ?? ""),
        status: String(row.status ?? ""),
        adults: toNumber(row.adults),
        children: toNumber(row.children),
        total_price: applyVisibleTotal(row.total_price, visibleExtraByReservationId.get(String(row.id)), {
          discountType: row.discount_type,
          discountValue: row.discount_value,
          discountPercent: row.discount_percent,
          checkinDate: row.checkin_date,
          checkoutDate: row.checkout_date,
        }),
        outstanding_balance: Math.max(0, toNumber(outstandingBalanceByReservationId.get(String(row.id)) ?? 0)),
        category: classifyReservation(String(row.checkin_date ?? ""), String(row.checkout_date ?? ""), businessDate),
      } satisfies SnapshotReservation;

      const activeRoomId = activeNight?.room_id ? String(activeNight.room_id) : "";
      if (activeRoomId && roomMetaById.has(activeRoomId)) {
        reservationByActiveRoomId.set(activeRoomId, reservation);
      }

      return reservation;
    })
    .filter((row) => row.checkin_date && row.checkout_date);

  const arrivals = reservations.filter((row) => row.category === "arrival");
  const inHouse = reservations.filter((row) => row.category === "in_house");
  const departures = reservations.filter((row) => row.category === "departure");

  const hkStatus = Array.from(hkByRoomId.values())
    .map((row) => ({
      ...row,
      room_number: roomMetaById.get(row.room_id)?.room_number ?? row.room_number,
    }))
    .sort((left, right) => toRoomSortKey(left.room_number).localeCompare(toRoomSortKey(right.room_number)));

  const roomStatus = rooms
    .map((room) => {
      const current = reservationByActiveRoomId.get(room.id);
      const housekeeping = hkByRoomId.get(room.id) ?? null;
      if (current) {
        return {
          room_id: room.id,
          room_number: room.room_number,
          floor: room.floor,
          room_type: room.room_type,
          occupancy_status: current.category,
          housekeeping_status: housekeeping?.status ?? null,
          maid_name: housekeeping?.maid_name ?? null,
          guest_name: current.guest_name,
          booking_code: current.booking_code,
          checkin_date: current.checkin_date,
          checkout_date: current.checkout_date,
          total_price: current.total_price,
          outstanding_balance: current.outstanding_balance,
        } satisfies SnapshotRoomStatus;
      }
      return {
        room_id: room.id,
        room_number: room.room_number,
        floor: room.floor,
        room_type: room.room_type,
        occupancy_status: "vacant",
        housekeeping_status: housekeeping?.status ?? null,
        maid_name: housekeeping?.maid_name ?? null,
        guest_name: null,
        booking_code: null,
        checkin_date: null,
        checkout_date: null,
        total_price: 0,
        outstanding_balance: 0,
      } satisfies SnapshotRoomStatus;
    })
    .sort((left, right) => toRoomSortKey(left.room_number).localeCompare(toRoomSortKey(right.room_number)));

  const snapshotData: OfflineSnapshotData = {
    generated_at: new Date().toISOString(),
    date_range: { from: fromDate, to: toDate },
    business_date: businessDate,
    rooms,
    reservations,
    arrivals,
    in_house: inHouse,
    departures,
    hk_status: hkStatus,
    room_status: roomStatus,
  };

  return {
    snapshotDate: businessDate,
    snapshotData,
    recordCount: rooms.length + reservations.length + hkStatus.length + roomStatus.length,
  };
}

async function trimOldSnapshots(supabase: SupabaseServerClient): Promise<void> {
  const { data, error } = await supabase
    .from("backup_snapshots")
    .select("id")
    .order("created_at", { ascending: false })
    .range(SNAPSHOT_KEEP_ROWS, SNAPSHOT_KEEP_ROWS + 50);
  if (error) throw new Error(error.message);

  const staleIds = (data ?? [])
    .map((row) => String((row as any).id ?? ""))
    .filter(Boolean);
  if (staleIds.length === 0) return;

  const { error: deleteError } = await supabase
    .from("backup_snapshots")
    .delete()
    .in("id", staleIds);
  if (deleteError) throw new Error(deleteError.message);
}

export function isAuthorizedCronRequest(request: NextRequest): boolean {
  const expected = String(process.env.CRON_BACKUP_SECRET ?? "").trim();
  if (!expected) return false;

  const queryToken = String(request.nextUrl.searchParams.get("token") ?? "").trim();
  if (queryToken && queryToken === expected) return true;

  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  return Boolean(bearer && bearer === expected);
}

export function assertAuthorizedCronRequest(request: NextRequest): void {
  if (!isAuthorizedCronRequest(request)) {
    throw new BackupHttpError(401, "Unauthorized");
  }
}

export async function requireAdminAccess(
  supabase: SupabaseServerClient,
  request: NextRequest
): Promise<AuthUser> {
  const user = await getAuthenticatedUser(supabase, request);
  if (!user) {
    throw new BackupHttpError(401, "Unauthorized");
  }

  const role = await getUserRole(supabase, user.id);
  if (role !== "admin") {
    throw new BackupHttpError(403, "Forbidden");
  }

  return user;
}

export function hashOfflinePin(pin: string): string {
  return hashValue(pin.trim());
}

export async function verifyOfflinePin(
  supabase: SupabaseServerClient,
  pin: string
): Promise<boolean> {
  const config = await ensureBackupConfig(supabase);
  if (!config.offline_pin) return false;

  const provided = Buffer.from(hashOfflinePin(pin), "utf8");
  const expected = Buffer.from(config.offline_pin, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

async function verifyTrustedDeviceToken(
  supabase: SupabaseServerClient,
  rawDeviceToken: string
): Promise<{ id: string; device_name: string }> {
  const tokenHash = hashValue(rawDeviceToken.trim());
  const { data, error } = await supabase
    .from("backup_trusted_devices")
    .select("id, device_name")
    .eq("device_token_hash", tokenHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data?.id) {
    throw new BackupHttpError(403, "This device is not paired for offline sync");
  }

  await supabase
    .from("backup_trusted_devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", data.id);

  return {
    id: String(data.id),
    device_name: normalizeDeviceName(data.device_name, "FO Device"),
  };
}

export async function issueBackupPairingToken(
  supabase: SupabaseServerClient,
  params: {
    device_name?: string | null;
    expires_in_minutes?: number;
    created_by_user_id?: string | null;
  }
): Promise<PairingTokenIssueResult> {
  const pairingToken = createOpaqueToken(16);
  const expiresInMinutes = Math.max(5, Math.min(24 * 60, Number(params.expires_in_minutes ?? 30)));
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();
  const deviceName = normalizeDeviceName(params.device_name, "FO Device");

  const { error } = await supabase.from("backup_pairing_tokens").insert({
    token_hash: hashValue(pairingToken),
    device_name: deviceName,
    expires_at: expiresAt,
    created_by_user_id: params.created_by_user_id ?? null,
  });

  if (error) {
    throw new Error(error.message);
  }

  return {
    pairing_token: pairingToken,
    device_name: deviceName,
    expires_at: expiresAt,
  };
}

export async function pairOfflineDevice(
  supabase: SupabaseServerClient,
  params: {
    pairing_token: string;
    device_name?: string | null;
    user_agent?: string | null;
  }
): Promise<DevicePairingResult> {
  const pairingToken = String(params.pairing_token ?? "").trim();
  if (!pairingToken) {
    throw new BackupHttpError(400, "Pairing token is required");
  }

  const { data: tokenRow, error: tokenError } = await supabase
    .from("backup_pairing_tokens")
    .select("id, device_name, expires_at, used_at")
    .eq("token_hash", hashValue(pairingToken))
    .maybeSingle();

  if (tokenError) {
    throw new Error(tokenError.message);
  }
  if (!tokenRow?.id) {
    throw new BackupHttpError(404, "Pairing token not found");
  }
  if (tokenRow.used_at) {
    throw new BackupHttpError(409, "Pairing token has already been used");
  }
  if (new Date(String(tokenRow.expires_at)).getTime() < Date.now()) {
    throw new BackupHttpError(410, "Pairing token has expired");
  }

  const deviceToken = createOpaqueToken(24);
  const deviceName = normalizeDeviceName(params.device_name, tokenRow.device_name);
  const pairedAt = new Date().toISOString();

  const { data: deviceRow, error: deviceError } = await supabase
    .from("backup_trusted_devices")
    .insert({
      device_name: deviceName,
      device_token_hash: hashValue(deviceToken),
      paired_via_token_id: tokenRow.id,
      user_agent: params.user_agent ? String(params.user_agent).slice(0, 255) : null,
      paired_at: pairedAt,
      last_seen_at: pairedAt,
    })
    .select("id, device_name, paired_at")
    .maybeSingle();

  if (deviceError) {
    throw new Error(deviceError.message);
  }
  if (!deviceRow?.id) {
    throw new Error("Failed to pair this device");
  }

  const { error: updateError } = await supabase
    .from("backup_pairing_tokens")
    .update({ used_at: pairedAt })
    .eq("id", tokenRow.id)
    .is("used_at", null);

  if (updateError) {
    throw new Error(updateError.message);
  }

  return {
    device_id: String(deviceRow.id),
    device_name: normalizeDeviceName(deviceRow.device_name, deviceName),
    device_token: deviceToken,
    paired_at: String(deviceRow.paired_at ?? pairedAt),
  };
}

export async function authorizeOfflineSnapshotRequest(
  supabase: SupabaseServerClient,
  request: NextRequest
): Promise<"admin" | "pin"> {
  const user = await getAuthenticatedUser(supabase, request);
  if (user) {
    const role = await getUserRole(supabase, user.id);
    if (role === "admin") return "admin";
  }

  const headerPin = String(request.headers.get("x-offline-pin") ?? "").trim();
  const queryPin = String(request.nextUrl.searchParams.get("pin") ?? "").trim();
  const rawPin = headerPin || queryPin;
  const headerDeviceToken = String(request.headers.get("x-offline-device-token") ?? "").trim();
  const queryDeviceToken = String(request.nextUrl.searchParams.get("device_token") ?? "").trim();
  const rawDeviceToken = headerDeviceToken || queryDeviceToken;

  if (!rawDeviceToken) {
    throw new BackupHttpError(401, "Paired device token required");
  }

  await verifyTrustedDeviceToken(supabase, rawDeviceToken);

  if (!rawPin) {
    throw new BackupHttpError(401, "Offline PIN required");
  }

  const isValid = await verifyOfflinePin(supabase, rawPin);
  if (!isValid) {
    throw new BackupHttpError(403, "Invalid offline PIN");
  }

  return "pin";
}

export async function canReadBackupConfigPinHash(
  supabase: SupabaseServerClient,
  request: NextRequest
): Promise<boolean> {
  const user = await getAuthenticatedUser(supabase, request);
  if (user) {
    const role = await getUserRole(supabase, user.id);
    if (role === "admin") return true;
  }

  const headerDeviceToken = String(request.headers.get("x-offline-device-token") ?? "").trim();
  const queryDeviceToken = String(request.nextUrl.searchParams.get("device_token") ?? "").trim();
  const rawDeviceToken = headerDeviceToken || queryDeviceToken;
  if (!rawDeviceToken) return false;

  try {
    await verifyTrustedDeviceToken(supabase, rawDeviceToken);
    return true;
  } catch (error) {
    if (error instanceof BackupHttpError) return false;
    throw error;
  }
}

export async function getBackupConfigPublicPayload(
  supabase: SupabaseServerClient,
  options: { includePinHash?: boolean } = {}
): Promise<{
  retention_days: number;
  r2_bucket: string;
  updated_at: string;
  pin_hash: string | null;
  has_pin: boolean;
  device_pairing_required: boolean;
}> {
  const config = await ensureBackupConfig(supabase);
  return {
    retention_days: config.retention_days,
    r2_bucket: config.r2_bucket,
    updated_at: config.updated_at,
    pin_hash: options.includePinHash ? config.offline_pin : null,
    has_pin: Boolean(config.offline_pin),
    device_pairing_required: true,
  };
}

export async function updateBackupConfig(
  supabase: SupabaseServerClient,
  updates: {
    retention_days?: number;
    offline_pin?: string | null;
  }
): Promise<BackupConfigRow> {
  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (updates.retention_days !== undefined) {
    payload.retention_days = updates.retention_days;
  }
  if (updates.offline_pin !== undefined) {
    payload.offline_pin = updates.offline_pin ? hashOfflinePin(updates.offline_pin) : null;
  }

  const { error } = await supabase
    .from("backup_config")
    .update(payload)
    .eq("id", 1);
  if (error) {
    throw new Error(error.message);
  }

  return ensureBackupConfig(supabase);
}

export async function getLatestSnapshot(supabase: SupabaseServerClient): Promise<OfflineSnapshotRow | null> {
  const { data, error } = await supabase
    .from("backup_snapshots")
    .select("id, snapshot_date, snapshot_data, record_count, created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  if (!data) return null;

  return {
    id: String(data.id),
    snapshot_date: String(data.snapshot_date),
    snapshot_data: data.snapshot_data as OfflineSnapshotData,
    record_count: Number(data.record_count ?? 0),
    created_at: String(data.created_at),
  };
}

export async function getBackupStatus(supabase: SupabaseServerClient): Promise<BackupStatusPayload> {
  const config = await ensureBackupConfig(supabase);
  const { data, error } = await supabase
    .from("backup_logs")
    .select("id, backup_type, status, file_name, file_size_bytes, record_count, error_message, started_at, completed_at, created_at")
    .order("created_at", { ascending: false })
    .limit(BACKUP_HISTORY_LIMIT);
  if (error) {
    throw new Error(error.message);
  }

  const history = ((data ?? []) as any[]).map(normalizeBackupLogRow);
  let activityLogArchives: UiEventLogArchiveRunRow[] = [];
  try {
    const { data: archiveRuns, error: archiveError } = await supabase
      .from("ui_event_log_archive_runs")
      .select("id, status, archive_cutoff_at, row_count, archived_count, deleted_count, r2_keys, event_counts, category_counts, error_message, started_at, completed_at, created_at")
      .order("created_at", { ascending: false })
      .limit(10);
    if (!archiveError) {
      activityLogArchives = ((archiveRuns ?? []) as any[]).map((row) => ({
        id: String(row.id),
        status: row.status === "failed" || row.status === "started" ? row.status : "succeeded",
        archive_cutoff_at: String(row.archive_cutoff_at),
        row_count: Number(row.row_count ?? 0),
        archived_count: Number(row.archived_count ?? 0),
        deleted_count: Number(row.deleted_count ?? 0),
        r2_keys: Array.isArray(row.r2_keys) ? row.r2_keys.map(String) : [],
        event_counts: typeof row.event_counts === "object" && row.event_counts ? row.event_counts as Record<string, number> : {},
        category_counts: typeof row.category_counts === "object" && row.category_counts ? row.category_counts as Record<string, number> : {},
        error_message: row.error_message ? String(row.error_message) : null,
        started_at: String(row.started_at),
        completed_at: row.completed_at ? String(row.completed_at) : null,
        created_at: String(row.created_at),
      }));
    }
  } catch {
    activityLogArchives = [];
  }
  let storage: BackupStorageSummary;
  try {
    storage = await getStorageSummary(config.r2_bucket);
  } catch {
    storage = {
      bucket: config.r2_bucket,
      file_count: 0,
      total_bytes: 0,
      oldest_file_key: null,
      oldest_file_date: null,
    };
  }

  return {
    config: {
      retention_days: config.retention_days,
      r2_bucket: config.r2_bucket,
      updated_at: config.updated_at,
      has_pin: Boolean(config.offline_pin),
      device_pairing_required: true,
    },
    pin_hash: config.offline_pin,
    latest_cloud_backup: history.find((row) => row.backup_type === "daily_cloud") ?? null,
    latest_offline_sync: history.find((row) => row.backup_type === "offline_snapshot") ?? null,
    history,
    activity_log_archives: activityLogArchives,
    storage,
  };
}

export async function runDailyCloudBackup(
  supabase: SupabaseServerClient,
  options: { mode?: DailyCloudBackupMode } = {}
): Promise<DailyBackupRunResult> {
  await markStaleStartedBackupLogsFailed(supabase, "daily_cloud");
  const config = await ensureBackupConfig(supabase);
  const modeContext = await resolveDailyCloudBackupMode(supabase, options.mode ?? "auto");
  const logId = await createBackupLog(supabase, "daily_cloud");

  try {
    const { payload, recordCount, skippedTables } = await buildDailyBackupPayload(supabase, {
      mode: modeContext.mode,
      baseFullStartedAt: modeContext.baseFullBackup?.started_at ?? null,
      watermarkStartedAt: modeContext.watermarkStartedAt,
    });
    const compressed = gzipSync(Buffer.from(JSON.stringify(payload)));
    const objectKey = buildBackupFileName(modeContext.mode);
    const bucket = String(process.env.R2_BUCKET_NAME ?? config.r2_bucket).trim() || config.r2_bucket;

    await uploadBufferToR2({
      bucket,
      key: objectKey,
      buffer: compressed,
    });

    const deletedKeys = await cleanupExpiredBackups(bucket, config.retention_days);

    await markBackupLogSuccess(supabase, logId, {
      file_name: objectKey,
      file_size_bytes: compressed.byteLength,
      record_count: recordCount,
    });

    return {
      log_id: logId,
      object_key: objectKey,
      backup_mode: modeContext.mode,
      base_full_started_at: modeContext.baseFullBackup?.started_at ?? null,
      watermark_started_at: modeContext.watermarkStartedAt,
      skipped_tables: skippedTables,
      file_size_bytes: compressed.byteLength,
      record_count: recordCount,
      storage: await getStorageSummary(bucket),
      deleted_keys: deletedKeys,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Daily backup failed.";
    await markBackupLogFailed(supabase, logId, message);
    throw error;
  }
}

export async function runOfflineSnapshotSync(supabase: SupabaseServerClient): Promise<SnapshotRunResult> {
  await markStaleStartedBackupLogsFailed(supabase, "offline_snapshot");
  const logId = await createBackupLog(supabase, "offline_snapshot");

  try {
    const { snapshotDate, snapshotData, recordCount } = await buildOfflineSnapshotData(supabase);
    const { data, error } = await supabase
      .from("backup_snapshots")
      .insert({
        snapshot_date: snapshotDate,
        snapshot_data: snapshotData,
        record_count: recordCount,
      })
      .select("id, snapshot_date, created_at")
      .maybeSingle();
    if (error) {
      throw new Error(error.message);
    }
    if (!data?.id) {
      throw new Error("Failed to store backup snapshot.");
    }

    await trimOldSnapshots(supabase);
    await markBackupLogSuccess(supabase, logId, {
      record_count: recordCount,
    });

    return {
      log_id: logId,
      snapshot_id: String(data.id),
      snapshot_date: String(data.snapshot_date),
      record_count: recordCount,
      created_at: String(data.created_at),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Offline snapshot failed.";
    await markBackupLogFailed(supabase, logId, message);
    throw error;
  }
}
