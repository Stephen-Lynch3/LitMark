import { test } from "node:test";
import assert from "node:assert/strict";
import { createResponseCache, normalizeQuestion, searchCacheKey } from "./response-cache.js";

const HOUR = 60 * 60 * 1000;
const ok = (value, extra = {}) => ({ value, cacheable: true, ...extra });
const clock = (t = 1_000_000) => {
  const c = { t, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- keys ----------

test("1. the same question in different case, spacing and trailing punctuation shares a key", () => {
  const a = searchCacheKey("search", "Does social media harm teenagers?");
  assert.equal(a, searchCacheKey("search", "  does   SOCIAL media harm teenagers ?? "));
  assert.equal(a, searchCacheKey("search", "does social media harm teenagers"));
});

test("2. a different question, year, paywall setting or search kind is a different key", () => {
  const base = searchCacheKey("search", "q about sleep", { minYear: 2015 });
  assert.notEqual(base, searchCacheKey("search", "q about sleep", { minYear: 2020 }));
  assert.notEqual(base, searchCacheKey("search", "q about sleep", { minYear: null }));
  assert.notEqual(base, searchCacheKey("search", "q about sleep", { minYear: 2015, includePaywalled: true }));
  assert.notEqual(base, searchCacheKey("critical", "q about sleep", { minYear: 2015 }));
  assert.notEqual(base, searchCacheKey("search", "q about exercise", { minYear: 2015 }));
});

test("3. a NaN year (from a bad query string) is treated as no year, not a separate key", () => {
  assert.equal(searchCacheKey("search", "x", { minYear: NaN }), searchCacheKey("search", "x", { minYear: null }));
});

test("4. normalizeQuestion keeps punctuation inside the question", () => {
  assert.equal(normalizeQuestion("Is it A, or B?"), "is it a, or b");
  assert.equal(normalizeQuestion(null), "");
});

// ---------- hits, misses, copies ----------

test("5. the second identical request is served from memory without recomputing", async () => {
  const cache = createResponseCache();
  let calls = 0;
  const compute = async () => { calls++; return ok({ results: [{ id: 1 }] }); };
  const first = await cache.run("k", compute);
  const second = await cache.run("k", compute);
  assert.equal(calls, 1);
  assert.equal(first.status, "miss");
  assert.equal(second.status, "hit");
  assert.deepEqual(second.value, { results: [{ id: 1 }] });
});

test("6. a caller changing its answer cannot change what the next caller gets", async () => {
  const cache = createResponseCache();
  await cache.run("k", async () => ok({ results: [{ id: 1 }] }));
  const a = await cache.run("k", async () => ok({}));
  a.value.results.push({ id: 99 });
  a.value.extra = true;
  const b = await cache.run("k", async () => ok({}));
  assert.deepEqual(b.value, { results: [{ id: 1 }] });
});

test("7. different keys do not interfere", async () => {
  const cache = createResponseCache();
  await cache.run("a", async () => ok({ n: 1 }));
  await cache.run("b", async () => ok({ n: 2 }));
  assert.equal((await cache.run("a", async () => ok({ n: 0 }))).value.n, 1);
  assert.equal((await cache.run("b", async () => ok({ n: 0 }))).value.n, 2);
});

// ---------- expiry ----------

test("8. an answer expires after the time to live", async () => {
  const c = clock();
  const cache = createResponseCache({ ttlMs: 12 * HOUR, now: c.now });
  let calls = 0;
  const compute = async () => { calls++; return ok({ calls }); };
  await cache.run("k", compute);
  c.advance(12 * HOUR - 1);
  assert.equal((await cache.run("k", compute)).status, "hit");
  c.advance(2);
  const after = await cache.run("k", compute);
  assert.equal(after.status, "miss");
  assert.equal(after.value.calls, 2);
});

test("9. a single answer can carry its own shorter life", async () => {
  const c = clock();
  const cache = createResponseCache({ ttlMs: 12 * HOUR, now: c.now });
  let calls = 0;
  const compute = async () => { calls++; return ok({ calls }, { ttlMs: HOUR }); };
  await cache.run("k", compute);
  c.advance(HOUR + 1);
  assert.equal((await cache.run("k", compute)).status, "miss");
  assert.equal(calls, 2);
});

// ---------- what is not kept ----------

test("10. an answer marked not cacheable is returned but not stored", async () => {
  const cache = createResponseCache();
  let calls = 0;
  const compute = async () => { calls++; return { value: { results: [] }, cacheable: false }; };
  const a = await cache.run("k", compute);
  const b = await cache.run("k", compute);
  assert.deepEqual(a.value, { results: [] });
  assert.equal(b.status, "miss");
  assert.equal(calls, 2);
});

test("11. a failed run is not stored, and the next request tries again", async () => {
  const cache = createResponseCache();
  let calls = 0;
  const compute = async () => { calls++; if (calls === 1) throw new Error("boom"); return ok({ fine: true }); };
  await assert.rejects(() => cache.run("k", compute), /boom/);
  assert.equal(cache.stats().inFlight, 0);
  const again = await cache.run("k", compute);
  assert.deepEqual(again.value, { fine: true });
  assert.equal(calls, 2);
});

test("12. an answer over the per-entry size limit is not stored", async () => {
  const cache = createResponseCache({ maxEntryBytes: 1000 });
  const big = { text: "x".repeat(2000) };
  let calls = 0;
  const compute = async () => { calls++; return ok(big); };
  await cache.run("k", compute);
  await cache.run("k", compute);
  assert.equal(calls, 2);
  assert.equal(cache.stats().entries, 0);
});

test("13. a ttl of zero turns the cache off completely", async () => {
  const cache = createResponseCache({ ttlMs: 0 });
  let calls = 0;
  const compute = async () => { calls++; return ok({ calls }); };
  const a = await cache.run("k", compute);
  const b = await cache.run("k", compute);
  assert.equal(calls, 2);
  assert.equal(a.status, "bypass");
  assert.equal(b.status, "bypass");
});

test("14. bypass skips the cache for one call but leaves what is stored alone", async () => {
  const cache = createResponseCache();
  await cache.run("k", async () => ok({ v: "old" }));
  const fresh = await cache.run("k", async () => ok({ v: "new" }), { bypass: true });
  assert.equal(fresh.status, "bypass");
  assert.equal(fresh.value.v, "new");
  assert.equal((await cache.run("k", async () => ok({ v: "x" }))).value.v, "old");
});

// ---------- people asking at the same moment ----------

test("15. identical requests made together share one run", async () => {
  const cache = createResponseCache();
  let calls = 0;
  const compute = async () => { calls++; await sleep(20); return ok({ results: [1, 2, 3] }); };
  const all = await Promise.all(Array.from({ length: 6 }, () => cache.run("k", compute)));
  assert.equal(calls, 1);
  assert.deepEqual(all.map(r => r.status).sort(), ["joined", "joined", "joined", "joined", "joined", "miss"]);
  for (const r of all) assert.deepEqual(r.value, { results: [1, 2, 3] });
  // and they are separate copies
  all[1].value.results.push(4);
  assert.deepEqual(all[2].value.results, [1, 2, 3]);
});

test("16. when a shared run fails, everyone waiting on it gets the error and nothing is kept", async () => {
  const cache = createResponseCache();
  let calls = 0;
  const compute = async () => { calls++; await sleep(10); throw new Error("sources down"); };
  const settled = await Promise.allSettled([cache.run("k", compute), cache.run("k", compute), cache.run("k", compute)]);
  assert.equal(calls, 1);
  assert.ok(settled.every(s => s.status === "rejected" && /sources down/.test(s.reason.message)));
  assert.equal(cache.stats().inFlight, 0);
  assert.equal(cache.stats().entries, 0);
});

test("17. a shared run that is not cacheable still reaches everyone waiting, and is not stored", async () => {
  const cache = createResponseCache();
  let calls = 0;
  const compute = async () => { calls++; await sleep(10); return { value: { results: [] }, cacheable: false }; };
  const all = await Promise.all([cache.run("k", compute), cache.run("k", compute)]);
  assert.equal(calls, 1);
  assert.ok(all.every(r => r.value.results.length === 0));
  assert.equal(cache.stats().entries, 0);
});

test("18. a run that has hung for too long is not waited for", async () => {
  const c = clock();
  const cache = createResponseCache({ inflightMaxMs: 1000, now: c.now });
  let release;
  const stuck = cache.run("k", () => new Promise(r => { release = () => r(ok({ n: "old" })); }));
  c.advance(5000);
  const fresh = await cache.run("k", async () => ok({ n: "fresh" }));
  assert.equal(fresh.status, "miss");
  assert.equal(fresh.value.n, "fresh");
  release();
  await stuck;
});

test("19. different questions run side by side without sharing", async () => {
  const cache = createResponseCache();
  let calls = 0;
  const compute = (n) => async () => { calls++; await sleep(10); return ok({ n }); };
  const [a, b] = await Promise.all([cache.run("a", compute("a")), cache.run("b", compute("b"))]);
  assert.equal(calls, 2);
  assert.equal(a.value.n, "a");
  assert.equal(b.value.n, "b");
});

// ---------- staying small ----------

test("20. the oldest answers go first when the entry limit is reached", async () => {
  const cache = createResponseCache({ maxEntries: 3 });
  for (const k of ["a", "b", "c", "d"]) await cache.run(k, async () => ok({ k }));
  assert.equal(cache.stats().entries, 3);
  let recomputed = false;
  const a = await cache.run("a", async () => { recomputed = true; return ok({ k: "a" }); });
  assert.equal(recomputed, true);
  assert.equal(a.status, "miss");
});

test("21. reading an answer keeps it from being the next one evicted", async () => {
  const cache = createResponseCache({ maxEntries: 3 });
  for (const k of ["a", "b", "c"]) await cache.run(k, async () => ok({ k }));
  await cache.run("a", async () => ok({})); // touch a
  await cache.run("d", async () => ok({ k: "d" })); // evicts b, the oldest untouched
  assert.equal((await cache.run("a", async () => ok({}))).status, "hit");
  assert.equal((await cache.run("b", async () => ok({ k: "b" }))).status, "miss");
});

test("22. total memory is capped, evicting the oldest", async () => {
  const cache = createResponseCache({ maxEntries: 100, maxEntryBytes: 10_000, maxTotalBytes: 5_000 });
  for (let i = 0; i < 10; i++) await cache.run(`k${i}`, async () => ok({ pad: "y".repeat(500) }));
  const s = cache.stats();
  assert.ok(s.approxBytes <= 5_000, `approxBytes ${s.approxBytes}`);
  assert.ok(s.entries < 10 && s.entries > 0);
  assert.ok(s.evicted > 0);
  assert.equal((await cache.run("k9", async () => ok({}))).status, "hit"); // newest survives
});

test("23. replacing an entry does not double-count its size", async () => {
  const c = clock();
  const cache = createResponseCache({ ttlMs: HOUR, now: c.now });
  await cache.run("k", async () => ok({ pad: "z".repeat(300) }));
  const one = cache.stats().approxBytes;
  c.advance(HOUR + 1);
  await cache.run("k", async () => ok({ pad: "z".repeat(300) }));
  assert.equal(cache.stats().approxBytes, one);
  assert.equal(cache.stats().entries, 1);
});

test("24. clear empties it", async () => {
  const cache = createResponseCache();
  await cache.run("k", async () => ok({ a: 1 }));
  cache.clear();
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().approxBytes, 0);
  assert.equal((await cache.run("k", async () => ok({ a: 2 }))).status, "miss");
});
