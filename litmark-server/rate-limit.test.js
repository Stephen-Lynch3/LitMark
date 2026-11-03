import { test } from "node:test";
import assert from "node:assert/strict";
import { COSTS, createRateLimiter, createUsageStore, parseLimit } from "./rate-limit.js";

const HOUR = 60 * 60 * 1000;
const clock = (t = 1_000_000_000_000) => { const c = { t, now: () => c.t, advance: (ms) => { c.t += ms; } }; return c; };
const quiet = { error() {}, warn() {}, log() {} };
const make = (opts = {}) => { const c = clock(); return { c, rl: createRateLimiter({ now: c.now, log: quiet, ...opts }) }; };

test("1. twenty searches in an hour are fine, the twenty-first is not", () => {
  const { rl } = make();
  for (let i = 0; i < 20; i++) assert.equal(rl.check("a@x.com", COSTS.full).ok, true, `search ${i + 1}`);
  assert.equal(rl.check("a@x.com", COSTS.full).ok, false);
});

test("2. a student can ask Vera eighty questions in an hour", () => {
  const { rl } = make();
  for (let i = 0; i < 80; i++) assert.equal(rl.check("a@x.com", COSTS.light).ok, true, `question ${i + 1}`);
  assert.equal(rl.check("a@x.com", COSTS.light).ok, false);
});

test("3. a busy study session that the old flat limit would have blocked now goes through", () => {
  // 6 searches, 2 citation checks, 20 Vera questions, 10 explain buttons, 3 folder summaries, 2 DOI adds:
  // 43 actions. The old rule stopped everyone at 20 actions.
  const { rl } = make();
  const session = [[6, COSTS.full], [2, COSTS.full], [20, COSTS.light], [10, COSTS.light], [3, COSTS.half], [2, COSTS.half]];
  let actions = 0;
  for (const [n, cost] of session) for (let i = 0; i < n; i++) { actions++; assert.equal(rl.check("a@x.com", cost).ok, true, `action ${actions}`); }
  assert.equal(actions, 43);
  assert.equal(rl.used("a@x.com"), 18);
});

test("4. two people sharing an account still hit it through searches", () => {
  const { rl } = make();
  let blocked = 0;
  for (let i = 0; i < 12; i++) { if (!rl.check("shared@x.com", COSTS.full).ok) blocked++; if (!rl.check("shared@x.com", COSTS.full).ok) blocked++; }
  assert.ok(blocked > 0);
});

test("5. cheap and expensive actions add up against the same allowance", () => {
  const { rl } = make();
  for (let i = 0; i < 10; i++) rl.check("a@x.com", COSTS.full);          // 10
  for (let i = 0; i < 40; i++) rl.check("a@x.com", COSTS.light);         // +10 = 20
  assert.equal(rl.check("a@x.com", COSTS.light).ok, false);
});

test("6. the allowance comes back as old actions leave the hour", () => {
  const { c, rl } = make();
  for (let i = 0; i < 20; i++) { rl.check("a@x.com", COSTS.full); c.advance(60_000); } // one a minute for 20 minutes
  assert.equal(rl.check("a@x.com", COSTS.full).ok, false);
  c.advance(40 * 60_000 + 1);                                  // the first one is now over an hour old
  assert.equal(rl.check("a@x.com", COSTS.full).ok, true);
});

test("7. a blocked request is told how long to wait, and waiting that long works", () => {
  const { c, rl } = make();
  for (let i = 0; i < 20; i++) { rl.check("a@x.com", COSTS.full); c.advance(30_000); }   // 10 minutes of searching
  const blocked = rl.check("a@x.com", COSTS.full);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 49 * 60_000 && blocked.retryAfterMs <= 50 * 60_000, `retry ${blocked.retryAfterMs}`);
  c.advance(blocked.retryAfterMs);
  assert.equal(rl.check("a@x.com", COSTS.full).ok, true);
});

