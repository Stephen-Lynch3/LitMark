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
import helmet from "helmet";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import { Resend } from "resend";
import multer from "multer";
import mammoth from "mammoth";
import { randomUUID, randomBytes } from "crypto";
import "dotenv/config";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB max

const app = express();
// Render sits in front of this app behind its own proxy, so without this,
// every request looks like it comes from Render's internal address —
// req.ip would be useless, and the login rate limiter below (keyed partly
// by IP) would silently do nothing. This makes Express read the real
// client address from the X-Forwarded-For header Render sets.
app.set("trust proxy", 1);
// Standard security headers (HSTS, no-sniff, frame-busting, etc.) on every
// response. This API only ever returns JSON, never HTML, so helmet's
// default Content-Security-Policy has nothing to actually protect here —
// left in anyway since it's harmless, in case a route ever serves anything
// else later.
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
// Stripe signs each webhook over the exact bytes it sent, so that one route
// must receive the raw body; every other route gets normal JSON parsing.
app.use((req, res, next) => (req.originalUrl === "/api/stripe-webhook" ? next() : express.json()(req, res, next)));

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
// OpenAlex's free daily credit allowance without a key is small and shared
// across every student using the site — a free key (openalex.org/settings/api)
// raises it tenfold for zero cost. Search still works without one, just on a
// much tighter, easy-to-exhaust budget.
const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY || "";
if (!OPENALEX_API_KEY) {
  console.warn("[startup] WARNING: OPENALEX_API_KEY is not set. OpenAlex searches are running on a small, shared anonymous quota (roughly 100 searches/day sitewide) instead of the much larger allowance a free key provides. Get one free at https://openalex.org/settings/api and set OPENALEX_API_KEY on Render.");
}
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
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
if (/resend\.dev/i.test(FROM_EMAIL)) {
  console.warn("[startup] WARNING: FROM_EMAIL is still Resend's test address (onboarding@resend.dev). Until litmark.org is verified in Resend and FROM_EMAIL is set to an address on it (e.g. \"LitMark <hello@litmark.org>\"), Resend will only deliver to your own Resend account email, so customers will not receive login links or sign-up confirmations.");
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn("[startup] WARNING: STRIPE_WEBHOOK_SECRET is not set, so sign-up confirmation emails will NOT be sent. Add a webhook endpoint in Stripe (event: checkout.session.completed) and paste its signing secret into this variable.");
}

// The Resend library reports a rejected send (an unverified sender, a bad
// address, a revoked key) by RETURNING an error rather than throwing one, so
// a plain try/catch around resend.emails.send() never notices a failure: the
// page would say "sent" while nothing arrived and nothing was logged. This
// turns both kinds of failure into a thrown Error.
async function sendEmail({ to, subject, html, text }) {
  const result = await resend.emails.send({
    from: FROM_EMAIL, to, subject, html, text,
    ...(CONTACT_EMAIL !== "you@example.com" ? { replyTo: CONTACT_EMAIL } : {})
  });
  if (result && result.error) {
    throw new Error(result.error.message || result.error.name || "Resend rejected the email");
  }
  return result;
}
// A real button, with short human text as the clickable target rather than
// the raw URL itself — both because that reads as a proper product rather
// than a debug dump, and because a link this short causes none of the
// Apple Mail trouble the old long JWT link did. The plain URL is still
// shown underneath in small text, for anyone whose mail app strips styled
// buttons, or who'd rather copy it manually.
function buildLoginLinkEmailHtml(link) {
  // Tried a long token, a short one, a styled button and a bare plain
  // link — every version failed identically in Mac Mail's own link
  // handling while copy-paste always worked, which rules out the email
  // itself as the cause. Since none of it made a difference either way,
  // this goes back to the styled button: it's simply the nicer design,
  // and the plain fallback link stays underneath for copy-pasting.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:16px;">
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#14161A;line-height:1.55;font-size:15px;">
<h1 style="font-size:20px;margin:0 0 4px;">Log in to LitMark</h1>
<p style="margin:0 0 22px;color:#6E7166;">We find it. You write it. Nothing fake.</p>
<p style="margin:0 0 20px;">Click the button below to log in. This link works once, and expires in 15 minutes.</p>
<p style="margin:0 0 24px;"><a href="${link}" style="display:inline-block;background:#14161A;color:#FDFDF9;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:24px;">Log in to LitMark</a></p>
<p style="margin:0 0 8px;color:#6E7166;font-size:13px;">If the button doesn't work, copy and paste this link into your browser:</p>
<p style="margin:0 0 20px;word-break:break-all;font-size:13px;"><a href="${link}" style="color:#1A3FB0;">${link}</a></p>
<p style="margin:0;color:#6E7166;font-size:13px;">If you didn't ask for this, you can ignore this email.</p>
</div>
</body></html>`;
}

function emailFailureHint(message) {
  return /verify a domain|only send testing emails|not verified/i.test(String(message))
    ? " -> Resend won't send from this address yet. Verify litmark.org at resend.com/domains and set FROM_EMAIL on Render to an address on it, e.g. \"LitMark <hello@litmark.org>\"."
    : "";
}

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

// What KIND of paper is this? Sources describe it differently ("review",
// "JournalArticle", "Journal Article; Review", ...), so map them onto one
// short label a student can read at a glance — a review and a single trial
// are used very differently in an essay. The source's own tag wins; the
// title only sharpens a generic one (an article whose title says it's a
// systematic review), and a title that says "protocol" is flagged as such,
// since a protocol reports no results.
function normalizePaperType(rawList, title = "") {
  const raw = (Array.isArray(rawList) ? rawList : [rawList]).filter(Boolean).map(s => String(s).toLowerCase()).join(" | ");
  const t = String(title || "").toLowerCase();
  const has = re => re.test(raw);
  if (/\bprotocol\b/.test(t) && /(review|trial|study)/.test(t)) return "Study protocol";
  let label = null;
  if (has(/systematic review/)) label = "Systematic review";
  else if (has(/meta[- ]?analy/)) label = "Meta-analysis";
  else if (has(/randomi[sz]ed controlled trial/)) label = "Randomised controlled trial";
  else if (has(/clinical trial/)) label = "Clinical trial";
  else if (has(/case report/)) label = "Case report";
  else if (has(/\breview\b/)) label = "Review";
  else if (has(/preprint|posted[- ]content/)) label = "Preprint";
  else if (has(/dissertation|thesis/)) label = "Thesis";
  else if (has(/conference|proceedings/)) label = "Conference paper";
  else if (has(/book[- ]?(chapter|section)|chapter/)) label = "Book chapter";
  else if (has(/\bbook\b/)) label = "Book";
  else if (has(/editorial/)) label = "Editorial";
  else if (has(/letter|comment/)) label = "Letter or comment";
  else if (has(/dataset/)) label = "Dataset";
  else if (has(/report/)) label = "Report";
  else if (has(/article|journal|research/)) label = "Research article";
  if (!label || label === "Research article" || label === "Review") {
    if (/systematic (literature )?review/.test(t)) return "Systematic review";
    if (/meta[- ]?analy/.test(t)) return "Meta-analysis";
    if (/randomi[sz]ed (controlled |clinical )?trial|randomi[sz]ed,? (double|placebo)/.test(t)) return "Randomised controlled trial";
    if (/(scoping|narrative|literature|umbrella|integrative) review/.test(t)) return "Review";
  }
  return label;
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
    "primary_location", "open_access", "abstract_inverted_index", "doi", "cited_by_count", "type", "is_retracted"
  ].join(","));
  url.searchParams.set("mailto", CONTACT_EMAIL);
  // OpenAlex introduced a metered daily credit budget in Feb 2026; a request
  // with no key gets a small shared allowance, a free key a much larger one.
  // Since this endpoint (a search/list call) is the expensive kind of
  // request, this key matters far more here than on the single-record
  // lookup below.
  if (OPENALEX_API_KEY) url.searchParams.set("api_key", OPENALEX_API_KEY);

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
      paperType: normalizePaperType([w.type], w.title),
      retracted: !!w.is_retracted,
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
  url.searchParams.set("fields", "title,abstract,year,venue,authors,openAccessPdf,externalIds,citationCount,publicationTypes");

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
      paperType: normalizePaperType(p.publicationTypes || [], p.title),
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
      paperType: normalizePaperType([
        ...(Array.isArray(r.pubTypeList?.pubType) ? r.pubTypeList.pubType : (r.pubTypeList?.pubType ? [r.pubTypeList.pubType] : [])),
        r.pubType || "",
        r.source === "PPR" ? "preprint" : ""
      ], r.title),
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
        paperType: normalizePaperType([w.documentType, ...(Array.isArray(w.types) ? w.types : [])], w.title),
        abstract: w.abstract || null
      };
    })
    .filter(p => p.abstract && (requireOA ? p.oaUrl : true));
}

// DOAJ (Directory of Open Access Journals) — added specifically to broaden
// coverage beyond the other four sources' science lean (Europe PMC is
// biomedical by design; OpenAlex, Semantic Scholar and CORE are genuinely
// multidisciplinary but still skew STEM in practice). DOAJ indexes 20,000+
// peer-reviewed OA journals across every discipline, arts and humanities
// included, with a free, keyless public API — no setup needed, unlike CORE.
// Every DOAJ-indexed article is open access by definition, so requireOA
// never actually excludes anything here the way it can for other sources.
async function searchDOAJ(query, { requireOA = true } = {}) {
  const url = new URL(`https://doaj.org/api/search/articles/${encodeURIComponent(query)}`);
  url.searchParams.set("pageSize", "30");

  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`DOAJ ${res.status}`);
  const data = await res.json();

  return (data.results || [])
    .map(r => {
      const bib = r.bibjson || {};
      const rawNames = (Array.isArray(bib.author) ? bib.author : [])
        .map(a => a?.name)
        .filter(Boolean);
      const doajAuthorList = rawNames.slice(0, MAX_AUTHORS_KEPT).map(splitGivenFamily).filter(Boolean);
      const links = Array.isArray(bib.link) ? bib.link : [];
      const fulltextLink = links.find(l => l.type === "fulltext") || links[0] || null;
      const doiEntry = (Array.isArray(bib.identifier) ? bib.identifier : []).find(i => i.type === "doi");
      return {
        source: "DOAJ",
        id: r.id,
        title: bib.title,
        year: bib.year || null,
        journal: bib.journal?.title || "Unknown venue",
        authors: doajAuthorList.slice(0, 4).map(a => a.given ? `${a.given} ${a.family}` : a.family).join(", "),
        authorList: doajAuthorList,
        authorTotal: rawNames.length,
        oaUrl: fulltextLink?.url || (doiEntry ? `https://doi.org/${doiEntry.id}` : null),
        isOA: true, // DOAJ only indexes fully open-access journals, by definition
        doi: doiEntry?.id || null,
        citedByCount: null, // DOAJ's metadata doesn't include citation counts
        paperType: normalizePaperType([], bib.title),
        abstract: bib.abstract || null
      };
    })
    .filter(p => p.abstract && (requireOA ? p.oaUrl : true));
}

