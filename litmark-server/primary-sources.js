// UK legislation for a student's question, shown above the papers.
//
// "Is the Equality Act's definition of disability too narrow?" needs the wording
// of section 6, not a paper about it, and the usual way students get that
// wording (a chatbot) paraphrases it or invents it. This fetches the provision
// from legislation.gov.uk and hands it back word for word, with a ready citation.
//
// The rule that matters, same as the Official data card: the AI only chooses
// WHICH provision to fetch (an Act and a section). The wording always comes
// from legislation.gov.uk's own response, never from the model. And because a
// model can misremember an Act's number, the page that comes back must say it
// is the Act the model named, or nothing is shown. If anything is unsure (not
// a UK law question, a low-confidence pick, a title that does not match, a
// repealed section, the service down or slow) this returns null and the search
// carries on as if it were not here.
//
// Licence: Open Government Licence v3.0. Attribution wording below is the one
// legislation.gov.uk suggests. Fair use limit: 3,000 requests per 5 minutes per
// IP, and a user agent is required.
//
// Case law (National Archives "Find Case Law") is deliberately NOT here: its
// licence does not allow computational analysis, which includes AI-based
// services, without a free licence application.
//
// Everything outside the network and the model is plain functions, so it can be
// tested without either: `fetchFn` and `askModel` are passed in.

export const LEG_BASE = "https://www.legislation.gov.uk";
const MIN_CONFIDENCE = 75;
const MAX_PROVISIONS = 2;
const MAX_CHARS = 2600; // per provision; longer ones are cut at a paragraph and linked

export const ATTRIBUTION = "© Crown and database right. Derived from content available under the Open Government Licence v3.0 from legislation.gov.uk.";

// ---------- Is this a question about the law at all? ----------
// A cheap check before anything else, so most searches never pay for a model
// call. Deliberately generous: the model, told to be strict, has the final say.
const LAW = /\b(law|laws|legal|legally|legislation|legislative|statute|statutes|statutory|act|acts|regulations?|bill|offen[cs]es?|crimes?|criminal|criminali[sz]\w*|liab\w+|tort|negligen\w+|contracts?|discriminat\w+|equality|human rights?|tenants?|landlords?|dismissal|redundancy|data protection|gdpr|copyright|patents?|trespass|unlawful|illegal|legali[sz]\w*|decriminali[sz]\w*|parliament\w*|constitution\w*|devolution|immigration|asylum|police|policing|sentenc\w+|bail|juries|jury|tribunals?|courts?|prosecut\w+|rights of|right to|duty of|duties|powers? of|abortion|euthanasia|assisted dying|surrogacy|marriage|divorce|inheritance|wills?|trusts?|mental capacity|safeguarding|consent|harassment|stalking|terroris\w+|surveillance|privacy|defamation|libel|freedom of (speech|expression|information)|minimum wage|zero.hours|whistleblow\w*|health and safety|planning permission|compulsory purchase|stop and search)\b/i;

// The AI is told to answer null for another country's law, but a question that
// plainly names another country never needs the call.
const ELSEWHERE = /\b(us|u\.s\.|usa|america\w*|canad\w+|australia\w*|india\w*|china|chinese|german\w*|france|french|spain|spanish|italy|italian|new zealand|south africa\w*|nigeria\w*|eu law|european union law|republic of ireland)\b/i;

export const mentionsUK = (q) => /\b(uk|u\.k\.|united kingdom|britain|british|great britain|england|english|scotland|scottish|wales|welsh|northern ireland|nhs)\b/i.test(String(q || ""));

export function wantsLaw(question) {
  const q = String(question || "");
  if (q.trim().split(/\s+/).filter(Boolean).length < 3) return false;
  if (ELSEWHERE.test(q) && !mentionsUK(q)) return false;
  return LAW.test(q);
}

