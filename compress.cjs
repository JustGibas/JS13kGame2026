// Build a js13k ZIP or compare 7-Zip compression settings.
// Usage: node compress.cjs [input.html] [output.zip] [--benchmark]

const { copyFile, mkdtemp, mkdir, readFile, rm, stat } = require("fs/promises");
const { tmpdir } = require("os");
const { basename, join, resolve } = require("path");
const {
  LIMIT,
  SUBMISSION_METHOD,
  SUBMISSION_OPTIONS,
  find7Zip,
  run7Zip
} = require("./compression-config.cjs");

function candidates() {
  const tests = [];
  for (const order of [2, 4, 6, 8, 10, 12, 16]) {
    tests.push({
      name: `PPMd order=${order}`,
      options: [`-mm=PPMd:o=${order}:mem=1m`]
    });
  }
  return tests;
}

(async () => {
  const args = process.argv.slice(2);
  const benchmark = args.includes("--benchmark");
  const files = args.filter(arg => !arg.startsWith("--"));
  const input = resolve(files[0] || "index.min.html");
  const output = resolve(files[1] || "game.zip");
  await stat(input);

  const sevenZip = find7Zip();
  const work = await mkdtemp(join(tmpdir(), "js13k-compress-"));
  const sourceDir = join(work, "source");
  await mkdir(sourceDir);
  await copyFile(input, join(sourceDir, "index.html"));

  try {
    if (!benchmark) {
      await rm(output, { force: true });
      run7Zip(sevenZip, sourceDir, output, SUBMISSION_OPTIONS);
      const archiveBytes = (await stat(output)).size;
      console.log(`Created ${basename(output)} with ${SUBMISSION_METHOD}: ${archiveBytes} bytes (${archiveBytes <= LIMIT ? `${LIMIT - archiveBytes} B free` : `${archiveBytes - LIMIT} B over`})`);
      return;
    }

    const results = [];
    let number = 0;
    for (const test of candidates()) {
      const archive = join(work, `test-${number++}.zip`);
      run7Zip(sevenZip, sourceDir, archive, test.options);
      results.push({ ...test, bytes: (await stat(archive)).size });
    }
    results.sort((a, b) => a.bytes - b.bytes);

    console.log(`Compression benchmark: ${basename(input)} (${(await readFile(input)).byteLength} bytes)`);
    console.log("  Bytes   Limit       Settings");
    for (const result of results) {
      const delta = result.bytes <= LIMIT ? `${LIMIT - result.bytes} B free` : `${result.bytes - LIMIT} B over`;
      console.log(`  ${String(result.bytes).padStart(5)}   ${delta.padEnd(10)}  ${result.name}`);
    }
    console.log(`\nSubmission setting: ${SUBMISSION_METHOD}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
})().catch(error => {
  console.error("Compression failed:", error.message);
  process.exit(1);
});
