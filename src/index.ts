import { readFileSync } from "node:fs";
import {
  account,
  dashboard,
  deliveries,
  paymentMethods,
  permissions,
  webhooks,
  type Check,
  type Context,
  type Result,
  type Secret,
} from "./checks.ts";
import { validate, type Config } from "./config.ts";
import { inspectKey, type KeyInfo, type Mode } from "./key.ts";
import { NetworkError, StripeApiError, createClient, missingPermission } from "./stripe.ts";

export { defineConfig, type Access, type Config, type DashboardItem, type WebhookSpec } from "./config.ts";
export type { Result, Secret, Status } from "./checks.ts";
export type { KeyInfo, Mode } from "./key.ts";
export { formatText } from "./format.ts";

export const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export type Options = {
  /** A secret (sk_) or restricted (rk_) key. Only its type is ever reported. */
  key: string;
  /** Create or update what the API allows. Without it nothing in Stripe changes. */
  apply?: boolean;
  /** Required with apply when the key is live. */
  confirmLive?: boolean;
  /** Stop unless the key is of this mode. */
  expect?: Mode;
  fetch?: typeof fetch;
  now?: () => number;
};

export type Report = {
  version: string;
  key: KeyInfo;
  applied: boolean;
  results: Result[];
  secrets: Secret[];
  /** False when any result failed. */
  ok: boolean;
};

const CHECKS: [string, Check][] = [
  ["account", account],
  ["webhook", webhooks],
  ["payment methods", paymentMethods],
  ["permissions", permissions],
  ["deliveries", deliveries],
  ["dashboard", dashboard],
];

export async function preflight(config: Config, options: Options): Promise<Report> {
  const checked = validate(config);
  const key = inspectKey(options.key);
  if (options.expect && options.expect !== key.mode) {
    throw new Error(`Expected a ${options.expect} key, but this is a ${key.type} key.`);
  }
  if (options.apply && key.mode === "live" && !options.confirmLive) {
    throw new Error("Refusing to change a live account without --confirm-live.");
  }
  const ctx: Context = {
    client: createClient(options.key.trim(), { fetch: options.fetch }),
    key,
    apply: Boolean(options.apply),
    now: options.now ?? Date.now,
    secrets: [],
  };
  const results: Result[] = [];
  for (const [area, check] of CHECKS) {
    try {
      results.push(...(await check(checked, ctx)));
    } catch (err) {
      if (err instanceof NetworkError) throw err;
      if (err instanceof StripeApiError && err.status === 401) {
        throw new Error("Stripe rejected the key. Check that it is complete and has not been rolled.");
      }
      if (err instanceof StripeApiError && err.status === 403) {
        const rak = missingPermission(err.message);
        results.push({ area, status: "skip", message: `this key cannot check it${rak ? ` (needs ${rak})` : ""}` });
      } else {
        results.push({ area, status: "fail", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return {
    version,
    key,
    applied: ctx.apply,
    results,
    secrets: ctx.secrets,
    ok: !results.some((r) => r.status === "fail"),
  };
}
