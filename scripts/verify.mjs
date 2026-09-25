import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readlink, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_STEPS = [
  ["check", "npm", ["run", "check"]],
  ["demo", "npm", ["run", "demo"]],
  ["operations-demo", "npm", ["run", "operations:demo"]],
  ["owner-control-demo", "npm", ["run", "owner-control:demo"]],
  ["service-demo", "npm", ["run", "service:demo"]],
  ["git-diff-check", "git", ["diff", "--check"]],
];

function errorText(error) {
  return error instanceof Error ? `${error.code ? `${error.code}: ` : ""}${error.message}` : String(error);
}

async function resolveNpmExecPath() {
  if (process.env.npm_execpath) return process.env.npm_execpath;
  return realpath(path.join(path.dirname(process.execPath), "npm"));
}

function child(executable, args, cwd) {
  return spawn(executable, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
}

async function collect(executable, args, cwd, limit = 4096) {
  const processChild = child(executable, args, cwd);
  const chunks = [];
  let length = 0;
  let stderr = "";
  processChild.stdout.on("data", (chunk) => {
    length += chunk.length;
    if (length > limit) processChild.kill("SIGKILL");
    else chunks.push(chunk);
  });
  processChild.stderr.setEncoding("utf8");
  processChild.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve) => {
    let spawnError;
    processChild.once("error", (error) => { spawnError = error; });
    processChild.once("close", (exitCode, signal) => resolve({ exitCode, signal, spawnError }));
  });
  if (result.spawnError) throw result.spawnError;
  if (length > limit) throw new Error(`command output exceeded ${limit} bytes`);
  if (result.exitCode !== 0) {
    throw new Error(`${executable} ${args.join(" ")} exited ${result.exitCode ?? `on ${result.signal}`}: ${stderr.trim()}`);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function hashCommandOutput(executable, args, cwd) {
  const hash = createHash("sha256");
  const processChild = child(executable, args, cwd);
  processChild.stdout.on("data", (chunk) => hash.update(chunk));
  let stderr = "";
  processChild.stderr.setEncoding("utf8");
  processChild.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve) => {
    let spawnError;
    processChild.once("error", (error) => { spawnError = error; });
    processChild.once("close", (exitCode, signal) => resolve({ exitCode, signal, spawnError }));
  });
  if (result.spawnError) throw result.spawnError;
  if (result.exitCode !== 0) throw new Error(`${executable} ${args.join(" ")} failed: ${stderr.trim()}`);
  return hash.digest("hex");
}

async function hashUntrackedFiles(repoRoot, aggregate) {
  const processChild = child("git", ["ls-files", "--others", "--exclude-standard", "-z"], repoRoot);
  let pending = Buffer.alloc(0);
  let count = 0;
  let stderr = "";
  processChild.stderr.setEncoding("utf8");
  processChild.stderr.on("data", (chunk) => { stderr += chunk; });
  const outcome = new Promise((resolve) => {
    let spawnError;
    processChild.once("error", (error) => { spawnError = error; });
    processChild.once("close", (exitCode, signal) => resolve({ exitCode, signal, spawnError }));
  });
  for await (const chunk of processChild.stdout) {
    pending = Buffer.concat([pending, chunk]);
    let separator;
    while ((separator = pending.indexOf(0)) !== -1) {
      const relativePath = pending.subarray(0, separator).toString("utf8");
      pending = pending.subarray(separator + 1);
      count += 1;
      aggregate.update(`path\0${relativePath}\0`);
      const absolutePath = path.join(repoRoot, relativePath);
      const fileStat = await lstat(absolutePath);
      if (fileStat.isSymbolicLink()) {
        aggregate.update(`symlink\0${await readlink(absolutePath)}\0`);
      } else if (fileStat.isFile()) {
        const fileHash = createHash("sha256");
        for await (const fileChunk of createReadStream(absolutePath)) fileHash.update(fileChunk);
        aggregate.update(`file\0${fileHash.digest("hex")}\0`);
      } else {
        aggregate.update(`other\0${fileStat.mode}\0`);
      }
    }
  }
  const result = await outcome;
  if (result.spawnError) throw result.spawnError;
  if (result.exitCode !== 0) throw new Error(`git ls-files failed: ${stderr.trim()}`);
  if (pending.length !== 0) throw new Error("git returned an unterminated untracked path");
  return count;
}

async function sourceSnapshot(repoRoot) {
  const tracked = await hashCommandOutput("git", ["diff", "HEAD", "--no-ext-diff", "--binary", "--"], repoRoot);
  const staged = await hashCommandOutput("git", ["diff", "--cached", "--no-ext-diff", "--binary", "--"], repoRoot);
  const unstaged = await hashCommandOutput("git", ["diff", "--no-ext-diff", "--binary", "--"], repoRoot);
  const emptyTracked = createHash("sha256").digest("hex");
  const aggregate = createHash("sha256").update(`tracked\0${tracked}\0`);
  const untrackedCount = await hashUntrackedFiles(repoRoot, aggregate);
  return {
    fingerprint: aggregate.digest("hex"),
    dirty: staged !== emptyTracked || unstaged !== emptyTracked || untrackedCount > 0,
  };
}

async function writeSummary(summaryPath, summary) {
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  await chmod(summaryPath, 0o600);
}

