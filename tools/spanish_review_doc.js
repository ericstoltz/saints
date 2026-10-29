// Builds a Word file with all the Spanish text in the app, for review by a Spanish reader.
// Run: node tools/spanish_review_doc.js OUT.docx
// Headings use Word's built-in styles so Google Docs shows them in its outline panel.
// Each saint's block starts with an "ID:" line so an edited copy can be mapped back.
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, AlignmentType,
} = require('docx');

const APP = path.join(__dirname, '..', 'app');
global.window = {};
require(path.join(APP, 'data/content.js'));
require(path.join(APP, 'data/saints.js'));
require(path.join(APP, 'data/saints.es.js'));
const C = window.CONTENT, S = window.SAINTS, ES = window.SAINTS_ES;
const en = C.en, es = C.es;

// ---- same Spanish date rules as app/js/app.js ----
const MONTHS_ES = { January: 'enero', February: 'febrero', March: 'marzo', April: 'abril', May: 'mayo', June: 'junio',
  July: 'julio', August: 'agosto', September: 'septiembre', October: 'octubre', November: 'noviembre', December: 'diciembre' };
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];
function feastEs(f) {
  if (!f) return f;
  if (f === 'Easter Day') return 'Domingo de Pascua';
  const m = f.match(/^(\w+) (\d+)$/);
  return m ? m[2] + ' de ' + MONTHS_ES[m[1]] : f;
}
function datesEs(d) {
  if (!d) return d;
  return d
    .replace(/(\d+)(?:st|nd|rd|th)–(\d+)(?:st|nd|rd|th)\? century/, (_, a, b) => 'siglos ' + ROMAN[+a] + '–' + ROMAN[+b] + '?')
    .replace(/(\d+)(?:st|nd|rd|th) century/, (_, a) => 'siglo ' + ROMAN[+a])
    .replace(/BCE/g, 'a. e. c.').replace(/^reigned /, 'reinó ');
}
const MEMBER_DATES = { 'Nellie Lincoln': '1862–1956' };

// ---- styling helpers ----
const FONT = 'Arial';
const GREY = '6B6B6B';
const W = 9360; // text width, US Letter with 1" margins

// HTML (only <em> and the source <span> occur) -> runs. Returns { main, source }.
function splitSource(html) {
  const m = html.match(/^([\s\S]*?)<span class="profile__source">([\s\S]*)<\/span>\s*$/);
  return m ? { main: m[1], source: m[2] } : { main: html, source: null };
}
function runs(html, opts = {}) {
  const out = [];
  html.split(/(<em>[\s\S]*?<\/em>)/).forEach((part) => {
    if (!part) return;
    const em = part.startsWith('<em>');
    const text = part.replace(/<\/?em>/g, '');
    out.push(new TextRun({ text, italics: em || !!opts.italics, color: opts.color, size: opts.size }));
  });
  return out;
}
const label = (t) => new TextRun({ text: t + ' ', bold: true });
function field(lbl, html) {
  return new Paragraph({ spacing: { after: 80 }, children: [label(lbl), ...runs(html || '')] });
}
function idLine(text) {
  return new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text, color: GREY, size: 18 })] });
}
function englishRef(html, lbl = 'English (reference):') {
  return new Paragraph({
    spacing: { before: 60, after: 200 },
    indent: { left: 360 },
    children: [new TextRun({ text: lbl + ' ', bold: true, color: GREY, size: 18 }), ...runs(html, { color: GREY, size: 18 })],
  });
}
const h1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun(t)] });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const p = (t, o = {}) => new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: t, ...o })] });

