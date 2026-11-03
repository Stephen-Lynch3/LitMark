import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_SOURCES, DEFAULT_WATCH, SOURCE_NAMES,
  createSourceHealth, parseWatchList, repeatSourceLabels, runQuality, tallySources
} from "./source-health.js";

const HOUR = 60 * 60 * 1000;
const silent = { error() {}, warn() {}, log() {} };
const clock = (t = 1_000_000) => {
  const c = { t, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
};
// A search where OpenAlex returned `oa` papers, and Semantic Scholar, Crossref and DOAJ answered normally.
const search = (over = {}) => ({
  "OpenAlex": 25, "Semantic Scholar": 20, "Europe PMC": 0, "CORE": 0, "DOAJ": 6, "Crossref": 22, "ERIC": 0, ...over
});
const ok = (n) => ({ status: "fulfilled", value: Array.from({ length: n }, (_, i) => ({ i })) });
const bad = { status: "rejected", reason: new Error("x") };

// ---------- counting ----------

test("1. tallySources adds up each source across both rounds of a search", () => {
  const labels = repeatSourceLabels(2);
  assert.equal(labels.length, 14);
  const settled = labels.map((name, i) => ok(name === "OpenAlex" ? 10 : name === "Crossref" ? 5 : 0));
  const t = tallySources(settled, labels);
  assert.equal(t["OpenAlex"], 20);
  assert.equal(t["Crossref"], 10);
  assert.equal(t["ERIC"], 0);
});

test("2. a rejected call counts as nothing", () => {
  const labels = repeatSourceLabels(1);
  const t = tallySources(labels.map(n => (n === "OpenAlex" ? bad : ok(3))), labels);
  assert.equal(t["OpenAlex"], 0);
  assert.equal(t["Crossref"], 3);
});

test("3. tallySources follows the labels, not the position, so any call order works", () => {
  const labels = ["Crossref", "OpenAlex", "OpenAlex", "Not a source"];
  const t = tallySources([ok(1), ok(2), ok(3), ok(9)], labels);
  assert.equal(t["Crossref"], 1);
  assert.equal(t["OpenAlex"], 5);
  assert.equal(Object.keys(t).length, SOURCE_NAMES.length);
});

// ---------- run quality ----------

test("4. a normal run is ok", () => {
  assert.equal(runQuality(search()), "ok");
});

test("5. a run with no OpenAlex papers is degraded", () => {
  assert.equal(runQuality(search({ "OpenAlex": 0 })), "degraded");
});

test("6. a run where only OpenAlex answered is still ok: a narrow topic is not a failure", () => {
  const onlyOpenAlex = Object.fromEntries(SOURCE_NAMES.map(n => [n, n === "OpenAlex" ? 12 : 0]));
  assert.equal(runQuality(onlyOpenAlex), "ok");
});

test("7. an empty run is degraded", () => {
  assert.equal(runQuality(Object.fromEntries(SOURCE_NAMES.map(n => [n, 0]))), "degraded");
});

// ---------- raising an alert ----------

test("8. no alert until the source has been quiet for the threshold number of searches", () => {
  const h = createSourceHealth({ threshold: 5, log: silent });
  for (let i = 0; i < 4; i++) assert.deepEqual(h.record(search({ "OpenAlex": 0 })), []);
  const events = h.record(search({ "OpenAlex": 0 }));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "quiet");
  assert.equal(events[0].source, "OpenAlex");
  assert.equal(events[0].streak, 5);
});

test("9. a search where the source answers resets the count", () => {
  const h = createSourceHealth({ threshold: 3, log: silent });
  h.record(search({ "OpenAlex": 0 }));
  h.record(search({ "OpenAlex": 0 }));
  h.record(search()); // answered
  assert.deepEqual(h.record(search({ "OpenAlex": 0 })), []);
  assert.deepEqual(h.record(search({ "OpenAlex": 0 })), []);
  assert.equal(h.record(search({ "OpenAlex": 0 })).length, 1);
});

test("10. a search that nothing else answered does not count against the source", () => {
  const h = createSourceHealth({ threshold: 2, watch: ["OpenAlex"], log: silent });
  const nothing = search({ "OpenAlex": 0, "Semantic Scholar": 0, "DOAJ": 0, "Crossref": 0 });
  for (let i = 0; i < 10; i++) assert.deepEqual(h.record(nothing), []);
  assert.equal(h.snapshot()["OpenAlex"].quietSearchesInARow, 0);
});

