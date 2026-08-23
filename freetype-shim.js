// freetype-shim.js
// Real implementation of arc.freetype.FreeType's native layer, backed by the browser's
// own font engine (FontFace API + Canvas2D) instead of actual FreeType/libfreetype.
//
// WHY THIS EXISTS: stub-natives.js used to have a fully-stubbed FreeType block (fake
// handles, no real glyph data) as a placeholder to get past startup without crashing.
// That's fine for booting, but Mindustry can't show any UI text with it. This file
// replaces that block with something that actually rasterizes glyphs.
//
// IMPORTANT MANGLING BUG THIS FIXES: the old stub registered every FreeType native
// under the flat name `Java_arc_freetype_FreeType_<method>`. That's only correct for
// the couple of methods that really are direct members of the `FreeType` class
// (getLastErrorCode, initFreeTypeJni). Almost everything else - doneFace, loadChar,
// getMetrics, getBuffer, etc. - is declared on a *nested static class*
// (FreeType.Face, FreeType.Library, FreeType.Bitmap, FreeType.GlyphSlot, ...), which
// under real JNI mangling gets an extra `_00024<ClassName>_` segment (the same way a
// literal underscore in a method name becomes `_1` - see sdl-shim.js's mangle()).
// Registering these flat means CheerpJ can never find them, since the mangled names
// don't match. See nativeIn() below.
//
// ARCHITECTURE: FreeType's real API is entirely address-based (every Java-side object
// - Library/Face/Size/SizeMetrics/GlyphSlot/Glyph/Bitmap/GlyphMetrics/Stroker - is just
// a `long` pointer into native memory). We reproduce that shape with a JS handle table
// (BigInt addresses -> plain JS objects) rather than trying to back it with real
// pointers, same general pattern as buffers-shim.js's fake addresses.
//
// GLYPH RENDERING STRATEGY: newMemoryFace's ByteBuffer argument holds the actual font
// file bytes (ttf/otf), which we hand to the browser's own FontFace API and register
// under a synthetic font-family name. From then on, measuring/rendering a glyph is just
// normal Canvas2D: ctx.font = "<px>px familyName", ctx.measureText()/ctx.fillText(),
// and the resulting alpha channel becomes the FT_PIXEL_MODE_GRAY coverage bitmap Arc
// expects. All FreeType metrics that are supposed to be in 26.6 fixed-point (see
// FreeType.toInt() on the Java side: `((v + 63) & -64) >> 6`) are produced by
// multiplying our plain pixel measurements by 64 - callers just divide back out.
//
// KNOWN SIMPLIFICATIONS (fine for Mindustry's UI, not a general FreeType clone):
//  - Kerning is reported as unavailable (hasKerning() = false) rather than computed -
//    matches the plan already noted in the file this replaces: pixel-perfect kerning
//    isn't needed for the UI to be usable.
//  - getCharIndex() is the identity function (charCode straight through) instead of a
//    real cmap lookup - fine since we never report a glyph as "missing".
//  - Bitmap-strike/embedded-bitmap fonts (checkForBitmapFont()'s FT_FACE_FLAG_FIXED_SIZES
//    path) are not supported - getFaceFlags() always reports 0, so Arc always takes the
//    normal scalable-outline-font path, which is what every font Mindustry ships is.
//  - Stroker/outlined-glyph support (Glyph.strokeBorder/toBitmap) is a real but rough
//    approximation using ctx.strokeText() at the requested radius, not true FT outline
//    stroking - good enough for drop-shadow/outline-styled UI text, not pixel-exact.

