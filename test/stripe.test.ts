// Runs against a real Stripe test account, only when the keys are set:
//   STRIPE_TEST_KEY          a test-mode secret key (sk_test_)
//   STRIPE_TEST_LIMITED_KEY  a test-mode restricted key with Products: Read and nothing else
// Nothing is created: these runs only check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { preflight } from "../src/index.ts";

const key = process.env.STRIPE_TEST_KEY;
const limited = process.env.STRIPE_TEST_LIMITED_KEY;

test("reads a real test account", { skip: !key && "set STRIPE_TEST_KEY" }, async () => {
  const report = await preflight(
    {
      webhooks: [{ url: "https://stripe-preflight.invalid/hook", events: ["checkout.session.completed"] }],
      paymentMethods: ["card"],
      deliveries: { days: 1 },
    },
    { key: key!, expect: "test" },
  );
  const status = (area: string) => report.results.find((r) => r.area === area)?.status;
  assert.match(status("account") ?? "", /^(pass|warn)$/);
  assert.equal(status("webhook"), "fail");
  assert.equal(status("payment methods"), "pass");
  assert.match(status("deliveries") ?? "", /^(pass|fail)$/);
});

test("a write probe without the permission gets 403, not 400", { skip: !limited && "set STRIPE_TEST_LIMITED_KEY" }, async () => {
  const report = await preflight(
    { permissions: { products: "read", refunds: "write" }, deliveries: false },
    { key: limited!, expect: "test" },
  );
  const r = report.results.find((x) => x.area === "permissions");
  assert.equal(r?.status, "fail");
  assert.deepEqual(
    r?.details?.map((d) => d.split(" (")[0]),
    ["refunds write"],
  );
});