// Crossref — the DOI registration agency itself, not a search engine built
// on top of one. Added specifically because, unlike every other source
// here, it is NOT limited to open-access content: publishers register a
// DOI with Crossref regardless of whether the work ends up paywalled. That
// makes it the strongest option for the citation checker's "does this
// paper genuinely exist" question — a citation to a real but paywalled
// journal can now be confirmed real, rather than landing in "unable to
// verify" purely because nothing OA-indexed matched it. Free, public,
// keyless API, ~180 million records.
//
// Because Crossref can't reliably tell us whether a given record is
// actually free to read (a link existing doesn't mean it's unpaywalled),
// oaUrl is only set when requireOA is false — otherwise this source
// correctly contributes nothing to an open-access-only search, the same
// way any source would if it had no OA content to offer.
async function searchCrossref(query, { requireOA = true } = {}) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query", query);
  url.searchParams.set("rows", "30");
  url.searchParams.set("mailto", CONTACT_EMAIL); // joins Crossref's faster "polite pool"

  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`Crossref ${res.status}`);
  const data = await res.json();
  const items = data.message?.items || [];

  return items
    .map(w => {
      const rawNames = (Array.isArray(w.author) ? w.author : [])
        .map(a => [a.given, a.family].filter(Boolean).join(" ") || a.name)
        .filter(Boolean);
      const crossrefAuthorList = rawNames.slice(0, MAX_AUTHORS_KEPT).map(splitGivenFamily).filter(Boolean);
      const year = w["published"]?.["date-parts"]?.[0]?.[0]
        || w["published-print"]?.["date-parts"]?.[0]?.[0]
        || w["published-online"]?.["date-parts"]?.[0]?.[0]
        || null;
      const fulltextLink = (Array.isArray(w.link) ? w.link : []).find(l => l["content-type"] === "text/html" || l["content-type"] === "application/pdf");
      // A plain abstract field sometimes carries JATS XML tags verbatim —
      // strip them rather than show a student raw markup.
      const cleanAbstract = w.abstract ? w.abstract.replace(/<[^>]+>/g, "").trim() : null;
      return {
        source: "Crossref",
        id: w.DOI,
        title: Array.isArray(w.title) ? w.title[0] : w.title,
        year,
        journal: (Array.isArray(w["container-title"]) && w["container-title"][0]) || w.publisher || "Unknown venue",
        authors: crossrefAuthorList.slice(0, 4).map(a => a.given ? `${a.given} ${a.family}` : a.family).join(", "),
        authorList: crossrefAuthorList,
        authorTotal: rawNames.length,
        oaUrl: requireOA ? null : (fulltextLink?.URL || (w.DOI ? `https://doi.org/${w.DOI}` : null)),
        isOA: false, // Crossref doesn't reliably say — never claimed open access by default
        doi: w.DOI || null,
        citedByCount: typeof w["is-referenced-by-count"] === "number" ? w["is-referenced-by-count"] : null,
        paperType: normalizePaperType([w.type], Array.isArray(w.title) ? w.title[0] : w.title),
        abstract: cleanAbstract
      };
    })
    .filter(p => p.abstract && (requireOA ? p.oaUrl : true));
}

