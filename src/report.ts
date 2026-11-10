import type { Regression } from "./baseline.js";
import type { Baseline, SuiteResult } from "./types.js";

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function consoleReport(result: SuiteResult, baseline: Baseline | undefined, regressions: Regression[]): string {
  const lines = [`\n${result.suite}  (${result.model})`];
  for (const c of result.cases) {
    const base = baseline?.cases[c.id];
    const delta = base ? `  was ${base.score.toFixed(2)}` : "  new";
    lines.push(`  ${c.passed ? "PASS" : "FAIL"}  ${c.id.padEnd(32)} ${c.score.toFixed(2)}${delta}`);
    for (const t of c.trials) {
      if (t.error) lines.push(`        error: ${t.error}`);
      for (const ch of t.checks) if (!ch.passed) lines.push(`        failed check: ${ch.label}`);
      if (t.judge && t.judge.verdict !== "pass") lines.push(`        judge ${t.judge.verdict}: ${t.judge.reasoning}`);
    }
  }
  lines.push(
    `  mean ${result.mean.toFixed(3)}${baseline ? ` (baseline ${baseline.mean.toFixed(3)})` : ""}, ${result.passed}/${result.total} passing`,
  );
  if (regressions.length) {
    lines.push("  REGRESSIONS:");
    for (const r of regressions) lines.push(`    - ${r.detail}`);
  }
  return lines.join("\n");
}

/** Markdown for the GitHub Actions job summary and the uploaded report. */
export function markdownReport(
  rows: { result: SuiteResult; baseline?: Baseline; regressions: Regression[] }[],
): string {
  const out = ["# Prompt regression report", ""];
  const failed = rows.filter((r) => r.regressions.length).length;
  out.push(failed ? `**${failed} suite(s) regressed.**` : "No regressions.", "");
  for (const { result, baseline, regressions } of rows) {
    out.push(`## ${result.suite}`, "");
    out.push(
      `Model \`${result.model}\`. Mean ${pct(result.mean)}${baseline ? ` (baseline ${pct(baseline.mean)})` : " (no baseline yet)"}. ${result.passed} of ${result.total} cases passing.`,
      "",
    );
    out.push("| Case | Score | Baseline | Result |", "|---|---|---|---|");
    for (const c of result.cases) {
      const base = baseline?.cases[c.id];
      out.push(`| ${c.id} | ${c.score.toFixed(2)} | ${base ? base.score.toFixed(2) : "new"} | ${c.passed ? "pass" : "**fail**"} |`);
    }
    if (regressions.length) {
      out.push("", "**Regressions**", "", ...regressions.map((r) => `- ${r.detail}`));
    }
    const failing = result.cases.filter((c) => !c.passed);
    if (failing.length) {
      out.push("", "<details><summary>Why cases failed</summary>", "");
      for (const c of failing) {
        out.push(`**${c.id}**`, "");
        for (const t of c.trials) {
          if (t.error) out.push(`- error: ${t.error}`);
          for (const ch of t.checks) if (!ch.passed) out.push(`- failed check: ${ch.label}`);
          if (t.judge && t.judge.verdict !== "pass") out.push(`- judge (${t.judge.verdict}): ${t.judge.reasoning}`);
        }
        out.push("");
      }
      out.push("</details>");
    }
    out.push("");
  }
  return out.join("\n");
}
