import assert from "node:assert/strict";
import {
  linkStay,
  unlinkStay,
  LinkedStayManagementError,
} from "./linked-stay-management.ts";

type ResRow = {
  id: string;
  parent_reservation_id: string | null;
  guest_profile_id: string | null;
  guest_name: string | null;
  checkin_date: string;
  checkout_date: string;
  status: string;
  checked_in_at: string | null;
  checkin_time: string | null;
};

type AuditRow = Record<string, unknown>;

class Db {
  reservations: Map<string, ResRow>;
  audits: AuditRow[] = [];
  plannedMoves: any[] = [];
  failUpdate: ((payload: Record<string, unknown>) => string | null) | null = null;

  constructor(rows: ResRow[]) {
    this.reservations = new Map(rows.map((r) => [r.id, { ...r }]));
  }

  from(table: string) {
    const self = this;
    if (table === "hotel_settings") {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: { business_date: "2026-09-22" },
                  error: null,
                }),
              };
            },
          };
        },
      };
    }
    if (table === "audit_logs") {
      return {
        insert: async (row: AuditRow) => {
          self.audits.push(row);
          return { data: row, error: null };
        },
      };
    }
    if (table === "reservation_room_plans") {
      return {
        select() {
          return {
            eq() {
              return {
                or: async () => ({ data: self.plannedMoves, error: null }),
              };
            },
          };
        },
      };
    }
    if (table !== "reservations") {
      throw new Error(`Unexpected table: ${table}`);
    }

    let selectOpts: { count?: string; head?: boolean } | null = null;
    let filter: { type: string; key: string; value: any } | null = null;
    let updatePayload: Record<string, unknown> | null = null;

    const runSelect = async () => {
      let rows = [...self.reservations.values()];
      if (filter?.type === "in" && filter.key === "id") {
        const ids = new Set((filter.value as string[]).map(String));
        rows = rows.filter((r) => ids.has(r.id));
      } else if (filter?.type === "eq") {
        rows = rows.filter((r) => String((r as any)[filter!.key] ?? "") === String(filter!.value));
      }
      if (selectOpts?.count === "exact" && selectOpts?.head) {
        return { data: null, error: null, count: rows.length };
      }
      return { data: rows, error: null, count: rows.length };
    };

    const runUpdate = async () => {
      const failure = self.failUpdate?.(updatePayload ?? {});
      if (failure) return { data: null, error: { message: failure } };
      let targets = [...self.reservations.values()];
      if (filter?.type === "eq") {
        targets = targets.filter((r) => String((r as any)[filter!.key] ?? "") === String(filter!.value));
      } else if (filter?.type === "in" && filter.key === "id") {
        const ids = new Set((filter.value as string[]).map(String));
        targets = targets.filter((r) => ids.has(r.id));
      }
      for (const row of targets) {
        Object.assign(row, updatePayload);
      }
      return { data: targets, error: null };
    };

    const builder: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        selectOpts = opts ?? null;
        return builder;
      },
      update(payload: Record<string, unknown>) {
        updatePayload = payload;
        return builder;
      },
      in(key: string, value: any) {
        filter = { type: "in", key, value };
        if (updatePayload) return runUpdate();
        return runSelect();
      },
      eq(key: string, value: any) {
        filter = { type: "eq", key, value };
        return builder;
      },
      maybeSingle: async () => {
        const { data, error } = await runSelect();
        return { data: (data as any[])?.[0] ?? null, error };
      },
      then(resolve: any, reject: any) {
        const p = updatePayload ? runUpdate() : runSelect();
        return p.then(resolve, reject);
      },
    };
    return builder;
  }
}

const STAMP = "2026-09-20T04:15:00.000Z";
const STAMP_OTHER = "2026-09-21T05:00:00.000Z";

function basePair(overrides?: { parent?: Partial<ResRow>; child?: Partial<ResRow> }): ResRow[] {
  const parent: ResRow = {
    id: "parent-1",
    parent_reservation_id: null,
    guest_profile_id: "guest-1",
    guest_name: "Test Guest",
    checkin_date: "2026-09-20",
    checkout_date: "2026-09-22",
    status: "active",
    checked_in_at: STAMP,
    checkin_time: "11:15",
    ...overrides?.parent,
  };
  const child: ResRow = {
    id: "child-1",
    parent_reservation_id: null,
    guest_profile_id: "guest-1",
    guest_name: "Test Guest",
    checkin_date: "2026-09-22",
    checkout_date: "2026-09-24",
    status: "active",
    checked_in_at: null,
    checkin_time: null,
    ...overrides?.child,
  };
  return [parent, child];
}

