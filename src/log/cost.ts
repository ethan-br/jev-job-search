/**
 * What the tool has cost, read from its two records. OpenAI decision calls are priced by this tool
 * from the tokens the backend reported, so those figures are estimates. A call marked free is a
 * known price of zero and is shown as free. The writer is whatever command the person configured,
 * and this tool has no price for it: it shows what the writer reported and says how many calls
 * reported nothing. A cost that is not known is counted as unknown, never as zero.
 */
import { PATHS, COST, DECISIONS } from "../config.js";
import { readUsage, type UsageLine } from "../decisions/usage.js";
import { STAGES, type Stage } from "../decisions/types.js";
import { readWriterUsage, type WriterUsageLine } from "../writer/usage.js";
import { TASK_KINDS, type TaskKind } from "../writer/contract.js";
import type { BillingMode } from "../settings.js";
import { loadQueue } from "../jobs/queue.js";

/** Totals for decision attempts in one group. */
export type DecisionBucket = {
  calls: number;
  retries: number;
  failedAttempts: number;
  refusals: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  estimatedUsd: number;
  /** Dollars a response named itself. These are not an estimate from the OpenAI price table. */
  reportedUsd: number;
  /** Attempts whose price is known to be zero. */
  freeAttempts: number;
  unknownAttempts: number;
  unknownBoundUsd: number;
};
/** Totals for writer calls in one group. */
export type WriterBucket = {
  calls: number;
  failed: number;
  byBilling: Record<BillingMode, number>;
  inputTokens: number;
  outputTokens: number;
  tokensUnknown: number;
  knownCostUsd: number;
  costUnknown: number;
};
/** Decision usage grouped by run. */
export type RunCost = { run: string; command: string; startedAt: string } & DecisionBucket;
/** A completed application known to the queue. */
export type Applied = { jobId: string; appliedAt: string };
/** Combined decision and writer usage for a period. */
export type CostSummary = {
  since: string;
  decisions: { byStage: Partial<Record<Stage, DecisionBucket>>; total: DecisionBucket; runs: RunCost[]; unreadable: number };
  screening: { postings: number; applied: number; neverApplied: DecisionBucket };
  applications: { started: number; completed: number; formWork: DecisionBucket; perCompletedFormUsd: number | null; perCompletedAllUsd: number | null; perCompletedFormAtMostUsd: number | null; perCompletedAllAtMostUsd: number | null };
  writer: { byTask: Partial<Record<TaskKind, WriterBucket>>; total: WriterBucket; unreadable: number };
};

const FORM_STAGES: readonly Stage[] = ["mapping", "follow_up", "verification", "memory"];

const emptyDecision = (): DecisionBucket => ({ calls: 0, retries: 0, failedAttempts: 0, refusals: 0, inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0, reportedUsd: 0, freeAttempts: 0, unknownAttempts: 0, unknownBoundUsd: 0 });
const emptyWriter = (): WriterBucket => ({ calls: 0, failed: 0, byBilling: { subscription: 0, metered: 0, free: 0, unknown: 0 }, inputTokens: 0, outputTokens: 0, tokensUnknown: 0, knownCostUsd: 0, costUnknown: 0 });

function addDecision(b: DecisionBucket, l: UsageLine): void {
  if (l.attempt === 1) b.calls++;
  else b.retries++;
  if (l.outcome !== "ok") b.failedAttempts++;
  b.refusals += l.refusals;
  if (l.usage) {
    b.inputTokens += l.usage.inputTokens;
    b.cachedTokens += l.usage.cachedTokens;
    b.cacheWriteTokens += l.usage.cacheWriteTokens;
  }
  if (l.costKind === "free") {
    b.freeAttempts++;
    return;
  }
  if (l.costUsd !== null && l.costKind === "reported") {
    b.reportedUsd += l.costUsd;
    return;
  }
  if (l.costUsd !== null) {
    b.estimatedUsd += l.costUsd;
    return;
  }
  // No usage came back, so the attempt may or may not have been billed: it is counted apart, never as zero.
  b.unknownAttempts++;
  b.unknownBoundUsd += l.boundUsd ?? 0;
}

