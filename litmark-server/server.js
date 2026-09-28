// LitMark backend
// Search: queries open-access literature (OpenAlex + Semantic Scholar +
// Europe PMC, which covers PMC/PubMed plus preprints), filters to
// genuinely open-access papers, requires the actual search terms to
// appear in the abstract (not just loose topical relevance from the
// search engines' own ranking), then asks Claude to point at the single
// most relevant sentence in each abstract and highlight it — no relevance
// score, no AI verdict on quality; the reader judges that. Highlighting
// runs in parallel chunks rather than one big sequential call, since
// that's the dominant cost in how long a search takes.
// Critical Analysis runs two deliberately-framed searches (one aimed at
// supporting evidence, one at challenging evidence) and sorts each paper
// into a column by which search found it, not by an after-the-fact
// AI judgment call.
// Billing: Stripe handles all payment/card data — this server never sees
// a card number. Auth is passwordless: a signed link is emailed, clicking
// it proves the person controls that email address. On every search, we
// check Stripe live for an active subscription tied to that email — no
// separate database of subscribers to keep in sync.
//
// Run:  npm install && cp .env.example .env  (fill in the keys)  && npm start
// Requires Node 18+ (native fetch).

import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import { Resend } from "resend";
import multer from "multer";
import mammoth from "mammoth";
import { randomUUID } from "crypto";
import "dotenv/config";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB max

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Every feature in this app depends on a Claude call succeeding — unlike
// the search-source APIs, which each contribute one of several, a Claude
// failure previously killed the entire request outright, with no recovery
// attempt at all. Retries only on a transient failure (rate limit, server
// error, or a network-level failure with no status at all); a genuine
// client error (bad request, auth) is rethrown immediately rather than
// retried, since retrying an invalid request would just fail again.
async function createMessageWithRetry(params, retries = 2, delayMs = 800) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      const status = err?.status;
      const isTransient = status === 429 || (typeof status === "number" && status >= 500) || !status;
      if (!isTransient || attempt === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
}
// A placeholder key lets the server boot even before Stripe/Resend are
// configured — actual billing calls will fail loudly with a clear error
// (not a server crash) until real keys are set.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_not_configured_yet");
const resend = new Resend(process.env.RESEND_API_KEY || "re_not_configured_yet");

const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "you@example.com";
if (CONTACT_EMAIL === "you@example.com") {
  console.warn("[startup] WARNING: CONTACT_EMAIL is still the placeholder \"you@example.com\" — OpenAlex's polite pool (higher rate limits) requires a real, valid email. Set a genuine CONTACT_EMAIL on Render to fix this.");
}

// Haiku for the bulk/structured work here — extracting a quote and a short
// line of context from an abstract doesn't need Sonnet-level reasoning,
// and Haiku is meaningfully faster, which matters directly for how long
// a search takes.
const MODEL = "claude-haiku-4-5-20251001";
const JWT_SECRET = process.env.JWT_SECRET || "";
const APP_URL = (process.env.APP_URL || "http://localhost:3787").replace(/\/$/, "");
const PRICE_ID = process.env.STRIPE_PRICE_ID || ""; // monthly — kept as the original name for backward compatibility
const PRICE_ID_ANNUAL = process.env.STRIPE_PRICE_ID_ANNUAL || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "LitMark <onboarding@resend.dev>";

// ---------- Turn a natural-language question into a search-engine query ----------
async function buildSearchQuery(question) {
  const msg = await createMessageWithRetry({
    model: MODEL,
    max_tokens: 60,
    temperature: 0, // a judgment/extraction task, not creative writing — the same
                    // question should reliably produce the same query, not a
                    // different one each time just from default randomness
    messages: [{
      role: "user",
      content: `Turn this research question into a concise academic database search query: 4-8 of the most important keywords and phrases, optimized for literal keyword matching (not a natural sentence). Return ONLY the query string, nothing else, no quotes.\n\nQuestion: "${question}"`
    }]
  });
  const raw = msg.content.find(b => b.type === "text")?.text || question;
  return raw.trim().replace(/^["']|["']$/g, "") || question;
}

// A second query deliberately aimed at literature that would challenge or
// complicate a hypothesis about this question — null results, contradicting
// findings, failed replications, limitations. Used only for Critical
// Analysis mode, so counter-evidence is actively sought, not just hoped for.
async function buildCounterQuery(question) {
  const msg = await createMessageWithRetry({
    model: MODEL,
    max_tokens: 60,
    temperature: 0,
    messages: [{
      role: "user",
      content: `A student is researching this question: "${question}"

Write a concise academic database search query (4-8 keywords/phrases, literal keyword matching, not a sentence) specifically aimed at finding papers that would CHALLENGE, CONTRADICT, or COMPLICATE the expected hypothesis — e.g. null results, failed replications, meta-analyses finding no effect, documented limitations or criticisms. Return ONLY the query string, nothing else, no quotes.`
    }]
  });
  const raw = msg.content.find(b => b.type === "text")?.text || question;
  return raw.trim().replace(/^["']|["']$/g, "") || question;
}

// A source that fails with 429 contributes ZERO candidates for that
// request — which is a real cause of two different problems at once: it
// silently shrinks the candidate pool (lower yield), and it means the
// exact same search can succeed or fail on a source essentially at
// random between runs (inconsistent results for identical searches).
// One short retry recovers the large majority of transient rate limits.
async function fetchWithRetry(url, options = {}, retries = 2, delayMs = 700) {
  let res;
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await fetch(url, options);
    if (res.status !== 429 || attempt === retries) return res;
    await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
  }
  return res;
}

// A DOI landing page is where a paywalled paper's publisher page lives —
// what a student follows to check whether their university has access.
// Sources return DOIs both bare ("10.1234/x") and as full URLs.
function toDoiUrl(doi) {
  if (!doi) return null;
  return /^https?:\/\//i.test(doi) ? doi : `https://doi.org/${doi}`;
}

// Structured author names (family / given), so a citation can be formatted
// correctly in ANY style. The sources disagree on how they write a name —
// "Jane Smith" (OpenAlex, Semantic Scholar), "Smith AB" (Europe PMC's author
// string), "Smith, Jane" (many repositories, CORE) — and assuming "the last
// word is the surname" for all of them produces wrong citations for some.
const MAX_AUTHORS_KEPT = 8;

function splitGivenFamily(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
  if (!s) return null;
  if (s.includes(",")) {
    const i = s.indexOf(",");
    return { family: s.slice(0, i).trim(), given: s.slice(i + 1).trim() };
  }
  const parts = s.split(" ");
  if (parts.length === 1) return { family: parts[0], given: "" };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(" ") };
}

// Europe PMC's plain author string writes "Smith AB": family first, initials last.
function splitFamilyInitials(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
  if (!s) return null;
  const parts = s.split(" ");
  if (parts.length === 1) return { family: parts[0], given: "" };
  const last = parts[parts.length - 1];
  if (/^[A-Z]{1,4}$/.test(last)) return { family: parts.slice(0, -1).join(" "), given: last };
  return splitGivenFamily(s);
}

// ---------- Source 1: OpenAlex ----------
async function searchOpenAlex(query, { requireOA = true } = {}) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  const filters = ["has_abstract:true"];
  if (requireOA) filters.push("open_access.is_oa:true");
  url.searchParams.set("filter", filters.join(","));
  url.searchParams.set("per-page", "30");
  url.searchParams.set("select", [
    "id", "title", "publication_year", "authorships",
    "primary_location", "open_access", "abstract_inverted_index", "doi", "cited_by_count"
  ].join(","));
  url.searchParams.set("mailto", CONTACT_EMAIL);

  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  const data = await res.json();

  return data.results.map(w => {
    const oaLink = w.open_access?.oa_url || w.primary_location?.pdf_url
      || ((w.open_access?.is_oa || !requireOA) && w.doi ? w.doi : null); // is_oa but no direct link on file — DOI landing page as a fallback rather than dropping it. When paywalled papers are wanted (requireOA off), the DOI page is also the right link for a paper that isn't open access.
    return {
      source: "OpenAlex",
      id: w.id,
      title: w.title,
      year: w.publication_year,
      journal: w.primary_location?.source?.display_name || "Unknown venue",
      authors: (w.authorships || []).slice(0, 4).map(a => a.author?.display_name).filter(Boolean).join(", "),
      authorList: (w.authorships || []).slice(0, MAX_AUTHORS_KEPT).map(a => splitGivenFamily(a.author?.display_name)).filter(Boolean),
      authorTotal: (w.authorships || []).length,
      oaUrl: oaLink,
      isOA: !!w.open_access?.is_oa,
      doi: w.doi,
      citedByCount: typeof w.cited_by_count === "number" ? w.cited_by_count : null,
      abstract: reconstructAbstract(w.abstract_inverted_index)
    };
  }).filter(p => p.abstract && (requireOA ? p.oaUrl : true));
}

function reconstructAbstract(inverted) {
  if (!inverted) return null;
  const positions = [];
  for (const [word, idxs] of Object.entries(inverted)) {
    for (const i of idxs) positions[i] = word;
  }
  const text = positions.join(" ").trim();
  return text.length > 40 ? text : null;
}

// ---------- Source 2: Semantic Scholar ----------
async function searchSemanticScholar(query, { requireOA = true } = {}) {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "30");
  url.searchParams.set("fields", "title,abstract,year,venue,authors,openAccessPdf,externalIds,citationCount");

  const headers = process.env.SEMANTIC_SCHOLAR_API_KEY
    ? { "x-api-key": process.env.SEMANTIC_SCHOLAR_API_KEY }
    : {};

  const res = await fetchWithRetry(url, { headers });
  if (!res.ok) throw new Error(`Semantic Scholar ${res.status}`);
  const data = await res.json();

  return (data.data || [])
    .filter(p => p.abstract && (requireOA ? p.openAccessPdf?.url : true))
    .map(p => ({
      source: "Semantic Scholar",
      id: p.externalIds?.DOI || p.paperId,
      title: p.title,
      year: p.year,
      journal: p.venue || "Unknown venue",
      authors: (p.authors || []).slice(0, 4).map(a => a.name).join(", "),
      authorList: (p.authors || []).slice(0, MAX_AUTHORS_KEPT).map(a => splitGivenFamily(a.name)).filter(Boolean),
      authorTotal: (p.authors || []).length,
      oaUrl: p.openAccessPdf?.url || (!requireOA ? toDoiUrl(p.externalIds?.DOI) : null),
      isOA: !!p.openAccessPdf?.url,
      doi: p.externalIds?.DOI,
      citedByCount: typeof p.citationCount === "number" ? p.citationCount : null,
      abstract: p.abstract
    }));
}

