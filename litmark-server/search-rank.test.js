import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDoi, titleKey, dedupePapers, fuseRankedLists, landmarkStats, isLandmark,
  selectCandidates, selectFinal, compareForDisplay,
} from "./search-rank.js";

let n = 0;
const paper = (over = {}) => {
  n += 1;
  return {
    source: "OpenAlex", id: `id${n}`, title: `A study of something specific number ${n}`,
    year: 2020, journal: "Journal", authors: "Smith", doi: null, citedByCount: null,
    paperType: "Research article", retracted: false, isOA: true, oaUrl: "https://x/y",
    abstract: "An abstract.", ...over,
  };
};

// ---------- identifying papers ----------

test("DOIs are compared in one form", () => {
  assert.equal(normalizeDoi("https://doi.org/10.1000/ABC.1"), "10.1000/abc.1");
  assert.equal(normalizeDoi("http://dx.doi.org/10.1000/abc.1"), "10.1000/abc.1");
  assert.equal(normalizeDoi("doi:10.1000/abc.1"), "10.1000/abc.1");
  assert.equal(normalizeDoi(" 10.1000/abc.1 "), "10.1000/abc.1");
  assert.equal(normalizeDoi("not a doi"), "");
  assert.equal(normalizeDoi(null), "");
});

test("title keys ignore case, punctuation and accents", () => {
  assert.equal(titleKey("Sleep: A Review of  Évidence!"), titleKey("sleep a review of evidence"));
});

test("dedupe merges one paper written two ways and keeps first-seen order", () => {
  const a = paper({ title: "Effects of sleep on memory consolidation", doi: "https://doi.org/10.1/ABC", citedByCount: null, source: "OpenAlex" });
  const b = paper({ title: "Unrelated paper about something else entirely", source: "CORE" });
  const c = paper({ title: "Effects of sleep on memory consolidation", doi: "10.1/abc", citedByCount: 120, paperType: "Review", source: "SemanticScholar" });
  const out = dedupePapers([a, b, c]);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, "OpenAlex");
  assert.equal(out[0].citedByCount, 120); // filled in from the duplicate
  assert.equal(out[0].paperType, "Research article"); // not overwritten when already known
  assert.equal(out[1].source, "CORE");
});

test("a copy with no DOI is matched to one that has a DOI by title", () => {
  const a = paper({ title: "Cognitive behavioural therapy for insomnia in adults", doi: "10.5/xyz" });
  const b = paper({ title: "Cognitive behavioural therapy for insomnia in adults.", doi: null, source: "CORE", citedByCount: 40 });
  const out = dedupePapers([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].doi, "10.5/xyz");
  assert.equal(out[0].citedByCount, 40);
});

test("different DOIs stay separate even with the same title, as do far-apart years", () => {
  const title = "Deep learning for diagnosis of retinal disease";
  assert.equal(dedupePapers([paper({ title, doi: "10.1/preprint" }), paper({ title, doi: "10.1/published" })]).length, 2);
  assert.equal(dedupePapers([paper({ title, year: 2001 }), paper({ title, year: 2019 })]).length, 2);
});

test("short generic titles are never merged, and are not dropped either", () => {
  const out = dedupePapers([paper({ title: "Editorial", year: 2020 }), paper({ title: "Editorial", year: 2020, source: "CORE" })]);
  assert.equal(out.length, 2);
});

test("a paper with neither DOI nor title is ignored; inputs are not changed", () => {
  const a = paper({ title: "", doi: null });
  const b = paper({ title: "A real title that is long enough", doi: "10.2/q" });
  const dup = { ...b, citedByCount: 9 };
  const out = dedupePapers([a, b, dup]);
  assert.equal(out.length, 1);
  assert.equal(b.citedByCount, null);
});

test("the longer abstract and a real journal name win a merge", () => {
  const a = paper({ title: "Metformin and cancer risk: a cohort study", doi: "10.3/m", journal: "Unknown venue", abstract: "Short." });
  const b = paper({ title: "Metformin and cancer risk: a cohort study", doi: "10.3/m", journal: "Diabetes Care", abstract: "A much longer abstract with the findings in full." });
  const [m] = dedupePapers([a, b]);
  assert.equal(m.journal, "Diabetes Care");
  assert.match(m.abstract, /findings in full/);
});

// ---------- fusion ----------

test("a paper several lists found beats one a single list ranked first", () => {
  const consensus = paper({ title: "The consensus paper everyone found", doi: "10.9/c" });
  const loner = paper({ title: "The loner only one list found", doi: "10.9/l" });
  const lists = [
    [loner, paper(), consensus],
    [paper(), consensus],
    [paper(), paper(), consensus],
  ];
  const fused = fuseRankedLists(lists);
  assert.equal(fused[0].doi, "10.9/c");
  assert.equal(fused[0].engineHits, 3);
});

