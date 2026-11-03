// Merging two versions of a student's saved folders without losing anything.
//
// The problem this solves: a student's folders live in their browser and are
// copied to the server. With two devices (phone and laptop), or a save that
// failed while on bad wifi, the two copies drift apart. The old rule was
// "whole list overwrites whole list", so whichever device saved last silently
// erased what the other had added.
//
// This is a three-way merge, the same idea git uses. Given
//   base   - the copy both sides last agreed on (what the server had when this
//            device last synced),
//   local  - what is on this device now,
//   remote - what the server has now,
// it keeps every change made on either side:
//   - something added on either side is kept,
//   - something deleted on one side is deleted, unless the other side changed
//     it in the meantime (an edit beats a delete, so work is never discarded),
//   - a field changed on only one side takes that change; if both sides
//     changed the same field, this device's value wins,
//   - two brand-new folders with the same name, made on different devices
//     before they synced, become one folder holding both sets of papers.
//
// Written as plain functions with no imports or exports so the identical text
// can be pasted into the app page (which has no build step) and also loaded
// here for tests. `library-merge.test.js` loads it with `loadLibraryMerge()`
// below. If you change this file, re-run `node scripts/inline-library-merge.mjs
// <path to the app page>` so the page gets the same code.

// ---- begin library-merge ----
function libStable(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(libStable).join(",") + "]";
  return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + libStable(v[k])).join(",") + "}";
}

function libSame(a, b) { return libStable(a) === libStable(b); }

function libIsObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

function libFolderKey(f) { return f.id !== undefined && f.id !== null ? "id:" + String(f.id) : "name:" + String(f.name || "").trim().toLowerCase(); }

function libPaperKey(p) { return String((p && (p.doi || p.title)) || "").toLowerCase() || libStable(p); }

// One field at a time: a change on only one side wins; if both sides changed
// it, this device (local) wins.
function libMergeFields(base, local, remote) {
  const b = libIsObject(base) ? base : {};
  const l = libIsObject(local) ? local : {};
  const r = libIsObject(remote) ? remote : {};
  const out = {};
  const keys = new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)]);
  for (const k of keys) {
    if (k === "papers") continue;
    const val = libSame(l[k], b[k]) ? r[k] : libSame(r[k], b[k]) ? l[k] : l[k];
    if (val !== undefined) out[k] = val;
  }
  return out;
}

function libIndexPapers(list) {
  const m = new Map();
  for (const p of Array.isArray(list) ? list : []) {
    if (!libIsObject(p)) continue;
    const k = libPaperKey(p);
    if (!m.has(k)) m.set(k, p);
  }
  return m;
}

function libMergePapers(basePapers, localPapers, remotePapers) {
  const bm = libIndexPapers(basePapers), lm = libIndexPapers(localPapers), rm = libIndexPapers(remotePapers);
  const keep = new Map();
  const consider = new Set([...bm.keys(), ...lm.keys(), ...rm.keys()]);
  for (const k of consider) {
    const b = bm.get(k), l = lm.get(k), r = rm.get(k);
    let out = null;
    if (b) {
      if (l && r) out = libMergeFields(b, l, r);
      else if (!l && r) out = libSame(r, b) ? null : r;     // deleted here, edited there: keep the edit
      else if (l && !r) out = libSame(l, b) ? null : l;     // deleted there, edited here: keep the edit
    } else if (l && r) {
      out = libMergeFields({}, l, r);                       // added on both sides
    } else {
      out = l || r;
    }
    if (out) keep.set(k, out);
  }
  // The server's order first, then anything only this device has, in its order.
  const ordered = [];
  const seen = new Set();
  for (const k of rm.keys()) if (keep.has(k) && !seen.has(k)) { ordered.push(keep.get(k)); seen.add(k); }
  for (const k of lm.keys()) if (keep.has(k) && !seen.has(k)) { ordered.push(keep.get(k)); seen.add(k); }
  for (const k of bm.keys()) if (keep.has(k) && !seen.has(k)) { ordered.push(keep.get(k)); seen.add(k); }
  return ordered;
}

function libIndexFolders(list) {
  const m = new Map();
  for (const f of Array.isArray(list) ? list : []) {
    if (!libIsObject(f)) continue;
    const k = libFolderKey(f);
    if (!m.has(k)) m.set(k, f);
  }
  return m;
}

function mergeLibraries(base, local, remote) {
  const baseList = Array.isArray(base) ? base : [];
  const localList = Array.isArray(local) ? local : [];
  const remoteList = Array.isArray(remote) ? remote : [];
  const bm = libIndexFolders(baseList);
  let lm = libIndexFolders(localList);
  const rm = libIndexFolders(remoteList);

  // Two new folders with the same name made on different devices are one
  // folder: give the local one the server's id so they merge into one.
  const nameOf = f => String(f.name || "").trim().toLowerCase();
  const remoteNewByName = new Map();
  for (const [k, f] of rm) if (!bm.has(k) && nameOf(f)) remoteNewByName.set(nameOf(f), { key: k, folder: f });
  if (remoteNewByName.size) {
    const renamed = new Map();
    for (const [k, f] of lm) {
      const twin = !bm.has(k) && !rm.has(k) ? remoteNewByName.get(nameOf(f)) : null;
      if (twin) renamed.set(twin.key, { ...f, id: twin.folder.id });
      else renamed.set(k, f);
    }
    lm = renamed;
  }

  const merged = new Map();
  for (const k of new Set([...bm.keys(), ...lm.keys(), ...rm.keys()])) {
    const b = bm.get(k), l = lm.get(k), r = rm.get(k);
    if (b && !l && !r) continue;                            // gone on both sides
    const deletedHere = !!b && !l, deletedThere = !!b && !r;
    // A side that deleted the folder counts as a folder that kept its fields
    // but lost all its papers, so the other side's changes still survive.
    const lSide = l || { ...b, papers: [] };
    const rSide = r || { ...b, papers: [] };
    const fields = libMergeFields(b || {}, lSide, rSide);
    const papers = libMergePapers(b && b.papers, lSide.papers, rSide.papers);
    if ((deletedHere || deletedThere) && papers.length === 0) continue;
    merged.set(k, { ...fields, papers });
  }

  // New folders from this device first (the app puts new folders on top),
  // then the server's order, then anything left.
  const ordered = [];
  const seen = new Set();
  const push = k => { if (merged.has(k) && !seen.has(k)) { ordered.push(merged.get(k)); seen.add(k); } };
  for (const k of lm.keys()) if (!bm.has(k) && !rm.has(k)) push(k);
  for (const k of rm.keys()) push(k);
  for (const k of lm.keys()) push(k);
  for (const k of bm.keys()) push(k);
  return ordered;
}
// ---- end library-merge ----

// For tests and the server: hands back the functions above.
export function loadLibraryMerge() {
  return { mergeLibraries, libStable, libSame, libPaperKey, libFolderKey };
}
export { mergeLibraries, libStable };
