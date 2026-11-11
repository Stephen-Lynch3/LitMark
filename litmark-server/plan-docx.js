// Writes a plan as a Word (.docx) file with no outside package.
//
// A .docx is a zip of a few XML files, and Node can already compress (zlib), so
// the zip container is written here by hand. That keeps `npm install` unchanged
// on Render and means the whole thing can be tested here (`npm test`).
//
// The plan is laid out to fit on one A4 page: the papers to read first in two
// columns, then the outline table. Everything that came from a paper record or
// from the AI is escaped before it goes into the XML.

import { deflateRawSync } from "node:zlib";

// ---------------------------------------------------------------------
// The zip container
// ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: Buffer }]. Returns the zip as a Buffer.
export function zip(files) {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = f.data;
    const packed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);        // version needed
    lh.writeUInt16LE(0x0800, 6);    // flags: names are UTF-8
    lh.writeUInt16LE(8, 8);         // method: deflate
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(packed.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, packed);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);        // version made by
    ch.writeUInt16LE(20, 6);        // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(packed.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------

// Characters XML 1.0 forbids (control characters, lone surrogates, U+FFFE/F) are
// removed: one stray character in a paper's title would otherwise make Word
// report the whole file as corrupt.
export function xmlText(s) {
  return String(s ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const INK = "14161A", SOFT = "6E7166", LIME = "C6F135", AMBER = "F2C14E", BLUE = "1A3FB0", PAPER = "F7F7F1", GREY = "F1F0E8";

// opts: b, i, color, size (points), fill (background), u (underline)
function run(text, opts = {}) {
  const { b, i, color, size, fill, u } = opts;
  const rPr =
    (b ? "<w:b/>" : "") +
    (i ? "<w:i/>" : "") +
    (color ? `<w:color w:val="${color}"/>` : "") +
    (size ? `<w:sz w:val="${Math.round(size * 2)}"/><w:szCs w:val="${Math.round(size * 2)}"/>` : "") +
    (u ? '<w:u w:val="single"/>' : "") +
    (fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : "");
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;
}

const tab = () => "<w:r><w:tab/></w:r>";

// opts: after / before (twips), align, border ("bottom"|"top" + colour), keepNext, rightTab
function para(content, opts = {}) {
  const { after = 0, before = 0, align, border, keepNext, rightTab } = opts;
  const pPr =
    (keepNext ? "<w:keepNext/>" : "") +
    (border ? `<w:pBdr><w:${border.side} w:val="single" w:sz="${border.size || 8}" w:space="2" w:color="${border.color}"/></w:pBdr>` : "") +
    (rightTab ? `<w:tabs><w:tab w:val="right" w:pos="${rightTab}"/></w:tabs>` : "") +
    `<w:spacing w:before="${before}" w:after="${after}"/>` +
    (align ? `<w:jc w:val="${align}"/>` : "");
  return `<w:p><w:pPr>${pPr}</w:pPr>${content}</w:p>`;
}

const CONTENT_WIDTH = 10206; // A4 width less 1.5 cm margins, in twips

function cell(width, inner, { fill, borders, span, margins = "80 100 80 100" } = {}) {
  const [t, r, bt, l] = margins.split(" ").map(Number);
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
    (span ? `<w:gridSpan w:val="${span}"/>` : "") +
    (borders ? `<w:tcBorders>${borders}</w:tcBorders>` : "") +
    (fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : "") +
    `<w:tcMar><w:top w:w="${t}" w:type="dxa"/><w:left w:w="${l}" w:type="dxa"/><w:bottom w:w="${bt}" w:type="dxa"/><w:right w:w="${r}" w:type="dxa"/></w:tcMar>` +
    `</w:tcPr>${inner || para("")}</w:tc>`
  );
}

function table(widths, rows, { borders } = {}) {
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>` +
    (borders ? `<w:tblBorders>${borders}</w:tblBorders>` : "") +
    `<w:tblLayout w:type="fixed"/></w:tblPr>` +
    `<w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>` +
    rows.map(r => `<w:tr>${r}</w:tr>`).join("") +
    `</w:tbl>`
  );
}

const border = (side, color, size = 4) => `<w:${side} w:val="single" w:sz="${size}" w:space="0" w:color="${color}"/>`;
const noBorder = side => `<w:${side} w:val="nil"/>`;

// ---------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------

const fmt = n => Number(n).toLocaleString("en-US");
// "2026-11-11" -> "11 Nov 2026". Anything unreadable is shown as it came.
function niceDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso ?? "") : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function buildBody(plan, linkId) {
  const out = [];
  const typeName = String(plan.type || "Essay");

  // Header
  out.push(para(
    run("LitMark", { b: true, size: 9, color: INK }) + run(` ${typeName.toLowerCase()} plan`, { size: 9, color: SOFT }) + tab() + run(`Built ${niceDate(plan.builtOn)}`, { size: 9, color: SOFT }),
    { after: 200, border: { side: "bottom", color: "CCCCCC", size: 6 }, rightTab: CONTENT_WIDTH }
  ));

  // Title and details
  out.push(para(run(plan.question, { b: true, size: 15, color: INK }), { after: 40 }));
  const details = [typeName, `${fmt(plan.wordCount)} words`, plan.year, plan.subject].filter(Boolean).join(", ");
  out.push(para(run(details + ".", { size: 10, color: SOFT }) + (plan.brief ? run(` Brief: ${plan.brief}`, { size: 10, color: SOFT }) : ""), { after: 80 }));
  out.push(para(
    run(" Checked ", { b: true, size: 8, color: INK, fill: LIME }) +
    run(" the papers, the quotes, the review labels, the citation counts and the word budget.  ", { size: 8.5, color: SOFT }) +
    run(" Suggested ", { b: true, size: 8, color: INK, fill: AMBER }) +
    run(" the section headings and their order. Change them to suit your argument.", { size: 8.5, color: SOFT }),
    { after: 60 }
  ));

  // Start here
  out.push(para(run("Start here", { b: true, size: 12, color: INK }), { before: 160, after: 80, keepNext: true, border: { side: "bottom", color: LIME, size: 12 } }));

  const paperBlock = (p, badge) => {
    const titleRun = run(p.title, { b: true, size: 10, color: p.url ? BLUE : INK, u: !!p.url });
    const titleXml = p.url ? `<w:hyperlink r:id="${linkId(p.url)}">${titleRun}</w:hyperlink>` : titleRun;
    const meta = [p.cite, p.journal].filter(Boolean).join(", ");
    return (
      para(titleXml + run("  ") + run(`\u00a0${badge.replace(/ /g, "\u00a0")}\u00a0`, { b: true, size: 7.5, color: "FFFFFF", fill: badge.startsWith("Cited") ? INK : BLUE }), { before: 80, after: 10, keepNext: true }) +
      (meta ? para(run(meta, { size: 8.5, color: SOFT }), { after: 20, keepNext: true }) : "") +
      para(run("“" + p.quote.text + "”", { size: 9.5, color: INK, fill: LIME }), { after: 40 })
    );
  };
  const column = (heading, papers, badgeFor, emptyText) =>
    para(run(heading, { b: true, size: 8.5, color: SOFT }), { after: 20 }) +
    (papers.length ? papers.map(p => paperBlock(p, badgeFor(p))).join("") : para(run(emptyText, { i: true, size: 9, color: SOFT }), { before: 60 }));

  const colW = [5003, 5203];
  const cellBorders = side => border(side, "FFFFFF", 36);
  out.push(table(colW, [
    cell(colW[0], column("Read these reviews first", plan.keyReviews || [], p => p.paperType || "Review",
      "No review paper in these results fit your question well enough to recommend. Try Find sources or For & against."), { fill: PAPER, margins: "80 120 80 120", borders: cellBorders("right") }) +
    cell(colW[1], column("Most cited in this area", plan.mostCited || [], p => `Cited by ${fmt(p.citedByCount)}`,
      "No paper in these results has enough citations to count as most cited."), { fill: PAPER, margins: "80 120 80 120", borders: cellBorders("left") })
  ]));

  // Outline
  out.push(para(run("Outline", { b: true, size: 12, color: INK }), { before: 200, after: 40, keepNext: true, border: { side: "bottom", color: LIME, size: 12 } }));
  if (!(plan.outline || []).length) {
    out.push(para(run("We could not suggest section headings this time. The papers above are still worth reading first. Try building the plan again, or use Find sources for your own search.", { i: true, size: 9.5, color: SOFT }), { before: 80 }));
  } else {
    out.push(para(
      run("Suggested: ", { b: true, size: 8.5, color: INK }) +
      run(`the section headings and their order. Word budgets add up to ${fmt(plan.outlineTotal)}.`, { size: 8.5, color: SOFT }),
      { before: 40, after: 80, keepNext: true }
    ));
    const w = [2100, 750, 3300, 2000, 2056];
    const head = ["Section", "Words", "What to cover", "Start with", "Find more in LitMark"].map((h, i) =>
      cell(w[i], para(run(h, { b: true, size: 8.5, color: "FFFFFF" }), { align: i === 1 ? "right" : undefined }), { fill: INK, margins: "60 80 60 80" })
    ).join("");
    const line = border("bottom", "E3E1D5", 4);
    const rows = plan.outline.map(s => {
      const start = s.startWith && s.startWith.length ? s.startWith.map(x => x.cite).join(", ") : (s.heading === "Conclusion" ? "None needed" : "Find your own");
      return [
        cell(w[0], para(run(s.heading, { b: true, size: 9, color: INK })), { borders: line, margins: "60 80 60 80" }),
        cell(w[1], para(run(fmt(s.words), { b: true, size: 9, color: INK }), { align: "right" }), { borders: line, margins: "60 80 60 80" }),
        cell(w[2], para(run(s.cover, { size: 9, color: INK })), { borders: line, margins: "60 80 60 80" }),
        cell(w[3], para(run(start, { size: 9, color: INK })), { borders: line, margins: "60 80 60 80" }),
        cell(w[4], para(run(s.query || "", { size: 9, color: BLUE })), { borders: line, margins: "60 80 60 80" })
      ].join("");
    });
    const total = [
      cell(w[0], para(run("Total", { b: true, size: 9, color: INK })), { fill: GREY, margins: "60 80 60 80" }),
      cell(w[1], para(run(fmt(plan.outlineTotal), { b: true, size: 9, color: INK }), { align: "right" }), { fill: GREY, margins: "60 80 60 80" }),
      cell(w[2] + w[3] + w[4], para(""), { fill: GREY, span: 3, margins: "60 80 60 80" })
    ].join("");
    out.push(table(w, [head, ...rows, total]));
  }

  // Footer note
  out.push(para(
    run("A plan, not a draft. ", { b: true, size: 8, color: SOFT }) +
    run("LitMark does not write any of your essay. Check your university's rules on using AI to help with planning.", { size: 8, color: SOFT }) +
    tab() + run("litmark.org", { size: 8, color: SOFT }),
    { before: 240, border: { side: "top", color: "DDDDDD", size: 6 }, rightTab: CONTENT_WIDTH }
  ));
  return out.join("");
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

// plan: what assemblePlan returns. Returns the .docx as a Buffer.
export function buildDocx(plan) {
  const links = new Map(); // url -> relationship id
  const linkId = url => {
    if (!links.has(url)) links.set(url, `rId${links.size + 2}`);
    return links.get(url);
  };
  const body = buildBody(plan, linkId);

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document ${NS}><w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="760" w:right="850" w:bottom="680" w:left="850" w:header="400" w:footer="400" w:gutter="0"/></w:sectPr>` +
    `</w:body></w:document>`;

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:color w:val="${INK}"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="250" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    `</w:styles>`;

  const relsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    [...links].map(([url, id]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlText(url)}" TargetMode="External"/>`).join("") +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  const file = (name, text) => ({ name, data: Buffer.from(text, "utf8") });
  return zip([
    file("[Content_Types].xml", contentTypes),
    file("_rels/.rels", rootRels),
    file("word/document.xml", documentXml),
    file("word/styles.xml", stylesXml),
    file("word/_rels/document.xml.rels", relsXml)
  ]);
}

// A plain ASCII name that is safe in a download header and a file system.
export function docxFilename(plan) {
  const slug = String(plan?.question ?? "")
    .normalize("NFKD").replace(/[^\x00-\x7f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .split("-").slice(0, 6).join("-");
  return `litmark-plan${slug ? "-" + slug : ""}.docx`;
}

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
