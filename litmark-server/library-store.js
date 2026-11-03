// A student's saved folders, kept in Postgres.
//
// Each account has one row. What this adds over a plain "replace the row":
//
//  - A revision number. Every write bumps it, and a client that says "I based
//    this on revision 7" is refused if the row has moved on, and is handed the
//    current copy so it can merge. That is what stops a stale device from
//    wiping out what another device saved. A client that sends no revision at
//    all (an older copy of the app still open in someone's browser) is
//    treated as before: its copy replaces the row.
//
//  - Previous versions. Before a write replaces the stored folders, the old
//    copy is kept as a snapshot when it is worth keeping: at least one every
//    30 minutes, and always when a write removes a big chunk of papers.
//    The last 12 are kept per account. That is the safety net for any bug,
//    bad client or mistaken bulk delete: the old copy can be put back.
//
// `pool` only needs `query(text, params) -> { rows }`, which is what `pg`
// gives, so this can be tested against a fake or a real database.

const SNAPSHOT_EVERY_SECONDS = 30 * 60;
const KEEP_VERSIONS = 12;

export function countPapers(folders) {
  if (!Array.isArray(folders)) return 0;
  let n = 0;
  for (const f of folders) if (f && Array.isArray(f.papers)) n += f.papers.length;
  return n;
}

// Losing 3 or more papers, and at least 30% of them, in one save.
function isBigShrink(oldCount, newCount) {
  const lost = oldCount - newCount;
  return lost >= 3 && newCount <= oldCount * 0.7;
}

export function createLibraryStore(pool, { snapshotEverySeconds = SNAPSHOT_EVERY_SECONDS, keepVersions = KEEP_VERSIONS, log = console } = {}) {
  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS library (
        email TEXT PRIMARY KEY,
        folders JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`ALTER TABLE library ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS library_versions (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        revision BIGINT NOT NULL,
        folders JSONB NOT NULL,
        papers INTEGER NOT NULL DEFAULT 0,
        saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS library_versions_email_idx ON library_versions (email, saved_at DESC)`);
  }

  // { folders: [...] | null, revision }. null means "this account has nothing
  // stored yet", which is different from an empty list.
  async function load(email) {
    const { rows } = await pool.query("SELECT folders, revision FROM library WHERE email = $1", [email]);
    if (!rows[0]) return { folders: null, revision: 0 };
    return { folders: rows[0].folders ?? null, revision: Number(rows[0].revision) };
  }

  async function takeSnapshot(email, row) {
    try {
      await pool.query(
        "INSERT INTO library_versions (email, revision, folders, papers) VALUES ($1, $2, $3::jsonb, $4)",
        [email, row.revision, JSON.stringify(row.folders), countPapers(row.folders)]
      );
      await pool.query(
        `DELETE FROM library_versions WHERE email = $1 AND id NOT IN (
           SELECT id FROM library_versions WHERE email = $1 ORDER BY saved_at DESC, id DESC LIMIT $2
         )`,
        [email, keepVersions]
      );
    } catch (err) {
      // A failed snapshot must never block the student's own save.
      log.error("[library] could not keep a previous version:", err.message);
    }
  }

  async function shouldSnapshot(email, oldRow, newFolders) {
    const oldCount = countPapers(oldRow.folders);
    if (oldCount === 0) return false; // nothing worth keeping
    if (isBigShrink(oldCount, countPapers(newFolders))) return true;
    try {
      const { rows } = await pool.query(
        "SELECT EXTRACT(EPOCH FROM (now() - max(saved_at))) AS age FROM library_versions WHERE email = $1",
        [email]
      );
      const age = rows[0]?.age;
      return age === null || age === undefined || Number(age) >= snapshotEverySeconds;
    } catch {
      return false;
    }
  }

  // Resolves to { ok: true, revision } or { conflict: true, folders, revision }.
  // `baseRevision`: a number or null (null = "I believe nothing is stored
  // yet"), or undefined for an older client that doesn't track revisions.
  async function save(email, folders, baseRevision, { forceSnapshot = false } = {}) {
    const json = JSON.stringify(folders);
    for (let attempt = 0; attempt < 4; attempt++) {
      const { rows } = await pool.query("SELECT folders, revision FROM library WHERE email = $1", [email]);
      const row = rows[0];

      if (!row) {
        const ins = await pool.query(
          `INSERT INTO library (email, folders, revision, updated_at) VALUES ($1, $2::jsonb, 1, now())
           ON CONFLICT (email) DO NOTHING RETURNING revision`,
          [email, json]
        );
        if (ins.rows[0]) return { ok: true, revision: Number(ins.rows[0].revision) };
        continue; // someone else created it a moment ago: look again
      }

      const current = Number(row.revision);
      if (baseRevision !== undefined && baseRevision !== current) {
        return { conflict: true, folders: row.folders, revision: current };
      }

      if (forceSnapshot || await shouldSnapshot(email, row, folders)) {
        await takeSnapshot(email, { revision: current, folders: row.folders });
      }

      const upd = await pool.query(
        `UPDATE library SET folders = $2::jsonb, revision = revision + 1, updated_at = now()
         WHERE email = $1 AND revision = $3 RETURNING revision`,
        [email, json, current]
      );
      if (upd.rows[0]) return { ok: true, revision: Number(upd.rows[0].revision) };
      // The row changed between reading it and writing it. A client that sent
      // a revision is told to merge; one that didn't just tries again.
      if (baseRevision !== undefined) {
        const again = await load(email);
        return { conflict: true, folders: again.folders, revision: again.revision };
      }
    }
    throw new Error("could not save the library after several attempts");
  }

  // ----- for the backup tool -----

  async function exportAll() {
    const { rows } = await pool.query("SELECT email, folders, revision, updated_at FROM library ORDER BY email");
    return rows.map(r => ({ email: r.email, revision: Number(r.revision), updatedAt: r.updated_at, folders: r.folders }));
  }

  async function listVersions(email) {
    const { rows } = await pool.query(
      "SELECT id, revision, papers, saved_at FROM library_versions WHERE email = $1 ORDER BY saved_at DESC, id DESC",
      [email]
    );
    return rows.map(r => ({ id: Number(r.id), revision: Number(r.revision), papers: Number(r.papers), savedAt: r.saved_at }));
  }

  // Puts an earlier copy back. The current copy is kept as a version first, so
  // a restore can itself be undone.
  async function restoreVersion(email, versionId) {
    const { rows } = await pool.query("SELECT folders FROM library_versions WHERE email = $1 AND id = $2", [email, versionId]);
    if (!rows[0]) throw new Error(`no version ${versionId} for ${email}`);
    return save(email, rows[0].folders, undefined, { forceSnapshot: true });
  }

  return { ensureSchema, load, save, exportAll, listVersions, restoreVersion };
}
