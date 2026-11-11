// "Before you go": why someone is cancelling. Optional for the student, and
// stored in Postgres with a short list of reasons plus an optional comment, so
// the answers can be counted.
//
// `pool` only needs `query(text, params) -> { rows }`, as `pg` gives.

export const REASONS = [
  { id: "too_expensive", label: "It's too expensive" },
  { id: "not_using", label: "I don't use it enough" },
  { id: "course_not_covered", label: "My course or subject isn't really covered" },
  { id: "finished", label: "I've finished the assignment I needed it for" },
  { id: "results_quality", label: "The papers I found weren't good enough" },
  { id: "missing_feature", label: "It's missing something I need" },
  { id: "technical", label: "Something didn't work properly" },
  { id: "other", label: "Something else" }
];
const IDS = new Set(REASONS.map(r => r.id));
export const MAX_COMMENT = 500;

// Strips control characters, then trims and cuts to length.
const tidy = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

export function cleanFeedback(body) {
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!IDS.has(reason)) return { ok: false, error: "Choose one of the reasons." };
  return { ok: true, value: { reason, comment: tidy(body?.comment, MAX_COMMENT) } };
}

export function createFeedbackStore(pool) {
  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cancel_feedback (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        reason TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS cancel_feedback_created_idx ON cancel_feedback (created_at DESC)`);
  }

  // One answer per person per day: pressing the button twice does not count twice.
  async function add(email, { reason, comment }) {
    const { rows } = await pool.query(
      `INSERT INTO cancel_feedback (email, reason, comment)
       SELECT $1, $2, $3
       WHERE NOT EXISTS (SELECT 1 FROM cancel_feedback WHERE email = $1 AND created_at > now() - interval '1 day')
       RETURNING id`,
      [email, reason, comment]
    );
    return rows.length > 0;
  }

  // Counts per reason plus the most recent comments, for the owner.
  async function summary(limit = 50) {
    const counts = await pool.query("SELECT reason, COUNT(*)::int AS n FROM cancel_feedback GROUP BY reason ORDER BY n DESC");
    const recent = await pool.query(
      "SELECT reason, comment, created_at FROM cancel_feedback ORDER BY created_at DESC LIMIT $1",
      [Math.max(1, Math.min(200, limit))]
    );
    const label = Object.fromEntries(REASONS.map(r => [r.id, r.label]));
    return {
      total: counts.rows.reduce((n, r) => n + r.n, 0),
      byReason: counts.rows.map(r => ({ reason: r.reason, label: label[r.reason] || r.reason, count: r.n })),
      recent: recent.rows.map(r => ({ reason: label[r.reason] || r.reason, comment: r.comment, at: r.created_at }))
    };
  }

  return { ensureSchema, add, summary };
}
