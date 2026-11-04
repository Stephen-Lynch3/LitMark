import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTRIBUTION,
  buildChoicePrompt,
  createPrimarySources,
  extentText,
  limitParagraphs,
  parseChoice,
  parseMetadata,
  parseProvisionBody,
  provisionPath,
  titleMatches,
  validateReference,
  wantsLaw
} from "./primary-sources.js";

// ---------- fixture ----------
// Hand-built from legislation.gov.uk's documented CLML (Metadata with dc:title and
// ukm:Year/Number, then <Primary><Body> with P1group/P1/P2/P3 and Pnumber carrying
// PuncBefore/PuncAfter, commentary references, and Commentaries after the body).
// The words are those of the Equality Act 2010 section 6.
const SECTION_6 = `<?xml version="1.0" encoding="UTF-8"?>
<Legislation xmlns="http://www.legislation.gov.uk/namespaces/legislation" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:ukm="http://www.legislation.gov.uk/namespaces/metadata" DocumentURI="http://www.legislation.gov.uk/ukpga/2010/15/section/6" IdURI="http://www.legislation.gov.uk/id/ukpga/2010/15/section/6">
<ukm:Metadata>
<dc:identifier>http://www.legislation.gov.uk/ukpga/2010/15/section/6</dc:identifier>
<dc:title>Equality Act 2010</dc:title>
<ukm:DocumentClassification><ukm:DocumentCategory Value="primary"/><ukm:DocumentMainType Value="UnitedKingdomPublicGeneralAct"/><ukm:Year Value="2010"/><ukm:Number Value="15"/></ukm:DocumentClassification>
<ukm:UnappliedEffects><ukm:UnappliedEffect Type="inserted"><ukm:AffectedTitle>Equality Act 2010</ukm:AffectedTitle></ukm:UnappliedEffect></ukm:UnappliedEffects>
</ukm:Metadata>
<Primary>
<Body>
<P1group RestrictExtent="E+W+S">
<Title>Disability</Title>
<P1 id="section-6"><Pnumber>6</Pnumber>
<P1para>
<P2 id="section-6-1"><Pnumber PuncBefore="(" PuncAfter=")">1</Pnumber><P2para><Text>A person (<Term>P</Term>) has a disability if<CommentaryRef Ref="key-1"/>—</Text>
<P3 id="section-6-1-a"><Pnumber PuncBefore="(" PuncAfter=")">a</Pnumber><P3para><Text>P has a physical or mental impairment, and</Text></P3para></P3>
<P3 id="section-6-1-b"><Pnumber PuncBefore="(" PuncAfter=")">b</Pnumber><P3para><Text>the impairment has a substantial and long-term adverse effect on P’s ability to carry out normal day-to-day activities.</Text></P3para></P3>
</P2para></P2>
<P2 id="section-6-2"><Pnumber PuncBefore="(" PuncAfter=")">2</Pnumber><P2para><Text>A reference to a disabled person is a reference to a person who has a disability.</Text></P2para></P2>
</P1para></P1>
</P1group>
</Body>
</Primary>
<Commentaries><Commentary id="key-1" Type="F"><Para><Text>Words in s. 6(1) substituted (1.1.2099) by Some Act 2099 (c. 9), s. 1</Text></Para></Commentary></Commentaries>
</Legislation>`;

const REF = { title: "Equality Act 2010", type: "ukpga", year: 2010, number: 15, provision: "section/6", confidence: 95 };

// ---------- is this about the law? ----------

test("wantsLaw: law questions yes, others no", () => {
  assert.equal(wantsLaw("Is the Equality Act definition of disability too narrow?"), true);
  assert.equal(wantsLaw("Should assisted dying be legalised in England and Wales?"), true);
  assert.equal(wantsLaw("What are the effects of sleep deprivation on memory?"), false);
  assert.equal(wantsLaw("law"), false); // a bare keyword is not a question
});

test("wantsLaw: another country's law is skipped, unless the UK is also named", () => {
  assert.equal(wantsLaw("How does US law treat negligence claims?"), false);
  assert.equal(wantsLaw("How does UK law differ from US law on negligence?"), true);
});

// ---------- references ----------

