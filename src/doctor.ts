/**
 * `doctor`: checks everything a run needs and names the one thing to do next.
 * Run it after every step of setting up, so a person never has to work out what is missing.
 *
 * By default it is offline and free: it reads settings and files and looks for programs, and
 * starts no model. `--probe-decisions` makes one small paid Decisions call, and `--probe-writer`
 * asks the configured writer for one short reply. Each happens only when its flag is given.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { chromePath, DECISIONS, DOCTOR, GMAIL, PATHS, ROOT } from "./config.js";
import { decisionSettings, writerExecutable, writerSettings } from "./settings.js";
import { probeWriter, WriterError } from "./writer/index.js";
import { createDecider } from "./decisions/openai.js";
import { chargedUsd, predicate } from "./decisions/types.js";
import { openerFor, notifierFor } from "./util/platform.js";
import { loadAccounts } from "./accounts/config.js";
import { defaultStore, type SecretStore } from "./accounts/secrets.js";
import { loadGmail } from "./mail/gmail.js";
import { loadQueue } from "./jobs/queue.js";
import { loadProfile, type Profile } from "./profile/schema.js";

export type Check = {
  name: string;
  ok: boolean;
  /** What was found. */
  detail: string;
  /** What to do when it is not ok. */
  fix: string;
  /** An optional check never blocks a run. */
  optional?: boolean;
};

const rel = (file: string) => path.relative(ROOT, file) || file;

export function checkNode(version = process.versions.node): Check {
  const major = Number(version.split(".")[0]);
  return { name: "Node.js", ok: major >= DOCTOR.minNodeMajor, detail: `version ${version}`, fix: `Install Node.js ${DOCTOR.minNodeMajor} or newer from https://nodejs.org` };
}

export function checkChrome(file: string | null = chromePath()): Check {
  const ok = file !== null && existsSync(file);
  return { name: "Google Chrome", ok, detail: ok ? file : "not found", fix: "Install Google Chrome (https://www.google.com/chrome) or Chromium, or set CHROME_PATH in .env to the browser's full path" };
}

export function checkDecisionSettings(env = process.env): Check {
  try {
    const settings = decisionSettings(env);
    const budget = settings.budgetUsd === null ? "" : `, $${settings.budgetUsd.toFixed(2)} in all`;
    return { name: "Decisions key", ok: true, detail: `OPENAI_API_KEY is set; ${DECISIONS.model}; at most $${settings.runCapUsd.toFixed(2)} per command${budget}`, fix: "" };
  } catch (err) {
    return { name: "Decisions key", ok: false, detail: err instanceof Error ? err.message : String(err), fix: "Copy .env.example to .env and put your OpenAI API key after OPENAI_API_KEY=. Do not paste the key into a chat." };
  }
}

export function checkWriterSettings(env = process.env): Check {
  const fix = 'Set WRITER_COMMAND in .env to a JSON array, for example ["node","examples/writers/codex-exec.mjs"]. docs/WRITER.md lists what a writer must do.';
  try {
    const settings = writerSettings(env);
    const program = writerExecutable(settings, env);
    if (!program) return { name: "Writer", ok: false, detail: `"${settings.command[0]}" was not found`, fix };
    return { name: "Writer", ok: true, detail: `${program} (accepts ${settings.billing.join(", ")})`, fix: "" };
  } catch (err) {
    return { name: "Writer", ok: false, detail: err instanceof Error ? err.message : String(err), fix };
  }
}

