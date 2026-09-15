import { appendFile, writeFile } from "node:fs/promises";

const [mode, target] = process.argv.slice(2);

if (mode === "output") {
  process.stdout.write("fixture stdout\n");
  process.stderr.write("fixture stderr\n");
} else if (mode === "fail-after-success") {
  process.stdout.write("SUCCESS (misleading)\n");
  process.exitCode = 7;
} else if (mode === "signal") {
  process.kill(process.pid, "SIGTERM");
} else if (mode === "touch") {
  await appendFile(target, "changed during verification\n");
} else if (mode === "mark") {
  await writeFile(target, "ran\n");
}
