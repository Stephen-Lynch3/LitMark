// How LitMark turns the lists of results from its seven sources into the
// papers a student actually sees.
//
// The old approach took each source's results in turn, one from each, until
// 36 papers were collected. That treats the 5th result of a source nobody
// agrees with the same as the 1st result of three sources that all found the
// same paper, and it kept no particular interest in the famous paper on the
// topic. This module does two things instead:
//
//  1. Rank fusion. Every list a source returned (each source is searched with
//     the raw question and with a distilled keyword query) casts a vote for
//     each paper it contains, worth 1 / (60 + rank). Papers that several lists
//     found, and found high up, rise; a paper only one list mentioned, deep
//     down, falls. This is "reciprocal rank fusion" (Cormack et al., 2009),
//     the standard way to combine rankers whose scores can't be compared. It
//     needs no tuning and makes no assumptions about any one source's quality.
//
//  2. Protection for important papers. Relevance to the exact question is
//     judged afterwards by the AI step, and that judgement decides the order
//     the student sees. But a heavily cited paper or a good review on the
//     topic should not be lost just because it sits a little further down a
//     ranking, or scores a few points below twenty more specific papers. So a
//     few slots, at both cut points (before the AI step and at the final
//     display), are held for them, as long as they're genuinely relevant.
//
// Kept apart from server.js so it can be unit-tested: `npm test`.

const REVIEW_TYPES = new Set(["Systematic review", "Meta-analysis", "Review"]);

// ---------------------------------------------------------------------
// Recognising the same paper across sources
// ---------------------------------------------------------------------

// "https://doi.org/10.1000/ABC", "doi:10.1000/abc" and "10.1000/abc" are the
// same DOI. Anything that doesn't look like a DOI returns "".
export function normalizeDoi(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^doi:\s*/, "")
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  return s.startsWith("10.") ? s : "";
}

export function titleKey(title) {
  return String(title ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 100);
}

const MIN_TITLE_KEY_FOR_MATCH = 12; // a title like "Editorial" must not merge unrelated papers

function yearsCompatible(a, b) {
  return !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) <= 1;
}

class PaperIndex {
  constructor() {
    this.entries = [];
    this.byDoi = new Map();
    this.byTitle = new Map();
  }

  find(paper) {
    const doi = normalizeDoi(paper.doi);
    if (doi && this.byDoi.has(doi)) return this.byDoi.get(doi);
    const tk = titleKey(paper.title);
    if (tk.length >= MIN_TITLE_KEY_FOR_MATCH) {
      for (const entry of this.byTitle.get(tk) || []) {
        const entryDoi = normalizeDoi(entry.paper.doi);
        // Two different DOIs are two different records (a preprint and its
        // published version, say), however alike their titles are.
        if (doi && entryDoi && doi !== entryDoi) continue;
        if (!yearsCompatible(entry.paper.year, paper.year)) continue;
        return entry;
      }
    }
    return null;
  }

  register(entry) {
    const doi = normalizeDoi(entry.paper.doi);
    if (doi && !this.byDoi.has(doi)) this.byDoi.set(doi, entry);
    const tk = titleKey(entry.paper.title);
    if (tk.length >= MIN_TITLE_KEY_FOR_MATCH) {
      const list = this.byTitle.get(tk) || [];
      if (!list.includes(entry)) list.push(entry);
      this.byTitle.set(tk, list);
    }
  }

  // Returns the entry the paper now belongs to, or null if it can't be
  // identified at all (no DOI and no title).
  add(paper) {
    if (!paper) return null;
    if (!normalizeDoi(paper.doi) && !titleKey(paper.title)) return null;
    let entry = this.find(paper);
    if (!entry) {
      entry = { paper: { ...paper }, order: this.entries.length, score: 0, hits: 0, foundBy: new Set() };
      this.entries.push(entry);
    } else {
      mergeInto(entry.paper, paper);
    }
    this.register(entry);
    return entry;
  }
}

// The same paper from another source: keep the first copy, but don't lose a
// DOI, paper type, citation count, full-text id, link, or retraction flag if
// only the duplicate had it, and keep the longer abstract.
function mergeInto(base, other) {
  for (const f of ["doi", "year", "citedByCount", "paperType", "pmcid", "oaUrl", "authors", "authorList", "authorTotal"]) {
    const missing = base[f] == null || base[f] === "";
    if (missing && other[f] != null && other[f] !== "") base[f] = other[f];
  }
  if ((!base.journal || base.journal === "Unknown venue") && other.journal && other.journal !== "Unknown venue") base.journal = other.journal;
  if (other.isOA && !base.isOA) base.isOA = true;
  if (other.retracted) base.retracted = true;
  if ((other.abstract || "").length > (base.abstract || "").length) base.abstract = other.abstract;
}

// Removes duplicates, keeping first-seen order. Same job the old dedupe did,
// but a paper listed as "https://doi.org/10.1/X" by one source and "10.1/x"
// by another is now recognised as one paper, and so is one that one source
// gave a DOI and another didn't.
export function dedupePapers(papers) {
  const index = new PaperIndex();
  for (const p of papers) index.add(p);
  return index.entries.map(e => e.paper);
}

// ---------------------------------------------------------------------
// Rank fusion
// ---------------------------------------------------------------------

