import assert from "node:assert/strict";
import { test } from "node:test";
import { preflight, type Config, type Report } from "../src/index.ts";
import { encode } from "../src/stripe.ts";

type Request = { method: string; path: string; query: URLSearchParams; body: URLSearchParams };
type Route = (req: Request) => [number, unknown] | undefined;

/** A stand-in for api.stripe.com: answers from the routes, records every request. */
function fakeStripe(...routes: Route[]) {
  const calls: Request[] = [];
  const fetchImpl = async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const req = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
    };
    calls.push(req);
    for (const route of routes) {
      const hit = route(req);
      if (hit) return new Response(JSON.stringify(hit[1]), { status: hit[0] });
    }
    return new Response(JSON.stringify({ error: { message: `no route for ${req.method} ${req.path}` } }), { status: 404 });
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

const on =
  (method: string, path: string, status: number, body: unknown): Route =>
  (req) =>
    req.method === method && req.path === path ? [status, body] : undefined;
const list = (data: unknown[]) => ({ object: "list", data, has_more: false });
const denied = (rak: string) => ({
  error: {
    type: "invalid_request_error",
    message: `The provided key 'rk_test_***' does not have the required permissions for this endpoint on account 'acct_1'. Having the '${rak}' permission would allow this request to continue.`,
  },
});
const results = (report: Report, area: string) => report.results.filter((r) => r.area === area);
const run = (config: Config, stripe: ReturnType<typeof fakeStripe>, key = "sk_test_x", more = {}) =>
  preflight({ deliveries: false, ...config }, { key, fetch: stripe.fetch, ...more });

const URL_ = "https://shop.example/api/stripe";
const EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded"];

test("encodes nested params the way Stripe reads them", () => {
  assert.equal(
    decodeURIComponent(encode({ a: ["x", "y"], b: { c: { d: true } }, e: undefined, f: 1 })),
    "a[0]=x&a[1]=y&b[c][d]=true&f=1",
  );
});

test("refuses unsafe runs before calling Stripe", async () => {
  const stripe = fakeStripe();
  await assert.rejects(run({}, stripe, "sk_live_x", { apply: true }), /without --confirm-live/);
  await assert.rejects(run({}, stripe, "sk_test_x", { expect: "live" }), /Expected a live key/);
  await assert.rejects(run({}, stripe, "pk_test_x"), /publishable key/);
  await assert.rejects(run({ webhook: [] } as Config, stripe), /unknown field "webhook"/);
  await assert.rejects(run({ permissions: { refund: "write" } }, stripe), /unknown resource "refund"/);
  assert.equal(stripe.calls.length, 0);
});

test("a rejected key stops the run", async () => {
  const stripe = fakeStripe(on("GET", "/v1/account", 401, { error: { message: "Invalid API Key provided" } }));
  await assert.rejects(run({}, stripe), /Stripe rejected the key/);
});

test("an unreachable Stripe stops the run with one message", async () => {
  const offline = (async () => {
    throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.stripe.com") });
  }) as typeof fetch;
  await assert.rejects(
    preflight({}, { key: "sk_test_x", fetch: offline }),
    /Could not reach api.stripe.com: getaddrinfo ENOTFOUND/,
  );
});

test("account: restricted keys cannot read it, so the check is skipped", async () => {
  const stripe = fakeStripe(on("GET", "/v1/account", 403, denied("rak_accounts_read")));
  const [r] = results(await run({}, stripe, "rk_test_x"), "account");
  assert.equal(r?.status, "skip");
  assert.match(r!.message, /rak_accounts_read/);
});

test("account: wrong public details fail; an unactivated account only warns in test mode", async () => {
  const acct = {
    id: "acct_1",
    country: "ES",
    details_submitted: false,
    charges_enabled: false,
    payouts_enabled: false,
    business_profile: { name: "Shop", support_email: "old@shop.example" },
  };
  const stripe = fakeStripe(on("GET", "/v1/account", 200, acct));
  const [wrong] = results(await run({ account: { supportEmail: "hola@shop.example" } }, stripe), "account");
  assert.equal(wrong?.status, "fail");
  assert.match(wrong!.message, /support email is "old@shop.example", expected "hola@shop.example"/);
  const [early] = results(await run({ account: { country: "ES" } }, stripe), "account");
  assert.equal(early?.status, "warn");
  const [live] = results(await run({}, stripe, "sk_live_x"), "account");
  assert.equal(live?.status, "fail");
});