test("11. one other source answering is enough to count against a source, unless more are required", () => {
  const onlyOne = search({ "OpenAlex": 0, "Semantic Scholar": 0, "DOAJ": 0 }); // only Crossref answered
  const lenient = createSourceHealth({ threshold: 2, watch: ["OpenAlex"], log: silent });
  lenient.record(onlyOne);
  assert.equal(lenient.record(onlyOne).length, 1);
  const strict = createSourceHealth({ threshold: 2, minOthersActive: 2, watch: ["OpenAlex"], log: silent });
  for (let i = 0; i < 5; i++) assert.deepEqual(strict.record(onlyOne), []);
});

test("12. a source that is not watched never alerts", () => {
  const h = createSourceHealth({ threshold: 2, log: silent }); // default watch: OpenAlex, Semantic Scholar, all sources
  for (let i = 0; i < 20; i++) assert.deepEqual(h.record(search({ "Europe PMC": 0, "ERIC": 0, "CORE": 0 })), []);
});

test("13. two sources going quiet are reported together in one batch", () => {
  const h = createSourceHealth({ threshold: 2, log: silent });
  h.record(search({ "OpenAlex": 0, "Semantic Scholar": 0 }));
  const events = h.record(search({ "OpenAlex": 0, "Semantic Scholar": 0 }));
  assert.deepEqual(events.map(e => e.source).sort(), ["OpenAlex", "Semantic Scholar"]);
});

// ---------- not nagging ----------

test("14. one alert per outage, then a reminder only after the reminder interval", () => {
  const c = clock();
  const h = createSourceHealth({ threshold: 3, reminderMs: 12 * HOUR, now: c.now, watch: ["OpenAlex"], log: silent });
  const dead = search({ "OpenAlex": 0 });
  h.record(dead); h.record(dead);
  assert.equal(h.record(dead).length, 1); // first alert
  for (let i = 0; i < 30; i++) assert.deepEqual(h.record(dead), []); // quiet, but no repeat
  c.advance(12 * HOUR - 1);
  assert.deepEqual(h.record(dead), []);
  c.advance(2);
  const reminder = h.record(dead);
  assert.equal(reminder.length, 1);
  assert.equal(reminder[0].type, "quiet");
});

test("15. a recovery is reported once, and only after an alert", () => {
  const h = createSourceHealth({ threshold: 2, watch: ["OpenAlex"], log: silent });
  assert.deepEqual(h.record(search()), []); // healthy from the start: nothing to report
  h.record(search({ "OpenAlex": 0 }));
  assert.equal(h.record(search({ "OpenAlex": 0 }))[0].type, "quiet");
  const back = h.record(search());
  assert.equal(back.length, 1);
  assert.equal(back[0].type, "recovered");
  assert.deepEqual(h.record(search()), []);
});

test("16. a quiet period shorter than the threshold ends without any email at all", () => {
  const h = createSourceHealth({ threshold: 5, watch: ["OpenAlex"], log: silent });
  h.record(search({ "OpenAlex": 0 }));
  h.record(search({ "OpenAlex": 0 }));
  assert.deepEqual(h.record(search()), []);
});

test("17. a second outage after a recovery alerts again straight away once the threshold is reached", () => {
  const h = createSourceHealth({ threshold: 2, watch: ["OpenAlex"], log: silent });
  h.record(search({ "OpenAlex": 0 }));
  assert.equal(h.record(search({ "OpenAlex": 0 })).length, 1);
  assert.equal(h.record(search())[0].type, "recovered");
  h.record(search({ "OpenAlex": 0 }));
  assert.equal(h.record(search({ "OpenAlex": 0 }))[0].type, "quiet");
});

// ---------- the reason ----------

test("18. the last recent error is attached to the alert", () => {
  const c = clock();
  const h = createSourceHealth({ threshold: 2, watch: ["OpenAlex"], now: c.now, log: silent });
  h.noteError("OpenAlex", "OpenAlex 429");
  h.record(search({ "OpenAlex": 0 }));
  const [e] = h.record(search({ "OpenAlex": 0 }));
  assert.equal(e.lastError, "OpenAlex 429");
});

test("19. an old error is not quoted as the reason", () => {
  const c = clock();
  const h = createSourceHealth({ threshold: 2, watch: ["OpenAlex"], errorFreshMs: 30 * 60 * 1000, now: c.now, log: silent });
  h.noteError("OpenAlex", "OpenAlex 429");
  c.advance(2 * HOUR);
  h.record(search({ "OpenAlex": 0 }));
  const [e] = h.record(search({ "OpenAlex": 0 }));
  assert.equal(e.lastError, null);
});

