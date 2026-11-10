# Prompt Regression Suite

Unit tests for LLM prompts. Each suite pairs a system prompt with graded test cases. A run sends every case to Claude, scores the output with deterministic checks and an LLM judge, and compares the scores with a committed baseline. If a case that used to pass now fails, or the suite's average drops past a tolerance, the run exits 1 and CI goes red.

A small change to a prompt can quietly break cases nobody re-tested by hand. This catches that before it merges.

The bundled suites are construction workflows: RFI triage, turning a superintendent's notes into a daily log, and classifying jobsite safety reports.

## How it works

```
suites/<name>.json    cases + settings ──┐
prompts/<name>.md     prompt under test ─┤
                                         ▼
                        Claude (prompt under test)
                                         │ output
                    ┌────────────────────┴───────────────────┐
           deterministic checks                     Claude judge (rubric)
     json_valid, json_field, contains,         structured output: reasoning
     not_contains, regex, max_words            + verdict pass/partial/fail
                    └────────────────────┬───────────────────┘
                              case score 0..1
                                         │
                    compare with baselines/<name>.json
                                         │
                  exit 0 (no regressions)  /  exit 1 (regressed)
```

- **Case score** is the average of its checks (each 0 or 1) and the judge verdict (pass 1, partial 0.5, fail 0). A case passes at `passScore` (default 0.8).
- **A regression** is a case that passed in the baseline and now fails, or a suite mean more than `tolerance` (default 0.05) below the baseline mean. New cases never fail a run, so you can add coverage before refreshing the baseline.
- **Noise:** set `trials` on a suite to run each case several times and average the scores.
- **Errors count against you.** A failed call, a model refusal, or a judge that cannot return a verdict scores the case 0. A bad API key, a missing permission, or an unknown model stops the run with exit 2 rather than looking like a regression.
- **Judge output** uses structured outputs (`messages.parse` with a Zod schema), so a verdict is always one of three values, never free text the harness has to guess at.
- The prompt under test runs with server side refusal fallbacks enabled (`fallbacks: "default"`), so a false positive refusal is retried on a fallback model instead of returning nothing.

## Setup

Requires Node 20 or newer and an Anthropic API key.

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env   # read by npm run eval; .env is gitignored
```

An exported `ANTHROPIC_API_KEY` environment variable works too.

## Usage

```bash
npm test                                   # unit tests for the harness itself, no API calls
npm run eval -- --update-baseline          # first run: record the baseline for every suite
npm run eval                               # compare against the baselines; exit 1 on a regression
npm run eval -- --suite suites/rfi-triage.json --filter energized    # one suite, matching cases
npm run eval -- --suite suites/rfi-triage.json --prompt prompts/rfi-triage.loose.md   # try a prompt change
```

`prompts/rfi-triage.loose.md` is a deliberately weaker rewrite of the RFI prompt: it drops the priority rules, the discipline definitions, and the JSON shape. Running it against the RFI suite shows what a regression report looks like.

## Example: catching a prompt regression

First live run, `claude-opus-5-5` at low effort. The committed prompts pass all 19 cases (suite means 1.000, 0.982, 1.000). Then the RFI suite was run with the loose prompt swapped in:

```
rfi-triage  (claude-opus-5-5)
  FAIL  pour_blocked_rebar_conflict      0.67  was 1.00
        failed check: priority == "urgent"
        failed check: discipline == "structural"
  FAIL  paint_color_clarification        0.25  was 1.00
  ...
  mean 0.548 (baseline 0.982), 0/7 passing
  REGRESSIONS:
    - pour_blocked_rebar_conflict passed in the baseline (1.00) and now fails (0.67)
    ...
    - suite mean fell from 0.982 to 0.548 (tolerance 0.05)

1 suite(s) regressed.        (exit code 1)
```

The loose prompt's answers still read well. For the energized panel RFI it wrote a sensible summary and recommended actions. But it invented its own schema: `"priority": "Critical"` instead of one of `urgent / normal / low`, and a `trade` field instead of `discipline`. Any code that reads that JSON (a Procore sync, a dashboard, a routing rule) would break, and nobody reviewing the text by eye would notice. The suite catches it on every case.

The first run also caught a bad test case. `rtu_curb_size` said the delivery was "set for the 14th" with no current date, so the model reasonably did not call it urgent under the 48 hour rule. The case was rewritten to say "tomorrow morning". The judge still marks that summary partial because it does not say the curb was detailed for the old unit. That is a real, small weakness in the prompt, and it is recorded in the baseline at 0.88.

Every run writes `reports/latest.md`. In GitHub Actions the same report goes to the job summary.

## Writing a suite

```json
{
  "name": "rfi-triage",
  "prompt": "../prompts/rfi-triage.md",
  "model": "claude-opus-5-5",
  "effort": "low",
  "trials": 1,
  "passScore": 0.8,
  "tolerance": 0.05,
  "cases": [
    {
      "id": "pour_blocked_rebar_conflict",
      "input": "RFI from Gulf Concrete: Level 3 deck pour is scheduled for Thursday ...",
      "checks": [
        { "type": "json_field", "path": "priority", "equals": "urgent" },
        { "type": "regex", "pattern": "EP-14|embed", "flags": "i" }
      ],
      "rubric": "The summary names the embed plate conflict and that the pour depends on the answer."
    }
  ]
}
```

| Check | Passes when |
|---|---|
| `json_valid` | the output contains a JSON object or array (code fences are fine) |
| `json_field` | the value at a dot path (`inspections.0.result`) equals `equals`; strings compare case insensitively |
| `contains` / `not_contains` | the text does or does not include `value` (case insensitive unless `caseSensitive`) |
| `regex` | `pattern` matches |
| `max_words` | the output has at most `value` words |

Use checks for anything a script can verify and keep `rubric` for judgment calls. The judge is the slow, costly, and less consistent part.

Defaults: `model` and the judge model are `claude-opus-5-5`; `effort` defaults to `medium` (the bundled suites use `low` because they are short classification and extraction tasks).

## CI

`.github/workflows/eval.yml` runs the typecheck and unit tests on every push and pull request. The `eval` job then runs every suite against the committed baselines. Add `ANTHROPIC_API_KEY` as a repository secret to turn it on; without it the job logs a warning and skips. Pull requests from forks never receive the secret.

To change a prompt on purpose, run `npm run eval -- --update-baseline` and commit the new baseline with the prompt change, so the review shows both.

## Project layout

```
src/
  cli.ts        argument parsing, baseline update or compare, exit codes, reports
  runner.ts     loads suites, runs cases with bounded concurrency, scores trials
  model.ts      the Claude calls: prompt under test, and the structured output judge
  checks.ts     deterministic checks and JSON extraction
  baseline.ts   baseline files and regression rules
  report.ts     console and markdown reports
test/           vitest unit tests with a fake model client
suites/         test cases
prompts/        prompts under test
baselines/      committed scores from the last accepted run
```
