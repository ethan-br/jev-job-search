#!/usr/bin/env node
// A writer for job-search that asks the Codex CLI, headless, signed in with a ChatGPT plan.
//
// Configure it in .env:
//   WRITER_COMMAND=["node","examples/writers/codex-exec.mjs"]
//   WRITER_COMMAND=["node","examples/writers/codex-exec.mjs","--model","<name>"]
// It needs the Codex CLI on PATH (or --codex <path>) and `codex login` done once with a ChatGPT plan.
//
// It speaks the job-search.writer/v1 contract: one JSON request on standard input, one JSON response
// on standard output, diagnostics on standard error, and a non-zero exit on any failure.
//
// Billing. `codex login status` is read before every call, and the model is only called when it
// says the sign-in is a ChatGPT plan. The response then says "subscription". An API-key sign-in
// would be charged per token, so it is refused (exit 4) unless --allow-metered is given, and then
// the response says "metered", which job-search itself refuses unless WRITER_BILLING lists it.
// OPENAI_API_KEY and CODEX_API_KEY are taken out of the environment Codex is started with, unless
// --allow-metered is given, so a key in the environment cannot change who pays.
//
// What Codex may do. It runs in a read-only sandbox, in an empty temporary folder, without your
// Codex config, rules, MCP servers, web search, apps, plugins, browser or image tools. Codex has no
// mode with every tool switched off: the model could still run a command that only reads.
//
// What it cannot report. Codex does not say which model its default is, so `model` is null unless
// --model names one. It reports tokens but no cost, so `costUsd` is always null.
//
// Tested with codex-cli 0.167.0 on Linux.
//
// Exit codes: 2 bad arguments or request, 3 Codex not found, 4 sign-in not accepted,
// 5 Codex failed, 6 Codex answered with something that is not JSON, 143 stopped by a signal.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CONTRACT = "job-search.writer/v1";
/** How long `codex --version` and `codex login status` get. Neither calls a model. */
const QUICK_MS = 15_000;
/** How long Codex gets to end after it is asked to, before it is ended by force. */
const GRACE_MS = 1_500;
/** Everything switched off that a writing task has no use for. */
const DISABLED = ["shell_tool", "apps", "plugins", "image_generation", "view_image", "browser_use", "browser_use_external", "computer_use", "in_app_browser", "skill_search", "tool_suggest", "sleep_tool", "goals", "hooks", "memories"];

class Failure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArgs(args) {
  const options = { codex: "codex", model: null, allowMetered: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--allow-metered") options.allowMetered = true;
    else if ((arg === "--codex" || arg === "--model") && args[i + 1]) options[arg.slice(2)] = args[++i];
    else throw new Failure(2, `unknown or incomplete argument: ${arg}`);
  }
  return options;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** The request, checked only as far as this wrapper uses it. job-search checks the whole contract on its side. */
function readRequest(text) {
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    throw new Failure(2, "standard input is not JSON");
  }
  const ok = request && request.contract === CONTRACT && typeof request.system === "string" && typeof request.input === "string" && request.output && typeof request.output.schema === "object" && request.settings && typeof request.settings.effort === "string";
  if (!ok) throw new Failure(2, `standard input is not a ${CONTRACT} request`);
  return request;
}

/** The environment Codex is started with. A key in it could move the call from the plan to per-token billing. */
function codexEnv(allowMetered) {
  const env = { ...process.env };
  if (!allowMetered) {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  }
  return env;
}

/** The Codex process running now, so a signal can stop it. */
let running = null;
let stoppedBy = null;

function stop(signal) {
  stoppedBy = signal;
  if (!running) return;
  const child = running;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), GRACE_MS).unref();
}

