import assert from "node:assert/strict";
import {
  allocateRoomAndExtraAcrossNights,
  applyCoveredRoomRevenueToNights,
  completeChargedReservationNightsFromAuditTotal,
  computeInvoiceableRoomTotal,
  distributeAuditTotalAcrossNights,
} from "./night-allocation.ts";

const activeMoveNights = [
  {
    id: "night-314",
    stay_date: "2026-05-10",
    nightly_price: 550,
    cancelled_at: null,
  },
  {
    id: "night-106",
    stay_date: "2026-05-11",
    nightly_price: 1590,
    cancelled_at: null,
  },
];

const uncoveredMoveNights = applyCoveredRoomRevenueToNights(activeMoveNights, {
  "2026-05-11": 1590,
});

assert.deepEqual(
  uncoveredMoveNights.map((night) => ({
    id: night.id,
    stay_date: night.stay_date,
    nightly_price: night.nightly_price,
  })),
  [
    {
      id: "night-314",
      stay_date: "2026-05-10",
      nightly_price: 550,
    },
  ],
  "full-tax covered room dates should be removed before abbreviated residual allocation"
);

assert.equal(
  computeInvoiceableRoomTotal({
    auditRoomTotal: 1620,
    includedNights: uncoveredMoveNights,
    capToIncludedNightTotal: true,
  }),
  550,
  "full-tax residual room total should be capped to uncovered nightly charges"
);

const earlyCheckoutNights = completeChargedReservationNightsFromAuditTotal(
  {
    checkin_date: "2026-05-05",
    checkout_date: "2026-05-17",
  },
  [
    { id: "05", stay_date: "2026-05-05", nightly_price: 1390, cancelled_at: null },
    { id: "06", stay_date: "2026-05-06", nightly_price: 1390, cancelled_at: null },
    { id: "07", stay_date: "2026-05-07", nightly_price: 1390, cancelled_at: null },
    { id: "08", stay_date: "2026-05-08", nightly_price: 1390, cancelled_at: null },
    { id: "09", stay_date: "2026-05-09", nightly_price: 1390, cancelled_at: null },
    { id: "10", stay_date: "2026-05-10", nightly_price: 1390, cancelled_at: null },
    { id: "11", stay_date: "2026-05-11", nightly_price: 1590, cancelled_at: null },
    { id: "12", stay_date: "2026-05-12", nightly_price: 1390, cancelled_at: null },
    { id: "13", stay_date: "2026-05-13", nightly_price: 1390, cancelled_at: null },
    { id: "14", stay_date: "2026-05-14", nightly_price: 1390, cancelled_at: null },
    { id: "15", stay_date: "2026-05-15", nightly_price: 1390, cancelled_at: null },
    {
      id: "16-cancelled-charged",
      stay_date: "2026-05-16",
      nightly_price: 1390,
      cancelled_at: "2026-05-16T04:28:50.826+00:00",
    },
  ],
  16880,
  0
);

assert.equal(
  earlyCheckoutNights.some((night) => night.id === "16-cancelled-charged"),
  true,
  "charged cancelled early-checkout night should still be restored"
);

const fullyCancelledRoomMoveNights = completeChargedReservationNightsFromAuditTotal(
  {
    checkin_date: "2026-06-28",
    checkout_date: "2026-06-29",
  },
  [
    {
      id: "room-238-moved",
      stay_date: "2026-06-28",
      nightly_price: 520,
      cancelled_at: "2026-06-28T11:36:36.108+00:00",
    },
    {
      id: "room-320-checked-out",
      stay_date: "2026-06-28",
      nightly_price: 520,
      cancelled_at: "2026-06-28T22:33:41.443+00:00",
    },
  ],
  520,
  0
);

assert.deepEqual(
  fullyCancelledRoomMoveNights.map((night) => night.id),
  ["room-320-checked-out"],
  "fully cancelled room moves should restore the latest exact charged candidate"
);

assert.deepEqual(
  distributeAuditTotalAcrossNights(4820, [
    { stay_date: "2026-05-10", nightly_price: 1590, cancelled_at: null },
    { stay_date: "2026-05-11", nightly_price: 1590, cancelled_at: null },
    { stay_date: "2026-05-12", nightly_price: 1590, cancelled_at: null },
  ]),
  [1607, 1607, 1606],
  "integer audit totals should be distributed as whole baht, not satang decimals"
);

assert.deepEqual(
  allocateRoomAndExtraAcrossNights({
    roomAuditTotal: 2130,
    extraAuditTotal: 20,
    includedNights: [
      { stay_date: "2026-05-15", nightly_price: 750, cancelled_at: null },
      { stay_date: "2026-05-16", nightly_price: 690, cancelled_at: null },
      { stay_date: "2026-05-17", nightly_price: 690, cancelled_at: null },
    ],
    capRoomToIncludedNightTotal: false,
  }).amounts,
  [750, 690, 710],
  "explicit extra revenue should be added to the last included night"
);

assert.deepEqual(
  allocateRoomAndExtraAcrossNights({
    roomAuditTotal: 4820,
    extraAuditTotal: 0,
    includedNights: [
      { stay_date: "2026-05-10", nightly_price: 1590, cancelled_at: null },
      { stay_date: "2026-05-11", nightly_price: 1590, cancelled_at: null },
      { stay_date: "2026-05-12", nightly_price: 1590, cancelled_at: null },
    ],
    capRoomToIncludedNightTotal: false,
  }).amounts,
  [1590, 1590, 1640],
  "room audit overage above nightly charges should be treated as extra on the last night"
);

assert.deepEqual(
  allocateRoomAndExtraAcrossNights({
    roomAuditTotal: 1800,
    extraAuditTotal: 100,
    includedNights: [
      { stay_date: "2026-05-01", nightly_price: 1000, cancelled_at: null },
      { stay_date: "2026-05-02", nightly_price: 1000, cancelled_at: null },
    ],
    capRoomToIncludedNightTotal: false,
  }).amounts,
  [900, 1000],
  "discounted room revenue should distribute across nights while extra stays on the last night"
);

assert.deepEqual(
  allocateRoomAndExtraAcrossNights({
    roomAuditTotal: 1620,
    extraAuditTotal: 0,
    includedNights: [
      { stay_date: "2026-05-10", nightly_price: 550, cancelled_at: null },
    ],
    capRoomToIncludedNightTotal: true,
  }).amounts,
  [550],
  "full-tax room coverage caps room residual without converting covered room revenue to extra"
);

assert.deepEqual(
  distributeAuditTotalAcrossNights(2150, [
    { stay_date: "2026-05-15", nightly_price: 750, cancelled_at: null },
    { stay_date: "2026-05-16", nightly_price: 690, cancelled_at: null },
    { stay_date: "2026-05-17", nightly_price: 690, cancelled_at: null },
  ]),
  [757, 697, 696],
  "integer proportional distribution should keep whole-baht unit prices while preserving total"
);
