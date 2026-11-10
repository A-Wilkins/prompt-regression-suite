import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Baseline, SuiteResult } from "./types.js";

export interface Regression {
  kind: "case_now_failing" | "mean_dropped" | "case_missing";
  detail: string;
}

export function toBaseline(result: SuiteResult): Baseline {
  return {
    suite: result.suite,
    model: result.model,
    createdAt: new Date().toISOString(),
    mean: round(result.mean),
    cases: Object.fromEntries(result.cases.map((c) => [c.id, { score: round(c.score), passed: c.passed }])),
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * A run regresses when a case that passed in the baseline now fails, or when the suite mean
 * falls more than `tolerance` below the baseline mean. New cases are reported but never fail
 * the run, so adding coverage does not need a baseline refresh first.
 */
export function compare(result: SuiteResult, baseline: Baseline, tolerance: number, partial = false): Regression[] {
  const out: Regression[] = [];
  const current = new Map(result.cases.map((c) => [c.id, c]));

  for (const [id, base] of Object.entries(baseline.cases)) {
    const now = current.get(id);
    if (!now) {
      if (!partial) out.push({ kind: "case_missing", detail: `${id} is in the baseline but was not run` });
      continue;
    }
    if (base.passed && !now.passed) {
      out.push({
        kind: "case_now_failing",
        detail: `${id} passed in the baseline (${base.score.toFixed(2)}) and now fails (${now.score.toFixed(2)})`,
      });
    }
  }

  // The mean only means something when the same set of cases ran.
  if (!partial) {
    const drop = baseline.mean - result.mean;
    if (drop > tolerance + 1e-9) {
      out.push({
        kind: "mean_dropped",
        detail: `suite mean fell from ${baseline.mean.toFixed(3)} to ${result.mean.toFixed(3)} (tolerance ${tolerance})`,
      });
    }
  }
  return out;
}

export function baselinePath(dir: string, suite: string): string {
  return path.join(dir, `${suite}.json`);
}

export async function readBaseline(dir: string, suite: string): Promise<Baseline | undefined> {
  try {
    return JSON.parse(await readFile(baselinePath(dir, suite), "utf8")) as Baseline;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function writeBaseline(dir: string, result: SuiteResult): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = baselinePath(dir, result.suite);
  await writeFile(file, JSON.stringify(toBaseline(result), null, 2) + "\n");
  return file;
}
