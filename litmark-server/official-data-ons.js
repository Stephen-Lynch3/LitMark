// UK figures from the Office for National Statistics (ONS), for the "Official
// data" card. Same rule as the World Bank half: the AI only chooses WHICH ONS
// time series to look at. The number, the period and the unit come from the
// ONS's own response.
//
// Not the ONS "datasets" API: that stopped updating in January 2026 (its own
// pages say so). This uses the ONS search, which finds a time series by its
// title, and the ONS data endpoint, which returns the series with every period
// up to the latest release:
//   GET https://api.beta.ons.gov.uk/v1/search?content_type=timeseries&q=...
//   GET https://api.beta.ons.gov.uk/v1/data?uri=<uri from the search result>
// No key. Licence: Open Government Licence v3.0 (attribution statement below).
// Both response shapes below were checked against live responses.

export const ONS_BASE = "https://api.beta.ons.gov.uk/v1";
const MIN_CONFIDENCE = 70;
const MAX_CANDIDATES = 40;

// ---------- Is this question about the UK? ----------
// The ONS only publishes UK figures, so it is only asked about UK questions.
const UK = /\b(uk|u\.k\.|united kingdom|britain|british|great britain|england|english|scotland|scottish|wales|welsh|northern ireland|nhs)\b/i;
export const mentionsUK = (q) => UK.test(String(q || ""));

// ---------- The ONS search ----------
const LIGHT_STOP = new Set((
  "a an the and or of in on at to for with by from is are was were be been being do does did what which who how why when where " +
  "many much number numbers there their it its this that these those as about across among between per " +
  "uk u.k. united kingdom britain british great england english scotland scottish wales welsh northern ireland " +
  "adults adult people person persons common currently now today latest recent"
).split(/\s+/));

export function searchWords(question) {
  const words = String(question || "").toLowerCase().split(/[^a-z0-9%]+/).filter(w => w.length > 1 && !LIGHT_STOP.has(w));
  return [...new Set(words)].slice(0, 8);
}

export function onsSearchUrl(question) {
  const q = searchWords(question).join(" ");
  if (!q) return null;
  return `${ONS_BASE}/search?content_type=timeseries&q=${encodeURIComponent(q)}&limit=${MAX_CANDIDATES}`;
}

// -> [{ cdid, datasetId, title, uri, releaseDate }]
export function parseOnsSearch(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  const out = [];
  for (const it of items) {
    if (!it || it.type !== "timeseries") continue;
    if (typeof it.title !== "string" || typeof it.cdid !== "string") continue;
    if (typeof it.uri !== "string" || !/^\/[A-Za-z0-9/_-]+$/.test(it.uri)) continue;
    out.push({
      cdid: it.cdid.trim(),
      datasetId: typeof it.dataset_id === "string" ? it.dataset_id.trim() : "",
      title: it.title.trim(),
      uri: it.uri,
      releaseDate: typeof it.release_date === "string" ? it.release_date : ""
    });
  }
  return out;
}

// ---------- Asking the model to choose ----------
export function buildOnsPrompt(question, candidates) {
  const lines = candidates.map((c, i) => `${i + 1}. ${c.title} [${c.cdid}${c.datasetId ? ", " + c.datasetId : ""}]`).join("\n");
  return `A student is researching this question:
"${String(question).slice(0, 500)}"

Below are time series published by the UK's Office for National Statistics. Choose the ONE series whose latest figure the student would most likely quote when writing about this question, for example how common something is, how many, or a rate. Answer null if none of them genuinely measures it, or if the question is really about whether something works (an effect or mechanism) rather than how big or common something is.

Be strict. A close but different measure is worse than none. Prefer the headline series for the whole UK and all people (not a single region, sex or age group) unless the question asks for that group. Do not pick a series for a different group, place or measure than the question names.

If the series' definition differs in any way from what the question asks about (for example it covers more or less than the question does), say so in "caveat" in one plain sentence with no numbers. Otherwise leave "caveat" empty.

Series:
${lines}

Respond with ONLY JSON in this exact shape, nothing else:
{"choice": "the number of the series, or null", "confidence": 0-100, "caveat": ""}`;
}

