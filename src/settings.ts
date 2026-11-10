/**
 * What the person configures, read from the environment and checked before anything runs.
 *
 * Precedence, highest first: a command-line flag, the process environment, the `.env` file at the
 * top of the project (loaded by `loadEnv`, which never overrides a name the environment already
 * has), then the defaults in `src/config.ts`.
 *
 * Two groups that never mix:
 *   decisions  OPENAI_API_KEY, DECISIONS_RUN_CAP_USD, DECISIONS_BUDGET_USD. The key pays for
 *              decision calls and nothing else. It is never handed to the writer.
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

export type DecisionSettings = {
  apiKey: string;
  /** The most one command may spend on decisions. */
  runCapUsd: number;
  /** The most all recorded decision calls together may cost, or null when the person set no budget. */
  budgetUsd: number | null;
};

/** The spend limits alone, for a command that only reports. */
export function decisionLimits(env: Env = process.env): Omit<DecisionSettings, "apiKey"> {
  const runCap = usd(env, "DECISIONS_RUN_CAP_USD");
  const budgetUsd = usd(env, "DECISIONS_BUDGET_USD");
  if (runCap !== null && runCap === 0) throw new SettingsError("DECISIONS_RUN_CAP_USD is 0, which stops every decision call. Remove it, or set an amount.");
  if (runCap !== null && budgetUsd !== null && runCap > budgetUsd) throw new SettingsError(`DECISIONS_RUN_CAP_USD (${runCap}) is more than DECISIONS_BUDGET_USD (${budgetUsd}): one command could spend more than the whole budget. Lower the first or raise the second.`);
  return { runCapUsd: runCap ?? DECISIONS.runSpendCapUsd, budgetUsd };
}

export function decisionSettings(env: Env = process.env): DecisionSettings {
  const apiKey = read(env, "OPENAI_API_KEY");
  if (!apiKey) throw new SettingsError("OPENAI_API_KEY is not set. Copy .env.example to .env and put your key after OPENAI_API_KEY= in that file. Do not paste the key into a chat.");
  if (/\s/.test(apiKey)) throw new SettingsError("OPENAI_API_KEY has a space or a line break in it. It must be the key alone.");
  return { apiKey, ...decisionLimits(env) };
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
