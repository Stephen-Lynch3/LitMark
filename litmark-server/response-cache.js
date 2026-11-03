// A short-lived memory of finished search answers.
//
// A cohort is usually set the same assessment question, so thirty students
// searching "the effects of social media on adolescent wellbeing" would each
// trigger the whole pipeline: fourteen literature queries (the OpenAlex
// credits that ran out before), several AI calls, and a wait of many seconds.
// The answer to that question doesn't depend on who asks it, so the first
// student pays for it and everyone after gets the same answer straight away.
//
// Three details matter:
//
//  - Students who ask at the same moment share one run. Thirty people hitting
//    Search together would otherwise all miss the cache, since nothing is
//    stored until the first run finishes.
//  - Nothing bad is kept. An empty answer, or a run where the literature
//    sources were failing (see source-health.js), is returned but never
//    stored, so an outage can't be pinned in place for the rest of the day.
//  - It is bounded. Entries expire, the oldest go first, and there is a cap
//    on the total memory used, since the server has 512MB to share.
//
// Held in memory only, like the rate limiter: a redeploy empties it, which is
// the right behaviour after a change to how searches work. Kept apart from
// server.js so it can be unit-tested: `npm test`.

const HOUR = 60 * 60 * 1000;

// "Does X cause Y?", "does x cause y" and "  Does X cause Y ?? " are the same
// question as far as the literature is concerned.
export function normalizeQuestion(q) {
  return String(q ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s?!.,;:]+$/, "");
}

// Everything that changes which papers come back is part of the key: which
// kind of search it was, the question, the earliest year, and whether
// paywalled papers are included. Nothing about the person asking is, because
// the answer doesn't depend on it.
export function searchCacheKey(kind, question, { minYear = null, includePaywalled = false } = {}) {
  return JSON.stringify([
    kind,
    normalizeQuestion(question),
    Number.isFinite(minYear) ? minYear : null,
    includePaywalled ? 1 : 0
  ]);
}

export function createResponseCache({
  ttlMs = 12 * HOUR,          // how long an answer is reused; 0 or less turns the cache off
  maxEntries = 150,
  maxEntryBytes = 400_000,     // a typical answer is well under 100KB; anything huge isn't worth keeping
  maxTotalBytes = 48_000_000,  // a hard ceiling on memory, whatever the entry count
  inflightMaxMs = 4 * 60 * 1000, // a run that has hung this long is not waited for
  now = Date.now
} = {}) {
  const entries = new Map();   // key -> { json, bytes, expiresAt }, oldest first
  const inflight = new Map();  // key -> { promise, startedAt }
  let totalBytes = 0;
  const counters = { hits: 0, joined: 0, misses: 0, bypassed: 0, stored: 0, notStored: 0, evicted: 0 };

  const drop = (key) => {
    const e = entries.get(key);
    if (!e) return;
    totalBytes -= e.bytes;
    entries.delete(key);
  };

  // Answers are stored as JSON text and rebuilt on every read, so a caller
  // can never change what the next caller receives.
  function lookup(key) {
    const e = entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= now()) { drop(key); return undefined; }
    entries.delete(key);
    entries.set(key, e); // most recently used goes to the back
    return JSON.parse(e.json);
  }

  function store(key, value, ttl) {
    const json = JSON.stringify(value);
    const bytes = json.length * 2; // JS strings are up to two bytes a character
    if (!(ttl > 0) || bytes > maxEntryBytes) { counters.notStored++; return false; }
    drop(key);
    entries.set(key, { json, bytes, expiresAt: now() + ttl });
    totalBytes += bytes;
    while (entries.size > 0 && (entries.size > maxEntries || totalBytes > maxTotalBytes)) {
      drop(entries.keys().next().value);
      counters.evicted++;
    }
    counters.stored++;
    return true;
  }

  // `compute` does the real work and returns { value, cacheable, ttlMs? }:
  // `value` is what the caller gets; `cacheable` says whether it is fit to
  // reuse; `ttlMs` shortens or lengthens this one answer's life.
  // Resolves to { value, status } where status is
  //   "hit"    - served from memory
  //   "joined" - waited for an identical run already in progress
  //   "miss"   - this call did the work
  //   "bypass" - the cache was skipped (switched off, or `bypass: true`)
  // A failed run is never stored, and everyone waiting on it gets the error.
  async function run(key, compute, { bypass = false } = {}) {
    if (bypass || !(ttlMs > 0)) {
      counters.bypassed++;
      const r = await compute();
      return { value: r.value, status: "bypass" };
    }

    const cached = lookup(key);
    if (cached !== undefined) {
      counters.hits++;
      return { value: cached, status: "hit" };
    }

    const running = inflight.get(key);
    if (running && now() - running.startedAt < inflightMaxMs) {
      counters.joined++;
      const r = await running.promise;
      return { value: JSON.parse(JSON.stringify(r.value)), status: "joined" };
    }

    counters.misses++;
    const entry = {
      startedAt: now(),
      promise: (async () => {
        const r = await compute();
        if (r && r.cacheable) store(key, r.value, r.ttlMs ?? ttlMs);
        else counters.notStored++;
        return r;
      })()
    };
    inflight.set(key, entry);
    try {
      const r = await entry.promise;
      return { value: r.value, status: "miss" };
    } finally {
      if (inflight.get(key) === entry) inflight.delete(key);
    }
  }

  return {
    run,
    clear() { entries.clear(); totalBytes = 0; },
    stats() { return { entries: entries.size, approxBytes: totalBytes, inFlight: inflight.size, ...counters }; }
  };
}
