import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { JudgeResult } from "./types.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The two calls the runner needs. Tests pass a fake; the CLI passes the real Claude client.
 * Keeping this seam small means the scoring logic is tested without spending API credit.
 */
export interface ModelClient {
  complete(args: { model: string; effort: Effort; maxTokens: number; system: string; input: string }): Promise<string>;
  judge(args: { model: string; effort: Effort; input: string; output: string; rubric: string }): Promise<JudgeResult>;
}

export class ModelDeclinedError extends Error {}

const JudgeSchema = z.object({
  reasoning: z.string(),
  verdict: z.enum(["pass", "partial", "fail"]),
});

const VERDICT_SCORE = { pass: 1, partial: 0.5, fail: 0 } as const;

const JUDGE_SYSTEM = `You grade one output from a prompt under test against a rubric.
Read the task input, the output, and the rubric. Judge only what the rubric asks about.
Give "pass" when every point in the rubric is met, "partial" when some are met and nothing in the output is wrong or harmful, and "fail" otherwise.
Write your reasoning in two or three sentences, before the verdict.`;

export class ClaudeClient implements ModelClient {
  constructor(private client = new Anthropic()) {}

  async complete({ model, effort, maxTokens, system, input }: Parameters<ModelClient["complete"]>[0]) {
    // Server side fallbacks: if a safety classifier declines, the API reruns the request on a
    // fallback model chosen by refusal category instead of returning an empty answer.
    const response = await this.client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort },
      system,
      messages: [{ role: "user", content: input }],
    });
    if (response.stop_reason === "refusal") {
      throw new ModelDeclinedError(`model declined (${response.stop_details?.category ?? "no category"})`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error(`output hit max_tokens (${maxTokens}); raise maxTokens in the suite`);
    }
    return response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
  }

  async judge({ model, effort, input, output, rubric }: Parameters<ModelClient["judge"]>[0]): Promise<JudgeResult> {
    const response = await this.client.messages.parse({
      model,
      max_tokens: 4000,
      output_config: { effort, format: zodOutputFormat(JudgeSchema) },
      system: JUDGE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `<task_input>\n${input}\n</task_input>\n\n<output>\n${output}\n</output>\n\n<rubric>\n${rubric}\n</rubric>`,
        },
      ],
    });
    if (response.stop_reason === "refusal") throw new ModelDeclinedError("judge declined");
    const parsed = response.parsed_output;
    if (!parsed) throw new Error("judge returned no parsable verdict");
    return { verdict: parsed.verdict, score: VERDICT_SCORE[parsed.verdict], reasoning: parsed.reasoning };
  }
}
