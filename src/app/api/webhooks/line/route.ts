import { createServerSupabaseClient } from "@/lib/supabase/server";
import { classifyLineStaffAccess, type LineStaffAccess } from "@/lib/line-staff-access";
import { formatLineStaffScheduleReply, getLineStaffSchedule } from "@/lib/staff-schedule";
import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type LineEvent = {
  type?: string;
  replyToken?: string;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: { type?: string; text?: string };
};

type LineWebhookBody = {
  events?: LineEvent[];
};

function getLineSecrets() {
  return {
    channelSecret: process.env.LINE_CHANNEL_SECRET ?? "",
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
  };
}

function verifyLineSignature(rawBody: string, signature: string | null): boolean {
  const { channelSecret } = getLineSecrets();
  if (!channelSecret || !signature) return false;

  const digest = createHmac("sha256", channelSecret).update(rawBody).digest("base64");
  const signatureBuffer = Buffer.from(signature, "utf8");
  const digestBuffer = Buffer.from(digest, "utf8");
  if (signatureBuffer.length !== digestBuffer.length) return false;
  return timingSafeEqual(signatureBuffer, digestBuffer);
}

async function replyLineText(replyToken: string, text: string) {
  const { channelAccessToken } = getLineSecrets();
  if (!channelAccessToken) {
    console.error("LINE_CHANNEL_ACCESS_TOKEN missing");
    return;
  }

  try {
    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channelAccessToken}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error("LINE reply API failed", { status: response.status, body });
    }
  } catch (err) {
    console.error("LINE reply API error", err);
  }
}

/** Bangkok UTC+7 date string "YYYY-MM-DD" */
function bangkokToday(): string {
  const now = new Date();
  const bkk = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 10);
}

async function resolveLineBusinessDate() {
  const supabase = createServerSupabaseClient();
  const calendarDate = bangkokToday();
  const { data } = await supabase
    .from("hotel_settings")
    .select("business_date")
    .eq("id", 1)
    .maybeSingle();

  const businessDate = String(data?.business_date ?? "").trim() || calendarDate;
  return { supabase, businessDate, calendarDate };
}

async function resolveLineStaffAccess(lineUserId: string): Promise<LineStaffAccess> {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("staff")
    .select("id, department:departments(code), profiles:profiles!staff_id_fkey(role)")
    .eq("line_user_id", lineUserId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("line staff access lookup failed", error);
    return { isBound: false, isFrontdeskOnly: false, departmentCode: null, role: null };
  }

  return classifyLineStaffAccess(data as Record<string, unknown> | null);
}

async function handleCheckoutQuery(replyToken: string) {
  const { supabase, businessDate, calendarDate } = await resolveLineBusinessDate();

  const { data, error } = await supabase
    .from("reservations")
    .select("id, booking_code, status, checkout_date, guest_name")
    .eq("checkout_date", businessDate)
    .in("status", ["active", "checked_out"])
    .order("status", { ascending: true });

  if (error) {
    console.error("line checkout query failed", error);
    await replyLineText(replyToken, `[DEBUG co] ${error.code ?? "?"}: ${error.message ?? String(error)}`);
    return;
  }

  const rows = (data ?? []) as Array<{
    id: string;
    booking_code: string | null;
    status: string | null;
    checkout_date: string | null;
    guest_name: string | null;
  }>;

  const checkedOut = rows.filter((r) => r.status === "checked_out");
  const remaining = rows.filter((r) => r.status !== "checked_out");
  const total = rows.length;

  if (total === 0) {
    await replyLineText(
      replyToken,
      `📋 ยอด Check-Out (Business Date ${businessDate})\nCalendar: ${calendarDate}\n\nไม่มีการ Check-out กำหนดใน business date นี้`
    );
    return;
  }

  const lines = [
    `📋 ยอด Check-Out (Business Date ${businessDate})`,
    `Calendar: ${calendarDate}`,
    ``,
    `✅ Check-out แล้ว: ${checkedOut.length} ห้อง`,
    `⏳ ยังไม่ Check-out: ${remaining.length} ห้อง`,
    `📊 รวม Due Out ใน business date นี้: ${total} ห้อง`,
  ];

  if (remaining.length > 0 && remaining.length <= 10) {
    lines.push(``);
    lines.push(`ห้องที่ยังไม่ออก:`);
    for (const r of remaining) {
      lines.push(`• ${r.booking_code ?? r.id.slice(0, 8)} — ${r.guest_name ?? "ไม่ระบุชื่อ"}`);
    }
  }

  await replyLineText(replyToken, lines.join("\n"));
}

