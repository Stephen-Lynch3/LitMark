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
    if (/api\.beta\.ons\.gov\.uk\/v1\/search/.test(url)) return json({ items: [] }); // the ONS has nothing, so UK questions fall through to the World Bank
    if (/\/sources\/2\/indicators\?/.test(url)) return json(catalogue, state.catalogueStatus);
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
  assert.equal(bank.calls.filter(u => /worldbank/.test(u)).length, 1);
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
  assert.equal(bank.calls.filter(u => /\/sources\/2\/indicators\?/.test(u)).length, 1);
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

const WB_ERROR = [{ message: [{ id: "120", key: "Invalid value", value: "The provided parameter value is not valid" }] }];

test("27. the World Bank's error body (HTTP 200) for a wrong address is treated as unavailable, not as an empty answer to cache", async () => {
  const fetchFn = async (url) => (/\/sources\/2\/indicators\?/.test(url) ? json(WB_ERROR) : json({}, 404));
  const od = createOfficialData({ fetchFn, askModel: async () => sayIndicator(), log: quiet });
  assert.equal(await od.find(DIABETES_Q), null);
});

test("28. if every address fails the indicator list is unavailable and there is no card", async () => {
  const fetchFn = async () => json(WB_ERROR);
  const od = createOfficialData({ fetchFn, askModel: async () => sayIndicator(), log: quiet });
  assert.equal(await od.find(DIABETES_Q), null);
});

test("29. indicators from other World Bank databases are ignored", () => {
  const body = catalogueBody();
  body[1] = [...body[1], { id: "XX.OTHER.DB", name: "Diabetes prevalence in another database", source: { id: "57", value: "WDI Database Archives" }, sourceNote: "n", sourceOrganization: "n" }];
  const { entries } = parseCatalogue(body);
  assert.ok(!entries.some(e => e.id === "XX.OTHER.DB"));
  assert.equal(entries.length, INDICATORS.length);
});

// ---------- the ONS half ----------
// Fixtures are trimmed copies of real responses from api.beta.ons.gov.uk
// (the search, and the data endpoint for the UK unemployment rate, MGSX).

import {
  buildOnsPrompt, formatOnsValue, mentionsUK, onsSearchUrl, parseOnsChoice, parseOnsData, parseOnsSearch, searchWords
} from "./official-data-ons.js";

