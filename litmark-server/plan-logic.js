// The pure parts of the Plan feature, kept apart from server.js so they can be
// unit-tested (`npm test`).
//
// A plan is a one-page Word file: the key reviews and most-cited papers to read
// first, then a suggested outline with a word budget for each section.
//
// The rule that decides who does what, same as everywhere else in LitMark:
// the AI proposes, the code verifies, and anything unverifiable fails closed.
//
//   CODE  decides which papers are shown (from the search results LitMark already
//         has), which are reviews (the database's own type label), which are most
//         cited (the database's own count), the quote under each (a highlight that
//         was already checked word for word against the paper), how many words each
//         section gets, and that the budgets add up to the student's total.
//   AI    only suggests the section headings, one line on what each should cover,
//         which of the chosen papers belongs with which section, and a search for
//         finding more. Every one of those is checked here before it is used.
//
// Nothing in a plan is a sentence of the student's essay.

import { REVIEW_TYPES } from "./search-rank.js";
import { salvageObjects } from "./highlight-utils.js";

export const PLAN_TYPES = ["Essay", "Literature review", "Dissertation", "Report"];

export const MIN_WORDS = 300;
export const MAX_WORDS = 30000;

const oneLine = (s, max) => {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max).trim() : t;
};

// Cuts at a word boundary, so a trimmed line never ends mid-word.
function trimToWords(s, max) {
  const t = oneLine(s, 100000);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, "") + "…";
}

// ---------------------------------------------------------------------
// What the student typed
// ---------------------------------------------------------------------

// Returns { ok: true, value } or { ok: false, error } where error is a sentence
// the student can act on.
export function cleanPlanInput(body) {
  const b = body && typeof body === "object" ? body : {};
  const question = oneLine(b.question, 400);
  if (question.length < 5) return { ok: false, error: "Type your assignment question or title." };

  const raw = typeof b.wordCount === "number" ? b.wordCount : Number(String(b.wordCount ?? "").replace(/[,\s]/g, ""));
  const wordCount = Math.round(raw);
  if (!Number.isFinite(wordCount) || wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
    return { ok: false, error: `Enter a word count between ${MIN_WORDS.toLocaleString("en-US")} and ${MAX_WORDS.toLocaleString("en-US")}.` };
  }
  const type = PLAN_TYPES.includes(b.type) ? b.type : "Essay";
  return {
    ok: true,
    value: {
      question,
      type,
      wordCount,
      year: oneLine(b.year, 30),
      subject: oneLine(b.subject, 80),
      brief: oneLine(b.brief, 400)
    }
  };
}

// How many sections between the introduction and the conclusion a piece of this
// length can sensibly carry.
export function bodySectionRange(wordCount) {
  if (wordCount < 800) return { min: 2, max: 3 };
  if (wordCount < 1500) return { min: 3, max: 4 };
  if (wordCount < 2500) return { min: 4, max: 5 };
  if (wordCount < 4000) return { min: 5, max: 6 };
  if (wordCount < 8000) return { min: 6, max: 8 };
  return { min: 7, max: 10 };
}

// ---------------------------------------------------------------------
// Choosing the papers
// ---------------------------------------------------------------------

const MAX_QUOTE = 240;

// One verified highlight to show under a paper. `highlights` already passed the
// word-for-word check against the paper's own text when they were made, so any
// of them is safe; this only picks a readable one. A long one is cut at a word
// boundary, which leaves the start of a real sentence, still the paper's words.
export function pickQuote(highlights) {
  const list = (Array.isArray(highlights) ? highlights : [])
    .filter(h => h && typeof h.text === "string" && h.text.trim().length >= 20)
    .map(h => ({ text: oneLine(h.text, 100000), section: h.section === "methods" || h.section === "results" ? h.section : "abstract" }));
  if (!list.length) return null;
  const fits = list.find(h => h.text.length <= MAX_QUOTE);
  if (fits) return fits;
  const shortest = [...list].sort((a, b) => a.text.length - b.text.length)[0];
  return { text: trimToWords(shortest.text, MAX_QUOTE), section: shortest.section };
}

