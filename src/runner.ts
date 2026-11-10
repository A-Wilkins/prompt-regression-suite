import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCheck } from "./checks.js";
import type { ModelClient } from "./model.js";
import { SuiteSchema, type Case, type CaseResult, type Suite, type SuiteResult, type TrialResult } from "./types.js";

export async function loadSuite(file: string): Promise<{ suite: Suite; system: string }> {
  const suite = SuiteSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const ids = suite.cases.map((c) => c.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`${file}: duplicate case id "${dup}"`);
  const system = await readFile(path.resolve(path.dirname(file), suite.prompt), "utf8");
  return { suite, system };
}

/** Run tasks with at most `limit` in flight, keeping results in input order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Setup problems (bad key, no access, unknown model) stop the run; scoring them as 0 would hide them. */
function rethrowSetupError(err: unknown): void {
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError ||
    (err instanceof Error && /Could not resolve authentication method/i.test(err.message))
  ) {
    throw err;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `API ${err.status ?? "error"}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

async function runTrial(client: ModelClient, suite: Suite, system: string, c: Case): Promise<TrialResult> {
  let output: string;
  try {
    output = await client.complete({
      model: suite.model,
      effort: suite.effort,
      maxTokens: suite.maxTokens,
      system,
      input: c.input,
    });
  } catch (err) {
    rethrowSetupError(err);
    return { output: "", checks: [], error: describeError(err), score: 0 };
  }

  const checks = c.checks.map((check) => runCheck(check, output));
  const parts = checks.map((r) => (r.passed ? 1 : 0)) as number[];

  let judge: TrialResult["judge"];
  if (c.rubric) {
    try {
      judge = await client.judge({
        model: suite.judge.model,
        effort: suite.judge.effort,
        input: c.input,
        output,
        rubric: c.rubric,
      });
      parts.push(judge.score);
    } catch (err) {
      rethrowSetupError(err);
      // A broken judge must not look like a passing case.
      return { output, checks, error: `judge failed: ${describeError(err)}`, score: 0 };
    }
  }

  const score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  return { output, checks, judge, score };
}

export async function runSuite(
  client: ModelClient,
  suite: Suite,
  system: string,
  opts: { concurrency?: number; filter?: string } = {},
): Promise<SuiteResult> {
  const cases = opts.filter ? suite.cases.filter((c) => c.id.includes(opts.filter!)) : suite.cases;
  const jobs = cases.flatMap((c) => Array.from({ length: suite.trials }, () => c));
  const trials = await pool(jobs, opts.concurrency ?? 4, (c) => runTrial(client, suite, system, c));

  const results: CaseResult[] = cases.map((c, i) => {
    const mine = trials.slice(i * suite.trials, (i + 1) * suite.trials);
    const score = mine.reduce((a, t) => a + t.score, 0) / mine.length;
    return { id: c.id, score, passed: score >= suite.passScore, trials: mine };
  });

  const mean = results.length ? results.reduce((a, r) => a + r.score, 0) / results.length : 0;
  return {
    suite: suite.name,
    model: suite.model,
    mean,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    cases: results,
  };
}