export function parseOnsChoice(text, candidates) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || "").replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const n = Number(parsed.choice);
  if (!Number.isInteger(n) || n < 1 || n > candidates.length) return null; // "null", or a number that isn't on the list
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) return null;
  let caveat = typeof parsed.caveat === "string" ? parsed.caveat.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 220) : "";
  if (/\d+(\.\d+)?\s?%|\d{3,}|\d+\.\d+/.test(caveat)) caveat = "";
  return { series: candidates[n - 1], confidence, caveat };
}

// ---------- Reading a time series ----------
const decimalsOf = (s) => (String(s).split(".")[1] || "").length;

// The response has `months`, `quarters` and `years`, each oldest first, with
// values as strings. The most frequent one that has any data is used.
export function parseOnsData(body) {
  if (!body || typeof body !== "object") return null;
  const d = body.description || {};
  for (const [kind, key, points] of [["month", "months", 24], ["quarter", "quarters", 16], ["year", "years", 15]]) {
    const raw = Array.isArray(body[key]) ? body[key] : [];
    const rows = raw
      .filter(r => r && r.value !== "" && r.value != null && Number.isFinite(Number(r.value)))
      .map(r => ({ label: String(r.label || r.date || ""), value: Number(r.value), text: String(r.value), year: Number(r.year), updateDate: r.updateDate }));
    if (!rows.length) continue;
    const latest = rows[rows.length - 1];
    const series = rows.slice(-points).map((r, i) => ({ t: i, label: r.label, value: r.value, year: r.year }));
    return {
      kind,
      latest,
      series,
      title: typeof d.title === "string" ? d.title.trim() : "",
      unit: typeof d.unit === "string" ? d.unit.trim() : "",
      keyNote: typeof d.keyNote === "string" ? d.keyNote.replace(/\s+/g, " ").trim() : "",
      source: typeof d.source === "string" ? d.source.trim() : "",
      cdid: typeof d.cdid === "string" ? d.cdid : "",
      datasetId: typeof d.datasetId === "string" ? d.datasetId : "",
      releaseDate: typeof d.releaseDate === "string" ? d.releaseDate : "",
      nextRelease: typeof d.nextRelease === "string" ? d.nextRelease.trim() : ""
    };
  }
  return null;
}

// How the headline number reads: the ONS's own digits, with its unit.
export function formatOnsValue(latest, unit) {
  const d = decimalsOf(latest.text);
  const n = latest.value.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
  if (unit === "%") return { valueText: `${n}%`, unitText: "" };
  if (unit === "£") return { valueText: `£${n}`, unitText: "" };
  return { valueText: n, unitText: unit };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function longDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const yearOf = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).getUTCFullYear() : null;
};

export function buildOnsCard({ choice, data }) {
  const { series: found, caveat, confidence } = choice;
  const { latest, unit } = data;
  const { valueText, unitText } = formatOnsValue(latest, unit);
  const title = data.title || found.title;
  const url = `https://www.ons.gov.uk${found.uri}`;
  const release = data.releaseDate || found.releaseDate;
  const updated = [
    release ? `Latest release: ${longDate(release)}.` : "",
    data.nextRelease ? `Next release: ${data.nextRelease}.` : ""
  ].filter(Boolean).join(" ");
  const place = /^([^:]{2,30}):/.exec(data.keyNote)?.[1]?.trim() || "";
  return {
    provider: "ONS",
    providerName: "Office for National Statistics",
    indicatorId: data.cdid || found.cdid,
    title,
    geography: place,
    value: latest.value,
    valueText,
    unitText,
    year: Number.isFinite(latest.year) ? latest.year : null,
    period: latest.label,
    series: data.series,
    definition: data.keyNote,
    originalSource: data.source || (data.datasetId ? `Office for National Statistics, ${data.datasetId} dataset` : "Office for National Statistics"),
    updateNote: updated,
    caveat,
    url,
    citation: {
      author: "Office for National Statistics",
      title: `${title} (${data.cdid || found.cdid}) [time series]`,
      container: "ONS time series",
      year: yearOf(release),
      url
    },
    attribution: "Contains public sector information licensed under the Open Government Licence v3.0.",
    licence: "OGL v3.0",
    matchConfidence: confidence
  };
}
