import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeLibraries, libStable } from "./library-merge.js";

const paper = (title, extra = {}) => ({ title, doi: `10.1/${title.toLowerCase().replace(/\s+/g, "-")}`, year: 2020, abstract: `About ${title}`, ...extra });
const folder = (id, name, papers = [], extra = {}) => ({ id, name, question: name, createdAt: id, papers, ...extra });
const titles = (lib) => lib.map(f => `${f.name}:${f.papers.map(p => p.title).join("|")}`);
const clone = (x) => JSON.parse(JSON.stringify(x));

const A = paper("Alpha"), B = paper("Beta"), C = paper("Gamma"), D = paper("Delta"), E = paper("Epsilon");

// ---------- the basics ----------

test("1. nothing changed anywhere gives the server copy back", () => {
  const base = [folder(1, "Sleep", [A, B])];
  assert.deepEqual(mergeLibraries(base, clone(base), clone(base)), base);
});

test("2. a paper added on this device is added to what the server has", () => {
  const base = [folder(1, "Sleep", [A])];
  const local = [folder(1, "Sleep", [A, B])];
  assert.deepEqual(titles(mergeLibraries(base, local, clone(base))), ["Sleep:Alpha|Beta"]);
});

test("3. a paper added on the other device is kept when this device adds a different one", () => {
  const base = [folder(1, "Sleep", [A])];
  const local = [folder(1, "Sleep", [A, B])];
  const remote = [folder(1, "Sleep", [A, C])];
  assert.deepEqual(titles(mergeLibraries(base, local, remote)), ["Sleep:Alpha|Gamma|Beta"]);
});

test("4. the phone adds a folder while the laptop adds a paper to another: both survive", () => {
  const base = [folder(1, "Sleep", [A])];
  const local = [folder(1, "Sleep", [A, B])];
  const remote = [folder(2, "Diet", [C]), folder(1, "Sleep", [A])];
  assert.deepEqual(titles(mergeLibraries(base, local, remote)), ["Diet:Gamma", "Sleep:Alpha|Beta"]);
});

test("5. a stale device saving cannot erase what another device added", () => {
  // The old bug. The laptop never saw Gamma, which the phone added, and then
  // saves a change of its own.
  const base = [folder(1, "Sleep", [A, B])];
  const local = [folder(1, "Sleep", [A, B, D])];
  const remote = [folder(1, "Sleep", [A, B, C])];
  const out = mergeLibraries(base, local, remote);
  assert.deepEqual(titles(out), ["Sleep:Alpha|Beta|Gamma|Delta"]);
});

// ---------- deletions ----------

test("6. a paper deleted here and untouched there is deleted", () => {
  const base = [folder(1, "Sleep", [A, B])];
  assert.deepEqual(titles(mergeLibraries(base, [folder(1, "Sleep", [A])], clone(base))), ["Sleep:Alpha"]);
});

test("7. a paper deleted there and untouched here is deleted", () => {
  const base = [folder(1, "Sleep", [A, B])];
  assert.deepEqual(titles(mergeLibraries(base, clone(base), [folder(1, "Sleep", [B])])), ["Sleep:Beta"]);
});

test("8. a paper deleted here but given a note there is kept, with the note", () => {
  const base = [folder(1, "Sleep", [A, B])];
  const local = [folder(1, "Sleep", [A])];
  const remote = [folder(1, "Sleep", [A, { ...B, note: "use in intro" }])];
  const out = mergeLibraries(base, local, remote);
  assert.deepEqual(titles(out), ["Sleep:Alpha|Beta"]);
  assert.equal(out[0].papers[1].note, "use in intro");
});

test("9. a paper deleted on both sides stays deleted", () => {
  const base = [folder(1, "Sleep", [A, B])];
  const both = [folder(1, "Sleep", [A])];
  assert.deepEqual(titles(mergeLibraries(base, both, clone(both))), ["Sleep:Alpha"]);
});

test("10. a folder deleted here and untouched there is deleted, with its papers", () => {
  const base = [folder(1, "Sleep", [A]), folder(2, "Diet", [B])];
  assert.deepEqual(titles(mergeLibraries(base, [folder(2, "Diet", [B])], clone(base))), ["Diet:Beta"]);
});

test("11. a folder deleted here that got a new paper there keeps only the new paper", () => {
  const base = [folder(1, "Sleep", [A, B])];
  const remote = [folder(1, "Sleep", [A, B, C])];
  assert.deepEqual(titles(mergeLibraries(base, [], remote)), ["Sleep:Gamma"]);
});

