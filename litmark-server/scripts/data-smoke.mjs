// A live check of the "Official data" card, run from a machine that can reach
// the internet (your Mac, or the Render shell). The tests use stand-in responses;
// this asks the real World Bank.
//
//   node scripts/data-smoke.mjs
//   node scripts/data-smoke.mjs "What is the unemployment rate in Spain?"
//
// It needs no API key: in place of the AI it takes the top-scoring indicator for
// the question and the UK, which is enough to prove the connection, the field
// names and the figure. Then it prints the first few lines of what the ONS
// (Office for National Statistics) beta API returns, so a UK-statistics source
// can be added against its real response shapes. Paste the whole output back.
import { createOfficialData, shortlistIndicators, parseCatalogue } from "../official-data.js";

const questions = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "How common is type 2 diabetes in UK adults?",
      "What is the unemployment rate in the UK?",
      "How many people live in poverty worldwide?"
    ];

const fetchFn = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });

console.log("=== World Bank ===");
let catalogue = null;
try {
  const res = await fetchFn("https://api.worldbank.org/v2/sources/2/indicators?format=json&per_page=2000");
  console.log("indicator list:", res.status);
  catalogue = parseCatalogue(await res.json());
  console.log(`  ${catalogue.entries.length} indicators, data last updated ${catalogue.lastUpdatedYear ?? "(not stated)"}`);
} catch (err) {
  console.log("  FAILED:", err.message);
}

if (catalogue?.entries.length) {
  for (const q of questions) {
    const top = shortlistIndicators(q, catalogue.entries)[0];
    console.log(`\nQ: ${q}`);
    if (!top) { console.log("  no indicator shortlisted"); continue; }
    const od = createOfficialData({
      fetchFn,
      // Stand-in for the AI: always picks the top-scoring indicator, UK (or the world if asked).
      askModel: async () => JSON.stringify({
        indicator: top.id,
        country: /world|global/i.test(q) ? "WLD" : "GBR",
        confidence: 100,
        caveat: ""
      })
    });
    const card = await od.find(q);
    if (!card) { console.log(`  ${top.id}: no card (no recent figure, or the request failed)`); continue; }
    console.log(`  ${card.title}`);
    console.log(`  ${card.geography}: ${card.valueText} (${card.year}), ${card.series.length} points in the trend`);
    console.log(`  cited as: ${card.citation.author} (${card.citation.year ?? "n.d."}) ${card.citation.title}`);
    console.log(`  ${card.url}`);
  }
}

console.log("\n=== ONS beta API (response shapes, for adding it next) ===");
const show = async (label, url) => {
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    const text = await res.text();
    console.log(`\n${label}\n  GET ${url}\n  -> ${res.status}`);
    console.log(text.slice(0, 1800).replace(/^/gm, "  "));
    try { return JSON.parse(text); } catch { return null; }
  } catch (err) {
    console.log(`\n${label}\n  GET ${url}\n  -> FAILED: ${err.message}`);
    return null;
  }
};
const base = "https://api.beta.ons.gov.uk/v1";
await show("dataset list (first 3)", `${base}/datasets?limit=3`);
// cpih01 (consumer price inflation) is the dataset the ONS's own guides use, so
// it is walked end to end: dataset -> latest version -> dimensions -> options -> observations.
const ds = await show("dataset cpih01", `${base}/datasets/cpih01`);
const versionHref = ds?.links?.latest_version?.href;
if (versionHref) {
  const version = await show("its latest version", versionHref);
  const dims = (version?.dimensions || []).map(d => d.name || d.id).filter(Boolean);
  const picks = {};
  for (const name of dims) {
    const opts = await show(`options for dimension "${name}" (first 3)`, `${versionHref}/dimensions/${encodeURIComponent(name)}/options?limit=3`);
    const first = opts?.items?.[0];
    picks[name] = first?.option ?? first?.id ?? first?.code ?? "*";
  }
  if (dims.length) {
    const q = dims.map(n => `${encodeURIComponent(n)}=${n.toLowerCase() === "time" ? "*" : encodeURIComponent(picks[n])}`).join("&");
    await show("observations (time = every period)", `${versionHref}/observations?${q}`);
  }
}
console.log("\nDone. Paste all of the above back to Claude.");
