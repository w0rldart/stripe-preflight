#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { formatText, preflight, version, type Config, type Mode } from "./index.ts";

const HELP = `stripe-preflight ${version}

Checks that a Stripe account is ready for your app, and sets up what the API allows.

Usage
  stripe-preflight [check]   report only, changes nothing
  stripe-preflight apply     also create or fix the webhook endpoints and payment methods

Options
  --config <file>     config file (default: stripe-preflight.config.ts, .mts, .mjs, .js or .json)
  --env-file <file>   read the key from this file instead of the environment
  --key-var <name>    variable that holds the key (default: STRIPE_SECRET_KEY)
  --expect <mode>     test or live: stop if the key is of the other mode
  --confirm-live      allow apply with a live key
  --json              print the report as JSON
  -h, --help          show this help
  -v, --version       show the version

Exit codes: 0 all passed, 1 a check failed, 2 the run could not start.`;

const CONFIG_FILES = ["ts", "mts", "mjs", "js", "json"].map((ext) => `stripe-preflight.config.${ext}`);

async function loadConfig(path: string | undefined): Promise<Config> {
  const file = path ? resolve(path) : CONFIG_FILES.map((name) => resolve(name)).find((f) => existsSync(f));
  if (!file) throw new Error("No config found. Create stripe-preflight.config.ts or pass --config.");
  if (!existsSync(file)) throw new Error(`Config not found: ${file}`);
  if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"));
  const mod = await import(pathToFileURL(file).href);
  return mod.default;
}

function readKey(envFile: string | undefined, name: string): string {
  if (envFile) {
    // Read the file directly, so a key exported in the shell cannot override it.
    const key = parseEnv(readFileSync(envFile, "utf8"))[name];
    if (!key) throw new Error(`${envFile} has no ${name}.`);
    return key;
  }
  const key = process.env[name];
  if (!key) throw new Error(`Set ${name}, or pass --env-file.`);
  return key;
}

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "env-file": { type: "string" },
      "key-var": { type: "string", default: "STRIPE_SECRET_KEY" },
      expect: { type: "string" },
      "confirm-live": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.help || values.version) {
    console.log(values.help ? HELP : version);
    return 0;
  }

  const command = positionals[0] ?? "check";
  if (positionals.length > 1 || (command !== "check" && command !== "apply")) {
    throw new Error(`Unknown command "${positionals.join(" ")}". Use check or apply.`);
  }
  if (values.expect !== undefined && values.expect !== "test" && values.expect !== "live") {
    throw new Error("--expect takes test or live.");
  }

  const config = await loadConfig(values.config);
  const report = await preflight(config, {
    key: readKey(values["env-file"], values["key-var"]),
    apply: command === "apply",
    confirmLive: values["confirm-live"],
    expect: values.expect as Mode | undefined,
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : formatText(report));
  return report.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`stripe-preflight: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  },
);
