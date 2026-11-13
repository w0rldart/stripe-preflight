# stripe-preflight

Checks that a Stripe account is ready for your app, and sets up the parts Stripe's API allows.

Most Stripe setup happens by hand in the Dashboard, and small mistakes stay hidden until a real order goes wrong: a webhook missing one event, a restricted key without one permission, a payment method left off, a price that still has last year's amount. stripe-preflight compares the account with a short config file and reports each gap with the fix.

```
stripe-preflight 0.1.0: test mode, secret key

PASS  account          Example Shop, ES, ready for live payments
FAIL  webhook          https://shop.example.com/api/stripe: no endpoint
                       Run apply to create it.
FAIL  payment methods  off: bizum
                       Run apply, or see Settings, Payment methods: https://dashboard.stripe.com/test/settings/payment_methods
SKIP  permissions      a secret key has every permission
                       Run check with the app's restricted key to test what it can do.
PASS  deliveries       no failed deliveries in the last 3 days
TODO  dashboard        Customer emails: turn on Refunds
                       https://dashboard.stripe.com/settings/emails

2 failed, 1 skipped, 1 to confirm in the Dashboard.
```

It needs Node 22.18 or later and has no dependencies.

## What it checks

| Area | Check | `apply` |
| --- | --- | --- |
| account | Country, business name, support email and website. In live mode, that the account can take payments and receive payouts. | Reports only |
| webhook | Each endpoint exists, is enabled, receives exactly your events and uses your API version. | Creates the endpoint, or fixes its events, description and metadata |
| payment methods | Each listed method is on, and Stripe has activated it. | Turns them on |
| catalog | Each product exists with its name, description and metadata, and has an active price for each amount. | Creates or updates products and prices |
| permissions | Your app's restricted key has every permission it needs. | Reports only |
| deliveries | Events Stripe failed to deliver in the last few days. | Reports only |
| dashboard | Steps Stripe offers no API for, each with a link. | You confirm them |

## Use

```sh
npx stripe-preflight          # check: reports, changes nothing
npx stripe-preflight apply    # also creates or fixes webhooks, payment methods, products and prices
```

The key comes from `STRIPE_SECRET_KEY`. To read it from a file instead:

```sh
npx stripe-preflight --env-file .dev.vars
```

The file is read directly, so a key exported in your shell cannot take its place.

| Option | |
| --- | --- |
| `--config <file>` | Config file. By default `stripe-preflight.config.ts`, `.mts`, `.mjs`, `.js` or `.json` in the current folder. |
| `--env-file <file>` | Read the key from this file. |
| `--key-var <name>` | The variable that holds the key. Default `STRIPE_SECRET_KEY`. |
| `--expect <mode>` | `test` or `live`. Stops if the key is of the other mode. |
| `--confirm-live` | Required for `apply` with a live key. |
| `--replace-prices` | With `apply`: archive a price whose amount changed and create the new one. |
| `--only <checks>` | Run only these, comma-separated: `account`, `webhooks`, `paymentMethods`, `catalog`, `permissions`, `deliveries`, `dashboard`. |
| `--strict` | Count warnings as failures. |
| `--json` | Print the report as JSON. |

Exit codes: `0` when every check passed, `1` when one failed, `2` when the run could not start.

## Config

```ts
// stripe-preflight.config.ts
export default {
  account: { country: "ES", businessName: "Example Shop", supportEmail: "hello@example.com" },
  webhooks: [
    {
      url: "https://shop.example.com/api/stripe",
      events: ["checkout.session.completed", "checkout.session.async_payment_succeeded"],
      apiVersion: "2026-10-28.endive",
    },
  ],
  paymentMethods: ["card", "bizum", "apple_pay", "google_pay"],
  catalog: {
    products: [
      {
        key: "pro",
        name: "Example Pro",
        prices: [
          { name: "PRICE_PRO_MONTHLY", currency: "eur", unitAmount: 1900, interval: "month" },
          { name: "PRICE_PRO_ANNUAL", currency: "eur", unitAmount: 19000, interval: "year" },
        ],
      },
    ],
  },
  permissions: {
    checkout_sessions: "write",
    refunds: "write",
    products: "read",
  },
  dashboard: ["receipts", "refunds", "publicDetails", "branding", "team", "restrictedKey"],
};
```