test("the same paper under two DOI spellings is one vote-getter", () => {
  const fused = fuseRankedLists([
    [paper({ title: "Shared paper with a long enough title", doi: "https://doi.org/10.7/S" })],
    [paper({ title: "Shared paper with a long enough title", doi: "10.7/s", source: "CORE" })],
  ]);
  assert.equal(fused.length, 1);
  assert.equal(fused[0].engineHits, 2);
  assert.deepEqual(fused[0].foundBy.sort(), ["CORE", "OpenAlex"]);
});

test("a paper listed twice by the same list gets one vote; rank order breaks ties", () => {
  const p = paper({ title: "Only paper here that is long enough", doi: "10.8/z" });
  const fused = fuseRankedLists([[p, { ...p }]]);
  assert.equal(fused[0].engineHits, 1);

  const x = paper({ title: "First placed paper in its list ok", doi: "10.8/x" });
  const y = paper({ title: "First placed paper in another list", doi: "10.8/y" });
  assert.equal(fuseRankedLists([[x], [y]])[0].doi, "10.8/x"); // equal scores: first seen wins
});

test("fusion copes with empty and missing lists", () => {
  assert.deepEqual(fuseRankedLists([]), []);
  assert.deepEqual(fuseRankedLists([[], null, undefined]), []);
});

// ---------- important papers ----------

const pool = counts => counts.map(c => paper({ citedByCount: c }));

test("the citation bar is the top tenth of the pool, never below 50", () => {
  const big = landmarkStats(pool([1, 2, 3, 4, 5, 6, 7, 8, 9, 400]));
  assert.equal(big.citeThreshold, 400);
  const low = landmarkStats(pool([0, 1, 1, 2, 2, 3, 3, 4, 5, 9]));
  assert.equal(low.citeThreshold, 50);
  assert.equal(landmarkStats(pool([30, 200])).citeThreshold, 100); // too few counts to trust a percentile
  assert.equal(landmarkStats([]).citeThreshold, 100);
});

test("reviews count as important when cited above the pool's typical paper", () => {
  const stats = landmarkStats(pool([10, 12, 15, 20, 25, 30, 40, 60, 80, 90]));
  assert.equal(isLandmark(paper({ paperType: "Systematic review", citedByCount: 45 }), stats), true);
  assert.equal(isLandmark(paper({ paperType: "Systematic review", citedByCount: 5 }), stats), false);
  assert.equal(isLandmark(paper({ paperType: "Research article", citedByCount: 45 }), stats), false);
});

test("a retracted or uncounted paper is never important", () => {
  const stats = { citeThreshold: 50, medianCites: 10 };
  assert.equal(isLandmark(paper({ citedByCount: 9000, retracted: true }), stats), false);
  assert.equal(isLandmark(paper({ citedByCount: null }), stats), false);
});

// ---------- before the AI step ----------

const fusedPool = size => Array.from({ length: size }, (_, i) =>
  paper({ fusedScore: 1 / (i + 1), engineHits: 1, foundBy: ["OpenAlex"], citedByCount: 3 }));

test("under the cap, everything goes through", () => {
  assert.equal(selectCandidates(fusedPool(10), { cap: 36 }).length, 10);
});

test("the best by fused score are chosen, and the cap holds", () => {
  const pool60 = fusedPool(60);
  const out = selectCandidates(pool60, { cap: 36, minPerSource: 0, reserveLandmarks: 0 });
  assert.equal(out.length, 36);
  assert.deepEqual(out.map(p => p.id), pool60.slice(0, 36).map(p => p.id));
});

test("a famous paper found by two lists is kept even if it ranks far down", () => {
  const pool60 = fusedPool(60);
  pool60[55] = { ...pool60[55], citedByCount: 5000, engineHits: 2, title: "The famous one" };
  const out = selectCandidates(pool60, { cap: 36, minPerSource: 0, reserveLandmarks: 4 });
  assert.ok(out.some(p => p.title === "The famous one"));
  assert.equal(out.length, 36);
});

test("a famous paper only one list found is not given a reserved place", () => {
  const pool60 = fusedPool(60);
  pool60[55] = { ...pool60[55], citedByCount: 5000, engineHits: 1, title: "Cited but only one list" };
  const out = selectCandidates(pool60, { cap: 36, minPerSource: 0, reserveLandmarks: 4 });
  assert.ok(!out.some(p => p.title === "Cited but only one list"));
});

test("a source that disagrees with the rest still gets its best papers read", () => {
  const pool60 = fusedPool(60);
  pool60[50] = { ...pool60[50], foundBy: ["ERIC"], title: "ERIC's best" };
  pool60[51] = { ...pool60[51], foundBy: ["ERIC"], title: "ERIC's second" };
  pool60[52] = { ...pool60[52], foundBy: ["ERIC"], title: "ERIC's third" };
  const out = selectCandidates(pool60, { cap: 36, minPerSource: 2, reserveLandmarks: 0 });
  const titles = out.map(p => p.title);
  assert.ok(titles.includes("ERIC's best") && titles.includes("ERIC's second"));
  assert.ok(!titles.includes("ERIC's third"));
  assert.equal(out.length, 36);
});