export function checkPlatform(platform = process.platform, env = process.env): Check[] {
  const linuxOpenFix = "Install xdg-utils so reports and documents can be opened for you. Without it, open the printed path yourself.";
  const mac = platform === "darwin";
  const linuxNotifyFix = "Install libnotify-bin (notify-send) to be told when a form waits on you.";
  return [
    { name: "Opening files", ok: openerFor("https://example.com", platform, env) !== null, optional: true, detail: openerFor("https://example.com", platform, env) ? "available" : "not available", fix: platform === "linux" ? linuxOpenFix : "Open the printed path yourself." },
    { name: "Notifications", ok: notifierFor("a", "b", platform, env) !== null, optional: true, detail: notifierFor("a", "b", platform, env) ? "available" : "not available", fix: platform === "linux" ? linuxNotifyFix : "Notifications are unavailable on this system." },
    // These two are how the system is, not something to fix, so they never show as a step still to do.
    { name: "Password store", ok: true, optional: true, detail: mac ? "the macOS Keychain" : `no system keychain is used on ${platform}: a password for employer accounts goes in .env as JOB_SEARCH_ACCOUNTS_PASSWORD (docs/ACCOUNTS.md)`, fix: "" },
    { name: "Scheduled runs", ok: true, optional: true, detail: mac ? "`npx job-search schedule install` (a macOS LaunchAgent)" : `not built in on ${platform}: run \`npx job-search daily\` from cron or a systemd timer (docs/PLATFORMS.md)`, fix: "" },
  ];
}

export function checkProfile(file: string = PATHS.profile): { check: Check; profile: Profile | null } {
  if (!existsSync(file)) return { profile: null, check: { name: "Your profile", ok: false, detail: `${rel(file)} does not exist yet`, fix: "Run setup, or copy data/profile.example.json to data/profile.json and fill it in" } };
  try {
    const profile = loadProfile(file);
    return { profile, check: { name: "Your profile", ok: true, detail: `${profile.name.first} ${profile.name.last}, ${profile.facts.length} facts, ${profile.answers.length} standing answers`, fix: "" } };
  } catch (err) {
    return { profile: null, check: { name: "Your profile", ok: false, detail: (err instanceof Error ? err.message : String(err)).slice(0, 600), fix: `Correct the fields named above in ${rel(file)}` } };
  }
}

export function checkResume(profile: Profile | null): Check {
  const fix = "Put your resume PDF at documents/resume.pdf and set resume.path in data/profile.json to its full path";
  if (!profile) return { name: "Your resume", ok: false, detail: "needs the profile first", fix };
  const file = profile.resume.path;
  if (!existsSync(file)) return { name: "Your resume", ok: false, detail: `no file at ${file}`, fix };
  const size = statSync(file).size;
  const ok = /\.pdf$/i.test(file) && size > 0 && size <= DOCTOR.maxResumeBytes;
  return { name: "Your resume", ok, detail: `${path.basename(file)}, ${(size / 1024).toFixed(0)} KB`, fix: `The resume must be a PDF of at most ${DOCTOR.maxResumeBytes / 1_000_000} MB. ${fix}` };
}

export function checkOwnWords(): Check[] {
  const voice = existsSync(path.join(PATHS.data, "voice.local.md"));
  const bank = existsSync(PATHS.bank);
  return [
    { name: "Your voice guide", ok: voice, optional: true, detail: voice ? "data/voice.local.md" : "using the shipped data/voice.md", fix: "Copy data/voice.md to data/voice.local.md and edit it until a sample answer sounds like you" },
    { name: "Your drafts", ok: bank, optional: true, detail: bank ? "data/bank.json" : "using the example drafts, which are about a made-up person", fix: "Copy data/bank.example.json to data/bank.json and rewrite each draft with your own facts" },
  ];
}

export function checkQueue(): Check {
  const fix = "Run `npx job-search discover` to find jobs";
  if (!existsSync(PATHS.queue)) return { name: "Job queue", ok: false, optional: true, detail: "no jobs found yet", fix };
  const q = loadQueue();
  const queued = q.entries.filter((e) => e.status === "queued").length;
  const ageHours = (Date.now() - new Date(q.generatedAt).getTime()) / 3_600_000;
  const fresh = ageHours <= DOCTOR.staleQueueHours;
  return { name: "Job queue", ok: queued > 0 && fresh, optional: true, detail: `${queued} jobs queued, last refreshed ${ageHours < 1 ? "under an hour" : `${Math.round(ageHours)} hours`} ago`, fix };
}

/**
 * Job-board accounts are optional. When the person set some up, this says whether what a sign-in
 * needs is there: the password in the Keychain, and Gmail when they let the tool read verification mail.
 */