// ---- interface strings ----
const UI_GROUPS = [
  ['Loading screen', ['loadingQuote', 'loadingQuoteBy']],
  ['Welcome screen', ['introTitle', 'church', 'introQuote', 'introQuoteBy', 'introCameraNote', 'allowCamera', 'skipToList']],
  ['Desktop screen', ['desktopTitle', 'desktopMessage', 'continue']],
  ['Top bar and menu', ['appName', 'churchName', 'menu', 'close', 'skip', 'navCamera', 'navBrowse', 'navCommentary', 'navIconographer']],
  ['Camera', ['cameraStarting', 'cameraPoint', 'cameraTap', 'cameraDenied', 'cameraTryAgain']],
  ['Guessing game', ['whoIsThis', 'letMeGuess', 'tellMe', 'guessLabel', 'guessPlaceholder', 'findOut', 'youreRight', 'notQuite', 'lookingClosely', 'oneOfThese', 'someoneElse']],
  ['Browse list', ['browseTitle', 'browseIntro', 'filterLabel', 'filterPlaceholder', 'noResults', 'otherIconography']],
  ['Saint profile', ['celebratedOn', 'done', 'previous', 'next']],
];
const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
const borders = { top: border, bottom: border, left: border, right: border };
const COLS = [1900, 3730, 3730];
function cell(children, width, head) {
  return new TableCell({
    borders, width: { size: width, type: WidthType.DXA },
    shading: head ? { fill: 'E8EDF5', type: ShadingType.CLEAR, color: 'auto' } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children,
  });
}
function uiTable(keys) {
  const head = new TableRow({ tableHeader: true, children: ['ID', 'English', 'Español'].map((t, i) =>
    cell([new Paragraph({ children: [new TextRun({ text: t, bold: true })] })], COLS[i], true)) });
  const rows = keys.map((k) => new TableRow({ children: [
    cell([new Paragraph({ children: [new TextRun({ text: k, color: GREY, size: 16 })] })], COLS[0]),
    cell([new Paragraph({ children: [new TextRun({ text: en[k], color: GREY, size: 20 })] })], COLS[1]),
    cell([new Paragraph({ children: [new TextRun({ text: es[k], size: 20 })] })], COLS[2]),
  ] }));
  return new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: COLS, rows: [head, ...rows] });
}

const body = [];

// ---- title and instructions ----
body.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('Los Santos Danzantes: texto en español')] }));
body.push(p('All the Spanish text in The Dancing Saints app, for review. Generated ' + new Date().toISOString().slice(0, 10) + '.', { color: GREY }));
body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('How to review')] }));
[
  'Use the outline panel on the left to jump between sections and saints.',
  'Edit the Spanish text in place. Grey text is the English original, shown for reference only; changes to it are ignored.',
  'Please keep the headings, the grey ID lines and the bold field labels (Nombre, Fechas, Se celebra el, Texto, Fuente) as they are, so each edit can be matched back to the right place in the app. Comments and suggested edits are welcome too.',
  'Italics are kept (book and album titles).',
  'Dates and feast days are converted from English automatically. If one is wrong, correct it here and it will be fixed in the app.',
  'Saints are listed A–Z by first name, in the same order as the Spanish list in the app.',
].forEach((t) => body.push(new Paragraph({ spacing: { after: 100 }, bullet: { level: 0 }, children: [new TextRun(t)] })));

// ---- interface ----
body.push(h1('Interface'));
body.push(p('Buttons, labels and short messages. Edit the Español column only.', { color: GREY }));
UI_GROUPS.forEach(([title, keys]) => {
  body.push(h2(title));
  body.push(uiTable(keys));
  body.push(new Paragraph({ children: [] }));
});
body.push(p('In “Se celebra el {date}”, {date} is filled in by the app (for example “Se celebra el 12 de enero”). Please keep {date} as is.', { color: GREY, size: 18 }));

// ---- commentary page ----
body.push(h1('Commentary page'));
body.push(h2('Heading'));
body.push(idLine('ID: commentary-heading'));
body.push(field('Eyebrow / Antetítulo:', es.commentaryEyebrow)); body.push(englishRef(en.commentaryEyebrow));
body.push(field('Título:', es.commentaryTitle)); body.push(englishRef(en.commentaryTitle));
body.push(field('Autor:', es.commentaryBy)); body.push(englishRef(en.commentaryBy));
body.push(field('Foto (texto alternativo):', es.commentaryPhotoAlt)); body.push(englishRef(en.commentaryPhotoAlt));
body.push(h2('Text'));
es.commentary.forEach((t, i) => {
  body.push(field('Párrafo ' + (i + 1) + ':', t));
  body.push(englishRef(en.commentary[i]));
});
body.push(h2('Poem'));
es.commentaryPoem.forEach((t, i) => {
  body.push(field('Verso ' + (i + 1) + ':', t));
  body.push(englishRef(en.commentaryPoem[i]));
});
body.push(p('The poem is signed “— ' + es.introQuoteBy + '” (same text as the welcome screen).', { color: GREY, size: 18 }));

// ---- iconographer page ----
body.push(h1('About the iconographer page'));
body.push(h2('Heading'));
body.push(idLine('ID: iconographer-heading'));
body.push(field('Eyebrow / Antetítulo:', es.iconographerEyebrow)); body.push(englishRef(en.iconographerEyebrow));
body.push(field('Título:', es.iconographerTitle)); body.push(englishRef(en.iconographerTitle));
body.push(field('Foto (texto alternativo):', es.iconographerPhotoAlt)); body.push(englishRef(en.iconographerPhotoAlt));
body.push(h2('Text'));
es.iconographer.forEach((t, i) => {
  body.push(field('Párrafo ' + (i + 1) + ':', t));
  body.push(englishRef(en.iconographer[i]));
});