// `lists` is an array of result lists, each in the order its source ranked
// them. Returns one deduplicated list, best first, each paper carrying
// `fusedScore`, `engineHits` (how many lists found it) and `foundBy` (which
// sources).
export function fuseRankedLists(lists, { k = 60 } = {}) {
  const index = new PaperIndex();
  for (const list of lists) {
    const counted = new Set();
    (list || []).forEach((paper, rank) => {
      const entry = index.add(paper);
      if (!entry || counted.has(entry)) return; // a paper listed twice by one list still gets one vote
      counted.add(entry);
      entry.score += 1 / (k + rank + 1);
      entry.hits += 1;
      if (paper.source) entry.foundBy.add(paper.source);
    });
  }
  return [...index.entries]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(e => ({ ...e.paper, fusedScore: e.score, engineHits: e.hits, foundBy: [...e.foundBy] }));
}

// ---------------------------------------------------------------------
// Important papers
// ---------------------------------------------------------------------

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// Works out, from the candidate pool, how many citations make a paper stand
// out here. Done once per search and shared by both cut points so "important"
// means the same thing at each.
export function landmarkStats(papers, { floor = 50, q = 0.9 } = {}) {
  const counts = papers.map(p => p.citedByCount).filter(Number.isFinite).sort((a, b) => a - b);
  const enoughData = counts.length >= 8;
  return {
    // The top tenth of the pool by citations, but never fewer than `floor`:
    // in a pool of barely-cited papers the "top tenth" is still not a landmark.
    citeThreshold: Math.max(floor, enoughData ? quantile(counts, q) : 2 * floor),
    medianCites: enoughData ? quantile(counts, 0.5) : 0,
  };
}

// A paper is important if it is among the most cited in the pool, or if it
// is a review (the paper type that maps a whole topic) cited more than the
// typical paper here. A retracted paper is never promoted.
export function isLandmark(paper, stats) {
  if (!paper || paper.retracted) return false;
  const c = paper.citedByCount;
  if (!Number.isFinite(c)) return false;
  if (c >= stats.citeThreshold) return true;
  return REVIEW_TYPES.has(paper.paperType) && c >= Math.max(stats.medianCites, 20);
}

const byCitations = (a, b) => (b.citedByCount ?? -1) - (a.citedByCount ?? -1);

// ---------------------------------------------------------------------
// Cut points
// ---------------------------------------------------------------------

// Before the AI step. Picks `cap` papers from the fused list: the best by
// fused score, except that
//  - each source's best `minPerSource` papers are kept, so a source that
//    is good for this topic but disagrees with the others isn't shut out
//    (the reason the old code took one from each source in turn), and
//  - up to `reserveLandmarks` important papers that at least two lists found
//    are kept, so a famous paper a little way down the ranking is still read.
export function selectCandidates(fused, { cap = 36, minPerSource = 2, reserveLandmarks = 4, stats } = {}) {
  if (fused.length <= cap) return fused.slice();
  const st = stats || landmarkStats(fused);

  const landmarks = fused
    .filter(p => p.engineHits >= 2 && isLandmark(p, st))
    .sort(byCitations)
    .slice(0, reserveLandmarks);

  const perSource = [];
  const sources = [];
  for (const p of fused) for (const s of p.foundBy || []) if (!sources.includes(s)) sources.push(s);
  for (const s of sources) {
    perSource.push(...fused.filter(p => (p.foundBy || []).includes(s)).slice(0, minPerSource));
  }

  const chosen = new Set();
  for (const p of [...landmarks, ...perSource]) {
    if (chosen.size >= cap) break;
    chosen.add(p);
  }
  for (const p of fused) {
    if (chosen.size >= cap) break;
    chosen.add(p);
  }
  return fused.filter(p => chosen.has(p));
}

// How the papers are ordered for the student: the AI's Suitability first;
// among equals, the paper more sources agreed on, then the more cited.
export function compareForDisplay(a, b) {
  return (b.suitability ?? -1) - (a.suitability ?? -1)
    || (b.fusedScore ?? 0) - (a.fusedScore ?? 0)
    || (b.citedByCount ?? -1) - (a.citedByCount ?? -1);
}

// After the AI step. Takes the top `cap` by Suitability, except that up to
// `reserve` important papers that would have just missed the cut replace the
// lowest-placed ordinary papers, provided the AI judged them genuinely
// relevant (Suitability at least `minSuitability`). An important paper that
// is already in is never pushed out.
export function selectFinal(highlighted, { cap = 20, reserve = 3, minSuitability = 50, stats } = {}) {
  const sorted = [...highlighted].sort(compareForDisplay);
  if (sorted.length <= cap) return sorted;
  const st = stats || landmarkStats(highlighted);

  const kept = sorted.slice(0, cap);
  const rescued = sorted.slice(cap)
    .filter(p => isLandmark(p, st) && (p.suitability ?? 0) >= minSuitability)
    .sort((a, b) => (b.suitability ?? 0) - (a.suitability ?? 0) || byCitations(a, b))
    .slice(0, Math.max(0, Math.min(reserve, cap - 1)));

  for (const p of rescued) {
    let drop = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (!isLandmark(kept[i], st)) { drop = i; break; }
    }
    if (drop === -1) break; // every place is already held by an important paper
    kept.splice(drop, 1);
    kept.push(p);
  }
  return kept.sort(compareForDisplay);
}

// A paper the AI scored below this for relevance is not shown, however high its
// other score is. Suitability averages relevance and accuracy, and "accuracy"
// only asks whether the quoted sentence is faithful, so a paper on a different
// subject quoted honestly could still average out mid-table (a breastfeeding
// study turning up for "number of cancer patients in the UK"). Relevance
// alone decides whether a paper belongs.
export const MIN_RELEVANCE = 40;

// A paper with no relevance score (the AI gave none) is kept: it can't be judged.
export function dropOffTopic(papers, min = MIN_RELEVANCE) {
  return papers.filter(p => typeof p.relevance !== "number" || p.relevance >= min);
}
