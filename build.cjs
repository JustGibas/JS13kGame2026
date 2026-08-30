// Complete release build: minify and report first, then benchmark compression.

const { spawnSync } = require("child_process");
const { join } = require("path");

function run(script) {
  const result = spawnSync(process.execPath, [join(__dirname, script)], {
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("minify.cjs");
run("compress.cjs");
