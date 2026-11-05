// Getting a student's question into the form each source will accept.
//
// Every source is searched twice per question: once with the student's own words,
// once with a distilled keyword query. The student's own words are full of
// punctuation ("Does fasting improve insulin sensitivity in adults?").
//
// DOAJ runs the query as Elasticsearch/Lucene query-string syntax and has switched
// off wildcards, regular expressions, fuzzy and proximity searches. So a "?" or "*"
// (wildcard), a "/" (regular expression), a "~" (fuzzy), or a stray ":", quote or
// bracket gets the whole request refused with HTTP 400, and DOAJ contributed
// nothing for that query. Plain words are all it needs, so everything that has a
// special meaning to it is turned into a space.
//
// Kept apart from server.js so it can be unit-tested: `npm test`.

const LUCENE_SPECIAL = /[?*~\/\\^:()[\]{}"!+=&|<>]/g;

// Returns the query as plain words, or "" when nothing searchable is left (the
// caller should then skip the request rather than send an empty search).
export function doajSafeQuery(query) {
  return String(query ?? "")
    .replace(LUCENE_SPECIAL, " ")
    .replace(/(^|\s)-+/g, "$1")          // a leading "-" would mean "exclude this word"
    .replace(/\b(AND|OR|NOT)\b/g, w => w.toLowerCase()) // as capitals these are operators
    .replace(/\s+/g, " ")
    .trim();
}

// An API key pasted into a hosting dashboard often arrives with a trailing
// newline, spaces, or quote marks around it, and the source then answers 401
// ("not authorised") even though the key itself is fine.
export function cleanApiKey(raw) {
  return String(raw ?? "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
}
