import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupAll, backupFileName, main, restoreFromFile } from "./library-tool.js";

const lib = (...titles) => [{ id: 1, name: "Sleep", papers: titles.map(t => ({ title: t })) }];
function fakeStore(accounts) {
  const saved = [];
  return {
    saved,
    exportAll: async () => accounts,
    save: async (email, folders, base, opts) => { saved.push({ email, folders, base, opts }); return { ok: true, revision: 9 }; },
    listVersions: async () => [{ id: 4, revision: 2, papers: 3, savedAt: "2026-11-03T10:00:00Z" }],
    restoreVersion: async () => ({ ok: true, revision: 10 }),
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "litmark-tool-"));
const accounts = [
  { email: "a@x.com", revision: 3, updatedAt: "t", folders: lib("A", "B") },
  { email: "b@x.com", revision: 1, updatedAt: "t", folders: lib("C") },
];

test("1. a backup is named by date", () => {
  assert.equal(backupFileName(new Date("2026-11-03T18:00:00Z")), "library-backup-2026-11-03.json");
});

test("2. a backup writes every account to a file only the owner can read", async () => {
  const dir = path.join(tmp(), "backups");
  const r = await backupAll(fakeStore(accounts), dir, { now: new Date("2026-11-03T18:00:00Z") });
  assert.equal(r.accounts, 2);
  assert.equal(r.papers, 3);
  assert.equal(path.basename(r.file), "library-backup-2026-11-03.json");
  const data = JSON.parse(fs.readFileSync(r.file, "utf8"));
  assert.equal(data.kind, "library-backup");
  assert.deepEqual(data.accounts.map(a => a.email), ["a@x.com", "b@x.com"]);
  assert.equal(fs.statSync(r.file).mode & 0o077, 0, "no access for group or others");
});

test("3. a backup with no accounts is still a valid file", async () => {
  const r = await backupAll(fakeStore([]), tmp());
  assert.equal(r.accounts, 0);
});

test("4. restoring one account from a backup puts back only that account, keeping what it replaces", async () => {
  const dir = tmp();
  const { file } = await backupAll(fakeStore(accounts), dir);
  const store = fakeStore([]);
  const r = await restoreFromFile(store, file, "b@x.com");
  assert.equal(r.restored, 1);
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].email, "b@x.com");
  assert.equal(store.saved[0].base, undefined);
  assert.equal(store.saved[0].opts.forceSnapshot, true);
});

test("5. --all restores every account", async () => {
  const { file } = await backupAll(fakeStore(accounts), tmp());
  const store = fakeStore([]);
  assert.equal((await restoreFromFile(store, file, "--all")).restored, 2);
});

test("6. restoring an account that is not in the backup, or a file that is not a backup, fails clearly", async () => {
  const { file } = await backupAll(fakeStore(accounts), tmp());
  await assert.rejects(() => restoreFromFile(fakeStore([]), file, "nobody@x.com"), /no account nobody@x.com/);
  const junk = path.join(tmp(), "x.json");
  fs.writeFileSync(junk, JSON.stringify({ hello: 1 }));
  await assert.rejects(() => restoreFromFile(fakeStore([]), junk, "--all"), /does not look like/);
});

test("7. the command line asks for what is missing instead of guessing", async () => {
  const lines = [];
  const out = (s) => lines.push(s);
  assert.equal(await main(["versions"], { store: fakeStore([]), out }), 2);
  assert.equal(await main(["restore", "a@x.com", "not-a-number"], { store: fakeStore([]), out }), 2);
  assert.equal(await main(["restore-file", "f.json"], { store: fakeStore([]), out }), 2);
  assert.equal(await main(["nonsense"], { store: fakeStore([]), out }), 2);
  assert.equal(await main([], { store: fakeStore([]), out }), 0);
});

test("8. versions and restore report in plain words", async () => {
  const lines = [];
  const out = (s) => lines.push(s);
  assert.equal(await main(["versions", "a@x.com"], { store: fakeStore([]), out }), 0);
  assert.match(lines[0], /version 4 .*3 papers/);
  assert.equal(await main(["restore", "a@x.com", "4"], { store: fakeStore([]), out }), 0);
  assert.match(lines[1], /revision 10/);
});
