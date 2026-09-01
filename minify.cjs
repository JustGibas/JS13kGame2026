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


// Ultra‑minimal HTML+JS packer for jam builds.
// Usage: node minify.cjs [in.html] [out.html] [--no-report]
// Defaults: in=index.html  out=index.min.html
// Steps: read HTML -> extract <script> bodies -> aggressive Terser -> reinsert -> minify HTML -> write.

const { mkdir, mkdtemp, readFile, rm, stat, writeFile } = require("fs/promises");
const { tmpdir } = require("os");
const { join } = require("path");
const { minify: terser } = require("terser");
const { version: terserVersion } = require("terser/package.json");
const { minify: minifyHTML } = require("html-minifier-terser");
const {
  LIMIT: ZIP_LIMIT,
  MEASUREMENT_METHOD,
  find7Zip,
  readPackedSize,
  run7Zip
} = require("./compress.cjs");

const bytes = value => Buffer.byteLength(value || "", "utf8");
const size = value => value < 1024 ? `${value} B` : `${(value / 1024).toFixed(2)} KB`;

async function createPpmdMeasurer() {
  const executable = find7Zip();
  const work = await mkdtemp(join(tmpdir(), "js13k-ppmd-report-"));
  const sourceDir = join(work, "source");
  const source = join(sourceDir, "index.html");
  const archive = join(work, "measure.zip");
  await mkdir(sourceDir);

  return {
    async measure(content) {
      await writeFile(source, content, "utf8");
      await rm(archive, { force: true });
      run7Zip(executable, sourceDir, archive);
      return {
        archiveBytes: (await stat(archive)).size,
        packedBytes: readPackedSize(executable, archive)
      };
    },
    async cleanup() {
      await rm(work, { recursive: true, force: true });
    }
  };
}

const REPORT_TYPES = ["FEATURE", "MODULE", "PART", "SOLUTION", "ITEM", "ENTITY"];

// A marker may classify one block in several useful ways without adding more
// anchor lines:
//   // -- MODULE: Scene-Orb | ENTITY: Orb --
//   // -- /MODULE: Scene-Orb | /ENTITY: Orb --
// Existing one-classification markers remain valid.
function findTagMarkers(source, type) {
  const line = /^\s*\/\/\s*--\s*(.*?)\s*--\s*$/gim;
  const markers = [];
  let match;

  while ((match = line.exec(source))) {
    for (const field of match[1].split("|")) {
      const tag = field.trim().match(/^(\/?)\s*(FEATURE|MODULE|PART|SOLUTION|ITEM|ENTITY)\s*:\s*(.+)$/i);
      if (tag && tag[2].toUpperCase() === type) {
        markers.push({ closing: Boolean(tag[1]), name: tag[3].trim(), start: match.index, end: line.lastIndex });
      }
    }
  }
  return markers;
}

// Collect the text owned directly by each tagged block. Text inside a nested
// block of the same type belongs to the child only, preventing double-counting.
function findTaggedRegions(source, type) {
  const stack = [];
  const regions = [];

  for (const marker of findTagMarkers(source, type)) {
    const { closing, name } = marker;

    if (!closing) {
      if (stack.length) {
        const parent = stack[stack.length - 1];
        parent.parts.push(source.slice(parent.partStart, marker.start));
      }
      stack.push({ name, start: marker.start, partStart: marker.end, parts: [] });
      continue;
    }

    const open = stack.pop();
    if (!open) {
      console.warn(`[size report] Closing ${type} "${name}" has no opening tag`);
      continue;
    }
    if (open.name.toLowerCase() !== name.toLowerCase()) {
      console.warn(`[size report] ${type} "${open.name}" closes as "${name}"`);
    }
    open.parts.push(source.slice(open.partStart, marker.start));
    regions.push({ name: open.name, source: open.parts.join("\n"), start: open.start, end: marker.end });

    if (stack.length) stack[stack.length - 1].partStart = marker.end;
  }

  for (const open of stack) {
    console.warn(`[size report] ${type} "${open.name}" has no closing tag`);
  }
  return regions.sort((a, b) => a.start - b.start);
}

