import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanAbstractText, mergeReHighlight, parseHighlightReply, reHighlightPapers, resolveHighlights } from "./highlight-utils.js";
import { locateQuote } from "./search-rank.js";

// ---------- cleaning abstracts ----------

test("1. JATS paragraphs stay apart and the Abstract label is dropped", () => {
  const raw = "<jats:title>Abstract</jats:title><jats:p>Rates fell sharply.</jats:p><jats:p>Mortality was lower.</jats:p>";
  assert.equal(cleanAbstractText(raw, { markup: true }), "Rates fell sharply. Mortality was lower.");
});

test("2. inline tags vanish without leaving gaps, entities are decoded", () => {
  assert.equal(cleanAbstractText("CD4<sup>+</sup> cells and H<sub>2</sub>O at p &lt; 0.05 &amp; n&#61;12 &#x3b1;", { markup: true }),
    "CD4+ cells and H2O at p < 0.05 & n=12 α");
});

test("3. plain-text sources keep a less-than sign: it is not a tag", () => {
  const t = "Effects were significant if a<b and c>d, p<0.05.";
  assert.equal(cleanAbstractText(t), t);
});

test("4. an abstract that really starts with the word Abstract is left alone", () => {
  assert.equal(cleanAbstractText("Abstract art is discussed here.", { markup: true }), "Abstract art is discussed here.");
});

test("5. soft hyphens and zero-width spaces are removed, spacing is tidied, empty gives null", () => {
  assert.equal(cleanAbstractText("Treat­ment  with​ the\n\ndrug"), "Treatment with the drug");
  assert.equal(cleanAbstractText("   "), null);
  assert.equal(cleanAbstractText(null), null);
});

// ---------- reading the AI's reply ----------

const entry = (i, text) => ({ index: i, highlights: [{ text, reason: "r", section: "abstract" }], relevance: 80, accuracy: 80 });

test("6. a clean array parses as before", () => {
  const out = parseHighlightReply(JSON.stringify([entry(0, "a"), entry(1, "b")]));
  assert.deepEqual(out.map(e => e.index), [0, 1]);
});

test("7. code fences and a sentence around the array are tolerated", () => {
  const raw = "Here are the highlights:\n```json\n" + JSON.stringify([entry(0, "a")]) + "\n```\nHope that helps.";
  assert.equal(parseHighlightReply(raw).length, 1);
});

test("8. an object that wraps the array is unwrapped, not a crash", () => {
  assert.equal(parseHighlightReply(JSON.stringify({ papers: [entry(0, "a"), entry(1, "b")] })).length, 2);
  assert.equal(parseHighlightReply(JSON.stringify(entry(3, "a"))).length, 1);
});

test("9. a reply cut off part-way keeps every complete entry", () => {
  const full = JSON.stringify([entry(0, "one, with a } brace in it"), entry(1, "two"), entry(2, "three")]);
  const cut = full.slice(0, full.indexOf('"three"') - 30);
  const out = parseHighlightReply(cut);
  assert.deepEqual(out.map(e => e.index), [0, 1]);
  assert.equal(out[0].highlights[0].text, "one, with a } brace in it");
});

test("10. string indexes are accepted; unreadable entries are skipped; rubbish gives []", () => {
  const out = parseHighlightReply('[{"index":"2","highlights":[]}, null, 7, "x", {"highlights":[]}, {"index":1.5}]');
  assert.deepEqual(out.map(e => e.index), [2]);
  assert.deepEqual(parseHighlightReply("I could not find anything."), []);
  assert.deepEqual(parseHighlightReply(""), []);
  assert.deepEqual(parseHighlightReply(undefined), []);
  assert.deepEqual(parseHighlightReply("[]"), []);
});

// ---------- checking the quotes ----------

const paper = {
  abstract: "Background text here. In a 12-week trial, an 8-hour eating window improved insulin sensitivity independent of weight loss. Adherence was high.",
  resultsExcerpt: "Fasting insulin fell by 14% in the intervention group compared with 3% in controls."
};

test("11. a quote is returned in the paper's own wording", () => {
  const [h] = resolveHighlights([{ text: "an 8-hour eating window improved insulin sensitivity", reason: "why", section: "abstract" }], paper);
  assert.equal(h.text, "an 8-hour eating window improved insulin sensitivity");
  assert.equal(h.reason, "why");
});

test("12. a made-up quote is dropped", () => {
  assert.deepEqual(resolveHighlights([{ text: "Fasting cured diabetes in every participant.", section: "abstract" }], paper), []);
});

test("13. a quote labelled with the wrong section is still found where it really is", () => {
  const [h] = resolveHighlights([{ text: "Fasting insulin fell by 14% in the intervention group", section: "abstract" }], paper);
  assert.equal(h.section, "results");
  assert.equal(h.text, "Fasting insulin fell by 14% in the intervention group");
});

test("14. a quote labelled results when the paper has no results text is found in the abstract", () => {
  const [h] = resolveHighlights([{ text: "Adherence was high.", section: "results" }], { abstract: paper.abstract });
  assert.equal(h.section, "abstract");
});

test("15. overlapping quotes become one stretch of the paper's text, so no words are shown twice", () => {
  const out = resolveHighlights([
    { text: "an 8-hour eating window improved insulin sensitivity", reason: "first" },
    { text: "improved insulin sensitivity independent of weight loss", reason: "second" }
  ], paper);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "an 8-hour eating window improved insulin sensitivity independent of weight loss");
  assert.equal(out[0].reason, "first");
  assert.ok(paper.abstract.includes(out[0].text));
});

