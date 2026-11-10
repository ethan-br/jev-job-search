#!/usr/bin/env node
// A stand-in writer for a first rehearsal and for the tests. It calls no model and writes nothing real.
// Configure it with WRITER_COMMAND=["node","examples/writers/mock-writer.mjs"].
//
// It speaks the job-search.writer/v1 contract: one JSON request on standard input, one JSON response
// on standard output. With no flags it answers every task with the emptiest value its schema allows,
// and a verdict of "needs_review" where there is one, so a rehearsal hands every open question to a person.
// The flags below make it misbehave on purpose, which is how the tests exercise the adapter.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const valueFlags = new Set([
  "--billing",
  "--model",
  "--usage",
  "--cost",
  "--output",
  "--sleep-ms",
  "--exit",
  "--stderr",
  "--print-env",
  "--flood",
  "--pid-file",
  "--child-pid-file",
  "--echo-request",
]);
const booleanFlags = new Set([
  "--garbage",
  "--wrong-contract",
  "--ignore-term",
]);
const flags = new Map();

for (let index = 0; index < process.argv.length - 2; index += 1) {
  const name = process.argv[index + 2];
  if (valueFlags.has(name)) {
    if (index + 1 >= process.argv.length - 2) {
      fail(`missing value for ${name}`);
    }
    flags.set(name, process.argv[index + 3]);
    index += 1;
  } else if (booleanFlags.has(name)) {
    flags.set(name, true);
  } else {
    fail(`unknown flag: ${name}`);
  }
}

function flag(name) {
  return flags.get(name);
}

function has(name) {
  return flags.has(name);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function build(schema) {
  if (Array.isArray(schema.enum)) {
    return schema.enum.includes("needs_review") ? "needs_review" : schema.enum[0];
  }
  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return null;
  }
  if (schema.type === "object") {
    const result = {};
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      result[key] = build(property);
    }
    return result;
  }
  if (schema.type === "array") {
    return [];
  }
  if (schema.type === "string") {
    return "";
  }
  if (schema.type === "boolean") {
    return false;
  }
  if (schema.type === "integer" || schema.type === "number") {
    return 0;
  }
  return null;
}

if (has("--pid-file")) {
  writeFileSync(flag("--pid-file"), String(process.pid));
}
if (has("--child-pid-file")) {
  // A process of its own that would outlive this one, as a harness's helpers do. Stopping the writer must stop it too.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
  writeFileSync(flag("--child-pid-file"), String(child.pid));
}
if (has("--ignore-term")) {
  process.on("SIGTERM", () => {});
}
// Diagnostics come before a requested failure, so a test can read them in the error it gets.
if (has("--stderr")) {
  process.stderr.write(`${flag("--stderr")}\n`);
}
if (has("--print-env")) {
  const name = flag("--print-env");
  process.stderr.write(`${name}=${process.env[name] === undefined ? "unset" : "set"}\n`);
}
if (has("--exit")) {
  process.stderr.write("mock-writer: asked to fail\n");
  process.exit(Number(flag("--exit")));
}

let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  fail("invalid JSON");
}

let request;
try {
  request = JSON.parse(input);
} catch {
  fail("invalid JSON");
}
if (request.contract !== "job-search.writer/v1") {
  fail("invalid contract");
}
if (has("--echo-request")) {
  writeFileSync(flag("--echo-request"), JSON.stringify(request));
}
if (has("--sleep-ms")) {
  await new Promise((resolve) => setTimeout(resolve, Number(flag("--sleep-ms"))));
}
if (has("--garbage")) {
  process.stdout.write("this is not JSON", () => process.exit(0));
  await new Promise(() => {});
}
if (has("--flood")) {
  process.stdout.write("x".repeat(Number(flag("--flood"))), () => process.exit(0));
  await new Promise(() => {});
}

let output = has("--output") ? JSON.parse(flag("--output")) : build(request.output.schema);
if (
  output !== null &&
  typeof output === "object" &&
  !Array.isArray(output) &&
  typeof output.reason === "string"
) {
  output.reason = "The stand-in writer writes nothing. Set WRITER_COMMAND to a real writer.";
}

const usageParts = has("--usage") ? flag("--usage").split(",").map(Number) : null;
const response = {
  contract: has("--wrong-contract") ? "other/v0" : request.contract,
  output,
  writer: {
    name: "mock-writer",
    version: "1",
    model: has("--model") ? flag("--model") : null,
  },
  billing: has("--billing") ? flag("--billing") : "free",
  usage: usageParts === null
    ? null
    : {
        inputTokens: usageParts[0],
        cachedInputTokens: usageParts[1],
        outputTokens: usageParts[2],
      },
  costUsd: has("--cost") ? Number(flag("--cost")) : null,
};
process.stdout.write(JSON.stringify(response));
