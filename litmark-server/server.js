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
import "dotenv/config";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB max

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// A placeholder key lets the server boot even before Stripe/Resend are
// configured — actual billing calls will fail loudly with a clear error
// (not a server crash) until real keys are set.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_not_configured_yet");
const resend = new Resend(process.env.RESEND_API_KEY || "re_not_configured_yet");

const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "you@example.com";
// Haiku for the bulk/structured work here — extracting a quote and a short
// line of context from an abstract doesn't need Sonnet-level reasoning,
// and Haiku is meaningfully faster, which matters directly for how long
// a search takes.
const MODEL = "claude-haiku-4-5-20251001";
const JWT_SECRET = process.env.JWT_SECRET || "";
const APP_URL = (process.env.APP_URL || "http://localhost:3787").replace(/\/$/, "");
const PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "LitMark <onboarding@resend.dev>";

// ---------- Turn a natural-language question into a search-engine query ----------
async function buildSearchQuery(question) {
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 60,
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
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 60,
    messages: [{
      role: "user",
      content: `A student is researching this question: "${question}"

Write a concise academic database search query (4-8 keywords/phrases, literal keyword matching, not a sentence) specifically aimed at finding papers that would CHALLENGE, CONTRADICT, or COMPLICATE the expected hypothesis — e.g. null results, failed replications, meta-analyses finding no effect, documented limitations or criticisms. Return ONLY the query string, nothing else, no quotes.`
    }]
  });
  const raw = msg.content.find(b => b.type === "text")?.text || question;
  return raw.trim().replace(/^["']|["']$/g, "") || question;
}

// ---------- Source 1: OpenAlex ----------
async function searchOpenAlex(query, { requireOA = true } = {}) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  const filters = ["has_abstract:true"];
  if (requireOA) filters.push("open_access.is_oa:true");
  url.searchParams.set("filter", filters.join(","));
  url.searchParams.set("per-page", "20");
  url.searchParams.set("select", [
    "id", "title", "publication_year", "authorships",
    "primary_location", "open_access", "abstract_inverted_index", "doi"
  ].join(","));
  url.searchParams.set("mailto", CONTACT_EMAIL);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  const data = await res.json();

  return data.results.map(w => {
    const oaLink = w.open_access?.oa_url || w.primary_location?.pdf_url
      || (w.open_access?.is_oa && w.doi ? w.doi : null); // is_oa but no direct link on file — DOI landing page as a fallback rather than dropping it
    return {
      source: "OpenAlex",
      id: w.id,
      title: w.title,
      year: w.publication_year,
      journal: w.primary_location?.source?.display_name || "Unknown venue",
      authors: (w.authorships || []).slice(0, 4).map(a => a.author?.display_name).filter(Boolean).join(", "),
      oaUrl: oaLink,
      isOA: !!w.open_access?.is_oa,
      doi: w.doi,
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
  url.searchParams.set("limit", "20");
  url.searchParams.set("fields", "title,abstract,year,venue,authors,openAccessPdf,externalIds");

  const headers = process.env.SEMANTIC_SCHOLAR_API_KEY
    ? { "x-api-key": process.env.SEMANTIC_SCHOLAR_API_KEY }
    : {};

  const res = await fetch(url, { headers });
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
      oaUrl: p.openAccessPdf?.url || null,
      isOA: !!p.openAccessPdf?.url,
      doi: p.externalIds?.DOI,
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
  url.searchParams.set("pageSize", "20");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Europe PMC ${res.status}`);
  const data = await res.json();
  const results = data.resultList?.result || [];

  return results.map(r => {
    const oaLink =
      (r.fullTextUrlList?.fullTextUrl || []).find(u => (u.availability || "").toLowerCase().includes("open access"))?.url
      || (r.pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${r.pmcid}/` : null)
      || (r.doi ? `https://doi.org/${r.doi}` : null);

    return {
      source: "Europe PMC",
      id: r.id,
      title: r.title,
      year: r.pubYear ? parseInt(r.pubYear) : null,
      journal: r.journalTitle || "Unknown venue",
      authors: (r.authorString || "").split(", ").slice(0, 4).join(", "),
      oaUrl: oaLink,
      isOA: r.isOpenAccess === "Y",
      pmcid: r.pmcid || null,
      doi: r.doi || null,
      abstract: r.abstractText || null
    };
  }).filter(p => p.abstract && (requireOA ? p.oaUrl : true));
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
    const res = await fetch(url);
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
  const terms = [...new Set(queries.flatMap(extractKeyTerms))];
  if (terms.length === 0) return papers;
  return papers.filter(p => {
    const text = (p.abstract || "").toLowerCase();
    return terms.some(t => text.includes(t));
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

  const prompt = `A student is researching this question:
"${question}"

For each paper below, quote the sentence(s) most relevant to this question — quoted EXACTLY as they appear, word for word, so each can be located by an exact string match. Most papers only need ONE quoted highlight, drawn from the ABSTRACT. Only include a second (maximum two) if there's a genuinely distinct additional point — never pad with a weaker second quote just to have more than one. Where a paper also has a METHODS EXCERPT or RESULTS EXCERPT, you may quote from one of those instead of (or in addition to) the abstract if it contains something more specifically relevant than anything in the abstract — but don't force it; most highlights should still come from the abstract, since that's where a paper's own summary of what matters usually lives. Say which section each quote came from. Where a paper is marked ANGLE: support, prefer sentences that support a hypothesis answering the question. Where marked ANGLE: challenge, prefer sentences that challenge, contradict, or complicate it. Where no angle is given, just quote whichever sentence(s) are most relevant.

Judge relevance by substance, not vocabulary. A paper that shares terminology with the question but is actually about a different mechanism, population, or claim is NOT relevant — do not force a highlight just because words match. If a paper doesn't genuinely engage with the substance of the question, OMIT its index from your response entirely rather than quoting a superficial or tangential sentence.

For each highlight, give one short, plain sentence of context on why it matters — not a verdict on relevance, just context to help the reader judge it themselves.

Also give the paper two scores (0-100), your own honest estimate — these are shown to the reader as informational context only, never used to hide or rank results, so give your genuine judgment rather than avoiding extremes:
- "relevance": how relevant this paper is to the student's question overall
- "accuracy": how much the highlighted excerpt(s) can be trusted at face value — factoring in (a) whether this is genuinely the right paper for the topic, not a loose or mismatched result, (b) whether the quoted excerpt(s) genuinely reflect the paper's actual finding rather than being taken out of context, and (c) whether they're faithfully represented rather than overstated or contradicted by the rest of the paper

Papers:
${numbered}

Respond with ONLY a JSON array, one object per paper index, in this exact shape, and nothing else — "section" must be exactly one of "abstract", "methods", or "results":
[{"index": 0, "highlights": [{"text": "exact substring from that section", "reason": "one short sentence of context", "section": "abstract"}], "relevance": 0-100, "accuracy": 0-100}]`;

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3600,
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
        : (s.highlight ? [{ text: s.highlight, reason: s.reason, section: "abstract" }] : []);
      // A highlight is only kept if its quoted text is genuinely locatable
      // in the section it claims to be from — this is what stops a
      // fabricated or misattributed quote from ever reaching the reader.
      const sourceTextFor = section =>
        section === "methods" ? paper.methodsExcerpt
        : section === "results" ? paper.resultsExcerpt
        : paper.abstract;
      const highlights = rawHighlights
        .map(h => ({
          text: h?.text,
          reason: typeof h?.reason === "string" ? h.reason : "",
          section: ["abstract", "methods", "results"].includes(h?.section) ? h.section : "abstract"
        }))
        .filter(h => h.text && sourceTextFor(h.section) && sourceTextFor(h.section).includes(h.text))
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

function signSessionToken(email, customerId) {
  return jwt.sign({ email, customerId, purpose: "session" }, JWT_SECRET, { expiresIn: "30d" });
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

// ---------- Start a subscription ----------
app.post("/api/checkout", async (req, res) => {
  const email = (req.body.email || "").toString().trim().toLowerCase();
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });
  if (!PRICE_ID) return res.status(500).json({ error: "Server not configured: missing STRIPE_PRICE_ID" });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
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
app.get("/api/search", requireAuth, async (req, res) => {
  const question = (req.query.q || "").toString().trim();
  if (!question) return res.status(400).json({ error: "Missing query param: q" });

  try {
    const searchQuery = await buildSearchQuery(question);

    // Two nets, not one: the distilled keyword query catches precise
    // matches, but a narrowed query can miss papers a broader phrasing
    // would find — especially for open, exploratory questions ("uses of
    // X") rather than a specific claim. Searching the raw question too
    // and merging both pools substantially widens coverage.
    const fetches = await Promise.allSettled([
      searchOpenAlex(searchQuery),
      searchSemanticScholar(searchQuery),
      searchOpenAlex(question),
      searchSemanticScholar(question),
      searchEuropePMC(searchQuery),
      searchEuropePMC(question)
    ]);
    const labels = ["OpenAlex(query)", "SemanticScholar(query)", "OpenAlex(raw)", "SemanticScholar(raw)", "EuropePMC(query)", "EuropePMC(raw)"];
    fetches.forEach((f, i) => {
      if (f.status === "rejected") console.error(`${labels[i]} failed:`, f.reason?.message || f.reason);
    });

    const allFound = dedupe(fetches.flatMap(f => f.status === "fulfilled" ? f.value : []));
    const papers = requireTermMatch(allFound, [searchQuery, question]).slice(0, 36);

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
    // Throttled to 4 at a time (not all-at-once) — firing dozens of
    // simultaneous requests at Europe PMC in one burst was found to trip
    // its rate limiting, which broke Europe PMC results entirely for that
    // search. A paper that already came from Europe PMC's own search
    // already carries its pmcid, so it skips the extra DOI lookup — only
    // OpenAlex/Semantic-Scholar-only papers need it.
    const withFullText = await mapWithConcurrency(papers, 4, async (p) => {
      try {
        const pmcid = p.pmcid || await findPmcMatchByDoi(p.doi);
        if (!pmcid) return p;
        const ft = await fetchPmcFullText(pmcid);
        return {
          ...p, hasFullText: true,
          pmcUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
          methodsExcerpt: ft.methodsExcerpt, resultsExcerpt: ft.resultsExcerpt
        };
      } catch {
        return p;
      }
    });
    console.log(`[search] full text available for ${withFullText.filter(p => p.hasFullText).length}/${withFullText.length} candidates`);

    const highlighted = await highlightPapers(question, withFullText);
    console.log(`[search] highlightPapers: ${withFullText.length} in -> ${highlighted.length} out`);
    // Highest suitability first. Sorting (unlike the old filtering-by-score
    // approach) never drops a paper — it only changes order — so it doesn't
    // carry the failure mode that got scoring removed once already.
    const sorted = [...highlighted].sort((a, b) => (b.suitability ?? -1) - (a.suitability ?? -1));
    const results = sorted.slice(0, 20);

    res.json({ results, searchQuery });
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
app.get("/api/critical-search", requireAuth, async (req, res) => {
  const question = (req.query.q || "").toString().trim();
  if (!question) return res.status(400).json({ error: "Missing query param: q" });

  try {
    const [supportQuery, counterQuery] = await Promise.all([
      buildSearchQuery(question),
      buildCounterQuery(question)
    ]);

    const [supportFetches, counterFetches] = await Promise.all([
      Promise.allSettled([searchOpenAlex(supportQuery), searchSemanticScholar(supportQuery), searchEuropePMC(supportQuery)]),
      Promise.allSettled([searchOpenAlex(counterQuery), searchSemanticScholar(counterQuery), searchEuropePMC(counterQuery)])
    ]);
    const labels = ["OpenAlex(support)", "SemanticScholar(support)", "EuropePMC(support)", "OpenAlex(counter)", "SemanticScholar(counter)", "EuropePMC(counter)"];
    [...supportFetches, ...counterFetches].forEach((f, i) => {
      if (f.status === "rejected") console.error(`${labels[i]} failed:`, f.reason?.message || f.reason);
    });

    // support-first, so a paper found by both searches defaults to the
    // "support" column rather than appearing twice or being dropped
    const supportPapers = requireTermMatch(
      supportFetches.flatMap(f => f.status === "fulfilled" ? f.value : []), [supportQuery]
    ).map(p => ({ ...p, angle: "support" }));
    const counterPapers = requireTermMatch(
      counterFetches.flatMap(f => f.status === "fulfilled" ? f.value : []), [counterQuery]
    ).map(p => ({ ...p, angle: "challenge" }));
    const papers = dedupe([...supportPapers, ...counterPapers]).slice(0, 30);

    console.log(`[critical] "${question}" -> support "${supportQuery}" (${supportPapers.length}) / counter "${counterQuery}" (${counterPapers.length}) -> ${papers.length} after dedupe`);

    if (papers.length === 0) {
      return res.json({ supports: [], challenges: [], warning: "No open-access papers found for this query." });
    }

    const withFullText = await mapWithConcurrency(papers, 4, async (p) => {
      try {
        const pmcid = p.pmcid || await findPmcMatchByDoi(p.doi);
        if (!pmcid) return p;
        const ft = await fetchPmcFullText(pmcid);
        return {
          ...p, hasFullText: true,
          pmcUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
          methodsExcerpt: ft.methodsExcerpt, resultsExcerpt: ft.resultsExcerpt
        };
      } catch {
        return p;
      }
    });

    const highlighted = await highlightPapers(question, withFullText);
    console.log(`[critical] highlightPapers: ${withFullText.length} in -> ${highlighted.length} out`);
    const bySuitability = (a, b) => (b.suitability ?? -1) - (a.suitability ?? -1);
    const supports = highlighted.filter(p => p.angle === "support").sort(bySuitability).slice(0, 7);
    const challenges = highlighted.filter(p => p.angle === "challenge").sort(bySuitability).slice(0, 7);

    res.json({ supports, challenges, supportQuery, counterQuery });
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
  const prompt = `Below is an excerpt from a student's essay (it may be a section of a longer document, with the full reference list included at the end if one exists). Find every in-text citation (e.g. "(Smith, 2020)", "(Smith et al., 2020)", numbered markers like "[3]", footnotes) and the specific claim or sentence it's attached to. If a reference list/bibliography appears, use it to identify the full title, first author, and year for each citation.

For each citation found, provide your best guess at the paper's title, first author's last name, and year — from the reference list if present, otherwise inferred from context. Leave guessTitle empty if you can't confidently guess it.

Text:
"""
${text}
"""

Respond with ONLY a JSON array, nothing else, in this shape:
[{"claim": "exact claim sentence from the text", "citationText": "(Smith, 2020)", "guessTitle": "...", "guessAuthor": "Smith", "guessYear": 2020}]

Only extract citations that actually appear in this excerpt's own body text — ignore reference-list entries that aren't cited here.`;

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3000,
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

async function lookupPaper({ guessTitle, guessAuthor, guessYear }) {
  const query = [guessTitle, guessAuthor, guessYear].filter(Boolean).join(" ").trim();
  if (!query) return null;

  const results = await Promise.allSettled([
    searchOpenAlex(query, { requireOA: false }),
    searchSemanticScholar(query, { requireOA: false }),
    searchEuropePMC(query, { requireOA: false })
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

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 200,
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
      ...verdict
    };
  });

  console.log(`[audit] verified ${results.length} citations`);
  const bibliography = analyzeBibliography(results);
  return { results, bibliography };
}

app.post("/api/audit-essay", requireAuth, async (req, res) => {
  const essayText = (req.body.essay || "").toString().trim();
  if (!essayText) return res.status(400).json({ error: "Missing essay text" });
  if (essayText.length > 100000) return res.status(400).json({ error: "Essay too long — 100,000 characters max (around 15,000 words)" });

  try {
    res.json(await auditEssayText(essayText));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Citation audit failed", detail: err.message });
  }
});

// ---------- Citation Audit: file upload (.docx / .txt) ----------
// Accepts a Word doc or plain text file instead of pasted text. Extraction
// is the one genuinely new failure mode here — .docx is a zipped bundle of
// XML under the hood, handled by the well-established `mammoth` library
// rather than anything hand-rolled.
app.post("/api/audit-essay/upload", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const name = (req.file.originalname || "").toLowerCase();

  let essayText;
  try {
    if (name.endsWith(".docx")) {
      const { value } = await mammoth.extractRawText({ buffer: req.file.buffer });
      essayText = value;
    } else if (name.endsWith(".txt")) {
      essayText = req.file.buffer.toString("utf-8");
    } else {
      return res.status(400).json({ error: "Unsupported file type — please upload a .docx or .txt file" });
    }
  } catch (err) {
    console.error("File extraction failed:", err.message);
    return res.status(400).json({ error: "Couldn't read that file — it may be corrupted, password-protected, or an older .doc format (only .docx is supported)" });
  }

  essayText = (essayText || "").trim();
  if (!essayText) return res.status(400).json({ error: "That file appears to be empty" });
  if (essayText.length > 100000) return res.status(400).json({ error: "That essay is too long — 100,000 characters max (around 15,000 words)" });

  try {
    const result = await auditEssayText(essayText);
    res.json({ ...result, extractedLength: essayText.length });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Citation audit failed", detail: err.message });
  }
});

// ---------- Search Lexicon ----------
// Not a paper search — this generates ONE ready-to-paste PubMed Boolean
// query, plus a breakdown of the concepts it's built from. Claude only
// ever returns plain terms (simple, robust JSON) — the actual Boolean
// query string, with its nested quote marks and field tags, is built
// mechanically by this code, not generated as a single fragile JSON
// string value (which failed on more complex questions in practice).
async function generateLexicon(question) {
  const prompt = `A student wants to search PubMed for literature on this research question:
"${question}"

Break this down into the distinct CONCEPTS a good PubMed search needs (usually 2-4), and for each concept, list the alternative search terms that mean the same thing or are genuinely interchangeable for search purposes — the terms within one concept will be combined with OR, so only group things that are truly alternative ways of saying the same thing.

For each concept, include, where genuinely useful for this specific question:
- synonyms
- alternative spellings
- abbreviations and acronyms
- singular/plural variants
- gene/protein aliases
- closely related biological terminology (e.g. ortholog/orthologue, homolog/homologue) — only when it actually fits

Do NOT blindly treat merely related concepts as synonyms of each other — a concept's terms must be genuinely interchangeable, not just topically related.

Respond with ONLY JSON in this exact shape, nothing else — plain terms only, no quote marks or search syntax inside the strings themselves:
{"concepts": [{"name": "Concept name", "terms": ["term1", "term2", "term3"]}]}`;

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
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
  const query = concepts
    .map(c => "(" + c.terms.map(t => t.includes(" ") ? `"${t}"[tiab]` : `${t}[tiab]`).join(" OR ") + ")")
    .join(" AND ");

  return { query, concepts };
}

app.get("/api/lexicon", requireAuth, async (req, res) => {
  const question = (req.query.q || "").toString().trim();
  if (!question) return res.status(400).json({ error: "Missing query param: q" });

  try {
    const result = await generateLexicon(question);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Lexicon generation failed", detail: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3787;
app.listen(port, () => console.log(`LitMark backend running on :${port}`));
