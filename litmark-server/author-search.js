// Students sometimes type a researcher's name into the search box, alone or with
// a topic ("Cudzik trauma models", "Smith 2019 sleep"). Papers rarely mention
// their authors in the title or abstract, so a plain topic search never finds
// them. These helpers detect the name, check each paper's real author list, and
// put papers by that author first.
//
// The AI only suggests names. Code makes sure each one is literally in what the
// student typed, and code checks the authors on every paper. A name the AI made
// up, or a paper that only looks like a match, never gets through.

const MAX_NAMES = 2;

// Lower case, accents removed, anything that is not a letter turned into a space.
export function norm(s) {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildAuthorPrompt(question) {
  return `A student typed this into a literature search box:
"${question}"

If it names one or more researchers as authors (for example "Smith 2019 sleep", "papers by Jane Doe on anxiety", "Cudzik trauma models"), return their names exactly as the student typed them, as a JSON array of strings, such as ["Cudzik"]. Only names of people. Never topics, theories, places, journals or organisations. If no person is named, return [].
Reply with only the JSON array.`;
}

// The AI's reply as a short list of names that are really in the question.
export function cleanAuthorNames(raw, question) {
  const text = String(raw ?? "").replace(/```json|```/g, "").trim();
  let arr;
  try { arr = JSON.parse(text); } catch {
    const a = text.indexOf("[");
    const b = text.lastIndexOf("]");
    if (a === -1 || b <= a) return [];
    try { arr = JSON.parse(text.slice(a, b + 1)); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const q = norm(question);
  const out = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const name = item.replace(/\bet al\.?/i, "").replace(/\s+/g, " ").trim();
    if (name.length < 2 || name.length > 40) continue;
    if (!/^[\p{L}][\p{L}'’\- .]*$/u.test(name)) continue;
    const n = norm(name);
    if (!n) continue;
    if (!(` ${q} `).includes(` ${n} `)) continue;          // must really be in the question
    if (out.some(x => norm(x) === n)) continue;
    out.push(name);
    if (out.length === MAX_NAMES) break;
  }
  return out;
}

// "Jane Cudzik" -> surname "cudzik", given "jane". "Cudzik" -> surname only.
function parts(name) {
  const toks = norm(name).split(" ").filter(Boolean);
  return { surname: toks[toks.length - 1] || "", given: toks.slice(0, -1).join(" ") };
}

function paperAuthors(paper) {
  if (Array.isArray(paper?.authorList) && paper.authorList.length) {
    return paper.authorList.map(a => ({ family: norm(a?.family), given: norm(a?.given) }));
  }
  // Fall back to the plain "Jane Cudzik, Tom Badrick" string.
  return String(paper?.authors ?? "").split(",").map(s => s.trim()).filter(Boolean).map(full => {
    const toks = norm(full).split(" ").filter(Boolean);
    return { family: toks[toks.length - 1] || "", given: toks.slice(0, -1).join(" ") };
  });
}

// True when one of the paper's real authors is this person. A surname alone is
// enough; if the student gave a first name too, the first letter must agree.
export function authorMatches(paper, names) {
  if (!Array.isArray(names) || !names.length) return false;
  const authors = paperAuthors(paper);
  return names.some(name => {
    const { surname, given } = parts(name);
    if (!surname) return false;
    return authors.some(a => {
      const sameFamily = a.family === surname || a.family.split(/[\s-]/).includes(surname);
      if (!sameFamily) return false;
      if (!given || !a.given) return true;
      return a.given[0] === given[0];
    });
  });
}

// The topic search query without the person's name, unless that would leave too
// little to search on.
export function stripAuthorNames(text, names) {
  let out = String(text ?? "");
  for (const name of names || []) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[^\\p{L}])${esc}('s|’s)?(\\s+et\\s+al\\.?)?(?![\\p{L}])`, "giu"), "$1");
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.split(" ").filter(Boolean).length >= 2 ? out : String(text ?? "").trim();
}

const keyOf = p => (p.doi ? `doi:${String(p.doi).toLowerCase()}` : `t:${String(p.title || "").toLowerCase().replace(/\W+/g, " ").trim()}`);

// Papers by the named author that the topic selection left out are added (up to
// `max`) so the relevance step can judge them.
export function addAuthorCandidates(chosen, allFound, names, max = 8) {
  const have = new Set(chosen.map(keyOf));
  const extra = [];
  for (const p of allFound) {
    if (extra.length >= max) break;
    if (!authorMatches(p, names)) continue;
    const k = keyOf(p);
    if (have.has(k)) continue;
    have.add(k);
    extra.push(p);
  }
  return [...chosen, ...extra];
}

// Papers by the named author first (each marked), everything else after, each
// group keeping its own order.
export function authorFirst(results, names) {
  const mine = [];
  const rest = [];
  for (const p of results) (authorMatches(p, names) ? mine : rest).push(p);
  return { results: [...mine.map(p => ({ ...p, authorMatch: true })), ...rest], matched: mine.length };
}
