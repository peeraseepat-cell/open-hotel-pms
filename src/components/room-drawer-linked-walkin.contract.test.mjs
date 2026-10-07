import assert from "node:assert/strict";
import fs from "node:fs";

const drawerSource = fs.readFileSync(new URL("./room-drawer.tsx", import.meta.url), "utf8");
const boardSource = fs.readFileSync(new URL("../app/pms/board/page.tsx", import.meta.url), "utf8");
const housekeepingRouteSource = fs.readFileSync(
  new URL("../app/api/housekeeping/status/route.ts", import.meta.url),
  "utf8"
);

assert.match(
  drawerSource,
  /parent_reservation_id\?: string \| null;/,
  "Room Drawer reservation context should include the linked parent id"
);

assert.match(
  drawerSource,
  /const canActivatePendingLinkedWalkIn = Boolean\([\s\S]*?diaryState === "due_in"[\s\S]*?res\?\.source === "walkin"[\s\S]*?res\?\.parent_reservation_id[\s\S]*?\);/,
  "A due-in linked Walk-in should expose Room Rack housekeeping controls before the noon segment switch"
);

assert.match(
  drawerSource,
  /const canInHouseActions = Boolean\([\s\S]*?canActivatePendingLinkedWalkIn[\s\S]*?\);/,
  "The linked Walk-in capability should participate in the Room Rack control gate"
);

assert.match(
  boardSource,
  /parent_reservation_id: reservation\.parent_reservation_id \?\? null,/,
  "Board booking detail mapping should pass the linked parent id into Room Drawer"
);

const genericStatusStart = housekeepingRouteSource.lastIndexOf("const { room_id, date, new_status }");
assert.notEqual(genericStatusStart, -1, "Generic housekeeping status handler should exist");
const genericStatusSource = housekeepingRouteSource.slice(genericStatusStart);

assert.match(
  genericStatusSource,
  /if \(new_status === "dirty"\) \{\s*await maybeActivateLinkedWalkInForRoomDiary\(supabase, room_id, date, false\);\s*\}/,
  "HK Dashboard Mark Dirty should activate a qualifying linked Walk-in through the same guarded path"
);
