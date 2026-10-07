import { createServerSupabaseClient } from "@/lib/supabase/server";
import { applyAlertSettingsToHotelSettings, readAlertSettings, updateAlertSettings } from "@/lib/alerts/service";
import { requireStaffAuth } from "@/lib/server-auth";
import { normalizeTransportAlertLeadMinutes } from "@/lib/transport-alert-settings";
import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";

export const dynamic = "force-dynamic";

const DEFAULT_SHIFT_LOGOUT_TIMES = ["07:00", "15:00", "23:00"];

function toLocalDate(date: Date, tz = "Asia/Bangkok"): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
}

function normalizeTimeList(value: unknown): string[] {
    const values = Array.isArray(value) ? value : DEFAULT_SHIFT_LOGOUT_TIMES;
    const normalized = Array.from(new Set(values
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => /^\d{2}:\d{2}$/.test(entry))
        .filter((entry) => {
            const [hour, minute] = entry.split(":").map(Number);
            return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
        })))
        .sort();
    return normalized.length > 0 ? normalized.slice(0, 6) : DEFAULT_SHIFT_LOGOUT_TIMES;
}

function normalizeSnoozeMinutes(value: unknown, fallback = 15): number {
    const raw = Number(value);
    const normalized = Number.isFinite(raw) ? Math.trunc(raw) : fallback;
    return Math.min(Math.max(normalized, 1), 1440);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") return true;
        if (normalized === "false") return false;
    }
    return fallback;
}

function isOptionalHotelSettingsColumnMissingError(message: string, key: string): boolean {
    return new RegExp(`${key}|schema cache`, "i").test(message);
}

function withSettingsDefaults<T extends Record<string, unknown>>(settings: T): T & { urgent_overlay_enabled: boolean } {
    return {
        ...settings,
        urgent_overlay_enabled: normalizeBoolean(settings.urgent_overlay_enabled, false),
    };
}