test("webhook: a missing endpoint fails on check and is created on apply", async () => {
  const created = { id: "we_new", secret: "whsec_new" };
  const stripe = fakeStripe(
    on("GET", "/v1/webhook_endpoints", 200, list([])),
    on("POST", "/v1/webhook_endpoints", 200, created),
  );
  const config: Config = { webhooks: [{ url: URL_, events: EVENTS, apiVersion: "2026-10-28.endive" }] };
  const [checked] = results(await run(config, stripe), "webhook");
  assert.equal(checked?.status, "fail");
  assert.equal(stripe.calls.filter((c) => c.method === "POST").length, 0);

  const report = await run(config, stripe, "sk_test_x", { apply: true });
  assert.equal(results(report, "webhook")[0]?.status, "pass");
  const post = stripe.calls.find((c) => c.method === "POST")!;
  assert.equal(post.body.get("url"), URL_);
  assert.equal(post.body.get("enabled_events[1]"), EVENTS[1]);
  assert.equal(post.body.get("api_version"), "2026-10-28.endive");
  assert.equal(post.body.get("metadata[stripe_preflight]"), "1");
  assert.deepEqual(report.secrets, [{ label: `Signing secret for ${URL_}`, value: "whsec_new" }]);
});

test("webhook: missing and extra events, fixed by apply", async () => {
  const endpoint = {
    id: "we_1",
    url: URL_,
    status: "enabled",
    enabled_events: ["checkout.session.completed", "charge.refunded"],
    api_version: null,
  };
  const stripe = fakeStripe(
    on("GET", "/v1/webhook_endpoints", 200, list([endpoint])),
    on("POST", "/v1/webhook_endpoints/we_1", 200, endpoint),
  );
  const config: Config = { webhooks: [{ url: URL_, events: EVENTS }] };
  const [checked] = results(await run(config, stripe), "webhook");
  assert.equal(checked?.status, "fail");
  assert.match(checked!.message, /missing checkout.session.async_payment_succeeded/);
  assert.deepEqual(checked!.details, ["also sends charge.refunded"]);

  const [applied] = results(await run(config, stripe, "sk_test_x", { apply: true }), "webhook");
  assert.equal(applied?.status, "pass");
  const update = stripe.calls.find((c) => c.method === "POST")!;
  assert.deepEqual([update.body.get("enabled_events[0]"), update.body.get("enabled_events[1]")], EVENTS);
  assert.equal(update.body.get("disabled"), "false");
});

test("webhook: a wrong API version fails and apply does not delete anything", async () => {
  const endpoint = { id: "we_1", url: URL_, status: "enabled", enabled_events: EVENTS, api_version: "2024-06-20" };
  const stripe = fakeStripe(on("GET", "/v1/webhook_endpoints", 200, list([endpoint])));
  const config: Config = { webhooks: [{ url: URL_, events: EVENTS, apiVersion: "2026-10-28.endive" }] };
  const [r] = results(await run(config, stripe, "sk_test_x", { apply: true }), "webhook");
  assert.equal(r?.status, "fail");
  assert.match(r!.fix!, /only when an endpoint is created/);
  assert.equal(stripe.calls.filter((c) => c.method === "POST").length, 0);
});

test("webhook: picks the URL for the key's mode and warns about duplicates", async () => {
  const a = { id: "we_a", url: "https://test.example/hook", status: "enabled", enabled_events: EVENTS };
  const b = { ...a, id: "we_b" };
  const stripe = fakeStripe(on("GET", "/v1/webhook_endpoints", 200, list([a, b])));
  const config: Config = {
    webhooks: [{ url: { test: "https://test.example/hook", live: "https://live.example/hook" }, events: EVENTS }],
  };
  const [r] = results(await run(config, stripe), "webhook");
  assert.equal(r?.status, "warn");
  assert.match(r!.details![0]!, /2 enabled endpoints at this URL: we_a, we_b/);
});