async function handleInHouseQuery(replyToken: string) {
  const { supabase, businessDate, calendarDate } = await resolveLineBusinessDate();

  // Room assignment lives on reservation_nights, not reservations directly.
  // Query today's occupied nights → join rooms for room_number → join reservations to filter status=active.
  const { data, error } = await supabase
    .from("reservation_nights")
    .select("room_id, rooms(room_number), reservations!inner(status)")
    .eq("stay_date", businessDate)
    .is("cancelled_at", null)
    .not("room_id", "is", null)
    .eq("reservations.status", "active");

  if (error) {
    console.error("line inhouse query failed", error.message, error.code);
    await replyLineText(replyToken, `[DEBUG ih] ${error.code ?? "?"}: ${error.message ?? String(error)}`);
    return;
  }

  type InHouseRow = {
    room_id: string | null;
    rooms: { room_number: string | null }[] | { room_number: string | null } | null;
    reservations: { status: string | null }[] | { status: string | null } | null;
  };
  const rows = (data ?? []) as unknown as InHouseRow[];

  if (rows.length === 0) {
    await replyLineText(
      replyToken,
      `🏨 In House (Business Date ${businessDate})\nCalendar: ${calendarDate}\n\nไม่มีแขกพักอยู่ในโรงแรมขณะนี้`
    );
    return;
  }

  // Sort room numbers naturally (101, 102, 201...)
  const roomNumbers = rows
    .map((r) => {
      const roomsField = r.rooms;
      if (!roomsField) return null;
      if (Array.isArray(roomsField)) return roomsField[0]?.room_number ?? null;
      return roomsField.room_number ?? null;
    })
    .filter((n): n is string => n !== null)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const lines = [
    `🏨 In House (Business Date ${businessDate})`,
    `Calendar: ${calendarDate}`,
    ``,
    `จำนวน ${roomNumbers.length} ห้อง`,
    ``,
    roomNumbers.join(", "),
  ];

  await replyLineText(replyToken, lines.join("\n"));
}

async function handleScheduleQuery(params: {
  replyToken: string;
  lineUserId: string;
  nextMonth: boolean;
  period: "week" | "month";
}) {
  const supabase = createServerSupabaseClient();
  const result = await getLineStaffSchedule(supabase, {
    lineUserId: params.lineUserId,
    nextMonth: params.nextMonth,
    period: params.period,
  });

  if (!result.ok) {
    await replyLineText(
      params.replyToken,
      "ยังไม่ได้ผูก LINE กับบัญชี Staff\nกรุณาพิมพ์ BIND <token> เพื่อผูกบัญชีก่อนใช้งาน"
    );
    return;
  }

  await replyLineText(params.replyToken, formatLineStaffScheduleReply(result));
}

function isScheduleQuery(norm: string): boolean {
  const scheduleCommands = new Set([
    "schedule",
    "schedule week",
    "schedule this week",
    "schedule next",
    "shift",
    "shift week",
    "shift this week",
    "shift next",
    "work schedule",
    "roster",
    "roster next",
    "ตารางเวร",
    "ตารางกะ",
    "เวร",
    "กะ",
    "กะทำงาน",
    "เวลาทำงาน",
    "ตารางงาน",
    "งานอาทิตย์นี้",
    "งานสัปดาห์นี้",
    "ตารางเวรเดือนหน้า",
    "ตารางเวร เดือนหน้า",
    "เวรเดือนหน้า",
    "เวร เดือนหน้า",
    "กะเดือนหน้า",
    "กะ เดือนหน้า",
  ]);
  if (scheduleCommands.has(norm)) return true;
  return (
    norm.includes("กะทำงาน") ||
    norm.includes("เวลาทำงาน") ||
    norm.includes("ตารางกะ") ||
    norm.includes("ตารางงาน") ||
    norm.includes("ตารางเวร") ||
    norm.includes("เข้าเวร") ||
    norm.includes("เข้ากะ") ||
    norm.includes("ทำงานวันไหน") ||
    norm.includes("ต้องเข้ามาทำงาน") ||
    norm.includes("work schedule")
  );
}

function isScheduleNextMonthQuery(norm: string): boolean {
  return norm.includes("next") || norm.includes("เดือนหน้า");
}

function isScheduleWeekQuery(norm: string): boolean {
  return (
    norm.includes("week") ||
    norm.includes("อาทิตย์นี้") ||
    norm.includes("สัปดาห์นี้") ||
    norm.includes("7 วัน") ||
    norm.includes("เจ็ดวัน") ||
    norm === "shift" ||
    norm === "กะ" ||
    norm === "กะทำงาน" ||
    norm === "เวลาทำงาน" ||
    norm.includes("ทำงานวันไหน") ||
    norm.includes("ต้องเข้ามาทำงาน")
  );
}

