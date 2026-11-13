// A small Stripe REST client: form-encoded requests, JSON answers, no SDK.

/** The API version every request is sent with, so answers keep the shape this code reads. */
export const API_VERSION = "2026-10-28.endive";

export type Params = { [key: string]: unknown };

export type StripeAnswer = { status: number; body: any };

export class StripeApiError extends Error {
  status: number;
  type: string | undefined;

  constructor(status: number, error: { message?: string; type?: string } | undefined) {
    super(error?.message ?? `Stripe answered ${status}`);
    this.status = status;
    this.type = error?.type;
  }
}

/** Stripe could not be reached at all. Stops the run instead of failing each check. */
export class NetworkError extends Error {}

/** Stripe names the missing permission in the message, for example rak_refund_write. */
export function missingPermission(message: string): string | undefined {
  return /Having the '?(rak_[a-z0-9_]+)'? permission/.exec(message)?.[1];
}

function flatten(params: Params, prefix: string, out: [string, string][]): [string, string][] {
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const key = prefix ? `${prefix}[${name}]` : name;
    if (Array.isArray(value)) {
      value.forEach((item, i) =>
        item !== null && typeof item === "object"
          ? flatten(item as Params, `${key}[${i}]`, out)
          : out.push([`${key}[${i}]`, String(item)]),
      );
    } else if (typeof value === "object") {
      flatten(value as Params, key, out);
    } else {
      out.push([key, String(value)]);
    }
  }
  return out;
}

/** Stripe's form encoding: nested objects as a[b], arrays as a[0]. */
export function encode(params: Params): string {
  return new URLSearchParams(flatten(params, "", [])).toString();
}

export type Client = ReturnType<typeof createClient>;

export function createClient(key: string, fetchImpl: typeof fetch = fetch) {
  /** One request. Never throws on a Stripe error; the caller reads the status. */
  async function request(method: "GET" | "POST", path: string, params: Params = {}): Promise<StripeAnswer> {
    const query = method === "GET" && Object.keys(params).length ? `?${encode(params)}` : "";
    const res = await fetchImpl(`https://api.stripe.com${path}${query}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        "stripe-version": API_VERSION,
        ...(method === "POST" && { "content-type": "application/x-www-form-urlencoded" }),
      },
      body: method === "POST" ? encode(params) : undefined,
    }).catch((err: Error) => {
      throw new NetworkError(`Could not reach api.stripe.com: ${(err.cause as Error | undefined)?.message ?? err.message}`);
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  /** Like request, but throws StripeApiError unless Stripe answered 2xx. */
  async function call(method: "GET" | "POST", path: string, params?: Params): Promise<any> {
    const res = await request(method, path, params);
    if (res.status < 200 || res.status > 299) throw new StripeApiError(res.status, res.body?.error);
    return res.body;
  }

  /** Every item of a list endpoint, page by page, up to max. */
  async function list(path: string, params: Params = {}, max = 1000): Promise<any[]> {
    const items: any[] = [];
    let after: string | undefined;
    while (items.length < max) {
      const page = await call("GET", path, { ...params, limit: 100, starting_after: after });
      items.push(...page.data);
      if (!page.has_more || page.data.length === 0) break;
      after = page.data[page.data.length - 1].id;
    }
    return items.slice(0, max);
  }

  return {
    request,
    get: (path: string, params?: Params) => call("GET", path, params),
    post: (path: string, params?: Params) => call("POST", path, params),
    list,
  };
}
