// Copies the merge code from library-merge.js into the app page, between the
// "begin library-merge" and "end library-merge" markers, so the page (which has
// no build step) always runs exactly the code the tests cover.
//
//   node scripts/inline-library-merge.mjs path/to/app-page.html
//   node scripts/inline-library-merge.mjs path/to/app-page.html --check   (exit 1 if they differ)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BEGIN = "// ---- begin library-merge ----";
const END = "// ---- end library-merge ----";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "library-merge.js"), "utf8");
const block = source.slice(source.indexOf(BEGIN), source.indexOf(END) + END.length);
if (!block.startsWith(BEGIN) || !block.endsWith(END)) throw new Error("markers not found in library-merge.js");

const [file, flag] = process.argv.slice(2);
if (!file) { console.error("usage: node scripts/inline-library-merge.mjs <app page.html> [--check]"); process.exit(2); }
const html = readFileSync(file, "utf8");
const a = html.indexOf(BEGIN), b = html.indexOf(END);
if (a === -1 || b === -1) { console.error("The page has no library-merge markers."); process.exit(2); }
const current = html.slice(a, b + END.length);
if (flag === "--check") {
  console.log(current === block ? "in sync" : "DIFFERENT");
  process.exit(current === block ? 0 : 1);
}
writeFileSync(file, html.slice(0, a) + block + html.slice(b + END.length));
console.log(current === block ? "already up to date" : "updated");
