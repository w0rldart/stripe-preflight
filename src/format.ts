import type { Status } from "./checks.ts";
import type { Report } from "./index.ts";

const LABEL: Record<Status, string> = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP", todo: "TODO" };

/** The report as plain text for a terminal. */
export function formatText(report: Report): string {
  const { key } = report;
  const lines = [
    `stripe-preflight ${report.version}: ${key.mode} mode, ${key.restricted ? "restricted" : "secret"} key${report.applied ? ", applying" : ""}`,
    "",
  ];
  const width = Math.max(8, ...report.results.map((r) => r.area.length)) + 2;
  const indent = " ".repeat(6 + width);
  for (const r of report.results) {
    lines.push(`${LABEL[r.status]}  ${r.area.padEnd(width)}${r.message}`);
    for (const detail of r.details ?? []) lines.push(indent + detail);
    if (r.fix) lines.push(indent + r.fix);
  }
  const prices = Object.entries(report.ids.prices);
  if (prices.length) {
    lines.push("", "Price IDs:");
    for (const [name, id] of prices) lines.push(`  ${name}=${id}`);
  }
  if (report.secrets.length) {
    lines.push("", "Shown once. Store it now:");
    for (const s of report.secrets) lines.push(`  ${s.label}: ${s.value}`);
  }
  const count = (status: Status) => report.results.filter((r) => r.status === status).length;
  const summary = (
    [
      [count("fail"), "failed"],
      [count("warn"), "with warnings"],
      [count("skip"), "skipped"],
      [count("todo"), "to confirm in the Dashboard"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}`);
  lines.push("", summary.length ? `${summary.join(", ")}.` : "All checks passed.");
  return lines.join("\n");
}
