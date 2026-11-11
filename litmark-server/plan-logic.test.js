import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocateWords, assemblePlan, bodySectionRange, cleanOutline, cleanPlanInput,
  parseOutlineReply, pickKeyPapers, pickQuote, shortCite
} from "./plan-logic.js";

// ---------- what the student typed ----------

test("1. a good form is accepted, a word count with a comma is read, odd fields are tidied", () => {
  const r = cleanPlanInput({ question: "  Does fasting\n improve insulin   sensitivity?  ", wordCount: "2,000", type: "Essay", year: "2nd year", subject: "Nutrition", brief: "Harvard" });
  assert.equal(r.ok, true);
  assert.equal(r.value.question, "Does fasting improve insulin sensitivity?");
  assert.equal(r.value.wordCount, 2000);
});

test("2. a missing question or an impossible word count gets a sentence the student can act on", () => {
  assert.match(cleanPlanInput({ question: "hi", wordCount: 2000 }).error, /question or title/);
  for (const w of [299, 30001, "abc", "", null, undefined, NaN]) {
    assert.match(cleanPlanInput({ question: "A real question here", wordCount: w }).error, /word count between 300 and 30,000/);
  }
  assert.equal(cleanPlanInput(undefined).ok, false);
});

test("3. an unknown type becomes Essay and over-long fields are cut", () => {
  const r = cleanPlanInput({ question: "x".repeat(900), wordCount: 1500, type: "Seminar", subject: "s".repeat(500) });
  assert.equal(r.value.type, "Essay");
  assert.equal(r.value.question.length, 400);
  assert.equal(r.value.subject.length, 80);
});

test("4. longer pieces get more sections", () => {
  assert.deepEqual(bodySectionRange(500), { min: 2, max: 3 });
  assert.deepEqual(bodySectionRange(2000), { min: 4, max: 5 });
  assert.deepEqual(bodySectionRange(10000), { min: 7, max: 10 });
});

// ---------- the quote under each paper ----------

test("5. a readable verified quote is chosen; a long one is cut at a word, still the paper's own words", () => {
  const short = "Fasting insulin fell by 14% in the intervention group.";
  assert.equal(pickQuote([{ text: "Too short.", section: "abstract" }, { text: short, section: "results" }]).text, short);
  const long = ("word ".repeat(100)).trim();
  const q = pickQuote([{ text: long }]);
  assert.ok(q.text.endsWith("…"));
  assert.ok(long.startsWith(q.text.slice(0, -1)));
  assert.ok(q.text.length <= 241);
  assert.equal(pickQuote([]), null);
  assert.equal(pickQuote(undefined), null);
  assert.equal(pickQuote([{ text: "tiny" }]), null);
});

test("6. citations read like a student would write them", () => {
  assert.equal(shortCite({ authors: "Chidi Okafor, Anna Lindgren, Jo Park, Sam Lee", year: 2023 }), "Okafor et al. 2023");
  assert.equal(shortCite({ authors: "Ana Lindqvist, Sam Rahman", year: 2022 }), "Lindqvist and Rahman 2022");
  assert.equal(shortCite({ authors: "Pat Hartley", year: 2016 }), "Hartley 2016");
  assert.equal(shortCite({ authors: "", year: 2020, title: "An untitled thing" }), "2020");
});

// ---------- choosing the papers ----------

const hl = [{ text: "A sentence taken word for word from the abstract.", section: "abstract", reason: "r" }];
const mk = (o) => ({ title: "T " + Math.random(), authors: "A B, C D", year: 2020, journal: "J", paperType: "Research article", citedByCount: 10, suitability: 80, highlights: hl, url: "https://x.org/p", ...o });

test("7. reviews come from the database's own type label, best suitability first; two at most", () => {
  const r = pickKeyPapers([
    mk({ title: "R-low", paperType: "Review", suitability: 65 }),
    mk({ title: "R-top", paperType: "Meta-analysis", suitability: 95 }),
    mk({ title: "R-mid", paperType: "Systematic review", suitability: 80 }),
    mk({ title: "Trial", paperType: "Randomised controlled trial", suitability: 99, citedByCount: 5 })
  ]);
  assert.deepEqual(r.reviews.map(p => p.title), ["R-top", "R-mid"]);
  assert.deepEqual(r.reviews.map(p => p.ref), ["R1", "R2"]);
  assert.equal(r.mostCited.length, 0, "a paper with only 5 citations is not 'most cited'");
});