function buildReportTree(taggedSpans) {
  const spans = [...taggedSpans.values()].flat();
  const parentOf = new Map();
  const allowedParents = {
    MODULE: new Set(["FEATURE"]),
    PART: new Set(["FEATURE", "MODULE", "PART"]),
    SOLUTION: new Set(["FEATURE", "MODULE", "PART"]),
    ITEM: new Set(["FEATURE", "MODULE", "PART"]),
    ENTITY: new Set(["FEATURE", "MODULE", "PART"])
  };

  for (const span of spans) {
    const allowed = allowedParents[span.type];
    if (!allowed) continue;
    const parents = spans.filter(candidate =>
      allowed.has(candidate.type) &&
      candidate.script === span.script &&
      candidate.start <= span.start && candidate.end >= span.end &&
      (candidate.start < span.start || candidate.end > span.end)
    );
    parents.sort((a, b) => (a.end - a.start) - (b.end - b.start));
    if (parents.length) parentOf.set(span, parents[0]);
  }

  const keyMemo = new Map();
  const keyFor = span => {
    if (keyMemo.has(span)) return keyMemo.get(span);
    const parent = parentOf.get(span);
    const key = `${parent ? `${keyFor(parent)}>` : ""}${span.type}:${span.name.toLowerCase()}`;
    keyMemo.set(span, key);
    return key;
  };
  const nodes = new Map();

  for (const span of spans) {
    const key = keyFor(span);
    const parent = parentOf.get(span);
    const existing = nodes.get(key);
    if (existing) {
      existing.source += `\n${span.source}`;
      existing.spans++;
      existing.start = Math.min(existing.start, span.start);
    } else {
      nodes.set(key, {
        key,
        parentKey: parent ? keyFor(parent) : null,
        type: span.type,
        name: span.name,
        source: span.source,
        start: span.start,
        spans: 1,
        children: []
      });
    }
  }
  for (const node of nodes.values()) {
    if (node.parentKey && nodes.has(node.parentKey)) {
      node.parent = nodes.get(node.parentKey);
      node.parent.children.push(node);
    }
  }
  return [...nodes.values()].filter(node => !node.parentKey);
}

function printRankedReport(nodes, { title, column, showKind = false }) {
  if (!nodes.length) return;
  const labelWidth = showKind ? 32 : 22;
  const measuredTotal = nodes.reduce((sum, node) => sum + (node.ppmdBytes || 0), 0);
  const sorted = [...nodes].sort((a, b) => (b.ppmdBytes ?? b.rawBytes) - (a.ppmdBytes ?? a.rawBytes));
  const max = Math.max(...sorted.map(node => node.ppmdBytes || 0), 1);
  const pathLabel = node => {
    if (!showKind) return node.name;
    const parent = node.parent;
    return parent ? `${parent.name} › ${node.name}` : node.name;
  };

  console.log(`\n${title}`);
  console.log(`  ${column.padEnd(labelWidth)}${showKind ? ` ${"Kind".padEnd(8)}` : ""} ${"Minified".padStart(10)} ${"PPMd".padStart(9)} ${"Raw".padStart(9)}  Share  Relative`);
  for (const node of sorted) {
    const estimated = node.estimatedBytes;
    const share = node.ppmdBytes == null || !measuredTotal ? "  n/a" : `${(100 * node.ppmdBytes / measuredTotal).toFixed(1)}%`.padStart(5);
    const bar = node.ppmdBytes == null ? "estimate failed" : node.ppmdBytes === 0 ? "—" : "█".repeat(Math.max(1, Math.round(20 * node.ppmdBytes / max)));
    const spans = node.spans > 1 ? ` ×${node.spans}` : "";
    const label = `${pathLabel(node)}${spans}`.slice(0, labelWidth).padEnd(labelWidth);
    const kind = showKind ? ` ${(node.type[0] + node.type.slice(1).toLowerCase()).padEnd(8)}` : "";
    console.log(`  ${label}${kind} ${estimated == null ? "n/a".padStart(10) : size(estimated).padStart(10)} ${node.ppmdBytes == null ? "n/a".padStart(9) : size(node.ppmdBytes).padStart(9)} ${size(node.rawBytes).padStart(9)}  ${share}  ${bar}`);
    if (node.error) console.log(`    ${node.error}`);
  }
  console.log("  Estimates at different levels overlap and do not sum to packed JavaScript.");
}

