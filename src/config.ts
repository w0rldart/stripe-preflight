export type Access = "read" | "write";

export type WebhookSpec = {
  /** One URL for both modes, or one per mode. */
  url: string | { test: string; live: string };
  events: string[];
  /** The API version your Stripe library pins. Stripe fixes it when the endpoint is created. */
  apiVersion?: string;
  description?: string;
  metadata?: Record<string, string>;
};

export type PriceSpec = {
  /** Your name for the price, such as the variable that will hold its ID. Unique across the catalog. */
  name: string;
  /** Three-letter ISO code, such as "eur". */
  currency: string;
  /** In the currency's smallest unit: 3900 for 39.00 EUR. */
  unitAmount: number;
  /** Leave out for a one-time price. */
  interval?: "day" | "week" | "month" | "year";
  metadata?: Record<string, string>;
};

export type ProductSpec = {
  /** Finds the product in Stripe, through the metadata field named by catalog.keyField. */
  key: string;
  name: string;
  description?: string;
  metadata?: Record<string, string>;
  prices: PriceSpec[];
};

/** Steps only the Dashboard can do. The CLI lists them with a link; it cannot check them. */
export const DASHBOARD = {
  receipts: { label: "Customer emails: turn on Successful payments", path: "settings/emails" },
  refunds: { label: "Customer emails: turn on Refunds", path: "settings/emails" },
  publicDetails: {
    label: "Public details: business name, support email, terms of service URL",
    path: "settings/public",
  },
  branding: { label: "Branding: icon, logo and colours for Checkout and emails", path: "settings/branding" },
  team: { label: "Team: everyone with access uses two-step authentication", path: "settings/team" },
  restrictedKey: {
    label: "A restricted key for the app, with only the permissions it needs",
    path: "apikeys",
    perMode: true,
  },
} as const;

export type DashboardItem = keyof typeof DASHBOARD;

/** Resources whose restricted-key permission can be checked, by the API path that tests it. */
export const RESOURCES: Record<string, string> = {
  charges: "/v1/charges",
  checkout_sessions: "/v1/checkout/sessions",
  coupons: "/v1/coupons",
  customers: "/v1/customers",
  events: "/v1/events",
  invoices: "/v1/invoices",
  payment_intents: "/v1/payment_intents",
  payment_method_configurations: "/v1/payment_method_configurations",
  prices: "/v1/prices",
  products: "/v1/products",
  promotion_codes: "/v1/promotion_codes",
  refunds: "/v1/refunds",
  subscriptions: "/v1/subscriptions",
  webhook_endpoints: "/v1/webhook_endpoints",
};

export type Config = {
  /** Public details Stripe should hold. Read with a secret key; restricted keys cannot read the account. */
  account?: { country?: string; businessName?: string; supportEmail?: string; url?: string };
  webhooks?: WebhookSpec[];
  /** Payment methods that must be on, by API name: card, bizum, apple_pay, google_pay... */
  paymentMethods?: string[];
  /** Products and prices that must exist, active, with these amounts. */
  catalog?: {
    /** The product metadata field that holds each product's key. Default "preflight_key". */
    keyField?: string;
    products: ProductSpec[];
  };
  /** What the app's restricted key needs, for example { refunds: "write", products: "read" }. */
  permissions?: Record<string, Access>;
  /** Report events Stripe failed to deliver. On by default, over the last 3 days. */
  deliveries?: false | { days?: number };
  dashboard?: (DashboardItem | { label: string; url: string })[];
};

/** Gives editors the types. Returns the config unchanged. */
export function defineConfig(config: Config): Config {
  return config;
}

const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Throws on the first mistake, naming the field, so a typo never passes as "nothing to check". */
export function validate(input: unknown): Config {
  const fail = (msg: string): never => {
    throw new Error(`Config: ${msg}`);
  };
  if (!input || typeof input !== "object") fail("export an object");
  const config = input as Record<string, any>;
  const known = ["account", "webhooks", "paymentMethods", "catalog", "permissions", "deliveries", "dashboard"];
  for (const field of Object.keys(config)) if (!known.includes(field)) fail(`unknown field "${field}"`);

  for (const [i, hook] of (config.webhooks ?? []).entries()) {
    const url = hook?.url;
    if (!isText(url) && !(isText(url?.test) && isText(url?.live))) fail(`webhooks[${i}].url needs a URL or { test, live }`);
    if (!Array.isArray(hook.events) || !hook.events.length || !hook.events.every(isText)) {
      fail(`webhooks[${i}].events needs at least one event name`);
    }
  }
  if (config.paymentMethods && !(Array.isArray(config.paymentMethods) && config.paymentMethods.every(isText))) {
    fail("paymentMethods takes a list of names");
  }
  if (config.catalog !== undefined) {
    const { keyField, products } = config.catalog ?? {};
    if (keyField !== undefined && !isText(keyField)) fail("catalog.keyField takes a metadata field name");
    if (!Array.isArray(products)) fail("catalog.products takes a list of products");
    const keys = new Set<string>();
    const names = new Set<string>();
    for (const [i, product] of products.entries()) {
      const at = `catalog.products[${i}]`;
      if (!isText(product?.key) || keys.has(product.key)) fail(`${at}.key needs a unique key`);
      keys.add(product.key);
      if (!isText(product.name)) fail(`${at}.name is required`);
      if (!Array.isArray(product.prices) || !product.prices.length) fail(`${at}.prices needs at least one price`);
      for (const [j, price] of product.prices.entries()) {
        const where = `${at}.prices[${j}]`;
        if (!isText(price?.name) || names.has(price.name)) fail(`${where}.name needs a name unique across the catalog`);
        names.add(price.name);
        if (!/^[a-z]{3}$/i.test(price.currency ?? "")) fail(`${where}.currency takes a three-letter code`);
        if (!(Number.isInteger(price.unitAmount) && price.unitAmount >= 0)) {
          fail(`${where}.unitAmount takes a whole number in the smallest unit, such as 3900`);
        }
        if (price.interval !== undefined && !["day", "week", "month", "year"].includes(price.interval)) {
          fail(`${where}.interval takes day, week, month or year`);
        }
      }
    }
  }
  for (const [resource, access] of Object.entries(config.permissions ?? {})) {
    if (!RESOURCES[resource]) fail(`permissions: unknown resource "${resource}". Known: ${Object.keys(RESOURCES).join(", ")}`);
    if (access !== "read" && access !== "write") fail(`permissions.${resource} takes "read" or "write"`);
    if (resource === "events" && access === "write") fail("permissions.events can only be read");
  }
  const days = config.deliveries?.days;
  if (config.deliveries !== undefined && config.deliveries !== false && typeof config.deliveries !== "object") {
    fail("deliveries takes false or { days }");
  }
  if (days !== undefined && !(Number.isInteger(days) && days > 0)) fail("deliveries.days takes a whole number above 0");
  for (const item of config.dashboard ?? []) {
    if (typeof item === "string" ? !(item in DASHBOARD) : !(isText(item?.label) && isText(item?.url))) {
      fail(`dashboard: "${JSON.stringify(item)}" is not one of ${Object.keys(DASHBOARD).join(", ")} or { label, url }`);
    }
  }
  return config as Config;
}
