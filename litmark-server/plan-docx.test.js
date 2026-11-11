import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { buildDocx, crc32, docxFilename, xmlText, zip } from "./plan-docx.js";
import { assemblePlan, cleanOutline, pickKeyPapers } from "./plan-logic.js";

// A small zip reader, written separately from the writer so the two check each other.
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "end-of-central-directory record found");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central directory entry");
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    assert.equal(buf.readUInt32LE(off), 0x04034b50, "local header");
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    assert.equal(method, 8);
    const raw = inflateRawSync(data);
    assert.equal(raw.length, usize, `${name}: size`);
    assert.equal(crc32(raw), crc, `${name}: crc`);
    files[name] = raw.toString("utf8");
    p += 46 + nlen + elen + clen;
  }
  return files;
}

// Enough of an XML checker to catch what would make Word call a file corrupt:
// unbalanced tags, or a bare & or < inside text.
function assertWellFormed(xml, name) {
  const body = xml.replace(/^<\?xml[^>]*\?>/, "");
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:.-]*)([^<>]*?)(\/?)>|([^<]+)/g;
  let m, last = 0;
  while ((m = re.exec(body))) {
    assert.equal(m.index, last, `${name}: stray "<" at ${m.index}`);
    last = re.lastIndex;
    if (m[5] !== undefined) {
      assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(m[5]), `${name}: bare & in text "${m[5].slice(0, 40)}"`);
      continue;
    }
    const [, close, tag, , selfClose] = m;
    if (selfClose) continue;
    if (close) assert.equal(stack.pop(), tag, `${name}: </${tag}> closes the wrong tag`);
    else stack.push(tag);
  }
  assert.equal(last, body.length, `${name}: trailing junk`);
  assert.deepEqual(stack, [], `${name}: unclosed tags`);
}

const hl = [{ text: "Fasting insulin fell by a small but consistent amount across trials.", section: "abstract" }];
const mk = o => ({ title: "A paper", authors: "Ola Okafor, B C, D E", year: 2023, journal: "Obesity Reviews", paperType: "Meta-analysis", citedByCount: 212, suitability: 90, highlights: hl, url: "https://doi.org/10.1/x", ...o });
const input = { question: "Does intermittent fasting improve insulin sensitivity in adults?", type: "Essay", wordCount: 2000, year: "2nd year", subject: "Nutrition", brief: "Harvard referencing" };
const good = (h, a = ["R1"]) => ({ heading: h, cover: "Cover the main trials and what they found.", anchors: a, weight: 5, query: "fasting insulin trials" });

function samplePlan(papers = [mk({}), mk({ title: "Cited trial", paperType: "Randomised controlled trial", citedByCount: 1240, url: "https://x.org/a?b=1&c=2" })]) {
  const picks = pickKeyPapers(papers);
  const body = cleanOutline([good("Time-restricted eating"), good("Mechanisms", []), good("Limitations"), good("Weight loss")], new Set(["R1", "C1"]), { min: 2, max: 5 });
  return assemblePlan(input, picks, body, { now: new Date("2026-11-11T12:00:00Z") });
}

test("1. the zip is a valid container: every file inflates and matches its checksum", () => {
  const files = readZip(zip([{ name: "a.txt", data: Buffer.from("hello ".repeat(500)) }, { name: "dir/é.txt", data: Buffer.alloc(0) }]));
  assert.equal(files["a.txt"], "hello ".repeat(500));
  assert.equal(files["dir/é.txt"], "");
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926, "the standard CRC-32 check value");
});