// ---------- Which kinds of legislation, and how they are cited ----------
// type -> [what it is called, how the chapter/number reads, which provision words it uses]
const TYPES = {
  ukpga: { name: "UK Public General Act", jurisdiction: "UK", chapter: (y, n) => `${y} c ${n}`, short: (y, n) => `c. ${n}`, words: ["section", "schedule"] },
  asp: { name: "Act of the Scottish Parliament", jurisdiction: "Scotland", chapter: (y, n) => `${y} asp ${n}`, short: (y, n) => `asp ${n}`, words: ["section", "schedule"] },
  asc: { name: "Act of Senedd Cymru", jurisdiction: "Wales", chapter: (y, n) => `${y} asc ${n}`, short: (y, n) => `asc ${n}`, words: ["section", "schedule"] },
  anaw: { name: "Act of the National Assembly for Wales", jurisdiction: "Wales", chapter: (y, n) => `${y} anaw ${n}`, short: (y, n) => `anaw ${n}`, words: ["section", "schedule"] },
  nia: { name: "Act of the Northern Ireland Assembly", jurisdiction: "Northern Ireland", chapter: (y, n) => `${y} c ${n}`, short: (y, n) => `c. ${n}`, words: ["section", "schedule"] },
  uksi: { name: "UK Statutory Instrument", jurisdiction: "UK", chapter: (y, n) => `SI ${y}/${n}`, short: (y, n) => `SI ${y}/${n}`, words: ["regulation", "article", "rule", "schedule"] },
  ssi: { name: "Scottish Statutory Instrument", jurisdiction: "Scotland", chapter: (y, n) => `SSI ${y}/${n}`, short: (y, n) => `SSI ${y}/${n}`, words: ["regulation", "article", "rule", "schedule"] }
};

const PROVISION = /^(section|regulation|article|rule|schedule)\/(\d{1,3}[A-Z]{0,3})$/;

// A provision word like "regulation" short-form for OSCOLA: s, reg, art, r, sch.
const SHORT = { section: "s", regulation: "reg", article: "art", rule: "r", schedule: "sch" };

export function validateReference(ref) {
  if (!ref || typeof ref !== "object") return null;
  const type = String(ref.type || "").toLowerCase().trim();
  const info = TYPES[type];
  if (!info) return null;
  const year = Number(ref.year);
  const number = Number(ref.number);
  if (!Number.isInteger(year) || year < 1800 || year > 2100) return null;
  if (!Number.isInteger(number) || number < 1 || number > 9999) return null;
  const m = PROVISION.exec(String(ref.provision || "").trim());
  if (!m) return null;
  if (!info.words.includes(m[1])) return null;
  const title = String(ref.title || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (title.length < 6) return null;
  return { type, year, number, kind: m[1], ref: m[2], provision: `${m[1]}/${m[2]}`, title };
}

export const provisionPath = (r) => `/${r.type}/${r.year}/${r.number}/${r.provision}`;

// ---------- Asking the model to choose ----------
export function buildChoicePrompt(question) {
  return `A student is writing an essay on this question:
"${String(question).slice(0, 500)}"

If the question turns on what a specific UK statute or statutory instrument says, name the provision(s) the student would most likely need to quote: the one that creates, defines or limits the main right, duty, power or offence at issue. At most ${MAX_PROVISIONS}.

Rules:
- UK legislation only (Westminster, Scotland, Wales, Northern Ireland). If the question is about another country's law, or is not really about what a law says (for example a question about attitudes, effects or opinions), answer with an empty list.
- Name only a provision you are certain exists, with the Act's exact title, type, year and chapter/number. A wrong number is worse than none: leave it out if you are not sure.
- type is one of: ukpga (UK Public General Act), asp (Scottish Act), asc (Welsh Act, Senedd Cymru), anaw (Welsh Act before 2020), nia (Northern Ireland Act), uksi (UK statutory instrument), ssi (Scottish statutory instrument).
- provision is "section/6", "regulation/4", "article/3", "rule/2" or "schedule/1": one provision, never a range, and the number only (for example section/6, section/20A).
- Do not quote or paraphrase the law. Only name it.

Respond with ONLY JSON in this exact shape, nothing else:
{"provisions": [{"title": "Equality Act 2010", "type": "ukpga", "year": 2010, "number": 15, "provision": "section/6", "confidence": 0-100}], "caveat": ""}

"caveat" is one plain sentence with no quotation of the law, for example that the law differs in Scotland, or "" if there is nothing to flag.`;
}

export function parseChoice(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || "").replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const list = Array.isArray(parsed.provisions) ? parsed.provisions : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const confidence = Number(item?.confidence);
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) continue;
    const ref = validateReference(item);
    if (!ref) continue;
    const key = provisionPath(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...ref, confidence });
    if (out.length >= MAX_PROVISIONS) break;
  }
  let caveat = typeof parsed.caveat === "string" ? parsed.caveat.replace(/[<>"“”]/g, "").replace(/\s+/g, " ").trim().slice(0, 220) : "";
  // The caveat is the model's own words, so it never carries a quotation of the
  // law or a figure; only a short flag.
  if (/\d+(\.\d+)?\s?%|\d{3,}|\d+\.\d+/.test(caveat)) caveat = "";
  return { provisions: out, caveat, answered: true };
}

// ---------- Reading legislation.gov.uk's XML (CLML) ----------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", pound: "£", sect: "§" };
function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10), m))
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] !== undefined ? ENTITIES[n.toLowerCase()] : m));
}
function safeChar(code, fallback) {
  try {
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : fallback;
  } catch {
    return fallback;
  }
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decode(m[2] ?? m[3] ?? "") : "";
};

