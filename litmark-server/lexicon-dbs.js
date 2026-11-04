// Database Search: how each library database writes the same Boolean search.
//
// Claude only ever returns plain terms. This file turns those terms into the
// database's own syntax mechanically, so a malformed query can never come from
// the model. Each entry follows that database's published help:
//
//   PubMed          [tiab] tag after each term
//   Scopus          TITLE-ABS-KEY( ... )
//   Web of Science  TS=( ... )
//   EBSCOhost       the field code repeats per term: TI "x" OR AB "x"
//   Ovid            a suffix after the group: (x or y).ti,ab.
//   Google Scholar  no field tags exist, so a plain grouped query
//   ProQuest        TIAB( ... ) in Command Line Search (ProQuest's own pages list
//                   TITLE( ) and ABSTRACT( ); TIAB is the combined form used in
//                   university ProQuest guides)
//   JSTOR           ti:"x" and ab:"x" typed into the search box, parentheses
//                   group, operators must be ALL CAPS
//   Cochrane        (x OR y):ti,ab,kw  with one label for the whole group
//   Westlaw (UK)    & for AND, "or" for OR, quote marks for phrases
//   Lexis+ (UK)     and / or, multi-word terms are phrases by default
//
// LitMark cannot run searches in the licensed databases (they have no open API
// and need the student's own university login). These are query writers only.

export const quoteTerm = t => t.includes(" ") ? `"${t}"` : t;

// JSTOR's field syntax always takes a quoted term.
const alwaysQuote = t => `"${t}"`;

export const LEXICON_DBS = {
  pubmed:   { label: "PubMed",         join: " AND ", concept: ts => "(" + ts.map(t => `${quoteTerm(t)}[tiab]`).join(" OR ") + ")" },
  scopus:   { label: "Scopus",         join: " AND ", concept: ts => "TITLE-ABS-KEY(" + ts.map(quoteTerm).join(" OR ") + ")" },
  wos:      { label: "Web of Science", join: " AND ", concept: ts => "TS=(" + ts.map(quoteTerm).join(" OR ") + ")" },
  ebsco:    { label: "EBSCOhost (PsycINFO, ERIC, CINAHL…)", join: " AND ", concept: ts => "(" + ts.flatMap(t => [`TI ${quoteTerm(t)}`, `AB ${quoteTerm(t)}`]).join(" OR ") + ")" },
  ovid:     { label: "Ovid (MEDLINE, PsycINFO, Embase…)", join: " and ", concept: ts => "(" + ts.map(quoteTerm).join(" or ") + ").ti,ab." },
  proquest: { label: "ProQuest",       join: " AND ", concept: ts => "TIAB(" + ts.map(quoteTerm).join(" OR ") + ")" },
  jstor:    { label: "JSTOR",          join: " AND ", concept: ts => "(" + ts.flatMap(t => [`ti:${alwaysQuote(t)}`, `ab:${alwaysQuote(t)}`]).join(" OR ") + ")" },
  cochrane: { label: "Cochrane Library", join: " AND ", concept: ts => "(" + ts.map(quoteTerm).join(" OR ") + "):ti,ab,kw" },
  westlaw:  { label: "Westlaw",        join: " & ",   concept: ts => "(" + ts.map(quoteTerm).join(" or ") + ")" },
  lexis:    { label: "Lexis+",         join: " and ", concept: ts => "(" + ts.join(" or ") + ")" },
  scholar:  { label: "Google Scholar", join: " ",     concept: ts => "(" + ts.map(quoteTerm).join(" OR ") + ")" }
};

export function hasLexiconDb(db) {
  return typeof db === "string" && Object.prototype.hasOwnProperty.call(LEXICON_DBS, db);
}

// concepts: [{ name, terms: [string] }]. An unknown database falls back to PubMed.
export function buildLexiconQuery(concepts, db = "pubmed") {
  const key = hasLexiconDb(db) ? db : "pubmed";
  const spec = LEXICON_DBS[key];
  const query = concepts.map(c => spec.concept(c.terms)).join(spec.join);
  return { query, db: key, dbLabel: spec.label };
}

// The model is told to answer with JSON only, but on some questions it adds a
// sentence before or after. Take the outermost {...} so that still parses.
export function extractJsonObject(raw) {
  const text = String(raw || "").replace(/```json|```/g, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start ? text.slice(start, end + 1) : text;
}