function addWriter(b: WriterBucket, l: WriterUsageLine): void {
  b.calls++;
  if (l.outcome !== "ok") b.failed++;
  if (l.outcome === "ok" && l.billing) b.byBilling[l.billing]++;
  if (l.usage && l.usage.inputTokens !== null && l.usage.outputTokens !== null) {
    b.inputTokens += l.usage.inputTokens;
    b.outputTokens += l.usage.outputTokens;
  } else b.tokensUnknown++;
  // A subscription or free call adds nothing to a bill. Any other call costs what the writer said, or is unknown.
  if (l.billing === "subscription" || l.billing === "free") return;
  if (l.costUsd !== null) b.knownCostUsd += l.costUsd;
  else b.costUnknown++;
}

/** Summarizes recorded usage and completed applications. `since` keeps only what happened at or after it. */
export function summarizeCost(decisionLines: UsageLine[], writerLines: WriterUsageLine[], applied: Applied[], since = "", unreadable = { decisions: 0, writer: 0 }): CostSummary {
  const byStage: Partial<Record<Stage, DecisionBucket>> = {};
  const byTask: Partial<Record<TaskKind, WriterBucket>> = {};
  const total = emptyDecision();
  const neverApplied = emptyDecision();
  const formWork = emptyDecision();
  const runs = new Map<string, RunCost>();
  const appliedIds = new Set(applied.map((a) => a.jobId));
  const postings = new Set<string>();
  const started = new Set<string>();
  for (const l of decisionLines) {
    if (since && l.at < since) continue;
    addDecision((byStage[l.stage] ??= emptyDecision()), l);
    addDecision(total, l);
    const run = runs.get(l.run) ?? { run: l.run, command: l.command, startedAt: l.at, ...emptyDecision() };
    if (l.at < run.startedAt) run.startedAt = l.at;
    addDecision(run, l);
    runs.set(l.run, run);
    if (l.stage === "screening") {
      if (l.jobId) postings.add(l.jobId);
      // A rating with no job named cannot have led to an application, so it counts with the ones that did not.
      if (!l.jobId || !appliedIds.has(l.jobId)) addDecision(neverApplied, l);
    }
    if (FORM_STAGES.includes(l.stage)) {
      addDecision(formWork, l);
      if (l.jobId) started.add(l.jobId);
    }
  }
  const writerTotal = emptyWriter();
  for (const l of writerLines) {
    if (since && l.at < since) continue;
    addWriter((byTask[l.task] ??= emptyWriter()), l);
    addWriter(writerTotal, l);
  }
  const completed = applied.filter((a) => !since || a.appliedAt >= since).length;
  const known = (bucket: DecisionBucket): number => bucket.estimatedUsd + bucket.reportedUsd;
  const per = (n: number): number | null => (completed ? n / completed : null);
  return {
    since,
    decisions: { byStage, total, runs: [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)), unreadable: unreadable.decisions },
    screening: { postings: postings.size, applied: [...postings].filter((id) => appliedIds.has(id)).length, neverApplied },
    applications: {
      started: started.size,
      completed,
      formWork,
      perCompletedFormUsd: per(known(formWork)),
      perCompletedAllUsd: per(known(total)),
      perCompletedFormAtMostUsd: per(known(formWork) + formWork.unknownBoundUsd),
      perCompletedAllAtMostUsd: per(known(total) + total.unknownBoundUsd),
    },
    writer: { byTask, total: writerTotal, unreadable: unreadable.writer },
  };
}

/** Reads both usage records and the queue, and builds the summary. It calls nothing. */
export function loadCost(since = ""): CostSummary {
  const d = readUsage(PATHS.decisionsUsage);
  const w = readWriterUsage(PATHS.writerUsage);
  let applied: Applied[] = [];
  try {
    applied = loadQueue().entries.flatMap((e) => (e.status === "applied" && e.appliedAt ? [{ jobId: e.job.id, appliedAt: e.appliedAt }] : []));
  } catch {
    // A queue that cannot be read leaves the spending readable: only the per-application figures are missing.
    applied = [];
  }
  return summarizeCost(d.lines, w.lines, applied, since, { decisions: d.unreadable, writer: w.unreadable });
}