// ---- saints ----
const byId = Object.fromEntries(S.saints.map((s) => [s.id, s]));
const esName = (s) => (ES[s.id] && ES[s.id].name) || s.name;
const shown = (e) => {
  const s = byId[e.id];
  return e.label === s.name ? esName(s) : (es.memberNames[e.label] || e.label);
};
const list = S.list.slice().sort((a, b) => shown(a).localeCompare(shown(b), 'es', { sensitivity: 'base' }));

function profile(s, member) {
  const tx = ES[s.id] || {};
  if (member) {
    const name = es.memberNames[member] || member;
    body.push(h2(name));
    body.push(idLine('ID: ' + s.id + ' / ' + member + ' · Individual profile. It shows the shared text of “' + esName(s) + '”, which is reviewed under that name.'));
    body.push(field('Nombre:', name));
    if (name !== member) body.push(englishRef(member));
    if (MEMBER_DATES[member]) body.push(field('Fechas:', MEMBER_DATES[member]));
    if (s.feast) body.push(field('Se celebra el:', feastEs(s.feast)));
    return;
  }
  const name = esName(s);
  body.push(h2(name));
  body.push(idLine('ID: ' + s.id + (name !== s.name ? ' · English name: ' + s.name : '')));
  body.push(field('Nombre:', name));
  const dates = tx.lifespan || datesEs(s.lifespan);
  if (dates) body.push(field('Fechas:', dates));
  if (s.feast) body.push(field('Se celebra el:', feastEs(s.feast)));
  const b = splitSource(tx.bio || s.bio), be = splitSource(s.bio);
  body.push(field('Texto:', b.main));
  if (!tx.bio) body.push(p('(No Spanish text yet: the app shows the English.)', { color: 'B00020', size: 18 }));
  body.push(englishRef(be.main));
  if (b.source) { body.push(field('Fuente:', b.source)); body.push(englishRef(be.source)); }
}

body.push(h1('Saints'));
body.push(p(list.length + ' entries, A–Z by first name as in the app. Sergio, Baco, Nellie Lincoln and Dorothy Lincoln also have their own entries; their text is the shared pair profile.', { color: GREY }));
list.forEach((e) => {
  const s = byId[e.id];
  profile(s, e.label !== s.name ? e.label : null);
});

body.push(h1('Other iconography'));
body.push(p('Shown at the end of the list under “' + es.otherIconography + '”.', { color: GREY }));
S.saints.filter((s) => s.kind === 'mural').forEach((s) => profile(s));

// ---- document ----
const doc = new Document({
  creator: 'The Dancing Saints',
  title: 'Los Santos Danzantes: texto en español',
  styles: {
    default: {
      document: { run: { font: FONT, size: 22 } },
      title: { run: { size: 44, bold: true, color: '14254C', font: FONT }, paragraph: { spacing: { after: 120 } } },
      heading1: { run: { size: 34, bold: true, color: '14254C', font: FONT }, paragraph: { spacing: { before: 240, after: 160 } } },
      heading2: { run: { size: 26, bold: true, color: '14254C', font: FONT }, paragraph: { spacing: { before: 320, after: 60 }, keepNext: true } },
    },
    // docx-js doesn't define Normal, which the heading styles are based on; readers that follow
    // that chain (pandoc, some importers) then miss the headings.
    paragraphStyles: [{ id: 'Normal', name: 'Normal', quickFormat: true, run: { font: FONT, size: 22 } }],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
    children: body,
  }],
});
// Word's built-in heading styles are named in lowercase ("heading 1"). Google Docs and pandoc
// recognise headings by that name, so fix the names docx-js writes and add outline levels.
Packer.toBuffer(doc).then(async (buf) => {
  const JSZip = require(require.resolve('jszip', { paths: [path.dirname(require.resolve('docx'))] }));
  const zip = await JSZip.loadAsync(buf);
  let styles = await zip.file('word/styles.xml').async('string');
  [1, 2].forEach((n) => {
    styles = styles
      .replace('<w:name w:val="Heading ' + n + '"/>', '<w:name w:val="heading ' + n + '"/>')
      .replace(new RegExp('(w:styleId="Heading' + n + '">[\\s\\S]*?)</w:pPr>'), '$1<w:outlineLvl w:val="' + (n - 1) + '"/></w:pPr>');
  });
  zip.file('word/styles.xml', styles);
  fs.writeFileSync(process.argv[2] || 'spanish-review.docx', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  console.log('wrote', process.argv[2], list.length, 'list entries');
});