test("20. very long error text is trimmed", () => {
  const h = createSourceHealth({ threshold: 1, watch: ["OpenAlex"], log: silent });
  h.noteError("OpenAlex", "x".repeat(5000));
  const [e] = h.record(search({ "OpenAlex": 0 }));
  assert.ok(e.lastError.length <= 300);
});

// ---------- the all-sources alarm ----------

test("21. every source returning nothing for several searches raises one all-sources alert", () => {
  const h = createSourceHealth({ threshold: 3, watch: [ALL_SOURCES], log: silent });
  const nothing = Object.fromEntries(SOURCE_NAMES.map(n => [n, 0]));
  h.record(nothing); h.record(nothing);
  const [e] = h.record(nothing);
  assert.equal(e.source, ALL_SOURCES);
  assert.equal(e.type, "quiet");
  assert.deepEqual(h.record(nothing), []);
});

test("22. one ordinary search resets the all-sources count", () => {
  const h = createSourceHealth({ threshold: 3, watch: [ALL_SOURCES], log: silent });
  const nothing = Object.fromEntries(SOURCE_NAMES.map(n => [n, 0]));
  h.record(nothing); h.record(nothing);
  h.record(search());
  assert.deepEqual(h.record(nothing), []);
  assert.deepEqual(h.record(nothing), []);
});

// ---------- delivering the news ----------

test("23. notify gets the whole batch once", () => {
  const batches = [];
  const h = createSourceHealth({ threshold: 1, notify: (events) => batches.push(events), log: silent });
  h.record(search({ "OpenAlex": 0, "Semantic Scholar": 0 }));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
});

test("24. notify is not called when there is nothing to report", () => {
  let calls = 0;
  const h = createSourceHealth({ threshold: 5, notify: () => { calls++; }, log: silent });
  for (let i = 0; i < 10; i++) h.record(search());
  assert.equal(calls, 0);
});

test("25. a notify that throws or rejects cannot break the search that triggered it", async () => {
  const errors = [];
  const log = { error: (...a) => errors.push(a.join(" ")) };
  const throwing = createSourceHealth({ threshold: 1, watch: ["OpenAlex"], notify: () => { throw new Error("mail down"); }, log });
  assert.doesNotThrow(() => throwing.record(search({ "OpenAlex": 0 })));
  const rejecting = createSourceHealth({ threshold: 1, watch: ["OpenAlex"], notify: () => Promise.reject(new Error("resend 403")), log });
  assert.doesNotThrow(() => rejecting.record(search({ "OpenAlex": 0 })));
  await new Promise(r => setImmediate(r));
  assert.ok(errors.some(e => /mail down/.test(e)));
  assert.ok(errors.some(e => /resend 403/.test(e)));
});

test("26. snapshot reports the count, alert state and last error for each watched source", () => {
  const h = createSourceHealth({ threshold: 2, log: silent });
  h.noteError("OpenAlex", "OpenAlex 402");
  h.record(search({ "OpenAlex": 0 }));
  const s = h.snapshot();
  assert.deepEqual(Object.keys(s), DEFAULT_WATCH);
  assert.equal(s["OpenAlex"].quietSearchesInARow, 1);
  assert.equal(s["OpenAlex"].alerted, false);
  assert.equal(s["OpenAlex"].lastError, "OpenAlex 402");
  assert.equal(s["Semantic Scholar"].quietSearchesInARow, 0);
});

// ---------- configuration ----------

test("27. parseWatchList accepts names in any case or spacing", () => {
  assert.deepEqual(parseWatchList("openalex, SEMANTIC scholar ,crossref"), ["OpenAlex", "Semantic Scholar", "Crossref"]); // allowed if asked for
  assert.deepEqual(parseWatchList("All sources"), [ALL_SOURCES]);
});

test("28. parseWatchList falls back to the default for empty or unrecognised values", () => {
  assert.deepEqual(parseWatchList(""), DEFAULT_WATCH);
  assert.deepEqual(parseWatchList(undefined), DEFAULT_WATCH);
  assert.deepEqual(parseWatchList("nonsense, other"), DEFAULT_WATCH);
});

test("29. parseWatchList drops unknown names and duplicates but keeps the rest", () => {
  assert.deepEqual(parseWatchList("OpenAlex, bogus, openalex, DOAJ"), ["OpenAlex", "DOAJ"]);
});
