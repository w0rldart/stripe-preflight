import { DASHBOARD, RESOURCES, type Config, type WebhookSpec } from "./config.ts";
import type { KeyInfo } from "./key.ts";
import { StripeApiError, missingPermission, type Client } from "./stripe.ts";

export type Status = "pass" | "fail" | "warn" | "skip" | "todo";

export type Result = {
  area: string;
  status: Status;
  message: string;
  details?: string[];
  fix?: string;
};

export type Secret = { label: string; value: string };

/** IDs of what the run found or created: products by key, prices by name, webhooks by URL. */
export type Ids = {
  products: Record<string, string>;
  prices: Record<string, string>;
  webhooks: Record<string, string>;
};

export type Context = {
  client: Client;
  key: KeyInfo;
  apply: boolean;
  /** The key is from a Stripe sandbox, which keeps its own public details. */
  sandbox: boolean;
  /** With apply: archive a price whose amount changed and create the new one. */
  replacePrices: boolean;
  now: () => number;
  /** Values Stripe shows once, such as a new webhook signing secret. */
  secrets: Secret[];
  ids: Ids;
};

export type Check = (config: Config, ctx: Context) => Promise<Result[]>;

/** Marks what this tool creates, so it can be found later. */
const TAG = { stripe_preflight: "1" };

function link(path: string, ctx: Context, perMode = false): string {
  return `https://dashboard.stripe.com/${perMode && ctx.key.mode === "test" ? "test/" : ""}${path}`;
}

const strings = (items: unknown[]): string[] => items.filter((x): x is string => typeof x === "string");

export const account: Check = async (config, ctx) => {
  const a = await ctx.client.get("/v1/account");
  const have = {
    country: a.country,
    businessName: a.business_profile?.name,
    supportEmail: a.business_profile?.support_email,
    url: a.business_profile?.url,
  };
  const names = { country: "country", businessName: "business name", supportEmail: "support email", url: "website" };
  // A sandbox keeps its own public details, and Stripe names it after the account with "sandbox" added.
  // Only its country says something about the live account, and it is never activated.
  const expected = ctx.sandbox ? { country: config.account?.country } : (config.account ?? {});
  const wrong = Object.entries(expected).flatMap(([field, want]) => {
    const got = have[field as keyof typeof have];
    if (!want || want === got) return [];
    return [`${names[field as keyof typeof names]} is ${got ? `"${got}"` : "not set"}, expected "${want}"`];
  });
  const notReady = strings([
    !ctx.sandbox && !a.details_submitted && "details not submitted",
    !ctx.sandbox && !a.charges_enabled && "charges not enabled",
    !ctx.sandbox && !a.payouts_enabled && "payouts not enabled",
  ]);
  const name = have.businessName ?? a.id;
  const live = ctx.key.mode === "live";
  if (wrong.length || (live && notReady.length)) {
    return [
      {
        area: "account",
        status: "fail",
        message: [...wrong, ...(live ? notReady : [])].join("; "),
        fix: `Settings: ${link("settings/public", ctx)}${/sandbox$/i.test(have.businessName ?? "") ? "\nIf this key is from a sandbox, add --sandbox." : ""}`,
      },
    ];
  }
  if (ctx.sandbox) {
    return [{ area: "account", status: "pass", message: `${name}, ${have.country}, a sandbox: public details are checked with the live key` }];
  }
  if (notReady.length) {
    return [{ area: "account", status: "warn", message: `${name}, not ready for live payments: ${notReady.join(", ")}` }];
  }
  return [{ area: "account", status: "pass", message: `${name}, ${have.country}, ready for live payments` }];
};

export const webhooks: Check = async (config, ctx) => {
  if (!config.webhooks?.length) return [];
  const endpoints = await ctx.client.list("/v1/webhook_endpoints");
  const results: Result[] = [];
  for (const spec of config.webhooks) {
    const url = typeof spec.url === "string" ? spec.url : spec.url[ctx.key.mode];
    results.push(await webhook(spec, url, endpoints.filter((e) => e.url === url), ctx));
  }
  return results;
};