test("8. most cited: highest citation counts, at least 25, never a paper already chosen as a review", () => {
  const r = pickKeyPapers([
    mk({ title: "Review", paperType: "Review", citedByCount: 5000 }),
    mk({ title: "Big", citedByCount: 1240 }),
    mk({ title: "Mid", citedByCount: 610 }),
    mk({ title: "Third", citedByCount: 300 }),
    mk({ title: "Small", citedByCount: 24 })
  ]);
  assert.deepEqual(r.reviews.map(p => p.title), ["Review"]);
  assert.deepEqual(r.mostCited.map(p => p.title), ["Big", "Mid"]);
  assert.deepEqual(r.mostCited.map(p => p.ref), ["C1", "C2"]);
});

test("9. a retracted paper, a study protocol, a weak fit, or a paper with no checked quote is never shown", () => {
  const r = pickKeyPapers([
    mk({ title: "Retracted", paperType: "Review", retracted: true }),
    mk({ title: "Protocol", paperType: "Study protocol", citedByCount: 900 }),
    mk({ title: "Weak", paperType: "Review", suitability: 59 }),
    mk({ title: "Unscored", paperType: "Review", suitability: null }),
    mk({ title: "NoQuote", paperType: "Review", highlights: [] }),
    mk({ title: "Fine", paperType: "Review" })
  ]);
  assert.deepEqual(r.reviews.map(p => p.title), ["Fine"]);
  assert.equal(r.mostCited.length, 0);
});

test("10. the same paper twice is shown once; a non-web link is dropped", () => {
  const r = pickKeyPapers([
    mk({ title: "Same", doi: "10.1/ABC", paperType: "Review", url: "javascript:alert(1)" }),
    mk({ title: "Same again", doi: "10.1/abc", paperType: "Review" }),
    mk({ title: "Other", paperType: "Review", url: "https://doi.org/10.1/x" })
  ]);
  assert.equal(r.reviews.length, 2);
  assert.equal(r.reviews.find(p => p.title === "Same").url, null);
  assert.equal(r.reviews.find(p => p.title === "Other").url, "https://doi.org/10.1/x");
});

test("11. nothing in the search results gives nothing to show, not an error", () => {
  assert.deepEqual(pickKeyPapers([]), { reviews: [], mostCited: [] });
  assert.deepEqual(pickKeyPapers(undefined), { reviews: [], mostCited: [] });
});

// ---------- the AI's outline ----------

const good = (h, extra = {}) => ({ heading: h, cover: "Cover the main trials and what they found.", anchors: ["R1"], weight: 5, query: "fasting insulin trials", ...extra });

test("12. a reply is read whatever shape it comes in, and a cut-off reply keeps its complete entries", () => {
  const arr = [good("A topic"), good("B topic")];
  assert.equal(parseOutlineReply(JSON.stringify(arr)).length, 2);
  assert.equal(parseOutlineReply("Here you go:\n```json\n" + JSON.stringify(arr) + "\n```").length, 2);
  assert.equal(parseOutlineReply(JSON.stringify({ sections: arr })).length, 2);
  const cut = JSON.stringify([good("One"), good("Two"), good("Three")]);
  assert.equal(parseOutlineReply(cut.slice(0, cut.indexOf('{"heading":"Three"') + 25)).length, 2);
  assert.deepEqual(parseOutlineReply("sorry, no"), []);
  assert.deepEqual(parseOutlineReply(undefined), []);
});

test("13. headings are tidied: numbering and markdown stripped, Introduction/Conclusion and repeats dropped", () => {
  const out = cleanOutline([
    good("Introduction"), good("1. **Time-restricted eating**"), good("B) Time-restricted eating"),
    good("Conclusion"), good("## Mechanisms"), good("Weight loss as a confounder")
  ], new Set(["R1"]), { min: 2, max: 5 });
  assert.deepEqual(out.map(s => s.heading), ["Time-restricted eating", "Mechanisms", "Weight loss as a confounder"]);
});

test("14. anchors must be real papers; weight and search are cleaned", () => {
  const [s] = cleanOutline([good("Topic", { anchors: ["r1", "R9", "R1", "C1", "C2"], weight: 99, query: "  insulin; (fasting) \"trial\" a b c d e f g h i j " })], new Set(["R1", "C1"]), { min: 1, max: 5 });
  assert.deepEqual(s.anchors, ["R1", "C1"]);
  assert.equal(s.weight, 10);
  assert.equal(s.query, "insulin fasting trial a b c d e", "special characters removed, at most 8 words");
  assert.equal(cleanOutline([good("Topic", { query: "alternate-day fasting 5:2 diet: results" })], new Set(["R1"]), { min: 1 })[0].query, "alternate-day fasting 5:2 diet results", "5:2 keeps its colon");
});

