import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Execute the real middleware and SDK. Only cookie-session and network boundaries
// are simulated: PostgREST sees no profile when Authorization is the anon key.
const require = createRequire(import.meta.url);
const M = Module as any;
const originalLoad = M._load;
const originalResolve = M._resolveFilename;
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const url = "https://owner-wall.invalid";
const anonKey = "owner-wall-test-anon-key";
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
let profile: Record<string, unknown> | null = { role: "frontdesk" };
let profileError = false;
let dataWithError = false;
let authenticated = true;
let requests: Array<{ pathname: string; authorization: string | null; apikey: string | null; query: string }> = [];
let cookieClients = 0;

globalThis.fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const authorization = headers.get("authorization");
  requests.push({ pathname: target.pathname, authorization, apikey: headers.get("apikey"), query: target.search });
  if (target.pathname === "/auth/v1/user") {
    return new Response(JSON.stringify(authenticated ? { id: "actor", email: "staff@example.invalid" } : { message: "Invalid token" }), {
      status: authenticated ? 200 : 401, headers: { "content-type": "application/json" },
    });
  }
  assert.equal(target.pathname, "/rest/v1/profiles", "unexpected database request");
  const userContext = authorization !== `Bearer ${anonKey}`;
  return new Response(JSON.stringify(profileError ? { message: "Profile unavailable", code: "XX000" } : userContext && profile ? [profile] : []), {
    status: profileError ? 500 : 200, headers: { "content-type": "application/json" },
  });
};
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return originalResolve.call(this, request.startsWith("@/") ? path.join(process.cwd(), "src", request.slice(2)) : request, ...rest);
};
M._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/supabase/middleware") return {
    createMiddlewareSupabaseClient(req: NextRequest, response: NextResponse) {
      cookieClients++;
      const hasCookie = req.cookies.has("test-session");
      const client = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: hasCookie ? { headers: { Authorization: "Bearer cookie-session-token" } } : undefined,
      });
      const getUser = client.auth.getUser.bind(client.auth);
      client.auth.getUser = async (token?: string) => {
        if (!token && hasCookie) response.cookies.set("refreshed-session", "fresh", { httpOnly: true });
        return getUser(token ?? (hasCookie ? "cookie-session-token" : anonKey));
      };
      // An error alongside nonempty data is a separate boundary case: no HTTP
      // response can make the real SDK return both, so stub only that result.
      if (dataWithError) client.from = (() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "frontdesk" }, error: { message: "Profile failed" } }) }) }) })) as any;
      return client;
    },
  };
  return originalLoad.call(this, request, parent, isMain);
};
const { middleware } = require("./middleware.ts") as { middleware: (request: NextRequest) => Promise<NextResponse> };
after(() => {
  M._load = originalLoad;
  M._resolveFilename = originalResolve;
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  if (originalAnon === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalAnon;
});
function reset(role: unknown = "frontdesk") {
  profile = { role }; profileError = false; dataWithError = false; authenticated = true; requests = []; cookieClients = 0;
}
function request(pathname = "/api/bookings/booking/payments", method = "POST", mode: "bearer" | "cookie" = "bearer") {
  return new NextRequest(`http://localhost${pathname}`, { method, headers: mode === "bearer" ? { authorization: "Bearer user-session-token" } : { cookie: "test-session=yes" } });
}
function profileRequests() { return requests.filter(r => r.pathname === "/rest/v1/profiles"); }

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`bearer owner ${method} is forbidden under user RLS context`, async () => {
    reset("owner");
    const response = await middleware(request(undefined, method));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "Owner is view-only.");
    assert.deepEqual(profileRequests().map(r => r.authorization), ["Bearer user-session-token"]);
  });
}
test("bearer frontdesk mutation positive control", async () => {
  reset();
  const response = await middleware(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});
test("bearer profiles carry actual SDK Authorization and anon apikey", async () => {
  reset();
  const response = await middleware(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
  assert.deepEqual(profileRequests().map(r => [r.authorization, r.apikey]), [["Bearer user-session-token", anonKey]]);
  assert.match(profileRequests()[0].query, /user_id=eq.actor/);
});
test("SDK RLS control: anonymous profile context returns no row", async () => {
  reset("owner");
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await anon.from("profiles").select("role").eq("user_id", "actor").maybeSingle();
  assert.equal(result.error, null);
  assert.equal(result.data, null);
  assert.equal(profileRequests()[0].authorization, `Bearer ${anonKey}`);
});
for (const mode of ["bearer", "cookie"] as const) {
  test(`${mode} profile read error fails closed`, async () => {
    reset(); profileError = true;
    assert.equal((await middleware(request(undefined, "POST", mode))).status, 403);
  });
  for (const [name, value] of [["null", null], ["missing", undefined], ["empty", ""], ["whitespace", "  \t " ]] as const) {
    test(`${mode} ${name} role fails closed`, async () => {
      reset(); profile = { role: value };
      assert.equal((await middleware(request(undefined, "POST", mode))).status, 403);
    });
  }
  test(`${mode} missing profile fails closed`, async () => {
    reset(); profile = null;
    assert.equal((await middleware(request(undefined, "POST", mode))).status, 403);
  });
}
test("profile error takes precedence over nonempty frontdesk data", async () => {
  reset(); dataWithError = true;
  assert.equal((await middleware(request(undefined, "POST", "cookie"))).status, 403);
});
test("cookie owner remains forbidden", async () => {
  reset(" OwNeR ");
  assert.equal((await middleware(request(undefined, "POST", "cookie"))).status, 403);
});
test("cookie frontdesk retains session refresh response", async () => {
  reset();
  const response = await middleware(request(undefined, "POST", "cookie"));
  assert.equal(response.status, 200);
  assert.equal(response.cookies.get("refreshed-session")?.value, "fresh");
  assert.equal(cookieClients, 1);
  assert.deepEqual(profileRequests().map(r => r.authorization), ["Bearer cookie-session-token"]);
});
test("unauthenticated mutation remains 401 without profiles", async () => {
  reset(); authenticated = false;
  assert.equal((await middleware(request())).status, 401);
  assert.equal(profileRequests().length, 0);
});
const safePaths = ["/api/room-planner/preview", "/api/bookings/b/extend-stay/preview", "/api/bookings/b/ota-extend-orchestrator/preview", "/api/dynamic-rules/simulate", "/api/tax/lookup", "/api/mobile-text", "/api/mobile-text/child"];
for (const pathname of safePaths) {
  test(`owner-safe mutation bypass unchanged: ${pathname}`, async () => {
    reset("owner"); profileError = true;
    assert.equal((await middleware(request(pathname))).status, 200);
    assert.equal(cookieClients, 0); assert.equal(requests.length, 0);
  });
}
const publicPaths = ["/api/auth", "/api/webhooks", "/api/linen/vendor", "/api/integrations/scb/callback", "/api/backup/device-pair", "/api/cron", "/api/telegram/webhook/bot-token"];
for (const pathname of publicPaths) {
  test(`public mutation bypass unchanged: ${pathname}`, async () => {
    reset(); authenticated = false;
    for (const target of pathname.startsWith("/api/telegram") ? [pathname] : [pathname, `${pathname}/child`]) {
      assert.equal((await middleware(request(target))).status, 200);
    }
    assert.equal(cookieClients, 0); assert.equal(requests.length, 0);
  });
}
test("owner-safe exact matching and public prefix boundaries stay protected", async () => {
  for (const pathname of ["/api/room-planner/preview/child", "/api/mobile-text-unsafe", "/api/cron-unsafe", "/api/telegram/webhook/register"]) {
    reset("owner");
    assert.equal((await middleware(request(pathname, "POST", "cookie"))).status, 403, pathname);
  }
});
test("owner authenticated GET remains allowed without a role lookup", async () => {
  reset("owner");
  assert.equal((await middleware(request(undefined, "GET"))).status, 200);
  assert.equal(profileRequests().length, 0);
});