// ---------- Source 3: Europe PMC ----------
// Covers the same PMC/PubMed open-access content as NCBI's own interface,
// plus preprints (bioRxiv, medRxiv) — broader net, and a single clean JSON
// call instead of NCBI's two-step XML dance. No API key needed at all.
async function searchEuropePMC(query, { requireOA = true } = {}) {
  const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  url.searchParams.set("query", requireOA ? `(${query}) AND (OPEN_ACCESS:Y)` : query);
  url.searchParams.set("format", "json");
  url.searchParams.set("resultType", "core");
  url.searchParams.set("pageSize", "30");

  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`Europe PMC ${res.status}`);
  const data = await res.json();
  const results = data.resultList?.result || [];

  return results.map(r => {
    // Prefer Europe PMC's structured author records; fall back to parsing
    // its plain "Smith AB, Jones CD" string.
    const epmcAuthors = r.authorList?.author;
    let authorList, authorTotal;
    if (Array.isArray(epmcAuthors) && epmcAuthors.length) {
      authorList = epmcAuthors.slice(0, MAX_AUTHORS_KEPT)
        .map(a => a.lastName ? { family: a.lastName, given: a.firstName || a.initials || "" } : splitFamilyInitials(a.fullName || a.collectiveName))
        .filter(Boolean);
      authorTotal = epmcAuthors.length;
    } else {
      const parts = (r.authorString || "").split(", ").filter(Boolean);
      authorList = parts.slice(0, MAX_AUTHORS_KEPT).map(splitFamilyInitials).filter(Boolean);
      authorTotal = parts.length;
    }
    const oaLink =
      (r.fullTextUrlList?.fullTextUrl || []).find(u => (u.availability || "").toLowerCase().includes("open access"))?.url
      || (r.pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${r.pmcid}/` : null)
      || (r.doi ? `https://doi.org/${r.doi}` : null)
      || (!requireOA && r.source && r.id ? `https://europepmc.org/article/${r.source}/${r.id}` : null);

    return {
      source: "Europe PMC",
      id: r.id,
      title: r.title,
      year: r.pubYear ? parseInt(r.pubYear) : null,
      journal: r.journalTitle || "Unknown venue",
      authors: (r.authorString || "").split(", ").slice(0, 4).join(", "),
      authorList,
      authorTotal,
      oaUrl: oaLink,
      isOA: r.isOpenAccess === "Y",
      pmcid: r.pmcid || null,
      doi: r.doi || null,
      citedByCount: typeof r.citedByCount === "number" ? r.citedByCount : null,
      abstract: r.abstractText ? stripXmlTags(r.abstractText) : null
    };
  }).filter(p => p.abstract && (requireOA ? p.oaUrl : true));
}

// ---------- Source 4: CORE ----------
// The largest open-access aggregator (260M+ records from 10,000+
// repositories), with particularly strong coverage of preprints, theses,
// and institutional-repository content that OpenAlex, Semantic Scholar,
// and Europe PMC don't fully overlap with. Anonymous access is heavily
// rate-limited, so genuinely useful results need a free key from
// core.ac.uk/services/api — without one, this source is skipped entirely
// rather than hitting the heavily-throttled anonymous tier, and the
// search simply proceeds on the other three sources, exactly as it
// already does when any one source fails for any other reason.
async function searchCORE(query, { requireOA = true } = {}) {
  if (!process.env.CORE_API_KEY) return [];
  const url = new URL("https://api.core.ac.uk/v3/search/works");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "30");
  const headers = { Authorization: `Bearer ${process.env.CORE_API_KEY}` };

  const res = await fetchWithRetry(url, { headers });
  if (!res.ok) throw new Error(`CORE ${res.status}`);
  const data = await res.json();

  return (data.results || [])
    .map(w => {
      const oaLink = w.downloadUrl || (w.doi ? `https://doi.org/${w.doi}` : null);
      // CORE returns authors as plain strings or as {name} objects depending
      // on the record, usually written "Smith, Jane" — normalise both.
      const rawNames = (Array.isArray(w.authors) ? w.authors : [])
        .map(a => typeof a === "string" ? a : a?.name)
        .filter(Boolean);
      const coreAuthorList = rawNames.slice(0, MAX_AUTHORS_KEPT).map(splitGivenFamily).filter(Boolean);
      return {
        source: "CORE",
        id: w.coreId || w.id,
        title: w.title,
        // Different CORE docs/examples show this field two different ways
        // (yearPublished vs year) — checking both rather than betting on one.
        year: w.yearPublished || w.year || null,
        journal: (Array.isArray(w.journals) && w.journals[0]) || w.publisher || "Unknown venue",
        authors: coreAuthorList.slice(0, 4).map(a => a.given ? `${a.given} ${a.family}` : a.family).join(", "),
        authorList: coreAuthorList,
        authorTotal: rawNames.length,
        oaUrl: oaLink,
        isOA: true, // CORE indexes open-access content by design
        doi: w.doi || null,
        citedByCount: typeof w.citationCount === "number" ? w.citationCount : null,
        abstract: w.abstract || null
      };
    })
    .filter(p => p.abstract && (requireOA ? p.oaUrl : true));
}


// Given ANY paper's DOI (regardless of whether OpenAlex, Semantic Scholar,
// or Europe PMC's own topic search originally found it), check whether
// Europe PMC separately has it indexed with full text available. This is
// how full-text coverage extends beyond papers Europe PMC's own search
// happened to surface — without ever touching an arbitrary publisher's
// PDF or HTML, which is where real fragility would start.
async function findPmcMatchByDoi(doi) {
  if (!doi) return null;
  const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//i, "");
  try {
    const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
    url.searchParams.set("query", `DOI:"${cleanDoi}"`);
    url.searchParams.set("format", "json");
    url.searchParams.set("pageSize", "1");
    const res = await fetchWithRetry(url);
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data.resultList?.result?.[0];
    if (!hit || !hit.pmcid) return null;
    const hasFullText = (hit.fullTextUrlList?.fullTextUrl || [])
      .some(u => (u.documentStyle || "").toLowerCase().includes("xml") || u.site === "Europe_PMC");
    return hasFullText ? hit.pmcid : null;
  } catch {
    return null;
  }
}

