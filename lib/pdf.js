// A small PDF writer, dependency-free like the rest of this repo.
//
// It does exactly what the housekeeping record needs and nothing else: A4
// pages, Helvetica text with word wrap, headings, and JPEG photos laid out
// in a grid. JPEGs go into the file as they are (DCTDecode), which is why
// this is a few hundred lines rather than a library: a WhatsApp photo is
// always a JPEG, and a PDF can carry one without decoding it.
//
// Text is WinAnsi: the few non-ASCII characters a record uses (en dash,
// middle dot, accented letters) are mapped; anything else becomes "?".
// Emoji are dropped rather than printed as question marks.

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 42;
const CONTENT_W = A4.w - 2 * MARGIN;

// Helvetica widths for the printable ASCII range, per 1000 em, so wrapping
// is right rather than approximate. Everything else is treated as 600.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_B = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

const WIN = { '–': 150, '—': 151, '·': 183, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149, 'é': 233, 'è': 232, 'à': 224, 'ü': 252, 'ö': 246, 'ä': 228, 'ç': 231, 'ñ': 241, 'í': 237, 'ó': 243, 'ú': 250, 'á': 225 };
function winAnsi(str) {
  const out = [];
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c < 127) out.push(c);
    else if (c === 10) out.push(10);
    else if (WIN[ch] != null) out.push(WIN[ch]);
    else if (c >= 160 && c < 256) out.push(c);
    else if (c > 0x2000 && c < 0x3000 || c > 0xffff || (c >= 0xd800 && c <= 0xdfff)) continue;   // punctuation/emoji: drop
    else out.push(63);
  }
  return Buffer.from(out);
}
function textWidth(str, size, bold) {
  const tbl = bold ? HELV_B : HELV;
  let w = 0;
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    w += (c >= 32 && c < 127) ? tbl[c - 32] : 600;
  }
  return w * size / 1000;
}
function wrap(str, size, bold, maxW) {
  const lines = [];
  for (const para of String(str).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const cand = line ? line + ' ' + w : w;
      if (textWidth(cand, size, bold) <= maxW || !line) line = cand;
      else { lines.push(line); line = w; }
    }
    lines.push(line);
  }
  return lines;
}
const esc = (buf) => {
  const out = [];
  for (const b of buf) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) { out.push(0x5c, b); }
    else if (b < 32 || b > 126) { out.push(...Buffer.from('\\' + b.toString(8).padStart(3, '0'))); }
    else out.push(b);
  }
  return Buffer.from(out);
};

