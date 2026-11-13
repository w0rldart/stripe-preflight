// A small Stripe REST client: form-encoded requests, JSON answers, no SDK.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

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

export type ClientOptions = {
  fetch?: typeof fetch;
  /** Wait before each retry, in milliseconds. One entry per retry. */
  retryDelays?: number[];
  /** Give up on a request after this many milliseconds. */
  timeoutMs?: number;
};

export function createClient(key: string, options: ClientOptions = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const delays = options.retryDelays ?? [500, 2000];
  const timeoutMs = options.timeoutMs ?? 30_000;

  /**
   * One request, retried on network errors, 429 and 5xx, as Stripe advises.
   * Never throws on a Stripe error; the caller reads the status.
   */
  async function request(method: "GET" | "POST", path: string, params: Params = {}): Promise<StripeAnswer> {
    const query = method === "GET" && Object.keys(params).length ? `?${encode(params)}` : "";
    // The same key on every attempt, so a retried POST cannot create anything twice.
    const idempotencyKey = method === "POST" ? randomUUID() : undefined;
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= delays.length;
      let res: Response;
      try {
        res = await fetchImpl(`https://api.stripe.com${path}${query}`, {
          method,
          headers: {
            authorization: `Bearer ${key}`,
            "stripe-version": API_VERSION,
            ...(idempotencyKey && {
              "content-type": "application/x-www-form-urlencoded",
              "idempotency-key": idempotencyKey,
            }),
          },
          body: method === "POST" ? encode(params) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (!last) {
          await sleep(delays[attempt]);
          continue;
        }
        const e = err as Error;
        const why =
          e.name === "TimeoutError"
            ? `no answer within ${timeoutMs / 1000} s`
            : ((e.cause as Error | undefined)?.message ?? e.message);
        throw new NetworkError(`Could not reach api.stripe.com: ${why}`);
      }
      const advice = res.headers.get("stripe-should-retry");
      const retry = advice === "true" || (advice !== "false" && (res.status === 429 || res.status >= 500));
      if (retry && !last) {
        await res.body?.cancel();
        await sleep(delays[attempt]);
        continue;
      }
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }
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
