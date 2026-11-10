import { describe, expect, it } from "vitest";
import { DecisionError } from "../src/decisions/types.js";
import { haltsRun } from "../src/run/pipeline.js";
import { WriterError } from "../src/writer/contract.js";

describe("haltsRun", () => {
  it("halts for decision errors that stop every call", () => {
    for (const kind of ["config", "auth", "quota", "spend_limit"] as const) {
      expect(haltsRun(new DecisionError(kind, "x"))).toBe(true);
    }
  });

  it("halts for writer errors that stop every call", () => {
    for (const kind of ["config", "spawn", "exit", "billing"] as const) {
      expect(haltsRun(new WriterError(kind, "x"))).toBe(true);
    }
  });

  it("continues for task-specific errors and other values", () => {
    expect(haltsRun(new DecisionError("timeout", "x"))).toBe(false);
    expect(haltsRun(new DecisionError("malformed", "x"))).toBe(false);
    expect(haltsRun(new WriterError("timeout", "x"))).toBe(false);
    expect(haltsRun(new WriterError("malformed", "x"))).toBe(false);
    expect(haltsRun(new WriterError("invalid_output", "x"))).toBe(false);
    expect(haltsRun(new Error("x"))).toBe(false);
    expect(haltsRun("x")).toBe(false);
  });
});
