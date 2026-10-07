#!/usr/bin/env bash
# Mutation battery for group-B tier 1: the two unordered/under-ordered offset
# pagers (revenue route + abbreviated-tax-invoice loadNights).
#
# Every mutant is CONFIRMED APPLIED before its verdict is read. "All mutants
# green" almost always means the battery never ran, so a mutant that does not
# change the file is reported as a HARNESS failure, not as a surviving mutant.
set -u

ROUTE="src/app/api/revenue/route.ts"
SERVICE="src/lib/abbreviated-tax-invoice/service.ts"
TESTS=(
  "src/app/api/revenue/route.contract.test.mjs"
  "src/lib/abbreviated-tax-invoice/service.contract.test.mjs"
  "src/lib/complete-fetch.contract.test.mjs"
)

P_ROUTE="$(mktemp)"; cp "$ROUTE" "$P_ROUTE"
P_SVC="$(mktemp)"; cp "$SERVICE" "$P_SVC"
trap 'cp "$P_ROUTE" "$ROUTE"; cp "$P_SVC" "$SERVICE"; rm -f "$P_ROUTE" "$P_SVC"' EXIT

pass=0; fail=0

# Any of the three guards catching it counts as killed — they guard the same
# invariant from different angles, and which one fires is not the point.
run_tests() {
  for t in "${TESTS[@]}"; do
    node "$t" >/dev/null 2>&1 || return 1
  done
  return 0
}

if run_tests; then
  echo "baseline      GREEN ✅  (pristine passes — verdicts below are readable)"
else
  echo "baseline      RED ❌  — pristine already fails; battery aborted"
  exit 1
fi

mutate() {
  local name="$1" target="$2" pristine="$3" expr="$4"
  cp "$pristine" "$target"
  perl -0pi -e "$expr" "$target"
  if cmp -s "$pristine" "$target"; then
    echo "  $name  HARNESS ❌  mutant never applied (file unchanged) — verdict void"
    fail=$((fail+1)); return
  fi
  if run_tests; then
    echo "  $name  SURVIVED ❌  every guard stayed green on mutated code"
    fail=$((fail+1))
  else
    echo "  $name  KILLED ✅"
    pass=$((pass+1))
  fi
  cp "$pristine" "$target"
}

echo "revenue route (offset pager with NO .order):"
mutate "R1 drop id from pos_orders projection   " "$ROUTE" "$P_ROUTE" 's/\.select\("id, total, order_date, status"/.select("total, order_date, status"/'
mutate "R2 drop count exact from nights         " "$ROUTE" "$P_ROUTE" 's/\`, \{ count: "exact" \}\)/\`)/'
mutate "R3 nights: leading id -> nested id only " "$ROUTE" "$P_ROUTE" 's/\.select\(\`id,\n        room_id,/.select(\`room_id,/'
mutate "R4 drop count exact from pos_orders     " "$ROUTE" "$P_ROUTE" 's/\.select\("id, total, order_date, status", \{ count: "exact" \}\)/.select("id, total, order_date, status")/'
mutate "R5 revert one read to the old pager     " "$ROUTE" "$P_ROUTE" 's/fetchAllRowsComplete<RevenuePosOrderRow>/fetchRevenueRows<RevenuePosOrderRow>/'
mutate "R6 unregister one paged read            " "$ROUTE" "$P_ROUTE" 's/fetchAllRowsComplete<RevenueDayuseRow>/plainFetch<RevenueDayuseRow>/'

echo "loadNights (offset pager under a NON-UNIQUE .order):"
mutate "N1 drop count exact                     " "$SERVICE" "$P_SVC" 's/"id, reservation_id, room_id, stay_date, nightly_price, cancelled_at, rooms\(id, room_type_id, room_types\(code, name_en\)\)",\n            \{ count: "exact" \}/"id, reservation_id, room_id, stay_date, nightly_price, cancelled_at, rooms(id, room_type_id, room_types(code, name_en))"/'
mutate "N2 drop id from projection               " "$SERVICE" "$P_SVC" 's/"id, reservation_id, room_id, stay_date/"reservation_id, room_id, stay_date/'
mutate "N3 reintroduce the non-unique .order     " "$SERVICE" "$P_SVC" 's/\.in\("reservation_id", reservationIds\),\n      \{ label: "invoice nights" \}/.in("reservation_id", reservationIds).order("stay_date", { ascending: true }),\n      { label: "invoice nights" }/'
mutate "N4 unregister the paged read             " "$SERVICE" "$P_SVC" 's/rows = await fetchAllRowsComplete<any>\(/rows = await plainFetch<any>(/'

cp "$P_ROUTE" "$ROUTE"; cp "$P_SVC" "$SERVICE"
if cmp -s "$P_ROUTE" "$ROUTE" && cmp -s "$P_SVC" "$SERVICE"; then
  echo "restore       byte-identical ✅"
else
  echo "restore       FAILED ❌"
fi
echo "result: $pass killed, $fail not killed"
[ "$fail" -eq 0 ]
