// Single source of truth for js13k submission compression.

const { spawnSync } = require("child_process");

const LIMIT = 13 * 1024;
const SUBMISSION_METHOD = "PPMd order=12, memory=1 MiB";
const SUBMISSION_OPTIONS = ["-mm=PPMd:o=12:mem=1m"];

function find7Zip() {
  const candidates = [
    process.env.SEVEN_ZIP,
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe",
    "7z", "7zz", "7za"
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-h"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error("7-Zip not found. Install it or set SEVEN_ZIP to its executable path.");
}

function run7Zip(executable, sourceDir, archive, options = SUBMISSION_OPTIONS) {
  const result = spawnSync(executable, [
    "a", "-tzip", archive, "index.html",
    "-bd", "-bso0", "-bsp0", "-y",
    ...options
  ], { cwd: sourceDir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`7-Zip failed (${result.status}): ${result.stderr || result.stdout}`);
  }
}

function readPackedSize(executable, archive) {
  const result = spawnSync(executable, ["l", "-slt", archive], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`7-Zip listing failed: ${result.stderr || result.stdout}`);
  const match = result.stdout.match(/^Packed Size = (\d+)$/m);
  if (!match) throw new Error("Could not read packed size from 7-Zip output");
  return Number(match[1]);
}

module.exports = {
  LIMIT,
  SUBMISSION_METHOD,
  SUBMISSION_OPTIONS,
  find7Zip,
  run7Zip,
  readPackedSize
};