async function replyFoLineHelp(replyToken: string) {
  await replyLineText(
    replyToken,
    "📖 คำสั่งสำหรับ FO:\n\n" +
    "• shift / กะ / กะทำงาน / เวลาทำงาน\n  → ตารางกะของตัวเอง 7 วันนี้\n\n" +
    "• schedule\n  → ตารางกะของตัวเองถึงสิ้นเดือน\n\n" +
    "• shift next / เวรเดือนหน้า\n  → ตารางกะของตัวเองเดือนถัดไป"
  );
}

async function replyFoRestricted(replyToken: string) {
  await replyLineText(
    replyToken,
    "บัญชี LINE นี้เป็น FO จึงดูได้เฉพาะตารางกะของตัวเองเท่านั้น\n\n" +
    "ลองพิมพ์: shift, กะทำงาน, เวลาทำงาน หรือ เวรเดือนหน้า"
  );
}

async function replyUnboundLineUser(replyToken: string) {
  await replyLineText(
    replyToken,
    "ยังไม่ได้ผูก LINE กับบัญชี Staff\nกรุณาพิมพ์ BIND <token> เพื่อผูกบัญชีก่อนใช้งาน"
  );
}

async function handleBindCommand(params: {
  token: string;
  lineUserId: string;
  replyToken: string;
}) {
  const { token, lineUserId, replyToken } = params;
  const supabase = createServerSupabaseClient();
  const nowIso = new Date().toISOString();

  const { data: tokenRow, error: tokenError } = await supabase
    .from("line_binding_tokens")
    .select("token, staff_id")
    .eq("token", token)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .maybeSingle();

  if (tokenError) {
    console.error("line bind token lookup failed", tokenError);
    await replyLineText(replyToken, "ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง");
    return;
  }
  if (!tokenRow?.staff_id) {
    await replyLineText(replyToken, "Token ไม่ถูกต้องหรือหมดอายุ กรุณาขอใหม่จากระบบ");
    return;
  }

  const { data: duplicateStaff, error: duplicateError } = await supabase
    .from("staff")
    .select("id")
    .eq("line_user_id", lineUserId)
    .neq("id", tokenRow.staff_id)
    .maybeSingle();

  if (duplicateError) {
    console.error("line bind duplicate check failed", duplicateError);
    await replyLineText(replyToken, "ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง");
    return;
  }

  if (duplicateStaff?.id) {
    await replyLineText(
      replyToken,
      "LINE account นี้ผูกกับ staff คนอื่นอยู่แล้ว กรุณาติดต่อ Admin"
    );
    return;
  }

  const { data: consumeToken, error: consumeError } = await supabase
    .from("line_binding_tokens")
    .update({ used_at: nowIso })
    .eq("token", token)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .select("staff_id")
    .maybeSingle();

  if (consumeError) {
    console.error("line bind consume token failed", consumeError);
    await replyLineText(replyToken, "ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง");
    return;
  }

  if (!consumeToken?.staff_id) {
    await replyLineText(replyToken, "Token ไม่ถูกต้องหรือหมดอายุ กรุณาขอใหม่จากระบบ");
    return;
  }

  const { data: updatedStaff, error: updateStaffError } = await supabase
    .from("staff")
    .update({
      line_user_id: lineUserId,
      line_bound_at: nowIso,
    })
    .eq("id", consumeToken.staff_id)
    .select("display_name")
    .maybeSingle();

  if (updateStaffError) {
    console.error("line bind update staff failed", updateStaffError);
    await replyLineText(replyToken, "ผูก LINE ไม่สำเร็จ กรุณาขอ Token ใหม่แล้วลองอีกครั้ง");
    return;
  }

  const displayName = updatedStaff?.display_name
    ? String(updatedStaff.display_name)
    : "พนักงาน";
  await replyLineText(replyToken, `ผูก LINE สำเร็จ! ยินดีต้อนรับ คุณ ${displayName}`);
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-line-signature");

    if (!verifyLineSignature(rawBody, signature)) {
      return NextResponse.json({ success: false, error: "Invalid signature" }, { status: 401 });
    }

    let body: LineWebhookBody;
    try {
      body = JSON.parse(rawBody) as LineWebhookBody;
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const events = Array.isArray(body.events) ? body.events : [];
    for (const event of events) {
      let replyToken = event.replyToken ? String(event.replyToken) : "";
      try {
        // The bot answers only in a 1:1 chat. This must stay the first statement in this try,
        // so the exception reply below is also unreachable for a group or room source.
        // A missing source.type counts as non-user on purpose: silence is the safe direction.
        if (event.source?.type !== "user") continue;

        if (event.type !== "message" || event.message?.type !== "text") continue;
        const text = String(event.message.text ?? "").trim();
        const lineUserId = event.source?.userId ? String(event.source.userId) : "";
        if (!replyToken || !lineUserId) continue;

        const upper = text.toUpperCase();
        const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
        const isHelpQuery =
          norm === "help" ||
          norm === "ช่วยเหลือ" ||
          norm === "คำสั่ง" ||
          norm === "?" ||
          norm === "menu" ||
          norm === "เมนู";

        // --- BIND command ---
        if (upper.startsWith("BIND")) {
          // Accept both "BIND <token>" and "BIND<token>" to reduce operator mistakes.
          const token = text.slice(4).trim();
          if (!token) {
            await replyLineText(replyToken, "รูปแบบคำสั่งไม่ถูกต้อง ใช้ BIND <token>");
            continue;
          }
          await handleBindCommand({ token, lineUserId, replyToken });
          continue;
        }

        const staffAccess = await resolveLineStaffAccess(lineUserId);
        const scheduleQuery = isScheduleQuery(norm);

        if (staffAccess.isFrontdeskOnly && isHelpQuery) {
          await replyFoLineHelp(replyToken);
          continue;
        }

        if (!staffAccess.isBound && !isHelpQuery) {
          await replyUnboundLineUser(replyToken);
          continue;
        }

        if (staffAccess.isFrontdeskOnly && !scheduleQuery) {
          await replyFoRestricted(replyToken);
          continue;
        }

        // --- Checkout query ---
        const isCheckoutQuery =
          norm.includes("checkout") ||
          norm.includes("check out") ||
          norm.includes("check-out") ||
          norm.includes("เช็คเอาท์") ||
          norm.includes("เช็กเอาท์") ||
          norm.includes("เช็คเอา") ||
          norm.includes("c/o") ||
          norm.startsWith("co ") ||
          norm === "co";
        if (isCheckoutQuery) {
          await handleCheckoutQuery(replyToken);
          continue;
        }

        // --- In-house query ---
        const isInHouseQuery =
          norm === "inhouse" ||
          norm === "in house" ||
          norm === "ih" ||
          norm.includes("in house") ||
          norm.includes("inhouse") ||
          norm.includes("แขกพักอยู่") ||
          norm.includes("ห้องที่พัก") ||
          norm.includes("ใครพักอยู่");
        if (isInHouseQuery) {
          await handleInHouseQuery(replyToken);
          continue;
        }

        // --- Staff schedule query ---
        if (scheduleQuery) {
          const nextMonth = isScheduleNextMonthQuery(norm);
          await handleScheduleQuery({
            replyToken,
            lineUserId,
            nextMonth,
            period: !nextMonth && isScheduleWeekQuery(norm) ? "week" : "month",
          });
          continue;
        }

        // --- Help ---
        if (isHelpQuery) {
          await replyLineText(
            replyToken,
            "📖 คำสั่งที่ใช้ได้:\n\n" +
            "• checkout / co / เช็คเอาท์\n  → ยอด Check-out วันนี้\n\n" +
            "• inhouse / ih / in house\n  → ห้องที่มีแขกพักอยู่ตอนนี้\n\n" +
            "• schedule / shift / ตารางเวร / เวร\n  → ตารางเวรของตัวเองถึงสิ้นเดือน\n\n" +
            "• schedule next / เวรเดือนหน้า\n  → ตารางเวรของตัวเองเดือนถัดไป\n\n" +
            "• BIND <token>\n  → ผูก LINE กับบัญชี Staff\n\n" +
            "พิมพ์ help เพื่อดูคำสั่งทั้งหมด"
          );
          continue;
        }

        // --- Unknown ---
        await replyLineText(
          replyToken,
          "ไม่เข้าใจคำสั่ง 🤔\nพิมพ์ help เพื่อดูคำสั่งที่ใช้ได้"
        );
      } catch (eventErr) {
        console.error("line webhook event handler error", eventErr);
        if (event.source?.type === "user") {
          const msg = eventErr instanceof Error ? eventErr.message : String(eventErr);
          await replyLineText(replyToken, `[DEBUG exception] ${msg}`).catch(() => undefined);
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("api/webhooks/line POST failed", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
