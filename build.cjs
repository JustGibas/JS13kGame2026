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