Every field is optional.

- `webhooks[].url` takes one URL, or `{ test, live }` when the modes use different ones.
- `webhooks[].apiVersion` should match the version your Stripe library pins. Stripe sets it when the endpoint is created and cannot change it later, so `apply` never touches it. If it is wrong, delete the endpoint in the Dashboard and run `apply` again.
- `webhooks[].description` and `webhooks[].metadata` are optional. When set, a difference is a warning and `apply` updates it. A new endpoint also gets `stripe_preflight: "1"` in its metadata.
- `paymentMethods` uses Stripe's API names, such as `card`, `bizum`, `apple_pay`, `google_pay`, `twint`, `ideal`.
- `catalog.products[].key` finds the product through a metadata field, `preflight_key` unless you set `catalog.keyField`. A price matches when currency, amount and interval match. Amounts are in the smallest unit, so `1900` is 19.00 EUR. Leave out `interval` for a one-time price. `name` is yours, such as the variable that will hold the price's ID; the report lists every ID under that name.
- `permissions` takes `read` or `write` for: `charges`, `checkout_sessions`, `coupons`, `customers`, `events`, `invoices`, `payment_intents`, `payment_method_configurations`, `prices`, `products`, `promotion_codes`, `refunds`, `subscriptions`, `webhook_endpoints`.
- `deliveries` is on by default over 3 days. Set `{ days: 7 }`, or `false` to turn it off.
- `dashboard` takes `receipts`, `refunds`, `publicDetails`, `branding`, `team`, `restrictedKey`, or your own `{ label, url }`.

For types in your editor, install the package and wrap the object in `defineConfig` from `stripe-preflight`.

## Prices

A Stripe price cannot change its amount. When the config has a new amount, `check` shows the old price and the expected one. `apply` leaves it alone unless you add `--replace-prices`: then it archives the old price and creates the new one. Subscriptions already on the old price keep it. A price that another entry in the config uses is never archived.

## Two keys

Run `apply` with a secret key from the Dashboard. It can read and change everything this tool touches. Keep it on your machine; your app does not need it.

Then run `check` with the restricted key your app uses. That run tests the key's permissions and skips the areas the key cannot read. When the account check is skipped, run it with the secret key.

## Safety

- `check` changes nothing.
- `apply` with a live key needs `--confirm-live`.
- `--expect live` stops a run that was handed a test key by mistake, and the other way round.
- The key is never printed. Reports show only its type, such as `rk_live`.
- `apply` never deletes anything.
- A new webhook's signing secret is printed once, because Stripe shows it only when the endpoint is created. Store it straight away.
- That secret is part of the output, `--json` included. Don't run `apply` where the output ends up in logs, such as CI.
- Each request times out after 30 seconds. Network errors, 429 and 5xx answers are retried twice, and a retried change carries the same idempotency key, so it can't happen twice.

## How permissions are checked

A read probe lists one item. A write probe sends a create request with a parameter Stripe does not know, so Stripe rejects it and nothing is created. A `400` means the key got past the permission check; a `403` means the permission is missing, and Stripe's message names it, for example `rak_event_read`.

This relies on Stripe checking permissions before parameters. The real-Stripe test below confirms it on your own account.

## From code

```ts
import { preflight, formatText } from "stripe-preflight";

const report = await preflight(config, { key: process.env.STRIPE_SECRET_KEY! });
console.log(formatText(report));
```

`report.ok` is false when any check failed. `report.results` holds one entry per check with `area`, `status`, `message`, and optional `details` and `fix`. `report.ids` has the IDs found or created: `products` by key, `prices` by name, `webhooks` by URL.

The options match the CLI flags: `apply`, `confirmLive`, `expect`, `replacePrices`, `only` and `strict`.

## What it does not do

Customer emails, branding, team access and creating API keys have no Stripe API, so it lists them for you to confirm.

## Tests

```sh
npm test
```

The tests use recorded Stripe answers. To also run against a real test account, set `STRIPE_TEST_KEY` to a test-mode secret key, and `STRIPE_TEST_LIMITED_KEY` to a test-mode restricted key that has Products: Read and nothing else. Those runs only read.

## License

MIT