(function (global) {
  'use strict';
  const NATIVES = {};
  const PKG = 'Java_arc_freetype_FreeType_';
  function native(name, fn) { NATIVES[PKG + name] = fn; }
  function nativeIn(cls, name, fn) { NATIVES[PKG + '00024' + cls + '_' + name] = fn; }

  // ---- handle table -----------------------------------------------------------
  // ADDRESSES ARE PLAIN JS NUMBERS, NOT BigInt. CheerpJ marshals scalar Java
  // `long` values between JS natives and Java via LiveConnect rules (JS Number
  // <-> long): real browser testing showed a BigInt return value (e.g. 1n) reads
  // back as 0 on the Java side - which made initFreeTypeJni() look like a null
  // library pointer and crashed font init with "Couldn't initialize FreeType
  // library, FreeType error code: 0". (long[] ARRAYS are different: those are
  // BigInt64Array with BigInt elements, per the documented extension - see
  // pixmap-shim.js's nativeData[0] = 0n, which is correct.) Long ARGUMENTS
  // flowing the other way (Java -> us) may arrive as Number or BigInt depending
  // on the call path, so h() normalizes either into the Number keys we store.
  let nextAddr = 1;
  const objects = new Map(); // Number address -> plain JS object
  function h(addr) { return typeof addr === 'bigint' ? Number(addr) : addr; }
  function alloc(obj) { const addr = nextAddr++; objects.set(addr, obj); return addr; }
  function get(addr) { return addr == null ? null : objects.get(h(addr)) || null; }
  function del(addr) { if (addr != null) objects.delete(h(addr)); }

  let lastError = 0;
  native('getLastErrorCode', async () => lastError);

  // ---- shared measuring canvas --------------------------------------------------
  const measureCanvas = new OffscreenCanvas(8, 8);
  const mctx = measureCanvas.getContext('2d', { willReadFrequently: true });
  mctx.textBaseline = 'alphabetic';
  mctx.textAlign = 'left';

  function setFont(ctx, face) { ctx.font = face.pixelSize + 'px "' + face.family + '"'; }

  // Measures a single character for `face` at its *current* pixelSize. Returns pixel
  // (not fixed-point) values - callers multiply by 64 where FT expects 26.6.
  function measureGlyph(face, ch) {
    setFont(mctx, face);
    const m = mctx.measureText(ch);
    const left = m.actualBoundingBoxLeft || 0;
    const right = m.actualBoundingBoxRight || 0;
    const ascent = m.actualBoundingBoxAscent || 0;
    const descent = m.actualBoundingBoxDescent || 0;
    return {
      char: ch,
      advance: m.width,
      width: Math.max(0, Math.ceil(left + right)),
      rows: Math.max(0, Math.ceil(ascent + descent)),
      originX: left,      // x to draw at so the glyph's left edge lands at canvas x=0
      baselineY: ascent,  // y to draw at (baseline) so the top edge lands at canvas y=0
      bitmapLeft: Math.round(-left),
      bitmapTop: Math.round(ascent),
    };
  }

  // Face-level (not per-size) font metrics, still computed at the face's current
  // pixelSize since we have no separate "unscaled font units" model. Cached per
  // pixelSize - the generator queries these metrics repeatedly during font
  // generation and each uncached call costs 2-3 measureText round trips.
  function faceMetrics(face) {
    if (face._fmCache && face._fmCache.size === face.pixelSize) return face._fmCache.value;
    setFont(mctx, face);
    const m = mctx.measureText('Mjpqy|');
    const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? face.pixelSize * 0.8;
    const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? face.pixelSize * 0.2;
    const maxAdvance = mctx.measureText('W').width || face.pixelSize;
    const value = { ascent, descent, height: ascent + descent, maxAdvance };
    face._fmCache = { size: face.pixelSize, value };
    return value;
  }

  function fx(px) { return Math.round(px * 64); } // pixels -> 26.6 fixed-point int

  // Rasterizes `ch` at `face`'s current pixelSize into an alpha-coverage bitmap
  // (FT_PIXEL_MODE_GRAY). `strokeRadiusPx > 0` adds an outline (used by Glyph.toBitmap).
  function rasterize(face, ch, strokeRadiusPx, mCached) {
    const m = mCached || measureGlyph(face, ch);
    const pad = Math.ceil(strokeRadiusPx || 0);
    const w = m.width + pad * 2, h = m.rows + pad * 2;
    let data = new Uint8Array(0);
    if (w > 0 && h > 0) {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      setFont(ctx, face);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      const x = m.originX + pad, y = m.baselineY + pad;
      if (strokeRadiusPx > 0) {
        ctx.lineWidth = strokeRadiusPx * 2;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#fff';
        ctx.strokeText(ch, x, y);
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(ch, x, y);
      const img = ctx.getImageData(0, 0, w, h);
      data = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) data[i] = img.data[i * 4 + 3]; // alpha = coverage
    }
    return {
      bitmap: { width: w, rows: h, pitch: w, data, numGray: 256, pixelMode: 2 /* FT_PIXEL_MODE_GRAY */ },
      bitmapLeft: m.bitmapLeft - pad,
      bitmapTop: m.bitmapTop + pad,
      metrics: m,
    };
  }

  // ---- Library ------------------------------------------------------------------
  native('initFreeTypeJni', async () => alloc({ type: 'library', faces: new Set() }));

  nativeIn('Library', 'doneFreeType', async (lib, addr) => { del(addr); });

  let faceCounter = 0;
  nativeIn('Library', 'newMemoryFace', async (lib, libAddr, data, dataSize, faceIndex) => {
    try {
      // data is a java.nio.ByteBuffer; every ByteBuffer our other shims hand out is
      // array-backed (buffers-shim.js deliberately uses allocate(), not
      // allocateDirect() - see its header comment), so this mirrors gl-shim's
      // readBuffer() array-backed path rather than trying a direct-buffer read.
      // Fast path first: if this buffer was created by our own wrap-based helpers and
      // JS-aliasing is confirmed, its memory is directly readable with zero round trips.
      const aliased = global.__BUFFERS_ALIAS && global.__BUFFERS_ALIAS.get(data);
      let bytes;
      if (aliased) {
        bytes = aliased.subarray(0, dataSize);
      } else {
        const arr = await data.array();               // Java byte[] (signed) -> Int8Array
        const arrOff = (await data.arrayOffset?.()) || 0;
        bytes = new Uint8Array(arr.buffer, arr.byteOffset + arrOff, dataSize);
      }
      const arrayBufferCopy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

      const family = 'mindustry-ft-face-' + (faceCounter++);
      const fontFace = new FontFace(family, arrayBufferCopy);
      await fontFace.load();
      document.fonts.add(fontFace);

      const face = { type: 'face', family, pixelSize: 16, current: null, slotAddr: null, sizeAddr: null };
      const addr = alloc(face);
      const libObj = get(libAddr);
      if (libObj) libObj.faces.add(addr);
      return addr;
    } catch (e) {
      console.error('[freetype-shim] newMemoryFace failed (bad/unsupported font data?):', e);
      lastError = 1;
      return 0;
    }
  });

  nativeIn('Library', 'strokerNew', async (lib, libAddr) =>
    alloc({ type: 'stroker', radiusPx: 0, lineCap: 0, lineJoin: 0 }));

  // ---- Face -----------------------------------------------------------------
  nativeIn('Face', 'doneFace', async (lib, addr) => { del(addr); });
  nativeIn('Face', 'getFaceFlags', async () => 0); // never FT_FACE_FLAG_FIXED_SIZES - see file header
  nativeIn('Face', 'getStyleFlags', async () => 0);
  nativeIn('Face', 'getNumGlyphs', async () => 0);
  nativeIn('Face', 'getAscender', async (lib, addr) => fx(faceMetrics(get(addr)).ascent));
  nativeIn('Face', 'getDescender', async (lib, addr) => fx(-faceMetrics(get(addr)).descent));
  nativeIn('Face', 'getHeight', async (lib, addr) => fx(faceMetrics(get(addr)).height));
  nativeIn('Face', 'getMaxAdvanceWidth', async (lib, addr) => fx(faceMetrics(get(addr)).maxAdvance));
  nativeIn('Face', 'getMaxAdvanceHeight', async (lib, addr) => fx(faceMetrics(get(addr)).height));
  nativeIn('Face', 'getUnderlinePosition', async () => 0);
  nativeIn('Face', 'getUnderlineThickness', async () => fx(1));

  nativeIn('Face', 'selectSize', async () => true); // only reached for bitmap-strike fonts, unused here

  nativeIn('Face', 'setCharSize', async (lib, addr, charWidth, charHeight, horzRes, vertRes) => {
    const face = get(addr); if (!face) return false;
    // charWidth/charHeight are 26.6 fixed-point points; scale by dpi/72 like FT_Set_Char_Size
    const dpi = vertRes || horzRes || 72;
    const px = Math.round(((charHeight || charWidth || 0) / 64) * (dpi / 72));
    face.pixelSize = Math.max(1, px || 16);
    return true;
  });

  nativeIn('Face', 'setPixelSizes', async (lib, addr, pixelWidth, pixelHeight) => {
    const face = get(addr); if (!face) return false;
    face._fmCache = null;
    face.pixelSize = Math.max(1, pixelHeight || pixelWidth || 16);
    return true;
  });

  nativeIn('Face', 'loadGlyph', async (lib, addr, glyphIndex, loadFlags) => {
    const face = get(addr); if (!face) return false;
    face.current = { char: String.fromCodePoint(glyphIndex), metrics: null };
    return true;
  });

  nativeIn('Face', 'loadChar', async (lib, addr, charCode, loadFlags) => {
    const face = get(addr); if (!face) return false;
    face.current = { char: String.fromCodePoint(charCode), metrics: null };
    return true;
  });

  nativeIn('Face', 'getGlyph', async (lib, addr) => {
    const face = get(addr); if (!face) return 0;
    if (face.slotAddr == null) face.slotAddr = alloc({ type: 'slot', faceAddr: addr });
    return face.slotAddr;
  });

  nativeIn('Face', 'getSize', async (lib, addr) => {
    const face = get(addr); if (!face) return 0;
    if (face.sizeAddr == null) face.sizeAddr = alloc({ type: 'size', faceAddr: addr });
    return face.sizeAddr;
  });

  nativeIn('Face', 'hasKerning', async () => false); // see file header - kerning intentionally skipped
  nativeIn('Face', 'getKerning', async () => 0);
  nativeIn('Face', 'getCharIndex', async (lib, addr, charCode) => charCode || 1); // identity; never "not found"

  // ---- Size / SizeMetrics -----------------------------------------------------
  nativeIn('Size', 'getMetrics', async (lib, addr) => {
    const size = get(addr); if (!size) return 0;
    if (size.metricsAddr == null) size.metricsAddr = alloc({ type: 'sizeMetrics', faceAddr: size.faceAddr });
    return size.metricsAddr;
  });

  function faceOf(sizeMetricsAddr) { const sm = get(sizeMetricsAddr); return sm && get(sm.faceAddr); }
  nativeIn('SizeMetrics', 'getXppem', async (lib, addr) => faceOf(addr)?.pixelSize || 0);
  nativeIn('SizeMetrics', 'getYppem', async (lib, addr) => faceOf(addr)?.pixelSize || 0);
  nativeIn('SizeMetrics', 'getXscale', async () => 0x10000); // 1.0 in 16.16 fixed-point
  nativeIn('SizeMetrics', 'getYscale', async () => 0x10000);
  nativeIn('SizeMetrics', 'getAscender', async (lib, addr) => { const f = faceOf(addr); return f ? fx(faceMetrics(f).ascent) : 0; });
  nativeIn('SizeMetrics', 'getDescender', async (lib, addr) => { const f = faceOf(addr); return f ? fx(-faceMetrics(f).descent) : 0; });
  nativeIn('SizeMetrics', 'getHeight', async (lib, addr) => { const f = faceOf(addr); return f ? fx(faceMetrics(f).height) : 0; });
  nativeIn('SizeMetrics', 'getMaxAdvance', async (lib, addr) => { const f = faceOf(addr); return f ? fx(faceMetrics(f).maxAdvance) : 0; });

  // ---- GlyphSlot ----------------------------------------------------------------
  nativeIn('GlyphSlot', 'getMetrics', async (lib, addr) => {
    const slot = get(addr); if (!slot) return 0;
    if (slot.metricsAddr == null) slot.metricsAddr = alloc({ type: 'glyphMetrics', slotAddr: addr });
    return slot.metricsAddr;
  });

  function currentMetrics(slotAddr) {
    const slot = get(slotAddr);
    const face = slot && get(slot.faceAddr);
    if (!face || !face.current) return null;
    if (!face.current.metrics) face.current.metrics = measureGlyph(face, face.current.char);
    return face.current.metrics;
  }

  nativeIn('GlyphSlot', 'getLinearHoriAdvance', async (lib, addr) => fx(currentMetrics(addr)?.advance || 0));
  nativeIn('GlyphSlot', 'getLinearVertAdvance', async () => 0);
  nativeIn('GlyphSlot', 'getAdvanceX', async (lib, addr) => fx(currentMetrics(addr)?.advance || 0));
  nativeIn('GlyphSlot', 'getAdvanceY', async () => 0);
  nativeIn('GlyphSlot', 'getFormat', async () => 0x6f75746c); // 'outl' - FT_GLYPH_FORMAT_OUTLINE, never the bitmap-strike sentinel
  nativeIn('GlyphSlot', 'getBitmapLeft', async (lib, addr) => currentMetrics(addr)?.bitmapLeft || 0);
  nativeIn('GlyphSlot', 'getBitmapTop', async (lib, addr) => currentMetrics(addr)?.bitmapTop || 0);

  let glyphsRasterized = 0;
  function glyphProgress() {
    if (++glyphsRasterized % 100 === 0) console.log('[freetype-shim] ' + glyphsRasterized + ' glyphs rasterized');
  }
  nativeIn('GlyphSlot', 'renderGlyph', async (lib, addr, renderMode) => {
    const slot = get(addr);
    const face = slot && get(slot.faceAddr);
    if (!face || !face.current) return false;
    glyphProgress();
    const r = rasterize(face, face.current.char, 0, face.current.metrics);
    slot.bitmap = r.bitmap;
    face.current.metrics = { ...r.metrics, bitmapLeft: r.bitmapLeft, bitmapTop: r.bitmapTop };
    return true;
  });

  nativeIn('GlyphSlot', 'getBitmap', async (lib, addr) => {
    const slot = get(addr); if (!slot || !slot.bitmap) return 0;
    if (slot.bitmapAddr == null) slot.bitmapAddr = alloc({ type: 'bitmap', data: slot.bitmap });
    else get(slot.bitmapAddr).data = slot.bitmap; // refreshed on every render
    return slot.bitmapAddr;
  });

  nativeIn('GlyphSlot', 'getGlyph', async (lib, addr) => {
    const slot = get(addr);
    const face = slot && get(slot.faceAddr);
    if (!face || !face.current) return 0;
    return alloc({ type: 'glyph', faceAddr: slot.faceAddr, char: face.current.char,
      pixelSize: face.pixelSize, strokeRadiusPx: 0, rendered: false });
  });

  // ---- Glyph (detached, strokeable copy of a GlyphSlot) --------------------------
  nativeIn('Glyph', 'done', async (lib, addr) => { del(addr); });

  nativeIn('Glyph', 'strokeBorder', async (lib, addr, strokerAddr, inside) => {
    const g = get(addr); const stroker = get(strokerAddr);
    if (g && stroker) g.strokeRadiusPx = Number(stroker.radiusPx) / 64; // stroker.set() stores 26.6
    return h(addr); // Java reassigns glyph.address to this return value - same handle is fine
  });

  nativeIn('Glyph', 'toBitmap', async (lib, addr, renderMode) => {
    const g = get(addr); if (!g) return 0;
    const face = get(g.faceAddr); if (!face) return 0;
    glyphProgress(); // createGlyph goes through this path (not GlyphSlot.renderGlyph)
    const saved = face.pixelSize;
    face.pixelSize = g.pixelSize;
    // reuse the face's cached per-char metrics when they're still for this char
    const cm = face.current && face.current.char === g.char ? face.current.metrics : null;
    const r = rasterize(face, g.char, g.strokeRadiusPx, cm || undefined);
    face.pixelSize = saved;
    g.bitmap = r.bitmap; g.bitmapLeft = r.bitmapLeft; g.bitmapTop = r.bitmapTop; g.rendered = true;
    return h(addr); // normalize: raw addr may be BigInt if that's how Java passed it in
  });

  nativeIn('Glyph', 'getBitmap', async (lib, addr) => {
    const g = get(addr); if (!g || !g.bitmap) return 0;
    if (g.bitmapAddr == null) g.bitmapAddr = alloc({ type: 'bitmap', data: g.bitmap });
    else get(g.bitmapAddr).data = g.bitmap;
    return g.bitmapAddr;
  });

  nativeIn('Glyph', 'getLeft', async (lib, addr) => get(addr)?.bitmapLeft || 0);
  nativeIn('Glyph', 'getTop', async (lib, addr) => get(addr)?.bitmapTop || 0);

  // ---- Bitmap ---------------------------------------------------------------
  function bmp(addr) { return get(addr)?.data; }
  nativeIn('Bitmap', 'getRows', async (lib, addr) => bmp(addr)?.rows || 0);
  nativeIn('Bitmap', 'getWidth', async (lib, addr) => bmp(addr)?.width || 0);
  nativeIn('Bitmap', 'getPitch', async (lib, addr) => bmp(addr)?.pitch || 0);
  nativeIn('Bitmap', 'getNumGray', async (lib, addr) => bmp(addr)?.numGray || 0);
  nativeIn('Bitmap', 'getPixelMode', async (lib, addr) => bmp(addr)?.pixelMode || 0);
  nativeIn('Bitmap', 'getBuffer', async (lib, addr) => {
    const b = bmp(addr);
    if (!b || !b.data || b.data.length === 0) return null; // Java side already guards rows==0
    let ByteBufferClass;
    try {
      ByteBufferClass = await lib.java.nio.ByteBuffer; // scoped to the actually-running JVM instance
    } catch (e) {
      console.warn('[freetype-shim] lib.java.nio.ByteBuffer unavailable, falling back to window.CJ_LIB', e);
      ByteBufferClass = await global.CJ_LIB.java.nio.ByteBuffer;
    }
    // Same wrap()-not-allocateDirect() reasoning as pixmap-shim.js; when JS-aliasing
    // works this also registers the buffer so gl-shim's reads of glyph pixels are O(1).
    if (global.__wrapAliased) return global.__wrapAliased(ByteBufferClass, b.data);
    const signed = new Int8Array(b.data.buffer, b.data.byteOffset, b.data.byteLength);
    return ByteBufferClass.wrap(signed);
  });

  // ---- GlyphMetrics -----------------------------------------------------------
  function glyphMetricsOf(addr) { const gm = get(addr); return gm && currentMetrics(gm.slotAddr); }
  nativeIn('GlyphMetrics', 'getWidth', async (lib, addr) => fx(glyphMetricsOf(addr)?.width || 0));
  nativeIn('GlyphMetrics', 'getHeight', async (lib, addr) => fx(glyphMetricsOf(addr)?.rows || 0));
  nativeIn('GlyphMetrics', 'getHoriBearingX', async (lib, addr) => fx(glyphMetricsOf(addr)?.bitmapLeft || 0));
  nativeIn('GlyphMetrics', 'getHoriBearingY', async (lib, addr) => fx(glyphMetricsOf(addr)?.bitmapTop || 0));
  nativeIn('GlyphMetrics', 'getHoriAdvance', async (lib, addr) => fx(glyphMetricsOf(addr)?.advance || 0));
  nativeIn('GlyphMetrics', 'getVertBearingX', async () => 0);
  nativeIn('GlyphMetrics', 'getVertBearingY', async () => 0);
  nativeIn('GlyphMetrics', 'getVertAdvance', async () => 0);

  // ---- Stroker ----------------------------------------------------------------
  nativeIn('Stroker', 'set', async (lib, addr, radius, lineCap, lineJoin, miterLimit) => {
    const s = get(addr); if (s) { s.radiusPx = radius; s.lineCap = lineCap; s.lineJoin = lineJoin; }
  });
  nativeIn('Stroker', 'done', async (lib, addr) => { del(addr); });

  global.FREETYPE_SHIM_NATIVES = NATIVES;
})(window);
