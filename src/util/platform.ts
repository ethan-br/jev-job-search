/** One place knows how each system opens things and notifies the person. */
import { spawn } from "node:child_process";
import path from "node:path";
import { childEnv, findExecutable } from "../config.js";

export type Launch = { command: string; args: string[] };

function acceptedTarget(target: string): boolean {
  if (target.startsWith("-")) return false;
  try {
    const url = new URL(target);
    if (url.protocol === "http:" || url.protocol === "https:") return true;
  } catch {
    // File paths are checked below.
  }
  return path.isAbsolute(target);
}

/** How this system opens a file or a link for the person, or null when it has no way. */
export function openerFor(target: string, platform = process.platform, env = process.env): Launch | null {
  if (!acceptedTarget(target)) return null;
  if (platform === "darwin") return { command: "/usr/bin/open", args: [target] };
  if (platform === "win32") {
    const command = findExecutable("explorer.exe", env, platform);
    return command ? { command, args: [target] } : null;
  }
  const command = findExecutable("xdg-open", env, platform);
  return command ? { command, args: [target] } : null;
}

/** How this system posts a desktop notification, or null when it has no way. */
export function notifierFor(title: string, body: string, platform = process.platform, env = process.env): Launch | null {
  if (platform === "darwin") {
    return {
      command: "/usr/bin/osascript",
      args: ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body],
    };
  }
  if (platform === "win32") return null;
  const command = findExecutable("notify-send", env, platform);
  if (!command) return null;
  const safeTitle = title.startsWith("-") ? ` ${title}` : title;
  const safeBody = body.startsWith("-") ? ` ${body}` : body;
  return { command, args: ["--app-name=job-search", safeTitle, safeBody] };
}

function launch(l: Launch): boolean {
  try {
    const child = spawn(l.command, l.args, { stdio: "ignore", detached: true, env: childEnv() });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Opens a file or a link in the person's own programs. */
export function openForPerson(target: string): boolean {
  const l = openerFor(target);
  return l ? launch(l) : false;
}

/** Posts a desktop notification. */
export function notifyPerson(title: string, body: string): boolean {
  const l = notifierFor(title, body);
  return l ? launch(l) : false;
}