test("12. removing the last paper (which removes the folder) does not resurrect it", () => {
  const base = [folder(1, "Sleep", [A]), folder(2, "Diet", [B])];
  assert.deepEqual(titles(mergeLibraries(base, [folder(2, "Diet", [B])], clone(base))), ["Diet:Beta"]);
});

// ---------- edits ----------

test("13. renaming a folder here and adding a paper there keeps both", () => {
  const base = [folder(1, "Sleep", [A])];
  const local = [folder(1, "Sleep and mood", [A])];
  const remote = [folder(1, "Sleep", [A, B])];
  assert.deepEqual(titles(mergeLibraries(base, local, remote)), ["Sleep and mood:Alpha|Beta"]);
});

test("14. if both devices rename the same folder, this device's name wins", () => {
  const base = [folder(1, "Sleep", [A])];
  const out = mergeLibraries(base, [folder(1, "Rest", [A])], [folder(1, "Slumber", [A])]);
  assert.equal(out[0].name, "Rest");
});

test("15. a note on one paper here and a note on another there both survive", () => {
  const base = [folder(1, "Sleep", [A, B])];
  const local = [folder(1, "Sleep", [{ ...A, note: "mine" }, B])];
  const remote = [folder(1, "Sleep", [A, { ...B, note: "theirs" }])];
  const out = mergeLibraries(base, local, remote);
  assert.equal(out[0].papers.find(p => p.title === "Alpha").note, "mine");
  assert.equal(out[0].papers.find(p => p.title === "Beta").note, "theirs");
});

test("16. a note and a different field edited on the same paper both survive", () => {
  const base = [folder(1, "Sleep", [A])];
  const local = [folder(1, "Sleep", [{ ...A, note: "n" }])];
  const remote = [folder(1, "Sleep", [{ ...A, retracted: true }])];
  const p = mergeLibraries(base, local, remote)[0].papers[0];
  assert.equal(p.note, "n");
  assert.equal(p.retracted, true);
});

test("17. deleting a note here is respected when nothing else changed", () => {
  const base = [folder(1, "Sleep", [{ ...A, note: "n" }])];
  const out = mergeLibraries(base, [folder(1, "Sleep", [{ ...A, note: null }])], clone(base));
  assert.equal(out[0].papers[0].note, null);
});

// ---------- two new things with the same identity ----------

test("18. the same new folder made on two devices becomes one folder", () => {
  const base = [];
  const local = [folder(101, "Does caffeine affect memory", [A, B])];
  const remote = [folder(202, "Does caffeine affect memory", [B, C])];
  const out = mergeLibraries(base, local, remote);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].papers.map(p => p.title).sort(), ["Alpha", "Beta", "Gamma"]);
  assert.equal(out[0].id, 202);
});

test("19. folders with different names stay separate", () => {
  const out = mergeLibraries([], [folder(1, "One", [A])], [folder(2, "Two", [B])]);
  assert.deepEqual(titles(out), ["One:Alpha", "Two:Beta"]);
});

test("20. the same paper added on both devices appears once", () => {
  const base = [folder(1, "Sleep", [])];
  const out = mergeLibraries(base, [folder(1, "Sleep", [A])], [folder(1, "Sleep", [A])]);
  assert.equal(out[0].papers.length, 1);
});

test("21. paper identity ignores letter case in the DOI", () => {
  const base = [folder(1, "Sleep", [])];
  const upper = { ...A, doi: A.doi.toUpperCase() };
  const out = mergeLibraries(base, [folder(1, "Sleep", [A])], [folder(1, "Sleep", [upper])]);
  assert.equal(out[0].papers.length, 1);
});

// ---------- storage quirks and bad input ----------

test("22. a database that reorders object keys does not look like an edit", () => {
  const base = [folder(1, "Sleep", [A])];
  const reordered = JSON.parse(JSON.stringify(base).replace(/"title":"Alpha",/, "")); // different shape on purpose below
  assert.notEqual(libStable(base), libStable(reordered));
  // The real case: same content, keys in another order.
  const shuffled = [{ papers: [{ year: A.year, abstract: A.abstract, doi: A.doi, title: A.title }], name: "Sleep", createdAt: 1, question: "Sleep", id: 1 }];
  assert.equal(libStable(base), libStable(shuffled));
  const out = mergeLibraries(base, [folder(1, "Sleep", [A, B])], shuffled);
  assert.deepEqual(titles(out), ["Sleep:Alpha|Beta"]);
});

