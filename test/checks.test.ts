import { describe, expect, it } from "vitest";
import { extractJson, getPath, runCheck } from "../src/checks.js";

describe("extractJson", () => {
  it("parses bare JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses JSON inside a code fence", () => {
    expect(extractJson('Here you go:\n```json\n{"a": [1, 2]}\n```')).toEqual({ a: [1, 2] });
  });
  it("finds JSON surrounded by prose", () => {
    expect(extractJson('Result: {"priority": "urgent"} done')).toEqual({ priority: "urgent" });
  });
  it("returns undefined for non JSON", () => {
    expect(extractJson("no json here")).toBeUndefined();
  });
});

describe("getPath", () => {
  it("walks objects and array indexes", () => {
    expect(getPath({ a: { b: [{ c: 3 }] } }, "a.b.0.c")).toBe(3);
  });
  it("returns undefined for a missing path", () => {
    expect(getPath({ a: 1 }, "a.b")).toBeUndefined();
  });
});

describe("runCheck", () => {
  const out = '{"priority": "Urgent", "count": 15, "flag": false, "note": null}';

  it("contains is case insensitive by default", () => {
    expect(runCheck({ type: "contains", value: "URGENT" }, out).passed).toBe(true);
    expect(runCheck({ type: "contains", value: "URGENT", caseSensitive: true }, out).passed).toBe(false);
  });
  it("not_contains", () => {
    expect(runCheck({ type: "not_contains", value: "low" }, out).passed).toBe(true);
  });
  it("regex", () => {
    expect(runCheck({ type: "regex", pattern: "count\\D+15" }, out).passed).toBe(true);
  });
  it("max_words", () => {
    expect(runCheck({ type: "max_words", value: 3 }, "one two three").passed).toBe(true);
    expect(runCheck({ type: "max_words", value: 2 }, "one two three").passed).toBe(false);
  });
  it("json_field compares strings loosely and other values exactly", () => {
    expect(runCheck({ type: "json_field", path: "priority", equals: "urgent" }, out).passed).toBe(true);
    expect(runCheck({ type: "json_field", path: "count", equals: 15 }, out).passed).toBe(true);
    expect(runCheck({ type: "json_field", path: "count", equals: "15" }, out).passed).toBe(false);
    expect(runCheck({ type: "json_field", path: "flag", equals: false }, out).passed).toBe(true);
    expect(runCheck({ type: "json_field", path: "note", equals: null }, out).passed).toBe(true);
  });
  it("json_field fails when the output is not JSON", () => {
    expect(runCheck({ type: "json_field", path: "priority", equals: "urgent" }, "urgent").passed).toBe(false);
  });
});
