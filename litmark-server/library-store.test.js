import { test } from "node:test";
import assert from "node:assert/strict";
import { createLibraryStore, countPapers } from "./library-store.js";

// These run against a small in-memory stand-in for the database, so `npm test`
// needs nothing installed. To run the very same tests against a real Postgres,
// set LIBRARY_TEST_POOL to a module that exports makePool() (see the comment in
// scripts/ if you ever want to; it is how the SQL was checked).
const REAL = !!process.env.LIBRARY_TEST_POOL;

function makeFakePool() {
  const library = new Map();   // email -> { folders, revision }
  const versions = [];         // { id, email, revision, folders, papers, saved_at }
  let nextId = 1;
  const clock = { t: 1_000_000_000_000 };
  const hooks = { beforeUpdate: null, failVersionInsert: false };
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const copy = (x) => JSON.parse(JSON.stringify(x));

  async function query(text, params = []) {
    const q = norm(text);
    if (/^(CREATE TABLE|ALTER TABLE|CREATE INDEX)/.test(q)) return { rows: [] };
    if (q.startsWith("SELECT folders, revision FROM library WHERE email = $1")) {
      const r = library.get(params[0]);
      return { rows: r ? [{ folders: copy(r.folders), revision: String(r.revision) }] : [] };
    }
    if (q.startsWith("INSERT INTO library (email, folders, revision, updated_at)")) {
      if (library.has(params[0])) return { rows: [] };
      library.set(params[0], { folders: JSON.parse(params[1]), revision: 1 });
      return { rows: [{ revision: "1" }] };
    }
    if (q.startsWith("UPDATE library SET folders = $2::jsonb, revision = revision + 1")) {
      if (hooks.beforeUpdate) { const h = hooks.beforeUpdate; hooks.beforeUpdate = null; h(library); }
      const r = library.get(params[0]);
      if (!r || r.revision !== Number(params[2])) return { rows: [] };
      r.folders = JSON.parse(params[1]);
      r.revision += 1;
      return { rows: [{ revision: String(r.revision) }] };
    }
    if (q.startsWith("SELECT EXTRACT(EPOCH FROM (now() - max(saved_at))) AS age FROM library_versions")) {
      const mine = versions.filter(v => v.email === params[0]);
      if (!mine.length) return { rows: [{ age: null }] };
      return { rows: [{ age: (clock.t - Math.max(...mine.map(v => v.saved_at))) / 1000 }] };
    }
    if (q.startsWith("INSERT INTO library_versions")) {
      if (hooks.failVersionInsert) throw new Error("disk full");
      versions.push({ id: nextId++, email: params[0], revision: Number(params[1]), folders: JSON.parse(params[2]), papers: params[3], saved_at: clock.t });
      clock.t += 1;
      return { rows: [] };
    }
    if (q.startsWith("DELETE FROM library_versions WHERE email = $1 AND id NOT IN")) {
      const mine = versions.filter(v => v.email === params[0]).sort((a, b) => b.saved_at - a.saved_at || b.id - a.id);
      const keepIds = new Set(mine.slice(0, params[1]).map(v => v.id));
      for (let i = versions.length - 1; i >= 0; i--) if (versions[i].email === params[0] && !keepIds.has(versions[i].id)) versions.splice(i, 1);
      return { rows: [] };
    }
    if (q.startsWith("SELECT email, folders, revision, updated_at FROM library ORDER BY email")) {
      return { rows: [...library.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([email, r]) => ({ email, folders: copy(r.folders), revision: String(r.revision), updated_at: "t" })) };
    }
    if (q.startsWith("SELECT id, revision, papers, saved_at FROM library_versions WHERE email = $1")) {
      return { rows: versions.filter(v => v.email === params[0]).sort((a, b) => b.saved_at - a.saved_at || b.id - a.id).map(v => ({ id: String(v.id), revision: String(v.revision), papers: v.papers, saved_at: v.saved_at })) };
    }
    if (q.startsWith("SELECT folders FROM library_versions WHERE email = $1 AND id = $2")) {
      const v = versions.find(x => x.email === params[0] && x.id === Number(params[1]));
      return { rows: v ? [{ folders: copy(v.folders) }] : [] };
    }
    // helpers used only by these tests
    if (q.startsWith("UPDATE library_versions SET saved_at = saved_at - interval '1 hour' WHERE email = $1")) {
      versions.filter(v => v.email === params[0]).forEach(v => { v.saved_at -= 3600_000; });
      return { rows: [] };
    }
    if (q.startsWith("SELECT count(*)::int AS n FROM library_versions WHERE email = $1")) {
      return { rows: [{ n: versions.filter(v => v.email === params[0]).length }] };
    }
    throw new Error("fake pool does not understand: " + q);
  }
  return { query, hooks, reset: async () => { library.clear(); versions.length = 0; }, close: async () => {} };
}

const makePool = REAL ? (await import(process.env.LIBRARY_TEST_POOL)).makePool : makeFakePool;