test("reserved places never push the pool past the cap", () => {
  const many = Array.from({ length: 80 }, (_, i) =>
    paper({ fusedScore: 1 / (i + 1), engineHits: 3, foundBy: [`S${i % 40}`], citedByCount: 1000 + i }));
  assert.equal(selectCandidates(many, { cap: 36, minPerSource: 2, reserveLandmarks: 4 }).length, 36);
});

// ---------- the final cut ----------

const scored = (suits, extra = () => ({})) => suits.map((s, i) => paper({ suitability: s, fusedScore: 1 / (i + 1), citedByCount: 5, ...extra(i) }));

test("under the cap, everything is shown in Suitability order", () => {
  const out = selectFinal(scored([40, 90, 70]), { cap: 20 });
  assert.deepEqual(out.map(p => p.suitability), [90, 70, 40]);
});

test("ties on Suitability go to the paper more sources agreed on, then the more cited", () => {
  const a = paper({ suitability: 80, fusedScore: 0.01, citedByCount: 500, title: "agreed less" });
  const b = paper({ suitability: 80, fusedScore: 0.05, citedByCount: 1, title: "agreed more" });
  const c = paper({ suitability: 80, fusedScore: 0.05, citedByCount: 90, title: "agreed more and cited" });
  assert.deepEqual([a, b, c].sort(compareForDisplay).map(p => p.title), ["agreed more and cited", "agreed more", "agreed less"]);
});

test("an important paper just outside the top 20 takes the last place", () => {
  const list = scored(Array.from({ length: 30 }, (_, i) => 95 - i), i => (i === 24 ? { citedByCount: 4000, title: "Landmark" } : {}));
  const out = selectFinal(list, { cap: 20, reserve: 3, minSuitability: 50 });
  assert.equal(out.length, 20);
  assert.ok(out.some(p => p.title === "Landmark"));
  assert.deepEqual(out.map(p => p.suitability).slice(0, 5), [95, 94, 93, 92, 91]); // still ordered by Suitability
});

test("an important paper the AI found barely relevant is not rescued", () => {
  const list = scored(Array.from({ length: 30 }, (_, i) => (i === 25 ? 30 : 95 - i)), i => (i === 25 ? { citedByCount: 4000, title: "Landmark" } : {}));
  const out = selectFinal(list, { cap: 20, reserve: 3, minSuitability: 50 });
  assert.ok(!out.some(p => p.title === "Landmark"));
});

test("rescued papers never push out another important paper, and the reserve is respected", () => {
  // 50 papers, five of them (a tenth) heavily cited: two already inside the top 20, three just outside
  const isLandmarkIdx = i => i === 18 || i === 19 || i === 30 || i === 31 || i === 32;
  const list = scored(Array.from({ length: 50 }, (_, i) => 95 - i), i => (isLandmarkIdx(i) ? { citedByCount: 4000 + i, title: `Landmark ${i}` } : {}));
  const out = selectFinal(list, { cap: 20, reserve: 1, minSuitability: 40 });
  assert.equal(out.length, 20);
  // 18 and 19 were already in and stay; exactly one more is rescued (the most relevant of the three)
  assert.ok(out.some(p => p.title === "Landmark 18") && out.some(p => p.title === "Landmark 19"));
  assert.ok(out.some(p => p.title === "Landmark 30"));
  assert.equal(out.filter(p => /^Landmark/.test(p.title)).length, 3);
});

// ---------- off-topic papers ----------

test("off-topic: a paper scored below the relevance floor is dropped even when its average is mid-table", async () => {
  const { dropOffTopic, MIN_RELEVANCE } = await import("./search-rank.js");
  // relevance 20 + accuracy 80 averages to a Suitability of exactly 50
  const breastfeeding = { id: "a", relevance: 20, suitability: 50 };
  const onTopic = { id: "b", relevance: 70, suitability: 75 };
  assert.deepEqual(dropOffTopic([breastfeeding, onTopic]).map(p => p.id), ["b"]);
  assert.ok(MIN_RELEVANCE > 20);
});

test("off-topic: the floor is inclusive, and a paper with no relevance score is kept", async () => {
  const { dropOffTopic, MIN_RELEVANCE } = await import("./search-rank.js");
  const atFloor = { id: "a", relevance: MIN_RELEVANCE };
  const justBelow = { id: "b", relevance: MIN_RELEVANCE - 1 };
  const unscored = { id: "c", relevance: null };
  assert.deepEqual(dropOffTopic([atFloor, justBelow, unscored]).map(p => p.id), ["a", "c"]);
});

test("off-topic: if every paper is off-topic the result is empty, not padded with weak matches", async () => {
  const { dropOffTopic } = await import("./search-rank.js");
  assert.deepEqual(dropOffTopic([{ relevance: 5 }, { relevance: 30 }]), []);
});
