import assert from "node:assert/strict";
import { test } from "node:test";
import { formatText, preflight, type Config, type ProductSpec, type Report } from "../src/index.ts";
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

test("account: a sandbox keeps its own public details, so only its country is compared", async () => {
  const acct = {
    id: "acct_sb",
    country: "ES",
    details_submitted: false,
    charges_enabled: false,
    payouts_enabled: false,
    business_profile: { name: "Shop sandbox" },
  };
  const stripe = fakeStripe(on("GET", "/v1/account", 200, acct));
  const config = { account: { country: "ES", businessName: "Shop", supportEmail: "hola@shop.example" } };
  const [plain] = results(await run(config, stripe), "account");
  assert.equal(plain?.status, "fail");
  assert.match(plain!.fix!, /If this key is from a sandbox, add --sandbox/);

  const report = await run(config, stripe, "sk_test_x", { sandbox: true });
  const [sandbox] = results(report, "account");
  assert.equal(sandbox?.status, "pass");
  assert.equal(sandbox?.message, "Shop sandbox, ES, a sandbox: public details are checked with the live key");
  assert.match(formatText(report).split("\n")[0]!, /: sandbox, secret key$/);

  const [elsewhere] = results(await run({ account: { country: "CH" } }, stripe, "sk_test_x", { sandbox: true }), "account");
  assert.equal(elsewhere?.status, "fail");
  await assert.rejects(run(config, stripe, "sk_live_x", { sandbox: true }), /A sandbox has test keys only, but this is a sk_live key/);
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
  assert.equal(checked!.fix, "Run apply to add the missing events.");

  const [applied] = results(await run(config, stripe, "sk_test_x", { apply: true }), "webhook");
  assert.equal(applied?.status, "pass");
  const update = stripe.calls.find((c) => c.method === "POST")!;
  assert.deepEqual([update.body.get("enabled_events[0]"), update.body.get("enabled_events[1]")], EVENTS);
  assert.equal(update.body.get("disabled"), "false");
});