test("16. a quote inside another, and an exact repeat, are not shown twice", () => {
  const out = resolveHighlights([
    { text: "In a 12-week trial, an 8-hour eating window improved insulin sensitivity independent of weight loss." },
    { text: "improved insulin sensitivity" },
    { text: "improved insulin sensitivity" }
  ], paper);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "In a 12-week trial, an 8-hour eating window improved insulin sensitivity independent of weight loss.");
});

test("17. two separate quotes stay separate and keep their order; no more than two are kept", () => {
  const out = resolveHighlights([
    { text: "Adherence was high." },
    { text: "Background text here." },
    { text: "an 8-hour eating window improved insulin sensitivity" }
  ], paper);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(h => h.text), ["Adherence was high.", "Background text here."]);
});

test("18. odd shapes from the model are tolerated: bare strings, missing fields, not an array", () => {
  assert.equal(resolveHighlights(["Adherence was high."], paper)[0].text, "Adherence was high.");
  assert.deepEqual(resolveHighlights(undefined, paper), []);
  assert.deepEqual(resolveHighlights([null, 5, {}], paper), []);
  assert.equal(resolveHighlights([{ text: "Adherence was high.", reason: 42 }], paper)[0].reason, "");
});

// ---------- the matcher itself ----------

test("19. the tolerant matcher returns the right stretch even after a character that lower-cases to two", () => {
  const src = "İstanbul rates fell sharply in 2020.  Elsewhere, the species declined by 40% over a decade.";
  // a double space in the paper, a single one in the quote: forces the tolerant path
  assert.equal(locateQuote(src, "Elsewhere, the species declined by 40% over a decade."), "Elsewhere, the species declined by 40% over a decade.");
  assert.equal(locateQuote(src, "rates fell sharply in 2020. Elsewhere, the species"), "rates fell sharply in 2020.  Elsewhere, the species");
});

test("20. soft hyphens, ligatures and an ellipsis character do not stop a quote matching", () => {
  const src = "Treat­ment with the ﬁrst-line drug reduced mortality by 30% in the trial… and beyond.";
  assert.equal(locateQuote(src, "Treatment with the first-line drug reduced mortality by 30% in the trial... and beyond."), src);
});

// ---------- the second pass ----------

const withExcerpt = (id, angle, highlights) => ({ id, angle, highlights, suitability: 70, relevance: 70, resultsExcerpt: "x" });
const fakeAi = (reply) => async (list) => list.map((p, i) => reply(p, i)).filter(Boolean);

test("21. a paper on both sides of For & against stays on both sides after the second pass", async () => {
  const both = [
    withExcerpt("W1", "support", [{ text: "supporting quote" }]),
    withExcerpt("W1", "challenge", [{ text: "challenging quote" }]),
    withExcerpt("W2", "challenge", [{ text: "other" }])
  ];
  const out = await reHighlightPapers(both, fakeAi(p => ({ ...p, highlights: [{ text: `new ${p.angle} quote` }], suitability: 90 })));
  assert.deepEqual(out.map(p => p.angle), ["support", "challenge", "challenge"]);
  assert.deepEqual(out.map(p => p.highlights[0].text), ["new support quote", "new challenge quote", "new challenge quote"]);
  assert.equal(out.filter(p => p.angle === "support").length, 1);
  assert.equal(out.filter(p => p.angle === "challenge").length, 2);
});

test("22. a second pass that gives no usable quote keeps the first pass's highlight", async () => {
  const one = [withExcerpt("A", "support", [{ text: "good quote from the abstract" }])];
  const out = await reHighlightPapers(one, fakeAi(p => ({ ...p, highlights: [], suitability: 10 })));
  assert.deepEqual(out[0].highlights, [{ text: "good quote from the abstract" }]);
  assert.equal(out[0].suitability, 70);
});

test("23. a paper the second pass leaves out, or a failed second pass result, keeps what it had", async () => {
  const two = [withExcerpt("A", "support", [{ text: "a" }]), withExcerpt("B", "support", [{ text: "b" }])];
  const out = await reHighlightPapers(two, fakeAi((p, i) => i === 1 ? { ...p, highlights: [{ text: "b2" }] } : null));
  assert.deepEqual(out.map(p => p.highlights[0].text), ["a", "b2"]);
  assert.deepEqual((await reHighlightPapers(two, async () => undefined)).map(p => p.highlights[0].text), ["a", "b"]);
});

test("24. the slot marker never leaks into what is returned", async () => {
  const out = await reHighlightPapers([withExcerpt("A", "support", [{ text: "a" }])], fakeAi(p => ({ ...p, highlights: [{ text: "z" }] })));
  assert.equal("_slot" in out[0], false);
});

test("25. a second pass keeps the better of the two when it did find something", () => {
  const orig = { id: "A", highlights: [{ text: "old" }], suitability: 60, relevance: 60 };
  assert.deepEqual(mergeReHighlight(orig, { highlights: [{ text: "new" }], suitability: 88, relevance: 90 }).highlights, [{ text: "new" }]);
  assert.equal(mergeReHighlight(orig, { highlights: [{ text: "new" }], suitability: null, relevance: null }).suitability, 60);
});
