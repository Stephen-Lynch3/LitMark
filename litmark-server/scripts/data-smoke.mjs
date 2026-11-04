// A live check of the "Official data" card, run from a machine that can reach
// the internet (your Mac, or the Render shell). The tests use stand-in responses;
// this asks the real World Bank and the real ONS.
//
//   node scripts/data-smoke.mjs
//   node scripts/data-smoke.mjs "What is the unemployment rate in Spain?"
//
// It needs no API key: in place of the AI it takes the top-ranked match for the
// question (for the UK, the ONS's first search result), which is enough to prove
// the connections, the field names and the figures. It does NOT test whether the
// AI picks well: that is judged by searching in the app.
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
    if (!top) console.log("  (no World Bank indicator shortlisted; the ONS is still tried for UK questions)");
    const od = createOfficialData({
      fetchFn,
      // Stand-in for the AI: always picks the top-scoring indicator, UK (or the world if asked).
      askModel: async (prompt) => /Office for National Statistics/.test(prompt)
        ? JSON.stringify({ choice: 1, confidence: 100, caveat: "" })
        : JSON.stringify({ indicator: top?.id ?? null, country: /world|global/i.test(q) ? "WLD" : "GBR", confidence: 100, caveat: "" })
    });
    const card = await od.find(q);
    if (!card) { console.log(`  ${top?.id ?? "-"}: no card (no recent figure, or the request failed)`); continue; }
    console.log(`  [${card.provider}] ${card.title}`);
    console.log(`  ${card.geography ? card.geography + ": " : ""}${card.valueText} (${card.period}), ${card.series.length} points in the trend`);
    console.log(`  cited as: ${card.citation.author} (${card.citation.year ?? "n.d."}) ${card.citation.title}`);
    console.log(`  ${card.url}`);
  }
}

console.log("\nDone. Paste all of the above back to Claude.");
