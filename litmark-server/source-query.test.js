import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanApiKey, doajSafeQuery } from "./source-query.js";

test("1. a question mark is removed: it is a DOAJ wildcard and gets the request refused", () => {
  assert.equal(doajSafeQuery("Does intermittent fasting improve insulin sensitivity in adults?"),
    "Does intermittent fasting improve insulin sensitivity in adults");
});

test("2. other Lucene symbols become spaces so words are not run together", () => {
  assert.equal(doajSafeQuery('HIV/AIDS: "stigma" (adults) [UK] {2020} a~b c*d e^2 !x +y =z &w |v <u> t\\s'),
    "HIV AIDS stigma adults UK 2020 a b c d e 2 x y z w v u t s");
});

test("3. plain keyword queries come back unchanged, hyphens inside words included", () => {
  assert.equal(doajSafeQuery("time-restricted eating insulin sensitivity prediabetes"),
    "time-restricted eating insulin sensitivity prediabetes");
  assert.equal(doajSafeQuery("O'Brien's theory of attachment"), "O'Brien's theory of attachment");
});

test("4. a leading minus (meaning exclude) is dropped, and capital AND / OR / NOT stop being operators", () => {
  assert.equal(doajSafeQuery("-fasting NOT diet"), "fasting not diet");
  assert.equal(doajSafeQuery("cats AND dogs OR birds"), "cats and dogs or birds");
});

test("5. nothing searchable left gives an empty string so the request is skipped", () => {
  assert.equal(doajSafeQuery("?"), "");
  assert.equal(doajSafeQuery(" ?! // :: "), "");
  assert.equal(doajSafeQuery(undefined), "");
  assert.equal(doajSafeQuery(null), "");
});

test("6. whitespace is tidied", () => {
  assert.equal(doajSafeQuery("  gut   microbiome \n and\tdepression  "), "gut microbiome and depression");
});

test("7. an API key with a newline, spaces or quote marks around it is cleaned", () => {
  assert.equal(cleanApiKey("abc123\n"), "abc123");
  assert.equal(cleanApiKey('  "abc123"  '), "abc123");
  assert.equal(cleanApiKey("'abc123'"), "abc123");
  assert.equal(cleanApiKey(undefined), "");
  assert.equal(cleanApiKey(""), "");
});
