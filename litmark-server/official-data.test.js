import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildChoicePrompt,
  createOfficialData,
  formatValue,
  parseCatalogue,
  parseChoice,
  parseSeries,
  shortlistIndicators,
  wantsFigure
} from "./official-data.js";

// ---------- fixtures, in the shapes the World Bank's v2 API documents ----------

const INDICATORS = [
  {
    id: "SH.STA.DIAB.ZS",
    name: "Diabetes prevalence (% of population ages 20 to 79)",
    source: { id: "2", value: "World Development Indicators" },
    sourceNote: "Diabetes prevalence refers to the percentage of people ages 20 to 79 who have type 1 or type 2 diabetes.",
    sourceOrganization: "International Diabetes Federation, Diabetes Atlas."
  },
  {
    id: "SL.UEM.TOTL.ZS",
    name: "Unemployment, total (% of total labor force) (modeled ILO estimate)",
    source: { id: "2", value: "World Development Indicators" },
    sourceNote: "Unemployment refers to the share of the labor force that is without work but available for and seeking employment.",
    sourceOrganization: "International Labour Organization, ILOSTAT database."
  },
  {
    id: "SP.POP.TOTL",
    name: "Population, total",
    source: { id: "2", value: "World Development Indicators" },
    sourceNote: "Total population is based on the de facto definition of population.",
    sourceOrganization: "United Nations Population Division. World Population Prospects."
  },
  {
    id: "NY.GDP.PCAP.CD",
    name: "GDP per capita (current US$)",
    source: { id: "2", value: "World Development Indicators" },
    sourceNote: "GDP per capita is gross domestic product divided by midyear population.",
    sourceOrganization: "World Bank national accounts data, and OECD National Accounts data files."
  },
  {
    id: "SE.TER.ENRR",
    name: "School enrollment, tertiary (% gross)",
    source: { id: "2", value: "World Development Indicators" },
    sourceNote: "Gross enrollment ratio is the ratio of total enrollment, regardless of age, to the population of the age group.",
    sourceOrganization: "UNESCO Institute for Statistics."
  }
];

const catalogueBody = () => [
  { page: 1, pages: 1, per_page: "2000", total: INDICATORS.length, sourceid: "2", lastupdated: "2025-07-01" },
  INDICATORS
];

// Newest year first, and with gaps, as the real service returns them.
const seriesBody = () => [
  { page: 1, pages: 1, per_page: 70, total: 5, sourceid: "2", lastupdated: "2025-07-01" },
  [
    { indicator: { id: "SH.STA.DIAB.ZS", value: "Diabetes prevalence (% of population ages 20 to 79)" }, country: { id: "GB", value: "United Kingdom" }, countryiso3code: "GBR", date: "2023", value: null, unit: "", obs_status: "", decimal: 1 },
    { indicator: { id: "SH.STA.DIAB.ZS", value: "Diabetes prevalence (% of population ages 20 to 79)" }, country: { id: "GB", value: "United Kingdom" }, countryiso3code: "GBR", date: "2021", value: 5.97, unit: "", obs_status: "", decimal: 1 },
    { indicator: { id: "SH.STA.DIAB.ZS", value: "Diabetes prevalence (% of population ages 20 to 79)" }, country: { id: "GB", value: "United Kingdom" }, countryiso3code: "GBR", date: "2019", value: 5.4, unit: "", obs_status: "", decimal: 1 },
    { indicator: { id: "SH.STA.DIAB.ZS", value: "Diabetes prevalence (% of population ages 20 to 79)" }, country: { id: "GB", value: "United Kingdom" }, countryiso3code: "GBR", date: "2017", value: 4.9, unit: "", obs_status: "", decimal: 1 },
    { indicator: { id: "SH.STA.DIAB.ZS", value: "Diabetes prevalence (% of population ages 20 to 79)" }, country: { id: "GB", value: "United Kingdom" }, countryiso3code: "GBR", date: "2015", value: 4.6, unit: "", obs_status: "", decimal: 1 }
  ]
];

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// A fake World Bank. `calls` records every URL asked for.
function fakeBank({ catalogue = catalogueBody(), series = seriesBody(), catalogueStatus = 200, seriesStatus = 200 } = {}) {
  const calls = [];
  const state = { catalogueStatus, seriesStatus };
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (/\/indicator\?/.test(url)) return json(catalogue, state.catalogueStatus);
    if (/\/country\/[A-Za-z]{3}\/indicator\//.test(url)) return json(series, state.seriesStatus);
    return json({}, 404);
  };
  return { fetchFn, calls, state };
}

