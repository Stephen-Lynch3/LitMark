// The pure parts of the highlight step, kept apart from server.js so they can be
// unit-tested (`npm test`): reading the AI's reply, checking its quotes against
// the paper's own text, and putting a second pass of highlights back onto the
// papers they belong to.
//
// The rule that never changes: a highlight is only shown if its text is found in
// the paper's own abstract (or Methods / Results excerpt), and what is shown is
// the paper's wording, not the AI's. Everything here fails closed: a reply that
// can't be read gives fewer highlights, never an invented one.

import { locateQuote } from "./search-rank.js";

// ---------------------------------------------------------------------
// Cleaning abstracts as they come in from the sources
// ---------------------------------------------------------------------

// Tags that start a new block of text. A paragraph break must become a space,
// otherwise "...the end.</p><p>Next..." reads "...the end.Next..." and the
// sentence the AI quotes can no longer be found.
const BLOCK_TAG = /<\/?(?:[A-Za-z][\w-]*:)?(?:p|div|br|li|ul|ol|list|list-item|title|sec|abstract|label|h[1-6])\b[^>]*>/gi;
const ANY_TAG = /<\/?[A-Za-z][^>]*>/g;
// Characters that print as nothing but stop a quote matching: soft hyphens
// (publishers hyphenate long words), zero-width spaces, byte-order marks.
const INVISIBLE = /[­​⁠﻿]/g;

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => safeCodePoint(parseInt(h, 16), m))
    .replace(/&#(\d{1,7});/g, (m, d) => safeCodePoint(parseInt(d, 10), m))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (m, n) => NAMED[n.toLowerCase()])
    .replace(/&#39;/g, "'");
}

function safeCodePoint(n, fallback) {
  return Number.isInteger(n) && n > 31 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : fallback;
}

// `markup: true` for the sources whose abstracts can carry XML/HTML (Crossref's
// JATS, Europe PMC). The others are plain text, where a "<" is a less-than sign
// ("p<0.05"), so tags are not looked for there.
export function cleanAbstractText(raw, { markup = false } = {}) {
  if (raw == null) return null;
  let s = String(raw);
  if (markup) {
    // Crossref starts many abstracts with <jats:title>Abstract</jats:title>: a label, not text.
    s = s.replace(/^\s*<(?:[A-Za-z][\w-]*:)?title>\s*abstract\s*<\/(?:[A-Za-z][\w-]*:)?title>/i, "");
    s = s.replace(BLOCK_TAG, " ").replace(ANY_TAG, "");
    s = decodeEntities(s);
  }
  s = s.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return s || null;
}

// ---------------------------------------------------------------------
// Reading the AI's reply
// ---------------------------------------------------------------------

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

// A reply cut off part-way (the model ran out of room) still holds complete
// entries before the cut. Walk the array and keep each object that closed.
export function salvageObjects(text) {
  const out = [];
  const start = text.indexOf("[");
  if (start === -1) return out;
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") { if (depth === 0) objStart = i; depth++; }
    else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && objStart !== -1) {
        const o = tryParse(text.slice(objStart, i + 1));
        if (o && typeof o === "object") out.push(o);
        objStart = -1;
      }
    }
  }
  return out;
}

// Returns an array of { index: integer, ...rest }, whatever shape the reply came
// in: a clean array, an array with a sentence before or after it, an object that
// wraps the array, or an array cut off part-way. An unreadable reply gives [].
export function parseHighlightReply(raw) {
  const text = String(raw ?? "").replace(/```json|```/g, "").trim();
  let v = tryParse(text);
  if (v === undefined) {
    const a = text.indexOf("[");
    const b = text.lastIndexOf("]");
    if (a !== -1 && b > a) v = tryParse(text.slice(a, b + 1));
  }
  if (v === undefined) v = salvageObjects(text);
  if (v && !Array.isArray(v) && typeof v === "object") {
    // One paper's entry on its own has an `index`; otherwise look for an array inside.
    v = v.index !== undefined ? [v] : (Object.values(v).find(Array.isArray) ?? []);
  }
  if (!Array.isArray(v)) return [];
  const entries = [];
  for (const e of v) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const idx = typeof e.index === "string" && e.index.trim() !== "" ? Number(e.index) : e.index;
    if (!Number.isInteger(idx)) continue;
    entries.push({ ...e, index: idx });
  }
  return entries;
}