test("8. waiting for room waits only until enough has expired, not for everything", () => {
  const { c, rl } = make();
  rl.check("a@x.com", COSTS.light);                  // 0.25, will expire first
  c.advance(10 * 60_000);
  for (let i = 0; i < 19; i++) rl.check("a@x.com", COSTS.full); // 19.25 used
  rl.check("a@x.com", COSTS.light); rl.check("a@x.com", COSTS.light); rl.check("a@x.com", COSTS.light); // 20.0 used
  const blocked = rl.check("a@x.com", COSTS.full);
  assert.equal(blocked.ok, false);
  // freeing the first 0.25 is not enough (19.75 is under 20, so it is enough!)
  assert.ok(blocked.retryAfterMs <= 50 * 60_000 + 1000);
});

test("9. accounts do not affect each other", () => {
  const { rl } = make();
  for (let i = 0; i < 20; i++) rl.check("a@x.com", COSTS.full);
  assert.equal(rl.check("a@x.com", COSTS.full).ok, false);
  assert.equal(rl.check("b@x.com", COSTS.full).ok, true);
});

test("10. a bad cost is treated as a full search rather than as free", () => {
  const { rl } = make();
  for (const bad of [NaN, -3, 0, undefined, "x"]) rl.check("a@x.com", bad);
  assert.equal(rl.used("a@x.com"), 5);
});

test("11. parseLimit falls back for nonsense settings", () => {
  assert.equal(parseLimit("30"), 30);
  assert.equal(parseLimit("0"), 20);
  assert.equal(parseLimit("-4"), 20);
  assert.equal(parseLimit("abc"), 20);
  assert.equal(parseLimit(undefined), 20);
  assert.equal(parseLimit("7.5"), 7.5);
});

test("12. housekeeping forgets idle accounts", async () => {
  const { c, rl } = make();
  rl.check("a@x.com"); rl.check("b@x.com");
  assert.equal(rl.accounts(), 2);
  c.advance(HOUR + 1);
  await rl.sweep();
  assert.equal(rl.accounts(), 0);
});

// ---------- keeping the count across a restart ----------

function fakeUsageStore() {
  const rows = [];
  return {
    rows,
    async record(email, at, cost) { rows.push({ email, at, cost }); },
    async load(since, until) { return rows.filter(r => r.at >= since && r.at < until).map(r => ({ ...r })); },
    async prune(before) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].at < before) rows.splice(i, 1); },
  };
}

test("13. every allowed action is saved to the store, blocked ones are not", async () => {
  const store = fakeUsageStore();
  const { rl } = make({ store });
  for (let i = 0; i < 22; i++) rl.check("a@x.com", COSTS.full);
  await new Promise(r => setImmediate(r));
  assert.equal(store.rows.length, 20);
});

test("14. after a restart the earlier count is still there", async () => {
  const store = fakeUsageStore();
  const c = clock();
  const before = createRateLimiter({ now: c.now, store, log: quiet });
  for (let i = 0; i < 20; i++) before.check("a@x.com", COSTS.full);
  await new Promise(r => setImmediate(r));
  c.advance(5 * 60_000);
  const after = createRateLimiter({ now: c.now, store, log: quiet });      // the new process
  assert.equal(await after.hydrate(c.now()), 20);
  assert.equal(after.check("a@x.com", COSTS.full).ok, false, "a redeploy does not hand out a fresh allowance");
  assert.equal(after.check("b@x.com", COSTS.full).ok, true);
});

test("15. usage from more than an hour ago is not brought back", async () => {
  const store = fakeUsageStore();
  const c = clock();
  store.rows.push({ email: "a@x.com", at: c.t - 2 * HOUR, cost: 1 }, { email: "a@x.com", at: c.t - 30 * 60_000, cost: 1 });
  const rl = createRateLimiter({ now: c.now, store, log: quiet });
  assert.equal(await rl.hydrate(c.now()), 1);
  assert.equal(rl.used("a@x.com"), 1);
});

test("16. requests made while loading are not counted twice", async () => {
  const store = fakeUsageStore();
  const c = clock();
  const startedAt = c.t;
  const rl = createRateLimiter({ now: c.now, store, log: quiet });
  c.advance(1000);
  rl.check("a@x.com", COSTS.full);                          // arrives during startup; also written to the store
  await new Promise(r => setImmediate(r));
  assert.equal(await rl.hydrate(startedAt), 0);             // only events from before this process started
  assert.equal(rl.used("a@x.com"), 1);
});