export function checkAccounts(store: SecretStore = defaultStore(), files: { accounts?: string; gmail?: string } = {}): Check {
  const name = "Job-board accounts";
  let file;
  try {
    file = loadAccounts(files.accounts);
  } catch (err) {
    return { name, ok: false, optional: true, detail: (err instanceof Error ? err.message : String(err)).slice(0, 200), fix: "Correct data/accounts.json, or set it up again with npx job-search accounts" };
  }
  const rule = file.providers.workday;
  if (!rule && !file.accounts.length) return { name, ok: true, optional: true, detail: "not set up, so jobs on Workday are skipped (optional: npx job-search accounts)", fix: "" };
  if (!file.enabled) return { name, ok: true, optional: true, detail: "set up, and switched off (npx job-search accounts on)", fix: "" };
  const wantsMail = !!rule?.emailVerification || file.accounts.some((a) => a.emailVerification);
  const mail = !!loadGmail(files.gmail) && !!store.get(GMAIL.refreshTokenItem);
  const how = rule?.mode === "create_if_missing" ? `sign in, or make an account (at most ${rule.maxNewAccountsPerDay} new a day)` : "sign in to the employers you listed";
  const verify = !wantsMail ? "" : mail ? ", verification emails read from Gmail" : ", you click each verification link (Gmail is not connected)";
  return { name, ok: true, optional: true, detail: `Workday: ${how}, ${file.accounts.filter((a) => a.mode !== "off").length} employer account(s)${verify}`, fix: "" };
}

export async function checkDecisionsOnline(): Promise<Check> {
  const fix = "Check the key and its credit at https://platform.openai.com";
  try {
    const decider = createDecider();
    await decider.decide({ evidence: { text: "The sky is blue." } }, { ok: predicate("Does the text mention a colour?") }, { stage: "probe" });
    return { name: "Decisions answer", ok: true, detail: `one test call, about $${chargedUsd(decider.usage).toFixed(6)}`, fix: "" };
  } catch (err) {
    return { name: "Decisions answer", ok: false, detail: (err instanceof Error ? err.message : String(err)).slice(0, 300), fix };
  }
}

export async function checkWriterOnline(): Promise<Check> {
  const fix = "Run the writer's own sign-in, then try again. docs/WRITER.md has the steps for the wrapper you use.";
  try {
    const result = await probeWriter();
    const model = result.writer.model ? ` (${result.writer.model})` : "";
    const tokens = result.usage ? `, ${result.usage.inputTokens} tokens in and ${result.usage.outputTokens} out` : "";
    return { name: "Writer answers", ok: true, detail: `${result.writer.name}${model}, billed as ${result.billing}${tokens}`, fix: "" };
  } catch (err) {
    const detail = err instanceof WriterError ? `${err.kind}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return { name: "Writer answers", ok: false, detail: detail.slice(0, 300), fix };
  }
}

export type DoctorOptions = { decisions?: boolean; writer?: boolean };

export async function runChecks(opts: DoctorOptions = {}): Promise<Check[]> {
  const { check: profileCheck, profile } = checkProfile();
  const key = checkDecisionSettings();
  const writer = checkWriterSettings();
  const checks = [checkNode(), checkChrome(), key, writer, profileCheck, checkResume(profile), ...checkOwnWords(), checkQueue(), checkAccounts(), ...checkPlatform()];
  if (opts.decisions && key.ok) checks.push(await checkDecisionsOnline());
  if (opts.writer && writer.ok) checks.push(await checkWriterOnline());
  return checks;
}

/** The first thing that blocks a run, or, when nothing does, the first optional improvement. */
export function nextStep(checks: Check[]): string {
  const blocking = checks.find((c) => !c.ok && !c.optional);
  if (blocking) return blocking.fix;
  const optional = checks.find((c) => !c.ok && c.optional);
  if (optional) return optional.fix;
  return "Everything is in place. Rehearse with `npx job-search apply --dry --count 3`, then apply.";
}

export const isReadyToRun = (checks: Check[]) => checks.every((c) => c.ok || c.optional);

export function formatChecks(checks: Check[]): string {
  const mark = (c: Check) => (c.ok ? "ok      " : c.optional ? "optional" : "MISSING ");
  const lines = checks.map((c) => `${mark(c)}  ${c.name.padEnd(20)} ${c.detail}`);
  return [...lines, "", `Next step: ${nextStep(checks)}`].join("\n");
}