test("webhook: a disabled endpoint fails and apply enables it, keeping its signing secret", async () => {
  const endpoint = { id: "we_1", url: URL_, status: "disabled", enabled_events: EVENTS, api_version: null };
  const stripe = fakeStripe(
    on("GET", "/v1/webhook_endpoints", 200, list([endpoint])),
    on("POST", "/v1/webhook_endpoints/we_1", 200, { ...endpoint, status: "enabled" }),
  );
  const config: Config = { webhooks: [{ url: URL_, events: EVENTS }] };
  const [checked] = results(await run(config, stripe), "webhook");
  assert.equal(checked?.status, "fail");
  assert.match(checked!.message, /we_1, disabled$/);
  assert.equal(checked!.fix, "Run apply to enable it.");

  const report = await run(config, stripe, "sk_test_x", { apply: true });
  const [applied] = results(report, "webhook");
  assert.equal(applied?.status, "pass");
  assert.match(applied!.message, /we_1, updated/);
  assert.deepEqual(report.secrets, []);
  assert.equal(stripe.calls.filter((c) => c.path === "/v1/webhook_endpoints" && c.method === "POST").length, 0);
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

test("formats the report for a terminal", () => {
  const report: Report = {
    version: "0.1.0",
    key: { type: "rk_live", mode: "live", restricted: true },
    sandbox: false,
    applied: false,
    secrets: [],
    ids: { products: {}, prices: { STRIPE_PRICE_SOLO: "price_1" }, webhooks: {} },
    ok: false,
    results: [
      { area: "deliveries", status: "pass", message: "no failed deliveries in the last 3 days" },
      { area: "permissions", status: "fail", message: "missing 1 of 2", details: ["refunds write"], fix: "Edit the key." },
      { area: "dashboard", status: "todo", message: "Customer emails: turn on Refunds", details: ["https://x.example"] },
    ],
  };
  assert.equal(
    formatText(report),
    [
      "stripe-preflight 0.1.0: live mode, restricted key",
      "",
      "PASS  deliveries   no failed deliveries in the last 3 days",
      "FAIL  permissions  missing 1 of 2",
      "                   refunds write",
      "                   Edit the key.",
      "TODO  dashboard    Customer emails: turn on Refunds",
      "                   https://x.example",
      "",
      "Price IDs:",
      "  STRIPE_PRICE_SOLO=price_1",
      "",
      "1 failed, 1 to confirm in the Dashboard.",
    ].join("\n"),
  );
});

// Catalog

const SOLO: ProductSpec = {
  key: "solo",
  name: "Shop Solo",
  description: "For one person",
  metadata: { catalog_version: "6" },
  prices: [
    { name: "PRICE_SOLO_EUR", currency: "eur", unitAmount: 3300, interval: "month", metadata: { price_key: "monthly" } },
    { name: "PRICE_SOLO_EUR_ANNUAL", currency: "eur", unitAmount: 31700, interval: "year" },
  ],
};
const catalogConfig = (products = [SOLO]): Config => ({ catalog: { keyField: "tier", products }, deliveries: false });
const product = { id: "prod_1", name: "Shop Solo", description: "For one person", metadata: { tier: "solo", catalog_version: "6" } };
const price = (id: string, unit_amount: number, interval: string | null, currency = "eur") => ({
  id,
  currency,
  unit_amount,
  recurring: interval ? { interval } : null,
});
const prices = (...data: unknown[]) => (req: Request) =>
  req.method === "GET" && req.path === "/v1/prices" && req.query.get("product") === "prod_1" ? ([200, list(data)] as [number, unknown]) : undefined;

test("catalog: a missing product fails on check and is created with its prices on apply", async () => {
  let n = 0;
  const stripe = fakeStripe(
    on("GET", "/v1/products", 200, list([{ id: "prod_other", metadata: { tier: "team" } }])),
    on("POST", "/v1/products", 200, { ...product, id: "prod_new" }),
    (req) => (req.method === "POST" && req.path === "/v1/prices" ? [200, { id: `price_${++n}` }] : undefined),
  );
  const [checked] = results(await run(catalogConfig(), stripe), "catalog");
  assert.equal(checked?.status, "fail");
  assert.deepEqual(checked?.details, ["missing PRICE_SOLO_EUR: EUR 33.00 per month", "missing PRICE_SOLO_EUR_ANNUAL: EUR 317.00 per year"]);
  assert.equal(stripe.calls.filter((c) => c.method === "POST").length, 0);

  const report = await run(catalogConfig(), stripe, "sk_test_x", { apply: true });
  const [applied] = results(report, "catalog");
  assert.equal(applied?.status, "pass");
  assert.equal(applied?.message, "solo (prod_new): created with 2 prices");
  const created = stripe.calls.filter((c) => c.method === "POST");
  assert.equal(created[0]?.body.get("metadata[tier]"), "solo");
  assert.equal(created[0]?.body.get("metadata[catalog_version]"), "6");
  assert.equal(created[1]?.body.get("product"), "prod_new");
  assert.equal(created[1]?.body.get("recurring[interval]"), "month");
  assert.equal(created[1]?.body.get("metadata[price_key]"), "monthly");
  assert.deepEqual(report.ids.prices, { PRICE_SOLO_EUR: "price_1", PRICE_SOLO_EUR_ANNUAL: "price_2" });
  assert.deepEqual(report.ids.products, { solo: "prod_new" });
});

test("catalog: matching prices pass and their IDs are reported", async () => {
  const stripe = fakeStripe(
    on("GET", "/v1/products", 200, list([product])),
    prices(price("price_m", 3300, "month"), price("price_y", 31700, "year"), price("price_chf", 3000, "month", "chf")),
  );
  const report = await run(catalogConfig(), stripe);
  assert.equal(results(report, "catalog")[0]?.message, "solo (prod_1), 2 prices");
  assert.deepEqual(report.ids.prices, { PRICE_SOLO_EUR: "price_m", PRICE_SOLO_EUR_ANNUAL: "price_y" });
  assert.equal(stripe.calls.find((c) => c.path === "/v1/products")?.query.get("active"), "true");
});

test("catalog: a changed amount is replaced only with replacePrices", async () => {
  const stripe = fakeStripe(
    on("GET", "/v1/products", 200, list([product])),
    prices(price("price_old", 3000, "month"), price("price_y", 31700, "year")),
    on("POST", "/v1/prices/price_old", 200, {}),
    on("POST", "/v1/prices", 200, { id: "price_new" }),
  );
  const [checked] = results(await run(catalogConfig(), stripe), "catalog");
  assert.equal(checked?.status, "fail");
  assert.deepEqual(checked?.details, ["PRICE_SOLO_EUR: Stripe has EUR 30.00 per month (price_old), expected EUR 33.00 per month"]);
  assert.match(checked!.fix!, /--replace-prices/);

  const [held] = results(await run(catalogConfig(), stripe, "sk_test_x", { apply: true }), "catalog");
  assert.equal(held?.status, "fail");
  assert.equal(stripe.calls.filter((c) => c.method === "POST").length, 0);

  const report = await run(catalogConfig(), stripe, "sk_test_x", { apply: true, replacePrices: true });
  assert.equal(results(report, "catalog")[0]?.message, "solo (prod_1): created 1 price, archived 1");
  const [archive, create] = stripe.calls.filter((c) => c.method === "POST");
  assert.equal(archive?.path, "/v1/prices/price_old");
  assert.equal(archive?.body.get("active"), "false");
  assert.equal(create?.body.get("unit_amount"), "3300");
  assert.equal(report.ids.prices.PRICE_SOLO_EUR, "price_new");
});

test("catalog: a price another spec uses is never archived", async () => {
  const two: ProductSpec = { ...SOLO, prices: [SOLO.prices[0]!, { name: "PRICE_SOLO_EUR_PRO", currency: "eur", unitAmount: 5000, interval: "month" }] };
  const stripe = fakeStripe(
    on("GET", "/v1/products", 200, list([product])),
    prices(price("price_m", 3300, "month")),
    on("POST", "/v1/prices", 200, { id: "price_pro" }),
  );
  await run(catalogConfig([two]), stripe, "sk_test_x", { apply: true, replacePrices: true });
  assert.deepEqual(stripe.calls.filter((c) => c.method === "POST").map((c) => c.path), ["/v1/prices"]);
});

test("catalog: product drift is fixed on apply; one-time prices have no interval", async () => {
  const oneOff: ProductSpec = { ...SOLO, prices: [{ name: "SETUP", currency: "jpy", unitAmount: 500 }] };
  const stripe = fakeStripe(
    on("GET", "/v1/products", 200, list([{ ...product, description: "Old" }, { ...product, id: "prod_2" }])),
    prices(price("price_setup", 500, null, "jpy")),
    on("POST", "/v1/products/prod_1", 200, product),
  );
  const [checked] = results(await run(catalogConfig([oneOff]), stripe), "catalog");
  assert.equal(checked?.status, "fail");
  assert.deepEqual(checked?.details, [
    "name, description or metadata differ",
    "2 active products have tier=solo: prod_1, prod_2; using prod_1",
  ]);
  const [applied] = results(await run(catalogConfig([oneOff]), stripe, "sk_test_x", { apply: true }), "catalog");
  assert.equal(applied?.status, "warn");
  assert.equal(stripe.calls.find((c) => c.method === "POST")?.body.get("description"), "For one person");
});

test("catalog: validates the config", async () => {
  const bad = (products: unknown) => run({ catalog: { products } } as Config, fakeStripe());
  await assert.rejects(bad([{ key: "a", name: "A", prices: [{ name: "P", currency: "euro", unitAmount: 1 }] }]), /three-letter code/);
  await assert.rejects(bad([{ key: "a", name: "A", prices: [{ name: "P", currency: "eur", unitAmount: 9.5 }] }]), /whole number/);
  await assert.rejects(
    bad([
      { key: "a", name: "A", prices: [{ name: "P", currency: "eur", unitAmount: 1 }] },
      { key: "b", name: "B", prices: [{ name: "P", currency: "eur", unitAmount: 2 }] },
    ]),
    /unique across the catalog/,
  );
});

// Options

test("only runs the named checks; strict counts warnings as failures", async () => {
  const endpoint = { id: "we_1", url: URL_, status: "enabled", enabled_events: [...EVENTS, "charge.refunded"] };
  const stripe = fakeStripe(on("GET", "/v1/webhook_endpoints", 200, list([endpoint])));
  const config: Config = { webhooks: [{ url: URL_, events: EVENTS }] };
  const report = await preflight(config, { key: "sk_test_x", fetch: stripe.fetch, only: ["webhooks"] });
  assert.deepEqual(report.results.map((r) => `${r.area} ${r.status}`), ["webhook warn"]);
  assert.equal(report.ok, true);
  assert.deepEqual(stripe.calls.map((c) => c.path), ["/v1/webhook_endpoints"]);
  assert.equal(report.ids.webhooks[URL_], "we_1");

  const strict = await preflight(config, { key: "sk_test_x", fetch: stripe.fetch, only: ["webhooks"], strict: true });
  assert.equal(strict.ok, false);
  await assert.rejects(preflight(config, { key: "sk_test_x", only: ["webhook"] }), /Unknown check "webhook"/);
});

test("webhook: description and metadata are part of the config", async () => {
  const endpoint = { id: "we_1", url: URL_, status: "enabled", enabled_events: EVENTS, description: "Old", metadata: {} };
  const stripe = fakeStripe(
    on("GET", "/v1/webhook_endpoints", 200, list([endpoint])),
    on("POST", "/v1/webhook_endpoints/we_1", 200, endpoint),
  );
  const config: Config = { webhooks: [{ url: URL_, events: EVENTS, description: "Shop", metadata: { shop_webhook: "1" } }] };
  const [checked] = results(await run(config, stripe), "webhook");
  assert.equal(checked?.status, "warn");
  assert.deepEqual(checked?.details, ["description or metadata differ"]);
  const [applied] = results(await run(config, stripe, "sk_test_x", { apply: true }), "webhook");
  assert.equal(applied?.status, "pass");
  const post = stripe.calls.find((c) => c.method === "POST")!;
  assert.equal(post.body.get("description"), "Shop");
  assert.equal(post.body.get("metadata[shop_webhook]"), "1");
});
