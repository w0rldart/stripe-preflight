import type { Check, Context, Result } from "./checks.ts";
import type { PriceSpec, ProductSpec } from "./config.ts";

// Currencies Stripe counts in whole units, so 500 JPY is 500, not 5.00.
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

export function formatPrice(p: { currency: string; unitAmount: number; interval?: string }): string {
  const currency = p.currency.toLowerCase();
  const amount = ZERO_DECIMAL.has(currency) ? String(p.unitAmount) : (p.unitAmount / 100).toFixed(2);
  return `${currency.toUpperCase()} ${amount}${p.interval ? ` per ${p.interval}` : ""}`;
}

const describe = (price: any) =>
  `${formatPrice({ currency: price.currency, unitAmount: price.unit_amount, interval: price.recurring?.interval })} (${price.id})`;

/** Same currency and billing interval: the place a price spec fills on its product. */
const sameSlot = (price: any, spec: PriceSpec) =>
  price.currency === spec.currency.toLowerCase() && (price.recurring?.interval ?? undefined) === spec.interval;

const matches = (price: any, spec: PriceSpec) => sameSlot(price, spec) && price.unit_amount === spec.unitAmount;

export const catalog: Check = async (config, ctx) => {
  if (!config.catalog) return [];
  const keyField = config.catalog.keyField ?? "preflight_key";
  const wanted = new Set(config.catalog.products.map((p) => p.key));
  const found = new Map<string, any[]>();
  for (const product of await ctx.client.list("/v1/products", { active: true })) {
    const key = product.metadata?.[keyField];
    if (wanted.has(key)) found.set(key, [...(found.get(key) ?? []), product]);
  }
  const results: Result[] = [];
  for (const spec of config.catalog.products) {
    results.push(await syncProduct(spec, keyField, found.get(spec.key) ?? [], ctx));
  }
  return results;
};

async function syncProduct(spec: ProductSpec, keyField: string, found: any[], ctx: Context): Promise<Result> {
  const area = "catalog";
  const metadata = { ...spec.metadata, [keyField]: spec.key };
  const notes =
    found.length > 1
      ? [`${found.length} active products have ${keyField}=${spec.key}: ${found.map((p) => p.id).join(", ")}; using ${found[0].id}`]
      : [];
  const done: string[] = [];
  const problems: string[] = [];

  let product = found[0];
  if (!product) {
    if (!ctx.apply) {
      return {
        area,
        status: "fail",
        message: `${spec.key}: no product`,
        details: spec.prices.map((p) => `missing ${p.name}: ${formatPrice(p)}`),
        fix: "Run apply to create it.",
      };
    }
    product = await ctx.client.post("/v1/products", { name: spec.name, description: spec.description, metadata });
    done.push("created");
  } else {
    const drifted =
      product.name !== spec.name ||
      (product.description ?? "") !== (spec.description ?? "") ||
      Object.entries(metadata).some(([k, v]) => product.metadata?.[k] !== v);
    if (drifted && ctx.apply) {
      product = await ctx.client.post(`/v1/products/${product.id}`, {
        name: spec.name,
        description: spec.description ?? "",
        metadata,
      });
      done.push("updated name, description and metadata");
    } else if (drifted) {
      problems.push("name, description or metadata differ");
    }
  }
  ctx.ids.products[spec.key] = product.id;

  const prices: any[] = done[0] === "created" ? [] : await ctx.client.list("/v1/prices", { product: product.id, active: true });
  const matched = new Map(spec.prices.map((p) => [p, prices.find((x) => matches(x, p))] as const));
  const taken = new Set([...matched.values()].filter(Boolean).map((x) => x.id));
  const archived = new Set<string>();
  let created = 0;
  let replaceable = false;

  for (const p of spec.prices) {
    const hit = matched.get(p);
    if (hit) {
      ctx.ids.prices[p.name] = hit.id;
      continue;
    }
    // Prices in the same slot that no spec claims: what this price used to cost.
    const stale = prices.filter((x) => sameSlot(x, p) && !taken.has(x.id) && !archived.has(x.id));
    if (!ctx.apply || (stale.length && !ctx.replacePrices)) {
      if (stale.length) replaceable = true;
      problems.push(
        stale.length
          ? `${p.name}: Stripe has ${stale.map(describe).join(", ")}, expected ${formatPrice(p)}`
          : `missing ${p.name}: ${formatPrice(p)}`,
      );
      continue;
    }
    for (const old of stale) {
      await ctx.client.post(`/v1/prices/${old.id}`, { active: false });
      archived.add(old.id);
    }
    const price = await ctx.client.post("/v1/prices", {
      product: product.id,
      currency: p.currency.toLowerCase(),
      unit_amount: p.unitAmount,
      recurring: p.interval ? { interval: p.interval } : undefined,
      metadata: p.metadata,
    });
    ctx.ids.prices[p.name] = price.id;
    created++;
  }
  const priceCount = `${created} price${created === 1 ? "" : "s"}`;
  if (done[0] === "created") done[0] = `created with ${priceCount}`;
  else if (created) done.push(`created ${priceCount}`);
  if (archived.size) done.push(`archived ${archived.size}`);

  const head = `${spec.key} (${product.id})`;
  const did = done.length ? `: ${done.join(", ")}` : "";
  if (problems.length) {
    const fix = replaceable
      ? "A Stripe price cannot change its amount. Run apply with --replace-prices to archive the old price and create the new one; subscriptions already on the old price keep it."
      : "Run apply to fix it.";
    return { area, status: "fail", message: `${head}${did}${did ? "; " : ", "}${problems.length} to fix`, details: [...problems, ...notes], fix };
  }
  if (notes.length) {
    return { area, status: "warn", message: `${head}${did}`, details: notes, fix: "Archive the duplicate products in the Dashboard." };
  }
  return { area, status: "pass", message: `${head}${did || `, ${spec.prices.length} prices`}` };
}
