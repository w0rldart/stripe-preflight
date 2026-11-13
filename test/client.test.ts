import assert from "node:assert/strict";
import { test } from "node:test";
import { NetworkError, createClient } from "../src/stripe.ts";

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** Gives the answers in order and records the headers of every attempt. */
function sequence(...answers: Answer[]) {
  const attempts: Headers[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    attempts.push(new Headers(init?.headers));
    const next = answers.shift()!;
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: next.headers });
  }) as typeof fetch;
  return { attempts, client: createClient("sk_test_x", { fetch: fetchImpl, retryDelays: [0, 0] }) };
}

test("retries 429 and 5xx, keeping one idempotency key for a POST", async () => {
  const { attempts, client } = sequence({ status: 500 }, { status: 429 }, { status: 200, body: { id: "we_1" } });
  assert.deepEqual(await client.post("/v1/webhook_endpoints", { url: "https://x.example" }), { id: "we_1" });
  assert.equal(attempts.length, 3);
  const keys = new Set(attempts.map((h) => h.get("idempotency-key")));
  assert.equal(keys.size, 1);
  assert.match([...keys][0]!, /^[0-9a-f-]{36}$/);
});

test("gives up after the last retry and returns Stripe's answer", async () => {
  const { attempts, client } = sequence({ status: 503 }, { status: 503 }, { status: 503, body: { error: { message: "down" } } });
  await assert.rejects(client.get("/v1/account"), /down/);
  assert.equal(attempts.length, 3);
});

test("follows Stripe's advice not to retry", async () => {
  const { attempts, client } = sequence({ status: 500, headers: { "stripe-should-retry": "false" } });
  assert.equal((await client.request("GET", "/v1/account")).status, 500);
  assert.equal(attempts.length, 1);
});

test("a GET carries no idempotency key", async () => {
  const { attempts, client } = sequence({ status: 200, body: {} });
  await client.get("/v1/account");
  assert.equal(attempts[0]!.get("idempotency-key"), null);
});

test("retries network errors, then stops with one message", async () => {
  const down = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
  const { attempts, client } = sequence(down, down, down);
  await assert.rejects(client.get("/v1/account"), (err: Error) => {
    assert.ok(err instanceof NetworkError);
    assert.equal(err.message, "Could not reach api.stripe.com: connect ECONNREFUSED");
    return true;
  });
  assert.equal(attempts.length, 3);
});

test("a request that never answers times out", async () => {
  const hang = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  const client = createClient("sk_test_x", { fetch: hang, retryDelays: [], timeoutMs: 50 });
  // A real request holds a socket open while it waits; stand in for it so the process stays up.
  const socket = setInterval(() => {}, 1000);
  try {
    await assert.rejects(client.get("/v1/account"), /Could not reach api.stripe.com: no answer within 0.05 s/);
  } finally {
    clearInterval(socket);
  }
});
