import { test } from "node:test";
import assert from "node:assert/strict";
import { addAuthorCandidates, authorFirst, authorMatches, buildAuthorPrompt, cleanAuthorNames, norm, stripAuthorNames } from "./author-search.js";

const Q = "does cudzik trauma models lead to better diagnosis";

test("1. a name the student typed is kept; a clean array, a wrapped one and fenced JSON all read", () => {
  assert.deepEqual(cleanAuthorNames('["Cudzik"]', Q), ["Cudzik"]);
  assert.deepEqual(cleanAuthorNames('Here you go: ["Cudzik"] done', Q), ["Cudzik"]);
  assert.deepEqual(cleanAuthorNames('```json\n["cudzik"]\n```', Q), ["cudzik"]);
});

test("2. a name that is not in the question is dropped, so the AI cannot invent one", () => {
  assert.deepEqual(cleanAuthorNames('["Smith"]', Q), []);
  assert.deepEqual(cleanAuthorNames('["Cudzik", "Smith"]', Q), ["Cudzik"]);
});

test("3. rubbish replies give no names, never an error", () => {
  for (const bad of ["", "no names", "{}", "[1,2]", "[\"<script>\"]", null, undefined, '["' + "x".repeat(80) + '"]']) assert.deepEqual(cleanAuthorNames(bad, Q), []);
});

test("4. at most two names, no repeats, et al. removed, first names kept", () => {
  const q = "Jane Cudzik and Tom Badrick and Smith on trauma";
  assert.deepEqual(cleanAuthorNames('["Jane Cudzik","Tom Badrick","Smith"]', q), ["Jane Cudzik", "Tom Badrick"]);
  assert.deepEqual(cleanAuthorNames('["Cudzik et al.","cudzik"]', "Cudzik et al. trauma"), ["Cudzik"]);
});

test("5. a surname matches the paper's real authors, ignoring case and accents", () => {
  assert.equal(authorMatches({ authorList: [{ given: "Tom", family: "Badrick" }, { given: "Anna", family: "Čudzik" }] }, ["cudzik"]), true);
  assert.equal(authorMatches({ authors: "F Bowling, T Badrick" }, ["Cudzik"]), false);
  assert.equal(authorMatches({ authors: "Jan Cudzik, T Badrick" }, ["Cudzik"]), true);
});

test("6. a first name must agree when the student gave one", () => {
  const p = { authorList: [{ given: "Anna", family: "Cudzik" }] };
  assert.equal(authorMatches(p, ["Anna Cudzik"]), true);
  assert.equal(authorMatches(p, ["John Cudzik"]), false);
  assert.equal(authorMatches({ authorList: [{ given: "", family: "Cudzik" }] }, ["John Cudzik"]), true);
});

test("7. a surname inside a longer one does not match", () => {
  assert.equal(authorMatches({ authorList: [{ given: "A", family: "Cudzikowski" }] }, ["Cudzik"]), false);
  assert.equal(authorMatches({ authorList: [{ given: "A", family: "van Cudzik" }] }, ["Cudzik"]), true);
  assert.equal(authorMatches({}, ["Cudzik"]), false);
  assert.equal(authorMatches({ authors: "A Cudzik" }, []), false);
});

test("8. the name is taken out of a search query, unless nothing useful would be left", () => {
  assert.equal(stripAuthorNames("cudzik trauma models diagnosis", ["Cudzik"]), "trauma models diagnosis");
  assert.equal(stripAuthorNames("Cudzik's trauma model", ["Cudzik"]), "trauma model");
  assert.equal(stripAuthorNames("Cudzik et al. trauma models", ["Cudzik"]), "trauma models");
  assert.equal(stripAuthorNames("cudzik trauma", ["Cudzik"]), "cudzik trauma");
  assert.equal(stripAuthorNames("trauma and Cudzikowski", ["Cudzik"]), "trauma and Cudzikowski");
});

test("9. the author's papers the topic search left out are added, without duplicates, up to the limit", () => {
  const mk = (t, f, doi) => ({ title: t, doi, authorList: [{ given: "A", family: f }] });
  const all = [mk("T1", "Cudzik", "10.1/a"), mk("T2", "Other", "10.1/b"), mk("T3", "Cudzik", "10.1/c"), mk("T4", "Cudzik", null), mk("T5", "Cudzik", "10.1/e")];
  const chosen = [all[0], all[1]];
  const out = addAuthorCandidates(chosen, all, ["Cudzik"], 2);
  assert.deepEqual(out.map(p => p.title), ["T1", "T2", "T3", "T4"]);
  assert.deepEqual(addAuthorCandidates(chosen, all, [], 5).length, 2);
});

test("10. papers by the author come first and are marked; the rest keep their order", () => {
  const mk = (t, f) => ({ title: t, authorList: [{ given: "A", family: f }] });
  const r = authorFirst([mk("a", "X"), mk("b", "Cudzik"), mk("c", "Y"), mk("d", "Cudzik")], ["Cudzik"]);
  assert.deepEqual(r.results.map(p => p.title), ["b", "d", "a", "c"]);
  assert.equal(r.matched, 2);
  assert.equal(r.results[0].authorMatch, true);
  assert.equal(r.results[2].authorMatch, undefined);
});

test("11. the prompt carries the student's words and norm tidies text", () => {
  assert.match(buildAuthorPrompt(Q), /cudzik trauma models/);
  assert.equal(norm("Čudzik-Ó'Neil  Jr."), "cudzik-o'neil jr");
});