function stripXmlTags(s) {
  if (!s) return "";
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Fetches the JATS full-text XML for a PMC-indexed open-access article and
// pulls out ONLY the Methods and Results sections, kept short (2000 chars
// each) — used purely to inform which sentence Claude highlights, not
// shown to the user wholesale. We deliberately do NOT store or re-serve a
// paper's full body text ourselves: an open-access flag confirms it's free
// to READ, not that every OA license permits a third party to re-host the
// whole text (that varies — CC-BY generally allows it, CC-BY-NC-ND does
// not). For actually reading the full paper, the safe approach is showing
// PMC's own page in an embedded frame (see pmcUrl below), never a copy.
async function fetchPmcFullText(pmcid) {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Europe PMC fullTextXML ${res.status}`);
  const xml = await res.text();

  const sections = [...xml.matchAll(/<sec[^>]*>[\s\S]*?<\/sec>/gi)].map(m => m[0]);
  const findSection = (pattern) => {
    const sec = sections.find(s => {
      const titleMatch = s.match(/<title>(.*?)<\/title>/i);
      return titleMatch && pattern.test(titleMatch[1]);
    });
    return sec ? stripXmlTags(sec).slice(0, 2000) : null;
  };

  return {
    methodsExcerpt: findSection(/method/i),
    resultsExcerpt: findSection(/result/i)
  };
}


// Complementary to Claude's substance judgment — this is a cheap, literal
// check applied BEFORE anything reaches Claude: does at least one real
// keyword from the query actually occur in the abstract text? Filters out
// candidates a search engine's own fuzzy ranking pulled in loosely.
const STOPWORDS = new Set(["and","or","not","the","for","with","from","that","this","into","about","using","use","uses","of","in","on","to","a","an"]);
function extractKeyTerms(query) {
  return [...new Set(
    query.toLowerCase()
      .replace(/\bAND\b|\bOR\b|\bNOT\b/gi, " ")
      .split(/[^a-z0-9]+/)
      .filter(w => w.length >= 4 && !STOPWORDS.has(w))
  )];
}
function requireTermMatch(papers, queries) {
  const allTerms = [...new Set(queries.flatMap(extractKeyTerms))];
  if (allTerms.length === 0) return papers;

  // A distinctive identifier (contains both a letter and a digit — typical
  // of gene/protein/chemical names like "gstz1" or "cyp2a6") is far more
  // specific than a generic accompanying word like "gene" or "deletion".
  // Requiring only ANY term to match let through many genuinely unrelated
  // papers that happened to share common vocabulary but were never
  // actually about the specific thing being searched for — Claude's own
  // highlighting step then correctly rejected them, but only after
  // wasting real cost on a candidate pool that was mostly noise. When a
  // distinctive identifier is present, require IT specifically.
  const distinctiveTerms = allTerms.filter(t => /[a-z]/.test(t) && /[0-9]/.test(t));
  const requiredTerms = distinctiveTerms.length > 0 ? distinctiveTerms : allTerms;

  return papers.filter(p => {
    // Europe PMC's own search already applied this exact query server-side
    // (with OPEN_ACCESS:Y) before ever returning a result, so its relevance
    // ranking can be trusted as-is. Re-checking for a literal keyword
    // substring in the returned abstract was found to wrongly reject the
    // large majority of genuinely relevant Europe PMC results (33 of 35
    // candidates in one real search) — its ranking works by MeSH terms and
    // synonyms, not just literal keyword occurrence, so a real match often
    // doesn't share the searched words verbatim in the abstract text
    // itself (e.g. "Cyp1a2-null mice" for a search on "knockout").
    if (p.source === "Europe PMC") return true;
    const text = (p.abstract || "").toLowerCase();
    return requiredTerms.some(t => text.includes(t));
  });
}

function dedupe(papers) {
  const seen = new Set();
  return papers.filter(p => {
    const key = (p.doi || p.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A plain slice(0, N) after concatenating sources in a fixed order silently
// starves whichever source is listed last — a source with plenty of
// genuinely good candidates can lose almost all of them just because
// another source's results happen to appear earlier in the array. This
// round-robins across sources first (one from each, then a second from
// each, and so on) so the cap applies fairly, not by array position.
function interleaveBySource(papers) {
  const bySource = new Map();
  papers.forEach(p => {
    if (!bySource.has(p.source)) bySource.set(p.source, []);
    bySource.get(p.source).push(p);
  });
  const lists = [...bySource.values()];
  const result = [];
  for (let i = 0; result.length < papers.length; i++) {
    let addedAny = false;
    for (const list of lists) {
      if (i < list.length) { result.push(list[i]); addedAny = true; }
    }
    if (!addedAny) break;
  }
  return result;
}

// Given a set of candidate papers, ask Claude for exactly one thing per
// paper: the single sentence from its own abstract most relevant to the
// question, quoted exactly, plus one short line of context — no numeric
// score, no stance judgment. The reader decides what's actually relevant;
// this just points them at the right sentence. Papers can optionally carry
// an `angle` ('support' or 'challenge') so the highlight leans toward
// evidence for or against, when used for Critical Analysis.
//
// Large candidate pools are split into chunks that run in PARALLEL rather
// than one big sequential generation — wall-clock time then tracks the
// size of one chunk, not the size of the whole pool, which is the single
// biggest lever on how long a search actually takes.
const HIGHLIGHT_CHUNK_SIZE = 12;

async function highlightPapers(question, papers) {
  if (papers.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < papers.length; i += HIGHLIGHT_CHUNK_SIZE) {
    chunks.push(papers.slice(i, i + HIGHLIGHT_CHUNK_SIZE));
  }
  const chunkResults = await Promise.all(chunks.map(chunk => highlightChunk(question, chunk)));
  return chunkResults.flat();
}

async function highlightChunk(question, papers) {
  const numbered = papers.map((p, i) => {
    let block = `[${i}]${p.angle ? ' ANGLE: ' + p.angle : ''}\nTITLE: ${p.title}\nABSTRACT: ${p.abstract}`;
    if (p.methodsExcerpt) block += `\nMETHODS EXCERPT: ${p.methodsExcerpt}`;
    if (p.resultsExcerpt) block += `\nRESULTS EXCERPT: ${p.resultsExcerpt}`;
    return block;
  }).join("\n\n");
  const anyFullText = papers.some(p => p.methodsExcerpt || p.resultsExcerpt);

  const prompt = `A student is researching this question:
"${question}"

For each paper below, quote the sentence(s) most relevant to this question — quoted EXACTLY as they appear, word for word, so each can be located by an exact string match. Most papers only need ONE quoted highlight. Only include a second (maximum two) if there's a genuinely distinct additional point relevant to the question — never pad with a weaker second quote just to have more than one. Where a paper is marked ANGLE: support, prefer sentences that support a hypothesis answering the question. Where marked ANGLE: challenge, prefer sentences that challenge, contradict, or complicate it. Where no angle is given, just quote whichever sentence(s) are most relevant.
${anyFullText ? '\nSome papers include METHODS EXCERPT and/or RESULTS EXCERPT sections in addition to the abstract — real excerpts from the paper\'s full text. A quote from one of these can often be more specific and useful than the abstract alone (e.g. an actual effect size or exact method used). Prefer quoting from Methods/Results over the abstract when it genuinely gives the reader more useful detail, but the abstract is still perfectly fine when it already says what matters most. Mark which section each quote came from.\n' : ''}
Judge relevance by substance, not vocabulary. A paper that shares terminology with the question but is actually about a different mechanism, population, or claim is NOT relevant — do not force a highlight just because words match. If a paper doesn't genuinely engage with the substance of the question, OMIT its index from your response entirely rather than quoting a superficial or tangential sentence.

For each highlight, give one short, plain sentence of context on why it matters — not a verdict on relevance, just context to help the reader judge it themselves.

Also give the paper two scores (0-100), your own honest estimate — these are shown to the reader as informational context only, never used to hide or rank results, so give your genuine judgment rather than avoiding extremes:
- "relevance": how relevant this paper is to the student's question overall
- "accuracy": how much the highlighted excerpt(s) can be trusted at face value — factoring in (a) whether this is genuinely the right paper for the topic, not a loose or mismatched result, (b) whether the quoted excerpt(s) genuinely reflect the paper's actual finding rather than being taken out of context, and (c) whether they're faithfully represented rather than overstated or contradicted by the rest of the abstract

Papers:
${numbered}

Respond with ONLY a JSON array, one object per paper index, in this exact shape, and nothing else — "section" must be exactly "abstract", "methods", or "results", matching which text the quote came from:
[{"index": 0, "highlights": [{"text": "exact substring", "reason": "one short sentence of context", "section": "abstract"}], "relevance": 0-100, "accuracy": 0-100}]`;

  const msg = await createMessageWithRetry({
    model: MODEL,
    max_tokens: 3600,
    temperature: 0, // relevance/highlight judgment, not creative writing — the
                    // same paper set should get the same verdict every time
    messages: [{ role: "user", content: prompt }]
  });

  const raw = msg.content.find(b => b.type === "text")?.text || "[]";
  const clean = raw.replace(/```json|```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    console.error(`highlightChunk: JSON parse failed for ${papers.length} papers (stop_reason: ${msg.stop_reason}). First/last 300 chars:`, clean.slice(0, 300), "...", clean.slice(-300));
    parsed = [];
  }

  // Keep the original candidate order (OpenAlex/Semantic Scholar's own
  // relevance ranking) rather than however the model happened to list
  // them — the reader gets the raw search-engine ordering, not an
  // AI re-ranking. Relevance/accuracy scores are informational only —
  // they never filter, sort, or hide anything here.
  const clampScore = n => (typeof n === "number" && isFinite(n)) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  const byIndex = new Map(parsed.map(s => [s.index, s]));
  return papers
    .map((paper, i) => {
      const s = byIndex.get(i);
      if (!s) return null;
      const rawHighlights = Array.isArray(s.highlights) ? s.highlights
        : (s.highlight ? [{ text: s.highlight, reason: s.reason, section: s.section }] : []);
      // A highlight is only kept if its quoted text is genuinely locatable
      // in the SPECIFIC source text it claims to come from — this is what
      // stops a fabricated or misattributed quote from ever reaching the
      // reader, now checked against the right source (abstract, methods,
      // or results) rather than always the abstract.
      const sourceFor = section => section === 'methods' ? paper.methodsExcerpt
        : section === 'results' ? paper.resultsExcerpt
        : paper.abstract;
      const highlights = rawHighlights
        .map(h => {
          const section = ['abstract','methods','results'].includes(h?.section) ? h.section : 'abstract';
          return { text: h?.text, reason: typeof h?.reason === "string" ? h.reason : "", section };
        })
        .filter(h => h.text && sourceFor(h.section) && sourceFor(h.section).includes(h.text))
        .slice(0, 2);
      if (highlights.length === 0) return null; // no genuinely locatable highlight = not included

      const relevance = clampScore(s.relevance);
      const accuracy = clampScore(s.accuracy);
      // Suitability is computed here, deterministically — not asked of the
      // model directly — since averaging two numbers we already trust is
      // more reliable than hoping the model self-combines them consistently.
      const suitability = (relevance != null && accuracy != null)
        ? Math.round((relevance + accuracy) / 2)
        : (relevance ?? accuracy ?? null);

      return { ...paper, highlights, suitability };
    })
    .filter(Boolean);
}

// =====================================================================
// AUTH — passwordless. A signed link proves email ownership; whether
// that email currently has an active Stripe subscription is checked
// live, every time, rather than stored anywhere on our side.
// =====================================================================

const activeSessions = new Map(); // customerId -> array of sessionIds, oldest first
// Tracks sessions that have been evicted, rather than requiring every
// request's session to be on a "valid" list. This matters because both
// maps live in memory: if enforcement checked "is this session on the valid
// list?", every server restart (each deploy, any idle spin-down) would empty
// that list and wrongly log out every subscriber at once. Checking for
// revocation instead means a restart can only ever forget an eviction —
// the same fail-open limitation as the hourly rate limit — never lock a
// legitimate user out. Entries older than the 30-day token lifetime are
// pruned, since the token itself would have expired by then anyway.
const revokedSessions = new Map(); // sessionId -> time revoked (ms)
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_SESSIONS = 2;

function signSessionToken(email, customerId) {
  // Session tracking, on top of the hourly rate limit: allows up to 2
  // concurrent logins per account (covers one person's own laptop + phone,
  // completely normal and never worth penalising), and automatically logs
  // out the OLDEST session the moment a 3rd concurrent login happens. This
  // catches genuine multi-person sharing directly, at the moment it
  // happens, rather than only after enough combined volume trips the rate
  // limit — the two mechanisms cover different sharing patterns (this one
  // catches simultaneous use; the rate limit catches sequential/heavy use).
  const sessionId = randomUUID();
  const sessions = activeSessions.get(customerId) || [];
  sessions.push(sessionId);
  while (sessions.length > MAX_CONCURRENT_SESSIONS) {
    const evicted = sessions.shift(); // evict the oldest first
    revokedSessions.set(evicted, Date.now());
    console.warn(`[session-limit] FLAGGED: ${email} logged in on a 3rd concurrent device — oldest session evicted. Possible account sharing.`);
  }
  activeSessions.set(customerId, sessions);
  const cutoff = Date.now() - SESSION_LIFETIME_MS;
  for (const [id, at] of revokedSessions) if (at < cutoff) revokedSessions.delete(id);
  return jwt.sign({ email, customerId, sessionId, purpose: "session" }, JWT_SECRET, { expiresIn: "30d" });
}
function signMagicToken(email, customerId) {
  return jwt.sign({ email, customerId, purpose: "magic" }, JWT_SECRET, { expiresIn: "15m" });
}

// Is there an active (or trialing) subscription for this Stripe customer?
async function hasActiveSubscription(customerId) {
  const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
  return subs.data.some(s => s.status === "active" || s.status === "trialing");
}

// A small allowlist for free access — the site owner's own email(s), never
// a public signup. Comma-separated in ADMIN_EMAILS on Render. Reuses the
// exact same passwordless login flow every real subscriber uses; the only
// difference is the Stripe subscription check gets skipped for this email.
function isAdminEmail(email) {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
    .includes((email || "").toLowerCase());
}

// Require a valid session token AND (a currently-active subscription OR an admin email).
async function requireAuth(req, res, next) {
  // Stress-testing switch: set DISABLE_AUTH=true on Render to let every
  // request through with no login/subscription check at all. Flip it back
  // to unset (or "false") to restore normal gated behaviour — no code
  // changes needed either way.
  if (process.env.DISABLE_AUTH === "true") {
    req.email = "test@litmark.local";
    req.customerId = null;
    return next();
  }

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not logged in" });

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Session expired or invalid" });
  }
  if (decoded.purpose !== "session") return res.status(401).json({ error: "Invalid token" });

  // Was this session evicted by a 3rd concurrent login? Admin accounts are
  // exempt, same as the rate limit — this is about catching real customer
  // sharing, not restricting your own testing. Tokens issued before session
  // tracking existed have no sessionId at all and simply pass.
  if (decoded.customerId !== "admin" && decoded.sessionId && revokedSessions.has(decoded.sessionId)) {
    return res.status(401).json({ error: "You've been logged out because this account signed in on a new device. If this wasn't you, someone else may be using your login." });
  }

  try {
    const active = isAdminEmail(decoded.email) || await hasActiveSubscription(decoded.customerId);
    if (!active) return res.status(402).json({ error: "No active subscription" });
  } catch (err) {
    console.error("Stripe check failed:", err.message);
    return res.status(502).json({ error: "Could not verify subscription" });
  }

  req.email = decoded.email;
  req.customerId = decoded.customerId;
  next();
}

// ---------- Per-account rate limiting ----------
// Discourages one paid account being shared across multiple people by
// capping how many AI-costing requests a single account can make within a
// rolling hour. Deliberately generous — a genuine single student, even on
// a heavy assignment day, should never come close to this; it's aimed at
// clear multi-person sharing, not normal use. Kept in memory rather than
// a database for simplicity — it resets on a redeploy, an acceptable
// trade-off for a first version, and this instance only runs one process
// (WEB_CONCURRENCY=1), so there's no cross-process consistency issue yet.
const usageLog = new Map(); // email -> array of request timestamps (ms)
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Configurable via Render's environment variables without needing a code
// change — RATE_LIMIT_MAX=20 by default. Lowered from an earlier, more
// generous 40: a genuine single student, even on a busy one-assignment
// day, rarely exceeds 20 actions in a single hour, while even a modest
// two-person sharing scenario (10 each) comfortably trips this — three or
// more sharing an account becomes very hard to avoid hitting it at all.
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "20", 10);

function rateLimit(req, res, next) {
  if (process.env.DISABLE_AUTH === "true") return next(); // stress-testing bypass, same as requireAuth
  if (isAdminEmail(req.email)) return next(); // the account owner's own free access is exempt
  const now = Date.now();
  const timestamps = (usageLog.get(req.email) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    // Visible to you in Render's logs — the block itself already protects
    // against sharing, but without this you'd have no way to actually see
    // it happening or notice a pattern worth investigating.
    console.warn(`[rate-limit] FLAGGED: ${req.email} hit ${timestamps.length} requests in the last hour (limit: ${RATE_LIMIT_MAX}) — possible account sharing.`);
    return res.status(429).json({ error: "This account has made a lot of requests in the last hour. If this account is being shared, each person needs their own subscription — otherwise, just try again shortly." });
  }
  timestamps.push(now);
  usageLog.set(req.email, timestamps);
  next();
}

// ---------- Start a subscription ----------
app.post("/api/checkout", async (req, res) => {
  const email = (req.body.email || "").toString().trim().toLowerCase();
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });

  const plan = (req.body.plan || "monthly").toString();
  const priceId = plan === "annual" ? PRICE_ID_ANNUAL : PRICE_ID;
  if (!priceId) return res.status(500).json({ error: `Server not configured: missing price ID for plan "${plan}"` });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { trial_period_days: 7 }, // card collected now, first charge after 7 days unless cancelled
      allow_promotion_codes: true, // shows a native "Add promotion code" field on checkout — this is what makes creator codes actually usable, no custom code needed beyond this one line
      success_url: `${APP_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/?checkout=cancelled`
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not start checkout", detail: err.message });
  }
});

// ---------- Confirm a checkout just completed, issue a session token ----------
app.get("/api/checkout/confirm", async (req, res) => {
  const sessionId = (req.query.session_id || "").toString();
  if (!sessionId) return res.status(400).json({ error: "Missing session_id" });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid" && session.status !== "complete") {
      return res.status(402).json({ error: "Payment not completed" });
    }
    const customerId = session.customer;
    const email = session.customer_details?.email || session.customer_email;
    const token = signSessionToken(email, customerId);
    res.json({ token, email });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not confirm checkout", detail: err.message });
  }
});

// ---------- Request a login link (existing subscribers, or an admin email) ----------
app.post("/api/login", async (req, res) => {
  const email = (req.body.email || "").toString().trim().toLowerCase();
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });

  try {
    let targetId = null;
    if (isAdminEmail(email)) {
      // No real Stripe customer needed for an admin — "admin" is a sentinel,
      // never sent to Stripe's API (requireAuth skips the Stripe check
      // entirely for this email).
      targetId = "admin";
    } else {
      const customers = await stripe.customers.list({ email, limit: 5 });
      for (const c of customers.data) {
        if (await hasActiveSubscription(c.id)) { targetId = c.id; break; }
      }
    }

    // Always respond the same way whether or not we found a match — don't
    // let this endpoint reveal who is or isn't a customer/admin.
    if (targetId) {
      const magicToken = signMagicToken(email, targetId);
      const link = `${APP_URL}/?magic=${encodeURIComponent(magicToken)}`;
      try {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: email,
          subject: "Your LitMark login link",
          html: `<p>Click below to log in to LitMark. This link expires in 15 minutes.</p><p><a href="${link}">${link}</a></p>`
        });
      } catch (err) {
        console.error("Email send failed:", err.message);
      }
    }
    res.json({ sent: true });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Login request failed", detail: err.message });
  }
});

// ---------- Confirm a magic link, issue a session token ----------
app.get("/api/login/confirm", async (req, res) => {
  const token = (req.query.token || "").toString();
  if (!token) return res.status(400).json({ error: "Missing token" });

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Link expired or invalid — request a new one" });
  }
  if (decoded.purpose !== "magic") return res.status(401).json({ error: "Invalid token" });

  const sessionToken = signSessionToken(decoded.email, decoded.customerId);
  res.json({ token: sessionToken, email: decoded.email });
});

// ---------- Stripe-hosted billing management page ----------
app.get("/api/billing-portal", requireAuth, async (req, res) => {
  if (req.customerId === "admin") {
    return res.status(400).json({ error: "Admin accounts don't have a billing subscription to manage." });
  }
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: req.customerId,
      return_url: APP_URL
    });
    res.json({ url: portal.url });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not open billing portal", detail: err.message });
  }
});

// ---------- Search (subscribers only) ----------
app.get("/api/search", requireAuth, rateLimit, async (req, res) => {
  const question = (req.query.q || "").toString().trim();
  if (!question) return res.status(400).json({ error: "Missing query param: q" });
  const minYear = req.query.minYear ? parseInt(req.query.minYear, 10) : null;
  // Default is open-access only. With includePaywalled=1, papers that aren't
  // free to read are included too (abstract-only, linked to the publisher
  // page) — much of the literature in fields outside biomedicine sits
  // behind paywalls that a student's university library unlocks.
  const oaOpts = { requireOA: req.query.includePaywalled !== "1" };

  try {
    const searchQuery = await buildSearchQuery(question);

    // Two nets, not one: the distilled keyword query catches precise
    // matches, but a narrowed query can miss papers a broader phrasing
    // would find — especially for open, exploratory questions ("uses of
    // X") rather than a specific claim. Searching the raw question too
    // and merging both pools substantially widens coverage.
    const fetches = await Promise.allSettled([
      searchOpenAlex(searchQuery, oaOpts),
      searchSemanticScholar(searchQuery, oaOpts),
      searchOpenAlex(question, oaOpts),
      searchSemanticScholar(question, oaOpts),
      searchEuropePMC(searchQuery, oaOpts),
      searchEuropePMC(question, oaOpts),
      searchCORE(searchQuery, oaOpts),
      searchCORE(question, oaOpts)
    ]);
    const labels = ["OpenAlex(query)", "SemanticScholar(query)", "OpenAlex(raw)", "SemanticScholar(raw)", "EuropePMC(query)", "EuropePMC(raw)", "CORE(query)", "CORE(raw)"];
    fetches.forEach((f, i) => {
      if (f.status === "rejected") console.error(`${labels[i]} failed:`, f.reason?.message || f.reason);
      else console.log(`${labels[i]}: ${f.value.length} results`);
    });

    const allFound = dedupe(fetches.flatMap(f => f.status === "fulfilled" ? f.value : []));
    // A paper with no year on record is kept rather than penalized —
    // only papers we KNOW are older than the cutoff are excluded.
    const dateFiltered = minYear ? allFound.filter(p => !p.year || p.year >= minYear) : allFound;
    const papers = interleaveBySource(requireTermMatch(dateFiltered, [searchQuery, question])).slice(0, 36);

    // Breaks candidate counts down by source at each stage — this is what
    // actually shows whether a source is quietly contributing nothing,
    // rather than just a single combined total that hides which source
    // dropped out.
    const bySource = (list) => list.reduce((acc, p) => { acc[p.source] = (acc[p.source] || 0) + 1; return acc; }, {});
    console.log(`[search] candidates by source (before filter):`, bySource(allFound));
    console.log(`[search] candidates by source (after filter):`, bySource(papers));

    console.log(`[search] "${question}" -> query "${searchQuery}" -> ${allFound.length} candidates, ${papers.length} after keyword-match filter`);

    if (papers.length === 0) {
      return res.json({ results: [], warning: "No open-access papers found for this query." });
    }

    // For every candidate — regardless of which source found it — check
    // whether Europe PMC separately has full text available. This is what
    // lets Claude consider Methods/Results, not just the abstract, when
    // picking a highlight. Failures here just fall back to abstract-only
    // for that one paper; they never break the search.
    //
    const highlighted = await highlightPapers(question, papers);
    console.log(`[search] highlightPapers: ${papers.length} in -> ${highlighted.length} out`);
    // Highest suitability first. Sorting (unlike the old filtering-by-score
    // approach) never drops a paper — it only changes order — so it doesn't
    // carry the failure mode that got scoring removed once already.
    const sorted = [...highlighted].sort((a, b) => (b.suitability ?? -1) - (a.suitability ?? -1));
    const results = sorted.slice(0, 20);

    // Full-text availability is checked only on the papers actually being
    // shown, not the full candidate pool — checking all 36 candidates
    // before highlighting used to mean checking ~16 papers that never even
    // made it to the screen. Checking after slicing, on just these ~20,
    // is meaningfully cheaper.
    const withFullText = await mapWithConcurrency(results, 4, async (p) => {
      try {
        const pmcid = p.pmcid || await findPmcMatchByDoi(p.doi);
        if (!pmcid) return p;
        return { ...p, hasFullText: true, pmcUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`, pmcid };
      } catch {
        return p;
      }
    });
    console.log(`[search] full text available for ${withFullText.filter(p => p.hasFullText).length}/${withFullText.length} shown results`);

    // For the (typically much smaller) subset that has full text, fetch
    // the actual Methods/Results excerpts and re-run highlighting just for
    // those — cheap now, since it only touches papers that already made
    // the final cut, not the full 36-candidate pool this used to run on
    // before full text was moved after slicing. Gives Claude a real shot
    // at a more specific highlight than the abstract alone offers. If this
    // step fails for any reason, or a paper's re-highlight comes back
    // empty, the paper keeps its existing abstract-only highlight rather
    // than being dropped — this only ever adds depth, never removes it.
    const withExcerpts = await mapWithConcurrency(withFullText, 4, async (p) => {
      if (!p.hasFullText) return p;
      try {
        const excerpts = await fetchPmcFullText(p.pmcid);
        if (!excerpts.methodsExcerpt && !excerpts.resultsExcerpt) return p;
        return { ...p, methodsExcerpt: excerpts.methodsExcerpt, resultsExcerpt: excerpts.resultsExcerpt };
      } catch {
        return p;
      }
    });

    const toReHighlight = withExcerpts.filter(p => p.methodsExcerpt || p.resultsExcerpt);
    let finalResults = withExcerpts;
    if (toReHighlight.length > 0) {
      const reHighlighted = await highlightPapers(question, toReHighlight);
      const byIdRe = new Map(reHighlighted.map(p => [p.id, p]));
      finalResults = withExcerpts.map(p => byIdRe.get(p.id) || p);
      console.log(`[search] re-highlighted with full text: ${toReHighlight.length} candidates -> ${reHighlighted.length} improved`);
    }

    res.json({ results: finalResults, searchQuery });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Search failed", detail: err.message });
  }
});