test("2. a plan becomes a .docx with the five parts Word needs, all well-formed", () => {
  const files = readZip(buildDocx(samplePlan()));
  assert.deepEqual(Object.keys(files), ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/_rels/document.xml.rels"]);
  for (const [name, xml] of Object.entries(files)) assertWellFormed(xml, name);
  assert.match(files["[Content_Types].xml"], /wordprocessingml\.document\.main\+xml/);
});

test("3. the page holds the question, the papers, their checked quotes and the outline", () => {
  const doc = readZip(buildDocx(samplePlan()))["word/document.xml"];
  for (const s of [
    "Does intermittent fasting improve insulin sensitivity in adults?", "2,000 words", "2nd year", "Harvard referencing",
    "Read these reviews first", "Most cited in this area", "Meta-analysis", "Cited\u00a0by\u00a01,240",
    "Fasting insulin fell by a small but consistent amount across trials.",
    "Time-restricted eating", "Introduction", "Conclusion", "Find more in LitMark", "fasting insulin trials", "Okafor et al. 2023", "None needed", "Built 11 Nov 2026", "A plan, not a draft."
  ]) assert.ok(doc.includes(s), `missing: ${s}`);
  assert.ok(doc.includes("2,000"), "the total is shown");
});

test("4. links to papers work, and an & in a link is escaped in the file", () => {
  const files = readZip(buildDocx(samplePlan()));
  assert.match(files["word/_rels/document.xml.rels"], /Target="https:\/\/doi\.org\/10\.1\/x" TargetMode="External"/);
  assert.match(files["word/_rels/document.xml.rels"], /a\?b=1&amp;c=2/);
  assert.match(files["word/document.xml"], /<w:hyperlink r:id="rId\d+">/);
});

test("5. text from a paper or the AI can never become markup or corrupt the file", () => {
  const evil = mk({ title: 'Cats <b>& dogs</b> "quoted" \u0001\u0008 bell￾', authors: "A <script>", journal: "J&J", highlights: [{ text: "A quote with <tags> & ampersands and a \u0000 null byte in it.", section: "abstract" }] });
  const files = readZip(buildDocx(samplePlan([evil])));
  assertWellFormed(files["word/document.xml"], "document");
  assert.ok(!files["word/document.xml"].includes("<script"));
  assert.ok(!files["word/document.xml"].includes("<b>& dogs"));
  assert.ok(files["word/document.xml"].includes("Cats &lt;b&gt;&amp; dogs&lt;/b&gt; &quot;quoted&quot;"));
  assert.equal(xmlText("a\u0001b\ud800c"), "abc");
});

test("6. with no review papers, and again with no outline, the page says so plainly", () => {
  const noReviews = readZip(buildDocx(samplePlan([mk({ paperType: "Research article", citedByCount: 900 })])))["word/document.xml"];
  assert.ok(noReviews.includes("No review paper in these results fit your question well enough"));
  const nothing = assemblePlan(input, { reviews: [], mostCited: [] }, []);
  const doc = readZip(buildDocx(nothing))["word/document.xml"];
  assertWellFormed(doc, "document");
  assert.ok(doc.includes("We could not suggest section headings this time"));
  assert.ok(doc.includes("No paper in these results has enough citations"));
});

test("7. the file name is plain ASCII and safe in a download header", () => {
  assert.equal(docxFilename({ question: "Does intermittent fasting improve insulin sensitivity in adults?" }), "litmark-plan-does-intermittent-fasting-improve-insulin-sensitivity.docx");
  assert.equal(docxFilename({ question: "Étude: l'effet de ¿qué? \"x\"\r\nSet-Cookie: a=b" }), "litmark-plan-etude-l-effet-de-que-x.docx");
  assert.equal(docxFilename({ question: "???" }), "litmark-plan.docx");
  assert.equal(docxFilename(undefined), "litmark-plan.docx");
});

test("8. a long plan (ten sections, long quotes) still builds", () => {
  const long = mk({ highlights: [{ text: ("word ".repeat(120)).trim(), section: "abstract" }] });
  const picks = pickKeyPapers([long, mk({ title: "B", paperType: "Review" }), mk({ title: "C", citedByCount: 90 }), mk({ title: "D", citedByCount: 80 })]);
  const body = cleanOutline(Array.from({ length: 10 }, (_, i) => good("Topic number " + (i + 1), ["R1"])), new Set(["R1", "R2", "C1", "C2"]), { min: 2, max: 10 });
  const plan = assemblePlan({ ...input, wordCount: 12000, type: "Dissertation" }, picks, body);
  const files = readZip(buildDocx(plan));
  assertWellFormed(files["word/document.xml"], "document");
  assert.equal(plan.outlineTotal, 12000);
});