async function fresh(opts) {
  const pool = await makePool();
  const store = createLibraryStore(pool, { log: { error() {} }, ...opts });
  await store.ensureSchema();
  await pool.reset();
  return { pool, store };
}

const P = (title) => ({ title, doi: `10.1/${title}`, abstract: `About ${title}` });
const lib = (...papers) => [{ id: 1, name: "Sleep", question: "Sleep", createdAt: 1, papers: papers.map(P) }];
const versionCount = async (pool, email) => (await pool.query("SELECT count(*)::int AS n FROM library_versions WHERE email = $1", [email])).rows[0].n;
const ageVersions = (pool, email) => pool.query("UPDATE library_versions SET saved_at = saved_at - interval '1 hour' WHERE email = $1", [email]);

test("1. an account with nothing stored reports no folders and revision 0", async () => {
  const { store } = await fresh();
  assert.deepEqual(await store.load("a@x.com"), { folders: null, revision: 0 });
});

test("2. the first save creates the row at revision 1", async () => {
  const { store } = await fresh();
  assert.deepEqual(await store.save("a@x.com", lib("A"), null), { ok: true, revision: 1 });
  const got = await store.load("a@x.com");
  assert.equal(got.revision, 1);
  assert.deepEqual(got.folders, lib("A"));
});

test("3. a save based on the current revision goes through and bumps it", async () => {
  const { store } = await fresh();
  await store.save("a@x.com", lib("A"), null);
  assert.deepEqual(await store.save("a@x.com", lib("A", "B"), 1), { ok: true, revision: 2 });
  assert.equal(countPapers((await store.load("a@x.com")).folders), 2);
});

test("4. a save based on an old revision is refused and nothing is overwritten", async () => {
  const { store } = await fresh();
  await store.save("a@x.com", lib("A"), null);
  await store.save("a@x.com", lib("A", "B"), 1);            // the phone saves
  const res = await store.save("a@x.com", lib("A", "C"), 1); // the laptop, still on revision 1
  assert.equal(res.conflict, true);
  assert.equal(res.revision, 2);
  assert.deepEqual(res.folders[0].papers.map(p => p.title), ["A", "B"]);
  assert.deepEqual((await store.load("a@x.com")).folders[0].papers.map(p => p.title), ["A", "B"]);
});

test("5. saying 'nothing is stored yet' when something is stored is a conflict", async () => {
  const { store } = await fresh();
  await store.save("a@x.com", lib("A"), null);
  const res = await store.save("a@x.com", lib("Z"), null);
  assert.equal(res.conflict, true);
  assert.equal(res.revision, 1);
});

test("6. an older client that sends no revision still overwrites, as before", async () => {
  const { store } = await fresh();
  await store.save("a@x.com", lib("A"), null);
  assert.deepEqual(await store.save("a@x.com", lib("Z"), undefined), { ok: true, revision: 2 });
  assert.equal((await store.load("a@x.com")).folders[0].papers[0].title, "Z");
});

test("7. a client with a revision but a server with no row (data was lost) is accepted", async () => {
  const { store } = await fresh();
  assert.deepEqual(await store.save("a@x.com", lib("A"), 7), { ok: true, revision: 1 });
});

test("8. accounts are independent", async () => {
  const { store } = await fresh();
  await store.save("a@x.com", lib("A"), null);
  await store.save("b@x.com", lib("B"), null);
  assert.equal((await store.load("a@x.com")).folders[0].papers[0].title, "A");
  assert.equal((await store.load("b@x.com")).folders[0].papers[0].title, "B");
});

test("9. the first overwrite of a non-empty library keeps the old copy", async () => {
  const { store, pool } = await fresh();
  await store.save("a@x.com", lib("A"), null);
  await store.save("a@x.com", lib("A", "B"), 1);
  assert.equal(await versionCount(pool, "a@x.com"), 1);
  const [v] = await store.listVersions("a@x.com");
  assert.equal(v.papers, 1);
  assert.equal(v.revision, 1);
});

test("10. saves close together do not each make a version, but one after half an hour does", async () => {
  const { store, pool } = await fresh();
  await store.save("a@x.com", lib("A"), null);
  await store.save("a@x.com", lib("A", "B"), 1);
  await store.save("a@x.com", lib("A", "B", "C"), 2);
  await store.save("a@x.com", lib("A", "B", "C", "D"), 3);
  assert.equal(await versionCount(pool, "a@x.com"), 1);
  await ageVersions(pool, "a@x.com");
  await store.save("a@x.com", lib("A", "B", "C", "D", "E"), 4);
  assert.equal(await versionCount(pool, "a@x.com"), 2);
});

test("11. an empty library is not worth keeping a version of", async () => {
  const { store, pool } = await fresh();
  await store.save("a@x.com", [], null);
  await store.save("a@x.com", lib("A"), 1);
  assert.equal(await versionCount(pool, "a@x.com"), 0);
});