test("validateReference accepts a well-formed reference", () => {
  const r = validateReference(REF);
  assert.deepEqual({ type: r.type, year: r.year, number: r.number, kind: r.kind, ref: r.ref }, { type: "ukpga", year: 2010, number: 15, kind: "section", ref: "6" });
  assert.equal(provisionPath(r), "/ukpga/2010/15/section/6");
});

test("validateReference rejects anything that could change the address", () => {
  assert.equal(validateReference({ ...REF, provision: "section/6/../../x" }), null);
  assert.equal(validateReference({ ...REF, provision: "section/6?x=1" }), null);
  assert.equal(validateReference({ ...REF, provision: "section/1-5" }), null);
  assert.equal(validateReference({ ...REF, type: "ukpga/../x" }), null);
  assert.equal(validateReference({ ...REF, type: "eur" }), null);
  assert.equal(validateReference({ ...REF, year: 20100 }), null);
  assert.equal(validateReference({ ...REF, number: 0 }), null);
  assert.equal(validateReference({ ...REF, title: "" }), null);
});

test("validateReference: an Act does not have regulations, a statutory instrument does", () => {
  assert.equal(validateReference({ ...REF, provision: "regulation/4" }), null);
  assert.ok(validateReference({ title: "The Working Time Regulations 1998", type: "uksi", year: 1998, number: 1833, provision: "regulation/4" }));
});

test("section numbers with letters are fine", () => {
  assert.equal(validateReference({ ...REF, provision: "section/20A" }).ref, "20A");
});

// ---------- the model's reply ----------

test("parseChoice reads a good reply", () => {
  const c = parseChoice(JSON.stringify({ provisions: [REF], caveat: "Scots law differs." }));
  assert.equal(c.provisions.length, 1);
  assert.equal(c.caveat, "Scots law differs.");
});

test("parseChoice: low confidence, duplicates and junk are dropped, at most two kept", () => {
  const c = parseChoice(JSON.stringify({
    provisions: [
      { ...REF, confidence: 60 },
      REF,
      REF,
      { ...REF, provision: "section/13" },
      { ...REF, provision: "section/15" }
    ]
  }));
  assert.deepEqual(c.provisions.map(p => p.ref), ["6", "13"]);
});

test("parseChoice: an empty list is an answer (nothing to show), unreadable text is not", () => {
  assert.deepEqual(parseChoice('{"provisions": []}').provisions, []);
  assert.equal(parseChoice("sorry, I can't"), null);
  assert.equal(parseChoice(""), null);
});

test("parseChoice drops a caveat that carries a number", () => {
  assert.equal(parseChoice(JSON.stringify({ provisions: [REF], caveat: "Applies to 2010 only." })).caveat, "");
});

test("the prompt tells the model to name, not quote", () => {
  const p = buildChoicePrompt("Is the Equality Act too narrow?");
  assert.match(p, /Do not quote or paraphrase/);
  assert.match(p, /UK legislation only/);
});

// ---------- the page ----------

test("parseMetadata reads the title and identifiers", () => {
  const m = parseMetadata(SECTION_6);
  assert.equal(m.title, "Equality Act 2010");
  assert.equal(m.year, 2010);
  assert.equal(m.number, 15);
});

test("titleMatches ignores case, 'The', punctuation and ampersands", () => {
  assert.equal(titleMatches("Equality Act 2010", "Equality Act 2010"), true);
  assert.equal(titleMatches("The Working Time Regulations 1998", "Working Time Regulations 1998"), true);
  assert.equal(titleMatches("Equality Act 2010", "Equality Act 2006"), false);
  assert.equal(titleMatches("Equality Act 2010", ""), false);
});

test("parseProvisionBody: heading, numbered subsections and indented paragraphs, none of the commentary", () => {
  const p = parseProvisionBody(SECTION_6);
  assert.equal(p.heading, "Disability");
  assert.equal(p.number, "6");
  assert.equal(p.extent, "England, Wales and Scotland");
  assert.deepEqual(p.paragraphs, [
    { level: 0, text: "(1) A person (P) has a disability if—" },
    { level: 1, text: "(a) P has a physical or mental impairment, and" },
    { level: 1, text: "(b) the impairment has a substantial and long-term adverse effect on P’s ability to carry out normal day-to-day activities." },
    { level: 0, text: "(2) A reference to a disabled person is a reference to a person who has a disability." }
  ]);
  assert.ok(!JSON.stringify(p).includes("2099"), "commentary must not leak in");
});