const clean = (s) => decode(s).replace(/\s+/g, " ").trim();

// The facts on the page that say which document this is.
export function parseMetadata(xml) {
  const s = String(xml || "");
  const title = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(s);
  const year = /<ukm:Year\s[^>]*Value\s*=\s*"(\d{4})"/.exec(s);
  const number = /<ukm:Number\s[^>]*Value\s*=\s*"(\d+)"/.exec(s);
  const docType = /<ukm:DocumentMainType\s[^>]*Value\s*=\s*"([A-Za-z]+)"/.exec(s);
  const uri = /<Legislation\b[^>]*\sDocumentURI\s*=\s*"([^"]*)"/.exec(s);
  return {
    title: title ? clean(title[1]) : "",
    year: year ? Number(year[1]) : null,
    number: number ? Number(number[1]) : null,
    docType: docType ? docType[1] : "",
    documentUri: uri ? uri[1] : ""
  };
}

const normTitle = (t) => String(t || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/^the /, "").trim();

// The page must be the Act the model named. A model can misremember a number,
// and a wrong number would otherwise quote the wrong law under the right name.
export function titleMatches(modelTitle, pageTitle) {
  const a = normTitle(modelTitle);
  const b = normTitle(pageTitle);
  return !!a && !!b && a === b;
}

