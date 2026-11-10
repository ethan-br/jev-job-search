/**
 * What the person configures, read from the environment and checked before anything runs.
 *
 * Precedence, highest first: a command-line flag, the process environment, the `.env` file at the
 * top of the project (loaded by `loadEnv`, which never overrides a name the environment already
 * has), then the defaults in `src/config.ts`.
 *
 * Two groups that never mix:
 *   decisions  DECISIONS_BACKEND, and the key for that backend only. `openai` (the default) reads
 *              OPENAI_API_KEY. `opencode` reads OPENCODE_API_KEY. Spend limits are
 *              DECISIONS_RUN_CAP_USD and DECISIONS_BUDGET_USD. A decision key is never handed to
 *              the writer, and one backend's key is never sent to the other backend.
 *   writer     WRITER_COMMAND, WRITER_ENV, WRITER_BILLING. A program the person chose, with its
 *              own sign-in. This tool holds no credential for it.
 *
 * A setting that is wrong is an error with its name in it. Nothing falls back to a default
 * silently, and no name from an earlier version is read.
 */
import { ACCOUNTS, CHILD_ENV, DECISIONS, findExecutable } from "./config.js";
import { hashOf } from "./util/cache.js";

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

type Env = NodeJS.ProcessEnv;
const read = (env: Env, name: string): string => (env[name] ?? "").trim();

function usd(env: Env, name: string): number | null {
  const raw = read(env, name);
  if (!raw) return null;
  const n = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(n)) throw new SettingsError(`${name} must be an amount in US dollars, like 0.50. It is "${raw}".`);
  return n;
}

export const DECISION_BACKENDS = ["openai", "opencode"] as const;
export type DecisionBackend = (typeof DECISION_BACKENDS)[number];

export type DecisionLimits = {
  /** The most one command may spend on decisions. */
  runCapUsd: number;
  /** The most all recorded decision calls together may cost, or null when the person set no budget. */
  budgetUsd: number | null;
};

export type DecisionSettings = DecisionLimits & {
  backend: DecisionBackend;
  /** The key for `backend` only. The other backend's key is not read into this object. */
  apiKey: string;
};

/** The spend limits alone, for a command that only reports. */
export function decisionLimits(env: Env = process.env): DecisionLimits {
  const runCap = usd(env, "DECISIONS_RUN_CAP_USD");
  const budgetUsd = usd(env, "DECISIONS_BUDGET_USD");
  if (runCap !== null && runCap === 0) throw new SettingsError("DECISIONS_RUN_CAP_USD is 0, which stops every decision call. Remove it, or set an amount.");
  if (runCap !== null && budgetUsd !== null && runCap > budgetUsd) throw new SettingsError(`DECISIONS_RUN_CAP_USD (${runCap}) is more than DECISIONS_BUDGET_USD (${budgetUsd}): one command could spend more than the whole budget. Lower the first or raise the second.`);
  return { runCapUsd: runCap ?? DECISIONS.runSpendCapUsd, budgetUsd };
}

/** Which decision backend the person named. Unset means OpenAI, so an existing environment keeps its behavior. */
export function decisionBackend(env: Env = process.env): DecisionBackend {
  const raw = read(env, "DECISIONS_BACKEND");
  if (!raw || raw === "openai") return "openai";
  if (raw === "opencode") return "opencode";
  throw new SettingsError(`DECISIONS_BACKEND must be openai or opencode. It is "${raw}". The choice is explicit, and there is no fallback.`);
}

function requireKey(env: Env, name: string): string {
  const apiKey = read(env, name);
  if (!apiKey) throw new SettingsError(`${name} is not set. Copy .env.example to .env and put your key after ${name}= in that file. Do not paste the key into a chat.`);
  if (/\s/.test(apiKey)) throw new SettingsError(`${name} has a space or a line break in it. It must be the key alone.`);
  return apiKey;
}

/** OpenAI's key and the spend limits. This does not read DECISIONS_BACKEND or OPENCODE_API_KEY. */
export function openAiSettings(env: Env = process.env): DecisionLimits & { apiKey: string } {
  return { apiKey: requireKey(env, "OPENAI_API_KEY"), ...decisionLimits(env) };
}

