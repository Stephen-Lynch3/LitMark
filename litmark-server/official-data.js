// A headline official figure for a student's question, shown above the papers.
//
// "How common is type 2 diabetes in UK adults?" is answered by a number from a
// statistics agency, not by a paper, and the usual way students get that number
// (a chatbot) invents it. This looks the figure up from the World Bank's open
// data service and hands it back with its definition, its original source and
// the details a citation needs.
//
// The rule that matters: the AI only chooses WHICH indicator and WHICH country
// to look up. The number, the year and the definition all come from the data
// service's own response, never from the model. If anything is unsure (no
// matching indicator, a low-confidence match, the service down or slow) this
// returns null and the search carries on as if it were not here.
//
// Licence: World Bank Open Data is CC BY 4.0 and free for commercial use with
// attribution (https://data.worldbank.org/summary-terms-of-use). Each result
// carries "The World Bank" as its author and a link back to the dataset.
//
// Everything outside the network and the model is plain functions, so it can be
// tested without either: `fetchFn` and `askModel` are passed in.

const WB_BASE = "https://api.worldbank.org/v2";
const WDI_SOURCE = 2; // World Development Indicators
const MIN_CONFIDENCE = 70;
const SHORTLIST_SIZE = 25;
const SERIES_POINTS = 15;

// ---------- Does this question want a figure at all? ----------
// A cheap check before anything else, so most searches never pay for a model
// call. Deliberately a little generous: the model, which is told to be strict,
// has the final say.
const QUANTITY = /\b(how (many|much|common|big|large|often|prevalent|widespread)|prevalence|incidence|rates? of|rate|percentage|proportion|share of|number of|statistics?|stats|trends? in|per capita|per head|average|growth in|increase in|decrease in|decline in|levels? of|scale of|extent of|burden of)\b/i;
const TOPIC = /\b(unemployment|employment|inflation|gdp|economic growth|poverty|inequality|life expectancy|mortality|obesity|diabetes|smoking|tobacco|alcohol|literacy|enrol\w*|tertiary education|fertility|birth rate|population|migration|emissions|carbon|renewable|internet|broadband|health(?:care)? (?:spending|expenditure)|military spending|homeless\w*|suicide|hiv|tuberculosis|maternal|child mortality|immuni[sz]ation|vaccination)\b/i;

export function wantsFigure(question) {
  const q = String(question || "");
  // A bare keyword ("diabetes") isn't asking for a number; a question is.
  if (q.trim().split(/\s+/).filter(Boolean).length < 3) return false;
  return QUANTITY.test(q) || TOPIC.test(q);
}

// ---------- Shortlisting indicators for a question ----------
const STOP = new Set((
  "the and for with that this from into over under than then them they their there about between among what which who whom whose when where why how " +
  "does did doing done are was were been being have has had having can could would should will shall may might must not nor but yet its our your " +
  "uk united kingdom britain british england english scotland wales scottish welsh world global worldwide country countries nation national " +
  "impact effect effects role discuss evaluate critically analyse analyze explain examine assess compare contrast essay question study studies " +
  "common many much often big large level levels rate rates number numbers total percentage proportion share figure figures statistic statistics stats " +
  "people person persons across within without per all any some more most less least very also such other another each both being"
).split(/\s+/));

function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 2 && !STOP.has(t))
    .map(t => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

// `catalogue` entries: { id, name, note, org, nameTokens: Set, noteTokens: Set }
export function shortlistIndicators(question, catalogue, size = SHORTLIST_SIZE) {
  const q = [...new Set(tokens(question))];
  if (!q.length || !Array.isArray(catalogue)) return [];
  const scored = [];
  for (const ind of catalogue) {
    let s = 0;
    for (const t of q) {
      if (ind.nameTokens.has(t)) s += 3;
      else if (ind.noteTokens.has(t)) s += 1;
    }
    if (s >= 3) scored.push({ ind, s: s - ind.nameTokens.size * 0.05 });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, size).map(x => x.ind);
}

// ---------- Asking the model to choose ----------
function clip(text, n) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return (lastStop > n * 0.5 ? cut.slice(0, lastStop + 1) : cut.replace(/\s+\S*$/, "") + "…").trim();
}

export function buildChoicePrompt(question, shortlist) {
  const lines = shortlist.map((ind, i) => `${i + 1}. ${ind.id} | ${ind.name} | ${clip(ind.note, 160)}`).join("\n");
  return `A student is researching this question:
"${String(question).slice(0, 500)}"

Below are World Bank indicators. Choose the ONE indicator whose figure the student would most likely quote when writing about this question, for example how common something is, how many, or a rate. Answer null if none of them genuinely measures it, or if the question is really about whether something works (an effect or mechanism) rather than how big or common something is.

Be strict. A close but different measure is worse than none: do not pick an adult measure for a question about children, or a whole-population measure for a specific condition.

Also choose the country as a three-letter ISO code. If the question names a country or region use it. If the question says global or worldwide use WLD. If it names none, use GBR.

If the indicator's definition differs in any way from what the question asks about (for example it covers more or less than the question does), say so in "caveat" in one plain sentence with no numbers. Otherwise leave "caveat" empty.

Indicators:
${lines}

Respond with ONLY JSON in this exact shape, nothing else:
{"indicator": "ID or null", "country": "ISO3", "confidence": 0-100, "caveat": ""}`;
}