test("parseProvisionBody: nothing readable means null", () => {
  assert.equal(parseProvisionBody("<html>Not found</html>"), null);
  assert.equal(parseProvisionBody("<Primary><Body></Body></Primary>"), null);
  assert.equal(parseProvisionBody(""), null);
});

test("parseProvisionBody: a repealed section is flagged", () => {
  const xml = SECTION_6.replace('<P1 id="section-6">', '<P1 id="section-6" Status="Repealed">');
  assert.equal(parseProvisionBody(xml).repealed, true);
});

test("entities and character references come out as text", () => {
  const xml = `<Primary><Body><P1group><Title>Fees</Title><P1><Pnumber>1</Pnumber><P1para><Text>Fees &amp; costs under &#163;5 &lt;or&gt; &#x2014; more.</Text></P1para></P1></P1group></Body></Primary>`;
  assert.equal(parseProvisionBody(xml).paragraphs[0].text, "Fees & costs under £5 <or> — more.");
});

test("extentText", () => {
  assert.equal(extentText("E+W"), "England and Wales");
  assert.equal(extentText("E+W+S+N.I."), "England, Wales, Scotland and Northern Ireland");
  assert.equal(extentText("S"), "Scotland");
  assert.equal(extentText("E+X"), ""); // anything unrecognised is left out, not guessed
  assert.equal(extentText(""), "");
});

test("limitParagraphs cuts at a paragraph, not mid-sentence", () => {
  const paras = [{ level: 0, text: "a".repeat(1500) }, { level: 0, text: "b".repeat(1500) }, { level: 0, text: "c" }];
  const r = limitParagraphs(paras, 2600);
  assert.equal(r.paragraphs.length, 1);
  assert.equal(r.truncated, true);
  assert.equal(limitParagraphs(paras.slice(2), 2600).truncated, false);
});

// ---------- the whole lookup ----------

function harness({ xml = SECTION_6, status = 200, reply, throwOnFetch = false } = {}) {
  const calls = { fetch: [], model: 0 };
  const fetchFn = async (url) => {
    calls.fetch.push(url);
    if (throwOnFetch) throw new Error("network down");
    return { ok: status >= 200 && status < 300, status, text: async () => xml };
  };
  const askModel = async () => {
    calls.model++;
    return reply ?? JSON.stringify({ provisions: [REF], caveat: "" });
  };
  const logs = [];
  const ps = createPrimarySources({ fetchFn, askModel, log: { warn: (...a) => logs.push(a.join(" ")) } });
  return { ps, calls, logs };
}

const Q = "Is the Equality Act definition of disability too narrow?";

test("a law question gets the provision, word for word, from the official page", async () => {
  const { ps, calls } = harness();
  const card = await ps.find(Q);
  assert.equal(card.provisions.length, 1);
  const p = card.provisions[0];
  assert.equal(p.actTitle, "Equality Act 2010");
  assert.equal(p.provisionLabel, "section 6");
  assert.equal(p.provisionShort, "s 6");
  assert.equal(p.chapter, "2010 c 15");
  assert.equal(p.heading, "Disability");
  assert.equal(p.paragraphs[0].text, "(1) A person (P) has a disability if—");
  assert.equal(p.url, "https://www.legislation.gov.uk/ukpga/2010/15/section/6");
  assert.equal(card.attribution, ATTRIBUTION);
  assert.equal(card.licence, "OGL v3.0");
  assert.match(calls.fetch[0], /^https:\/\/www\.legislation\.gov\.uk\/ukpga\/2010\/15\/section\/6\/data\.xml$/);
});

test("the wording is the page's, whatever the model said", async () => {
  const reply = JSON.stringify({ provisions: [{ ...REF, text: "INVENTED WORDING" }], caveat: "" });
  const { ps } = harness({ reply });
  const card = await ps.find(Q);
  assert.ok(!JSON.stringify(card).includes("INVENTED"));
});

test("a page that is a different Act from the one named is never shown", async () => {
  const wrong = SECTION_6.replace("<dc:title>Equality Act 2010</dc:title>", "<dc:title>Pensions Act 2008</dc:title>");
  const { ps, logs } = harness({ xml: wrong });
  assert.equal(await ps.find(Q), null);
  assert.ok(logs.some(l => /dropped/.test(l)));
});