const quiet = { warn() {}, error() {}, log() {} };
const clock = (t = 1_000_000) => {
  const c = { t, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
};
const DIABETES_Q = "How common is type 2 diabetes in UK adults?";
const sayIndicator = (over = {}) =>
  JSON.stringify({ indicator: "SH.STA.DIAB.ZS", country: "GBR", confidence: 90, caveat: "", ...over });

// ---------- the number-intent gate ----------

test("1. questions that ask how common or how big something is want a figure", () => {
  for (const q of [
    DIABETES_Q,
    "What is the unemployment rate among young people in Spain?",
    "How many people live in poverty globally?",
    "Trends in tertiary enrolment across Europe",
    "Prevalence of obesity in children"
  ]) assert.equal(wantsFigure(q), true, q);
});

test("2. questions about whether something works, or too short to mean anything, do not", () => {
  for (const q of [
    "Does intermittent fasting improve insulin sensitivity?",
    "Is social media harmful to teenage mental health?",
    "Critically evaluate Piaget's theory",
    "diabetes?",
    "",
    null
  ]) assert.equal(wantsFigure(q), false, String(q));
});

// ---------- shortlisting ----------

test("3. the shortlist puts the matching indicator first and leaves out unrelated ones", () => {
  const { entries } = parseCatalogue(catalogueBody());
  const list = shortlistIndicators(DIABETES_Q, entries);
  assert.equal(list[0].id, "SH.STA.DIAB.ZS");
  assert.ok(!list.some(i => i.id === "SP.POP.TOTL"));
});

test("4. a question with nothing to match gives an empty shortlist, so no model call is needed", () => {
  const { entries } = parseCatalogue(catalogueBody());
  assert.deepEqual(shortlistIndicators("How common is dragon fruit farming?", entries), []);
  assert.deepEqual(shortlistIndicators("", entries), []);
  assert.deepEqual(shortlistIndicators(DIABETES_Q, null), []);
});

// ---------- reading the model's choice ----------

const SHORT = () => parseCatalogue(catalogueBody()).entries;

test("5. a valid choice is accepted, including when wrapped in a code fence", () => {
  const c = parseChoice("```json\n" + sayIndicator({ caveat: "This covers type 1 and type 2 together." }) + "\n```", SHORT());
  assert.equal(c.indicator.id, "SH.STA.DIAB.ZS");
  assert.equal(c.country, "GBR");
  assert.equal(c.caveat, "This covers type 1 and type 2 together.");
});

test("6. 'none', an invented indicator, a bad country and low confidence are all rejected", () => {
  assert.equal(parseChoice(JSON.stringify({ indicator: null, country: "GBR", confidence: 95 }), SHORT()), null);
  assert.equal(parseChoice(JSON.stringify({ indicator: "null", country: "GBR", confidence: 95 }), SHORT()), null);
  assert.equal(parseChoice(sayIndicator({ indicator: "XX.MADE.UP" }), SHORT()), null);
  assert.equal(parseChoice(sayIndicator({ country: "UK" }), SHORT()), null);
  assert.equal(parseChoice(sayIndicator({ country: "gbr1" }), SHORT()), null);
  assert.equal(parseChoice(sayIndicator({ confidence: 40 }), SHORT()), null);
  assert.equal(parseChoice("I think diabetes prevalence", SHORT()), null);
  assert.equal(parseChoice("", SHORT()), null);
});

test("7. a caveat that contains a statistic is dropped: the model never supplies figures", () => {
  assert.equal(parseChoice(sayIndicator({ caveat: "Roughly 9% of adults are affected." }), SHORT()).caveat, "");
  assert.equal(parseChoice(sayIndicator({ caveat: "About 4.7 million people." }), SHORT()).caveat, "");
  assert.equal(parseChoice(sayIndicator({ caveat: "Covers 1,000,000 people." }), SHORT()).caveat, "");
});

test("8. the prompt offers only the shortlisted indicators and asks for strictness", () => {
  const prompt = buildChoicePrompt(DIABETES_Q, SHORT().slice(0, 2));
  assert.match(prompt, /SH\.STA\.DIAB\.ZS/);
  assert.match(prompt, /SL\.UEM\.TOTL\.ZS/);
  assert.doesNotMatch(prompt, /SP\.POP\.TOTL/);
  assert.match(prompt, /Be strict/);
  assert.match(prompt, /ONLY JSON/);
});

// ---------- reading the data service's responses ----------

test("9. a series skips missing years, finds the newest value and returns the trend oldest-first", () => {
  const s = parseSeries(seriesBody());
  assert.equal(s.latest.year, 2021);
  assert.equal(s.latest.value, 5.97);
  assert.deepEqual(s.series.map(p => p.year), [2015, 2017, 2019, 2021]);
  assert.equal(s.lastUpdatedYear, 2025);
});

test("10. an error body, an empty series or an all-missing series gives nothing", () => {
  assert.equal(parseSeries([{ message: [{ id: "120", key: "Invalid value", value: "The provided parameter value is not valid" }] }]), null);
  assert.equal(parseSeries([{ page: 1 }, []]), null);
  assert.equal(parseSeries([{ page: 1 }, [{ date: "2022", value: null, country: { id: "GB", value: "United Kingdom" } }]]), null);
  assert.equal(parseSeries(null), null);
  assert.equal(parseSeries("<html>"), null);
});

test("11. values are written the way their indicator's unit reads", () => {
  assert.equal(formatValue(5.97, "Diabetes prevalence (% of population ages 20 to 79)", 1), "6.0%");
  assert.equal(formatValue(46125.3, "GDP per capita (current US$)", 0), "US$46,125");
  assert.equal(formatValue(67596281, "Population, total", 0), "67,596,281");
  assert.equal(formatValue(4.2, "Unemployment, total (% of total labor force)"), "4.2%");
});

// ---------- the whole lookup ----------

test("12. the figure, year, definition and source come from the data service, never from the model", async () => {
  const bank = fakeBank();
  // The model tries to slip in its own number: it must not appear anywhere.
  const asked = [];
  const od = createOfficialData({
    fetchFn: bank.fetchFn,
    askModel: async (p) => { asked.push(p); return sayIndicator({ value: 99.9, answer: "11%" }); },
    log: quiet
  });
  const card = await od.find(DIABETES_Q);
  assert.equal(card.indicatorId, "SH.STA.DIAB.ZS");
  assert.equal(card.value, 5.97);
  assert.equal(card.valueText, "6.0%");
  assert.equal(card.year, 2021);
  assert.equal(card.geography, "United Kingdom");
  assert.deepEqual(card.series.map(p => p.year), [2015, 2017, 2019, 2021]);
  assert.match(card.definition, /type 1 or type 2 diabetes/);
  assert.match(card.originalSource, /International Diabetes Federation/);
  assert.equal(card.url, "https://data.worldbank.org/indicator/SH.STA.DIAB.ZS?locations=GB");
  assert.equal(card.citation.author, "World Bank");
  assert.equal(card.citation.year, 2025);
  assert.match(card.citation.title, /United Kingdom \[dataset\]$/);
  assert.match(card.attribution, /^The World Bank: World Development Indicators: International Diabetes Federation/);
  assert.equal(card.licence, "CC BY 4.0");
  assert.doesNotMatch(JSON.stringify(card), /99\.9|11%/);
  assert.equal(asked.length, 1);
});

test("13. it asks the data service for the country the model chose", async () => {
  const bank = fakeBank();
  const od = createOfficialData({ fetchFn: bank.fetchFn, askModel: async () => sayIndicator({ country: "wld" }), log: quiet });
  await od.find("How common is diabetes worldwide?");
  assert.ok(bank.calls.some(u => /\/country\/WLD\/indicator\/SH\.STA\.DIAB\.ZS\?/.test(u)), bank.calls.join("\n"));
});

test("14. when the model says no indicator fits, there is no card and no figure is fetched", async () => {
  const bank = fakeBank();
  const od = createOfficialData({
    fetchFn: bank.fetchFn,
    askModel: async () => JSON.stringify({ indicator: null, country: "GBR", confidence: 0, caveat: "" }),
    log: quiet
  });
  assert.equal(await od.find(DIABETES_Q), null);
  assert.equal(bank.calls.filter(u => /\/country\//.test(u)).length, 0);
});

test("15. a low-confidence match is treated as no match", async () => {
  const bank = fakeBank();
  const od = createOfficialData({ fetchFn: bank.fetchFn, askModel: async () => sayIndicator({ confidence: 55 }), log: quiet });
  assert.equal(await od.find(DIABETES_Q), null);
});

test("16. a question that doesn't want a figure costs nothing: no fetch, no model call", async () => {
  const bank = fakeBank();
  let asked = 0;
  const od = createOfficialData({ fetchFn: bank.fetchFn, askModel: async () => { asked++; return "{}"; }, log: quiet });
  assert.equal(await od.find("Does intermittent fasting improve insulin sensitivity?"), null);
  assert.equal(bank.calls.length, 0);
  assert.equal(asked, 0);
});

test("17. switched off, it does nothing at all", async () => {
  const bank = fakeBank();
  const od = createOfficialData({ enabled: false, fetchFn: bank.fetchFn, askModel: async () => sayIndicator(), log: quiet });
  assert.equal(await od.find(DIABETES_Q), null);
  await od.warm();
  assert.equal(bank.calls.length, 0);
});

test("18. the data service being down gives no card and no error, and is retried later, not remembered", async () => {
  const bank = fakeBank({ catalogueStatus: 503 });
  const c = clock();
  const od = createOfficialData({ fetchFn: bank.fetchFn, askModel: async () => sayIndicator(), now: c.now, log: quiet });
  assert.equal(await od.find(DIABETES_Q), null);
  // Inside the short back-off it does not hammer the service.
  assert.equal(await od.find(DIABETES_Q), null);
  assert.equal(bank.calls.length, 1);
  // The service recovers; once the back-off has passed, the same question works.
  bank.state.catalogueStatus = 200;
  c.advance(6 * 60 * 1000);
  const card = await od.find(DIABETES_Q);
  assert.equal(card.indicatorId, "SH.STA.DIAB.ZS");
});

test("19. an error from the figure request gives no card, and the next search tries again", async () => {
  const bank = fakeBank({ seriesStatus: 500 });
  const od = createOfficialData({ fetchFn: bank.fetchFn, askModel: async () => sayIndicator(), log: quiet });
  assert.equal(await od.find(DIABETES_Q), null);
  bank.state.seriesStatus = 200;
  assert.equal((await od.find(DIABETES_Q)).value, 5.97);
});

test("20. a failing model call gives no card and is not remembered", async () => {
  const bank = fakeBank();
  let n = 0;
  const od = createOfficialData({
    fetchFn: bank.fetchFn,
    askModel: async () => { if (n++ === 0) throw new Error("overloaded"); return sayIndicator(); },
    log: quiet
  });
  assert.equal(await od.find(DIABETES_Q), null);
  assert.equal((await od.find(DIABETES_Q)).indicatorId, "SH.STA.DIAB.ZS");
});

test("21. a model reply that isn't JSON at all is not remembered either", async () => {
  const bank = fakeBank();
  let n = 0;
  const od = createOfficialData({
    fetchFn: bank.fetchFn,
    askModel: async () => (n++ === 0 ? "Sorry, I can't help with that." : sayIndicator()),
    log: quiet
  });
  assert.equal(await od.find(DIABETES_Q), null);
  assert.equal((await od.find(DIABETES_Q)).indicatorId, "SH.STA.DIAB.ZS");
});

test("22. the same question again is answered from memory, once the answer has expired it is looked up again", async () => {
  const bank = fakeBank();
  const c = clock();
  let asked = 0;
  const od = createOfficialData({ fetchFn: bank.fetchFn, askModel: async () => { asked++; return sayIndicator(); }, now: c.now, log: quiet });
  await od.find(DIABETES_Q);
  await od.find("  how common is TYPE 2 diabetes in uk adults ?? ");
  assert.equal(asked, 1);
  c.advance(25 * 60 * 60 * 1000);
  await od.find(DIABETES_Q);
  assert.equal(asked, 2);
});

test("23. searches that arrive together share one request for the indicator list", async () => {
  const bank = fakeBank();
  const od = createOfficialData({ fetchFn: bank.fetchFn, askModel: async () => sayIndicator(), log: quiet });
  await Promise.all([
    od.find(DIABETES_Q),
    od.find("What is the prevalence of diabetes in the UK?"),
    od.find("How many adults have diabetes in Britain?"),
    od.warm()
  ]);
  assert.equal(bank.calls.filter(u => /\/indicator\?/.test(u)).length, 1);
});

test("24. an empty or malformed indicator list is treated as unavailable", async () => {
  for (const catalogue of [[{ page: 1 }, []], { oops: true }, null]) {
    const bank = fakeBank({ catalogue });
    const od = createOfficialData({ fetchFn: bank.fetchFn, askModel: async () => sayIndicator(), log: quiet });
    assert.equal(await od.find(DIABETES_Q), null);
  }
});

test("25. a fetch that throws (timeout, DNS) is swallowed", async () => {
  const od = createOfficialData({
    fetchFn: async () => { throw new Error("The operation was aborted due to timeout"); },
    askModel: async () => sayIndicator(),
    log: quiet
  });
  assert.equal(await od.find(DIABETES_Q), null);
});

test("26. a country the service doesn't know (an error body) gives no card", async () => {
  const bank = fakeBank({ series: [{ message: [{ id: "120", key: "Invalid value", value: "The provided parameter value is not valid" }] }] });
  const od = createOfficialData({ fetchFn: bank.fetchFn, askModel: async () => sayIndicator({ country: "ZZZ" }), log: quiet });
  assert.equal(await od.find(DIABETES_Q), null);
});