// ERIC (Education Resources Information Center) — the US Department of
// Education's own free database of education research, added because
// education is a real, distinct gap none of the other sources specialise
// in. Free, public, keyless API, ~2 million records. Note: the schema for
// title/author/abstract/url below is confirmed directly; year, journal and
// a stable per-record id are mapped from the field names ERIC's own
// documentation and Solr-based API conventions indicate, but have not been
// checked against a live response the way every other source here has —
// worth a quick look at the Render logs after this first deploys, to
// confirm those three map as expected.
async function searchERIC(query, { requireOA = true } = {}) {
  const url = new URL("https://api.ies.ed.gov/eric/");
  url.searchParams.set("search", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("rows", "30");

  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`ERIC ${res.status}`);
  const data = await res.json();
  const docs = data.response?.docs || [];

  return docs
    .map(d => {
      const rawNames = (Array.isArray(d.author) ? d.author : []).filter(Boolean);
      const ericAuthorList = rawNames.slice(0, MAX_AUTHORS_KEPT).map(splitGivenFamily).filter(Boolean);
      // ERIC hosts a genuine free PDF directly for a large share of its
      // own records (especially ED-numbered grey literature) — fulltextauth
      // / url fields vary by record, so check both before falling back.
      const fulltextUrl = d.fulltextauth || d.url || null;
      return {
        source: "ERIC",
        id: d.id || d.ericid,
        title: d.title,
        year: d.publicationdateyear || null,
        journal: d.source || d.publicationtype?.[0] || "Unknown venue",
        authors: ericAuthorList.slice(0, 4).map(a => a.given ? `${a.given} ${a.family}` : a.family).join(", "),
        authorList: ericAuthorList,
        authorTotal: rawNames.length,
        oaUrl: fulltextUrl,
        isOA: !!fulltextUrl,
        doi: d.doi || null,
        citedByCount: null, // ERIC's metadata doesn't include citation counts
        paperType: normalizePaperType(Array.isArray(d.publicationtype) ? d.publicationtype : [d.publicationtype], d.title),
        abstract: d.description || null
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


function requireTermMatch(papers, queries) {
  // This used to re-check each result for a literal keyword match against
  // the query, as a cost-control backstop before the (paid) AI relevance
  // pass. It was removed once it became clear it applied to every current
  // source, not just one: OpenAlex, Semantic Scholar, Europe PMC and CORE
  // are all sent the actual query directly and rank results with their own
  // concept/ML-based relevance search — not a literal keyword index — so a
  // real match often doesn't share the searched words verbatim in the
  // returned abstract (e.g. "Cyp1a2-null mice" for a search on
  // "knockout"). Re-rejecting those here (one real search lost 33 of 35
  // genuinely relevant Europe PMC candidates this way) was silently
  // throwing away real results — the actual cause of "too few results"
  // reports, not noise control. The AI highlighting step downstream still
  // does its own, far more capable relevance judgement, and is the right
  // place for that check now.
  return papers;
}

function dedupe(papers) {
  const kept = new Map();
  for (const p of papers) {
    const key = (p.doi || p.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (!key) continue;
    const existing = kept.get(key);
    if (!existing) { kept.set(key, p); continue; }
    // Same paper from another source: keep the first, but don't lose the
    // paper type, citation count or retraction flag if only the duplicate had it.
    for (const f of ["paperType", "citedByCount", "pmcid"]) if (existing[f] == null && p[f] != null) existing[f] = p[f];
    if (p.retracted) existing.retracted = true;
  }
  return [...kept.values()];
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
// The login link used to embed a full signed JWT (three dot-separated
// base64url chunks, 150+ characters) directly in the URL. That shape —
// long, full of dots, dashes and underscores — is exactly what trips up
// Apple Mail's link handling on both macOS and iOS: the email would
// render, the link would look right, but tapping it produced a broken
// internal "x-webdoc://" reference instead of opening the page. Other
// mail apps generally coped fine; Apple Mail's did not.
//
// A short opaque code sidesteps the problem rather than working around
// Apple's bug: nothing about how a random 32-character hex string reads
// is unusual enough to confuse anything's link parsing. The mapping from
// code to who it's actually for lives here in memory, the same pattern
// already used for revokedSessions below — a login link is only ever
// useful for 15 minutes, so nothing about it needs to survive a restart.
const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1000;
const magicLinkCodes = new Map(); // code -> { email, customerId, expiresAt }
function signMagicToken(email, customerId) {
  const code = randomBytes(16).toString("hex");
  const cutoff = Date.now();
  for (const [k, v] of magicLinkCodes) if (v.expiresAt < cutoff) magicLinkCodes.delete(k);
  magicLinkCodes.set(code, { email, customerId, expiresAt: cutoff + MAGIC_LINK_LIFETIME_MS });
  return code;
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
// ---------- Sign-up consent, and the renewal terms shown at checkout ----------
// Minimum age to subscribe. A self-declared tick box is the standard age gate;
// it doesn't verify anyone's age. Under-18s generally can't be bound to a paid
// subscription, which is why this is 18 rather than the UK's age of digital
// consent (13). Change it here, and in the Terms and Privacy Policy, together.
const MIN_AGE = 18;
// Which version of the Terms was in force when someone signed up. Keep this
// equal to the "Last updated" date on the Terms page (yyyy-mm-dd).
const TERMS_VERSION = "2026-09-28";
const TRIAL_DAYS = 7;

// The gate has to be enforced here, not just on the page — a tick box in the
// browser alone could be skipped by anyone calling the API directly. Returns
// an error message, or null when both confirmations were explicitly given.
function validateCheckoutConsent(body) {
  if (body?.ageConfirmed !== true) return `Please confirm you're ${MIN_AGE} or over to subscribe.`;
  if (body?.termsAccepted !== true) return "Please agree to the Terms, Privacy Policy and automatic renewal to subscribe.";
  return null;
}

// Whole pounds print as "£6", not "£6.00", to match the price shown on the site.
function formatMoney(unitAmount, currency) {
  const whole = unitAmount % 100 === 0;
  return new Intl.NumberFormat("en-GB", {
    style: "currency", currency: String(currency || "gbp").toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2
  }).format(unitAmount / 100);
}

// Plain-English renewal terms for Stripe's own payment page, built from the
// real Stripe price so the text can never drift from what will actually be
// charged. Returns null if the price isn't a simple fixed recurring one.
function buildRenewalText(price, trialDays, now = new Date()) {
  if (!price || typeof price.unit_amount !== "number" || !price.recurring) return null;
  const amount = formatMoney(price.unit_amount, price.currency);
  const n = price.recurring.interval_count || 1;
  const every = n === 1 ? price.recurring.interval : `${n} ${price.recurring.interval}s`;
  const end = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
  return `Free for ${trialDays} days, then ${amount} every ${every}. Unless you cancel before ${end}, the first payment of ${amount} is taken then (the minimum you'd pay if you don't cancel in time), and your subscription renews automatically every ${every} until you cancel. Cancel any time online from "Manage subscription" on litmark.org.`;
}

// If Stripe rejects only the optional consent/renewal-text extras (for
// example a dashboard prerequisite isn't set), retry without them rather than
// letting a cosmetic extra take sign-up down for everyone.
async function createSessionWithFallback(client, params) {
  try {
    return await client.checkout.sessions.create(params);
  } catch (err) {
    // Two different shapes of the same underlying problem: Stripe sometimes
    // names the offending field directly (err.param), but for at least one
    // real case — an account with "Managed Payments" enabled by default,
    // which is flatly incompatible with custom_text — it instead returns no
    // param at all and only explains itself in the message text. Checking
    // both means either shape falls back the same way: retry once without
    // the optional extras rather than fail the whole sign-up over them.
    const rejectsCustomText = (err?.param && /^(custom_text|consent_collection)/.test(err.param))
      || /custom_text cannot be used/i.test(err?.message || err?.raw?.message || "");
    if (!rejectsCustomText) throw err;
    console.warn(`[checkout] Stripe rejected the optional consent/renewal text — retrying without it: ${err.message}`);
    const { custom_text, consent_collection, ...rest } = params;
    return await client.checkout.sessions.create(rest);
  }
}

app.post("/api/checkout", async (req, res) => {
  const email = (req.body.email || "").toString().trim().toLowerCase();
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });

  const consentError = validateCheckoutConsent(req.body);
  if (consentError) return res.status(400).json({ error: consentError });

  const plan = (req.body.plan || "monthly").toString();
  const priceId = plan === "annual" ? PRICE_ID_ANNUAL : PRICE_ID;
  if (!priceId) return res.status(500).json({ error: `Server not configured: missing price ID for plan "${plan}"` });

  try {
    // Recorded against the subscription in Stripe, so there's a timestamped
    // record of what each customer confirmed and which Terms they agreed to.
    const consentMeta = {
      age_confirmed: `${MIN_AGE}+`,
      terms_accepted_at: new Date().toISOString(),
      terms_version: TERMS_VERSION,
      auto_renewal_acknowledged: "true"
    };

    let renewalText = null;
    try { renewalText = buildRenewalText(await stripe.prices.retrieve(priceId), TRIAL_DAYS); }
    catch (e) { console.warn("[checkout] couldn't load price for renewal text:", e.message); }

    const params = {
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: consentMeta,
      subscription_data: { trial_period_days: TRIAL_DAYS, metadata: consentMeta }, // card collected now, first charge after the trial unless cancelled
      allow_promotion_codes: true, // shows a native "Add promotion code" field on checkout — this is what makes creator codes actually usable, no custom code needed beyond this one line
      success_url: `${APP_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/?checkout=cancelled`,
      // This account has Stripe's "Managed Payments" turned on by default —
      // a bigger merchant-of-record product, not something LitMark's own
      // Stripe integration was ever built around. Left on, it rejected
      // custom_text outright, and once that was worked around, rejected the
      // whole session again because Managed Payments separately requires a
      // tax code on the product, which these products don't have. Rather
      // than patch around each new requirement it surfaces, this switches
      // it off for LitMark's sessions specifically — the subscription,
      // trial and billing-portal flow are unaffected either way.
      managed_payments: { enabled: false }
    };
    // Renewal terms next to Stripe's own pay button, as well as on our page.
    if (renewalText) params.custom_text = { submit: { message: renewalText } };
    // Optional: an express "I agree" checkbox on Stripe's page too. Needs a
    // Terms of Service link set in the Stripe dashboard first, so it's off
    // unless STRIPE_COLLECT_TOS=true.
    if (process.env.STRIPE_COLLECT_TOS === "true") {
      params.consent_collection = { terms_of_service: "required" };
      params.custom_text = {
        ...(params.custom_text || {}),
        terms_of_service_acceptance: { message: "I agree to LitMark's Terms of Service, and that my subscription renews automatically until I cancel." }
      };
    }

    const session = await createSessionWithFallback(stripe, params);
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

    // Plan and trial details for the "you're all set" banner on the page.
    // Best-effort: if this lookup fails, login still succeeds — the
    // sign-up confirmation email (sent separately, from the webhook) has
    // the authoritative numbers regardless of whether this succeeds.
    let plan = null, trialEnd = null;
    try {
      if (session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const price = sub.items?.data?.[0]?.price;
        if (price && typeof price.unit_amount === "number" && price.recurring) {
          const n = price.recurring.interval_count || 1;
          plan = {
            amount: formatMoney(price.unit_amount, price.currency),
            every: n === 1 ? price.recurring.interval : `${n} ${price.recurring.interval}s`
          };
        }
        trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
      }
    } catch (e) {
      console.warn("[checkout/confirm] couldn't load plan/trial details:", e.message);
    }

    res.json({ token, email, plan, trialEnd });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not confirm checkout", detail: err.message });
  }
});

// ---------- Confirmation email after sign-up ----------
// Stripe sends NO receipt when a free trial starts: nothing has been charged,
// and Stripe doesn't email receipts for zero-value invoices. Without this, a
// customer would get no confirmation of what they've signed up to at all. It
// is sent from a Stripe webhook rather than from the browser's "checkout
// success" step, so it still goes out if the customer closes the tab before
// returning to the site, and Stripe retries the webhook if the send fails.
const emailEsc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ukDate = d => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });

function buildWelcomeEmail({ price, trialEnd, trialDays, discounted, termsVersion, appUrl, contactEmail }) {
  const hasPrice = !!(price && typeof price.unit_amount === "number" && price.recurring);
  const amount = hasPrice ? formatMoney(price.unit_amount, price.currency) : null;
  const interval = hasPrice ? price.recurring.interval : null;
  const n = hasPrice ? (price.recurring.interval_count || 1) : 1;
  const every = interval ? (n === 1 ? interval : `${n} ${interval}s`) : null;
  const planName = interval === "year" ? "Annual" : interval === "month" ? "Monthly" : "LitMark";
  const endText = trialEnd ? ukDate(trialEnd) : null;
  const subject = trialEnd ? "Your LitMark free trial has started" : "Welcome to LitMark: your subscription is active";
  const heading = trialEnd ? "Your free trial has started" : "Your subscription is active";

  const facts = [["Plan", amount && every ? `${planName}: ${amount} every ${every}` : "LitMark subscription"]];
  if (trialEnd) {
    facts.push(["Free trial", `${trialDays} days. Your card has not been charged.`]);
    facts.push(["First payment", `${amount || "The plan price"} on ${endText}, unless you cancel before then. After that your subscription renews automatically${every ? ` every ${every}` : ""} until you cancel.`]);
  } else {
    facts.push(["Renewal", `Your subscription renews automatically${every ? ` every ${every}` : ""} until you cancel.`]);
  }
  const paras = [];
  if (discounted) paras.push("A promotion code has been applied to your subscription. Your first invoice will show the discounted price.");
  paras.push(`How to cancel: you can cancel online at any time. Go to ${appUrl} and choose "Login/Sign up", enter this email address to get a login link, then open Account and choose "Manage subscription".${endText ? ` Cancel before ${endText} and you won't be charged.` : ""}`);
  paras.push(`Logging in again: go to ${appUrl} and choose "Login/Sign up", then enter this email address. We'll email you a login link that works for 15 minutes.`);
  paras.push(`When you signed up you confirmed you're 18 or over and agreed to our Terms of Service (version ${termsVersion}) and Privacy Policy: ${appUrl}/terms.html and ${appUrl}/privacy.html`);
  paras.push(`Questions? Email ${contactEmail}.`);

  const text = [heading, "", ...facts.map(([k, v]) => `${k}: ${v}`), "", ...paras.flatMap(x => [x, ""]), "LitMark: We find it. You write it. Nothing fake."].join("\n");
  const linkify = s => emailEsc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1A3FB0;">$1</a>');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:16px;">
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#14161A;line-height:1.55;font-size:15px;">
<h1 style="font-size:22px;margin:0 0 4px;">${emailEsc(heading)}</h1>
<p style="margin:0 0 18px;color:#6E7166;">We find it. You write it. Nothing fake.</p>
<div style="background:#F1F0E8;border-left:4px solid #C6F135;padding:14px 16px;border-radius:8px;margin:0 0 18px;">
${facts.map(([k, v]) => `<p style="margin:0 0 8px;"><b>${emailEsc(k)}:</b> ${emailEsc(v)}</p>`).join("\n")}
</div>
${paras.map(x => `<p style="margin:0 0 14px;">${linkify(x)}</p>`).join("\n")}
</div>
</body></html>`;
  return { subject, html, text };
}

// ---------- Trial-ending reminder ----------
// Not yet a legal requirement in the UK — the DMCC Act 2024's subscription
// regime (which will mandate exactly this kind of reminder) hasn't commenced
// and isn't expected to until January 2027 at the earliest. Built now anyway,
// both because it's good practice regardless of enforcement, and because the
// content below is written to already satisfy what the eventual rule will
// require: the renewal date and amount, the total minimum payable, and clear
// cancellation steps with a deadline — sent on a "durable medium" (email)
// with its purpose immediately apparent from the subject line.
// Stripe fires `customer.subscription.trial_will_end` automatically 3 days
// before a trial converts, so no custom cron/polling is needed for the
// timing — just a handler for the event Stripe already sends.
function buildTrialEndingEmail({ price, trialEnd, appUrl, contactEmail }) {
  const hasPrice = !!(price && typeof price.unit_amount === "number" && price.recurring);
  const amount = hasPrice ? formatMoney(price.unit_amount, price.currency) : "the plan price";
  const interval = hasPrice ? price.recurring.interval : null;
  const n = hasPrice ? (price.recurring.interval_count || 1) : 1;
  const every = interval ? (n === 1 ? interval : `${n} ${interval}s`) : null;
  const endText = trialEnd ? ukDate(trialEnd) : "soon";
  const subject = `Your LitMark free trial ends on ${endText}`;
  const heading = "Your free trial is ending soon";

  const facts = [
    ["Your trial ends", endText],
    ["Unless you cancel before then", `${amount} will be charged on ${endText}, and the minimum you'd pay if you don't cancel in time`],
    ["After that", `your subscription renews automatically${every ? ` every ${every}` : ""} until you cancel`]
  ];
  const paras = [
    `How to cancel: go to ${appUrl} and choose "Login/Sign up", enter this email address to get a login link, then open Account and choose "Manage subscription". Cancel before ${endText} and you won't be charged.`,
    `Logging in again: go to ${appUrl} and choose "Login/Sign up", then enter this email address. We'll email you a login link that works for 15 minutes.`,
    `Questions? Email ${contactEmail}.`
  ];
  const text = [heading, "", ...facts.map(([k, v]) => `${k}: ${v}`), "", ...paras.flatMap(x => [x, ""]), "LitMark: We find it. You write it. Nothing fake."].join("\n");
  const linkify = s => emailEsc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1A3FB0;">$1</a>');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:16px;">
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#14161A;line-height:1.55;font-size:15px;">
<h1 style="font-size:22px;margin:0 0 4px;">${emailEsc(heading)}</h1>
<p style="margin:0 0 18px;color:#6E7166;">We find it. You write it. Nothing fake.</p>
<div style="background:#F1F0E8;border-left:4px solid #C6F135;padding:14px 16px;border-radius:8px;margin:0 0 18px;">
${facts.map(([k, v]) => `<p style="margin:0 0 8px;"><b>${emailEsc(k)}:</b> ${emailEsc(v)}</p>`).join("\n")}
</div>
${paras.map(x => `<p style="margin:0 0 14px;">${linkify(x)}</p>`).join("\n")}
</div>
</body></html>`;
  return { subject, html, text };
}

const webhookDeps = () => ({ stripe, sendEmail, secret: STRIPE_WEBHOOK_SECRET, appUrl: APP_URL, contactEmail: CONTACT_EMAIL, termsVersion: TERMS_VERSION, trialDays: TRIAL_DAYS });

async function handleStripeWebhook(req, res, deps = webhookDeps()) {
  const { stripe: stripeClient, sendEmail: send, secret } = deps;
  if (!secret) {
    console.error("[webhook] STRIPE_WEBHOOK_SECRET isn't set, so Stripe's event can't be trusted or processed.");
    return res.status(500).send("Webhook not configured");
  }
  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
  } catch (err) {
    console.warn("[webhook] rejected a request with a bad signature:", err.message);
    return res.status(400).send("Bad signature");
  }
  if (event.type === "customer.subscription.trial_will_end") {
    const sub = event.data.object;
    try {
      if (sub.metadata && sub.metadata.trial_reminder_emailed === "true") return res.json({ received: true, duplicate: true });
      const customer = await stripeClient.customers.retrieve(sub.customer);
      const to = customer && !customer.deleted ? customer.email : null;
      if (!to) {
        console.warn("[webhook] trial_will_end had no customer email, so no reminder was sent");
        return res.json({ received: true });
      }
      const msg = buildTrialEndingEmail({
        price: sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price,
        trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
        appUrl: deps.appUrl,
        contactEmail: deps.contactEmail
      });
      await send({ to, ...msg });
      console.log("[webhook] sent the trial-ending reminder");
      try {
        await stripeClient.subscriptions.update(sub.id, { metadata: { ...sub.metadata, trial_reminder_emailed: "true" } });
      } catch (err) {
        console.warn("[webhook] sent the reminder but couldn't mark it as sent:", err.message);
      }
      return res.json({ received: true, emailed: true });
    } catch (err) {
      console.error("[webhook] trial reminder failed (Stripe will retry):", err.message + emailFailureHint(err.message));
      return res.status(500).send("Will retry");
    }
  }

  if (event.type !== "checkout.session.completed") return res.json({ received: true });

  const session = event.data.object;
  if (session.mode !== "subscription" || !session.subscription) return res.json({ received: true, ignored: true });

  try {
    const sub = await stripeClient.subscriptions.retrieve(session.subscription);
    // Stripe can deliver the same event more than once; the mark below, kept
    // on the subscription itself, stops a second confirmation being sent.
    if (sub.metadata && sub.metadata.confirmation_emailed === "true") return res.json({ received: true, duplicate: true });

    const to = (session.customer_details && session.customer_details.email) || session.customer_email;
    if (!to) {
      console.warn("[webhook] a completed checkout had no email address, so no confirmation was sent");
      return res.json({ received: true });
    }
    const msg = buildWelcomeEmail({
      price: sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price,
      trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
      trialDays: deps.trialDays,
      discounted: !!(sub.discount || (Array.isArray(sub.discounts) && sub.discounts.length)),
      termsVersion: deps.termsVersion,
      appUrl: deps.appUrl,
      contactEmail: deps.contactEmail
    });
    await send({ to, ...msg });
    console.log("[webhook] sent the sign-up confirmation");
    try {
      await stripeClient.subscriptions.update(sub.id, { metadata: { confirmation_emailed: "true" } });
    } catch (err) {
      // The email HAS gone out; failing the webhook now would make Stripe
      // retry and send a duplicate, which is worse than a missing mark.
      console.warn("[webhook] sent the confirmation but couldn't mark it as sent:", err.message);
    }
    return res.json({ received: true, emailed: true });
  } catch (err) {
    console.error("[webhook] confirmation email failed (Stripe will retry):", err.message + emailFailureHint(err.message));
    return res.status(500).send("Will retry");
  }
}
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), (req, res) => handleStripeWebhook(req, res));

// ---------- Rate limiting the login endpoint itself ----------
// requireAuth's rate limiter (above) only ever sees a request once someone
// is ALREADY logged in. /api/login is the one route a stranger can call
// with nothing but an email address, and every call sends a real email —
// so without its own limit, it's a way to mail-bomb any address (repeated,
// unwanted login-link emails) or to hammer Stripe's customer-lookup API.
// Two separate caps, since they guard against two different things: the
// per-email one is generous — 3 in 15 minutes covers someone who mistyped
// or didn't get the first one — and is what actually stops one target
// being spammed. The per-IP one is looser still, since a university's
// public wifi can put many genuine students behind one shared address.
const LOGIN_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT_MAX_PER_EMAIL = 3;
const LOGIN_LIMIT_MAX_PER_IP = 15;
const loginAttemptsByEmail = new Map(); // email -> timestamps (ms)
const loginAttemptsByIp = new Map();    // ip -> timestamps (ms)
function tooManyLoginAttempts(map, key, max) {
  const now = Date.now();
  for (const [k, ts] of map) if (!ts.some(t => now - t < LOGIN_LIMIT_WINDOW_MS)) map.delete(k);
  const recent = (map.get(key) || []).filter(t => now - t < LOGIN_LIMIT_WINDOW_MS);
  if (recent.length >= max) return true;
  recent.push(now); map.set(key, recent);
  return false;
}
function loginRateLimit(req, res, next) {
  const email = (req.body.email || "").toString().trim().toLowerCase();
  const ip = req.ip || "unknown";
  if (email && tooManyLoginAttempts(loginAttemptsByEmail, email, LOGIN_LIMIT_MAX_PER_EMAIL)) {
    console.warn(`[login-rate-limit] blocked: too many login requests for ${email}`);
    // Same vague message either way — this endpoint never reveals whether
    // an email is a real customer, and a rate-limit response shouldn't
    // leak that distinction either.
    return res.status(429).json({ error: "Too many login requests for this email. Please wait a few minutes and try again." });
  }
  if (tooManyLoginAttempts(loginAttemptsByIp, ip, LOGIN_LIMIT_MAX_PER_IP)) {
    console.warn(`[login-rate-limit] blocked: too many login requests from ${ip}`);
    return res.status(429).json({ error: "Too many login requests from this network. Please wait a few minutes and try again." });
  }
  next();
}

// ---------- Request a login link (existing subscribers, or an admin email) ----------
app.post("/api/login", loginRateLimit, async (req, res) => {
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
        await sendEmail({
          to: email,
          subject: "Your LitMark login link",
          html: buildLoginLinkEmailHtml(link),
          text: `Log in to LitMark: ${link}\n\nThis link expires in 15 minutes. If you didn't ask for it, you can ignore this email.`
        });
      } catch (err) {
        // Same response to the browser either way (so this endpoint can't be
        // used to discover who is a customer), but the reason is logged.
        console.error("Login email failed to send:", err.message + emailFailureHint(err.message));
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
  const code = (req.query.token || "").toString();
  if (!code) return res.status(400).json({ error: "Missing token" });

  const entry = magicLinkCodes.get(code);
  // Consumed immediately either way: a link that's already been used
  // shouldn't work a second time just because someone clicked it twice
  // (the old JWT version had no such limit — this is a genuine
  // improvement, not just a side effect of the rewrite).
  magicLinkCodes.delete(code);
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(401).json({ error: "Link expired or invalid — request a new one" });
  }

  const sessionToken = signSessionToken(entry.email, entry.customerId);
  res.json({ token: sessionToken, email: entry.email });
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
      searchCORE(question, oaOpts),
      searchDOAJ(searchQuery, oaOpts),
      searchDOAJ(question, oaOpts),
      searchCrossref(searchQuery, oaOpts),
      searchCrossref(question, oaOpts),
      searchERIC(searchQuery, oaOpts),
      searchERIC(question, oaOpts)
    ]);
    const labels = ["OpenAlex(query)", "SemanticScholar(query)", "OpenAlex(raw)", "SemanticScholar(raw)", "EuropePMC(query)", "EuropePMC(raw)", "CORE(query)", "CORE(raw)", "DOAJ(query)", "DOAJ(raw)", "Crossref(query)", "Crossref(raw)", "ERIC(query)", "ERIC(raw)"];
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
      Promise.allSettled([searchOpenAlex(supportQuery, oaOpts), searchSemanticScholar(supportQuery, oaOpts), searchEuropePMC(supportQuery, oaOpts), searchCORE(supportQuery, oaOpts), searchDOAJ(supportQuery, oaOpts), searchCrossref(supportQuery, oaOpts), searchERIC(supportQuery, oaOpts)]),
      Promise.allSettled([searchOpenAlex(counterQuery, oaOpts), searchSemanticScholar(counterQuery, oaOpts), searchEuropePMC(counterQuery, oaOpts), searchCORE(counterQuery, oaOpts), searchDOAJ(counterQuery, oaOpts), searchCrossref(counterQuery, oaOpts), searchERIC(counterQuery, oaOpts)])
    ]);
    const labels = ["OpenAlex(support)", "SemanticScholar(support)", "EuropePMC(support)", "CORE(support)", "DOAJ(support)", "Crossref(support)", "ERIC(support)", "OpenAlex(counter)", "SemanticScholar(counter)", "EuropePMC(counter)", "CORE(counter)", "DOAJ(counter)", "Crossref(counter)", "ERIC(counter)"];
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

