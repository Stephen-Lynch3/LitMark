# LitMark backend

Real, working search over open-access literature. No mock data, no scraping.

## What it actually does

1. Takes a student's question and sends it to two free, legitimate APIs:
   - **OpenAlex** — ~250M works, includes everything PubMed indexes and far
     more, with open-access status and PDF links built in. No API key needed.
   - **Semantic Scholar** — strong abstracts, its own open-access PDF links.
     Works without a key; a free key raises your rate limit.
2. Throws out anything that isn't genuinely open access — no paywalled
   results ever reach the student.
3. Sends the question plus the surviving abstracts to Claude in one batched
   call, asking it to score relevance (0–100) and quote the exact sentence
   from each abstract that bears on the hypothesis — verified by string match
   before it's returned, so the frontend can highlight it safely.
4. Returns the top 8, sorted by score.

**Google Scholar is deliberately not included.** It has no public search API;
anything that queries it does so by scraping, which violates Google's Terms
of Service and can get your server's IP blocked. OpenAlex + Semantic Scholar
give broader open-access coverage than Scholar anyway.

## Setup

```
cd litmark-server
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm start
```

Server runs at `http://localhost:3787`. Test it:

```
curl "http://localhost:3787/api/search?q=does+intermittent+fasting+improve+insulin+sensitivity"
```

Then open `litmark.html`, click the small "⚙ backend" link near the top, and
point it at your server's URL (defaults to `http://localhost:3787`).

## Deploying it for real users

This is a plain Express server, so any Node host works:

- **Render / Railway / Fly.io** — simplest; push the repo, set
  `ANTHROPIC_API_KEY` as an environment variable, done.
- **Vercel / Netlify functions** — works, but you'd restructure `server.js`
  into individual serverless functions (one per route) since those platforms
  don't run a long-lived Express process.

Whichever you pick, update the frontend's backend URL to your deployed
address and serve `litmark.html` from wherever you like (Netlify, Vercel,
S3, GitHub Pages — it's a single static file).

## Known limits, honestly

- **PubMed/PMC direct integration isn't wired in yet.** OpenAlex already
  indexes the vast majority of PubMed's open-access content, so coverage
  loss is small — but if you want PubMed's own subject headings (MeSH terms)
  for more precise biomedical filtering, that's a clean addition: PubMed's
  E-utilities (`esearch.fcgi` / `efetch.fcgi`) for search, cross-referenced
  with Unpaywall's API for OA status by DOI. Ask and I'll build it in.
- **No caching or rate limiting yet.** Fine for testing; add both before
  putting this in front of real traffic, since Claude calls cost money per
  search.
- **No auth or subscription billing.** This is the search engine only — the
  "monthly subscription" part (accounts, Stripe billing, gating access) is a
  separate, well-scoped piece of work. Say the word and I'll build that next.
- I can't run or test this code inside this sandbox (no outbound network
  access here), so treat the first run as a real test — if OpenAlex or
  Semantic Scholar have changed a field name since my training data, the
  error will be visible immediately in the server logs.