test("15. an entry with no cover line is dropped; too few usable sections gives [] so the caller can say so", () => {
  assert.equal(cleanOutline([good("A topic", { cover: "" }), good("B topic")], new Set(["R1"]), { min: 2, max: 5 }).length, 0);
  assert.equal(cleanOutline([good("A topic"), good("B topic")], new Set(["R1"]), { min: 2, max: 5 }).length, 2);
  assert.equal(cleanOutline(undefined, new Set(), { min: 2 }).length, 0);
  assert.equal(cleanOutline([good("A topic"), good("B topic"), good("C topic")], new Set(["R1"]), { min: 1, max: 2 }).length, 2);
});

// ---------- the word budget ----------

test("16. the budget always adds up to exactly the total, in whole tens or fifties", () => {
  for (const total of [300, 640, 1234, 1500, 1999, 2000, 2987, 3000, 4321, 7777, 12000, 30000]) {
    for (const weights of [[1], [5, 5], [3, 7, 5], [10, 1, 1, 1, 1], [5, 5, 5, 5, 5, 5, 5]]) {
      const out = allocateWords(total, weights);
      assert.equal(out.reduce((a, b) => a + b, 0), total, `total ${total}, weights ${weights}`);
      assert.ok(out.every(n => n > 0 || total < 100), `no empty section for ${total}`);
    }
  }
});

test("17. a heavier section gets more words; bad weights count as equal shares", () => {
  const [a, b, c] = allocateWords(1000, [8, 1, 1]);
  assert.ok(a > b && a > c);
  assert.deepEqual(allocateWords(900, [0, NaN, -3]), [300, 300, 300]);
  assert.deepEqual(allocateWords(1000, []), []);
});

// ---------- the whole plan ----------

const input = { question: "Does fasting improve insulin sensitivity?", type: "Essay", wordCount: 2000, year: "2nd year", subject: "Nutrition", brief: "" };
const picks = pickKeyPapers([mk({ title: "Rev", paperType: "Review", authors: "Ola Okafor, B C, D E" }), mk({ title: "Cited", citedByCount: 500, authors: "Pat Hartley", year: 2016 })]);

test("18. the outline adds an Introduction and a Conclusion, its sections add up to the word count, anchors become citations", () => {
  const body = cleanOutline([good("Time-restricted eating", { anchors: ["R1", "C1"], weight: 8 }), good("Mechanisms", { anchors: [], weight: 4 }), good("Limitations", { weight: 3 }), good("Weight loss")], new Set(["R1", "C1"]), { min: 2, max: 5 });
  const plan = assemblePlan(input, picks, body, { now: new Date("2026-11-11T12:00:00Z") });
  assert.equal(plan.outline[0].heading, "Introduction");
  assert.equal(plan.outline.at(-1).heading, "Conclusion");
  assert.equal(plan.outline.length, body.length + 2);
  assert.equal(plan.outline.reduce((a, s) => a + s.words, 0), 2000);
  assert.equal(plan.outlineTotal, 2000);
  assert.equal(plan.builtOn, "2026-11-11");
  assert.deepEqual(plan.outline[1].startWith.map(x => x.cite), ["Okafor et al. 2016".replace("2016", "2020"), "Hartley 2016"]);
  assert.deepEqual(plan.outline[0].startWith.map(x => x.ref), ["R1"], "the introduction starts with the top review");
  assert.deepEqual(plan.outline.at(-1).startWith, []);
});

test("19. no usable sections gives an empty outline, but the papers are still in the plan", () => {
  const plan = assemblePlan(input, picks, []);
  assert.deepEqual(plan.outline, []);
  assert.equal(plan.outlineTotal, 0);
  assert.equal(plan.keyReviews.length, 1);
  assert.equal(plan.mostCited.length, 1);
});

test("20. the plan holds no essay text: only headings, cover lines, citations and quotes taken from papers", () => {
  const body = cleanOutline([good("A topic"), good("B topic")], new Set(["R1"]), { min: 2, max: 5 });
  const plan = assemblePlan({ ...input, wordCount: 5000, type: "Dissertation" }, picks, body);
  assert.equal(plan.outline.reduce((a, s) => a + s.words, 0), 5000);
  assert.ok(plan.outline.every(s => s.words % 50 === 0), "long pieces are budgeted in fifties");
});