const EXTENT = { E: "England", W: "Wales", S: "Scotland", "N.I.": "Northern Ireland", NI: "Northern Ireland" };
export function extentText(code) {
  const parts = String(code || "").split("+").map(x => x.trim()).filter(Boolean);
  const names = [...new Set(parts.map(p => EXTENT[p]).filter(Boolean))];
  if (!names.length || names.length !== parts.length) return "";
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

// Block-level elements that start a new paragraph in the text. P1 is the
// section, P2 its subsections (1), (2), P3 their paragraphs (a), (b) and so on.
const LEVEL = { P1: 0, P2: 0, P3: 1, P4: 2, P5: 3, P6: 4, P7: 5 };

// -> { heading, number, paragraphs: [{ level, text }], extent, repealed } | null
export function parseProvisionBody(xml) {
  const s = String(xml || "");
  const start = s.search(/<(Primary|Secondary)\b/);
  if (start < 0) return null;
  let body = s.slice(start);
  const end = body.search(/<\/(Primary|Secondary)>/);
  if (end >= 0) body = body.slice(0, end);

  const repealed = /<P1\b[^>]*\sStatus\s*=\s*"Repealed"/.test(body) || /<P1group\b[^>]*\sStatus\s*=\s*"Repealed"/.test(body);
  const extent = extentText((/\sRestrictExtent\s*=\s*"([^"]*)"/.exec(body) || [])[1] || "");

  const lines = []; // { level, text }
  let line = null;
  let level = 0;
  let heading = "";
  let number = "";
  let inTitle = false;
  let titleBuf = "";
  let skipTitle = false;
  let pnum = null; // { before, after, text }
  let sawHeading = false;
  let justNumbered = false; // a number was just written, so the text that follows stays on its line

  const flush = () => {
    if (line && line.text.replace(/\s+/g, " ").trim()) lines.push({ level: line.level, text: line.text.replace(/\s+/g, " ").trim() });
    line = null;
  };
  const addText = (t) => {
    if (!t) return;
    if (pnum) { pnum.text += t; return; }
    if (inTitle) { titleBuf += t; return; }
    if (!line) line = { level, text: "" };
    line.text += t;
    if (t.trim()) justNumbered = false;
  };

  const token = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][A-Za-z0-9:_-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = token.exec(body))) {
    if (m[5] !== undefined) { addText(decode(m[5])); continue; }
    if (!m[2]) continue; // a comment
    const closing = m[1] === "/";
    const name = m[2];
    const selfClose = m[4] === "/";
    const tag = m[0];

    if (name === "CommentaryRef" || name === "FootnoteRef" || name === "MarginNoteRef") continue;

    if (name === "Title") {
      if (closing) {
        if (inTitle) {
          if (!skipTitle && !sawHeading) { heading = clean(titleBuf); sawHeading = true; }
          inTitle = false; titleBuf = "";
        }
      } else if (!selfClose) {
        // The heading of the provision sits in the first <Title>. Later ones
        // (headings inside a schedule, say) are not part of the quoted text.
        inTitle = true; titleBuf = ""; skipTitle = sawHeading;
      }
      continue;
    }
    if (name === "Pnumber") {
      if (closing) {
        if (pnum) {
          const label = clean(pnum.text);
          if (!number && !lines.length && /^[0-9]+[A-Z]{0,3}$/.test(label) && !pnum.before) {
            // The provision's own number ("6"). It is the label, not text to quote.
            number = label;
          } else {
            if (!line) line = { level, text: "" };
            line.text += `${pnum.before}${label}${pnum.after} `;
            justNumbered = true;
          }
          pnum = null;
        }
      } else if (!selfClose) {
        flush();
        pnum = { before: attr(tag, "PuncBefore"), after: attr(tag, "PuncAfter"), text: "" };
      }
      continue;
    }
    if (LEVEL[name] !== undefined) {
      flush();
      justNumbered = false;
      // Opening P3 indents; closing it goes back to its parent's level, so the
      // text that follows a list of paragraphs sits where the list began.
      level = closing ? (LEVEL[`P${Number(name.slice(1)) - 1}`] ?? 0) : LEVEL[name];
      continue;
    }
    if (name === "Text" || name === "Para" || name === "ListItem" || name === "Tr") {
      // A paragraph of text. Straight after a number it continues that line.
      if (!closing && !justNumbered) flush();
      justNumbered = false;
      continue;
    }
    // Everything else (Emphasis, Term, Citation, Addition...) is inline: keep its text.
  }
  flush();

  const total = lines.reduce((n, l) => n + l.text.length, 0);
  if (total < 12) return null;
  return { heading, number, paragraphs: lines, extent, repealed };
}

// Keeps whole paragraphs up to the limit. Returns the paragraphs and whether
// anything was left out.
export function limitParagraphs(paragraphs, maxChars = MAX_CHARS) {
  const out = [];
  let used = 0;
  for (const p of paragraphs) {
    if (used + p.text.length > maxChars && out.length) return { paragraphs: out, truncated: true };
    out.push(p);
    used += p.text.length;
  }
  return { paragraphs: out, truncated: false };
}

