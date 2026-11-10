import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { compare, readBaseline, writeBaseline } from "./baseline.js";
import { ClaudeClient } from "./model.js";
import { consoleReport, markdownReport } from "./report.js";
import { loadSuite, runSuite } from "./runner.js";

const HELP = `Usage: npm run eval -- [options]

  --suite <file>        run one suite file (default: every suites/*.json)
  --prompt <file>       swap in a different system prompt (to test a change before committing it)
  --filter <text>       only run cases whose id contains this text
  --update-baseline     save this run as the new baseline instead of comparing
  --concurrency <n>     parallel requests (default 4)
  --baselines <dir>     baseline folder (default baselines)
  --report <file>       write a markdown report (default reports/latest.md)

Exits 1 when any suite regresses against its baseline, 2 on a setup error.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      suite: { type: "string" },
      prompt: { type: "string" },
      filter: { type: "string" },
      "update-baseline": { type: "boolean", default: false },
      concurrency: { type: "string", default: "4" },
      baselines: { type: "string", default: "baselines" },
      report: { type: "string", default: "reports/latest.md" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values["update-baseline"] && (values.filter || values.prompt)) {
    console.error("--update-baseline cannot be combined with --filter or --prompt: a baseline must cover the committed prompt and every case.");
    return 2;
  }

  const files = values.suite
    ? [values.suite]
    : (await readdir("suites")).filter((f) => f.endsWith(".json")).sort().map((f) => path.join("suites", f));
  if (!files.length) {
    console.error("No suites found in suites/.");
    return 2;
  }
  if (values.prompt && files.length > 1) {
    console.error("--prompt needs --suite, since it replaces one suite's prompt.");
    return 2;
  }

  const client = new ClaudeClient();
  const rows = [];
  for (const file of files) {
    const loaded = await loadSuite(file);
    const system = values.prompt ? await readFile(values.prompt, "utf8") : loaded.system;
    const result = await runSuite(client, loaded.suite, system, {
      concurrency: Number(values.concurrency),
      filter: values.filter,
    });

    if (values["update-baseline"]) {
      const saved = await writeBaseline(values.baselines!, result);
      console.log(consoleReport(result, undefined, []));
      console.log(`  baseline saved to ${saved}`);
      rows.push({ result, regressions: [] });
      continue;
    }

    const baseline = await readBaseline(values.baselines!, result.suite);
    const regressions = baseline ? compare(result, baseline, loaded.suite.tolerance, Boolean(values.filter)) : [];
    console.log(consoleReport(result, baseline, regressions));
    if (!baseline) console.log("  no baseline yet: run with --update-baseline to create one");
    rows.push({ result, baseline, regressions });
  }

  const md = markdownReport(rows);
  await mkdir(path.dirname(values.report!), { recursive: true });
  await writeFile(values.report!, md);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);

  const regressed = rows.filter((r) => r.regressions.length).length;
  console.log(regressed ? `\n${regressed} suite(s) regressed.` : "\nNo regressions.");
  return regressed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
