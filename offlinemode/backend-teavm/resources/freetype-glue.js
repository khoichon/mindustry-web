// FreeType emulation for the TeaVM backend, via opentype.js + Canvas2D
// rasterization. Ported from the CheerpJ reference build's
// shim/natives-freetype.js (same metric conventions, verified working there):
//
//  - All metrics returned to Java are in 26.6 fixed point, like FreeType:
//      scaled(v) = round(v / unitsPerEm * sizePx * 64)
//  - Rasterized bitmaps are FT_PIXEL_MODE_GRAY (8-bit alpha only), pixelMode 2.
//  - The FT stroker takes a *radius*; canvas lineWidth = radius * 2.
//  - bitmap top is measured in rows above the baseline (y-up), so
//      top = -ceil(bb.y1) - pad
//
// Handles are ints; Java passes/returns them through JSBody calls and pulls
// bulk pixel data through a TeaVM-owned Uint8Array (copyAlpha).
(() => {
  const registry = new Map();
  let nextId = 1;
  const alloc = (obj) => { const id = nextId++; registry.set(id, obj); return id; };
  const get = (id) => registry.get(id);

  const scaled = (f, v) => Math.round(((v / f.font.unitsPerEm) || 0) * f.sizePx * 64);

  // ---------- rasterization ----------
  let scratch = null;
  function cmdsToPath2D(path) {
    const p = new Path2D();
    const c = path.commands;
    for (let i = 0; i < c.length; i++) {
      const cmd = c[i];
      if (cmd.type === "M") p.moveTo(cmd.x, cmd.y);
      else if (cmd.type === "L") p.lineTo(cmd.x, cmd.y);
      else if (cmd.type === "C") p.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
      else if (cmd.type === "Q") p.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y);
      else if (cmd.type === "Z") p.closePath();
    }
    return p;
  }

  function rasterize(face, codePoint, strokeW) {
    try {
      const sizePx = face.sizePx;
      const path = face.font.getPath(String.fromCodePoint(codePoint), 0, 0, sizePx, null, true);
      const bb = path.getBoundingBox();
      if (!isFinite(bb.x1) || bb.x2 - bb.x1 <= 0 || bb.y2 - bb.y1 <= 0) {
        return alloc({ w: 0, h: 0, left: 0, top: 0, alpha: new Uint8Array(0) });
      }
      const pad = Math.ceil(strokeW) + 1;
      const w = Math.min(1024, Math.ceil(bb.x2 - bb.x1) + pad * 2);
      const h = Math.min(1024, Math.ceil(bb.y2 - bb.y1) + pad * 2);
      if (!scratch || scratch.w < w || scratch.h < h) {
        const cw = Math.max(64, w), ch = Math.max(64, h);
        const canvas = typeof OffscreenCanvas !== "undefined"
          ? new OffscreenCanvas(cw, ch)
          : Object.assign(document.createElement("canvas"), { width: cw, height: ch });
        scratch = { canvas, w: cw, h: ch, ctx: canvas.getContext("2d", { willReadFrequently: true }) };
      }
      const ctx = scratch.ctx;
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(-bb.x1 + pad, -bb.y1 + pad);
      const p2d = cmdsToPath2D(path);
      if (strokeW > 0) {
        ctx.lineWidth = strokeW * 2; // FT stroker width = radius; line width = 2 * radius
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.strokeStyle = "#fff";
        ctx.stroke(p2d);
      }
      ctx.fillStyle = "#fff";
      ctx.fill(p2d);
      ctx.restore();
      const img = ctx.getImageData(0, 0, w, h).data;
      const alpha = new Uint8Array(w * h);
      for (let i = 0; i < alpha.length; i++) alpha[i] = img[i * 4 + 3];
      return alloc({
        w, h, alpha,
        left: Math.floor(bb.x1) - pad,
        top: -Math.ceil(bb.y1) - pad, // FT bitmap_top: rows above baseline (y-up)
      });
    } catch (e) {
      console.error("[FT] rasterize", String.fromCodePoint(codePoint), e && e.message);
      return 0;
    }
  }

  function loadGlyphByIndex(face, glyphIndex, code) {
    const glyph = face.font.glyphs.get(glyphIndex) || face.font.glyphs.get(0);
    if (!glyph) { face.current = null; return false; }
    const scale = face.sizePx / face.font.unitsPerEm;
    face.current = {
      glyph,
      advanceX: Math.round((glyph.advanceWidth || 0) * scale * 64),
      code: code,
    };
    return true;
  }

  const FT = {
    parseError: "",

    init() { return alloc({ t: "lib" }); },
    dispose(h) { registry.delete(h); },

    // bytes: a TeaVM-backed Uint8Array view over the font file contents.
    newFace(libH, bytes, faceIndex) {
      try {
        // Copy: opentype wants a plain ArrayBuffer, and re-uses the input.
        const copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        const font = opentype.parse(copy.buffer);
        return alloc({
          t: "face", font, sizePx: 16,
          faceFlags: 1 | 8 | 16 | 64 | 2048, // SCALABLE|SFNT|HORIZONTAL|KERNING|HINTER
          current: null,
        });
      } catch (e) {
        FT.parseError = String(e && e.message || e);
        console.error("[FT] newFace", FT.parseError);
        return 0;
      }
    },

    strokerNew(libH) { return alloc({ t: "stroker", widthPx: 0 }); },
    strokerSet(h, w26) { const s = get(h); if (s) s.widthPx = w26 / 64; },

    getFaceFlags(h) { return (get(h) || {}).faceFlags || 0; },
    getNumGlyphs(h) { const f = get(h); return f ? f.font.numGlyphs : 0; },

    setCharSize(h, cw, ch, hres, vres) {
      const f = get(h); if (!f) return false;
      f.sizePx = Math.max(1, Math.round(((ch >> 6) * vres) / 72));
      return true;
    },
    setPixelSizes(h, w, hh) {
      const f = get(h); if (!f) return false;
      f.sizePx = Math.max(1, hh || w || 16);
      return true;
    },

    getAscender(h) { const f = get(h); return scaled(f, f.font.ascender); },
    getDescender(h) { const f = get(h); return scaled(f, f.font.descender); },
    getHeight(h) { const f = get(h); return scaled(f, f.font.ascender - f.font.descender); },
    getMaxAdvance(h) { const f = get(h); return scaled(f, f.font.unitsPerEm * 0.6); },
    getUnderlinePosition() { return -64 * 2; },
    getUnderlineThickness() { return 64; },

    hasKerning(h) {
      const f = get(h);
      try { return !!(f.font.tables.kern || (f.font.tables.gpos && f.font.tables.gpos.kernPairs)); }
      catch (e) { return false; }
    },
    getKerning(h, gl, gr) {
      const f = get(h);
      try {
        const k = f.font.getKerningValue(f.font.glyphs.get(gl), f.font.glyphs.get(gr));
        return scaled(f, k);
      } catch (e) { return 0; }
    },
    getCharIndex(h, cp) {
      const f = get(h);
      try { return f.font.charToGlyphIndex(String.fromCodePoint(cp)); } catch (e) { return 0; }
    },

    loadChar(h, cp) {
      const f = get(h); if (!f) return false;
      return loadGlyphByIndex(f, FT.getCharIndex(h, cp), cp);
    },
    loadGlyph(h, gi) {
      const f = get(h); if (!f) return false;
      let code = 0;
      try { const g = f.font.glyphs.get(gi); code = g && g.unicode != null ? g.unicode : 0; } catch (e) {}
      return loadGlyphByIndex(f, gi, code);
    },

    // current-glyph slot state (GlyphSlot/GlyphMetrics read these)
    slotAdvanceX(h) { const f = get(h); return (f && f.current && f.current.advanceX) || 0; },
    slotHasGlyph(h) { const f = get(h); return !!(f && f.current); },

    rasterize(h, strokeW) {
      const f = get(h);
      if (!f || !f.current) return 0;
      return rasterize(f, f.current.code, strokeW);
    },

    bitmapRows(h) { const b = get(h); return b ? b.h : 0; },
    bitmapWidth(h) { const b = get(h); return b ? b.w : 0; },
    bitmapLeft(h) { const b = get(h); return b ? b.left : 0; },
    bitmapTop(h) { const b = get(h); return b ? b.top : 0; },
    copyAlpha(h, out) { const b = get(h); if (b && out) out.set(b.alpha); },
  };

  globalThis.ArcFreeType = FT;
})();