const usd = (n: number): string => `$${n.toFixed(n < 0.01 ? 5 : n < 1 ? 4 : 2)}`;
const tokens = (n: number): string => n.toLocaleString("en-US");
const knownUsd = (b: DecisionBucket): number => b.estimatedUsd + b.reportedUsd;

/** A free-only bucket is labeled free. Anything priced is an amount, with unknown kept in the "at most" clause. */
function moneyPhrase(b: DecisionBucket): string {
  const known = knownUsd(b);
  if (b.freeAttempts > 0 && known === 0 && b.unknownAttempts === 0) return "free";
  const atMost = b.unknownBoundUsd > 0 ? ` (at most ${usd(known + b.unknownBoundUsd)})` : "";
  return `about ${usd(known)}${atMost}`;
}

function decisionHeader(total: DecisionBucket): string {
  if (total.freeAttempts === 0 && total.reportedUsd === 0) {
    return `Decisions (OpenAI Decisions API, billed to OPENAI_API_KEY). Costs are estimates: reported tokens at the prices published on ${DECISIONS.pricing.verifiedOn}.`;
  }
  const parts = ["Decisions."];
  if (total.estimatedUsd > 0 || total.unknownAttempts > 0) parts.push(`OpenAI calls are estimates from reported tokens at the prices published on ${DECISIONS.pricing.verifiedOn}.`);
  if (total.freeAttempts > 0) parts.push("OpenCode Jev 1.13 Free calls are free, a known price of zero, and are not part of that estimate.");
  if (total.reportedUsd > 0) parts.push("A price the response itself named is shown as that price.");
  return parts.join(" ");
}

function decisionLines(c: CostSummary): string[] {
  if (!c.decisions.total.calls && !c.decisions.total.retries) return [];
  const lines: string[] = [];
  lines.push(decisionHeader(c.decisions.total));
  lines.push("  stage         calls  retries  failed  refused      input     cached   estimate");
  for (const stage of STAGES) {
    const bucket = c.decisions.byStage[stage];
    if (bucket) lines.push(decisionRow(stage, bucket));
  }
  lines.push(decisionRow("total", c.decisions.total));
  const unknown = c.decisions.total;
  if (unknown.unknownAttempts) lines.push(`  Unknown: ${unknown.unknownAttempts} attempts reported no tokens and may have been billed: at most ${usd(unknown.unknownBoundUsd)} more.`);
  return lines;
}

function decisionRow(stage: string, b: DecisionBucket): string {
  const price = b.freeAttempts > 0 && knownUsd(b) === 0 && b.unknownAttempts === 0 ? "free" : usd(knownUsd(b));
  return `  ${stage.padEnd(13)} ${String(b.calls).padStart(5)} ${String(b.retries).padStart(8)} ${String(b.failedAttempts).padStart(7)} ${String(b.refusals).padStart(8)} ${tokens(b.inputTokens).padStart(10)} ${tokens(b.cachedTokens).padStart(10)} ${price}`;
}

function screeningLine(c: CostSummary): string[] {
  if (!c.screening.postings) return [];
  const neverApplied = c.screening.neverApplied;
  return [`Screening: ${c.screening.postings} postings rated, ${c.screening.applied} applied to. Rating the ${c.screening.postings - c.screening.applied} never applied to: ${moneyPhrase(neverApplied)}.`];
}

