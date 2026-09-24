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
import "dotenv/config";

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
async function searchOpenAlex(query) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("filter", "open_access.is_oa:true,has_abstract:true");
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
      doi: w.doi,
      abstract: reconstructAbstract(w.abstract_inverted_index)
    };
  }).filter(p => p.abstract && p.oaUrl);
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
async function searchSemanticScholar(query) {
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
    .filter(p => p.openAccessPdf?.url && p.abstract)
    .map(p => ({
      source: "Semantic Scholar",
      id: p.externalIds?.DOI || p.paperId,
      title: p.title,
      year: p.year,
      journal: p.venue || "Unknown venue",
      authors: (p.authors || []).slice(0, 4).map(a => a.name).join(", "),
      oaUrl: p.openAccessPdf.url,
      doi: p.externalIds?.DOI,
      abstract: p.abstract
    }));
}

// ---------- Source 3: Europe PMC ----------
// Covers the same PMC/PubMed open-access content as NCBI's own interface,
// plus preprints (bioRxiv, medRxiv) — broader net, and a single clean JSON
// call instead of NCBI's two-step XML dance. No API key needed at all.
async function searchEuropePMC(query) {
  const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  url.searchParams.set("query", `(${query}) AND (OPEN_ACCESS:Y)`);
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
      doi: r.doi || null,
      abstract: r.abstractText || null
    };
  }).filter(p => p.abstract && p.oaUrl);
}

// ---------- Hard relevance gate: the search term must actually appear ----------
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
  const numbered = papers.map((p, i) =>
    `[${i}]${p.angle ? ' ANGLE: ' + p.angle : ''}\nTITLE: ${p.title}\nABSTRACT: ${p.abstract}`
  ).join("\n\n");

  const prompt = `A student is researching this question:
"${question}"

For each paper below, quote the single sentence (or clause) from ITS OWN abstract that is most relevant to this question — quoted EXACTLY as it appears, word for word, so it can be located by an exact string match. Where a paper is marked ANGLE: support, prefer a sentence that supports a hypothesis answering the question. Where marked ANGLE: challenge, prefer a sentence that challenges, contradicts, or complicates it. Where no angle is given, just quote whichever sentence is most relevant.

Judge relevance by substance, not vocabulary. A paper that shares terminology with the question but is actually about a different mechanism, population, or claim is NOT relevant — do not force a highlight just because words match. If a paper doesn't genuinely engage with the substance of the question, OMIT its index from your response entirely rather than quoting a superficial or tangential sentence.

Also give one short, plain sentence of context on why that sentence matters — not a verdict on relevance, just context to help the reader judge it themselves.

Papers:
${numbered}

Respond with ONLY a JSON array, one object per paper index, in this exact shape, and nothing else:
[{"index": 0, "highlight": "exact substring from that paper's abstract", "reason": "one short sentence of context"}]`;

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3000,
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
  // AI re-ranking.
  const byIndex = new Map(parsed.map(s => [s.index, s]));
  return papers
    .map((paper, i) => {
      const s = byIndex.get(i);
      if (!s) return null;
      const found = s.highlight && paper.abstract.includes(s.highlight) ? s.highlight : null;
      return { ...paper, highlight: found, reason: s.reason };
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

// Require a valid session token AND a currently-active subscription.
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
    const active = await hasActiveSubscription(decoded.customerId);
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

// ---------- Request a login link (existing subscribers) ----------
app.post("/api/login", async (req, res) => {
  const email = (req.body.email || "").toString().trim().toLowerCase();
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });

  try {
    const customers = await stripe.customers.list({ email, limit: 5 });
    let target = null;
    for (const c of customers.data) {
      if (await hasActiveSubscription(c.id)) { target = c; break; }
    }

    // Always respond the same way whether or not we found a subscriber —
    // don't let this endpoint reveal who is or isn't a customer.
    if (target) {
      const magicToken = signMagicToken(email, target.id);
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

    const highlighted = await highlightPapers(question, papers);
    console.log(`[search] highlightPapers: ${papers.length} in -> ${highlighted.length} out`);
    const results = highlighted.slice(0, 15);

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

    const highlighted = await highlightPapers(question, papers);
    console.log(`[critical] highlightPapers: ${papers.length} in -> ${highlighted.length} out`);
    const supports = highlighted.filter(p => p.angle === "support").slice(0, 7);
    const challenges = highlighted.filter(p => p.angle === "challenge").slice(0, 7);

    res.json({ supports, challenges, supportQuery, counterQuery });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Critical analysis failed", detail: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3787;
app.listen(port, () => console.log(`LitMark backend running on :${port}`));
