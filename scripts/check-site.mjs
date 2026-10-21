// Checks that a built site folder contains every file the pages load: scripts, stylesheets,
// ES-module imports (followed recursively) and the data files app.js fetches.
// Usage: node scripts/check-site.mjs _site      (exit 1 and list what is missing)
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const siteDir = process.argv[2] || ".";
const missing = new Set();
const seen = new Set();

function check(file, from) {
  const rel = relative(siteDir, file).replace(/\\/g, "/");
  if (seen.has(rel)) return;
  seen.add(rel);
  if (!existsSync(file)) {
    missing.add(`${rel} (needed by ${from})`);
    return;
  }
  if (!file.endsWith(".js") && !file.endsWith(".mjs")) return;
  const src = readFileSync(file, "utf8");
  // Static imports: import ... from "./x.js" and import "./x.js"
  for (const m of src.matchAll(/^\s*import\s+(?:[^"'`]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm)) check(normalize(join(dirname(file), m[1])), rel);
  // Data files fetched as ./data/<name> from a list of names
  if (/fetch\(`\.\/data\/\$\{name\}`\)/.test(src)) {
    const list = src.match(/\[((?:\s*"[\w.-]+\.json",?)+)\s*\]\.map\(loadJson\)/);
    for (const name of list ? [...list[1].matchAll(/"([\w.-]+\.json)"/g)].map((x) => x[1]) : []) check(join(siteDir, "data", name), rel);
  }
}

for (const page of ["index.html", "about.html"]) {
  const path = join(siteDir, page);
  if (!existsSync(path)) {
    missing.add(page);
    continue;
  }
  const html = readFileSync(path, "utf8");
  for (const m of html.matchAll(/(?:src|href)="(\.\/[^"#?]+)"/g)) {
    if (m[1].endsWith(".html")) continue;
    check(normalize(join(siteDir, m[1])), page);
  }
}

if (missing.size) {
  console.error(`Site check failed: ${missing.size} file(s) missing from ${siteDir}:\n- ${[...missing].join("\n- ")}`);
  process.exit(1);
}
console.log(`Site check passed: ${seen.size} files referenced, all present in ${siteDir}.`);