test("payment methods: off ones fail, apply turns them on, unactivated ones still fail", async () => {
  const off = { available: false, display_preference: { value: "off", preference: "off" } };
  const on_ = { available: true, display_preference: { value: "on", preference: "on" } };
  const pmc = { id: "pmc_1", is_default: true, card: on_, bizum: off };
  const stripe = fakeStripe(
    on("GET", "/v1/payment_method_configurations", 200, list([pmc])),
    on("POST", "/v1/payment_method_configurations/pmc_1", 200, {
      ...pmc,
      bizum: { available: false, display_preference: { value: "on", preference: "on" } },
    }),
  );
  const config: Config = { paymentMethods: ["card", "bizum", "twint"] };
  const [checked] = results(await run(config, stripe), "payment methods");
  assert.equal(checked?.status, "fail");
  assert.match(checked!.message, /off: bizum; not offered to this account: twint/);

  const [applied] = results(await run(config, stripe, "sk_test_x", { apply: true }), "payment methods");
  assert.match(applied!.message, /turned on bizum; not offered to this account: twint; on, but not activated by Stripe yet: bizum/);
  const post = stripe.calls.find((c) => c.method === "POST")!;
  assert.equal(post.body.get("bizum[display_preference][preference]"), "on");
});

test("permissions: probes each resource and names what Stripe asks for", async () => {
  const stripe = fakeStripe(
    on("GET", "/v1/account", 403, denied("rak_accounts_read")),
    on("GET", "/v1/products", 200, list([])),
    on("POST", "/v1/checkout/sessions", 400, { error: { message: "Received unknown parameter: preflight_probe" } }),
    on("POST", "/v1/refunds", 403, denied("rak_refund_write")),
  );
  const config: Config = { permissions: { products: "read", checkout_sessions: "write", refunds: "write" } };
  const report = await run(config, stripe, "rk_test_x");
  const [r] = results(report, "permissions");
  assert.equal(r?.status, "fail");
  assert.equal(r?.message, "missing 1 of 3");
  assert.deepEqual(r?.details, ["refunds write (Stripe asks for rak_refund_write)"]);
  const probe = stripe.calls.find((c) => c.path === "/v1/refunds")!;
  assert.equal(probe.body.get("preflight_probe"), "1");
  assert.equal(stripe.calls.find((c) => c.path === "/v1/products")?.query.get("limit"), "1");
});

test("permissions: skipped for a secret key, which has them all", async () => {
  const stripe = fakeStripe(on("GET", "/v1/account", 200, { id: "acct_1", business_profile: {} }));
  const [r] = results(await run({ permissions: { refunds: "write" } }, stripe), "permissions");
  assert.equal(r?.status, "skip");
});

test("deliveries: lists failed events of the window, leaving out the last hour", async () => {
  const now = 1_800_000_000_000;
  const events = [
    { id: "evt_1", type: "checkout.session.completed" },
    { id: "evt_2", type: "checkout.session.completed" },
  ];
  const stripe = fakeStripe(on("GET", "/v1/events", 200, list(events)));
  const report = await preflight({ deliveries: { days: 2 } }, { key: "sk_test_x", fetch: stripe.fetch, now: () => now });
  const [r] = results(report, "deliveries");
  assert.equal(r?.status, "fail");
  assert.deepEqual(r?.details, ["checkout.session.completed: 2", "latest: evt_1, evt_2"]);
  const query = stripe.calls.find((c) => c.path === "/v1/events")!.query;
  assert.equal(query.get("delivery_success"), "false");
  assert.equal(query.get("created[gte]"), String(now / 1000 - 2 * 86400));
  assert.equal(query.get("created[lte]"), String(now / 1000 - 3600));
});

test("dashboard: lists the manual steps with links for the key's mode", async () => {
  const stripe = fakeStripe();
  const report = await run({ dashboard: ["refunds", "restrictedKey", { label: "Ask Mari", url: "https://x.example" }] }, stripe);
  assert.deepEqual(
    results(report, "dashboard").map((r) => [r.status, r.details?.[0]]),
    [
      ["todo", "https://dashboard.stripe.com/settings/emails"],
      ["todo", "https://dashboard.stripe.com/test/apikeys"],
      ["todo", "https://x.example"],
    ],
  );
});

test("pages through long lists", async () => {
  let page = 0;
  const stripe = fakeStripe((req) => {
    if (req.path !== "/v1/webhook_endpoints") return undefined;
    page++;
    return page === 1
      ? [200, { data: [{ id: "we_1", url: "https://other.example" }], has_more: true }]
      : [200, { data: [{ id: "we_2", url: URL_, status: "enabled", enabled_events: EVENTS }], has_more: false }];
  });
  const [r] = results(await run({ webhooks: [{ url: URL_, events: EVENTS }] }, stripe), "webhook");
  assert.equal(r?.status, "pass");
  assert.equal(stripe.calls.filter((c) => c.path === "/v1/webhook_endpoints")[1]?.query.get("starting_after"), "we_1");
});
