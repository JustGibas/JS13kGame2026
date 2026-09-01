/*
 * Copyright 2026 Justinas Gibas
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://apache.org
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


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

function candidates(deep) {
  if (!deep) {
    return [{ name: MEASUREMENT_METHOD, options: MEASUREMENT_OPTIONS }];
  }

  const tests = [
    {
      name: "LZMA mx=9 fb=273",
      options: ["-mm=LZMA", "-mx=9", "-mfb=273"]
    }
  ];

  // Sample the useful high-compression range instead of comparing two
  // unrelated Deflate profiles with different fast-byte and pass settings.
  for (const passes of [10, 15]) {
    tests.push({
      name: `Deflate mx=9 fb=258 pass=${passes}`,
      options: ["-mm=Deflate", "-mx=9", "-mfb=258", `-mpass=${passes}`]
    });
  }

  // Memory size does not affect this one-file archive in practice, so deep
  // mode varies only the setting that materially changes results: PPMd order.
  for (const order of [2, 4, 8, 12, 16]) {
    tests.push({
      name: `PPMd order=${order} mem=1m`,
      options: [`-mm=PPMd:o=${order}:mem=1m`]
    });
  }
  return tests;
}

async function roadrollHTML(html, allowFreeVars, level = 1, extraOptions = {}, optimizationLabel = "Roadroller") {
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
    allowFreeVars,
    ...extraOptions
  });
  if (level === Infinity) {
    let stop = false;
    const stopOptimization = () => { stop = true; };
    process.once("SIGINT", stopOptimization);
    console.log(`${optimizationLabel} infinite optimization started; press Ctrl+C to keep both best results and finish.`);
    try {
      for (let currentLevel = 1; !stop; currentLevel++) {
        try {
          const result = await packer.optimize(currentLevel, async info => {
            await new Promise(resolve => setImmediate(resolve));
            if (stop) return false;
          });
          console.log(`  ${optimizationLabel} level ${currentLevel} complete: ${result.bestSize} estimated bytes`);
        } catch (error) {
          if (!(stop && error instanceof Error && error.message === "search aborted")) throw error;
        }
      }
    } finally {
      process.removeListener("SIGINT", stopOptimization);
    }
  } else {
    await packer.optimize(level);
  }
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
  const infinite = args.includes("--infinite") || args.includes("-OO");
  const deep = infinite || args.includes("--deep") || args.includes("--level2") || args.includes("-O2");
  const files = args.filter(arg => !arg.startsWith("--") && !arg.startsWith("-O"));
  const input = resolve(files[0] || "index.min.html");
  const output = resolve(files[1] || "game.zip");
  await stat(input);

  const sevenZip = find7Zip();
  const work = await mkdtemp(join(tmpdir(), "js13k-compress-"));

  try {
    const terserHTML = await readFile(input, "utf8");
    console.log(infinite ? "Infinite compression mode..." : deep ? "Deep compression benchmark..." : "Quick compression (use --deep for all variants)...");
    const variants = [{ name: "Terser", html: terserHTML }];

    if (infinite) {
      const infiniteConfigs = [
        { name: "dirty", options: {} },
        { name: "dirty (16-ctx)", options: { numAbbreviations: 64, maxMemoryMB: 256 } }
      ];
      const infiniteResults = await Promise.all(infiniteConfigs.map(async config => ({
        name: config.name,
        html: await roadrollHTML(terserHTML, true, Infinity, config.options, `Roadroller ${config.name}`)
      })));
      variants.push(...infiniteResults.map(result => ({
        name: `Terser + Roadroller infinite ${result.name}`,
        html: result.html
      })));
    } else if (deep) {
      variants.push(
        { name: "Terser + Roadroller O2 dirty", html: await roadrollHTML(terserHTML, true, 2) },
        {
          name: "Terser + Roadroller O2 dirty (16-ctx)",
          html: await roadrollHTML(terserHTML, true, 2, { numAbbreviations: 64, maxMemoryMB: 256 })
        }
      );
    }

    const results = [];
    let number = 0;
    for (const variant of variants) {
      const sourceDir = join(work, `source-${number}`);
      await mkdir(sourceDir);
      await writeFile(join(sourceDir, "index.html"), variant.html, "utf8");
      for (const test of candidates(deep)) {
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
    // Show the benchmark as a visual funnel: largest result first and the
    // winning (smallest) result at the bottom, nearest the creation summary.
    results.sort((a, b) => b.bytes - a.bytes);
    const winner = results[results.length - 1];
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