// JPEG: walk the markers to the first SOF and read height, width, components.
function jpegInfo(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), components: buf[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

// ── The document ────────────────────────────────────────────────────
// A tiny layout engine: a cursor moving down the page, a new page when the
// next block would not fit. Blocks: heading, text, kv rows, photo grid.
export function buildPdf({ title, subtitle, meta = [], sections = [], photos = [], footer = '' }) {
  const pages = [];      // each: { ops: [], images: [] }
  const images = [];     // { name, buf, info }
  let page = null, y = 0;
  const newPage = () => { page = { ops: [] }; pages.push(page); y = A4.h - MARGIN; };
  const need = (h) => { if (!page || y - h < MARGIN + 18) newPage(); };
  const text = (str, { size = 10.5, bold = false, color = '0 0 0', x = MARGIN, maxW = CONTENT_W, lead = 1.35, after = 4 } = {}) => {
    const lines = wrap(str, size, bold, maxW);
    for (const ln of lines) {
      need(size * lead);
      y -= size * lead;
      page.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color} rg ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(winAnsi(ln)).toString('latin1')}) Tj ET`);
    }
    y -= after;
  };
  const rule = () => { need(8); y -= 4; page.ops.push(`0.86 0.83 0.78 RG 0.6 w ${MARGIN} ${y.toFixed(2)} m ${(A4.w - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`); y -= 8; };

  newPage();
  // Brand line
  page.ops.push(`0.784 0.333 0.176 rg ${MARGIN} ${(y - 9).toFixed(2)} 9 9 re f`);
  page.ops.push(`BT /F2 8 Tf 0.43 0.41 0.38 rg ${MARGIN + 14} ${(y - 8).toFixed(2)} Td (SAMBA MANAGEMENT) Tj ET`);
  y -= 24;
  text(title, { size: 20, bold: true, after: 2 });
  if (subtitle) text(subtitle, { size: 11, color: '0.43 0.41 0.38', after: 6 });
  for (const [k, v] of meta) {
    need(15);
    y -= 14;
    page.ops.push(`BT /F2 9.5 Tf 0.43 0.41 0.38 rg ${MARGIN} ${y.toFixed(2)} Td (${esc(winAnsi(k)).toString('latin1')}) Tj ET`);
    page.ops.push(`BT /F1 9.5 Tf 0 0 0 rg ${MARGIN + 110} ${y.toFixed(2)} Td (${esc(winAnsi(v)).toString('latin1')}) Tj ET`);
  }
  y -= 4;
  rule();

  for (const sec of sections) {
    if (!sec || (!sec.lines?.length && !sec.text)) continue;
    need(30);
    text(sec.heading, { size: 9, bold: true, color: '0.784 0.333 0.176', after: 2 });
    if (sec.text) text(sec.text, { size: 10.5 });
    for (const ln of (sec.lines || [])) text('•  ' + ln, { size: 10.5, x: MARGIN + 6, maxW: CONTENT_W - 6, after: 1 });
    y -= 6;
  }

  // Photos: three per row, square cells, caption under each.
  const usable = photos.map((p, i) => ({ ...p, info: jpegInfo(p.buf), i })).filter(p => p.info);
  if (usable.length) {
    need(30);
    text(`PHOTOS (${usable.length})`, { size: 9, bold: true, color: '0.784 0.333 0.176', after: 4 });
    const cols = 3, gap = 8, cell = (CONTENT_W - gap * (cols - 1)) / cols, capH = 14;
    for (let n = 0; n < usable.length; n += cols) {
      need(cell + capH + 8);
      const rowTop = y;
      usable.slice(n, n + cols).forEach((p, k) => {
        const name = `Im${images.length + 1}`;
        images.push({ name, buf: p.buf, info: p.info });
        const x = MARGIN + k * (cell + gap);
        const r = Math.min(cell / p.info.width, cell / p.info.height);
        const w = p.info.width * r, h = p.info.height * r;
        const ox = x + (cell - w) / 2, oy = rowTop - cell + (cell - h) / 2;
        page.ops.push(`q 0.94 0.92 0.89 rg ${x.toFixed(2)} ${(rowTop - cell).toFixed(2)} ${cell.toFixed(2)} ${cell.toFixed(2)} re f Q`);
        page.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${ox.toFixed(2)} ${oy.toFixed(2)} cm /${name} Do Q`);
        page.images = page.images || []; page.images.push(name);
        const cap = p.caption || `Photo ${p.i + 1}`;
        page.ops.push(`BT /F1 8 Tf 0.43 0.41 0.38 rg ${x.toFixed(2)} ${(rowTop - cell - 10).toFixed(2)} Td (${esc(winAnsi(cap.slice(0, 40))).toString('latin1')}) Tj ET`);
      });
      y = rowTop - cell - capH - 6;
    }
  }
  if (photos.length > usable.length) text(`${photos.length - usable.length} photo(s) could not be embedded (not JPEG).`, { size: 8.5, color: '0.43 0.41 0.38' });

  // Footer on every page.
  pages.forEach((pg, i) => {
    pg.ops.push(`BT /F1 8 Tf 0.43 0.41 0.38 rg ${MARGIN} ${(MARGIN - 14).toFixed(2)} Td (${esc(winAnsi(footer)).toString('latin1')}) Tj ET`);
    const pn = `${i + 1} / ${pages.length}`;
    pg.ops.push(`BT /F1 8 Tf 0.43 0.41 0.38 rg ${(A4.w - MARGIN - textWidth(pn, 8)).toFixed(2)} ${(MARGIN - 14).toFixed(2)} Td (${pn}) Tj ET`);
  });

  // ── Serialise ─────────────────────────────────────────────────────
  const objs = [];                       // Buffers, 1-based
  const add = (buf) => { objs.push(buf); return objs.length; };
  const fontN = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  const fontB = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
  const imgIds = {};
  for (const im of images) {
    const cs = im.info.components === 1 ? '/DeviceGray' : im.info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    const head = Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${im.info.width} /Height ${im.info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.buf.length}${im.info.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''} >>\nstream\n`);
    imgIds[im.name] = add(Buffer.concat([head, im.buf, Buffer.from('\nendstream')]));
  }
  const pagesId = objs.length + 1 + pages.length * 2;   // reserved after page+content pairs
  const pageIds = [];
  for (const pg of pages) {
    const content = Buffer.from(pg.ops.join('\n'), 'latin1');
    const cId = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]));
    const xo = (pg.images || []).map(n => `/${n} ${imgIds[n]} 0 R`).join(' ');
    const pId = add(Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Contents ${cId} 0 R /Resources << /Font << /F1 ${fontN} 0 R /F2 ${fontB} 0 R >> /XObject << ${xo} >> >> >>`));
    pageIds.push(pId);
  }
  const pagesReal = add(Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`));
  if (pagesReal !== pagesId) throw new Error('pdf: object numbering drifted');
  const catalog = add(Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`));

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    parts.push(b); pos += b.length;
  });
  const xref = ['xref', `0 ${objs.length + 1}`, '0000000000 65535 f '];
  for (const off of offsets) xref.push(String(off).padStart(10, '0') + ' 00000 n ');
  parts.push(Buffer.from(xref.join('\n') + `\ntrailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(parts);
}
