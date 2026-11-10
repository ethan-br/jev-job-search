/**
 * One name for this process, written on every usage record it makes, so the cost of one command
 * (one `discover`, one `apply`) can be told apart from the next.
 */
import { randomBytes } from "node:crypto";

export const THIS_RUN = {
  id: `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`,
  /** The command the person ran, as its first word: discover, apply, daily. */
  command: process.argv[2] && /^[a-z][a-z-]*$/.test(process.argv[2]) ? process.argv[2] : "",
};