test("a page whose year or number disagrees is never shown", async () => {
  const wrong = SECTION_6.replace('<ukm:Number Value="15"/>', '<ukm:Number Value="16"/>');
  const { ps } = harness({ xml: wrong });
  assert.equal(await ps.find(Q), null);
});

test("a page with no title cannot be confirmed, so it is not shown", async () => {
  const { ps } = harness({ xml: SECTION_6.replace(/<dc:title>[\s\S]*?<\/dc:title>/, "") });
  assert.equal(await ps.find(Q), null);
});

test("a repealed section is not shown", async () => {
  const { ps } = harness({ xml: SECTION_6.replace('<P1 id="section-6">', '<P1 id="section-6" Status="Repealed">') });
  assert.equal(await ps.find(Q), null);
});

test("no such provision (404) is an answer: nothing shown, remembered", async () => {
  const { ps, calls } = harness({ status: 404 });
  assert.equal(await ps.find(Q), null);
  assert.equal(await ps.find(Q), null);
  assert.equal(calls.model, 1);
});

test("the service failing is not remembered: the next search tries again", async () => {
  const { ps, calls } = harness({ throwOnFetch: true });
  assert.equal(await ps.find(Q), null);
  assert.equal(await ps.find(Q), null);
  assert.equal(calls.model, 2);
});

test("a question that is not about the law costs nothing", async () => {
  const { ps, calls } = harness();
  assert.equal(await ps.find("What are the effects of sleep deprivation on memory?"), null);
  assert.equal(calls.model, 0);
  assert.equal(calls.fetch.length, 0);
});

test("the model saying 'none' shows nothing and is remembered", async () => {
  const { ps, calls } = harness({ reply: '{"provisions": []}' });
  assert.equal(await ps.find(Q), null);
  assert.equal(await ps.find(Q), null);
  assert.equal(calls.model, 1);
});

test("an unreadable model reply shows nothing and is not remembered", async () => {
  const { ps, calls } = harness({ reply: "I think maybe section 6?" });
  assert.equal(await ps.find(Q), null);
  assert.equal(await ps.find(Q), null);
  assert.equal(calls.model, 2);
});

test("the same question is answered from memory the second time", async () => {
  const { ps, calls } = harness();
  const a = await ps.find(Q);
  const b = await ps.find("  " + Q.toLowerCase() + "  ");
  assert.deepEqual(a, b);
  assert.equal(calls.model, 1);
  assert.equal(calls.fetch.length, 1);
});

test("switched off, it does nothing", async () => {
  const ps = createPrimarySources({ enabled: false, askModel: async () => { throw new Error("should not be called"); } });
  assert.equal(await ps.find(Q), null);
});

test("one bad provision of two does not hide the good one", async () => {
  const reply = JSON.stringify({ provisions: [REF, { ...REF, title: "Pensions Act 2008", provision: "section/13" }] });
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => SECTION_6 });
  const ps = createPrimarySources({ fetchFn, askModel: async () => reply, log: { warn() {} } });
  const card = await ps.find(Q);
  assert.equal(card.provisions.length, 1);
  assert.equal(card.provisions[0].actTitle, "Equality Act 2010");
});

test("the card carries what the citation formats need", async () => {
  const { ps } = harness();
  const p = (await ps.find(Q)).provisions[0];
  assert.equal(p.chapterShort, "c. 15");
  assert.equal(p.jurisdiction, "UK");
  assert.equal(p.isInstrument, false);
  const sic = createPrimarySources({
    fetchFn: async () => ({ ok: true, status: 200, text: async () => SECTION_6.replace("Equality Act 2010", "Working Time Regulations 1998").replace('Value="2010"', 'Value="1998"').replace('Value="15"', 'Value="1833"') }),
    askModel: async () => JSON.stringify({ provisions: [{ title: "Working Time Regulations 1998", type: "uksi", year: 1998, number: 1833, provision: "regulation/4", confidence: 90 }] }),
    log: { warn() {} }
  });
  const si = (await sic.find("How many hours can an employee be made to work under the law?")).provisions[0];
  assert.equal(si.chapterShort, "SI 1998/1833");
  assert.equal(si.isInstrument, true);
  assert.equal(si.provisionShort, "reg 4");
});