// ---------- Add a specific paper to a folder by DOI ----------
// A student sometimes already knows the exact paper they want — a
// recommendation from a supervisor, something cited elsewhere — rather
// than searching by topic. This takes a DOI they paste in, fetches the
// REAL paper with the same exact lookup the citation auditor uses
// (findByDoiDirect, not a fuzzy title guess), and runs it through the
// same highlighting Claude already does for every search result, against
// the folder's own research question — so the student sees why (or
// whether) it's actually relevant before it lands in their folder.
app.post("/api/add-by-doi", requireAuth, rateLimit, async (req, res) => {
  const doi = cleanDoi(req.body.doi);
  const question = (req.body.question || "").toString().trim();
  if (!question) return res.status(400).json({ error: "Missing question" });
  if (!doi || !/^10\.\d{4,9}\/\S+$/.test(doi)) {
    return res.status(400).json({ error: "That doesn't look like a valid DOI. It should look like 10.1038/s41586-020-2649-2, or a doi.org link." });
  }

  try {
    const paper = await findByDoiDirect(doi);
    if (!paper) {
      // Tells "not a real/registered DOI" apart from "real, but no
      // abstract in any source we can read" — the same distinction the
      // citation auditor relies on, just as useful here: one means check
      // what you pasted, the other means the paper's genuine but we can't
      // fetch its abstract right now.
      const registered = await doiRegistration(doi);
      if (registered === "no") {
        return res.status(404).json({ error: "That DOI doesn't resolve to a registered paper — double-check it's correct." });
      }
      return res.status(404).json({ error: "Found the DOI, but couldn't get an abstract for it from any source we search — it may not be indexed yet, or may not be openly readable." });
    }

    // Same full-text upgrade /api/search gives every result: if Europe PMC
    // has the full text, pull real Methods/Results excerpts before
    // highlighting, so Claude already has the best material to quote from
    // on this one pass rather than a second re-highlight afterwards.
    let withExcerpts = paper;
    try {
      const pmcid = paper.pmcid || await findPmcMatchByDoi(paper.doi);
      if (pmcid) {
        const excerpts = await fetchPmcFullText(pmcid);
        withExcerpts = {
          ...paper, hasFullText: true, pmcid,
          pmcUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
          methodsExcerpt: excerpts.methodsExcerpt, resultsExcerpt: excerpts.resultsExcerpt
        };
      }
    } catch {}

    const [highlighted] = await highlightPapers(question, [withExcerpts]);
    // highlightPapers drops a paper entirely when Claude can't locate a
    // genuinely relevant quote — the right call for search results, but
    // here the student deliberately asked for this exact paper, so it's
    // still returned; lowRelevance just tells the folder UI to flag it
    // rather than silently treating it as a strong match.
    let result = highlighted;
    if (!result) {
      // The highlighter only ever says "no quotable sentence" — it never
      // says WHY. For a paper the student deliberately chose, a bare "not
      // relevant" flag isn't enough to act on, so this asks the same
      // question buildSummarisePrompt already answers for a saved paper
      // (does this actually help with the question, and if not, why not —
      // wrong population, wrong setting, background only, etc.) and keeps
      // that explanation to show alongside the warning.
      let whyNotRelevant = null;
      try {
        const msg = await createMessageWithRetry({
          model: MODEL,
          max_tokens: 200,
          temperature: 0,
          messages: [{ role: "user", content: buildSummarisePrompt(question, withExcerpts.title, withExcerpts.abstract) }]
        });
        whyNotRelevant = msg.content.find(b => b.type === "text")?.text?.trim() || null;
      } catch {}
      result = { ...withExcerpts, highlights: [], suitability: null, lowRelevance: true, whyNotRelevant };
    }

    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Couldn't look up that paper", detail: err.message });
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

For each citation found, provide your best guess at the paper's title, first author's last name, year, and DOI — from the reference list if present, otherwise inferred from context. Leave guessTitle empty if you can't confidently guess it. Leave guessDoi empty unless an actual DOI (or a doi.org link) appears in the reference list entry itself — never guess or invent one.

Also give "sourceKind": "journal_article" if the reference-list entry is clearly a journal article (it names a journal, or has volume/issue/page numbers), "book" for a book or book chapter, "report_or_web" for a report, thesis, website, news item or other grey literature, or "unknown" if there is no reference-list entry to tell.

Text:
"""
${text}
"""

Respond with ONLY a JSON array, nothing else, in this shape:
[{"claim": "exact claim sentence from the text", "citationText": "(Smith, 2020)", "guessTitle": "...", "guessAuthor": "Smith", "guessYear": 2020, "guessDoi": "", "sourceKind": "unknown"}]

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
    const parsed = JSON.parse(clean);
    return (Array.isArray(parsed) ? parsed : []).map(cit => sanitiseExtracted(cit, text));
  } catch (err) {
    // Deliberately not logging the model's output: it contains sentences
    // lifted from the student's essay, which shouldn't end up in server logs.
    console.error(`extractCitationsFromChunk: JSON parse failed (${clean.length} characters of output, not logged)`);
    return [];
  }
}

const SOURCE_KINDS = ["journal_article", "book", "report_or_web", "unknown"];
// A DOI only counts if it genuinely appears in the text the student gave us —
// otherwise a made-up or echoed DOI could get a real citation flagged as fake.
function sanitiseExtracted(cit, text) {
  const out = { ...cit };
  out.sourceKind = SOURCE_KINDS.includes(out.sourceKind) ? out.sourceKind : "unknown";
  const doi = cleanDoi(out.guessDoi);
  out.guessDoi = doi && String(text || "").toLowerCase().includes(doi.toLowerCase()) ? doi : "";
  return out;
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
    const url = `https://api.openalex.org/works/doi:${encodeURIComponent(clean)}?mailto=${encodeURIComponent(CONTACT_EMAIL)}${OPENALEX_API_KEY ? `&api_key=${encodeURIComponent(OPENALEX_API_KEY)}` : ""}`;
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
          paperType: normalizePaperType([w.type], w.title),
          retracted: !!w.is_retracted,
          abstract: reconstructAbstract(w.abstract_inverted_index)
        };
      }
    }
  } catch {}

  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(clean)}?fields=title,abstract,year,venue,authors,openAccessPdf,externalIds,citationCount,publicationTypes`;
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
          paperType: normalizePaperType(p.publicationTypes || [], p.title),
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
    searchCORE(query, { requireOA: false }),
    searchDOAJ(query, { requireOA: false }),
    searchCrossref(query, { requireOA: false }),
    searchERIC(query, { requireOA: false })
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

// ---------- Does the cited source even exist? ----------
// The old check could only say "not found", which lumped together two very
// different situations: a source that doesn't exist, and a real source with
// no abstract in the databases LitMark can read (every search source here
// needs an abstract). Telling those apart is what makes "fabricated" a claim
// LitMark can stand behind — it is only made on evidence, never just because
// something wasn't indexed.

function cleanDoi(raw) {
  if (!raw) return "";
  return String(raw).trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[\s.,;)\]]+$/, "");
}
const pathEncode = s => String(s).split("/").map(encodeURIComponent).join("/");

// Is this DOI registered with the global DOI system (Crossref, DataCite and
// the other registration agencies all resolve through it)? 'yes' | 'no' | 'unknown'.
async function doiRegistration(doi) {
  const d = cleanDoi(doi);
  if (!/^10\.\d{4,9}\/\S+$/.test(d)) return "no";
  try {
    const res = await fetchWithRetry(`https://doi.org/api/handles/${pathEncode(d)}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return "no";
    if (!res.ok) return "unknown";
    const j = await res.json();
    if (j.responseCode === 1) return "yes";
    if (j.responseCode === 100) return "no";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function crossrefItem(it) {
  if (!it) return null;
  const year = it.issued?.["date-parts"]?.[0]?.[0] ?? null;
  const authors = (it.author || []).slice(0, 4).map(a => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean).join(", ");
  return {
    title: (it.title || [])[0] || null,
    year,
    journal: (it["container-title"] || [])[0] || null,
    authors,
    doi: it.DOI || null,
    url: it.DOI ? `https://doi.org/${it.DOI}` : (it.URL || null)
  };
}

