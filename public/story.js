/* Samba story-card engine — THE 1080×1920 Instagram story design, extracted
 * from the agent portal so every surface (agent portal, owner portal) renders
 * the same art-directed card: full-bleed hero with a soft scrim, overlaid
 * location/title/subtitle block, availability pill, olive info panel with the
 * icon fact row and price focal, a white contact card, and the brand footer
 * with the handwritten tagline.
 *
 * window.SambaStory.makeStoryBlob(data) -> Promise<Blob>
 * data = {
 *   name, loc, subtitle,               // strings ('' ok)
 *   availTxt,                          // 'Available now' | 'Available from X' | 'Fully booked' | null
 *   beds, baths, sqm, pool,            // numbers/strings or null
 *   mn,                                // monthly price in millions (number or string) or null
 *   heroUrls,                          // array of candidate hero image URLs (first that loads wins)
 *   prof                               // { displayName, waNumber, photo } | null → generic Samba card
 * }
 */
(function () {
  const FF = 'Satoshi,-apple-system,Helvetica,Arial,sans-serif';
  const PANEL = '#4B5540', INK = '#1B2016', ORANGE = '#E2572B', WA = '#2FA44E', GREEN = '#2C6E3F';

  function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
  function drawCover(ctx, img, x, y, w, h) {
    const s = Math.max(w / img.width, h / img.height), dw = img.width * s, dh = img.height * s;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); ctx.restore();
  }
  const STORY_ICONS = {
    bed: 'M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4M2 17h20M12 10V4',
    bath: 'M4 12h16a1 1 0 0 1 1 1v2a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-2a1 1 0 0 1 1-1zM6 12V5.5a1.5 1.5 0 0 1 3 0M8 20l-1 2M17 20l1 2',
    area: 'M3 9V3h6M3 3l7 7M21 15v6h-6M21 21l-7-7',
    pool: 'M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5s2.4 2 5 2c1.3 0 1.9-.5 2.5-1M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2s2.4 2 5 2c1.3 0 1.9-.5 2.5-1M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2s2.4 2 5 2c1.3 0 1.9-.5 2.5-1',
    pin: 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'
  };
  const WA_PATH = 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.149-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.263.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347M12.05 21.785h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.359.101 11.892c0 2.096.549 4.14 1.595 5.945L0 24l6.335-1.652a11.9 11.9 0 0 0 5.71 1.454h.005c6.585 0 11.946-5.359 11.949-11.893a11.82 11.82 0 0 0-3.484-8.463';
  function drawStroke(ctx, d, x, y, size, color, sw) {
    ctx.save(); ctx.translate(x, y); ctx.scale(size / 24, size / 24);
    ctx.strokeStyle = color; ctx.lineWidth = sw || 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.stroke(new Path2D(d)); ctx.restore();
  }
  function drawFill(ctx, d, x, y, size, color) {
    ctx.save(); ctx.translate(x, y); ctx.scale(size / 24, size / 24);
    ctx.fillStyle = color; ctx.fill(new Path2D(d)); ctx.restore();
  }
  function drawTracked(ctx, text, x, y, ls) {
    let cx = x; for (const ch of String(text)) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + ls; }
    return cx - x;
  }
  function wrapText(ctx, text, maxW) {
    const words = String(text).split(/\s+/), lines = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur); return lines;
  }
  function brushUnderline(ctx, x1, x2, y, thick, bow, color) {
    const N = 28, pts = [];
    for (let i = 0; i <= N; i++) { const t = i / N, x = x1 + (x2 - x1) * t, cy = y + bow * Math.sin(Math.PI * t), ht = (thick / 2) * Math.sin(Math.PI * t); pts.push([x, cy - ht, cy + ht]); }
    ctx.save(); ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i][0], pts[i][2]);
    ctx.closePath(); ctx.fillStyle = color; ctx.fill(); ctx.restore();
  }
  function fitText(ctx, text, maxW, base, weight, ff) {
    let sz = base; ctx.font = weight + ' ' + sz + 'px ' + ff;
    while (ctx.measureText(text).width > maxW && sz > 34) { sz -= 2; ctx.font = weight + ' ' + sz + 'px ' + ff; }
    return sz;
  }
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  async function makeStoryBlob(f) {
    const W = 1080, H = 1920, HERO = 1076, PX = 84;
    let hasCaveat = false;
    try {
      await document.fonts.load('800 88px Satoshi'); await document.fonts.load('italic 600 40px Satoshi');
      try { await document.fonts.load('700 54px "Caveat"'); hasCaveat = document.fonts.check('700 54px "Caveat"'); } catch (e) {}
      await document.fonts.ready;
    } catch (e) {}
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = PANEL; ctx.fillRect(0, 0, W, H);

    // ── Full-bleed hero ──
    let hero = null;
    for (const u of (f.heroUrls || [])) { try { hero = await loadImg(u); break; } catch (e) {} }
    if (hero) drawCover(ctx, hero, 0, 0, W, HERO);
    else { const g = ctx.createLinearGradient(0, 0, 0, HERO); g.addColorStop(0, '#7C866A'); g.addColorStop(1, PANEL); ctx.fillStyle = g; ctx.fillRect(0, 0, W, HERO); }
    const scrim = ctx.createLinearGradient(0, HERO * 0.40, 0, HERO);
    scrim.addColorStop(0, 'rgba(14,20,14,0)'); scrim.addColorStop(.45, 'rgba(14,20,14,.10)');
    scrim.addColorStop(.78, 'rgba(14,20,14,.52)'); scrim.addColorStop(1, 'rgba(14,20,14,.82)');
    ctx.fillStyle = scrim; ctx.fillRect(0, 0, W, HERO);

    // ── Hero overlay block, bottom-aligned ──
    const title = (f.name || '').toUpperCase();
    let tsz = 90; ctx.font = '800 ' + tsz + 'px ' + FF;
    let lines = wrapText(ctx, title, W - PX * 2);
    while (lines.length > 2 && tsz > 56) { tsz -= 4; ctx.font = '800 ' + tsz + 'px ' + FF; lines = wrapText(ctx, title, W - PX * 2); }
    lines.forEach(ln => { const s = fitText(ctx, ln, W - PX * 2, tsz, '800', FF); if (s < tsz) tsz = s; });
    const lineH = Math.round(tsz * 1.12);
    const gLT = 32, gTS = 30, gSP = 44, pillH = 84;
    const locH = f.loc ? 38 : 0, subH = f.subtitle ? 42 : 0, titleH = lines.length * lineH;
    const total = (locH ? locH + gLT : 0) + titleH + (subH ? gTS + subH : 0) + (f.availTxt ? gSP + pillH : 0);
    let y = (HERO - 76) - total;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    if (f.loc) {
      const loc = String(f.loc).replace(/\s*·\s*/g, ', ').toUpperCase();
      drawStroke(ctx, STORY_ICONS.pin, PX, y - 4, 34, 'rgba(255,255,255,.96)', 2.2);
      ctx.font = '600 30px ' + FF; ctx.fillStyle = 'rgba(255,255,255,.94)';
      drawTracked(ctx, loc, PX + 48, y + 2, 5);
      y += locH + gLT;
    }
    ctx.font = '800 ' + tsz + 'px ' + FF; ctx.fillStyle = '#fff';
    for (const ln of lines) { ctx.fillText(ln, PX, y); y += lineH; }
    if (f.subtitle) {
      y += gTS; ctx.font = '600 34px ' + FF; ctx.fillStyle = 'rgba(255,255,255,.82)';
      drawTracked(ctx, String(f.subtitle).toUpperCase(), PX, y, 4); y += subH;
    }
    if (f.availTxt) {
      y += gSP;
      const lbl = f.availTxt.toUpperCase(), booked = f.availTxt === 'Fully booked';
      ctx.font = '700 32px ' + FF;
      const padL = booked ? 46 : 78, padR = 48, pw = Math.ceil(ctx.measureText(lbl).width) + padL + padR;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.22)'; ctx.shadowBlur = 28; ctx.shadowOffsetY = 10;
      ctx.fillStyle = '#fff'; roundRectPath(ctx, PX, y, pw, pillH, pillH / 2); ctx.fill(); ctx.restore();
      if (!booked) { ctx.beginPath(); ctx.arc(PX + 46, y + pillH / 2, 12, 0, Math.PI * 2); ctx.fillStyle = '#3E9B54'; ctx.fill(); }
      ctx.fillStyle = booked ? '#B23E19' : GREEN; ctx.textBaseline = 'middle';
      ctx.fillText(lbl, PX + padL, y + pillH / 2 + 1); ctx.textBaseline = 'top';
    }

    // ── Olive info panel: fact row ──
    const stats = [
      { d: STORY_ICONS.bed, l: f.beds ? f.beds + ' Bedroom' : null },
      { d: STORY_ICONS.bath, l: f.baths ? f.baths + ' Bathroom' : null },
      { d: STORY_ICONS.area, l: f.sqm ? f.sqm + ' m²' : null },
      { d: STORY_ICONS.pool, l: f.pool }
    ].filter(s => s.l);
    const nS = stats.length || 1, ICON_TOP = 1160, ICON = 44, colW = (W - PX * 2) / nS;
    ctx.textAlign = 'center';
    stats.forEach((s, i) => {
      const xc = PX + colW * (i + 0.5);
      drawStroke(ctx, s.d, xc - ICON / 2, ICON_TOP, ICON, 'rgba(255,255,255,.9)', 2);
      ctx.font = '500 30px ' + FF; ctx.fillStyle = 'rgba(255,255,255,.86)'; ctx.textBaseline = 'top';
      ctx.fillText(s.l, xc, ICON_TOP + ICON + 24);
    });
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

    // ── Price focal ──
    const priceBase = 1406, priceMain = 'IDR ' + (f.mn ? f.mn : '–') + 'M';
    ctx.font = '800 88px ' + FF; ctx.fillStyle = '#fff'; ctx.fillText(priceMain, PX, priceBase);
    const pmw = ctx.measureText(priceMain).width;
    ctx.font = '500 40px ' + FF; ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fillText('/ month', PX + pmw + 22, priceBase);

    // ── Contact card (agent profile, or the generic Samba card) ──
    const prof = f.prof || null;
    const nm = prof && prof.displayName ? prof.displayName : 'Samba Rentals';
    const role = prof && prof.displayName ? 'Your Samba agent' : 'Message us to enquire';
    const waRaw = prof && prof.waNumber ? String(prof.waNumber).trim() : null;
    const waNum = waRaw ? (/^\+/.test(waRaw) ? waRaw : '+' + waRaw.replace(/[^0-9]/g, '')) : null;
    const photo = prof ? prof.photo : null;
    const cardX = PX, cardW = W - PX * 2, cardY = 1476, cardH = 216, cardR = 40;
    ctx.save(); ctx.shadowColor = 'rgba(18,26,16,.20)'; ctx.shadowBlur = 50; ctx.shadowOffsetY = 18;
    ctx.fillStyle = '#fff'; roundRectPath(ctx, cardX, cardY, cardW, cardH, cardR); ctx.fill(); ctx.restore();
    const ad = 140, avx = cardX + 40, avy = cardY + (cardH - ad) / 2, acx = avx + ad / 2, acy = avy + ad / 2;
    let drew = false;
    if (photo) { try { const ai = await loadImg(photo); ctx.save(); ctx.beginPath(); ctx.arc(acx, acy, ad / 2, 0, Math.PI * 2); ctx.clip(); drawCover(ctx, ai, avx, avy, ad, ad); ctx.restore(); drew = true; } catch (e) {} }
    if (!drew) {
      ctx.beginPath(); ctx.arc(acx, acy, ad / 2, 0, Math.PI * 2); ctx.fillStyle = ORANGE; ctx.fill();
      ctx.font = '800 62px ' + FF; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText((nm.trim()[0] || 'S').toUpperCase(), acx, acy + 2); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    const tx = avx + ad + 40, maxTW = cardX + cardW - tx - 40;
    const gName = 16, gRole = 18;
    const grpH = 46 + gName + 32 + (waNum ? gRole + 38 : 0);
    let gy = cardY + (cardH - grpH) / 2;
    ctx.textBaseline = 'top';
    const nsz = fitText(ctx, nm, maxTW, 46, '800', FF); ctx.font = '800 ' + nsz + 'px ' + FF; ctx.fillStyle = INK;
    ctx.fillText(nm, tx, gy + (46 - nsz) / 2); gy += 46 + gName;
    ctx.font = '500 32px ' + FF; ctx.fillStyle = '#7A8467'; ctx.fillText(role, tx, gy); gy += 32 + gRole;
    if (waNum) {
      drawFill(ctx, WA_PATH, tx, gy, 38, WA);
      const wsz = fitText(ctx, waNum, maxTW - 56, 38, '700', FF); ctx.font = '700 ' + wsz + 'px ' + FF;
      ctx.fillStyle = GREEN; ctx.fillText(waNum, tx + 56, gy + (38 - wsz) / 2 + 1);
    }
    ctx.textBaseline = 'alphabetic';

    // ── Footer: brand mark left, handwritten tagline right ──
    const footMid = 1800;
    const CREAM = '#F5F3EE';
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '-0.5px';
    const tl1 = "Let's find", tl2 = 'your perfect villa.';
    if (hasCaveat) {
      const tsz2 = 58, tlH = Math.round(tsz2 * 0.98);
      ctx.font = '700 ' + tsz2 + 'px "Caveat"'; ctx.fillStyle = CREAM;
      const b2 = footMid + tlH / 2;
      ctx.fillText(tl1, W - PX, b2 - tlH);
      ctx.fillText(tl2, W - PX, b2);
      const w2 = ctx.measureText(tl2).width;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      brushUnderline(ctx, W - PX - w2 + 6, W - PX + 2, b2 + 26, 11, 7, ORANGE);
    } else {
      ctx.font = 'italic 600 42px ' + FF; ctx.fillStyle = CREAM;
      ctx.fillText(tl1, W - PX, footMid - 6);
      ctx.fillText(tl2, W - PX, footMid + 46);
      const w2 = ctx.measureText(tl2).width;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      brushUnderline(ctx, W - PX - w2 + 6, W - PX + 2, footMid + 46 + 22, 10, 6, ORANGE);
    }
    ctx.textAlign = 'left';
    try {
      const lg = await loadImg('/samba-logo-white.png');
      const lh = 96, lw = lg.width / lg.height * lh;
      ctx.drawImage(lg, PX, footMid - lh / 2, lw, lh);
    } catch (e) {
      ctx.font = '800 52px ' + FF; ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
      ctx.fillText('samba', PX, footMid); ctx.textBaseline = 'alphabetic';
    }
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('export failed')), 'image/png'));
  }

  window.SambaStory = { makeStoryBlob };
})();