async function measureRegions(regions, ppmd, options) {
  await Promise.all(regions.map(async region => {
    region.rawBytes = bytes(region.source);
    try {
      const code = (await terser(region.source, options)).code;
      region.estimatedBytes = bytes(code);
      region.minifiedCode = code;
    } catch (error) {
      region.estimatedBytes = null;
      region.error = error.message;
    }
  }));

  for (const region of regions) {
    if (region.estimatedBytes > 0) region.ppmdBytes = (await ppmd.measure(region.minifiedCode)).packedBytes;
    else if (region.estimatedBytes === 0) region.ppmdBytes = 0;
    delete region.minifiedCode;
  }
}

async function printSizeReport(sourceScripts, packedHTML, options) {
  const ppmd = await createPpmdMeasurer();
  try {
  const packedScripts = [...packedHTML.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .reduce((total, match) => total + bytes(match[1]), 0);
  const packedStyles = [...packedHTML.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .reduce((total, match) => total + bytes(match[1]), 0);
  const packedTotal = bytes(packedHTML);
  const packedMarkup = packedTotal - packedScripts - packedStyles;
  const packedPpmd = await ppmd.measure(packedHTML);

  console.log(`\nPacked breakdown (Terser ${terserVersion})`);
  for (const [label, value] of [["JavaScript", packedScripts], ["CSS", packedStyles], ["HTML", packedMarkup]]) {
    const percent = packedTotal ? 100 * value / packedTotal : 0;
    console.log(`  ${label.padEnd(12)} ${size(value).padStart(10)}  ${percent.toFixed(1).padStart(5)}%`);
  }
  const zipDelta = packedPpmd.archiveBytes - ZIP_LIMIT;
  console.log(`  ${"PPMd ZIP".padEnd(12)} ${size(packedPpmd.archiveBytes).padStart(10)}  ${zipDelta <= 0 ? `${-zipDelta} B free` : `${zipDelta} B over`}  (measurement: ${MEASUREMENT_METHOD})`);

  const tagged = new Map(REPORT_TYPES.map(type => [
    type,
    sourceScripts.flatMap((source, script) =>
      findTaggedRegions(source, type).map(region => ({ ...region, type, script }))
    )
  ]));
  if (![...tagged.values()].some(regions => regions.length)) {
    console.log("\nNo size-report tags found.");
    return;
  }

  const estimateOptions = {
    ...options,
    toplevel: false,
    mangle: { ...options.mangle, toplevel: false, properties: false },
    compress: { ...options.compress, toplevel: false, unused: false }
  };
  const roots = buildReportTree(tagged);
  const nodes = [];
  const collect = node => { nodes.push(node); node.children.forEach(collect); };
  roots.forEach(collect);
  await measureRegions(nodes, ppmd, estimateOptions);
  printRankedReport(nodes.filter(node => node.type === "FEATURE"), {
    title: "Feature size estimates (largest first)",
    column: "Feature"
  });
  printRankedReport(nodes.filter(node => node.type === "MODULE"), {
    title: "Module size estimates (largest first)",
    column: "Module"
  });
  printRankedReport(nodes.filter(node => !["FEATURE", "MODULE"].includes(node.type)), {
    title: "Smaller component estimates (largest first)",
    column: "Parent › Component",
    showKind: true
  });
  } finally {
    await ppmd.cleanup();
  }
}

(async () => {
  const args = process.argv.slice(2);
  const REPORT = !args.includes("--no-report");
  const files = args.filter(arg => !arg.startsWith("--"));
  const inFile  = files[0] || "index.html";
  const outFile = files[1] || "index.min.html";

  // Read input.
  let src;
  try { src = await readFile(inFile, "utf8"); }
  catch (e) { console.error("Read fail:", e.message); process.exit(1); }

  // Extract scripts -> placeholders.
  const scripts = [];
  const withSlots = src.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, body) => {
    const i = scripts.length;
    scripts.push({ i, attrs: attrs.trim(), body });
    return `<!--S${i}-->`;
  });

  // Aggressive single-pass Terser config.
  // Every line documents WHY it helps and possible RISK.
  const terserOptions = {
    ecma: 2022,                 // WebGL2/WebXR targets are modern; allow smaller modern output.
    toplevel: true,             // Allow dropping unused top-level bindings + tighter mangling.
    mangle: {
      toplevel: true,           // Shorten top-level names.
      reserved: ['E'],          // Runtime exports Math.E globally; never reuse that binding.
      safari10: false,          // WebXR is unavailable in Safari 10/11; skip legacy workarounds.
      properties: {
        // Mangle owned, wordy properties. Browser/JS built-ins remain reserved by Terser.
        regex: /^[a-zA-Z_]\w{2,}$/,
        keep_quoted: true,       // Quoting a key becomes an escape hatch for external/data APIs.
        // reserve: ['_keepMe']  // Example: keep specific props if needed later.
      }
    },
    compress: {
      // General iteration / exploration depth.
      passes: 7,                 // More than seven produced no further savings in this build.
      builtins_ecma: 2022,       // Let unsafe transforms recognize modern standard built-ins.
      toplevel: true,            // Drop unused top-level vars/functions.
      inline: 3,                 // Aggressively inline functions (3 = max heuristic).
      pure_getters: true,        // Assume property getters have no side effects (RISK if getters mutate).
      booleans_as_integers: true,// Turn true/false into !0/!1 etc.
      unsafe: true,              // Enable several "unsafe" transforms assuming standard semantics.
      unsafe_arrows: true,       // Convert funcs to arrows when shorter (can change 'this').
      unsafe_math: true,         // Reassociate math (can affect FP precision).
      unsafe_Function: true,     // Optimize new Function() patterns (rare; small gain).
      unsafe_methods: true,      // Assumes prototype methods not replaced.
      unsafe_symbols: true,      // Assumes Symbol.* not monkey-patched.
      hoist_funs: true,          // Hoist function declarations (may affect TDZ edge cases).
      hoist_props: true,         // Hoist object literal props into vars when profitable.
      hoist_vars: false,         // Terser notes var hoisting generally increases output size.
      reduce_funcs: true,        // Inline single-use function literals.
      reduce_vars: true,         // Substitute variables with values when safe.
      collapse_vars: true,       // Collapse sequences of assignments.
      conditionals: true,        // Optimize ?: and if.
      dead_code: true,           // Remove unreachable branches.
      evaluate: true,            // Precompute constant expressions.
      sequences: 1000,           // Allow long comma sequences where they are smaller.
      join_vars: true,           // Combine consecutive var declarations.
      loops: true,               // Optimize loops (e.g., while->for).
      switches: true,            // Deduplicate/optimize switch cases.
      comparisons: true,         // Optimize comparisons (e.g., === vs == if safe).
      drop_debugger: true,       // Remove debugger statements.
      arrows: true,              // Use arrow funcs where smaller.
      unsafe_comps: true,        // Reorder comparisons (RISK with NaN/order edge cases).
      pure_funcs: ['console.log','console.info','console.warn','console.error'],
    },
    format: {
      ascii_only: false,         // UTF-8 characters are usually smaller than \uXXXX escapes.
      comments: false,           // Strip all comments.
    }
  };

  // Minify scripts.
  const rebuilt = [];
  for (const s of scripts) {
    let code = s.body;
    try {
      code = (await terser(code, terserOptions)).code;
    } catch (e) {
      console.warn("[skip]", s.i, e.message);
    }
    rebuilt[s.i] = `<script${s.attrs ? " " + s.attrs : ""}>${code}</script>`;
  }

  // Reinsert.
  let html = withSlots;
  for (const s of scripts) html = html.replace(`<!--S${s.i}-->`, rebuilt[s.i]);

  // Minify HTML (leave JS untouched now).
  try {
    html = await minifyHTML(html, {
      collapseWhitespace: true,
      removeComments: true,
      removeAttributeQuotes: true,
      removeOptionalTags: true,
      //collapseBooleanAttributes: true,
      //removeEmptyAttributes: true,
      //removeRedundantAttributes: true,
      //removeScriptTypeAttributes: true,
      //removeStyleLinkTypeAttributes: true,
      useShortDoctype: true,
      minifyCSS: true,
      minifyJS: false
    });
  } catch (e) {
    console.warn("HTML minify failed, using non-minified HTML:", e.message);
  }

  // Write output.
  try { await writeFile(outFile, html, "utf8"); console.log("Packed ->", outFile);
  console.log("File size:", bytes(html), "bytes");
  if (REPORT) await printSizeReport(scripts.map(script => script.body), html, terserOptions); }
  catch (e) { console.error("Write fail:", e.message); process.exit(1); }
})().catch(e => { console.error("Unexpected:", e); process.exit(1); });