// ---------- Critical Analysis: for/against columns ----------
// Runs two deliberately-framed searches — one for supporting evidence, one
// for challenging evidence — and puts each paper in whichever column its
// OWN search found it in. No post-hoc "does this support or challenge"
// judgment call on Claude's part, so there's no failure mode where
// everything gets classified as ambiguous and both columns end up empty.
app.get("/api/critical-search", requireAuth, rateLimit, async (req, res) => {
  const question = (req.query.q || "").toString().trim();
  if (!question) return res.status(400).json({ error: "Missing query param: q" });
  const minYear = req.query.minYear ? parseInt(req.query.minYear, 10) : null;
  // Default is open-access only. With includePaywalled=1, papers that aren't
  // free to read are included too (abstract-only, linked to the publisher
  // page) — much of the literature in fields outside biomedicine sits
  // behind paywalls that a student's university library unlocks.
  const oaOpts = { requireOA: req.query.includePaywalled !== "1" };

  try {
    const [supportQuery, counterQuery] = await Promise.all([
      buildSearchQuery(question),
      buildCounterQuery(question)
    ]);

    const [supportFetches, counterFetches] = await Promise.all([
      Promise.allSettled([searchOpenAlex(supportQuery, oaOpts), searchSemanticScholar(supportQuery, oaOpts), searchEuropePMC(supportQuery, oaOpts), searchCORE(supportQuery, oaOpts)]),
      Promise.allSettled([searchOpenAlex(counterQuery, oaOpts), searchSemanticScholar(counterQuery, oaOpts), searchEuropePMC(counterQuery, oaOpts), searchCORE(counterQuery, oaOpts)])
    ]);
    const labels = ["OpenAlex(support)", "SemanticScholar(support)", "EuropePMC(support)", "CORE(support)", "OpenAlex(counter)", "SemanticScholar(counter)", "EuropePMC(counter)", "CORE(counter)"];
    [...supportFetches, ...counterFetches].forEach((f, i) => {
      if (f.status === "rejected") console.error(`${labels[i]} failed:`, f.reason?.message || f.reason);
    });

    const dateFilter = list => minYear ? list.filter(p => !p.year || p.year >= minYear) : list;

    // support-first, so a paper found by both searches defaults to the
    // "support" column rather than appearing twice or being dropped
    const supportPapers = requireTermMatch(
      dateFilter(supportFetches.flatMap(f => f.status === "fulfilled" ? f.value : [])), [supportQuery]
    ).map(p => ({ ...p, angle: "support" }));
    const counterPapers = requireTermMatch(
      dateFilter(counterFetches.flatMap(f => f.status === "fulfilled" ? f.value : [])), [counterQuery]
    ).map(p => ({ ...p, angle: "challenge" }));
    const papers = interleaveBySource(dedupe([...supportPapers, ...counterPapers])).slice(0, 30);

    console.log(`[critical] "${question}" -> support "${supportQuery}" (${supportPapers.length}) / counter "${counterQuery}" (${counterPapers.length}) -> ${papers.length} after dedupe`);

    if (papers.length === 0) {
      return res.json({ supports: [], challenges: [], warning: "No open-access papers found for this query." });
    }

    const highlighted = await highlightPapers(question, papers);
    console.log(`[critical] highlightPapers: ${papers.length} in -> ${highlighted.length} out`);
    const bySuitability = (a, b) => (b.suitability ?? -1) - (a.suitability ?? -1);
    const supports = highlighted.filter(p => p.angle === "support").sort(bySuitability).slice(0, 7);
    const challenges = highlighted.filter(p => p.angle === "challenge").sort(bySuitability).slice(0, 7);

    // Same principle as /api/search: full-text availability is only
    // checked on the papers actually being shown (up to 14 here, not the
    // full candidate pool).
    const checkFullText = async (list) => mapWithConcurrency(list, 4, async (p) => {
      try {
        const pmcid = p.pmcid || await findPmcMatchByDoi(p.doi);
        if (!pmcid) return p;
        return { ...p, hasFullText: true, pmcUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`, pmcid };
      } catch {
        return p;
      }
    });
    const [supportsWithFullText, challengesWithFullText] = await Promise.all([
      checkFullText(supports), checkFullText(challenges)
    ]);

    // Same re-highlighting step as /api/search: fetch real Methods/Results
    // excerpts for the (typically small) subset with full text available,
    // and give Claude a chance to find a more specific quote than the
    // abstract alone. A paper keeps its existing highlight if this step
    // fails or comes back empty for it — this only ever adds depth.
    const combined = [...supportsWithFullText, ...challengesWithFullText];
    const withExcerpts = await mapWithConcurrency(combined, 4, async (p) => {
      if (!p.hasFullText) return p;
      try {
        const excerpts = await fetchPmcFullText(p.pmcid);
        if (!excerpts.methodsExcerpt && !excerpts.resultsExcerpt) return p;
        return { ...p, methodsExcerpt: excerpts.methodsExcerpt, resultsExcerpt: excerpts.resultsExcerpt };
      } catch {
        return p;
      }
    });
    const toReHighlight = withExcerpts.filter(p => p.methodsExcerpt || p.resultsExcerpt);
    let finalCombined = withExcerpts;
    if (toReHighlight.length > 0) {
      const reHighlighted = await highlightPapers(question, toReHighlight);
      const byIdRe = new Map(reHighlighted.map(p => [p.id, p]));
      finalCombined = withExcerpts.map(p => byIdRe.get(p.id) || p);
    }
    const finalSupports = finalCombined.filter(p => p.angle === "support");
    const finalChallenges = finalCombined.filter(p => p.angle === "challenge");

    res.json({ supports: finalSupports, challenges: finalChallenges, supportQuery, counterQuery });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Critical analysis failed", detail: err.message });
  }
});

// ---------- Essay Citation Auditor ----------
// The student pastes a finished essay. Claude extracts every in-text
// citation and the specific claim it's attached to. For each one, we
// independently look up the ACTUAL paper — not trusting the student's
// citation — and check whether the real abstract genuinely supports what
// the essay claims. This catches fabricated or misrepresented citations
// (increasingly common when a draft has passed through an AI writing
// tool elsewhere) before submission, not after.

// Long essays are split into chunks and extracted in parallel — the same
// principle as the highlighting step. A reference list (if found) is kept
// attached to every chunk, so a citation in chunk 1 can still be matched
// against a bibliography that's only stated once, at the very end.
const CITATION_CHUNK_SIZE = 10000;
const MAX_CITATIONS_TOTAL = 40;

function splitIntoChunks(text, size) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const lastBreak = text.lastIndexOf("\n\n", end);
      if (lastBreak > start + size * 0.5) end = lastBreak;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}

async function extractCitations(essayText) {
  const refMatch = [...essayText.matchAll(/\n\s*(references|bibliography|works cited)\s*\n/gi)].pop();
  const body = refMatch ? essayText.slice(0, refMatch.index) : essayText;
  const refSection = refMatch ? essayText.slice(refMatch.index) : "";

  const chunks = splitIntoChunks(body, CITATION_CHUNK_SIZE);
  const perChunk = await Promise.all(
    chunks.map(chunk => extractCitationsFromChunk(chunk + (refSection ? "\n\n" + refSection : "")))
  );
  return perChunk.flat().slice(0, MAX_CITATIONS_TOTAL);
}

async function extractCitationsFromChunk(text) {
  const prompt = `Below is an excerpt from a student's essay (it may be a section of a longer document, with the full reference list included at the end if one exists). Find every in-text citation (e.g. "(Smith, 2020)", "(Smith et al., 2020)", numbered markers like "[3]", footnotes) and the specific claim or sentence it's attached to. If a reference list/bibliography appears, use it to identify the full title, first author, year, and — if present — DOI for each citation.

For each citation found, provide your best guess at the paper's title, first author's last name, year, and DOI — from the reference list if present, otherwise inferred from context. Leave guessTitle empty if you can't confidently guess it. Leave guessDoi empty unless an actual DOI (e.g. "10.1234/abcd.5678" or a doi.org link) appears in the reference list entry itself — never guess or invent one.

Text:
"""
${text}
"""

Respond with ONLY a JSON array, nothing else, in this shape:
[{"claim": "exact claim sentence from the text", "citationText": "(Smith, 2020)", "guessTitle": "...", "guessAuthor": "Smith", "guessYear": 2020, "guessDoi": "10.1234/abcd.5678"}]

Only extract citations that actually appear in this excerpt's own body text — ignore reference-list entries that aren't cited here.`;

  const msg = await createMessageWithRetry({
    model: MODEL,
    max_tokens: 3000,
    temperature: 0, // extraction task — the same essay text should yield the same extracted citations every time
    messages: [{ role: "user", content: prompt }]
  });
  const raw = msg.content.find(b => b.type === "text")?.text || "[]";
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch (err) {
    console.error("extractCitationsFromChunk: JSON parse failed:", clean.slice(0, 300));
    return [];
  }
}

// Look up ONE specific paper by title/author/year (different from topic
// search — this is trying to find the exact source the student cited).
// Deliberately does NOT require open access: abstracts are public even
// for paywalled papers, and we're verifying a claim against the abstract,
// not asking the student to read the full paper.

// Crude but effective: fraction of significant words (>3 letters) shared
// between two titles. Used to make sure we're comparing the claim against
// the ACTUAL cited paper, not just whatever came back first from search.
function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  const words = s => new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3)
  );
  const wa = words(a), wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.max(wa.size, wb.size);
}

// A DOI, when the reference list actually includes one, is a definitive
// identifier — no ambiguity, no fuzzy scoring needed. Tried as a direct,
// exact lookup against OpenAlex first (then Semantic Scholar), before
// ever falling back to title-similarity guessing in lookupPaper below.
async function findByDoiDirect(doi) {
  if (!doi) return null;
  const clean = doi.replace(/^https?:\/\/doi\.org\//i, "").trim();
  if (!clean) return null;

  try {
    const url = `https://api.openalex.org/works/doi:${encodeURIComponent(clean)}?mailto=${encodeURIComponent(CONTACT_EMAIL)}`;
    const res = await fetchWithRetry(url);
    if (res.ok) {
      const w = await res.json();
      if (w && w.abstract_inverted_index) {
        const oaLink = w.open_access?.oa_url || w.primary_location?.pdf_url
          || (w.open_access?.is_oa && w.doi ? w.doi : null);
        return {
          source: "OpenAlex", id: w.id, title: w.title, year: w.publication_year,
          journal: w.primary_location?.source?.display_name || "Unknown venue",
          authors: (w.authorships || []).slice(0, 4).map(a => a.author?.display_name).filter(Boolean).join(", "),
          oaUrl: oaLink || w.doi || null, isOA: !!w.open_access?.is_oa, doi: w.doi,
          citedByCount: typeof w.cited_by_count === "number" ? w.cited_by_count : null,
          abstract: reconstructAbstract(w.abstract_inverted_index)
        };
      }
    }
  } catch {}

  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(clean)}?fields=title,abstract,year,venue,authors,openAccessPdf,externalIds,citationCount`;
    const headers = process.env.SEMANTIC_SCHOLAR_API_KEY ? { "x-api-key": process.env.SEMANTIC_SCHOLAR_API_KEY } : {};
    const res = await fetchWithRetry(url, { headers });
    if (res.ok) {
      const p = await res.json();
      if (p && p.abstract) {
        return {
          source: "Semantic Scholar", id: p.externalIds?.DOI || p.paperId, title: p.title, year: p.year,
          journal: p.venue || "Unknown venue",
          authors: (p.authors || []).slice(0, 4).map(a => a.name).join(", "),
          oaUrl: p.openAccessPdf?.url || toDoiUrl(p.externalIds?.DOI), isOA: !!p.openAccessPdf?.url, doi: p.externalIds?.DOI,
          citedByCount: typeof p.citationCount === "number" ? p.citationCount : null,
          abstract: p.abstract
        };
      }
    }
  } catch {}

  return null;
}

async function lookupPaper({ guessTitle, guessAuthor, guessYear, guessDoi }) {
  if (guessDoi) {
    const direct = await findByDoiDirect(guessDoi);
    if (direct) return direct;
    // A DOI that didn't resolve anywhere is itself worth knowing — fall
    // through to the fuzzy title match rather than giving up, in case the
    // DOI was mistyped in the essay but the paper is still real.
  }

  const query = [guessTitle, guessAuthor, guessYear].filter(Boolean).join(" ").trim();
  if (!query) return null;

  const results = await Promise.allSettled([
    searchOpenAlex(query, { requireOA: false }),
    searchSemanticScholar(query, { requireOA: false }),
    searchEuropePMC(query, { requireOA: false }),
    searchCORE(query, { requireOA: false })
  ]);
  const candidates = dedupe(results.flatMap(r => r.status === "fulfilled" ? r.value : []));
  if (candidates.length === 0) return null;

  if (!guessTitle) {
    // No title to check against — too risky to just guess by year alone,
    // since that could easily land on the wrong paper.
    return guessYear ? (candidates.find(c => c.year === guessYear) || null) : null;
  }

  let best = null, bestScore = 0;
  for (const c of candidates) {
    let score = titleSimilarity(guessTitle, c.title);
    if (guessYear && c.year === guessYear) score += 0.15;
    if (score > bestScore) { bestScore = score; best = c; }
  }

  // Require real confidence before trusting a match — falsely matching
  // the wrong paper and reporting a correct citation as "misrepresented"
  // is a worse failure than honestly saying we couldn't find it.
  return bestScore >= 0.35 ? best : null;
}

async function verifyCitation(claim, paper) {
  if (!paper || !paper.abstract) {
    // Genuinely couldn't locate this source at all — an existence problem,
    // distinct from finding it and being unable to confirm the claim.
    return { status: "not_found", explanation: "Couldn't find this source at all — it may not be indexed, or the title/author guess was off. Worth double-checking it actually exists." };
  }
  const prompt = `An essay makes this claim, attributing it to a source:
CLAIM: "${claim}"

Here is that source's actual abstract:
"${paper.abstract}"

Does the abstract genuinely support the claim as written? Respond with ONLY JSON, nothing else:
{"status": "faithful" | "overstated" | "misrepresented" | "unrelated", "explanation": "one short plain sentence"}
- faithful: the claim accurately reflects what the abstract says
- overstated: the claim goes further than the evidence supports (e.g. abstract says "may suggest", claim says "proves")
- misrepresented: the claim says something the abstract doesn't support or actually contradicts
- unrelated: the abstract doesn't address the claim's topic at all`;

  const msg = await createMessageWithRetry({
    model: MODEL,
    max_tokens: 200,
    temperature: 0, // fidelity judgment — the same claim/abstract pair should get the same verdict every time
    messages: [{ role: "user", content: prompt }]
  });
  const raw = msg.content.find(b => b.type === "text")?.text || "{}";
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(clean);
    return { status: parsed.status || "unverifiable", explanation: parsed.explanation || "" };
  } catch {
    // Found the real source (we have its abstract) but something went
    // wrong generating a fidelity verdict this time — a technical hiccup,
    // not an existence problem, so this stays a separate status.
    return { status: "unverifiable", explanation: "Found the source, but couldn't generate a clear verdict this time — worth checking manually." };
  }
}

// Process citations in small concurrent batches rather than all at once —
// each citation involves 3 source lookups plus a verification call, so
// firing 20 of these simultaneously would hammer external rate limits.
async function mapWithConcurrency(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

// Rides entirely on data already fetched while verifying citations — no
// extra API calls. Flags patterns worth a student's attention: a
// bibliography that's gone stale, or leaning heavily on one author's work.
function analyzeBibliography(results) {
  const found = results.filter(r => r.matchedYear);
  if (found.length < 3) return null; // not enough matched sources to say anything meaningful

  const currentYear = new Date().getFullYear();
  const ages = found.map(r => currentYear - r.matchedYear);
  const avgAge = Math.round(ages.reduce((a, b) => a + b, 0) / ages.length);
  const recentCount = ages.filter(a => a <= 5).length;
  const oldShare = ages.filter(a => a > 10).length / found.length;

  const authorCounts = {};
  found.forEach(r => {
    const firstAuthor = (r.matchedAuthors || "").split(",")[0]?.trim();
    if (firstAuthor) authorCounts[firstAuthor] = (authorCounts[firstAuthor] || 0) + 1;
  });
  const topAuthor = Object.entries(authorCounts).sort((a, b) => b[1] - a[1])[0];

  const notes = [];
  if (recentCount === 0) {
    notes.push(`None of your matched sources are from the last 5 years (average age: ${avgAge} years) — worth checking for more recent literature.`);
  } else if (oldShare > 0.5) {
    notes.push(`Over half your matched sources are more than 10 years old (average age: ${avgAge} years) — consider balancing with more recent work.`);
  }
  if (topAuthor && found.length >= 4) {
    const pct = Math.round((topAuthor[1] / found.length) * 100);
    if (pct >= 40) {
      notes.push(`${pct}% of your matched sources share ${topAuthor[0]} as an author — worth drawing from a wider range of researchers.`);
    }
  }

  return { matchedCount: found.length, avgAge, notes };
}

// Shared by both the paste route and the file-upload route — everything
// after "we have plain essay text" is identical either way.
async function auditEssayText(essayText) {
  const citations = await extractCitations(essayText);
  console.log(`[audit] extracted ${citations.length} citations`);

  if (citations.length === 0) {
    return { results: [], warning: "No in-text citations were found in this text." };
  }

  const results = await mapWithConcurrency(citations, 5, async (c) => {
    const paper = await lookupPaper(c).catch(() => null);
    console.log(`[audit] guessed "${c.guessTitle || '(no title)'}" (${c.guessAuthor || '?'}, ${c.guessYear || '?'}) -> matched "${paper?.title || 'NOTHING'}"${paper?.year ? ' (' + paper.year + ')' : ''}`);
    const verdict = await verifyCitation(c.claim, paper);
    return {
      claim: c.claim,
      citationText: c.citationText,
      matchedTitle: paper?.title || null,
      matchedUrl: paper?.oaUrl || null,
      matchedJournal: paper?.journal || null,
      matchedYear: paper?.year || null,
      matchedAuthors: paper?.authors || null,
      matchedOA: paper ? !!paper.isOA : null,
      matchedCitedByCount: typeof paper?.citedByCount === "number" ? paper.citedByCount : null,
      ...verdict
    };
  });

  console.log(`[audit] verified ${results.length} citations`);
  const bibliography = analyzeBibliography(results);
  return { results, bibliography };
}

app.post("/api/audit-essay", requireAuth, rateLimit, async (req, res) => {
  const essayText = (req.body.essay || "").toString().trim();
  if (!essayText) return res.status(400).json({ error: "Missing essay text" });
  if (essayText.length > 100000) return res.status(400).json({ error: "Essay too long — 100,000 characters max (around 15,000 words)" });

  try {
    res.json(await auditEssayText(essayText));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Couldn't complete the citation audit right now — try again in a moment.", detail: err.message });
  }
});

// ---------- Citation Audit: file upload (.docx / .pdf / .txt) ----------
// Accepts a Word doc or plain text file instead of pasted text. Extraction
// is the one genuinely new failure mode here — .docx is a zipped bundle of
// XML under the hood, handled by the well-established `mammoth` library
// rather than anything hand-rolled.
app.post("/api/audit-essay/upload", requireAuth, rateLimit, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const name = (req.file.originalname || "").toLowerCase();

  let essayText;
  try {
    if (name.endsWith(".docx")) {
      const { value } = await mammoth.extractRawText({ buffer: req.file.buffer });
      essayText = value;
    } else if (name.endsWith(".txt")) {
      essayText = req.file.buffer.toString("utf-8");
    } else if (name.endsWith(".pdf")) {
      // Imported lazily, and from the library's inner file: pdf-parse's
      // top-level entry runs a debug routine on import that can crash when
      // loaded this way. Loading it only when a PDF is actually uploaded
      // also means a problem here can't affect anything else in the app.
      const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
      const parsed = await pdfParse(req.file.buffer);
      essayText = parsed.text || "";
      if (essayText.replace(/\s+/g, "").length < 200) {
        return res.status(400).json({ error: "That PDF doesn't seem to contain readable text — it may be a scan or an image. Export a text-based PDF from Word or Google Docs, or paste the text in instead." });
      }
    } else {
      return res.status(400).json({ error: "Unsupported file type — please upload a .docx, .pdf or .txt file" });
    }
  } catch (err) {
    console.error("File extraction failed:", err.message);
    return res.status(400).json({ error: "Couldn't read that file — it may be corrupted, password-protected, or an older .doc format (only .docx, .pdf and .txt are supported)" });
  }

  essayText = (essayText || "").trim();
  if (!essayText) return res.status(400).json({ error: "That file appears to be empty" });
  if (essayText.length > 100000) return res.status(400).json({ error: "That essay is too long — 100,000 characters max (around 15,000 words)" });

  try {
    const result = await auditEssayText(essayText);
    res.json({ ...result, extractedLength: essayText.length });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Couldn't complete the citation audit right now — try again in a moment.", detail: err.message });
  }
});

// ---------- Search Lexicon ----------
// Not a paper search — this generates ONE ready-to-paste PubMed Boolean
// query, plus a breakdown of the concepts it's built from. Claude only
// ever returns plain terms (simple, robust JSON) — the actual Boolean
// query string, with its nested quote marks and field tags, is built
// mechanically by this code, not generated as a single fragile JSON
// string value (which failed on more complex questions in practice).
// Each database writes the same Boolean search differently. These follow each
// interface's documented syntax: PubMed [tiab] tags; Scopus TITLE-ABS-KEY();
// Web of Science TS=(); EBSCOhost repeats the field code per term (TI "x" OR
// AB "x"); Ovid puts a suffix after the term (x.ti,ab.); Google Scholar has no
// field tags at all, so a plain grouped OR/AND query is the closest thing.
const quoteTerm = t => t.includes(" ") ? `"${t}"` : t;
const LEXICON_DBS = {
  pubmed:  { label: "PubMed",         join: " AND ", concept: ts => "(" + ts.map(t => `${quoteTerm(t)}[tiab]`).join(" OR ") + ")" },
  scopus:  { label: "Scopus",         join: " AND ", concept: ts => "TITLE-ABS-KEY(" + ts.map(quoteTerm).join(" OR ") + ")" },
  wos:     { label: "Web of Science", join: " AND ", concept: ts => "TS=(" + ts.map(quoteTerm).join(" OR ") + ")" },
  ebsco:   { label: "EBSCOhost (PsycINFO, ERIC, CINAHL…)", join: " AND ", concept: ts => "(" + ts.flatMap(t => [`TI ${quoteTerm(t)}`, `AB ${quoteTerm(t)}`]).join(" OR ") + ")" },
  ovid:    { label: "Ovid (MEDLINE, PsycINFO, Embase…)", join: " and ", concept: ts => "(" + ts.map(quoteTerm).join(" or ") + ").ti,ab." },
  scholar: { label: "Google Scholar", join: " ",     concept: ts => "(" + ts.map(quoteTerm).join(" OR ") + ")" }
};

async function generateLexicon(question, db = "pubmed") {
  const prompt = `A student wants to search academic literature databases for literature on this research question:
"${question}"

Break this down into the distinct CONCEPTS a good database search needs (usually 2-4), and for each concept, list the alternative search terms that mean the same thing or are genuinely interchangeable for search purposes — the terms within one concept will be combined with OR, so only group things that are truly alternative ways of saying the same thing.

For each concept, include, where genuinely useful for this specific question:
- synonyms
- alternative spellings
- abbreviations and acronyms
- singular/plural variants
- gene/protein aliases (only for biological topics)
- closely related field-specific terminology (e.g. ortholog/orthologue in biology, or the different names a concept goes by across disciplines) — only when it actually fits

Do NOT blindly treat merely related concepts as synonyms of each other — a concept's terms must be genuinely interchangeable, not just topically related.

Respond with ONLY JSON in this exact shape, nothing else — plain terms only, no quote marks or search syntax inside the strings themselves:
{"concepts": [{"name": "Concept name", "terms": ["term1", "term2", "term3"]}]}`;

  const msg = await createMessageWithRetry({
    model: MODEL,
    max_tokens: 1000,
    temperature: 0,
    messages: [{ role: "user", content: prompt }]
  });
  const raw = msg.content.find(b => b.type === "text")?.text || "{}";
  const clean = raw.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    console.error("generateLexicon: JSON parse failed:", clean.slice(0, 300));
    throw new Error("Could not generate search terms");
  }

  const concepts = (Array.isArray(parsed.concepts) ? parsed.concepts : [])
    .filter(c => c && typeof c.name === "string" && Array.isArray(c.terms))
    .map(c => ({
      name: c.name,
      // Strip any stray quote marks the model might still add despite
      // instructions — this is the string WE will wrap in quotes below.
      terms: c.terms
        .filter(t => typeof t === "string" && t.trim())
        .map(t => t.replace(/["']/g, "").trim())
        .filter(Boolean)
        .slice(0, 12)
    }))
    .filter(c => c.terms.length > 0)
    .slice(0, 6);

  if (concepts.length === 0) throw new Error("Could not generate search terms");

  // Build the actual Boolean query string ourselves, mechanically — no
  // risk of malformed JSON or broken syntax, since this is plain string
  // concatenation, not something an LLM had to get exactly right.
  const spec = LEXICON_DBS[db] || LEXICON_DBS.pubmed;
  const query = concepts.map(c => spec.concept(c.terms)).join(spec.join);

  return { query, concepts, db: LEXICON_DBS[db] ? db : "pubmed", dbLabel: spec.label };
}

// ---------- Summarise a saved source ----------
// Explicitly a paraphrase/summary task, not a quoting one — the prompt
// asks for the paper's useful information in Claude's own words, tied to
// why the student saved it, not a reproduction of the abstract.
app.post("/api/summarize-source", requireAuth, rateLimit, async (req, res) => {
  const question = (req.body.question || "").toString().trim();
  const title = (req.body.title || "").toString().trim();
  const abstract = (req.body.abstract || "").toString().trim();
  if (!abstract) return res.status(400).json({ error: "Missing abstract" });

  try {
    const prompt = `A student is researching this question:
"${question}"

They've saved this paper to their sources:
Title: ${title}
Abstract: ${abstract}

In 1-2 short, succinct sentences, pull out — in your own words, not quoting the abstract — the single most useful piece of information in this paper for answering their question. Skip anything in the abstract that isn't relevant. If the paper turns out not to be very useful for this question after all, say so plainly in one line rather than padding out a summary.`;

    const msg = await createMessageWithRetry({
      model: MODEL,
      max_tokens: 300,
      temperature: 0,
      messages: [{ role: "user", content: prompt }]
    });
    const summary = msg.content.find(b => b.type === "text")?.text?.trim() || "";
    res.json({ summary });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Summarize failed", detail: err.message });
  }
});

// ---------- Summarise an entire folder of saved sources together ----------
// A genuine cross-paper SYNTHESIS, not a stitched-together list of
// individual summaries — the prompt explicitly asks Claude to reason
// across all the saved abstracts at once (agreement, disagreement,
// overall picture), in its own words, rather than describing each paper
// one by one.
app.post("/api/summarize-folder", requireAuth, rateLimit, async (req, res) => {
  const question = (req.body.question || "").toString().trim();
  const papers = Array.isArray(req.body.papers) ? req.body.papers.slice(0, 20) : [];
  const withAbstracts = papers.filter(p => p && (p.abstract || "").toString().trim());
  if (withAbstracts.length < 2) return res.status(400).json({ error: "Need at least two saved papers with abstracts to synthesise" });

  const numbered = withAbstracts.map((p, i) =>
    `[${i + 1}] ${(p.title || "").toString().trim()}\n${(p.abstract || "").toString().trim()}`
  ).join("\n\n");

  try {
    const prompt = `A student is researching this question:
"${question}"

They've saved these ${withAbstracts.length} papers to this folder:

${numbered}

Write a short SYNTHESIS — not a list describing each paper one by one — of what these sources, taken together, actually say about the question. In your own words, never quoting the abstracts directly. Note where the sources agree, where they diverge or add different angles, and what the overall picture looks like across all of them combined. If the saved papers don't actually cover the question well as a set, say so plainly. Keep it to one tight paragraph, not an essay.`;

    const msg = await createMessageWithRetry({
      model: MODEL,
      max_tokens: 500,
      temperature: 0,
      messages: [{ role: "user", content: prompt }]
    });
    const summary = msg.content.find(b => b.type === "text")?.text?.trim() || "";
    res.json({ summary });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Summarize failed", detail: err.message });
  }
});

app.get("/api/lexicon", requireAuth, rateLimit, async (req, res) => {
  const question = (req.query.q || "").toString().trim();
  if (!question) return res.status(400).json({ error: "Missing query param: q" });

  try {
    const db = (req.query.db || "pubmed").toString();
    const result = await generateLexicon(question, db);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Lexicon generation failed", detail: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3787;
app.listen(port, () => console.log(`LitMark backend running on :${port}`));
