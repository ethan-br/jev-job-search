import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { notifierFor, openerFor } from "../src/util/platform.js";

describe("platform launches", () => {
  it("uses the expected macOS commands and argument arrays", () => {
    expect(openerFor("https://example.com/a?b=c", "darwin", {})).toEqual({ command: "/usr/bin/open", args: ["https://example.com/a?b=c"] });
    expect(notifierFor("title", "body", "darwin", {})).toEqual({
      command: "/usr/bin/osascript",
      args: ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "title", "body"],
    });
  });

  it("finds Linux programs on PATH and builds safe arguments", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "platform-test-"));
    try {
      for (const name of ["xdg-open", "notify-send"]) {
        const file = path.join(dir, name);
        writeFileSync(file, "");
        chmodSync(file, 0o755);
      }
      const env = { PATH: dir };
      expect(openerFor("/tmp/resume.pdf", "linux", env)).toEqual({ command: path.join(dir, "xdg-open"), args: ["/tmp/resume.pdf"] });
      expect(notifierFor("-title", "-body", "linux", env)).toEqual({ command: path.join(dir, "notify-send"), args: ["--app-name=job-search", " -title", " -body"] });
      expect(openerFor("https://example.com", "linux", { PATH: "" })).toBeNull();
      expect(notifierFor("title", "body", "linux", { PATH: "" })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when Windows has no explorer", () => {
    expect(openerFor("https://example.com", "win32", { PATH: "", PATHEXT: ".EXE" })).toBeNull();
    expect(notifierFor("title", "body", "win32", {})).toBeNull();
  });

  it("accepts only web URLs and absolute paths", () => {
    for (const target of ["-rf", "relative/file.pdf", "javascript:alert(1)", "file:///etc/passwd", ""]) {
      expect(openerFor(target, "darwin", {})).toBeNull();
    }
    expect(openerFor("https://example.com/a?b=c", "darwin", {})).not.toBeNull();
    expect(openerFor("/tmp/resume.pdf", "darwin", {})).not.toBeNull();
  });
});
