import { readFileSync } from "node:fs";
import { catalog } from "./catalog.ts";
import {
  account,
  dashboard,
  deliveries,
  paymentMethods,
  permissions,
  webhooks,
  type Check,
  type Context,
  type Ids,
  type Result,
  type Secret,
} from "./checks.ts";
import { validate, type Config } from "./config.ts";
import { inspectKey, type KeyInfo, type Mode } from "./key.ts";
import { NetworkError, StripeApiError, createClient, missingPermission } from "./stripe.ts";

export {
  defineConfig,
  type Access,
  type Config,
  type DashboardItem,
  type PriceSpec,
  type ProductSpec,
  type WebhookSpec,
} from "./config.ts";
export type { Ids, Result, Secret, Status } from "./checks.ts";
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
  /** With apply: archive a price whose amount changed and create the new one. */
  replacePrices?: boolean;
  /** Run only these checks, by config field name, such as ["catalog"]. */
  only?: string[];
  /** Count warnings as failures. */
  strict?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
};

export type Report = {
  version: string;
  key: KeyInfo;
  applied: boolean;
  results: Result[];
  secrets: Secret[];
  ids: Ids;
  /** False when any result failed, or with strict, warned. */
  ok: boolean;
};

/** Each check: the config field that drives it, the area its results show, and the check. */
const CHECKS: [string, string, Check][] = [
  ["account", "account", account],
  ["webhooks", "webhook", webhooks],
  ["paymentMethods", "payment methods", paymentMethods],
  ["catalog", "catalog", catalog],
  ["permissions", "permissions", permissions],
  ["deliveries", "deliveries", deliveries],
  ["dashboard", "dashboard", dashboard],
];

export async function preflight(config: Config, options: Options): Promise<Report> {
  const checked = validate(config);
  const unknown = (options.only ?? []).filter((name) => !CHECKS.some(([field]) => field === name));
  if (unknown.length) {
    throw new Error(`Unknown check "${unknown.join(", ")}". Known: ${CHECKS.map(([field]) => field).join(", ")}`);
  }
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
    replacePrices: Boolean(options.replacePrices),
    now: options.now ?? Date.now,
    secrets: [],
    ids: { products: {}, prices: {}, webhooks: {} },
  };
  const results: Result[] = [];
  for (const [field, area, check] of CHECKS) {
    if (options.only && !options.only.includes(field)) continue;
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
    ids: ctx.ids,
    ok: !results.some((r) => r.status === "fail" || (options.strict && r.status === "warn")),
  };
}