test("23. missing or malformed input is treated as empty rather than throwing", () => {
  assert.deepEqual(mergeLibraries(null, undefined, "nope"), []);
  assert.deepEqual(titles(mergeLibraries(null, [folder(1, "A", [A])], null)), ["A:Alpha"]);
  assert.deepEqual(titles(mergeLibraries([], [null, 5, { name: "x" }, folder(1, "Real", [A, null, 7])], [])), ["x:", "Real:Alpha"]);
});

test("24. with no base at all (a server restored from an old backup), nothing is deleted", () => {
  const local = [folder(1, "Sleep", [A, B])];
  const remote = [folder(1, "Sleep", [A])];
  assert.deepEqual(titles(mergeLibraries([], local, remote)), ["Sleep:Alpha|Beta"]);
});

// ---------- invariants over many random histories ----------

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function randomEdit(lib, rand, counter) {
  const pick = (n) => Math.floor(rand() * n);
  const op = pick(6);
  const withPapers = lib.filter(f => f.papers.length);
  if (op === 0 || lib.length === 0) {
    counter.n++;
    const f = lib.length && rand() < 0.6 ? lib[pick(lib.length)] : null;
    const p = paper(`P${counter.n}`);
    if (f) f.papers.push(p);
    else lib.unshift(folder(1000 + counter.n, `F${counter.n}`, [p]));
  } else if (op === 1 && withPapers.length) {
    const f = withPapers[pick(withPapers.length)];
    f.papers.splice(pick(f.papers.length), 1);
    if (!f.papers.length) lib.splice(lib.indexOf(f), 1);
  } else if (op === 2 && withPapers.length) {
    const f = withPapers[pick(withPapers.length)];
    f.papers[pick(f.papers.length)].note = `note ${counter.n++}`;
  } else if (op === 3) {
    lib[pick(lib.length)].name = `Renamed ${counter.n++}`;
  } else if (op === 4) {
    lib.splice(pick(lib.length), 1);
  }
}

function randomLibrary(rand, counter) {
  const lib = [];
  for (let i = 0; i < 1 + Math.floor(rand() * 3); i++) {
    const ps = [];
    for (let j = 0; j < 1 + Math.floor(rand() * 4); j++) { counter.n++; ps.push(paper(`P${counter.n}`)); }
    counter.n++;
    lib.push(folder(counter.n, `F${counter.n}`, ps));
  }
  return lib;
}

const norm = (lib) => libStable(lib.map(f => ({ ...f, papers: [...f.papers].sort((a, b) => a.title.localeCompare(b.title)) })).sort((a, b) => String(a.id).localeCompare(String(b.id))));

test("25. 3000 random histories: merging with an unchanged side gives the other side, merging is stable, nothing is duplicated", () => {
  const rand = rng(12345);
  for (let i = 0; i < 3000; i++) {
    const counter = { n: 0 };
    const base = randomLibrary(rand, counter);
    const local = clone(base), remote = clone(base);
    for (let k = 0, n = Math.floor(rand() * 5); k < n; k++) randomEdit(local, rand, counter);
    for (let k = 0, n = Math.floor(rand() * 5); k < n; k++) randomEdit(remote, rand, counter);

    // only this device changed: the result is exactly this device's copy
    assert.equal(norm(mergeLibraries(base, local, clone(base))), norm(local), `local-only #${i}`);
    // only the server changed: the result is exactly the server's copy
    assert.equal(norm(mergeLibraries(base, clone(base), remote)), norm(remote), `remote-only #${i}`);
    // both sides identical: nothing changes
    assert.equal(norm(mergeLibraries(base, local, clone(local))), norm(local), `identical #${i}`);

    const merged = mergeLibraries(base, local, remote);
    // no folder or paper appears twice
    const ids = merged.map(f => String(f.id));
    assert.equal(new Set(ids).size, ids.length, `dup folder #${i}`);
    for (const f of merged) {
      const keys = f.papers.map(p => p.title);
      assert.equal(new Set(keys).size, keys.length, `dup paper #${i}`);
    }
    // merging again with the merged result as the server copy changes nothing
    assert.equal(norm(mergeLibraries(remote, merged, merged)), norm(merged), `stable #${i}`);
    // every paper added on either side survives
    const baseKeys = new Set(base.flatMap(f => f.papers.map(p => p.title)));
    const mergedKeys = new Set(merged.flatMap(f => f.papers.map(p => p.title)));
    for (const side of [local, remote]) {
      for (const f of side) for (const p of f.papers) {
        if (!baseKeys.has(p.title)) assert.ok(mergedKeys.has(p.title), `lost new paper ${p.title} #${i}`);
      }
    }
  }
});
