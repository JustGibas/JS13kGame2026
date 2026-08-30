// Shared js13k compression helpers and final ZIP builder.
// Usage: node compress.cjs [input.html] [output.zip]

const { spawnSync } = require("child_process");
const { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } = require("fs/promises");
const { tmpdir } = require("os");
const { basename, join, resolve } = require("path");

const LIMIT = 13 * 1024;
const MEASUREMENT_METHOD = "PPMd order=12, memory=1 MiB";
const MEASUREMENT_OPTIONS = ["-mm=PPMd:o=12:mem=1m"];

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

function run7Zip(executable, sourceDir, archive, options = MEASUREMENT_OPTIONS) {
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

function candidates() {
  const tests = [{
    name: "Deflate level=9",
    options: ["-mm=Deflate", "-mx=9", "-mfb=258", "-mpass=15"]
  }];
  for (const order of [2, 4, 6, 8, 10, 12, 16]) {
    tests.push({
      name: `PPMd order=${order}`,
      options: [`-mm=PPMd:o=${order}:mem=1m`]
    });
  }
  return tests;
}

async function roadrollHTML(html, allowFreeVars) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  if (scripts.length !== 1) {
    throw new Error(`Roadroller expects exactly one inline script; found ${scripts.length}`);
  }

  const [{ Packer }, script] = await Promise.all([import("roadroller"), scripts[0]]);
  const packer = new Packer([{
    data: script[2],
    type: "js",
    action: "eval"
  }], {
    allowFreeVars
  });
  await packer.optimize(1);
  const packed = packer.makeDecoder();
  const decoder = packed.firstLine + packed.secondLine;
  if (/<\/script/i.test(decoder)) {
    throw new Error("Roadroller decoder contains a closing script tag");
  }

  if (allowFreeVars) {
    const ids = new Set([...html.matchAll(/\bid=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)]
      .map(match => match[1] || match[2] || match[3]));
    const collisions = packed.freeVars.filter(name => ids.has(name));
    if (collisions.length) {
      console.warn(`Roadroller dirty-global collision with element ID(s): ${collisions.join(", ")}`);
    }
  }

  const start = script.index + script[0].indexOf(">") + 1;
  const end = script.index + script[0].lastIndexOf("</script>");
  return html.slice(0, start) + decoder + html.slice(end);
}

async function buildArchive() {
  const args = process.argv.slice(2);
  const files = args.filter(arg => !arg.startsWith("--"));
  const input = resolve(files[0] || "index.min.html");
  const output = resolve(files[1] || "game.zip");
  await stat(input);

  const sevenZip = find7Zip();
  const work = await mkdtemp(join(tmpdir(), "js13k-compress-"));

  try {
    const terserHTML = await readFile(input, "utf8");
    console.log("Optimizing Roadroller candidates...");
    const variants = [
      { name: "Terser", html: terserHTML },
      { name: "Terser + Roadroller O1 safe", html: await roadrollHTML(terserHTML, false) },
      { name: "Terser + Roadroller O1 dirty", html: await roadrollHTML(terserHTML, true) }
    ];

    const results = [];
    let number = 0;
    for (const variant of variants) {
      const sourceDir = join(work, `source-${number}`);
      await mkdir(sourceDir);
      await writeFile(join(sourceDir, "index.html"), variant.html, "utf8");
      for (const test of candidates()) {
        const archive = join(work, `test-${number++}.zip`);
        run7Zip(sevenZip, sourceDir, archive, test.options);
        results.push({
          name: `${variant.name} + ${test.name}`,
          archive,
          htmlBytes: Buffer.byteLength(variant.html, "utf8"),
          bytes: (await stat(archive)).size
        });
      }
    }
    results.sort((a, b) => a.bytes - b.bytes);
    const winner = results[0];
    await rm(output, { force: true });
    await copyFile(winner.archive, output);

    console.log(`Compression benchmark: ${basename(input)} (${Buffer.byteLength(terserHTML, "utf8")} bytes)`);
    console.log("  ZIP B   Limit       HTML B   Pipeline");
    for (const result of results) {
      const delta = result.bytes <= LIMIT ? `${LIMIT - result.bytes} B free` : `${result.bytes - LIMIT} B over`;
      console.log(`  ${String(result.bytes).padStart(5)}   ${delta.padEnd(10)}  ${String(result.htmlBytes).padStart(6)}   ${result.name}`);
    }
    console.log(`\nCreated ${basename(output)} with ${winner.name}: ${winner.bytes} bytes`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

module.exports = {
  LIMIT,
  MEASUREMENT_METHOD,
  MEASUREMENT_OPTIONS,
  find7Zip,
  run7Zip,
  readPackedSize
};

if (require.main === module) {
  buildArchive().catch(error => {
    console.error("Compression failed:", error.message);
    process.exit(1);
  });
}