export function decisionSettings(env: Env = process.env): DecisionSettings {
  const backend = decisionBackend(env);
  if (backend === "opencode") return { backend, apiKey: requireKey(env, "OPENCODE_API_KEY"), ...decisionLimits(env) };
  return { backend, ...openAiSettings(env) };
}

/** How a writer's work is paid for, as the writer itself reports it. */
export const BILLING_MODES = ["subscription", "metered", "free", "unknown"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export type WriterSettings = {
  /** The program and its arguments, exactly as they are passed: no shell reads them. */
  command: string[];
  /** Names of environment variables handed to the writer on top of the allow-list. */
  passEnv: string[];
  /** The ways of paying the person accepts. A reply that reports another is refused. */
  billing: BillingMode[];
  /** Changes whenever the command does, so nothing written by one writer is reused as another's. */
  identity: string;
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function writerSettings(env: Env = process.env): WriterSettings {
  const raw = read(env, "WRITER_COMMAND");
  if (!raw) throw new SettingsError('WRITER_COMMAND is not set. It names the program that writes, as a JSON array: WRITER_COMMAND=["node","examples/writers/codex-exec.mjs"]. See docs/WRITER.md.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SettingsError('WRITER_COMMAND must be a JSON array of strings, like ["node","examples/writers/codex-exec.mjs"]. A plain command line is not accepted, because no shell is used to split it.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p) => typeof p === "string") || !(parsed[0] as string).trim()) {
    throw new SettingsError("WRITER_COMMAND must be a JSON array with the program first and every item a string.");
  }
  const command = parsed as string[];

  const passEnv = read(env, "WRITER_ENV").split(",").map((n) => n.trim()).filter(Boolean);
  for (const name of passEnv) {
    if (!ENV_NAME.test(name)) throw new SettingsError(`WRITER_ENV lists "${name}", which is not the name of an environment variable.`);
    if (name === "OPENAI_API_KEY") throw new SettingsError("WRITER_ENV lists OPENAI_API_KEY. That key pays for decisions only and is never handed to the writer. Remove it from WRITER_ENV.");
    if (name === "OPENCODE_API_KEY") throw new SettingsError("WRITER_ENV lists OPENCODE_API_KEY. That key is for the OpenCode decision backend only and is never handed to the writer. Remove it from WRITER_ENV.");
    if (name.startsWith(ACCOUNTS.envPrefix)) throw new SettingsError(`WRITER_ENV lists ${name}, one of this tool's own secrets. The writer has no use for it. Remove it from WRITER_ENV.`);
  }

  const billingRaw = read(env, "WRITER_BILLING");
  const billing = (billingRaw ? billingRaw.split(",").map((b) => b.trim()).filter(Boolean) : ["subscription", "free"]) as BillingMode[];
  const wrong = billing.find((b) => !(BILLING_MODES as readonly string[]).includes(b));
  if (wrong || billing.length === 0) throw new SettingsError(`WRITER_BILLING must list one or more of ${BILLING_MODES.join(", ")}, separated by commas. It is "${billingRaw}".`);

  return { command, passEnv, billing, identity: hashOf({ command, passEnv: [...passEnv].sort() }) };
}

/** Where the writer's program is on this machine, or null when it cannot be found. */
export const writerExecutable = (s: WriterSettings, env: Env = process.env): string | null => findExecutable(s.command[0] as string, env);

/** The environment variables the writer will be given, by name: the allow-list plus what WRITER_ENV adds. */
export const writerEnvNames = (s: WriterSettings): string[] => [...CHILD_ENV.allow, ...s.passEnv];

/** Every problem with the settings at once, for `doctor`. Empty when they are all usable. */
export function settingsProblems(env: Env = process.env): { decisions: string | null; writer: string | null } {
  const problem = (fn: () => unknown): string | null => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  return { decisions: problem(() => decisionSettings(env)), writer: problem(() => writerSettings(env)) };
}
