#!/usr/bin/env node
"use strict";
// Regenerate js/test/fixtures/relative-off-golden.json from the assembled core file.
// Run it ONLY from a checkout of release 0.12.1 (commit 9fe3213), where the assembled
// file is the one that shipped; the goldens are the contract that every later change must
// keep with relative search off. Refuses to overwrite the fixture without --force.
//   node scripts/gen_relative_off_golden.js [--force]
const fs = require("node:fs");
const path = require("node:path");
const { computeCases } = require("../js/test/helpers/relative-off-cases.js");

const OUT = path.join(__dirname, "..", "js", "test", "fixtures", "relative-off-golden.json");
const force = process.argv.includes("--force");
if (fs.existsSync(OUT) && !force) {
  process.stderr.write("refusing to overwrite " + OUT + " (pass --force, from a 0.12.1 checkout)\n");
  process.exit(1);
}
const out = {
  made_from: "embeddings-tumbler 0.12.1 (commit 9fe3213), embeddings_tumbler/static/embeddings-tumbler.js",
  cases: computeCases(),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
process.stdout.write("wrote " + Object.keys(out.cases).length + " cases to " + OUT + "\n");
