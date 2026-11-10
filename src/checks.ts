import type { Check, CheckResult } from "./types.js";

/** Pull the first JSON object or array out of a model reply, tolerating a ```json fence around it. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

export function getPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function norm(s: string, caseSensitive?: boolean): string {
  return caseSensitive ? s : s.toLowerCase();
}

export function describeCheck(check: Check): string {
  switch (check.type) {
    case "contains":
      return `contains "${check.value}"`;
    case "not_contains":
      return `does not contain "${check.value}"`;
    case "regex":
      return `matches /${check.pattern}/${check.flags ?? ""}`;
    case "max_words":
      return `at most ${check.value} words`;
    case "json_valid":
      return "is valid JSON";
    case "json_field":
      return `${check.path} == ${JSON.stringify(check.equals)}`;
  }
}

export function runCheck(check: Check, output: string): CheckResult {
  const label = describeCheck(check);
  let passed: boolean;
  switch (check.type) {
    case "contains":
      passed = norm(output, check.caseSensitive).includes(norm(check.value, check.caseSensitive));
      break;
    case "not_contains":
      passed = !norm(output, check.caseSensitive).includes(norm(check.value, check.caseSensitive));
      break;
    case "regex":
      passed = new RegExp(check.pattern, check.flags).test(output);
      break;
    case "max_words":
      passed = output.trim().split(/\s+/).filter(Boolean).length <= check.value;
      break;
    case "json_valid":
      passed = extractJson(output) !== undefined;
      break;
    case "json_field": {
      const actual = getPath(extractJson(output), check.path);
      passed =
        typeof actual === "string" && typeof check.equals === "string"
          ? actual.trim().toLowerCase() === check.equals.trim().toLowerCase()
          : actual === check.equals;
      break;
    }
  }
  return { label, passed };
}
