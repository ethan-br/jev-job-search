/**
 * The external-command adapter: starts the program the person configured as the writer, hands it
 * one request on standard input, and takes one response from standard output.
 *
 * The program is started from an argument array, never through a shell, so nothing in the
 * settings or in a request is ever read as shell syntax. It gets an allow-listed environment and
 * only the extra names the person listed, never this tool's own keys. Its output is bounded, it
 * has a time limit, and it can be cancelled. When it is stopped, everything it started is stopped
 * with it, and a call does not return while the writer may still be running.
 *
 * Nothing here knows what the program is. A harness, a script and a test double look the same.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { ACCOUNTS, childEnv, PATHS, WRITER } from "../config.js";
import { writerExecutable, type WriterSettings } from "../settings.js";
import { scrub } from "../util/redact.js";
import { WriterError, WriterRequest, WriterResponse } from "./contract.js";

export type RunOptions = { signal?: AbortSignal };

/** The environment the writer is given: the allow-list, plus the names the person listed in WRITER_ENV. */
export function writerEnv(settings: WriterSettings, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const extra: Record<string, string> = {};
  for (const name of settings.passEnv) {
    // The settings already refuse these two. This is the second lock on the same door.
    if (name === "OPENAI_API_KEY" || name.startsWith(ACCOUNTS.envPrefix)) continue;
    const value = env[name];
    if (value !== undefined) extra[name] = value;
  }
  return childEnv(extra);
}

/** Writers that are running now. None of them may outlive this process. */
const live = new Set<ChildProcess>();
let watchingExit = false;

/** Signals the writer and everything it started. On POSIX that is its process group, which `detached` gave it. */
function signalTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    if (process.platform === "win32" || child.pid === undefined) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
}

function track(child: ChildProcess): void {
  live.add(child);
  if (watchingExit) return;
  watchingExit = true;
  process.on("exit", () => {
    for (const running of live) signalTree(running, "SIGKILL");
  });
}

/** The response in what the writer printed. Exactly one JSON value in the contract, or an error that never quotes the output. */
function readResponse(stdout: Buffer): WriterResponse {
  let value: unknown;
  try {
    value = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw new WriterError("malformed", `the writer printed ${stdout.length} bytes that are not one JSON value`);
  }
  const parsed = WriterResponse.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "(top level)"}: ${issue.message}`);
  throw new WriterError("malformed", `the writer's response is not in the contract: ${issues.join("; ")}`);
}

/** What the writer said on standard error, cleaned of anything secret, for the end of an error message. */
function diagnosticsOf(stderr: Buffer): string {
  const text = scrub(stderr.toString("utf8")).trim().slice(-600);
  return text ? `: ${text}` : "";
}

/**
 * Runs the configured writer once. Resolves with its response, already checked against the
 * contract. Every failure is a WriterError that says which kind it was.
 */
export async function runWriterCommand(request: WriterRequest, settings: WriterSettings, opts: RunOptions = {}): Promise<WriterResponse> {
  const checked = WriterRequest.safeParse(request);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new WriterError("config", `this tool built a writer request that is not in the contract, at ${issue?.path.join(".") || "(top level)"}`);
  }
  if (opts.signal?.aborted) throw new WriterError("cancelled", "the writer call was cancelled before it started");
  const program = writerExecutable(settings);
  if (!program) throw new WriterError("spawn", `the writer program "${settings.command[0] ?? ""}" was not found, on PATH or at that path. Check WRITER_COMMAND.`);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(program)) {
    throw new WriterError("config", `WRITER_COMMAND names ${program}, a command file that Windows only runs through a shell, and no shell is used. Name the real program instead, for example node followed by the script.`);
  }
  return start(program, settings, checked.data, opts.signal);
}

function start(program: string, settings: WriterSettings, request: WriterRequest, signal: AbortSignal | undefined): Promise<WriterResponse> {
  return new Promise<WriterResponse>((resolve, reject) => {
    // The project root is the working directory, so a relative script path in WRITER_COMMAND means
    // the same thing wherever the tool was started from. Its own group, so it can be stopped whole.
    const child = spawn(program, settings.command.slice(1), {
      cwd: PATHS.root,
      env: writerEnv(settings),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    track(child);

    const out: Buffer[] = [];
    let outBytes = 0;
    let diagnostics = Buffer.alloc(0);
    let settled = false;
    /** Set once this file has decided to stop the writer. The call then ends with this error, however the writer exits. */
    let stopped: WriterError | null = null;
    let grace: NodeJS.Timeout | undefined;

    const settle = (result: WriterResponse | WriterError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", onAbort);
      out.length = 0;
      if (result instanceof WriterError) reject(result);
      else resolve(result);
    };

    /**
     * Asks the writer to end, and ends it by force when it has not gone after the grace time. The
     * call ends when the writer has gone ("close" below). The last timer is only for a system that
     * never reports that: the call must not hang on a process that was already killed.
     */
    const stop = (why: WriterError): void => {
      if (settled || stopped) return;
      stopped = why;
      signalTree(child, "SIGTERM");
      grace = setTimeout(() => {
        signalTree(child, "SIGKILL");
        grace = setTimeout(() => settle(why), WRITER.killGraceMs);
      }, WRITER.killGraceMs);
    };

    const onAbort = (): void => stop(new WriterError("cancelled", "the writer call was cancelled"));
    const timer = setTimeout(() => stop(new WriterError("timeout", `the writer did not answer in ${request.timeoutMs / 1000}s and was stopped`)), request.timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stopped) return;
      out.push(chunk);
      outBytes += chunk.length;
      if (outBytes > WRITER.maxOutputBytes) stop(new WriterError("output_limit", `the writer printed more than ${WRITER.maxOutputBytes} bytes and was stopped`));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Diagnostics are for a person to read in an error message. Only the end of them is kept.
      diagnostics = Buffer.concat([diagnostics, chunk]).subarray(-WRITER.maxDiagnosticBytes);
    });
    child.on("error", (err) => {
      live.delete(child);
      settle(stopped ?? new WriterError("spawn", `the writer could not be started: ${scrub(err.message)}`));
    });
    child.on("close", (code, endedBy) => {
      live.delete(child);
      if (stopped) return settle(stopped);
      if (endedBy) return settle(new WriterError("exit", `the writer was ended by ${endedBy}${diagnosticsOf(diagnostics)}`));
      if (code !== 0) return settle(new WriterError("exit", `the writer exited with code ${code}${diagnosticsOf(diagnostics)}`));
      try {
        settle(readResponse(Buffer.concat(out)));
      } catch (err) {
        settle(err instanceof WriterError ? err : new WriterError("malformed", "the writer's response could not be read"));
      }
    });

    // A writer that exits without reading must not take this process down with a broken pipe.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(request));
  });
}
