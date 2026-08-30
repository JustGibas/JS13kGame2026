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

// Collect the text owned directly by each tagged block. Text inside a nested
// block of the same type belongs to the child only, preventing double-counting.
function findTaggedRegions(source, type) {
  const marker = new RegExp(`^\\s*//\\s*--\\s*(/?)${type}\\s*:\\s*(.*?)\\s*--\\s*$`, "gim");
  const stack = [];
  const regions = [];
  let match;

  while ((match = marker.exec(source))) {
    const closing = Boolean(match[1]);
    const name = match[2].trim();

    if (!closing) {
      if (stack.length) {
        const parent = stack[stack.length - 1];
        parent.parts.push(source.slice(parent.partStart, match.index));
      }
      stack.push({ name, start: match.index, partStart: marker.lastIndex, parts: [] });
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
    open.parts.push(source.slice(open.partStart, match.index));
    regions.push({ name: open.name, source: open.parts.join("\n"), start: open.start });

    if (stack.length) stack[stack.length - 1].partStart = marker.lastIndex;
  }

  for (const open of stack) {
    console.warn(`[size report] ${type} "${open.name}" has no closing tag`);
  }
  return regions.sort((a, b) => a.start - b.start);
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

function disambiguateRegionLabels(regions) {
  const counts = new Map();
  for (const region of regions) {
    const key = region.name.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const seen = new Map();
  for (const region of regions) {
    const key = region.name.toLowerCase();
    const occurrence = (seen.get(key) || 0) + 1;
    seen.set(key, occurrence);
    region.label = counts.get(key) > 1 ? `${region.name} #${occurrence}` : region.name;
  }
}

async function printRegionReport(regions, ppmd, options, {
  title,
  column,
  footer,
  disambiguate = false,
  zeroBar = "— (comments only)"
}) {
  if (disambiguate) disambiguateRegionLabels(regions);
  await measureRegions(regions, ppmd, options);

  const measuredTotal = regions.reduce((sum, region) => sum + (region.ppmdBytes || 0), 0);
  regions.sort((a, b) => (b.ppmdBytes ?? b.rawBytes) - (a.ppmdBytes ?? a.rawBytes));
  const max = Math.max(...regions.map(region => region.ppmdBytes || 0), 1);

  console.log(`\n${title}`);
  console.log(`  ${column.padEnd(22)} ${"Minified".padStart(10)} ${"PPMd".padStart(9)} ${"Raw".padStart(9)}  Share  Relative`);
  for (const region of regions) {
    const estimated = region.estimatedBytes;
    const share = region.ppmdBytes == null || !measuredTotal ? "  n/a" : `${(100 * region.ppmdBytes / measuredTotal).toFixed(1)}%`.padStart(5);
    const bar = region.ppmdBytes == null ? "estimate failed" : region.ppmdBytes === 0 ? zeroBar : "█".repeat(Math.max(1, Math.round(20 * region.ppmdBytes / max)));
    const label = region.label || region.name;
    console.log(`  ${label.slice(0, 22).padEnd(22)} ${estimated == null ? "n/a".padStart(10) : size(estimated).padStart(10)} ${region.ppmdBytes == null ? "n/a".padStart(9) : size(region.ppmdBytes).padStart(9)} ${size(region.rawBytes).padStart(9)}  ${share}  ${bar}`);
    if (region.error) console.log(`    ${region.error}`);
  }
  console.log(`  ${footer}`);
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

  const regions = sourceScripts.flatMap(source => findTaggedRegions(source, "FEATURE"));
  if (!regions.length) {
    console.log("\nNo // -- FEATURE: name -- regions found.");
    return;
  }

  const estimateOptions = {
    ...options,
    toplevel: false,
    mangle: { ...options.mangle, toplevel: false, properties: false },
    compress: { ...options.compress, toplevel: false, unused: false }
  };
  await printRegionReport(regions, ppmd, estimateOptions, {
    title: "Feature size estimates (largest first)",
    column: "Feature",
    footer: "Estimates minify each feature independently; cross-feature optimization means they may not sum to packed JS.",
    disambiguate: true,
    zeroBar: "—"
  });

  // Measure MODULE tags inside every feature for an actionable second-level breakdown.
  const modules = regions
    .flatMap(region => findTaggedRegions(region.source, "MODULE"));
  if (!modules.length) return;
  await printRegionReport(modules, ppmd, estimateOptions, {
    title: "Module size estimates (largest first)",
    column: "Module",
    footer: "Module estimates exclude feature code outside MODULE tags."
  });

  // Scene-HUD has several distinct responsibilities. Its PART anchors make the
  // module report actionable without changing the code fed to the real build.
  const hudParts = modules
    .filter(region => region.name.toLowerCase() === "scene-hud")
    .flatMap(region => findTaggedRegions(region.source, "PART"));
  if (!hudParts.length) return;
  await printRegionReport(hudParts, ppmd, estimateOptions, {
    title: "Scene-HUD part estimates (largest first)",
    column: "Part",
    footer: "Part estimates exclude Scene-HUD code outside PART tags."
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

