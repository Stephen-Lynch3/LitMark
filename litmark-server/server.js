// LitMark backend
// Searches open-access literature (OpenAlex + Semantic Scholar), filters to
// papers with a real open-access PDF, then asks Claude to score each one's
// relevance to the student's question and pull the exact sentence that
// supports (or undermines) it, for highlighting in the UI.
//
// Run:  npm install && cp .env.example .env  (fill in ANTHROPIC_API_KEY)  && npm start
// Requires Node 18+ (native fetch).

import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

const app = express();
// Lock the API to your own frontend in production. Falls back to "allow
// everything" only if ALLOWED_ORIGIN isn't set, so local dev still works.
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "you@example.com"; // OpenAlex asks for this in the "polite pool" header — raises your rate limit, costs nothing
const MODEL = "claude-sonnet-5";

// ---------- Source 1: OpenAlex ----------
// Docs: https://docs.openalex.org/api-entities/works/search-works
async function searchOpenAlex(query) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("filter", "open_access.is_oa:true,has_abstract:true");
  url.searchParams.set("per-page", "12");
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

// OpenAlex stores abstracts as {word: [positions]} to respect publisher
// copyright on full-text reproduction — rebuild the plain-text version.
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
// Docs: https://api.semanticscholar.org/api-docs/graph
async function searchSemanticScholar(query) {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "12");
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

// ---------- Dedupe by DOI / near-identical title ----------
function dedupe(papers) {
  const seen = new Set();
  return papers.filter(p => {
    const key = (p.doi || p.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- Score + highlight with Claude ----------
// One batched call: cheaper and faster than one call per paper, and lets
// Claude weigh papers against each other when scoring.
async function scoreAndHighlight(question, papers) {
  const numbered = papers.map((p, i) => `[${i}] TITLE: ${p.title}\nABSTRACT: ${p.abstract}`).join("\n\n");

  const prompt = `A student is researching this question:
"${question}"

Below are candidate paper abstracts. For each one, judge how relevant it is to the question and pull out the single sentence (or clause) from ITS OWN abstract that most directly supports or bears on a hypothesis related to the question — quoted EXACTLY as it appears in the abstract text, word for word, so it can be located by string match.

Papers:
${numbered}

Respond with ONLY a JSON array, one object per paper index, in this exact shape, and nothing else:
[{"index": 0, "score": 0-100, "highlight": "exact substring from that paper's abstract", "reason": "one sentence on why this paper matters for the question"}]

If a paper is not meaningfully relevant, still include it with a low score (below 30) and your best-effort highlight.`;

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
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
      // Confirm the quoted highlight actually occurs in the abstract; if the
      // model paraphrased instead of quoting, fall back to the full abstract
      // (frontend just won't highlight a sub-span in that case).
      const found = paper.abstract.includes(s.highlight) ? s.highlight : null;
      return { ...paper, score: s.score, highlight: found, reason: s.reason };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

// ---------- Route ----------
app.get("/api/search", async (req, res) => {
  const question = (req.query.q || "").toString().trim();
  if (!question) return res.status(400).json({ error: "Missing query param: q" });

  try {
    const [openAlex, semanticScholar] = await Promise.allSettled([
      searchOpenAlex(question),
      searchSemanticScholar(question)
    ]);

    const papers = dedupe([
      ...(openAlex.status === "fulfilled" ? openAlex.value : []),
      ...(semanticScholar.status === "fulfilled" ? semanticScholar.value : [])
    ]).slice(0, 16); // cap what we send to Claude, for cost/latency

    if (papers.length === 0) {
      return res.json({ results: [], warning: "No open-access papers found for this query." });
    }

    const scored = await scoreAndHighlight(question, papers);
    res.json({ results: scored.slice(0, 8) });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Search failed", detail: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3787;
app.listen(port, () => console.log(`LitMark backend running on :${port}`));
