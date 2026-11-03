// Noticing when a literature source has quietly stopped answering.
//
// Each of the seven sources is wrapped so that a failure (a rate limit, an
// exhausted credit allowance, an outage) is logged and turned into an empty
// list. That keeps a search working when one source is down, but it also means
// a source can be dead for days with nothing but a line in the logs. When
// OpenAlex's metered credits ran out, searches got worse and nobody was told.
//
// This keeps a running count, per source, of how many searches in a row it
// returned nothing, and emails the owner when a source you depend on has been
// quiet for several searches. Three guards keep it from crying wolf:
//
//  - A search only counts against a source when other sources did answer it.
//    If nothing at all answered (a nonsense question, or the server has lost
//    its network) there is no way to say which source is to blame.
//  - Only the sources that should answer almost any question are watched by
//    default: OpenAlex, Semantic Scholar (when it has an API key, otherwise it
//    is rate-limited into silence all the time), and "all sources at once".
//    Europe PMC is biomedical and ERIC is education, so a zero from them is
//    normal. Crossref returns nothing at all in the default open-access mode,
//    and CORE nothing without an API key.
//  - One email per outage, a reminder every 12 hours while it lasts, and one
//    more when the source comes back.
//
// Also decides whether a search run was healthy enough for its answer to be
// kept by the response cache. Kept apart from server.js so it can be
// unit-tested: `npm test`.

const HOUR = 60 * 60 * 1000;

export const SOURCE_NAMES = ["OpenAlex", "Semantic Scholar", "Europe PMC", "CORE", "DOAJ", "Crossref", "ERIC"];
export const ALL_SOURCES = "All sources";
export const DEFAULT_WATCH = ["OpenAlex", "Semantic Scholar", ALL_SOURCES];

// `settled` is the result of Promise.allSettled over the source calls, and
// `labels` names the source behind each position, so the order the calls were
// made in doesn't matter. A rejected call counts as nothing.
export function tallySources(settled, labels) {
  const counts = Object.fromEntries(SOURCE_NAMES.map(n => [n, 0]));
  settled.forEach((r, i) => {
    const name = labels[i];
    if (!(name in counts)) return;
    if (r && r.status === "fulfilled" && Array.isArray(r.value)) counts[name] += r.value.length;
  });
  return counts;
}

// The seven sources in their usual order, repeated `times` times: how the
// searches line up their calls (one round on the question, one on the query).
export function repeatSourceLabels(times) {
  return Array.from({ length: times }, () => SOURCE_NAMES).flat();
}

// Whether a search run is fit to have its answer reused. OpenAlex is the
// backbone and the source that has failed before: if it gave nothing, the
// result is thinner than it should be, so it isn't pinned in place for hours.
// (A question so niche that OpenAlex has nothing is cheap to search again.)
// The other sources failing less badly, or a narrow topic that only some of
// them cover, don't make a run unfit.
export function runQuality(counts) {
  return counts["OpenAlex"] > 0 ? "ok" : "degraded";
}

// "OpenAlex, crossref" -> ["OpenAlex", "Crossref"]. Unknown names are ignored,
// and an empty or missing value gives the default.
export function parseWatchList(raw, fallback = DEFAULT_WATCH) {
  const wanted = String(raw ?? "").split(",").map(s => s.trim().toLowerCase().replace(/\s+/g, "")).filter(Boolean);
  if (!wanted.length) return [...fallback];
  const byKey = new Map([...SOURCE_NAMES, ALL_SOURCES].map(n => [n.toLowerCase().replace(/\s+/g, ""), n]));
  const out = [];
  for (const w of wanted) {
    const n = byKey.get(w);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.length ? out : [...fallback];
}

export function createSourceHealth({
  watch = DEFAULT_WATCH,
  threshold = 5,             // searches in a row with nothing before it counts as quiet
  minOthersActive = 1,       // other sources that must have answered for a zero to count
  reminderMs = 12 * HOUR,    // how often to repeat while an outage continues
  errorFreshMs = 30 * 60 * 1000, // an error older than this isn't quoted as the reason
  now = Date.now,
  notify = null,             // (events) => void | Promise; called once per search that has news
  log = console
} = {}) {
  const watched = [...watch];
  const state = new Map(); // name -> { streak, alerted, alertedAt }
  const lastErrors = new Map(); // name -> { message, at }

  const stateOf = (name) => {
    if (!state.has(name)) state.set(name, { streak: 0, alerted: false, alertedAt: 0 });
    return state.get(name);
  };

  // Called from each source's catch block: remembers why it last failed, so
  // the email can say "OpenAlex 429" instead of just "returned nothing".
  function noteError(source, message) {
    lastErrors.set(source, { message: String(message ?? "").slice(0, 300), at: now() });
  }

  const recentError = (name) => {
    const e = lastErrors.get(name);
    return e && now() - e.at <= errorFreshMs ? e.message : null;
  };

  function deliver(events) {
    if (!notify || !events.length) return;
    try {
      const p = notify(events);
      if (p && typeof p.catch === "function") p.catch(err => log.error("[source-health] could not send alert:", err?.message || err));
    } catch (err) {
      log.error("[source-health] could not send alert:", err?.message || err);
    }
  }

  // Feed in the per-source result counts of one finished search. Returns the
  // events it raised, [{ type: "quiet" | "recovered", source, streak, lastError }].
  function record(counts) {
    const events = [];
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    for (const name of watched) {
      const st = stateOf(name);
      let working, informative;
      if (name === ALL_SOURCES) {
        working = total > 0;
        informative = true;
      } else {
        working = (counts[name] ?? 0) > 0;
        const others = Object.entries(counts).filter(([n, c]) => n !== name && c > 0).length;
        informative = others >= minOthersActive;
      }

      if (working) {
        if (st.alerted) events.push({ type: "recovered", source: name, streak: st.streak, lastError: null });
        st.streak = 0;
        st.alerted = false;
        continue;
      }
      if (!informative) continue; // nothing else answered either, so this says nothing about this source

      st.streak++;
      if (st.streak >= threshold && (!st.alerted || now() - st.alertedAt >= reminderMs)) {
        st.alerted = true;
        st.alertedAt = now();
        events.push({ type: "quiet", source: name, streak: st.streak, lastError: recentError(name) });
      }
    }

    for (const e of events) {
      log.error(e.type === "quiet"
        ? `[source-health] ALERT: ${e.source} returned nothing for ${e.streak} searches in a row${e.lastError ? ` (last error: ${e.lastError})` : ""}`
        : `[source-health] ${e.source} is answering again`);
    }
    deliver(events);
    return events;
  }

  function snapshot() {
    return Object.fromEntries(watched.map(name => {
      const st = stateOf(name);
      return [name, { quietSearchesInARow: st.streak, alerted: st.alerted, lastError: lastErrors.get(name)?.message ?? null }];
    }));
  }

  return { record, noteError, snapshot };
}