const ONS_SEARCH = { count: 3430, items: [
  {
    "type": "timeseries",
    "cdid": "YCOL",
    "dataset_id": "LMS",
    "edition": "",
    "keywords": [],
    "meta_description": "",
    "release_date": "2026-10-19T23:00:00.000Z",
    "summary": "",
    "title": "LFS: ILO unemployment rate: England: Male: %: SA",
    "topics": [
      "5687",
      "4361",
      "2268"
    ],
    "uri": "/employmentandlabourmarket/peoplenotinwork/unemployment/timeseries/ycol/lms",
    "canonical_topic": ""
  },
  {
    "type": "timeseries",
    "cdid": "YCPL",
    "dataset_id": "LMS",
    "edition": "",
    "keywords": [],
    "meta_description": "",
    "release_date": "2026-10-19T23:00:00.000Z",
    "summary": "",
    "title": "LFS: ILO unemployment rate: England: Female: %: SA",
    "topics": [
      "5687",
      "4361",
      "2268"
    ],
    "uri": "/employmentandlabourmarket/peoplenotinwork/unemployment/timeseries/ycpl/lms",
    "canonical_topic": ""
  },
  {
    "type": "timeseries",
    "cdid": "MGSX",
    "dataset_id": "LMS",
    "edition": "",
    "keywords": [],
    "meta_description": "",
    "release_date": "2026-10-19T23:00:00.000Z",
    "summary": "",
    "title": "Unemployment rate (aged 16 and over, seasonally adjusted): %",
    "topics": [
      "5687",
      "4361",
      "2268"
    ],
    "uri": "/employmentandlabourmarket/peoplenotinwork/unemployment/timeseries/mgsx/lms",
    "canonical_topic": ""
  }
] };
const ONS_DATA = {
  "years": [
    {
      "date": "2023",
      "value": "4.1",
      "label": "2023",
      "year": "2023",
      "month": "",
      "quarter": "",
      "sourceDataset": "LMS",
      "updateDate": "2024-12-17T00:00:00.000Z"
    },
    {
      "date": "2024",
      "value": "4.3",
      "label": "2024",
      "year": "2024",
      "month": "",
      "quarter": "",
      "sourceDataset": "LMS",
      "updateDate": "2025-02-18T00:00:00.000Z"
    },
    {
      "date": "2025",
      "value": "4.9",
      "label": "2025",
      "year": "2025",
      "month": "",
      "quarter": "",
      "sourceDataset": "LMS",
      "updateDate": "2026-07-20T23:00:00.000Z"
    }
  ],
  "quarters": [
    {
      "date": "2025 Q4",
      "value": "5.2",
      "label": "2025 Q4",
      "year": "2025",
      "month": "",
      "quarter": "Q4",
      "sourceDataset": "LMS",
      "updateDate": "2026-02-17T00:00:00.000Z"
    },
    {
      "date": "2026 Q1",
      "value": "5.0",
      "label": "2026 Q1",
      "year": "2026",
      "month": "",
      "quarter": "Q1",
      "sourceDataset": "LMS",
      "updateDate": "2026-05-18T23:00:00.000Z"
    },
    {
      "date": "2026 Q2",
      "value": "4.9",
      "label": "2026 Q2",
      "year": "2026",
      "month": "",
      "quarter": "Q2",
      "sourceDataset": "LMS",
      "updateDate": "2026-08-17T23:00:00.000Z"
    }
  ],
  "months": [
    {
      "date": "2026 MAY",
      "value": "4.9",
      "label": "2026 APR-JUN",
      "year": "2026",
      "month": "May",
      "quarter": "",
      "sourceDataset": "LMS",
      "updateDate": "2026-08-17T23:00:00.000Z"
    },
    {
      "date": "2026 JUN",
      "value": "4.9",
      "label": "2026 MAY-JUL",
      "year": "2026",
      "month": "June",
      "quarter": "",
      "sourceDataset": "LMS",
      "updateDate": "2026-09-14T23:00:00.000Z"
    },
    {
      "date": "2026 JUL",
      "value": "4.7",
      "label": "2026 JUN-AUG",
      "year": "2026",
      "month": "July",
      "quarter": "",
      "sourceDataset": "LMS",
      "updateDate": "2026-10-19T23:00:00.000Z"
    }
  ],
  "description": {
    "title": "Unemployment rate (aged 16 and over, seasonally adjusted): %",
    "contact": {
      "email": "labour.market@ons.gov.uk",
      "name": "Labour Market team",
      "telephone": "+44 1633 455400"
    },
    "releaseDate": "2026-10-19T23:00:00.000Z",
    "nextRelease": "17 November 2026",
    "datasetId": "LMS",
    "datasetUri": "/employmentandlabourmarket/peopleinwork/employmentandemployeetypes/datasets/labourmarketstatistics",
    "cdid": "MGSX",
    "unit": "%",
    "preUnit": "",
    "source": "",
    "monthLabelStyle": "three month average",
    "date": "2026 JUL",
    "number": "4.7",
    "keyNote": "UK: Aged 16 and over\n",
    "sampleSize": "0"
  }
};
const UK_UNEMP_Q = "What is the unemployment rate in the UK?";
const sayOns = (over = {}) => JSON.stringify({ choice: 3, confidence: 90, caveat: "", ...over });

function fakeOns({ search = ONS_SEARCH, data = ONS_DATA, searchStatus = 200, dataStatus = 200 } = {}) {
  const bank = fakeBank();
  const calls = bank.calls;
  const state = { searchStatus, dataStatus };
  const fetchFn = async (url) => {
    if (/api\.beta\.ons\.gov\.uk\/v1\/search/.test(url)) { calls.push(String(url)); return json(search, state.searchStatus); }
    if (/api\.beta\.ons\.gov\.uk\/v1\/data\?/.test(url)) { calls.push(String(url)); return json(data, state.dataStatus); }
    return bank.fetchFn(url);
  };
  return { fetchFn, calls, state, bank };
}

