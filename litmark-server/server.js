// LitMark backend
// Search: queries open-access literature (OpenAlex + Semantic Scholar),
// filters to genuinely open-access papers, then asks Claude to score
// relevance and pull the exact supporting sentence for highlighting.
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
const MODEL = "claude-sonnet-5";
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
  url.searchParams.set("per-page", "15");
  url.searchParams.set("select", [
    "id", "title", "publication_year", "authorships",
    "primary_location", "open_access", "abstract_inverted_index", "doi"
  ].join(","));
  url.searchParams.set("mailto", CONTACT_EMAIL);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  const data = await res.json();

  return data.results.map(w => ({
    source: "OpenAlex",
    id: w.id,
    title: w.title,
    year: w.publication_year,
    journal: w.primary_location?.source?.display_name || "Unknown venue",
    authors: (w.authorships || []).slice(0, 4).map(a => a.author?.display_name).filter(Boolean).join(", "),
    oaUrl: w.open_access?.oa_url || w.primary_location?.pdf_url || null,
    doi: w.doi,
    abstract: reconstructAbstract(w.abstract_inverted_index)
  })).filter(p => p.abstract && p.oaUrl);
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
  url.searchParams.set("limit", "15");
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

function dedupe(papers) {
  const seen = new Set();
  return papers.filter(p => {
    const key = (p.doi || p.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scoreAndHighlight(question, papers) {
  const numbered = papers.map((p, i) => `[${i}] TITLE: ${p.title}\nABSTRACT: ${p.abstract}`).join("\n\n");

  const prompt = `A student is researching this question:
"${question}"

Below are candidate paper abstracts. For each one, judge how relevant it is to the question and pull out the single sentence (or clause) from ITS OWN abstract that most directly supports or bears on a hypothesis related to the question — quoted EXACTLY as it appears in the abstract text, word for word, so it can be located by string match.

Papers:
${numbered}

Also judge the STANCE of the highlighted sentence toward a hypothesis that would answer the question: does it "support" a positive/expected answer, "challenge" it (a null result, a contradicting finding, an important limitation), or is it genuinely "mixed"/context-only.

Respond with ONLY a JSON array, one object per paper index, in this exact shape, and nothing else:
[{"index": 0, "score": 0-100, "highlight": "exact substring from that paper's abstract", "reason": "one sentence on why this paper matters for the question", "stance": "supports" | "challenges" | "mixed"}]

If a paper is not meaningfully relevant, still include it with a low score (below 30) and your best-effort highlight and stance.`;

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3200,
    messages: [{ role: "user", content: prompt }]
  });

  const raw = msg.content.find(b => b.type === "text")?.text || "[]";
  const clean = raw.replace(/```json|```/g, "").trim();
  let scored;
  try {
    scored = JSON.parse(clean);
  } catch {
    scored = [];
  }

  return scored
    .map(s => {
      const paper = papers[s.index];
      if (!paper) return null;
      const found = paper.abstract.includes(s.highlight) ? s.highlight : null;
      const stance = ["supports", "challenges", "mixed"].includes(s.stance) ? s.stance : "mixed";
      return { ...paper, score: s.score, highlight: found, reason: s.reason, stance };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
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

    const [openAlex, semanticScholar] = await Promise.allSettled([
      searchOpenAlex(searchQuery),
      searchSemanticScholar(searchQuery)
    ]);

    const papers = dedupe([
      ...(openAlex.status === "fulfilled" ? openAlex.value : []),
      ...(semanticScholar.status === "fulfilled" ? semanticScholar.value : [])
    ]).slice(0, 24);

    if (papers.length === 0) {
      return res.json({ results: [], warning: "No open-access papers found for this query." });
    }

    const scored = await scoreAndHighlight(question, papers);
    const relevant = scored.filter(p => p.score >= 35);
    const results = (relevant.length ? relevant : scored.slice(0, 3)).slice(0, 15);

    res.json({ results, searchQuery });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Search failed", detail: err.message });
  }
});

// ---------- Critical Analysis: actively sourced for/against columns ----------
// Runs two searches — the normal one, and a second deliberately aimed at
// counter-evidence — pools both, then splits the scored results into two
// genuine columns rather than hoping enough opposing evidence turns up
// in a single ordinary search.
app.get("/api/critical-search", requireAuth, async (req, res) => {
  const question = (req.query.q || "").toString().trim();
  if (!question) return res.status(400).json({ error: "Missing query param: q" });

  try {
    const [supportQuery, counterQuery] = await Promise.all([
      buildSearchQuery(question),
      buildCounterQuery(question)
    ]);

    const fetches = await Promise.allSettled([
      searchOpenAlex(supportQuery),
      searchSemanticScholar(supportQuery),
      searchOpenAlex(counterQuery),
      searchSemanticScholar(counterQuery)
    ]);

    const papers = dedupe(fetches.flatMap(f => f.status === "fulfilled" ? f.value : [])).slice(0, 30);

    if (papers.length === 0) {
      return res.json({ supports: [], challenges: [], warning: "No open-access papers found for this query." });
    }

    const scored = await scoreAndHighlight(question, papers);
    const supports = scored.filter(p => p.stance === "supports" && p.score >= 30)
      .sort((a, b) => b.score - a.score).slice(0, 7);
    const challenges = scored.filter(p => p.stance === "challenges" && p.score >= 30)
      .sort((a, b) => b.score - a.score).slice(0, 7);

    res.json({ supports, challenges, supportQuery, counterQuery });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Critical analysis failed", detail: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3787;
app.listen(port, () => console.log(`LitMark backend running on :${port}`));
