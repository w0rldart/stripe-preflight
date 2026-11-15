import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main, type Io } from "../src/cli.ts";

const URL_ = "https://shop.example.com/api/stripe";
const EVENTS = ["checkout.session.completed"];

/** Answers like api.stripe.com for one shop: no webhook yet, account ready. */
const stripe = (async (input: string | URL | Request, init?: RequestInit) => {
  const key = `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`;
  const answers: Record<string, unknown> = {
    "GET /v1/account": {
      id: "acct_1",
      country: "ES",
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      business_profile: { name: "Example Shop" },
    },
    "GET /v1/webhook_endpoints": { data: [], has_more: false },
    "POST /v1/webhook_endpoints": { id: "we_new", secret: "whsec_new" },
  };
  const body = answers[key];
  return new Response(JSON.stringify(body ?? { error: { message: `no route for ${key}` } }), { status: body ? 200 : 404 });
}) as typeof fetch;

/** A folder with a config, and a CLI run inside it that records what it prints. */
function shop(config: object = { webhooks: [{ url: URL_, events: EVENTS }], deliveries: false }) {
  const cwd = mkdtempSync(join(tmpdir(), "spf-"));
  writeFileSync(join(cwd, "stripe-preflight.config.json"), JSON.stringify(config));
  const run = async (args: string[], io: Io = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, {
      cwd,
      env: {},
      fetch: stripe,
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      ...io,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { cwd, run };
}

test("prints help and version", async () => {
  const { run } = shop();
  assert.match((await run(["--help"])).out, /stripe-preflight apply/);
  assert.equal((await run(["-v"])).out, "0.1.0");
});

test("exits 2 with a plain message when it cannot start", async () => {
  const empty = mkdtempSync(join(tmpdir(), "spf-"));
  const { run, cwd } = shop();
  assert.match((await run([], { cwd: empty })).err, /No config found/);
  assert.match((await run(["--config", "missing.ts"])).err, /Config not found/);
  assert.match((await run(["deploy"])).err, /Unknown command "deploy"/);
  assert.match((await run(["--expect", "prod"])).err, /--expect takes test or live/);
  assert.match((await run(["--sandbox"], { env: { STRIPE_SECRET_KEY: "sk_live_x" } })).err, /A sandbox has test keys only/);

  const noKey = await run([]);
  assert.equal(noKey.code, 2);
  assert.match(noKey.err, /Set STRIPE_SECRET_KEY, or pass --env-file/);

  // The file wins over the shell, so this run is live and apply is refused.
  writeFileSync(join(cwd, ".dev.vars"), "STRIPE_SECRET_KEY=sk_live_abc\n");
  const live = await run(["apply", "--env-file", ".dev.vars"], { env: { STRIPE_SECRET_KEY: "sk_test_shell" } });
  assert.equal(live.code, 2);
  assert.match(live.err, /without --confirm-live/);
});

test("check reports a failure and exits 1", async () => {
  const { run } = shop();
  const res = await run([], { env: { STRIPE_SECRET_KEY: "sk_test_x" } });
  assert.equal(res.code, 1);
  assert.match(res.out, /^FAIL {2}webhook +https:\/\/shop\.example\.com\/api\/stripe: no endpoint$/m);
  assert.match(res.out, /^1 failed\.$/m);
});

test("apply creates the webhook and prints its secret once", async () => {
  const { run } = shop();
  const res = await run(["apply"], { env: { STRIPE_SECRET_KEY: "sk_test_x" } });
  assert.equal(res.code, 0);
  assert.match(res.out, /PASS {2}webhook +https:\/\/shop\.example\.com\/api\/stripe: created we_new/);
  assert.match(res.out, /Shown once\. Store it now:\n {2}Signing secret for https:\/\/shop\.example\.com\/api\/stripe: whsec_new/);
  assert.match(res.out, /All checks passed\.$/);
});

test("--json prints the whole report", async () => {
  const { run } = shop();
  const res = await run(["apply", "--json"], { env: { STRIPE_SECRET_KEY: "sk_test_x" } });
  const report = JSON.parse(res.out);
  assert.equal(report.ok, true);
  assert.deepEqual(report.key, { type: "sk_test", mode: "test", restricted: false });
  assert.deepEqual(
    report.results.map((r: { area: string; status: string }) => `${r.area} ${r.status}`),
    ["account pass", "webhook pass"],
  );
  assert.equal(report.secrets[0].value, "whsec_new");
});

test("the installed command runs", () => {
  const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
  const res = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "0.1.0");
});