const safeHttp = u => (/^https?:\/\//i.test(String(u ?? "").trim()) ? String(u).trim().slice(0, 500) : null);

// "Okafor et al. 2023" / "Lindqvist and Rahman 2022" / "Hartley 2016".
export function shortCite(paper) {
  const names = String(paper?.authors ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const surname = full => full.split(/\s+/).filter(Boolean).pop() || "";
  let who = "";
  if (names.length === 1) who = surname(names[0]);
  else if (names.length === 2) who = `${surname(names[0])} and ${surname(names[1])}`;
  else if (names.length > 2) who = `${surname(names[0])} et al.`;
  const year = paper?.year ? String(paper.year) : "";
  return [who, year].filter(Boolean).join(" ") || oneLine(paper?.title, 40);
}

function compactPaper(p, ref, quote) {
  return {
    ref,
    title: oneLine(p.title, 220),
    authors: oneLine(p.authors, 300),
    cite: oneLine(shortCite(p), 60),
    journal: oneLine(p.journal && p.journal !== "Unknown venue" ? p.journal : "", 120),
    year: p.year ? oneLine(p.year, 8) : "",
    paperType: p.paperType ? oneLine(p.paperType, 40) : "",
    citedByCount: Number.isFinite(p.citedByCount) ? Math.max(0, Math.round(p.citedByCount)) : null,
    // Search results carry their link as oaUrl (free to read); a DOI link is the
    // fallback. Without this a real result would have no link at all.
    url: safeHttp(p.oaUrl) || safeHttp(p.url) || (p.doi ? safeHttp(`https://doi.org/${String(p.doi).trim()}`) : null),
    // What a folder needs to keep the paper and export its citation.
    doi: p.doi ? oneLine(p.doi, 200) : null,
    authorList: Array.isArray(p.authorList) ? p.authorList.slice(0, 25) : undefined,
    authorTotal: Number.isFinite(p.authorTotal) ? p.authorTotal : undefined,
    abstract: p.abstract ? String(p.abstract).slice(0, 4000) : "",
    isOA: typeof p.isOA === "boolean" ? p.isOA : undefined,
    quote: { text: quote.text, section: quote.section }
  };
}

const paperKey = p => (p.doi ? `doi:${String(p.doi).toLowerCase()}` : `t:${String(p.title || "").toLowerCase().replace(/\W+/g, " ").trim()}`);

// results: what /api/search returns (already ranked, highlighted and scored).
//
// Key reviews: papers the database itself labels a review, systematic review or
// meta-analysis, best suitability first.
// Most cited: the papers with the highest citation counts, from the database's
// own figure. Fewer than `minCites` is not "most cited", so a topic with nothing
// well cited shows nothing here rather than a weak paper under a strong label.
// A paper with no checked quote, a retracted one, a study protocol, or one the
// search scored as a weak fit is never shown.
export function pickKeyPapers(results, { reviews = 2, cited = 2, minSuitability = 60, minCites = 25 } = {}) {
  const seen = new Set();
  const eligible = [];
  for (const p of Array.isArray(results) ? results : []) {
    if (!p || p.retracted || p.paperType === "Study protocol") continue;
    if (!Number.isFinite(p.suitability) || p.suitability < minSuitability) continue;
    const quote = pickQuote(p.highlights);
    if (!quote) continue;
    const key = paperKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push({ p, quote });
  }
  const cites = x => (Number.isFinite(x.p.citedByCount) ? x.p.citedByCount : -1);

  const reviewPicks = eligible
    .filter(x => REVIEW_TYPES.has(x.p.paperType))
    .sort((a, b) => b.p.suitability - a.p.suitability || cites(b) - cites(a))
    .slice(0, reviews);
  const taken = new Set(reviewPicks);
  const citedPicks = eligible
    .filter(x => !taken.has(x) && cites(x) >= minCites)
    .sort((a, b) => cites(b) - cites(a) || b.p.suitability - a.p.suitability)
    .slice(0, cited);

  return {
    reviews: reviewPicks.map((x, i) => compactPaper(x.p, `R${i + 1}`, x.quote)),
    mostCited: citedPicks.map((x, i) => compactPaper(x.p, `C${i + 1}`, x.quote))
  };
}

// ---------------------------------------------------------------------
// Reading and checking the AI's outline
// ---------------------------------------------------------------------

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

// The AI's reply as a list of objects, whatever shape it came in: a clean array,
// an array with a sentence round it, an object wrapping the array, or a reply cut
// off part-way (every complete entry before the cut is kept). Unreadable gives [].
export function parseOutlineReply(raw) {
  const text = String(raw ?? "").replace(/```json|```/g, "").trim();
  let v = tryParse(text);
  if (v === undefined) {
    const a = text.indexOf("[");
    const b = text.lastIndexOf("]");
    if (a !== -1 && b > a) v = tryParse(text.slice(a, b + 1));
  }
  if (v === undefined) v = salvageObjects(text);
  if (v && !Array.isArray(v) && typeof v === "object") v = Object.values(v).find(Array.isArray) ?? [];
  return Array.isArray(v) ? v.filter(e => e && typeof e === "object" && !Array.isArray(e)) : [];
}

const stripHeading = s => oneLine(s, 200)
  .replace(/^[#*>\-\s]+/, "")
  .replace(/^(?:section\s+)?(?:\d+|[A-Ha-h])[.):]\s+/, "")
  .replace(/[*_`]+/g, "")
  .trim();

// A colon between digits ("5:2 diet") is part of the term, so it is kept.
const cleanQuery = s => oneLine(s, 200)
  .replace(/(\d):(\d)/g, "$1\u0001$2")
  .replace(/[^\p{L}\p{N}\s'\u0001-]/gu, " ")
  .replace(/\u0001/g, ":")
  .replace(/\s+/g, " ")
  .trim()
  .split(" ")
  .slice(0, 8)
  .join(" ");

// rawList: parseOutlineReply's output. refs: the set of paper refs that exist
// ("R1", "C2", ...). Returns the usable body sections, or [] when too few survive
// (the caller then says it could not suggest headings, rather than guessing).
// Introduction and Conclusion are added by the code, so an entry with either name
// is dropped here.
export function cleanOutline(rawList, refs, { min = 2, max = 5 } = {}) {
  const valid = refs instanceof Set ? refs : new Set(refs || []);
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(rawList) ? rawList : []) {
    const heading = trimToWords(stripHeading(e.heading), 80);
    if (heading.length < 3) continue;
    if (/^(introduction|conclusions?|conclusion and recommendations?)$/i.test(heading)) continue;
    const key = heading.toLowerCase();
    if (seen.has(key)) continue;
    const cover = trimToWords(e.cover, 170);
    if (cover.length < 10) continue;
    const anchors = [];
    for (const r of Array.isArray(e.anchors) ? e.anchors : []) {
      const ref = String(r ?? "").trim().toUpperCase();
      if (valid.has(ref) && !anchors.includes(ref)) anchors.push(ref);
    }
    const w = Number(e.weight);
    seen.add(key);
    out.push({
      heading,
      cover,
      anchors: anchors.slice(0, 2),
      weight: Number.isFinite(w) ? Math.min(10, Math.max(1, w)) : 5,
      query: cleanQuery(e.query)
    });
    if (out.length === max) break;
  }
  return out.length >= min ? out : [];
}

// ---------------------------------------------------------------------
// The word budget
// ---------------------------------------------------------------------

// Splits `total` words between sections in proportion to `weights`, in whole
// tens (whole fifties for long pieces), and always adds back up to exactly
// `total`. Any odd few words left over by rounding go to the largest section.
export function allocateWords(total, weights) {
  const n = weights.length;
  if (!n) return [];
  const unit = total >= 3000 ? 50 : 10;
  // Weights must be positive; anything else counts as an equal share.
  const w = weights.map(x => (Number.isFinite(x) && x > 0 ? x : 1));
  const sum = w.reduce((a, b) => a + b, 0);
  const raw = w.map(x => (total * x) / sum);
  const out = raw.map(r => Math.floor(r / unit) * unit);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - out[i] })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; left >= unit; k = (k + 1) % n) {
    out[order[k].i] += unit;
    left -= unit;
  }
  if (left > 0) out[out.indexOf(Math.max(...out))] += left;
  return out;
}

const INTRO = {
  Essay: "Say what the question asks, define your key terms and state the position you will argue.",
  "Literature review": "Explain what the review covers, the question it asks and how you searched for sources.",
  Dissertation: "Set out the problem, why it matters, your aim or question and how the work is organised.",
  Report: "State the purpose of the report, its scope and what the reader will find in it."
};
const CONCLUSION = {
  Essay: "Answer the question directly, based on the evidence you have discussed. Add nothing new.",
  "Literature review": "Sum up what the literature shows, where it disagrees and what is still missing.",
  Dissertation: "Answer your question, say what the findings mean and note the limits of the work.",
  Report: "Summarise the main findings and what follows from them."
};

// ---------------------------------------------------------------------
// Putting the plan together
// ---------------------------------------------------------------------

// input: cleanPlanInput's value. picks: pickKeyPapers' output. body: cleanOutline's
// output (may be empty). Returns the plan the app shows and the Word file is built from.
export function assemblePlan(input, picks, body, { now = new Date() } = {}) {
  const papers = [...picks.reviews, ...picks.mostCited];
  const byRef = new Map(papers.map(p => [p.ref, p]));
  const startWith = refs => refs.map(r => byRef.get(r)).filter(Boolean).map(p => ({ ref: p.ref, cite: p.cite }));

  let outline = [];
  if (body.length) {
    const total = input.wordCount;
    const unit = total >= 3000 ? 50 : 10;
    const frac = total >= 8000 ? 0.07 : 0.1;
    const edge = Math.max(unit, Math.round((total * frac) / unit) * unit);
    const bodyWords = allocateWords(total - 2 * edge, body.map(s => s.weight));
    const firstPaper = picks.reviews[0] || picks.mostCited[0];
    outline = [
      { heading: "Introduction", words: edge, cover: INTRO[input.type], startWith: firstPaper ? startWith([firstPaper.ref]) : [], query: "" },
      ...body.map((s, i) => ({ heading: s.heading, words: bodyWords[i], cover: s.cover, startWith: startWith(s.anchors), query: s.query })),
      { heading: "Conclusion", words: edge, cover: CONCLUSION[input.type], startWith: [], query: "" }
    ];
  }

  return {
    version: 1,
    ...input,
    builtOn: now.toISOString().slice(0, 10),
    keyReviews: picks.reviews,
    mostCited: picks.mostCited,
    outline,
    outlineTotal: outline.reduce((a, s) => a + s.words, 0)
  };
}