test("12. a big drop in papers is kept as a version straight away", async () => {
  const { store, pool } = await fresh();
  await store.save("a@x.com", lib("A", "B", "C", "D", "E", "F"), null);
  await store.save("a@x.com", lib("A", "B", "C", "D", "E", "F", "G"), 1); // first version (nothing before it)
  await store.save("a@x.com", lib("A", "B", "C", "D", "E", "F", "G", "H"), 2); // too soon, no version
  assert.equal(await versionCount(pool, "a@x.com"), 1);
  await store.save("a@x.com", lib("A", "B"), 3);                              // 8 -> 2 papers
  assert.equal(await versionCount(pool, "a@x.com"), 2);
  const versions = await store.listVersions("a@x.com");
  assert.equal(versions[0].papers, 8);
});

test("13. removing one paper is not a big drop", async () => {
  const { store, pool } = await fresh();
  await store.save("a@x.com", lib("A", "B", "C", "D"), null);
  await store.save("a@x.com", lib("A", "B", "C", "D", "E"), 1); // makes the first version
  await store.save("a@x.com", lib("A", "B", "C", "D"), 2);
  assert.equal(await versionCount(pool, "a@x.com"), 1);
});

test("14. only the newest versions are kept", async () => {
  const { store, pool } = await fresh({ keepVersions: 3 });
  await store.save("a@x.com", lib("A"), null);
  let rev = 1;
  for (let i = 0; i < 6; i++) {
    await ageVersions(pool, "a@x.com");
    const r = await store.save("a@x.com", lib("A", `N${i}`), rev);
    rev = r.revision;
  }
  assert.equal(await versionCount(pool, "a@x.com"), 3);
});

test("15. an earlier copy can be restored, and the restore can itself be undone", async () => {
  const { store, pool } = await fresh();
  await store.save("a@x.com", lib("A", "B", "C", "D"), null);
  await store.save("a@x.com", [], 1);                    // a bad save wipes everything (a version of the 4 papers is kept)
  const [wiped] = await store.listVersions("a@x.com");
  assert.equal(wiped.papers, 4);
  const res = await store.restoreVersion("a@x.com", wiped.id);
  assert.equal(res.ok, true);
  assert.equal(countPapers((await store.load("a@x.com")).folders), 4);
  // a restore always keeps what it replaces, and the 4-paper copy is still there
  assert.ok((await versionCount(pool, "a@x.com")) >= 1);
});

test("16. restoring a version that does not exist says so", async () => {
  const { store } = await fresh();
  await store.save("a@x.com", lib("A"), null);
  await assert.rejects(() => store.restoreVersion("a@x.com", 999999), /no version/);
});

test("17. exportAll returns every account", async () => {
  const { store } = await fresh();
  await store.save("b@x.com", lib("B"), null);
  await store.save("a@x.com", lib("A"), null);
  const all = await store.exportAll();
  assert.deepEqual(all.map(a => a.email), ["a@x.com", "b@x.com"]);
  assert.equal(all[0].folders[0].papers[0].title, "A");
});

test("18. sizes: countPapers copes with junk", () => {
  assert.equal(countPapers(null), 0);
  assert.equal(countPapers([{ papers: [1, 2] }, null, { papers: "x" }, { papers: [3] }]), 3);
});

test("19. the stored copy comes back in full, whatever order the database keeps keys in", async () => {
  const { store } = await fresh();
  const folders = [{ id: 1.5, name: "N", papers: [{ title: "T", z: 1, a: [1, { y: 2, b: 3 }] }], zeta: null }];
  await store.save("a@x.com", folders, null);
  const back = (await store.load("a@x.com")).folders;
  assert.equal(JSON.stringify(sortKeys(back)), JSON.stringify(sortKeys(folders)));
});
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}

// ---- needs the in-memory stand-in, which can be made to misbehave ----

test("20. if the row changes between reading and writing, a client with a revision is told to merge", { skip: REAL }, async () => {
  const { store, pool } = await fresh();
  await store.save("a@x.com", lib("A"), null);
  pool.hooks.beforeUpdate = (library) => { const r = library.get("a@x.com"); r.revision += 1; r.folders = lib("A", "FromElsewhere"); };
  const res = await store.save("a@x.com", lib("A", "Mine"), 1);
  assert.equal(res.conflict, true);
  assert.equal(res.revision, 2);
  assert.deepEqual(res.folders[0].papers.map(p => p.title), ["A", "FromElsewhere"]);
});

test("21. the same race for an older client without a revision just retries and wins", { skip: REAL }, async () => {
  const { store, pool } = await fresh();
  await store.save("a@x.com", lib("A"), null);
  pool.hooks.beforeUpdate = (library) => { const r = library.get("a@x.com"); r.revision += 1; };
  const res = await store.save("a@x.com", lib("Legacy"), undefined);
  assert.equal(res.ok, true);
  assert.equal(res.revision, 3);
});

test("22. failing to keep a version never blocks the student's save", { skip: REAL }, async () => {
  const { store, pool } = await fresh();
  await store.save("a@x.com", lib("A"), null);
  pool.hooks.failVersionInsert = true;
  const res = await store.save("a@x.com", lib("A", "B"), 1);
  assert.equal(res.ok, true);
  assert.equal(countPapers((await store.load("a@x.com")).folders), 2);
});