// ---------- The card ----------
export function buildProvision({ ref, meta, parsed }) {
  const info = TYPES[ref.type];
  const actTitle = meta.title || ref.title;
  const cut = limitParagraphs(parsed.paragraphs);
  const label = `${ref.kind} ${ref.ref}`; // "section 6"
  const short = `${SHORT[ref.kind]} ${ref.ref}`; // "s 6"
  const url = `${LEG_BASE}${provisionPath(ref)}`;
  return {
    actTitle,
    typeName: info.name,
    chapter: info.chapter(ref.year, ref.number),
    chapterShort: info.short(ref.year, ref.number),
    jurisdiction: info.jurisdiction,
    isInstrument: ref.type === "uksi" || ref.type === "ssi",
    year: ref.year,
    provisionKind: ref.kind,
    provisionRef: ref.ref,
    provisionLabel: label,
    provisionShort: short,
    heading: parsed.heading || "",
    paragraphs: cut.paragraphs,
    truncated: cut.truncated,
    extent: parsed.extent || "",
    url,
    actUrl: `${LEG_BASE}/${ref.type}/${ref.year}/${ref.number}`,
    matchConfidence: ref.confidence
  };
}

// ---------- Putting it together ----------
export function createPrimarySources({
  fetchFn = globalThis.fetch,
  askModel,
  enabled = true,
  now = Date.now,
  log = console,
  answerTtlMs = 24 * 60 * 60 * 1000,
  maxAnswers = 500
} = {}) {
  const answers = new Map(); // normalised question -> { at, card }

  const getXml = async (url) => {
    const res = await fetchFn(url, { headers: { accept: "application/xml", "user-agent": "LitMark (litmark.org)" } });
    if (res.status === 404) return null; // no such provision: an answer, not a failure
    if (!res.ok) throw new Error(`legislation.gov.uk ${res.status}`);
    return res.text();
  };

  function remember(key, card) {
    if (answers.size >= maxAnswers) answers.delete(answers.keys().next().value);
    answers.set(key, { at: now(), card });
  }

  // One provision -> a provision object, or null if it can't be confirmed as the
  // thing the model named. Throws only when the service itself failed.
  async function fetchProvision(ref) {
    const xml = await getXml(`${LEG_BASE}${provisionPath(ref)}/data.xml`);
    if (!xml) return null;
    const meta = parseMetadata(xml);
    if (!titleMatches(ref.title, meta.title)) {
      log.warn?.(`[primary-sources] ${provisionPath(ref)} is "${meta.title || "(no title)"}", not "${ref.title}": dropped`);
      return null;
    }
    if ((meta.year != null && meta.year !== ref.year) || (meta.number != null && meta.number !== ref.number)) return null;
    const parsed = parseProvisionBody(xml);
    if (!parsed || parsed.repealed) return null;
    return buildProvision({ ref, meta, parsed });
  }

  // A card, null ("nothing to show", worth remembering) or undefined ("couldn't
  // tell right now", not remembered so the next search tries again).
  async function lookUp(question) {
    const reply = await askModel(buildChoicePrompt(question));
    const choice = parseChoice(reply);
    if (!choice) return undefined;
    if (!choice.provisions.length) return null;

    let failed = false;
    const results = await Promise.all(choice.provisions.map(async (ref) => {
      try {
        return await fetchProvision(ref);
      } catch (err) {
        failed = true;
        log.warn?.("[primary-sources] fetch failed:", err.message);
        return null;
      }
    }));
    const provisions = results.filter(Boolean);
    if (!provisions.length) return failed ? undefined : null;
    return {
      provider: "legislation.gov.uk",
      providerName: "legislation.gov.uk",
      provisions,
      caveat: choice.caveat,
      retrievedOn: new Date(now()).toISOString().slice(0, 10),
      attribution: ATTRIBUTION,
      licence: "OGL v3.0"
    };
  }

  // Never throws, never blocks for long: the search that called this must not
  // care whether it worked.
  async function find(question) {
    try {
      if (!enabled || typeof askModel !== "function") return null;
      const q = String(question || "").trim();
      if (!wantsLaw(q)) return null;
      const key = q.toLowerCase().replace(/\s+/g, " ").replace(/[?.!\s]+$/, "");
      const hit = answers.get(key);
      if (hit && now() - hit.at < answerTtlMs) return hit.card;
      const card = await lookUp(q);
      if (card === undefined) return null;
      remember(key, card);
      return card;
    } catch (err) {
      log.warn?.("[primary-sources] nothing for this search:", err.message);
      return null;
    }
  }

  return { find };
}
