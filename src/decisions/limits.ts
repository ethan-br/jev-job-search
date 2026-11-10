/**
 * The request size both decision clients refuse before sending. The numbers are in
 * `DECISIONS.limits`: they match what the OpenAI Decisions API accepts, and they sit inside
 * what TypeSafe documents for a choice (at most 255) and a score (at most 10).
 */
import { DECISIONS } from "../config.js";
import { DecisionError, type Questions } from "./types.js";

export function checkQuestions(questions: Questions): void {
  const L = DECISIONS.limits;
  const names = Object.keys(questions);
  if (names.length > L.questions) throw new DecisionError("request", `${names.length} questions in one call, and the limit is ${L.questions}`);
  for (const [name, q] of Object.entries(questions)) {
    if (!name) throw new DecisionError("request", "a question has no name");
    if (!q.instructions.trim()) throw new DecisionError("request", `${name} has no instructions`);
    if (q.type === "choice") {
      const n = Object.keys(q.choices).length;
      if (n < L.minChoices || n > L.maxChoices) throw new DecisionError("request", `${name} offers ${n} choices, and a choice takes ${L.minChoices} to ${L.maxChoices}`);
    }
    if (q.type === "score") {
      const n = q.levels.length;
      if (n < L.minLevels || n > L.maxLevels) throw new DecisionError("request", `${name} has ${n} levels, and a score takes ${L.minLevels} to ${L.maxLevels}`);
      if (new Set(q.levels.map((l) => l.label)).size !== n) throw new DecisionError("request", `${name} has two levels with the same label`);
    }
  }
}
