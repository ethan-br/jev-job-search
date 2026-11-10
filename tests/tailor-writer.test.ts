import { describe, expect, it } from "vitest";
import { parseTailored, TAILORED_SCHEMA } from "../src/documents/tailor.js";

function checkObjects(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) checkObjects(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const schema = value as Record<string, unknown>;
  if (schema.type === "object") {
    const properties = schema.properties as Record<string, unknown>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(properties));
  }
  for (const child of Object.values(schema)) checkObjects(child);
}

describe("tailored document writer schema", () => {
  it("requires every property and rejects additional properties on every object", () => {
    checkObjects(TAILORED_SCHEMA);
  });

  it("accepts a null cover letter and removes that optional key", () => {
    const tailored = parseTailored({
      headline: "Software Engineer",
      summary: "A practical engineer with a history of building useful software for teams and their customers.",
      skills: ["TypeScript", "Node", "Testing"],
      experience: [{ company: "Example", title: "Engineer", bullets: ["Built a reliable service for internal users"] }],
      projects: [],
      coverLetter: null,
      keywordsCovered: [],
      keywordsMissing: [],
    });
    expect(tailored).not.toHaveProperty("coverLetter");
  });

  it("rejects a short headline with the expected shape error", () => {
    expect(() => parseTailored({ headline: "Hi" })).toThrow("the draft is not in the expected shape:");
  });

  it("has no length keywords", () => {
    const schema = JSON.stringify(TAILORED_SCHEMA);
    expect(schema).not.toMatch(/minLength|maxLength|minItems|maxItems/);
  });
});
