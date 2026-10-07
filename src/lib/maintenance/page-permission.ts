// The maintenance page-permission predicate, extracted from api-auth.ts.
//
// Alias-free and self-contained (imports nothing) so a .contract.test.mjs can
// `await import("./page-permission.ts")` under node's type-stripping and CALL it.
// api-auth.ts itself imports "@/lib/server-auth" and "@/lib/supabase/server", so a
// predicate living there can only ever be source-GREPPED, never executed — and a
// source-grep pin on a security predicate is an instrument that cannot fail.
//
// Both real page paths count. The app serves maintenance from /pms/maintenance AND
// /pms/housekeeping/maintenance, and profiles are provisioned with either — honouring
// only one string silently locks out staff who hold the other (the same page-gate vs
// API-gate split that bites linen: /linen-mobile for the page, /pms/linen for the API).
export const MAINTENANCE_PAGE_ROOTS = ["/pms/maintenance", "/pms/housekeeping/maintenance"];

// ⚠ '*' does NOT satisfy this predicate. Product decision, 2026-07-18:
// the maintenance READ wall opens only for READ_ROLES or an EXPLICIT maintenance
// page grant. A blanket '*' in allowed_pages is a convenience grant handed out for
// unrelated surfaces; it must not silently carry maintenance read access with it.
//
// Scope note, deliberately recorded here rather than in a commit message alone: the
// same `page === "*"` idiom guards eight other surfaces (linen, analytics, amenity,
// amenity-audit, staff-schedule, maid-auth, auth-routing, middleware). Only
// maintenance is ruled. Do not "consistency-fix" the others without a ruling.
export function hasMaintenancePagePermission(allowedPages: unknown): boolean {
  if (!Array.isArray(allowedPages)) return false;
  return allowedPages
    .map((page) => String(page).trim())
    .some((page) =>
      MAINTENANCE_PAGE_ROOTS.some((root) => page === root || page.startsWith(`${root}/`))
    );
}