async function webhook(spec: WebhookSpec, url: string, found: any[], ctx: Context): Promise<Result> {
  const area = "webhook";
  const enabled = found.filter((e) => e.status === "enabled");
  const endpoint = enabled[0] ?? found[0];

  if (!endpoint) {
    if (!ctx.apply) return { area, status: "fail", message: `${url}: no endpoint`, fix: "Run apply to create it." };
    const created = await ctx.client.post("/v1/webhook_endpoints", {
      url,
      enabled_events: spec.events,
      api_version: spec.apiVersion,
      description: spec.description,
      metadata: { ...TAG, ...spec.metadata },
    });
    ctx.ids.webhooks[url] = created.id;
    ctx.secrets.push({ label: `Signing secret for ${url}`, value: created.secret });
    return { area, status: "pass", message: `${url}: created ${created.id}` };
  }
  ctx.ids.webhooks[url] = endpoint.id;

  const events: string[] = endpoint.enabled_events ?? [];
  const missing = events.includes("*") ? [] : spec.events.filter((e) => !events.includes(e));
  const extra = events.filter((e) => !spec.events.includes(e));
  const disabled = endpoint.status !== "enabled";
  const labels =
    (spec.description !== undefined && endpoint.description !== spec.description) ||
    Object.entries(spec.metadata ?? {}).some(([k, v]) => endpoint.metadata?.[k] !== v);
  const head = `${url}: ${endpoint.id}`;

  let updated = false;
  if (ctx.apply && (missing.length || extra.length || disabled || labels)) {
    await ctx.client.post(`/v1/webhook_endpoints/${endpoint.id}`, {
      enabled_events: spec.events,
      disabled: false,
      description: spec.description,
      metadata: spec.metadata,
    });
    updated = true;
  }
  const problems = strings([
    !updated && disabled && "disabled",
    !updated && missing.length > 0 && `missing ${missing.join(", ")}`,
    spec.apiVersion &&
      endpoint.api_version !== spec.apiVersion &&
      `sends events as API version ${endpoint.api_version ?? "account default"}, expected ${spec.apiVersion}`,
  ]);
  const notes = strings([
    !updated && extra.length > 0 && `also sends ${extra.join(", ")}`,
    !updated && labels && "description or metadata differ",
    enabled.length > 1 && `${enabled.length} enabled endpoints at this URL: ${enabled.map((e) => e.id).join(", ")}`,
  ]);
  const done = updated ? ", updated" : "";

  if (problems.length) {
    const versionWrong = problems.some((p) => p.startsWith("sends events"));
    const fix = strings([
      !updated && disabled && missing.length === 0 && "Run apply to enable it.",
      !updated && missing.length > 0 && `Run apply to ${disabled ? "enable it and " : ""}add the missing events.`,
      versionWrong &&
        "Stripe sets the API version only when an endpoint is created: delete this one in the Dashboard, run apply to create it again, then store the new signing secret.",
    ]).join(" ");
    return { area, status: "fail", message: `${head}${done}, ${problems.join("; ")}`, details: notes, fix };
  }
  if (notes.length) {
    const fix = strings([
      (extra.length > 0 || labels) && !updated && "Run apply to match the config.",
      enabled.length > 1 && "Delete the endpoints the app does not use; each one gets every event.",
    ]).join(" ");
    return { area, status: "warn", message: `${head}${done}`, details: notes, fix };
  }
  return { area, status: "pass", message: `${head}${done}, ${spec.events.length} events` };
}

export const paymentMethods: Check = async (config, ctx) => {
  const wanted = config.paymentMethods ?? [];
  if (!wanted.length) return [];
  const area = "payment methods";
  const configs = await ctx.client.list("/v1/payment_method_configurations");
  let pmc = configs.find((c) => c.is_default);
  const settings = link("settings/payment_methods", ctx, true);
  if (!pmc) return [{ area, status: "fail", message: "Stripe returned no default configuration", fix: settings }];

  const state = (c: any) => ({
    unknown: wanted.filter((m) => !c[m]?.display_preference),
    off: wanted.filter((m) => c[m]?.display_preference && c[m].display_preference.value !== "on"),
    waiting: wanted.filter((m) => c[m]?.display_preference?.value === "on" && c[m].available === false),
  });
  let now = state(pmc);
  let turnedOn: string[] = [];
  if (ctx.apply && now.off.length) {
    const on = Object.fromEntries(now.off.map((m) => [m, { display_preference: { preference: "on" } }]));
    pmc = await ctx.client.post(`/v1/payment_method_configurations/${pmc.id}`, on);
    turnedOn = now.off;
    now = state(pmc);
  }
  const done = turnedOn.length ? `turned on ${turnedOn.join(", ")}; ` : "";
  const problems = strings([
    now.off.length > 0 && `off: ${now.off.join(", ")}`,
    now.unknown.length > 0 && `not offered to this account: ${now.unknown.join(", ")}`,
    now.waiting.length > 0 && `on, but not activated by Stripe yet: ${now.waiting.join(", ")}`,
  ]);
  if (problems.length) {
    const fix = `${now.off.length && !ctx.apply ? "Run apply, or see" : "See"} Settings, Payment methods: ${settings}`;
    return [{ area, status: "fail", message: done + problems.join("; "), fix }];
  }
  return [{ area, status: "pass", message: `${done}${wanted.join(", ")} on` }];
};