export function parseChoice(text, shortlist) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || "").replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const id = typeof parsed.indicator === "string" ? parsed.indicator.trim() : "";
  const indicator = shortlist.find(ind => ind.id === id);
  if (!indicator) return null; // "null", or an ID the model made up
  const country = typeof parsed.country === "string" ? parsed.country.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(country)) return null;
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) return null;
  let caveat = typeof parsed.caveat === "string" ? parsed.caveat.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 220) : "";
  // The caveat is the model's words about the definition, never a source of
  // figures: anything that looks like a statistic is dropped.
  if (/\d+(\.\d+)?\s?%|\d{3,}|\d+\.\d+/.test(caveat)) caveat = "";
  return { indicator, country, confidence, caveat };
}

// ---------- Reading the World Bank's responses ----------
function toCatalogueEntry(raw) {
  if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  // If an endpoint ignores the source filter, indicators from other databases
  // come back too; only World Development Indicators are wanted.
  if (raw.source?.id !== undefined && String(raw.source.id) !== String(WDI_SOURCE)) return null;
  const note = typeof raw.sourceNote === "string" ? raw.sourceNote : "";
  return {
    id: raw.id,
    name: raw.name.trim(),
    note: note.trim(),
    org: typeof raw.sourceOrganization === "string" ? raw.sourceOrganization.trim() : "",
    nameTokens: new Set(tokens(raw.name)),
    noteTokens: new Set(tokens(note.slice(0, 400)))
  };
}

export function parseCatalogue(body) {
  if (!Array.isArray(body) || body.length < 2 || !Array.isArray(body[1])) return { entries: [], lastUpdatedYear: null };
  const entries = body[1].map(toCatalogueEntry).filter(Boolean);
  const m = /(\d{4})/.exec(String(body[0]?.lastupdated || ""));
  return { entries, lastUpdatedYear: m ? Number(m[1]) : null };
}

// Newest first in, oldest first out, nulls removed. null when there is nothing.
export function parseSeries(body) {
  if (!Array.isArray(body) || body.length < 2 || !Array.isArray(body[1])) return null;
  const rows = body[1]
    .filter(r => r && r.value !== null && r.value !== undefined && Number.isFinite(Number(r.value)) && /^\d{4}$/.test(String(r.date)))
    .map(r => ({ year: Number(r.date), value: Number(r.value), decimal: Number.isFinite(Number(r.decimal)) ? Number(r.decimal) : null, country: r.country, iso3: r.countryiso3code }));
  if (!rows.length) return null;
  rows.sort((a, b) => b.year - a.year);
  const latest = rows[0];
  const series = rows.slice(0, SERIES_POINTS).reverse().map(r => ({ year: r.year, value: r.value }));
  const m = /(\d{4})/.exec(String(body[0]?.lastupdated || ""));
  return { latest, series, lastUpdatedYear: m ? Number(m[1]) : null };
}