test("30. only questions that name a UK place go to the ONS", () => {
  for (const q of [UK_UNEMP_Q, "How common is diabetes in England?", "Inflation in Great Britain", "NHS waiting list size", "crime in Wales"]) assert.equal(mentionsUK(q), true, q);
  for (const q of ["What is the unemployment rate in Spain?", "How many people live in Nigeria?", "", null]) assert.equal(mentionsUK(q), false, String(q));
});

test("31. the ONS search keeps the subject words and drops filler and place names", () => {
  assert.deepEqual(searchWords(UK_UNEMP_Q), ["unemployment", "rate"]);
  assert.match(onsSearchUrl(UK_UNEMP_Q), /^https:\/\/api\.beta\.ons\.gov\.uk\/v1\/search\?content_type=timeseries&q=unemployment%20rate&limit=\d+$/);
  assert.equal(onsSearchUrl("What is the UK?"), null);
});

test("32. search results are read, and anything with an odd address or no title is skipped", () => {
  const list = parseOnsSearch(ONS_SEARCH);
  assert.equal(list.length, 3);
  assert.equal(list[2].cdid, "MGSX");
  assert.equal(list[2].uri, "/employmentandlabourmarket/peoplenotinwork/unemployment/timeseries/mgsx/lms");
  const bad = parseOnsSearch({ items: [
    { type: "timeseries", cdid: "A", title: "x", uri: "https://evil.example/x" },
    { type: "timeseries", cdid: "B", title: "x", uri: "/a/../b?x=1" },
    { type: "bulletin", cdid: "C", title: "x", uri: "/a/b" },
    { type: "timeseries", cdid: "D", uri: "/a/b" }
  ] });
  assert.deepEqual(bad, []);
  assert.deepEqual(parseOnsSearch(null), []);
});

test("33. the ONS choice is a number on the list: 'none', out of range, or low confidence are rejected", () => {
  const list = parseOnsSearch(ONS_SEARCH);
  assert.equal(parseOnsChoice(sayOns(), list).series.cdid, "MGSX");
  assert.equal(parseOnsChoice(sayOns({ choice: null }), list), null);
  assert.equal(parseOnsChoice(sayOns({ choice: 0 }), list), null);
  assert.equal(parseOnsChoice(sayOns({ choice: 4 }), list), null);
  assert.equal(parseOnsChoice(sayOns({ choice: "MGSX" }), list), null);
  assert.equal(parseOnsChoice(sayOns({ confidence: 50 }), list), null);
  assert.equal(parseOnsChoice(sayOns({ caveat: "About 4.7% of people." }), list).caveat, "");
  assert.match(buildOnsPrompt(UK_UNEMP_Q, list), /3\. Unemployment rate \(aged 16 and over, seasonally adjusted\): % \[MGSX, LMS\]/);
});

test("34. a time series is read from its most frequent period, with the ONS's own label and unit", () => {
  const d = parseOnsData(ONS_DATA);
  assert.equal(d.kind, "month");
  assert.equal(d.latest.value, 4.7);
  assert.equal(d.latest.label, "2026 JUN-AUG");
  assert.equal(d.unit, "%");
  assert.equal(d.cdid, "MGSX");
  assert.equal(d.nextRelease, "17 November 2026");
  assert.equal(d.series.length, 3);
  assert.deepEqual(d.series.map(p => p.t), [0, 1, 2]);
});

test("35. with no monthly data it falls back to quarters, then years, and empty values are skipped", () => {
  const quarters = parseOnsData({ ...ONS_DATA, months: [] });
  assert.equal(quarters.kind, "quarter");
  assert.equal(quarters.latest.label, "2026 Q2");
  const years = parseOnsData({ ...ONS_DATA, months: [], quarters: [{ date: "2026 Q1", value: "" , label: "2026 Q1", year: "2026"}] });
  assert.equal(years.kind, "year");
  assert.equal(years.latest.label, "2025");
  assert.equal(parseOnsData({ ...ONS_DATA, months: [], quarters: [], years: [] }), null);
  assert.equal(parseOnsData(null), null);
  assert.equal(parseOnsData("<html>"), null);
});