test("17. a broken database never stops the limiter working", async () => {
  const store = { async record() { throw new Error("db down"); }, async load() { throw new Error("db down"); }, async prune() { throw new Error("db down"); } };
  const logged = [];
  const { rl } = make({ store, log: { error: (...a) => logged.push(a.join(" ")) } });
  assert.equal(await rl.hydrate(), 0);
  for (let i = 0; i < 20; i++) assert.equal(rl.check("a@x.com", COSTS.full).ok, true);
  assert.equal(rl.check("a@x.com", COSTS.full).ok, false);
  await rl.sweep();
  await new Promise(r => setImmediate(r));
  assert.ok(logged.length >= 1 && logged.length <= 2, "logged once, not for every request: " + logged.length);
});

test("18. a store that throws synchronously is also survived", () => {
  const { rl } = make({ store: { record() { throw new Error("boom"); } } });
  assert.equal(rl.check("a@x.com", COSTS.full).ok, true);
});

// ---------- the SQL (an in-memory stand-in by default; set LIBRARY_TEST_POOL for a real database) ----------

const REAL = !!process.env.LIBRARY_TEST_POOL;
function fakePool() {
  const rows = [];
  const norm = s => s.replace(/\s+/g, " ").trim();
  return {
    async query(text, params = []) {
      const q = norm(text);
      if (/^(CREATE TABLE|CREATE INDEX)/.test(q)) return { rows: [] };
      if (q.startsWith("INSERT INTO usage_events")) { rows.push({ email: params[0], at: params[1], cost: params[2] }); return { rows: [] }; }
      if (q.startsWith("SELECT email, (EXTRACT(EPOCH FROM used_at)")) {
        return { rows: rows.filter(r => r.at >= params[0] && r.at < params[1]).sort((a, b) => a.at - b.at).map(r => ({ email: r.email, at_ms: r.at, cost: r.cost })) };
      }
      if (q.startsWith("DELETE FROM usage_events")) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].at < params[0]) rows.splice(i, 1); return { rows: [] }; }
      if (q.startsWith("SELECT count(*)::int AS n FROM usage_events")) return { rows: [{ n: rows.length }] };
      throw new Error("fake pool does not understand: " + q);
    },
    reset: async () => { rows.length = 0; },
  };
}
const makeUsagePool = REAL ? (await import(process.env.LIBRARY_TEST_POOL)).makePool : fakePool;

test("19. the usage table saves, loads and trims", async () => {
  const pool = await makeUsagePool();
  const store = createUsageStore(pool);
  await store.ensureSchema();
  await pool.reset();
  const base = 1_700_000_000_000;
  await store.record("a@x.com", base - 3 * HOUR, 1);
  await store.record("a@x.com", base - 10 * 60_000, 0.25);
  await store.record("b@x.com", base - 5 * 60_000, 0.5);
  const recent = await store.load(base - HOUR, base);
  assert.deepEqual(recent.map(r => [r.email, r.cost]), [["a@x.com", 0.25], ["b@x.com", 0.5]]);
  assert.equal(recent[0].at, base - 10 * 60_000, "millisecond timestamps survive the round trip");
  assert.deepEqual(await store.load(base - 5 * 60_000, base - 4 * 60_000), [{ email: "b@x.com", at: base - 5 * 60_000, cost: 0.5 }]);
  await store.prune(base - 2 * HOUR);
  const left = (await pool.query("SELECT count(*)::int AS n FROM usage_events")).rows[0].n;
  assert.equal(left, 2);
});

test("20. a restart through the real store keeps the count", async () => {
  const pool = await makeUsagePool();
  const store = createUsageStore(pool);
  await store.ensureSchema();
  await pool.reset();
  const c = clock(1_700_000_000_000);
  const first = createRateLimiter({ now: c.now, store, log: quiet });
  for (let i = 0; i < 20; i++) first.check("a@x.com", COSTS.full);
  await new Promise(r => setTimeout(r, REAL ? 1500 : 10));
  c.advance(60_000);
  const second = createRateLimiter({ now: c.now, store, log: quiet });
  assert.equal(await second.hydrate(c.now()), 20);
  assert.equal(second.check("a@x.com", COSTS.full).ok, false);
});