/** Runs Codex with these arguments. Resolves with its exit code and what it printed. Never rejects. */
function run(program, args, env, { input = null, timeoutMs = null, onLine = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(program, args, { env, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    } catch (err) {
      resolve({ code: null, out: "", err: String(err?.message ?? err), missing: true });
      return;
    }
    running = child;
    let out = "";
    let err = "";
    let pending = "";
    const timer = timeoutMs === null ? null : setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (!onLine) {
        out += chunk;
        return;
      }
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    // Only the end of what Codex says is kept: it is for a person reading an error.
    child.stderr.on("data", (chunk) => (err = (err + chunk).slice(-4000)));
    const done = (result) => {
      if (timer) clearTimeout(timer);
      if (running === child) running = null;
      resolve(result);
    };
    child.on("error", (e) => done({ code: null, out, err: String(e.message), missing: e.code === "ENOENT" }));
    child.on("close", (code) => {
      if (onLine && pending) onLine(pending);
      done({ code, out, err, missing: false });
    });
    if (input !== null) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

/** Who pays, from what `codex login status` prints. Anything this does not recognise is "unknown". */
function billingOf(status) {
  if (/chatgpt/i.test(status)) return "subscription";
  if (/api key/i.test(status)) return "metered";
  return "unknown";
}

function codexArgs(request, options, files, cwd) {
  const args = [
    "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config",
    "--sandbox", "read-only", "--color", "never", "--json",
    "--output-schema", files.schema, "-o", files.last, "-C", cwd,
    "-c", `model_reasoning_effort=${JSON.stringify(request.settings.effort)}`,
    "-c", 'web_search="disabled"',
  ];
  for (const feature of DISABLED) args.push("--disable", feature);
  if (options.model) args.push("-m", options.model);
  // The prompt comes on standard input, so nothing in it is ever an argument.
  args.push("-");
  return args;
}

function promptOf(request) {
  return [
    "<instructions>",
    request.system,
    "</instructions>",
    "",
    "<input>",
    request.input,
    "</input>",
    "",
    "Reply with one JSON value that fits the output schema you were given, and nothing else.",
    "Do not run commands, do not read or write files, do not browse: everything you need is above.",
  ].join("\n");
}

const count = (n) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const request = readRequest(await readStdin());
  const env = codexEnv(options.allowMetered);

  const versionRun = await run(options.codex, ["--version"], env, { timeoutMs: QUICK_MS });
  if (versionRun.code !== 0) {
    throw new Failure(3, `the Codex CLI did not run (${options.codex}). Install it with: npm install -g @openai/codex, then sign in with: codex login`);
  }
  const version = versionRun.out.trim().replace(/^codex-cli\s+/, "") || null;

  const loginRun = await run(options.codex, ["login", "status"], env, { timeoutMs: QUICK_MS });
  const status = `${loginRun.out}\n${loginRun.err}`.trim().split("\n")[0] ?? "";
  // With --allow-metered a key left in the environment may be what Codex uses, so the call is reported as metered.
  const keyInEnv = options.allowMetered && (!!env.CODEX_API_KEY || !!env.OPENAI_API_KEY);
  const billing = loginRun.code === 0 && !keyInEnv ? billingOf(status) : keyInEnv ? "metered" : "unknown";
  if (billing !== "subscription" && !options.allowMetered) {
    throw new Failure(4, `Codex is not signed in with a ChatGPT plan (it says: ${status || "nothing"}). Nothing was sent to a model. Sign in with: codex login. To use a sign-in that is charged per token, pass --allow-metered and list metered in WRITER_BILLING.`);
  }
  if (stoppedBy) throw new Failure(143, `stopped by ${stoppedBy}`);

  const dir = mkdtempSync(path.join(os.tmpdir(), "job-search-codex-"));
  try {
    const files = { schema: path.join(dir, "schema.json"), last: path.join(dir, "last.json") };
    writeFileSync(files.schema, JSON.stringify(request.output.schema));
    let usage = null;
    let problem = null;
    const onLine = (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type === "turn.completed" && event.usage) usage = event.usage;
      if (event?.type === "error" || event?.type === "turn.failed") problem = String(event.message ?? event.error?.message ?? "no reason given");
    };
    const result = await run(options.codex, codexArgs(request, options, files, dir), env, { input: promptOf(request), onLine });
    if (stoppedBy) throw new Failure(143, `stopped by ${stoppedBy}`);
    let last = "";
    try {
      last = readFileSync(files.last, "utf8").trim();
    } catch {
      last = "";
    }
    if (result.code !== 0 || problem || !last) {
      const why = problem ?? (result.code !== 0 ? `exit code ${result.code}` : "it gave no final message");
      throw new Failure(5, `Codex failed: ${why}${result.err.trim() ? `\n${result.err.trim().slice(-1500)}` : ""}`);
    }
    let output;
    try {
      output = JSON.parse(last);
    } catch {
      throw new Failure(6, "Codex's final message is not JSON");
    }
    return {
      contract: CONTRACT,
      output,
      writer: { name: "codex-exec", version, model: options.model },
      billing,
      usage: usage ? { inputTokens: count(usage.input_tokens), cachedInputTokens: count(usage.cached_input_tokens), outputTokens: count(usage.output_tokens) } : null,
      // Codex reports no cost. On a plan there is none per call; on a key it is not known here.
      costUsd: null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

try {
  const response = await main();
  process.stdout.write(`${JSON.stringify(response)}\n`, () => process.exit(0));
} catch (err) {
  const code = err instanceof Failure ? err.code : 1;
  process.stderr.write(`codex-exec: ${err?.message ?? err}\n`, () => process.exit(code));
}