export const permissions: Check = async (config, ctx) => {
  const wanted = Object.entries(config.permissions ?? {});
  if (!wanted.length) return [];
  const area = "permissions";
  if (!ctx.key.restricted) {
    return [
      {
        area,
        status: "skip",
        message: "a secret key has every permission",
        fix: "Run check with the app's restricted key to test what it can do.",
      },
    ];
  }
  const missing: string[] = [];
  const odd: string[] = [];
  for (const [resource, access] of wanted) {
    const path = RESOURCES[resource]!;
    // A write probe sends a parameter Stripe rejects. A 400 means the key passed the permission check
    // and nothing was created; a 403 means the permission is missing.
    const res =
      access === "read"
        ? await ctx.client.request("GET", path, { limit: 1 })
        : await ctx.client.request("POST", path, { preflight_probe: 1 });
    if (res.status === 401) throw new StripeApiError(401, res.body?.error);
    if (res.status === 403) {
      const rak = missingPermission(res.body?.error?.message ?? "");
      missing.push(`${resource} ${access}${rak ? ` (Stripe asks for ${rak})` : ""}`);
    } else if (res.status === 429 || res.status >= 500) {
      odd.push(`${resource}: Stripe answered ${res.status}, run check again`);
    } else if (access === "write" && res.status < 300) {
      odd.push(`${resource}: Stripe accepted the probe; look for an object it may have created`);
    }
  }
  const fix = `Edit the key in the Dashboard: ${link("apikeys", ctx, true)}`;
  if (missing.length) {
    return [{ area, status: "fail", message: `missing ${missing.length} of ${wanted.length}`, details: [...missing, ...odd], fix }];
  }
  if (odd.length) return [{ area, status: "warn", message: "some probes were inconclusive", details: odd }];
  return [{ area, status: "pass", message: wanted.map(([r, a]) => `${r} ${a}`).join(", ") }];
};

export const deliveries: Check = async (config, ctx) => {
  if (config.deliveries === false) return [];
  const area = "deliveries";
  const days = config.deliveries?.days ?? 3;
  const now = Math.floor(ctx.now() / 1000);
  // Leave out the last hour: Stripe may still be retrying those events.
  const created = { gte: now - days * 86400, lte: now - 3600 };
  const failed = await ctx.client.list("/v1/events", { delivery_success: false, created }, 500);
  if (!failed.length) return [{ area, status: "pass", message: `no failed deliveries in the last ${days} days` }];
  const byType = new Map<string, number>();
  for (const e of failed) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  return [
    {
      area,
      status: "fail",
      message: `${failed.length === 500 ? "500 or more" : failed.length} events not delivered in the last ${days} days`,
      details: [...[...byType].map(([type, n]) => `${type}: ${n}`), `latest: ${failed.slice(0, 3).map((e) => e.id).join(", ")}`],
      fix: "Fix the endpoint, then resend the events from the Dashboard (Workbench, Events).",
    },
  ];
};

export const dashboard: Check = async (config, ctx) =>
  (config.dashboard ?? []).map((item): Result => {
    if (typeof item !== "string") return { area: "dashboard", status: "todo", message: item.label, details: [item.url] };
    const step = DASHBOARD[item];
    return {
      area: "dashboard",
      status: "todo",
      message: step.label,
      details: [link(step.path, ctx, "perMode" in step && step.perMode)],
    };
  });