/* ─── GET — fetch hotel settings ─────────────────── */
export async function GET() {
    noStore(); // Completely disable all Next.js caching for this request
    try {
        const supabase = createServerSupabaseClient();
        const [{ data, error }, alertSettings] = await Promise.all([
            supabase
                .from("hotel_settings")
                .select("*")
                .eq("id", 1)
                .maybeSingle(),
            readAlertSettings(supabase),
        ]);

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        const localToday = toLocalDate(new Date());

        // Database time fields return as 'HH:mm:ss' (e.g., '14:00:00'). 
        // We slice to 5 chars ('14:00') since the frontend dropdown only has 'HH:mm' values.
        const settings = applyAlertSettingsToHotelSettings({
            hotel_name: data?.hotel_name ?? "My Hotel",
            hotel_timezone: data?.hotel_timezone ?? "Asia/Bangkok",
            sellable_rooms: data?.sellable_rooms ?? 0,
            business_date: data?.business_date ?? localToday,
            eod_reminder_time: (data?.eod_reminder_time ?? "02:00").slice(0, 5),
            night_audit_popup_snooze_min: Number(data?.night_audit_popup_snooze_min ?? 30),
            check_in_time: (data?.check_in_time ?? "14:00").slice(0, 5),
            check_out_time: (data?.check_out_time ?? "12:00").slice(0, 5),
            late_checkout_fee: data?.late_checkout_fee ?? 0,
            transport_alert_lead_min: normalizeTransportAlertLeadMinutes(data?.transport_alert_lead_min),
            dayuse_rate: Number(data?.dayuse_rate ?? 200),
            dayuse_duration_min: Number(data?.dayuse_duration_min ?? 120),
            dayuse_extend_rate: Number(data?.dayuse_extend_rate ?? 100),
            dayuse_extend_min: Number(data?.dayuse_extend_min ?? 60),
            amenity_audit_warn_days: Math.min(Math.max(Number(data?.amenity_audit_warn_days ?? 3), 1), 30),
            identity_alert_under18_thai_id_enabled: data?.identity_alert_under18_thai_id_enabled ?? true,
            identity_alert_under18_passport_enabled: data?.identity_alert_under18_passport_enabled ?? true,
            identity_alert_over18_thai_id_enabled: data?.identity_alert_over18_thai_id_enabled ?? true,
            identity_alert_over18_passport_enabled: data?.identity_alert_over18_passport_enabled ?? true,
            identity_alert_birthday_enabled: data?.identity_alert_birthday_enabled ?? true,
            shift_logout_reminder_times: normalizeTimeList(data?.shift_logout_reminder_times),
            shift_logout_snooze_min: normalizeSnoozeMinutes(data?.shift_logout_snooze_min),
            shift_logout_snooze_enabled: data?.shift_logout_snooze_enabled ?? true,
            urgent_overlay_enabled: normalizeBoolean(data?.urgent_overlay_enabled, false),
        }, alertSettings);

        return NextResponse.json(
            { success: true, settings },
            { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate", "Pragma": "no-cache" } }
        );
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}

/* ─── PUT — update hotel settings ────────────────── */
export async function PUT(request: NextRequest) {
    try {
        const supabase = createServerSupabaseClient();
        // hotel_settings PUT changes hotel-wide config (fees, check-in/out times, identity-verification
        // alerts). Gate to admin/supervisor BEFORE any write. Return 401/403 before the upsert.
        const auth = await requireStaffAuth(supabase, request, { allowRoles: ["admin", "supervisor"] });
        if (auth.error) return auth.error;
        const body = await request.json();
        const alertPatch = {
            start_time: "alert_start_time" in body ? String(body.alert_start_time ?? "") : undefined,
            snooze_minutes: "alert_snooze_minutes" in body ? Number(body.alert_snooze_minutes) : undefined,
            prepayment_lead_days: "alert_prepayment_lead_days" in body ? Number(body.alert_prepayment_lead_days) : undefined,
        };

        const allowed = [
            "hotel_name", "hotel_timezone", "sellable_rooms",
            "eod_reminder_time", "check_in_time", "check_out_time",
            "late_checkout_fee", "night_audit_popup_snooze_min",
            "transport_alert_lead_min",
            "dayuse_rate", "dayuse_duration_min", "dayuse_extend_rate", "dayuse_extend_min",
            "amenity_audit_warn_days",
            "identity_alert_under18_thai_id_enabled",
            "identity_alert_under18_passport_enabled",
            "identity_alert_over18_thai_id_enabled",
            "identity_alert_over18_passport_enabled",
            "identity_alert_birthday_enabled",
            "shift_logout_reminder_times",
            "shift_logout_snooze_min",
            "shift_logout_snooze_enabled",
            "urgent_overlay_enabled"
        ];

        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
        for (const key of allowed) {
            if (!(key in body)) continue;
            if (key === "transport_alert_lead_min") {
                updates[key] = normalizeTransportAlertLeadMinutes(body[key]);
            } else if (key === "amenity_audit_warn_days") {
                const raw = Number(body[key]);
                const normalized = Number.isFinite(raw) ? Math.trunc(raw) : 3;
                updates[key] = Math.min(Math.max(normalized, 1), 30);
            } else if (key === "shift_logout_reminder_times") {
                updates[key] = normalizeTimeList(body[key]);
            } else if (key === "shift_logout_snooze_min") {
                updates[key] = normalizeSnoozeMinutes(body[key]);
            } else if (key === "urgent_overlay_enabled") {
                updates[key] = normalizeBoolean(body[key], false);
            } else {
                updates[key] = body[key];
            }
        }

        let { data, error } = await supabase
            .from("hotel_settings")
            .upsert({ id: 1, ...updates })
            .select("*")
            .maybeSingle();

        if (error) {
            const retryUpdates = { ...updates };
            let shouldRetry = false;
            for (const key of ["shift_logout_snooze_enabled", "urgent_overlay_enabled"] as const) {
                if (key in retryUpdates && isOptionalHotelSettingsColumnMissingError(error.message, key)) {
                    delete retryUpdates[key];
                    shouldRetry = true;
                }
            }
            if (shouldRetry) {
                const retry = await supabase
                    .from("hotel_settings")
                    .upsert({ id: 1, ...retryUpdates })
                    .select("*")
                    .maybeSingle();
                data = retry.data;
                error = retry.error;
            }
        }

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        const actorUserId = auth.user.id;
        if (actorUserId && Object.values(alertPatch).some((value) => value !== undefined)) {
            await updateAlertSettings(supabase, actorUserId, alertPatch);
        }
        const alertSettings = await readAlertSettings(supabase);

        return NextResponse.json({ success: true, settings: applyAlertSettingsToHotelSettings(withSettingsDefaults(data ?? {}), alertSettings) });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
