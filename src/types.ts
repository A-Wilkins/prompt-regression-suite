import { z } from "zod";

/** Deterministic checks that run on the model's text output. Each one scores 0 or 1. */
export const CheckSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("contains"), value: z.string(), caseSensitive: z.boolean().optional() }),
  z.object({ type: z.literal("not_contains"), value: z.string(), caseSensitive: z.boolean().optional() }),
  z.object({ type: z.literal("regex"), pattern: z.string(), flags: z.string().optional() }),
  z.object({ type: z.literal("max_words"), value: z.number().int().positive() }),
  z.object({ type: z.literal("json_valid") }),
  z.object({
    type: z.literal("json_field"),
    /** Dot path into the parsed JSON output, for example "severity" or "crew.count". */
    path: z.string(),
    equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
]);
export type Check = z.infer<typeof CheckSchema>;

export const CaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, "case ids are lowercase letters, digits and underscores"),
  input: z.string().min(1),
  checks: z.array(CheckSchema).default([]),
  /** Plain language grading rule for the LLM judge. Optional; omit for purely deterministic cases. */
  rubric: z.string().optional(),
});
export type Case = z.infer<typeof CaseSchema>;

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const SuiteSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** Path to the system prompt under test, relative to the suite file. */
  prompt: z.string(),
  model: z.string().default("claude-opus-5-5"),
  effort: EffortSchema.default("medium"),
  maxTokens: z.number().int().positive().default(4000),
  /** How many times each case runs; the case score is the mean. Raise it for noisy prompts. */
  trials: z.number().int().positive().default(1),
  /** A case passes when its score is at or above this. */
  passScore: z.number().min(0).max(1).default(0.8),
  /** Fail the run when the suite mean falls more than this below the baseline mean. */
  tolerance: z.number().min(0).max(1).default(0.05),
  judge: z
    .object({ model: z.string().default("claude-opus-5-5"), effort: EffortSchema.default("medium") })
    .prefault({}),
  cases: z.array(CaseSchema).min(1),
});
export type Suite = z.infer<typeof SuiteSchema>;

export interface CheckResult {
  label: string;
  passed: boolean;
}

export interface JudgeResult {
  verdict: "pass" | "partial" | "fail";
  score: number;
  reasoning: string;
}

export interface TrialResult {
  output: string;
  checks: CheckResult[];
  judge?: JudgeResult;
  /** Set when the call failed or the model declined; the trial scores 0. */
  error?: string;
  score: number;
}

export interface CaseResult {
  id: string;
  score: number;
  passed: boolean;
  trials: TrialResult[];
}

export interface SuiteResult {
  suite: string;
  model: string;
  mean: number;
  passed: number;
  total: number;
  cases: CaseResult[];
}

/** What gets saved to baselines/<suite>.json. Outputs are left out so the file diffs cleanly. */
export interface Baseline {
  suite: string;
  model: string;
  createdAt: string;
  mean: number;
  cases: Record<string, { score: number; passed: boolean }>;
}
