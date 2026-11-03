// How much one account may do in an hour.
//
// The limit exists to stop one subscription being shared between several
// people, and to cap cost. It used to count every action the same, so a student
// working through a folder (asking Vera a few questions, tapping "explain" on
// some papers) used up the same allowance as a full literature search, and
// could be told their account "looks shared" while doing nothing unusual.
//
// Now each action has a cost in "searches": a search or a citation check is 1,
// a summary of a whole folder or adding a paper by DOI is a half, and a Vera
// question or a one-paper explanation is a quarter. The hourly allowance
// stays at 20 searches' worth. A request is let through while the hour's total
// is still under the allowance, so a normal day never notices it.
//
// The running totals are kept in memory for speed and copied to the database
// as they happen, so a redeploy no longer hands everyone a fresh allowance. If
// the database is unavailable the limiter carries on from memory alone.
//
// Kept apart from server.js so it can be unit-tested: `npm test`.

const HOUR = 60 * 60 * 1000;

export const COSTS = {
  full: 1,      // search, for & against, citation check, Hit the Mark
  half: 0.5,    // summarise a whole folder, add a paper by DOI, search-query helper
  light: 0.25,  // a Vera question, one paper's summary or explanation
};

export function parseLimit(raw, fallback = 20) {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createRateLimiter({ windowMs = HOUR, max = 20, now = Date.now, store = null, log = console } = {}) {
  const events = new Map(); // email -> [{ at, cost }], oldest first
  let lastStoreError = 0;

  const storeFailed = (what, err) => {
    // One line a minute at most, so a database outage doesn't flood the logs.
    if (now() - lastStoreError > 60_000) {
      lastStoreError = now();
      log.error(`[rate-limit] could not ${what}; carrying on from memory:`, err?.message || err);
    }
  };

  function recent(email) {
    const cutoff = now() - windowMs;
    const list = (events.get(email) || []).filter(e => e.at > cutoff);
    if (list.length) events.set(email, list); else events.delete(email);
    return list;
  }

  const sum = (list) => list.reduce((a, e) => a + e.cost, 0);

  // Lets the action through if the hour's total is still under the allowance,
  // and records it. Otherwise says how long until there is room again.
  function check(email, cost = COSTS.full) {
    const c = Number.isFinite(cost) && cost > 0 ? cost : COSTS.full;
    const list = recent(email);
    const used = sum(list);
    if (used >= max) {
      // Room opens up once enough of the oldest actions fall out of the window.
      let remaining = used;
      let waitUntil = now();
      for (const e of list) {
        remaining -= e.cost;
        waitUntil = e.at + windowMs;
        if (remaining < max) break;
      }
      return { ok: false, used, retryAfterMs: Math.max(1000, waitUntil - now()) };
    }
    const at = now();
    list.push({ at, cost: c });
    events.set(email, list);
    if (store) {
      try {
        const p = store.record(email, at, c);
        if (p && typeof p.catch === "function") p.catch(err => storeFailed("save usage", err));
      } catch (err) { storeFailed("save usage", err); }
    }
    return { ok: true, used: used + c, retryAfterMs: 0 };
  }

  // On startup: bring back what the previous process had counted in the last
  // hour. Only events from before this process started are loaded, so nothing
  // is counted twice if requests arrive while this is still running.
  async function hydrate(startedAt = now()) {
    if (!store) return 0;
    try {
      const rows = await store.load(startedAt - windowMs, startedAt);
      for (const r of rows) {
        const list = events.get(r.email) || [];
        list.push({ at: Number(r.at), cost: Number(r.cost) });
        events.set(r.email, list);
      }
      for (const [email, list] of events) events.set(email, list.sort((a, b) => a.at - b.at));
      return rows.length;
    } catch (err) {
      storeFailed("load earlier usage", err);
      return 0;
    }
  }

  // Housekeeping: forget accounts with nothing in the window, and trim the table.
  async function sweep() {
    for (const email of [...events.keys()]) recent(email);
    if (store) {
      try { await store.prune(now() - 2 * windowMs); } catch (err) { storeFailed("clean up old usage", err); }
    }
  }

  return { check, hydrate, sweep, used: (email) => sum(recent(email)), accounts: () => events.size };
}

// ---- the database side ----
export function createUsageStore(pool) {
  return {
    async ensureSchema() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS usage_events (
          email TEXT NOT NULL,
          used_at TIMESTAMPTZ NOT NULL,
          cost REAL NOT NULL
        )
      `);
      await pool.query("CREATE INDEX IF NOT EXISTS usage_events_used_at_idx ON usage_events (used_at)");
    },
    async record(email, atMs, cost) {
      await pool.query("INSERT INTO usage_events (email, used_at, cost) VALUES ($1, to_timestamp($2::double precision / 1000.0), $3)", [email, atMs, cost]);
    },
    async load(sinceMs, untilMs) {
      const { rows } = await pool.query(
        `SELECT email, (EXTRACT(EPOCH FROM used_at) * 1000)::double precision AS at_ms, cost
         FROM usage_events
         WHERE used_at >= to_timestamp($1::double precision / 1000.0) AND used_at < to_timestamp($2::double precision / 1000.0)
         ORDER BY used_at`,
        [sinceMs, untilMs]
      );
      return rows.map(r => ({ email: r.email, at: Math.round(Number(r.at_ms)), cost: Number(r.cost) }));
    },
    async prune(beforeMs) {
      await pool.query("DELETE FROM usage_events WHERE used_at < to_timestamp($1::double precision / 1000.0)", [beforeMs]);
    },
  };
}
