import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  const { STRIPE_SECRET_KEY: _, ...rest } = process.env;
  return spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...rest, ...env }, encoding: "utf8" });
}

test("prints help", () => {
  const res = run(["--help"], tmpdir());
  assert.equal(res.status, 0);
  assert.match(res.stdout, /stripe-preflight apply/);
});

test("exits 2 with a plain message when it cannot start", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-"));
  assert.match(run([], dir).stderr, /No config found/);

  writeFileSync(join(dir, "stripe-preflight.config.ts"), "export default { deliveries: false };\n");
  const noKey = run([], dir);
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /Set STRIPE_SECRET_KEY, or pass --env-file/);

  writeFileSync(join(dir, ".dev.vars"), "STRIPE_SECRET_KEY=sk_live_abc\n");
  const live = run(["apply", "--env-file", ".dev.vars"], dir, { STRIPE_SECRET_KEY: "sk_test_shell" });
  assert.equal(live.status, 2);
  assert.match(live.stderr, /without --confirm-live/);

  assert.match(run(["deploy"], dir).stderr, /Unknown command "deploy"/);
});