// ---------------------------------------------------------------------
// Checking the quotes
// ---------------------------------------------------------------------

const SECTIONS = ["abstract", "methods", "results"];
const FIELD = { abstract: "abstract", methods: "methodsExcerpt", results: "resultsExcerpt" };

// Two highlights that overlap (or one inside the other) are one highlight:
// otherwise the same words are shown twice. They become one stretch of the
// paper's own text, taken from the paper, so it is still word for word.
function mergeOverlaps(found, paper) {
  const result = [];
  for (const section of SECTIONS) {
    const source = paper[FIELD[section]];
    const items = found
      .map((h, i) => ({ ...h, i }))
      .filter(h => h.section === section)
      .map(h => {
        const start = typeof source === "string" ? source.indexOf(h.text) : -1;
        return { ...h, start, end: start === -1 ? -1 : start + h.text.length };
      });
    const placed = items.filter(h => h.start !== -1).sort((a, b) => a.start - b.start);
    const loose = items.filter(h => h.start === -1);
    let cur = null;
    for (const h of placed) {
      if (cur && h.start < cur.end) {
        cur.end = Math.max(cur.end, h.end);
        cur.i = Math.min(cur.i, h.i);
        if (!cur.reason && h.reason) cur.reason = h.reason;
      } else {
        if (cur) result.push(cur);
        cur = { ...h };
      }
    }
    if (cur) result.push(cur);
    result.push(...loose);
  }
  return result
    .map(h => h.start === undefined || h.start === -1 ? h : { ...h, text: paper[FIELD[h.section]].slice(h.start, h.end) })
    .sort((a, b) => a.i - b.i)
    .map(({ text, reason, section }) => ({ text, reason, section }));
}

// rawList: what the model gave as `highlights` for one paper. Returns at most two
// verified highlights { text, reason, section }. A quote the model labelled with
// the wrong section is still found if it really is in another part of the paper.
export function resolveHighlights(rawList, paper) {
  const found = [];
  for (const h of Array.isArray(rawList) ? rawList : []) {
    const quote = typeof h === "string" ? h : h?.text;
    const reason = typeof h?.reason === "string" ? h.reason : "";
    const declared = SECTIONS.includes(h?.section) ? h.section : "abstract";
    for (const section of [declared, ...SECTIONS.filter(s => s !== declared)]) {
      const text = locateQuote(paper[FIELD[section]], quote);
      if (text) { found.push({ text, reason, section }); break; }
    }
  }
  return mergeOverlaps(found, paper).slice(0, 2);
}

// ---------------------------------------------------------------------
// The second pass (with full-text excerpts)
// ---------------------------------------------------------------------

// `original` is the paper as it was; `redo` is what the second pass returned for
// it (or undefined). The second pass only ever adds: if it gave nothing usable
// the first pass's highlights stay. Everything else about the paper, including
// which side of For & against it belongs to, is taken from the original.
export function mergeReHighlight(original, redo) {
  if (!redo || !Array.isArray(redo.highlights) || redo.highlights.length === 0) return original;
  return {
    ...original,
    highlights: redo.highlights,
    suitability: redo.suitability ?? original.suitability,
    relevance: redo.relevance ?? original.relevance
  };
}

// Runs `highlight` (the AI step: takes a list of papers, returns the ones it
// scored, each with `highlights`, `suitability`, `relevance`) over `papers` and
// puts the results back on the right papers. Each paper is matched back to ITSELF
// by its position, not by id: a paper found by both For & against searches
// appears twice (once per side) with the same id, and matching on id let the
// second copy overwrite the first, so it showed twice under Challenging and not
// at all under Supporting. Returns a list the same length and order as `papers`.
export async function reHighlightPapers(papers, highlight) {
  const redone = await highlight(papers.map((p, i) => ({ ...p, _slot: i })));
  const bySlot = new Map((redone || []).map(p => [p._slot, p]));
  return papers.map((p, i) => mergeReHighlight(p, bySlot.get(i)));
}
