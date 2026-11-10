import { describe, expect, it } from "vitest";
import { compare, toBaseline } from "../src/baseline.js";
import type { ModelClient } from "../src/model.js";
import { loadSuite, pool, runSuite } from "../src/runner.js";
import { SuiteSchema, type JudgeResult } from "../src/types.js";

/** A fake model: answers come from a lookup on the input, so no API calls are made. */
function fakeClient(
  answers: Record<string, string | Error>,
  verdict: JudgeResult["verdict"] | Error = "pass",
): ModelClient {
  return {
    async complete({ input }) {
      const a = answers[input];
      if (a instanceof Error) throw a;
      return a ?? "";
    },
    async judge() {
      if (verdict instanceof Error) throw verdict;
      return { verdict, score: { pass: 1, partial: 0.5, fail: 0 }[verdict], reasoning: "fake" };
    },
  };
}

const suite = SuiteSchema.parse({
  name: "demo",
  prompt: "unused.md",
  cases: [
    { id: "a", input: "A", checks: [{ type: "json_field", path: "x", equals: 1 }] },
    { id: "b", input: "B", checks: [{ type: "contains", value: "yes" }], rubric: "says yes" },
  ],
});

describe("runSuite", () => {
  it("scores deterministic checks and the judge together", async () => {
    const r = await runSuite(fakeClient({ A: '{"x":1}', B: "yes" }), suite, "sys");
    expect(r.cases.map((c) => [c.id, c.score, c.passed])).toEqual([
      ["a", 1, true],
      ["b", 1, true],
    ]);
    expect(r.mean).toBe(1);
  });

  it("averages a partial judge verdict with the checks", async () => {
    const r = await runSuite(fakeClient({ A: '{"x":1}', B: "yes" }, "partial"), suite, "sys");
    expect(r.cases[1].score).toBe(0.75);
    expect(r.cases[1].passed).toBe(false); // default passScore is 0.8
  });

  it("scores a failed model call as 0 and records the error", async () => {
    const r = await runSuite(fakeClient({ A: new Error("boom"), B: "yes" }), suite, "sys");
    expect(r.cases[0].score).toBe(0);
    expect(r.cases[0].trials[0].error).toBe("boom");
  });

  it("never lets a broken judge count as a pass", async () => {
    const r = await runSuite(fakeClient({ A: '{"x":1}', B: "yes" }, new Error("judge down")), suite, "sys");
    expect(r.cases[1].score).toBe(0);
    expect(r.cases[1].trials[0].error).toMatch(/judge failed/);
  });

  it("runs each case once per trial and averages", async () => {
    let n = 0;
    const flaky: ModelClient = {
      async complete() {
        return n++ % 2 === 0 ? '{"x":1}' : '{"x":2}';
      },
      async judge() {
        return { verdict: "pass", score: 1, reasoning: "" };
      },
    };
    const three = SuiteSchema.parse({ ...suite, trials: 4, cases: [suite.cases[0]] });
    const r = await runSuite(flaky, three, "sys", { concurrency: 1 });
    expect(r.cases[0].trials).toHaveLength(4);
    expect(r.cases[0].score).toBe(0.5);
  });

  it("filters cases by id", async () => {
    const r = await runSuite(fakeClient({ B: "yes" }), suite, "sys", { filter: "b" });
    expect(r.cases.map((c) => c.id)).toEqual(["b"]);
  });
});

describe("compare", () => {
  const passing = async () => runSuite(fakeClient({ A: '{"x":1}', B: "yes" }), suite, "sys");

  it("finds no regressions against its own baseline", async () => {
    const r = await passing();
    expect(compare(r, toBaseline(r), 0.05)).toEqual([]);
  });

  it("flags a case that used to pass and now fails", async () => {
    const base = toBaseline(await passing());
    const worse = await runSuite(fakeClient({ A: '{"x":2}', B: "yes" }), suite, "sys");
    const kinds = compare(worse, base, 0.05).map((x) => x.kind);
    expect(kinds).toContain("case_now_failing");
    expect(kinds).toContain("mean_dropped");
  });

  it("allows a small mean drop inside the tolerance", async () => {
    const base = toBaseline(await passing());
    const r = await passing();
    r.mean = base.mean - 0.04;
    expect(compare(r, base, 0.05)).toEqual([]);
  });

  it("ignores missing cases and the mean on a filtered run", async () => {
    const base = toBaseline(await passing());
    const r = await runSuite(fakeClient({ B: "yes" }), suite, "sys", { filter: "b" });
    expect(compare(r, base, 0.05, true)).toEqual([]);
    expect(compare(r, base, 0.05, false).map((x) => x.kind)).toContain("case_missing");
  });

  it("does not fail on a new case that is not in the baseline", async () => {
    const r = await passing();
    const base = toBaseline(r);
    delete base.cases.b;
    expect(compare(r, base, 0.05)).toEqual([]);
  });
});

describe("pool", () => {
  it("keeps input order and respects the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await pool([30, 10, 20, 5], 2, async (ms) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return ms;
    });
    expect(out).toEqual([30, 10, 20, 5]);
    expect(peak).toBe(2);
  });
});

describe("bundled suites", () => {
  it.each(["rfi-triage", "daily-log-extract", "safety-severity"])("%s loads and validates", async (name) => {
    const { suite: s, system } = await loadSuite(`suites/${name}.json`);
    expect(s.cases.length).toBeGreaterThan(4);
    expect(system.length).toBeGreaterThan(100);
  });
});