function applicationLines(c: CostSummary): string[] {
  if (!c.applications.started && !c.applications.completed) return [];
  const a = c.applications;
  if (a.completed === 0) return [`Applications: ${a.completed} completed, ${a.started} started.`, "  no completed application in this period, so there is no per-application figure"];
  const formAtMost = a.perCompletedFormAtMostUsd !== a.perCompletedFormUsd ? ` (at most ${usd(a.perCompletedFormAtMostUsd!)})` : "";
  const allAtMost = a.perCompletedAllAtMostUsd !== a.perCompletedAllUsd ? ` (at most ${usd(a.perCompletedAllAtMostUsd!)})` : "";
  return [
    `Applications: ${a.completed} completed, ${a.started} started.`,
    `  Form work (mapping, follow-up, verification, memory): ${moneyPhrase(a.formWork)}, or ${usd(a.perCompletedFormUsd!)} per completed application${formAtMost}.`,
    `  Everything (screening and inbox included): ${moneyPhrase(c.decisions.total)}, or ${usd(a.perCompletedAllUsd!)} per completed application${allAtMost}.`,
  ];
}

function runLines(c: CostSummary): string[] {
  if (!c.decisions.runs.length) return [];
  const lines = ["Runs (newest first):"];
  for (const run of c.decisions.runs.slice(0, COST.runsListed)) {
    lines.push(`  ${run.startedAt.slice(0, 16).replace("T", " ")}  ${run.command.padEnd(10)} ${run.calls} calls  ${run.retries} retries  ${run.failedAttempts} failed  ${moneyPhrase(run)}`);
  }
  const remaining = c.decisions.runs.length - COST.runsListed;
  if (remaining > 0) lines.push(`  and ${remaining} earlier runs`);
  return lines;
}

function writerLines(c: CostSummary): string[] {
  if (!c.writer.total.calls) return [];
  const lines = ["Writer (your configured command). This tool has no price list for it: figures are what the writer reported.", "  task                 calls  failed  subscription  free  metered  unknown   tokens in / out"];
  for (const task of TASK_KINDS) {
    const b = c.writer.byTask[task];
    if (b) lines.push(`  ${task.padEnd(20)} ${String(b.calls).padStart(5)} ${String(b.failed).padStart(7)} ${String(b.byBilling.subscription).padStart(13)} ${String(b.byBilling.free).padStart(5)} ${String(b.byBilling.metered).padStart(8)} ${String(b.byBilling.unknown).padStart(8)}   ${tokens(b.inputTokens)} / ${tokens(b.outputTokens)}`);
  }
  const parts: string[] = [];
  if (c.writer.total.knownCostUsd) parts.push(`Metered cost reported: ${usd(c.writer.total.knownCostUsd)}.`);
  if (c.writer.total.costUnknown) parts.push(`Cost unknown for ${c.writer.total.costUnknown} call(s).`);
  if (c.writer.total.tokensUnknown) parts.push(`${c.writer.total.tokensUnknown} call(s) reported no tokens.`);
  if (parts.length) lines.push(`  ${parts.join(" ")}`);
  return lines;
}

function unreadableLines(c: CostSummary): string[] {
  const lines: string[] = [];
  if (c.decisions.unreadable) lines.push(`${c.decisions.unreadable} line(s) in decisions usage are not in the current format and are not counted.`);
  if (c.writer.unreadable) lines.push(`${c.writer.unreadable} line(s) in writer usage are not in the current format and are not counted.`);
  return lines;
}

/** Formats a cost summary as a plain text report. */
export function formatCost(c: CostSummary, budget?: { limitUsd: number; spentUsd: number } | null): string {
  const decisions = decisionLines(c);
  const writer = writerLines(c);
  if (!decisions.length && !writer.length) return ["No calls recorded yet.", ...unreadableLines(c)].join("\n");
  const lines = [...decisions, ...screeningLine(c), ...applicationLines(c), ...runLines(c)];
  if (budget) lines.push(`Budget: about ${usd(budget.spentUsd)} of ${usd(budget.limitUsd)} used (every recorded decision call, unknown counted at its bound).`);
  // The writer is kept apart from the decisions on purpose: one is known API spending, the other is whatever plan the writer runs on.
  if (writer.length) lines.push("", ...writer);
  lines.push(...unreadableLines(c));
  return lines.join("\n");
}
