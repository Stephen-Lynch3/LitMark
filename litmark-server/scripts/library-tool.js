#!/usr/bin/env node
// Backups and restores for students' saved folders.
//
// The database holds the only server-side copy of students' folders, and the
// free tiers of the usual hosts keep little or no history of their own. This
// writes a copy you control, and brings accounts back from one.
//
// Run from the litmark-server folder, with DATABASE_URL set (in .env or in the
// shell; use the database's EXTERNAL connection string when running on your own
// computer):
//
//   node scripts/library-tool.js backup [folder]
//       Writes library-backup-YYYY-MM-DD.json into the folder (default: backups/).
//   node scripts/library-tool.js versions <email>
//       Lists the earlier copies the server kept for one account.
//   node scripts/library-tool.js restore <email> <versionId>
//       Puts one of those earlier copies back (the current copy is kept as a version first).
//   node scripts/library-tool.js restore-file <backup file> <email>
//   node scripts/library-tool.js restore-file <backup file> --all
//       Puts accounts back from a backup file.
//
// The backup file contains students' saved papers and their email addresses.
// It is written readable only by you; keep it off shared drives, out of git,
// and delete old ones.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { countPapers, createLibraryStore } from "../library-store.js";

export function backupFileName(date = new Date()) {
  return `library-backup-${date.toISOString().slice(0, 10)}.json`;
}

export async function backupAll(store, folder, { now = new Date(), fsApi = fs } = {}) {
  const accounts = await store.exportAll();
  const payload = { app: "litmark", kind: "library-backup", version: 1, exportedAt: now.toISOString(), accounts };
  fsApi.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, backupFileName(now));
  fsApi.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  // Read it back and check, rather than trusting that the write worked.
  const back = JSON.parse(fsApi.readFileSync(file, "utf8"));
  if (back.accounts.length !== accounts.length) throw new Error("the backup file did not read back correctly");
  return { file, accounts: accounts.length, papers: accounts.reduce((n, a) => n + countPapers(a.folders), 0) };
}

export async function restoreFromFile(store, file, which, { fsApi = fs } = {}) {
  const data = JSON.parse(fsApi.readFileSync(file, "utf8"));
  if (data?.kind !== "library-backup" || !Array.isArray(data.accounts)) throw new Error("that does not look like a LitMark library backup");
  const chosen = which === "--all" ? data.accounts : data.accounts.filter(a => a.email === which);
  if (!chosen.length) throw new Error(which === "--all" ? "the backup has no accounts" : `no account ${which} in that backup`);
  let restored = 0;
  for (const a of chosen) {
    await store.save(a.email, a.folders, undefined, { forceSnapshot: true });
    restored++;
  }
  return { restored };
}

export async function main(argv, { store, out = console.log } = {}) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "backup": {
      const r = await backupAll(store, args[0] || "backups");
      out(`Backed up ${r.accounts} account${r.accounts === 1 ? "" : "s"} (${r.papers} saved papers) to ${r.file}`);
      return 0;
    }
    case "versions": {
      if (!args[0]) { out("usage: versions <email>"); return 2; }
      const list = await store.listVersions(args[0]);
      if (!list.length) { out("No earlier versions kept for that account."); return 0; }
      for (const v of list) out(`version ${v.id}  saved ${new Date(v.savedAt).toISOString()}  ${v.papers} papers  (was revision ${v.revision})`);
      return 0;
    }
    case "restore": {
      const [email, id] = args;
      if (!email || !/^\d+$/.test(id || "")) { out("usage: restore <email> <versionId>"); return 2; }
      const r = await store.restoreVersion(email, Number(id));
      out(`Restored. The account is now at revision ${r.revision}. The copy it replaced was kept as a version.`);
      return 0;
    }
    case "restore-file": {
      const [file, which] = args;
      if (!file || !which) { out("usage: restore-file <backup file> <email | --all>"); return 2; }
      const r = await restoreFromFile(store, file, which);
      out(`Restored ${r.restored} account${r.restored === 1 ? "" : "s"} from ${file}. Each replaced copy was kept as a version.`);
      return 0;
    }
    default:
      out("Commands: backup [folder] | versions <email> | restore <email> <versionId> | restore-file <file> <email|--all>");
      return cmd ? 2 : 0;
  }
}

// Only runs when started from the command line, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import("dotenv/config");
  const { default: pg } = await import("pg");
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set."); process.exit(1); }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const store = createLibraryStore(pool);
    process.exitCode = await main(process.argv.slice(2), { store });
  } catch (err) {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