// Pure, so it can be tested: is the closest Crossref record the paper the
// student cited? Deliberately cautious — 'found' needs a close title match
// (or a decent one plus a matching year or author), and the grey zone in
// between is 'ambiguous', which is never treated as proof of fabrication.
function judgeCrossrefMatches(items, { title, author, year }) {
  const surname = String(author || "").toLowerCase().replace(/[^a-z\s'-]/g, "").trim().split(/\s+/).pop();
  let best = null, bestSim = 0;
  for (const it of items) {
    const sim = titleSimilarity(title, it.title);
    if (sim > bestSim) { bestSim = sim; best = it; }
  }
  if (!best) return { status: "none" };
  const yearOk = !!(year && best.year && Math.abs(best.year - year) <= 1);
  const authorOk = !!(surname && best.authors && best.authors.toLowerCase().includes(surname));
  if (bestSim >= 0.6 || (bestSim >= 0.45 && (yearOk || authorOk))) return { status: "found", item: best, similarity: bestSim };
  if (bestSim >= 0.3) return { status: "ambiguous", item: best, similarity: bestSim };
  return { status: "none", similarity: bestSim };
}

// Crossref holds a record for nearly every journal article, book and
// conference paper, abstract or not — which is exactly what's needed to tell
// "doesn't exist" from "exists but we can't read it".
async function crossrefLookup({ doi, title, author, year }) {
  const opts = { signal: AbortSignal.timeout(9000) };
  try {
    if (doi) {
      const res = await fetchWithRetry(`https://api.crossref.org/works/${pathEncode(doi)}?mailto=${encodeURIComponent(CONTACT_EMAIL)}`, opts);
      if (res.ok) return { status: "found", item: crossrefItem((await res.json()).message) };
      if (res.status !== 404) return { status: "unknown" };
      // 404 = not a Crossref DOI (it can still be registered elsewhere): fall through to a title search
    }
    if (!title) return { status: "none" };
    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query.bibliographic", [title, author, year].filter(Boolean).join(" "));
    url.searchParams.set("rows", "5");
    url.searchParams.set("select", "DOI,title,author,issued,container-title,type,URL");
    url.searchParams.set("mailto", CONTACT_EMAIL);
    const res = await fetchWithRetry(url, opts);
    if (!res.ok) return { status: "unknown" };
    const items = ((await res.json()).message?.items || []).map(crossrefItem).filter(i => i && i.title);
    return judgeCrossrefMatches(items, { title, author, year });
  } catch {
    return { status: "unknown" };
  }
}

async function fullTextExcerpts(paper) {
  try {
    const pmcid = paper.pmcid || await findPmcMatchByDoi(paper.doi);
    if (!pmcid) return null;
    const ex = await fetchPmcFullText(pmcid);
    return (ex.methodsExcerpt || ex.resultsExcerpt) ? ex : null;
  } catch {
    return null;
  }
}

const searchedDatabases = () => ["OpenAlex", "Semantic Scholar", "Europe PMC", ...(process.env.CORE_API_KEY ? ["CORE"] : []), "Crossref"];
const defaultDeps = () => ({ lookupPaper, doiRegistration, crossrefLookup, verifyCitation, fullTextExcerpts });

// Works out whether the cited source exists, and if so whether there's an
// abstract to check the claim against.
// Matches a citation against a student's own folder before ever reaching
// out to an external database — the folder's papers are already confirmed
// real, with an abstract already fetched, so a match here is both faster
// (no network round trip) and more precise (there's no "which paper did
// the search actually mean" ambiguity). Same scoring convention as
// lookupPaper's own matching below, so the confidence bar is identical
// either way, not looser just because it's a folder.
function matchFolderPaper(c, folderPapers) {
  if (!Array.isArray(folderPapers) || folderPapers.length === 0 || !c.guessTitle) return null;
  let best = null, bestScore = 0;
  for (const p of folderPapers) {
    if (!p || !p.title) continue;
    let score = titleSimilarity(c.guessTitle, p.title);
    if (c.guessYear && Number(p.year) === Number(c.guessYear)) score += 0.15;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (bestScore < 0.35) return null;
  // Normalise to the same shape lookupPaper's results already have, so
  // every downstream step (verifyCitation, fullTextExcerpts, the result
  // fields sent to the frontend) works identically either way.
  return {
    title: best.title, authors: best.authors, year: best.year, journal: best.journal,
    abstract: best.abstract || "", oaUrl: best.url || null, isOA: !!best.isOA,
    paperType: best.paperType || null, retracted: !!best.retracted, citedByCount: null
  };
}

async function resolveCitation(c, deps = defaultDeps(), folderPapers = null) {
  const doi = cleanDoi(c.guessDoi);
  const doiState = doi ? await deps.doiRegistration(doi) : null;

  const folderMatch = matchFolderPaper(c, folderPapers);
  if (folderMatch) return { paper: folderMatch, exists: "yes", doiState, fromFolder: true };

  const paper = await deps.lookupPaper({ ...c, guessDoi: doi }).catch(() => null);
  if (paper) return { paper, exists: "yes", doiState };

  if (doiState === "no") return { paper: null, exists: "no", reason: "doi_unregistered", doiState };
  if (doiState === "yes") {
    const cr = await deps.crossrefLookup({ doi, title: c.guessTitle, author: c.guessAuthor, year: c.guessYear });
    return { paper: null, exists: "yes_no_abstract", meta: cr.item || null, doiState };
  }
  if (!c.guessTitle) return { paper: null, exists: "unknown", reason: "no_details", doiState };

  const cr = await deps.crossrefLookup({ title: c.guessTitle, author: c.guessAuthor, year: c.guessYear });
  if (cr.status === "found") return { paper: null, exists: "yes_no_abstract", meta: cr.item, doiState };
  if (cr.status === "ambiguous") return { paper: null, exists: "unknown", reason: "ambiguous", meta: cr.item, doiState };
  if (cr.status === "none") return { paper: null, exists: "no", reason: "no_record", doiState };
  return { paper: null, exists: "unknown", reason: "service_unavailable", doiState };
}

// "Fabricated" is only ever said when the evidence supports it: a DOI that
// isn't registered anywhere, or a clearly journal-style reference that no
// database — including Crossref — has any record of. A book, report or web
// page that simply isn't indexed is "unable to verify" instead, so a real
// source is never accused of being fake because of a gap in the databases.
function isJournalStyle(c) {
  const words = String(c.guessTitle || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3);
  return c.sourceKind === "journal_article" && words.length >= 3 && !!(c.guessAuthor || c.guessYear);
}

function existenceVerdict(res, c, searched = searchedDatabases()) {
  const list = `${searched.length} scholarly databases (${searched.join(", ")})`;
  switch (res.exists) {
    case "no":
      if (res.reason === "doi_unregistered") {
        return { status: "fabricated", explanation: `The DOI in this reference (${cleanDoi(c.guessDoi)}) isn't registered anywhere, and no paper matching it turned up in ${list}. This source looks made up, or the DOI is wrong.` };
      }
      if (isJournalStyle(c)) {
        return { status: "fabricated", explanation: `No record of this article turned up in ${list}. It may not exist, so check it before relying on it.` };
      }
      return { status: "unable_to_verify", explanation: "We couldn't find this source. It may be a kind that scholarly databases don't cover well (a book, report or web page), so we can't confirm it either way." };
    case "yes_no_abstract":
      return { status: "unable_to_verify", explanation: `This source exists${res.meta?.title ? ` ("${res.meta.title}")` : ""}, but no abstract or full text is available to us, so we couldn't check your claim against it.` };
    default:
      if (res.reason === "no_details") return { status: "unable_to_verify", explanation: "This reference has no title or DOI we could look up, so there was nothing to check the claim against. Add the full reference and check again." };
      if (res.reason === "ambiguous") return { status: "unable_to_verify", explanation: "We found something similar but couldn't be sure it's the same paper, so we didn't check your claim against it." };
      return { status: "check_failed", explanation: "The lookup services didn't respond, so we couldn't check this one. Try again in a moment." };
  }
}

// ---------- Is the claim faithful to the source? ----------
const VERDICTS = ["faithful", "overstated", "misrepresented", "unable_to_verify"];

function buildVerifyPrompt(claim, paper, extra = null) {
  const excerpts = extra
    ? `${extra.methodsExcerpt ? `\nMETHODS EXCERPT (from the full text): "${extra.methodsExcerpt}"` : ""}${extra.resultsExcerpt ? `\nRESULTS EXCERPT (from the full text): "${extra.resultsExcerpt}"` : ""}`
    : "";
  return `An essay makes this claim, attributing it to a source:
CLAIM: "${claim}"

Here is everything LitMark can read of that source:
ABSTRACT: "${paper.abstract}"${excerpts}

Does what's available genuinely support the claim as written? Respond with ONLY JSON, nothing else:
{"status": "faithful" | "overstated" | "misrepresented" | "unable_to_verify", "explanation": "one short plain sentence"}
- faithful: what's available clearly supports the claim as written
- overstated: the source points the same way, but the claim says MORE than it shows: stronger certainty (e.g. the source says "may suggest", the claim says "proves"), causation from a correlation, a wider group or setting than was studied, or a bigger effect than was reported
- misrepresented: the claim says something the source doesn't support, contradicts or reverses, or the source is about a different topic altogether (a real paper that doesn't say this)
- unable_to_verify: the claim depends on a detail that isn't in the text available (a specific figure, method, sample size or passage that only the full paper would show), so it can be neither confirmed nor refuted. Use this ONLY when the available text genuinely lacks the detail. If it clearly supports or contradicts the claim, choose one of the other three.
Judge only from the text above. Do not assume what the rest of the paper says.`;
}

async function verifyCitation(claim, paper, extra = null) {
  if (!paper || !paper.abstract) {
    return { status: "unable_to_verify", explanation: "This source has no abstract or full text available to us, so we couldn't check your claim against it." };
  }
  const msg = await createMessageWithRetry({
    model: MODEL,
    max_tokens: 200,
    temperature: 0, // fidelity judgment — the same claim/abstract pair should get the same verdict every time
    messages: [{ role: "user", content: buildVerifyPrompt(claim, paper, extra) }]
  });
  const raw = msg.content.find(b => b.type === "text")?.text || "{}";
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(clean);
    const status = parsed.status === "unrelated" ? "misrepresented" : parsed.status; // tolerate the old label
    if (!VERDICTS.includes(status)) throw new Error("unexpected status");
    return { status, explanation: parsed.explanation || "" };
  } catch {
    // Found the real source (we have its abstract) but something went wrong
    // producing a verdict this time — a technical hiccup, not a judgment.
    return { status: "check_failed", explanation: "Found the source, but couldn't produce a clear verdict this time. Try again, or check it manually." };
  }
}

// One citation, start to finish. If the abstract alone can't settle the
// claim, and the full text happens to be readable (open-access papers on
// Europe PMC), read that too before giving up — so "unable to verify" means
// the full text really wasn't available to LitMark.
async function checkCitation(c, deps = defaultDeps(), folderPapers = null) {
  const res = await resolveCitation(c, deps, folderPapers);
  if (!res.paper) {
    return { paper: null, meta: res.meta || null, ...existenceVerdict(res, c), checkedAgainst: null, fromFolder: false };
  }
  const paper = res.paper;
  let verdict = await deps.verifyCitation(c.claim, paper);
  let checkedAgainst = res.fromFolder ? "the saved copy in your folder" : "the abstract";
  if (verdict.status === "unable_to_verify") {
    const ex = await deps.fullTextExcerpts(paper);
    if (ex) {
      const second = await deps.verifyCitation(c.claim, paper, ex);
      if (second.status !== "check_failed") {
        verdict = second;
        checkedAgainst = res.fromFolder ? "the saved copy in your folder, and parts of the full text" : "the abstract and parts of the full text";
      }
    }
    if (verdict.status === "unable_to_verify") verdict = { ...verdict, explanation: `${verdict.explanation} Only the abstract was available to read.`.trim() };
  }
  const notes = [];
  if (res.doiState === "no") notes.push("The DOI in your reference list isn't registered, so check it for typos.");
  if (paper.retracted) notes.push("This paper has been retracted, so it shouldn't be relied on as evidence.");
  if (notes.length) verdict = { ...verdict, explanation: `${verdict.explanation} ${notes.join(" ")}`.trim() };
  return { paper, meta: null, ...verdict, checkedAgainst, fromFolder: !!res.fromFolder };
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
async function auditEssayText(essayText, folderPapers = null) {
  const citations = await extractCitations(essayText);
  console.log(`[audit] extracted ${citations.length} citations${folderPapers ? `, matching against ${folderPapers.length} folder source(s) first` : ""}`);

  if (citations.length === 0) {
    return { results: [], warning: "No in-text citations were found in this text." };
  }

  const results = await mapWithConcurrency(citations, 5, async (c) => {
    const checked = await checkCitation(c, undefined, folderPapers).catch(err => {
      console.error("[audit] a citation check failed:", err.message);
      return { paper: null, meta: null, status: "check_failed", explanation: "Something went wrong checking this one. Try again in a moment.", checkedAgainst: null, fromFolder: false };
    });
    const paper = checked.paper, meta = checked.meta;
    console.log(`[audit] guessed "${c.guessTitle || '(no title)'}" (${c.guessAuthor || '?'}, ${c.guessYear || '?'}) -> ${checked.status}${paper ? ` (matched "${paper.title}"${checked.fromFolder ? ", from folder" : ""})` : meta ? ` (record exists: "${meta.title}")` : ""}`);
    return {
      claim: c.claim,
      citationText: c.citationText,
      matchedTitle: paper?.title || meta?.title || null,
      matchedUrl: paper?.oaUrl || meta?.url || null,
      matchedJournal: paper?.journal || meta?.journal || null,
      matchedYear: paper?.year || meta?.year || null,
      matchedAuthors: paper?.authors || meta?.authors || null,
      matchedOA: paper ? !!paper.isOA : null,
      matchedCitedByCount: typeof paper?.citedByCount === "number" ? paper.citedByCount : null,
      matchedType: paper?.paperType || null,
      matchedRetracted: !!paper?.retracted,
      matchedFromFolder: !!checked.fromFolder,
      checkedAgainst: checked.checkedAgainst,
      status: checked.status,
      explanation: checked.explanation
    };
  });

  console.log(`[audit] verified ${results.length} citations`);
  const bibliography = analyzeBibliography(results);
  return { results, bibliography };
}

// The student's own browser sends these straight from a folder already in
// their account, so this is trusted-ish data, not a stranger's input — but
// it's still a request body, so still capped and trimmed rather than
// trusted blindly. Max 200 sources (no real folder gets anywhere close)
// and generous but bounded field lengths.
function sanitizeFolderPapers(raw) {
  if (!Array.isArray(raw)) return null;
  const cleaned = raw.slice(0, 200).map(p => ({
    title: (p?.title || "").toString().slice(0, 500),
    authors: (p?.authors || "").toString().slice(0, 500),
    year: Number.isFinite(Number(p?.year)) ? Number(p.year) : null,
    journal: (p?.journal || "").toString().slice(0, 300),
    abstract: (p?.abstract || "").toString().slice(0, 5000),
    url: (p?.url || "").toString().slice(0, 500),
    isOA: !!p?.isOA,
    paperType: p?.paperType ? p.paperType.toString().slice(0, 100) : null,
    retracted: !!p?.retracted
  })).filter(p => p.title && p.abstract);
  return cleaned.length ? cleaned : null;
}

app.post("/api/audit-essay", requireAuth, rateLimit, async (req, res) => {
  const essayText = (req.body.essay || "").toString().trim();
  if (!essayText) return res.status(400).json({ error: "Missing essay text" });
  if (essayText.length > 100000) return res.status(400).json({ error: "Essay too long — 100,000 characters max (around 15,000 words)" });
  const folderPapers = sanitizeFolderPapers(req.body.folderPapers);

  try {
    res.json(await auditEssayText(essayText, folderPapers));
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

  // Multipart form fields (alongside the uploaded file) arrive as plain
  // strings, not parsed JSON, so this one needs its own parse — with a
  // fallback to "no folder selected" rather than a 400, since a malformed
  // value here shouldn't block the actual essay check the student asked for.
  let folderPapers = null;
  if (req.body.folderPapers) {
    try { folderPapers = sanitizeFolderPapers(JSON.parse(req.body.folderPapers)); } catch { folderPapers = null; }
  }

  try {
    const result = await auditEssayText(essayText, folderPapers);
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
// Both summaries are written FOR the question the student was researching,
// not as a general description of the paper. The prompts require the answer
// to be tied to the question's own wording and to flag when a paper studied
// something different (another population, an animal model, another
// setting) since that limits how far it can be leaned on.
function buildSummarisePrompt(question, title, abstract) {
  const q = String(question || "").trim();
  if (!q) {
    return `A student has saved this paper to their sources:
Title: ${title}
Abstract: ${abstract}

In 1-2 short sentences, in your own words (not quoting the abstract), say what the paper found or argues and what kind of evidence it is. Then add: "(No research question was saved with this paper, so this is a general summary.)"`;
  }
  return `A student is researching this specific question:
"${q}"

They've saved this paper to their sources:
Title: ${title}
Abstract: ${abstract}

In 1-2 short sentences, in your own words (never quoting the abstract), say what this paper gives THEM for THAT question. Tie it directly to the question's own wording: state what the paper found or argues that bears on it, and how — whether it supports, complicates or challenges the question, or only gives background. Be specific to the question's details: if the paper studied a different population, setting, animal model or time frame from the one the question asks about, say so plainly, because that limits how far the student can lean on it. If the paper doesn't actually help answer the question, say that in one plain line rather than describing the paper generally.`;
}

function buildSynthesisPrompt(question, papers) {
  const q = String(question || "").trim();
  const numbered = papers.map((p, i) => `[${i + 1}] ${String(p.title || "").trim()}\n${String(p.abstract || "").trim()}`).join("\n\n");
  return `A student is researching this specific question:
${q ? `"${q}"` : "(no question was saved with this folder)"}

They've saved these ${papers.length} papers to this folder:

${numbered}

Write one short paragraph that ANSWERS THE STUDENT'S QUESTION from these sources taken together — not a description of each paper. ${q ? "Open by stating what the evidence points to for that question (or that these sources can't settle it), using the question's own wording." : "Open by stating the overall picture the sources give."} Then note where the sources agree, where they diverge or add different angles, and any limits that matter for the question (for example sources that studied a different population, an animal model, or a different setting). In your own words, never quoting the abstracts. If the saved papers don't cover the question well as a set, say so plainly and say what's missing. One tight paragraph, not an essay.`;
}

// Deliberately separate from buildSummarisePrompt above: that one is about
// relevance to the student's specific question; this one is about the
// abstract itself being hard to follow, regardless of the question — dense
// field-specific language, unfamiliar terms, jargon. A student can want
// either one, or both, for the same paper.
function buildExplainPrompt(title, abstract) {
  return `A student has saved this paper, but the abstract is written in dense academic language they're finding hard to follow:
Title: ${title}
Abstract: ${abstract}

Explain in plain, everyday English what this paper actually found or argues — as if to someone with no background in this field. Avoid jargon entirely where you can; where a technical term genuinely can't be avoided, briefly say what it means in plain words right there. In your own words, never quoting the abstract directly. 2-4 sentences.`;
}

app.post("/api/summarize-source", requireAuth, rateLimit, async (req, res) => {
  const question = (req.body.question || "").toString().trim();
  const title = (req.body.title || "").toString().trim();
  const abstract = (req.body.abstract || "").toString().trim();
  if (!abstract) return res.status(400).json({ error: "Missing abstract" });

  try {
    const prompt = buildSummarisePrompt(question, title, abstract);

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

app.post("/api/explain-source", requireAuth, rateLimit, async (req, res) => {
  const title = (req.body.title || "").toString().trim();
  const abstract = (req.body.abstract || "").toString().trim();
  if (!abstract) return res.status(400).json({ error: "Missing abstract" });

  try {
    const prompt = buildExplainPrompt(title, abstract);
    const msg = await createMessageWithRetry({
      model: MODEL,
      max_tokens: 300,
      temperature: 0,
      messages: [{ role: "user", content: prompt }]
    });
    const explanation = msg.content.find(b => b.type === "text")?.text?.trim() || "";
    res.json({ explanation });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Explain failed", detail: err.message });
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

  try {
    const prompt = buildSynthesisPrompt(question, withAbstracts);

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