async function runStep(step, repoRoot, runDirectory, stdout, stderr) {
  const safeName = step.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const stdoutLog = path.join(runDirectory, `${safeName}.stdout.log`);
  const stderrLog = path.join(runDirectory, `${safeName}.stderr.log`);
  const record = {
    name: step.name,
    command: step.executable,
    args: [...step.args],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    exitCode: null,
    signal: null,
    error: null,
    stdoutLog,
    stderrLog,
  };
  const stdoutFile = createWriteStream(stdoutLog, { flags: "wx", mode: 0o600 });
  const stderrFile = createWriteStream(stderrLog, { flags: "wx", mode: 0o600 });
  try {
    await Promise.all([
      new Promise((resolve, reject) => stdoutFile.once("open", resolve).once("error", reject)),
      new Promise((resolve, reject) => stderrFile.once("open", resolve).once("error", reject)),
    ]);
    const processChild = child(step.executable, step.args, repoRoot);
    const copy = (source, destination, display) => source.on("data", (chunk) => {
      if (!destination.write(chunk)) {
        source.pause();
        destination.once("drain", () => source.resume());
      }
      display.write(chunk);
    });
    copy(processChild.stdout, stdoutFile, stdout);
    copy(processChild.stderr, stderrFile, stderr);
    stdoutFile.once("error", () => processChild.kill("SIGTERM"));
    stderrFile.once("error", () => processChild.kill("SIGTERM"));
    const outcome = await new Promise((resolve) => {
      let spawnError;
      processChild.once("error", (error) => { spawnError = error; });
      processChild.once("close", (exitCode, signal) => resolve({ exitCode, signal, spawnError }));
    });
    record.exitCode = outcome.exitCode;
    record.signal = outcome.signal;
    if (outcome.spawnError) record.error = errorText(outcome.spawnError);
    stdoutFile.end();
    stderrFile.end();
    await Promise.all([finished(stdoutFile), finished(stderrFile)]);
    record.status = !record.error && record.exitCode === 0 && record.signal === null ? "passed" : "failed";
  } catch (error) {
    record.error = errorText(error);
    record.status = "failed";
    stdoutFile.destroy();
    stderrFile.destroy();
  } finally {
    record.finishedAt = new Date().toISOString();
  }
  return record;
}

export async function runVerification(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? path.join(import.meta.dirname, ".."));
  const outputRoot = path.resolve(options.outputRoot ?? path.join(repoRoot, "data", "verification"));
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const summary = {
    status: "incomplete",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    nodeVersion: process.version,
    npmVersion: null,
    headBefore: null,
    headAfter: null,
    dirtyBefore: null,
    dirtyAfter: null,
    sourceFingerprintBefore: null,
    sourceFingerprintAfter: null,
    steps: [],
    error: null,
  };
  let runDirectory = outputRoot;
  let summaryPath = path.join(runDirectory, "summary.json");
  try {
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    runDirectory = path.join(outputRoot, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
    await mkdir(runDirectory, { mode: 0o700 });
    await chmod(runDirectory, 0o700);
    summaryPath = path.join(runDirectory, "summary.json");
    await writeSummary(summaryPath, summary);

    const npmExecPath = options.npmExecPath ?? await resolveNpmExecPath();
    summary.npmVersion = await collect(process.execPath, [npmExecPath, "--version"], repoRoot);
    summary.headBefore = await collect("git", ["rev-parse", "HEAD"], repoRoot);
    const before = await sourceSnapshot(repoRoot);
    summary.dirtyBefore = before.dirty;
    summary.sourceFingerprintBefore = before.fingerprint;
    await writeSummary(summaryPath, summary);

    const steps = options.steps ?? DEFAULT_STEPS.map(([name, kind, args]) => ({
      name,
      executable: kind === "npm" ? process.execPath : "git",
      args: kind === "npm" ? [npmExecPath, ...args] : args,
    }));
    let stopped = false;
    for (const step of steps) {
      if (stopped) {
        summary.steps.push({ name: step.name, command: step.executable, args: [...step.args], status: "skipped", exitCode: null, signal: null, error: null });
        continue;
      }
      const record = await runStep(step, repoRoot, runDirectory, stdout, stderr);
      summary.steps.push(record);
      if (record.status !== "passed") stopped = true;
      await writeSummary(summaryPath, summary);
    }

    summary.headAfter = await collect("git", ["rev-parse", "HEAD"], repoRoot);
    const after = await sourceSnapshot(repoRoot);
    summary.dirtyAfter = after.dirty;
    summary.sourceFingerprintAfter = after.fingerprint;
    if (summary.headAfter !== summary.headBefore || after.fingerprint !== before.fingerprint) {
      stopped = true;
      summary.error = "Git source tree changed during verification";
    }
    summary.status = stopped ? "failed" : "passed";
  } catch (error) {
    summary.status = "failed";
    summary.error = errorText(error);
  } finally {
    summary.finishedAt = new Date().toISOString();
    try { await writeSummary(summaryPath, summary); } catch (error) {
      summary.status = "failed";
      summary.error = summary.error ? `${summary.error}; summary write failed: ${errorText(error)}` : `summary write failed: ${errorText(error)}`;
    }
  }
  return { runDirectory, summaryPath, summary };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await runVerification();
  process.exitCode = result.summary.status === "passed" ? 0 : 1;
}