async function main() {
  // 1) Link inherits check-in from checked-in parent onto due-in child
  {
    const db = new Db(basePair());
    const result = await linkStay({
      supabase: db as any,
      parentReservationId: "parent-1",
      payload: { child_reservation_id: "child-1" },
    });
    assert.equal(result.success, true);
    assert.equal(result.parent_reservation_id, "parent-1");
    const child = db.reservations.get("child-1")!;
    assert.equal(child.parent_reservation_id, "parent-1");
    assert.equal(child.status, "active");
    assert.equal(child.checked_in_at, STAMP);
    assert.equal(child.checkin_time, "11:15");
    const linkAudit = db.audits.find((a) => a.action === "linked_stay_manual_link");
    assert.equal((linkAudit?.after_json as any)?.auto_checked_in, true);
    assert.ok(db.audits.some((a) => a.action === "checked_in"));
    assert.ok(db.audits.some((a) => a.action === "auto_checkin_linked_extension"));
  }

  // 2) Link skips inherit when parent not checked in
  {
    const db = new Db(
      basePair({
        parent: { checked_in_at: null, checkin_time: null, status: "active" },
      })
    );
    await linkStay({
      supabase: db as any,
      parentReservationId: "parent-1",
      payload: { child_reservation_id: "child-1" },
    });
    const child = db.reservations.get("child-1")!;
    assert.equal(child.parent_reservation_id, "parent-1");
    assert.equal(child.checked_in_at, null);
    assert.equal(child.checkin_time, null);
    const linkAudit = db.audits.find((a) => a.action === "linked_stay_manual_link");
    assert.equal((linkAudit?.after_json as any)?.auto_checked_in, false);
    assert.equal(db.audits.filter((a) => a.action === "checked_in").length, 0);
  }

  // 3) Swap branch: earlier segment (payload child) is root; later inherits if earlier checked in
  {
    const db = new Db(
      basePair({
        // User picks later as "parent" and earlier as "child"
        parent: {
          id: "later",
          checkin_date: "2026-09-22",
          checkout_date: "2026-09-24",
          checked_in_at: null,
          checkin_time: null,
          status: "active",
        },
        child: {
          id: "earlier",
          checkin_date: "2026-09-20",
          checkout_date: "2026-09-22",
          checked_in_at: STAMP,
          checkin_time: "11:15",
          status: "active",
        },
      })
    );
    const result = await linkStay({
      supabase: db as any,
      parentReservationId: "later",
      payload: { child_reservation_id: "earlier" },
    });
    assert.equal(result.parent_reservation_id, "earlier");
    const later = db.reservations.get("later")!;
    assert.equal(later.parent_reservation_id, "earlier");
    assert.equal(later.checked_in_at, STAMP);
    assert.equal(later.status, "active");
  }

  // 4) Unlink clears matching inherited stamp when parent still in-house
  {
    const db = new Db(
      basePair({
        child: {
          parent_reservation_id: "parent-1",
          status: "active",
          checked_in_at: STAMP,
          checkin_time: "11:15",
        },
      })
    );
    await unlinkStay({
      supabase: db as any,
      reservationId: "child-1",
      payload: {},
    });
    const child = db.reservations.get("child-1")!;
    assert.equal(child.parent_reservation_id, null);
    assert.equal(child.checked_in_at, null);
    assert.equal(child.checkin_time, null);
    const unlinkAudit = db.audits.find((a) => a.action === "linked_stay_manual_unlink");
    assert.equal((unlinkAudit?.after_json as any)?.cleared_inherited_checkin, true);
    assert.ok(db.audits.some((a) => a.action === "linked_stay_clear_inherited_checkin"));
  }

  // 5) Unlink does NOT clear when stamps differ (independent check-in)
  {
    const db = new Db(
      basePair({
        child: {
          parent_reservation_id: "parent-1",
          status: "active",
          checked_in_at: STAMP_OTHER,
          checkin_time: "12:00",
        },
      })
    );
    await unlinkStay({
      supabase: db as any,
      reservationId: "child-1",
      payload: {},
    });
    const child = db.reservations.get("child-1")!;
    assert.equal(child.parent_reservation_id, null);
    assert.equal(child.checked_in_at, STAMP_OTHER);
    assert.equal(child.checkin_time, "12:00");
    const unlinkAudit = db.audits.find((a) => a.action === "linked_stay_manual_unlink");
    assert.equal((unlinkAudit?.after_json as any)?.cleared_inherited_checkin, false);
  }

  // 6) Unlink still blocks parent checked_out + child checked in
  {
    const db = new Db(
      basePair({
        parent: { status: "checked_out", checked_in_at: STAMP },
        child: {
          parent_reservation_id: "parent-1",
          status: "active",
          checked_in_at: STAMP,
          checkin_time: "11:15",
        },
      })
    );
    await assert.rejects(
      () =>
        unlinkStay({
          supabase: db as any,
          reservationId: "child-1",
          payload: {},
        }),
      (err: unknown) =>
        err instanceof LinkedStayManagementError &&
        /parent has already checked out/i.test(err.message)
    );
    const child = db.reservations.get("child-1")!;
    assert.equal(child.parent_reservation_id, "parent-1");
    assert.equal(child.checked_in_at, STAMP);
  }

  // 7) Inherit uses Asia/Bangkok HH:mm from checked_in_at when checkin_time missing
  {
    const db = new Db(
      basePair({
        parent: { checkin_time: null, checked_in_at: "2026-09-20T04:15:00.000Z" },
      })
    );
    await linkStay({
      supabase: db as any,
      parentReservationId: "parent-1",
      payload: { child_reservation_id: "child-1" },
    });
    const child = db.reservations.get("child-1")!;
    // 04:15Z = 11:15 Asia/Bangkok
    assert.equal(child.checkin_time, "11:15");
  }

  // Existing suppressed siblings must not be reactivated while another pair is linked.
  if (!process.argv[2] || process.argv[2] === "review-cancelled-sibling") {
    const rows = basePair();
    const cancelledSibling: ResRow = {
      ...rows[1],
      id: "cancelled-existing",
      parent_reservation_id: "parent-1",
      status: "cancelled",
    };
    const db = new Db([rows[0], cancelledSibling, rows[1]]);
    await linkStay({
      supabase: db as any,
      parentReservationId: "parent-1",
      payload: { child_reservation_id: "child-1" },
    });
    assert.deepEqual(db.reservations.get(cancelledSibling.id), cancelledSibling,
      "linking a different segment must preserve a cancelled sibling");
    assert.equal(db.reservations.get("child-1")?.checked_in_at, STAMP,
      "the incoming active pair still inherits check-in");
  }

  // A failed inheritance write must leave the link untouched so the operation can retry.
  if (!process.argv[2] || process.argv[2] === "review-link-failure") {
    const db = new Db(basePair());
    const before = { ...db.reservations.get("child-1")! };
    db.failUpdate = (payload) => payload.checked_in_at === STAMP ? "injected inherit failure" : null;
    await assert.rejects(() => linkStay({
      supabase: db as any,
      parentReservationId: "parent-1",
      payload: { child_reservation_id: "child-1" },
    }), /injected inherit failure/);
    assert.deepEqual(db.reservations.get("child-1"), before,
      "failed link and inheritance must not leave a partial relationship");
    db.failUpdate = null;
    await linkStay({
      supabase: db as any,
      parentReservationId: "parent-1",
      payload: { child_reservation_id: "child-1" },
    });
    assert.equal(db.reservations.get("child-1")?.parent_reservation_id, "parent-1");
    assert.equal(db.reservations.get("child-1")?.checked_in_at, STAMP);
  }

  // A failed unlink must preserve the inherited stamp alongside the relationship.
  if (!process.argv[2] || process.argv[2] === "review-unlink-failure") {
    const db = new Db(basePair({ child: {
      parent_reservation_id: "parent-1", status: "active",
      checked_in_at: STAMP, checkin_time: "11:15",
    } }));
    const before = { ...db.reservations.get("child-1")! };
    db.failUpdate = (payload) => Object.hasOwn(payload, "parent_reservation_id")
      && payload.parent_reservation_id === null ? "injected unlink failure" : null;
    await assert.rejects(() => unlinkStay({
      supabase: db as any, reservationId: "child-1", payload: {},
    }), /injected unlink failure/);
    assert.deepEqual(db.reservations.get("child-1"), before,
      "failed unlink must not erase a still-linked guest's check-in");
  }

  console.log("linked-stay-management.test.mts: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