// How the headline number reads. The unit is taken from the indicator's own
// name, which is where the World Bank puts it: "(% of population ...)",
// "(current US$)".
export function formatValue(value, indicatorName, decimals) {
  const d = Number.isInteger(decimals) && decimals >= 0 && decimals <= 4 ? decimals : (Math.abs(value) >= 100 ? 0 : 1);
  const n = Number(value);
  if (/%/.test(indicatorName)) return `${n.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
  if (/US\$/.test(indicatorName)) return `US$${n.toLocaleString("en-GB", { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2 })}`;
  return n.toLocaleString("en-GB", { maximumFractionDigits: d });
}

// ---------- The factory ----------
export function createOfficialData({
  fetchFn = globalThis.fetch,
  askModel,
  enabled = true,
  now = Date.now,
  log = console,
  answerTtlMs = 24 * 60 * 60 * 1000,
  catalogueTtlMs = 24 * 60 * 60 * 1000,
  failureTtlMs = 5 * 60 * 1000,
  maxAnswers = 500
} = {}) {
  let catalogue = null; // { entries, lastUpdatedYear, at }
  let catalogueLoading = null;
  let catalogueFailedAt = 0;
  const answers = new Map(); // normalised question -> { at, card }

  const getJson = async (url) => {
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`World Bank ${res.status}`);
    return res.json();
  };

  // The list of World Development Indicators, with each one's definition and
  // original source. (Checked against the live service: /v2/indicator?source=2 is
  // rejected, this form works.) A wrong address answers with an error body, not
  // an HTTP error, which parseCatalogue treats as an empty list.
  const catalogueUrls = [`${WB_BASE}/sources/${WDI_SOURCE}/indicators?format=json&per_page=2000`];
  let catalogueUrlFirst = 0;

  async function loadCatalogue() {
    if (catalogue && now() - catalogue.at < catalogueTtlMs) return catalogue;
    if (catalogueFailedAt && now() - catalogueFailedAt < failureTtlMs) return null;
    if (!catalogueLoading) {
      catalogueLoading = (async () => {
        try {
          let lastError = "empty indicator list";
          for (let n = 0; n < catalogueUrls.length; n++) {
            const i = (catalogueUrlFirst + n) % catalogueUrls.length;
            try {
              const parsed = parseCatalogue(await getJson(catalogueUrls[i]));
              if (!parsed.entries.length) { lastError = "empty indicator list"; continue; }
              catalogueUrlFirst = i;
              catalogue = { ...parsed, at: now() };
              catalogueFailedAt = 0;
              return catalogue;
            } catch (err) {
              lastError = err.message;
            }
          }
          throw new Error(lastError);
        } catch (err) {
          catalogueFailedAt = now();
          log.warn?.("[official-data] indicator list unavailable:", err.message);
          return null;
        } finally {
          catalogueLoading = null;
        }
      })();
    }
    return catalogueLoading;
  }

  function remember(key, card) {
    if (answers.size >= maxAnswers) answers.delete(answers.keys().next().value);
    answers.set(key, { at: now(), card });
  }

  // Resolves to a card, to null ("there is no good figure for this question",
  // worth remembering) or to undefined ("couldn't tell right now", not
  // remembered, so the next search tries again).
  async function lookUp(question) {
    const cat = await loadCatalogue();
    if (!cat) return undefined;
    const shortlist = shortlistIndicators(question, cat.entries);
    if (!shortlist.length) return null;

    const reply = await askModel(buildChoicePrompt(question, shortlist));
    const choice = parseChoice(reply, shortlist);
    if (!choice) return /\{[\s\S]*\}/.test(String(reply || "")) ? null : undefined;

    const { indicator, country, caveat, confidence } = choice;
    const body = await getJson(`${WB_BASE}/country/${encodeURIComponent(country)}/indicator/${encodeURIComponent(indicator.id)}?format=json&per_page=70`);
    const data = parseSeries(body);
    if (!data) return null;

    const { latest, series } = data;
    const geography = String(latest.country?.value || country);
    const iso2 = String(latest.country?.id || "").trim();
    const url = `https://data.worldbank.org/indicator/${encodeURIComponent(indicator.id)}${iso2 ? `?locations=${encodeURIComponent(iso2)}` : ""}`;
    return {
      provider: "World Bank",
      indicatorId: indicator.id,
      title: indicator.name,
      geography,
      geographyCode: country,
      value: latest.value,
      valueText: formatValue(latest.value, indicator.name, latest.decimal),
      year: latest.year,
      series,
      definition: clip(indicator.note, 420),
      originalSource: clip(indicator.org, 160),
      caveat,
      url,
      citation: {
        author: "World Bank",
        title: `${indicator.name} – ${geography} [dataset]`,
        container: "World Development Indicators",
        year: data.lastUpdatedYear || cat.lastUpdatedYear || null,
        url
      },
      // The wording the licence (CC BY 4.0) asks for: who, which dataset, and
      // where the data originally came from.
      attribution: `The World Bank: World Development Indicators${indicator.org ? `: ${clip(indicator.org, 160)}` : ""}`,
      licence: "CC BY 4.0",
      matchConfidence: confidence
    };
  }

  // Never throws, never blocks for long: the search that called this must not
  // care whether it worked.
  async function find(question) {
    try {
      if (!enabled || typeof askModel !== "function") return null;
      const q = String(question || "").trim();
      if (!wantsFigure(q)) return null;
      const key = q.toLowerCase().replace(/\s+/g, " ").replace(/[?.!\s]+$/, "");
      const hit = answers.get(key);
      if (hit && now() - hit.at < answerTtlMs) return hit.card;
      const card = await lookUp(q);
      if (card === undefined) return null;
      remember(key, card);
      return card;
    } catch (err) {
      log.warn?.("[official-data] no figure for this search:", err.message);
      return null; // failures are not remembered, so the next search tries again
    }
  }

  // Loads the indicator list ahead of the first search. Never throws.
  async function warm() {
    try {
      if (enabled) await loadCatalogue();
    } catch {
      /* loadCatalogue already logs and swallows its own failures */
    }
  }

  return { find, warm };
}
