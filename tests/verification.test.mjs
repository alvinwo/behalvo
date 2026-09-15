import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runVerification } from "../scripts/verify.mjs";

const execFileAsync = promisify(execFile);
const fixture = path.resolve("tests/verification-fixture.mjs");

async function git(repo, ...args) {
  return execFileAsync("git", args, { cwd: repo });
}

async function makeRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), "behalvo-verify-"));
  await git(repo, "init", "--quiet");
  await git(repo, "config", "user.email", "verification@example.invalid");
  await git(repo, "config", "user.name", "Verification Fixture");
  await writeFile(path.join(repo, "tracked.txt"), "original\n");
  await writeFile(path.join(repo, ".gitignore"), "data/\n");
  await git(repo, "add", "tracked.txt", ".gitignore");
  await git(repo, "commit", "--quiet", "-m", "fixture");
  return repo;
}

function step(name, ...args) {
  return { name, executable: process.execPath, args: [fixture, ...args] };
}

test("captures and displays child stdout and stderr before writing a passing summary", async () => {
  const repo = await makeRepo();
  let displayedOut = "";
  let displayedErr = "";
  const result = await runVerification({
    repoRoot: repo,
    steps: [step("visible-output", "output")],
    stdout: { write: (chunk) => { displayedOut += chunk; } },
    stderr: { write: (chunk) => { displayedErr += chunk; } },
  });

  assert.equal(result.summary.status, "passed");
  assert.match(displayedOut, /fixture stdout/);
  assert.match(displayedErr, /fixture stderr/);
  assert.equal(await readFile(result.summary.steps[0].stdoutLog, "utf8"), "fixture stdout\n");
  assert.equal(await readFile(result.summary.steps[0].stderrLog, "utf8"), "fixture stderr\n");
  assert.equal((await stat(result.runDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(result.summary.steps[0].stdoutLog)).mode & 0o777, 0o600);
  assert.equal(result.summary.steps[0].exitCode, 0);
  assert.equal(result.summary.steps[0].signal, null);
  assert.ok(result.summary.startedAt <= result.summary.finishedAt);
  assert.equal(result.summary.nodeVersion, process.version);
  assert.match(result.summary.npmVersion, /^\d+\./);
  assert.match(result.summary.headBefore, /^[0-9a-f]{40}$/);
  assert.equal(result.summary.dirtyBefore, false);
  assert.equal(result.summary.dirtyAfter, false);
});

test("fails fast on a nonzero exit even when output claims success", async () => {
  const repo = await makeRepo();
  const marker = path.join(repo, "later-ran");
  const result = await runVerification({
    repoRoot: repo,
    steps: [step("lying-step", "fail-after-success"), step("later-step", "mark", marker)],
  });

  assert.equal(result.summary.status, "failed");
  assert.equal(result.summary.steps[0].exitCode, 7);
  assert.equal(result.summary.steps[1].status, "skipped");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("records spawn errors and signals as failures", async (t) => {
  const repo = await makeRepo();
  await t.test("missing executable", async () => {
    const result = await runVerification({
      repoRoot: repo,
      steps: [{ name: "missing", executable: path.join(repo, "does-not-exist"), args: [] }],
    });
    assert.equal(result.summary.status, "failed");
    assert.equal(result.summary.steps[0].status, "failed");
    assert.match(result.summary.steps[0].error, /ENOENT/);
  });
  await t.test("terminated child", async () => {
    const result = await runVerification({ repoRoot: repo, steps: [step("signal", "signal")] });
    assert.equal(result.summary.status, "failed");
    assert.equal(result.summary.steps[0].signal, "SIGTERM");
  });
});

test("leaves a non-passing summary when log setup fails", async () => {
  const repo = await makeRepo();
  const notDirectory = path.join(repo, "not-a-directory");
  await writeFile(notDirectory, "file\n");
  const result = await runVerification({ repoRoot: repo, outputRoot: notDirectory, steps: [step("unused", "output")] });

  assert.notEqual(result.summary.status, "passed");
  assert.match(result.summary.error, /ENOTDIR|EEXIST/);
});

test("detects source edits when the repository was already dirty", async () => {
  const repo = await makeRepo();
  const tracked = path.join(repo, "tracked.txt");
  await writeFile(tracked, "dirty before\n");
  await writeFile(path.join(repo, "untracked.txt"), "untracked before\n");
  const result = await runVerification({
    repoRoot: repo,
    steps: [step("source-mutator", "touch", tracked)],
  });

  assert.equal(result.summary.dirtyBefore, true);
  assert.equal(result.summary.dirtyAfter, true);
  assert.notEqual(result.summary.sourceFingerprintBefore, result.summary.sourceFingerprintAfter);
  assert.equal(result.summary.status, "failed");
  assert.match(result.summary.error, /source tree changed/i);
});

test("reports a staged change when the working file is restored to HEAD", async () => {
  const repo = await makeRepo();
  const tracked = path.join(repo, "tracked.txt");
  await writeFile(tracked, "staged content\n");
  await git(repo, "add", "tracked.txt");
  await writeFile(tracked, "original\n");

  const { stdout: status } = await git(repo, "status", "--short");
  assert.match(status, /^MM tracked\.txt/m);
  const result = await runVerification({ repoRoot: repo, steps: [step("success", "output")] });

  assert.equal(result.summary.status, "passed");
  assert.equal(result.summary.dirtyBefore, true);
  assert.equal(result.summary.dirtyAfter, true);
});
