import { test } from "node:test";
import assert from "node:assert/strict";
import { LEXICON_DBS, buildLexiconQuery, hasLexiconDb } from "./lexicon-dbs.js";

const concepts = [
  { name: "Exercise", terms: ["exercise", "physical activity"] },
  { name: "Depression", terms: ["depression", "low mood"] }
];

test("1. the original six databases still write the same queries", () => {
  assert.equal(buildLexiconQuery(concepts, "pubmed").query,
    '(exercise[tiab] OR "physical activity"[tiab]) AND (depression[tiab] OR "low mood"[tiab])');
  assert.equal(buildLexiconQuery(concepts, "scopus").query,
    'TITLE-ABS-KEY(exercise OR "physical activity") AND TITLE-ABS-KEY(depression OR "low mood")');
  assert.equal(buildLexiconQuery(concepts, "wos").query,
    'TS=(exercise OR "physical activity") AND TS=(depression OR "low mood")');
  assert.equal(buildLexiconQuery(concepts, "ovid").query,
    '(exercise or "physical activity").ti,ab. and (depression or "low mood").ti,ab.');
  assert.equal(buildLexiconQuery(concepts, "scholar").query,
    '(exercise OR "physical activity") (depression OR "low mood")');
});

test("2. ProQuest searches title and abstract with TIAB()", () => {
  const r = buildLexiconQuery(concepts, "proquest");
  assert.equal(r.query, 'TIAB(exercise OR "physical activity") AND TIAB(depression OR "low mood")');
  assert.equal(r.dbLabel, "ProQuest");
});

test("3. JSTOR quotes every term and tags title and abstract", () => {
  const r = buildLexiconQuery([{ name: "Exercise", terms: ["exercise", "physical activity"] }], "jstor");
  assert.equal(r.query, '(ti:"exercise" OR ab:"exercise" OR ti:"physical activity" OR ab:"physical activity")');
});

test("4. JSTOR joins concepts with a capitalised AND", () => {
  const q = buildLexiconQuery(concepts, "jstor").query;
  assert.ok(q.includes(") AND ("));
  assert.ok(!q.includes(" and "));
});

test("5. Cochrane puts one field label after each grouped concept", () => {
  assert.equal(buildLexiconQuery(concepts, "cochrane").query,
    '(exercise OR "physical activity"):ti,ab,kw AND (depression OR "low mood"):ti,ab,kw');
});

test("6. Westlaw uses & between concepts and lower-case or inside them", () => {
  assert.equal(buildLexiconQuery(concepts, "westlaw").query,
    '(exercise or "physical activity") & (depression or "low mood")');
});

test("7. Lexis+ leaves multi-word terms unquoted because phrases are the default", () => {
  assert.equal(buildLexiconQuery(concepts, "lexis").query,
    '(exercise or physical activity) and (depression or low mood)');
});

test("8. an unknown database falls back to PubMed", () => {
  assert.equal(buildLexiconQuery(concepts, "nonsense").db, "pubmed");
  assert.equal(buildLexiconQuery(concepts, undefined).db, "pubmed");
});

test("9. prototype names are not treated as databases", () => {
  for (const bad of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(hasLexiconDb(bad), false, bad);
    assert.equal(buildLexiconQuery(concepts, bad).db, "pubmed", bad);
  }
});

test("10. every database has a label, a join and a builder, and builds a non-empty query", () => {
  for (const [key, spec] of Object.entries(LEXICON_DBS)) {
    assert.ok(spec.label, key);
    assert.equal(typeof spec.join, "string", key);
    const r = buildLexiconQuery(concepts, key);
    assert.equal(r.db, key);
    assert.ok(r.query.length > 10, key);
    assert.ok(r.query.includes("exercise"), key);
  }
});