test("36. ONS values keep the ONS's digits and unit", () => {
  assert.deepEqual(formatOnsValue({ value: 4.7, text: "4.7" }, "%"), { valueText: "4.7%", unitText: "" });
  assert.deepEqual(formatOnsValue({ value: 133.9, text: "133.9" }, "Index: 2015=100"), { valueText: "133.9", unitText: "Index: 2015=100" });
  assert.deepEqual(formatOnsValue({ value: 34000, text: "34000" }, "£"), { valueText: "£34,000", unitText: "" });
});

test("37. a UK question gets the ONS figure, never the model's, with a citation to the ONS", async () => {
  const ons = fakeOns();
  const od = createOfficialData({ fetchFn: ons.fetchFn, askModel: async () => sayOns({ value: 99, answer: "11%" }), log: quiet });
  const card = await od.find(UK_UNEMP_Q);
  assert.equal(card.provider, "ONS");
  assert.equal(card.indicatorId, "MGSX");
  assert.equal(card.valueText, "4.7%");
  assert.equal(card.period, "2026 JUN-AUG");
  assert.equal(card.year, 2026);
  assert.equal(card.title, "Unemployment rate (aged 16 and over, seasonally adjusted): %");
  assert.equal(card.geography, "UK");
  assert.equal(card.url, "https://www.ons.gov.uk/employmentandlabourmarket/peoplenotinwork/unemployment/timeseries/mgsx/lms");
  assert.equal(card.citation.author, "Office for National Statistics");
  assert.equal(card.citation.year, 2026);
  assert.match(card.citation.title, /\(MGSX\) \[time series\]$/);
  assert.match(card.updateNote, /Latest release: 19 October 2026\. Next release: 17 November 2026\./);
  assert.match(card.attribution, /Open Government Licence v3\.0/);
  assert.doesNotMatch(JSON.stringify(card), /99|11%/);
  // the data request uses the address exactly as the ONS gave it
  assert.ok(ons.calls.some(u => u === "https://api.beta.ons.gov.uk/v1/data?uri=/employmentandlabourmarket/peoplenotinwork/unemployment/timeseries/mgsx/lms"), ons.calls.join("\n"));
  assert.ok(!ons.calls.some(u => /worldbank/.test(u)), "no World Bank request was needed");
});

test("38. if the ONS has nothing that fits, a UK question falls back to the World Bank", async () => {
  const ons = fakeOns();
  let n = 0;
  const od = createOfficialData({
    fetchFn: ons.fetchFn,
    askModel: async () => (n++ === 0 ? sayOns({ choice: null }) : sayIndicator()),
    log: quiet
  });
  const card = await od.find(DIABETES_Q);
  assert.equal(card.provider, "World Bank");
  assert.equal(card.valueText, "6.0%");
});

test("39. if the ONS is down, a UK question still gets the World Bank figure", async () => {
  const ons = fakeOns({ searchStatus: 503 });
  const od = createOfficialData({ fetchFn: ons.fetchFn, askModel: async () => sayIndicator(), log: quiet });
  assert.equal((await od.find(DIABETES_Q)).provider, "World Bank");
});

test("40. a question about another country never touches the ONS", async () => {
  const ons = fakeOns();
  const od = createOfficialData({ fetchFn: ons.fetchFn, askModel: async () => sayIndicator({ country: "ESP" }), log: quiet });
  await od.find("What is the unemployment rate in Spain?");
  assert.ok(!ons.calls.some(u => /ons\.gov\.uk/.test(u)));
});

test("41. an ONS failure with nothing from the World Bank is not remembered, so the next search tries again", async () => {
  const ons = fakeOns({ searchStatus: 500, data: ONS_DATA });
  const bankDown = fakeBank({ catalogueStatus: 503 });
  let phase = 0;
  const fetchFn = async (url) => {
    if (/ons\.gov\.uk/.test(url)) return ons.fetchFn(url);
    return phase === 0 ? bankDown.fetchFn(url) : fakeBank().fetchFn(url);
  };
  const c = clock();
  const od = createOfficialData({ fetchFn, askModel: async (p) => (/Office for National Statistics/.test(p) ? sayOns() : sayIndicator()), now: c.now, log: quiet });
  assert.equal(await od.find(UK_UNEMP_Q), null);
  phase = 1; ons.state.searchStatus = 200; c.advance(6 * 60 * 1000);
  assert.equal((await od.find(UK_UNEMP_Q)).provider, "ONS");
});
