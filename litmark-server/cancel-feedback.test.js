import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanFeedback, createFeedbackStore, MAX_COMMENT, REASONS } from "./cancel-feedback.js";

test("1. a listed reason is accepted; anything else is refused", () => {
  assert.equal(cleanFeedback({ reason: "too_expensive" }).ok, true);
  assert.equal(cleanFeedback({ reason: "made_up" }).ok, false);
  assert.equal(cleanFeedback({}).ok, false);
  assert.equal(cleanFeedback(null).ok, false);
  assert.equal(cleanFeedback({ reason: ["other"] }).ok, false);
  for (const r of REASONS) assert.equal(cleanFeedback({ reason: r.id }).ok, true);
});

test("2. the comment is tidied, stripped of control characters and cut to length", () => {
  const r = cleanFeedback({ reason: "other", comment: "  too\u0000 many\n\n spaces  " });
  assert.equal(r.value.comment, "too many spaces");
  assert.equal(cleanFeedback({ reason: "other", comment: "x".repeat(2000) }).value.comment.length, MAX_COMMENT);
  assert.equal(cleanFeedback({ reason: "other" }).value.comment, "");
  assert.equal(cleanFeedback({ reason: "other", comment: { a: 1 } }).value.comment, "[object Object]".slice(0, MAX_COMMENT));
});

test("3. answers are saved with parameters, and a repeat within a day is not counted twice", async () => {
  const calls = [];
  let inserted = false;
  const pool = { query: async (q, p) => { calls.push([q, p]); if (/INSERT INTO cancel_feedback/.test(q)) { const first = !inserted; inserted = true; return { rows: first ? [{ id: 1 }] : [] }; } return { rows: [] }; } };
  const store = createFeedbackStore(pool);
  await store.ensureSchema();
  assert.equal(await store.add("a@b.c", { reason: "other", comment: "x'; DROP TABLE users;--" }), true);
  assert.equal(await store.add("a@b.c", { reason: "other", comment: "again" }), false);
  const ins = calls.find(([q]) => /INSERT INTO cancel_feedback/.test(q));
  assert.deepEqual(ins[1], ["a@b.c", "other", "x'; DROP TABLE users;--"]);
  assert.ok(!ins[0].includes("DROP TABLE"));
});

test("4. the summary names the reasons in words and counts them", async () => {
  const pool = { query: async q => /GROUP BY/.test(q) ? { rows: [{ reason: "too_expensive", n: 3 }, { reason: "not_using", n: 1 }] } : { rows: [{ reason: "not_using", comment: "busy", created_at: "2026-11-11" }] } };
  const s = await createFeedbackStore(pool).summary(10);
  assert.equal(s.total, 4);
  assert.equal(s.byReason[0].label, "It's too expensive");
  assert.equal(s.recent[0].reason, "I don't use it enough");
});
