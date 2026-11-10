/**
 * The decision backend for a command. `DECISIONS_BACKEND` names one client. A failure stays on
 * that client: the other one is not tried, and the two keys are not swapped.
 */
import { decisionSettings } from "../settings.js";
import { OpenCodeDecisions } from "./opencode.js";
import { OpenAIDecisions } from "./openai.js";
import type { Decider } from "./types.js";

export function createDecider(): Decider {
  const settings = decisionSettings();
  const limits = { apiKey: settings.apiKey, runCapUsd: settings.runCapUsd, budgetUsd: settings.budgetUsd };
  if (settings.backend === "opencode") return new OpenCodeDecisions(limits);
  return new OpenAIDecisions(limits);
}
