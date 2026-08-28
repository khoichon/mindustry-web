// gl-shim.js
// Maps arc.backend.sdl.jni.SDLGL's native methods onto a real WebGL2 context.
// The int enum values Arc/GLES use are numerically identical to WebGL's, so most
// calls are 1:1 forwarding. The real work is bridging two impedance mismatches:
//   1. Desktop/ES GL addresses objects (textures, buffers, programs...) by plain
//      integer "names". WebGL hands out opaque WebGLTexture/WebGLBuffer/... objects.
//      -> we keep id<->object maps and translate both directions.
//   2. GL calls take raw pointers/java.nio.Buffers for pixel & vertex data.
//      CheerpJ's documented conversion only auto-converts JS typed arrays <-> Java
//      primitive arrays; a java.nio.Buffer argument comes through as a Java object
//      proxy. We pull the bytes back out via the buffer's own instance methods.
//      THIS IS THE PART MOST LIKELY TO NEED LIVE DEBUGGING - see readBuffer() below.

(function (global) {
  'use strict';

  let gl = null; // set by sdl-shim.js once the canvas + context exist
  function setGL(context) { gl = context; }

  // ---- id <-> object tables --------------------------------------------------
  function makeTable() {
    let next = 1; // 0 means "null"/"none" in GL
    const byId = new Map();
    const idOf = new WeakMap();
    return {
      alloc(obj) {
        const id = next++;
        byId.set(id, obj);
        idOf.set(obj, id);
        return id;
      },
      get(id) { return id === 0 ? null : byId.get(id) || null; },
      idFor(obj) { return obj ? (idOf.get(obj) || 0) : 0; },
      free(id) {
        const obj = byId.get(id);
        if (obj) idOf.delete(obj);
        byId.delete(id);
      },
    };
  }

  const textures = makeTable();
  const buffers = makeTable();
  const framebuffers = makeTable();
  const renderbuffers = makeTable();
  const shaders = makeTable();
  const programs = makeTable();
  const vaos = makeTable();
  const uniformLocs = makeTable(); // glGetUniformLocation returns int in Arc's API

  // ---- java.nio.Buffer -> typed array ----------------------------------------
  // java.nio.Buffer instances arrive as CheerpJ Java-object proxies, not raw bytes -
  // we need to pull the actual data out via the buffer's own instance methods.
  //
  // This used to try buf.hasArray()/buf.array() first, on the theory that most
  // Arc/libGDX buffers are backed by a plain accessible array. That's true for a
  // *directly allocated* heap ByteBuffer, but NOT for the IntBuffer/FloatBuffer/
  // ShortBuffer *views* you get from ByteBuffer.asIntBuffer() etc - which is exactly
  // how Buffers.newIntBuffer()/newFloatBuffer()/newShortBuffer() build the buffers Arc
  // hands to GL calls. hasArray() on a view buffer reports false regardless of whether
  // the underlying ByteBuffer is heap- or direct-backed - that's standard java.nio
  // behavior, not a CheerpJ quirk.
  //
  // The obvious next attempt - the buffer's own bulk get(dst[]) - turned out not to
  // work either, but for a completely different reason: real testing showed CheerpJ
  // throwing "Method 'get' cannot be resolved for these parameters" the moment a JS
  // typed array was passed as an argument to a *regular* (non-native) Java instance
  // method call. That's a different code path from the native-argument marshalling
  // readBuffer/writeIntBuffer otherwise rely on (which does handle typed arrays fine -
  // see e.g. pixmap-shim.js's ByteBuffer.wrap(signed)); CheerpJ's dynamic dispatch for
  // ordinary instance methods apparently can't overload-resolve against a typed-array
  // argument at all, only against plain scalars.
  //
  // So: per-element scalar get(index) calls instead of one bulk get(array) call. Slower
  // (one JS<->JVM round trip per element) but every argument is a plain int, which is
  // unambiguous and known to resolve - the write-side equivalent (put(index, value) in
  // writeIntBuffer below) uses the same scalar-only shape and is the pattern this
  // mirrors. Fine for the small status/id buffers this is mostly used for; worth
  // revisiting if it ever shows up as a bottleneck on a large glReadPixels buffer.
  async function readBuffer(lib, buf, Ctor, elemsHint) {
    if (buf == null) return null;
    try {
      // Fast path: buffers our shims created via ByteBuffer.wrap + confirmed JS-aliasing
      // (see buffers-shim.js) share memory with a JS typed array - two metadata queries
      // and one slice() instead of one awaited get() per element.
      const aliased = global.__BUFFERS_ALIAS && global.__BUFFERS_ALIAS.get(buf);
      if (aliased && Ctor === Uint8Array) {
        const pos = await buf.position();
        const rem = await buf.remaining();
        return aliased.slice(pos, pos + rem);
      }
      // Second fast path: any heap ByteBuffer exposes its backing byte[] via array() -
      // one call, then slice JS-side. (View buffers - FloatBuffer etc. - throw on
      // array() and fall through to the scalar loop below.)
      if (Ctor === Uint8Array) {
        try {
          const arr = await buf.array();
          if (arr) {
            const arrOff = (await buf.arrayOffset()) | 0;
            const pos = await buf.position();
            const rem = await buf.remaining();
            return new Uint8Array(arr.buffer, arr.byteOffset + arrOff + pos, rem).slice();
          }
        } catch (e) { /* view/direct buffer - fall through */ }
      }
      const pos = await buf.position();
      const rem = await buf.remaining();
      const out = new Ctor(rem);
      // Absolute get(index) calls (not relative get()) don't touch buf's position and
      // don't depend on each other, so they're safe to fire concurrently in batches
      // instead of paying one full JS<->JVM round trip at a time - round-trip latency,
      // not JS-side work, dominates this loop. CHUNK keeps us from firing an unbounded
      // burst at once for very large buffers.
      const CHUNK = 64;
      for (let start = 0; start < rem; start += CHUNK) {
        const end = Math.min(start + CHUNK, rem);
        const vals = await Promise.all(
          Array.from({ length: end - start }, (_, k) => buf.get(pos + start + k))
        );
        for (let k = 0; k < vals.length; k++) out[start + k] = vals[k];
      }
      return out;
    } catch (e) {
      console.error('[gl-shim] could not read Buffer contents via get() - see readBuffer() in gl-shim.js', e, buf);
      return null;
    }
  }

  // string[] Java array -> JS array of strings (already converted per LiveConnect rules,
  // but kept here as a named helper for clarity at call sites)
  const toJsArray = (a) => a;

  function native(name, fn) { NATIVES['Java_arc_backend_sdl_jni_SDLGL_' + name] = fn; }
  function nativeMangled(shortName, mangledSuffix, fn) {
    NATIVES['Java_arc_backend_sdl_jni_SDLGL_' + shortName + '__' + mangledSuffix] = fn;
  }

  const NATIVES = {};

  // ---- simple state / misc ---------------------------------------------------
  // SdlGraphics.java: `String errorMessage = SDLGL.init(); if (errorMessage != null) throw ...`
  // - null means "initialized fine", any non-null string is shown as a fatal GLEW error.
  // WebGL2 doesn't need a GLEW-style extension-loading step at all, so this is just success.
  native('init', async () => null);
  native('glGetError', async () => gl.getError());
  native('glGetString', async (lib, name) => {
    // Arc's GLVersion parser (arc-core/.../GLVersion.java) treats this backend as
    // desktop OpenGL and regex-matches the *first* "<digit>(.<digit>){0,2}" pattern
    // it finds anywhere in the GL_VERSION string. The browser's real string -
    // "WebGL 2.0 (OpenGL ES 3.0 Chromium)" - has "2.0" appear before "3.0", so Arc
    // parses majorVersion=2 and then fails its `atLeast(3,0) || hasFBOExtension`
    // check (WebGL2 has no such extension string - FBOs are core, not an extension).
    // Report a version string that parses to the *actual* capability level (WebGL2
    // ~= GLES 3.0, which is what Arc really gets) instead of forwarding the raw
    // browser string for this one parameter.
    if (name === gl.VERSION) return '3.0.0 WebGL2 (browser compatibility layer)';
    return gl.getParameter(name) ?? '';
  });
  native('glGetStringi', async (lib, name, index) => (gl.getSupportedExtensions?.()[index]) ?? '');
  native('glFinish', async () => gl.finish());
  native('glFlush', async () => gl.flush());
  native('glEnable', async (lib, cap) => gl.enable(cap));
  native('glDisable', async (lib, cap) => gl.disable(cap));
  native('glIsEnabled', async (lib, cap) => gl.isEnabled(cap));
  native('glHint', async (lib, target, mode) => gl.hint(target, mode));
  native('glViewport', async (lib, x, y, w, h) => gl.viewport(x, y, w, h));
  native('glScissor', async (lib, x, y, w, h) => gl.scissor(x, y, w, h));
  native('glClear', async (lib, mask) => gl.clear(mask));
  native('glClearColor', async (lib, r, g, b, a) => gl.clearColor(r, g, b, a));
  native('glClearDepthf', async (lib, d) => gl.clearDepth(d));
  native('glClearStencil', async (lib, s) => gl.clearStencil(s));
  native('glColorMask', async (lib, r, g, b, a) => gl.colorMask(r, g, b, a));
  native('glDepthFunc', async (lib, f) => gl.depthFunc(f));
  native('glDepthMask', async (lib, f) => gl.depthMask(f));
  native('glDepthRangef', async (lib, n, f) => gl.depthRange(n, f));
  native('glCullFace', async (lib, m) => gl.cullFace(m));
  native('glFrontFace', async (lib, m) => gl.frontFace(m));
  native('glLineWidth', async (lib, w) => gl.lineWidth(w));
  native('glPolygonOffset', async (lib, f, u) => gl.polygonOffset(f, u));
  native('glPixelStorei', async (lib, p, v) => gl.pixelStorei(p, v));
  native('glSampleCoverage', async (lib, v, inv) => gl.sampleCoverage(v, inv));
  native('glReadBuffer', async (lib, mode) => gl.readBuffer(mode));

  native('glBlendFunc', async (lib, s, d) => gl.blendFunc(s, d));
  native('glBlendFuncSeparate', async (lib, sr, dr, sa, da) => gl.blendFuncSeparate(sr, dr, sa, da));
  native('glBlendColor', async (lib, r, g, b, a) => gl.blendColor(r, g, b, a));
  native('glBlendEquation', async (lib, m) => gl.blendEquation(m));
  native('glBlendEquationSeparate', async (lib, rgb, a) => gl.blendEquationSeparate(rgb, a));

  native('glStencilFunc', async (lib, f, r, m) => gl.stencilFunc(f, r, m));
  native('glStencilMask', async (lib, m) => gl.stencilMask(m));
  native('glStencilOp', async (lib, f, zf, zp) => gl.stencilOp(f, zf, zp));
  native('glStencilFuncSeparate', async (lib, face, f, r, m) => gl.stencilFuncSeparate(face, f, r, m));
  native('glStencilMaskSeparate', async (lib, face, m) => gl.stencilMaskSeparate(face, m));
  native('glStencilOpSeparate', async (lib, face, f, zf, zp) => gl.stencilOpSeparate(face, f, zf, zp));

  // ---- textures ---------------------------------------------------------------
  native('glGenTexture', async () => textures.alloc(gl.createTexture()));
  native('glDeleteTexture', async (lib, id) => { gl.deleteTexture(textures.get(id)); textures.free(id); });
  native('glBindTexture', async (lib, target, id) => gl.bindTexture(target, textures.get(id)));
  native('glIsTexture', async (lib, id) => gl.isTexture(textures.get(id)));
  native('glActiveTexture', async (lib, unit) => gl.activeTexture(unit));
  native('glGenerateMipmap', async (lib, target) => gl.generateMipmap(target));
  native('glTexParameterf', async (lib, t, p, v) => gl.texParameterf(t, p, v));
  native('glTexParameteri', async (lib, t, p, v) => gl.texParameteri(t, p, v));
  native('glCopyTexImage2D', async (lib, t, l, ifmt, x, y, w, h, b) => gl.copyTexImage2D(t, l, ifmt, x, y, w, h, b));
  native('glCopyTexSubImage2D', async (lib, t, l, xo, yo, x, y, w, h) => gl.copyTexSubImage2D(t, l, xo, yo, x, y, w, h));

  native('glTexImage2D', async (lib, target, level, ifmt, w, h, border, format, type, pixels) => {
    const px = await readBuffer(lib, pixels, Uint8Array);
    gl.texImage2D(target, level, ifmt, w, h, border, format, type, px);
  });
  native('glTexSubImage2D', async (lib, target, level, xo, yo, w, h, format, type, pixels) => {
    const px = await readBuffer(lib, pixels, Uint8Array);
    gl.texSubImage2D(target, level, xo, yo, w, h, format, type, px);
  });
  native('glCompressedTexImage2D', async (lib, target, level, ifmt, w, h, border, size, data) => {
    const d = await readBuffer(lib, data, Uint8Array);
    gl.compressedTexImage2D(target, level, ifmt, w, h, border, d);
  });
  native('glCompressedTexSubImage2D', async (lib, target, level, xo, yo, w, h, format, size, data) => {
    const d = await readBuffer(lib, data, Uint8Array);
    gl.compressedTexSubImage2D(target, level, xo, yo, w, h, format, d);
  });

  // ---- buffers (VBO/EBO/UBO) ---------------------------------------------------
  native('glGenBuffer', async () => buffers.alloc(gl.createBuffer()));
  native('glDeleteBuffer', async (lib, id) => { gl.deleteBuffer(buffers.get(id)); buffers.free(id); });
  native('glBindBuffer', async (lib, target, id) => gl.bindBuffer(target, buffers.get(id)));
  native('glIsBuffer', async (lib, id) => gl.isBuffer(buffers.get(id)));
  native('glBufferData', async (lib, target, size, data, usage) => {
    if (data == null) { gl.bufferData(target, size, usage); return; }
    const d = await readBuffer(lib, data, Uint8Array);
    gl.bufferData(target, d, usage);
  });
  native('glBufferSubData', async (lib, target, offset, size, data) => {
    const d = await readBuffer(lib, data, Uint8Array);
    gl.bufferSubData(target, offset, d);
  });
  native('glBindBufferBase', async (lib, target, index, id) => gl.bindBufferBase(target, index, buffers.get(id)));
  native('glBindBufferRange', async (lib, target, index, id, off, size) => gl.bindBufferRange(target, index, buffers.get(id), off, size));
  native('glCopyBufferSubData', async (lib, rt, wt, ro, wo, size) => gl.copyBufferSubData(rt, wt, ro, wo, size));

  // ---- framebuffers / renderbuffers --------------------------------------------
  native('glGenFramebuffer', async () => framebuffers.alloc(gl.createFramebuffer()));
  native('glDeleteFramebuffer', async (lib, id) => { gl.deleteFramebuffer(framebuffers.get(id)); framebuffers.free(id); });
  // --- presentation redirect -------------------------------------------------------
  // CheerpJ natives are async, so the browser event loop can yield (and Chrome
  // composite the canvas) *between* GL calls of one logical frame - showing
  // half-drawn states (the classic flicker; desktop GL's double buffering hides
  // exactly this). Fix: redirect framebuffer name 0 to an offscreen FBO; only
  // SDL_GL_SwapWindow blits it onto the visible default framebuffer, so every
  // composite shows the last complete frame.
  let presentFbo = null, presentTex = null, presentRb = null, presentW = 0, presentH = 0;
  function createPresentFbo() {
    const w = Math.max(1, gl.canvas.width), h = Math.max(1, gl.canvas.height);
    if (presentFbo) { gl.deleteFramebuffer(presentFbo); gl.deleteTexture(presentTex); gl.deleteRenderbuffer(presentRb); }
    presentTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, presentTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    presentRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, presentRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    presentFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, presentFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, presentTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, presentRb);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    presentW = w; presentH = h;
  }
  function presentToScreen() {
    // called from sdl-shim's SDL_GL_SwapWindow
    if (!presentFbo || presentW !== gl.canvas.width || presentH !== gl.canvas.height) createPresentFbo();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, presentFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, presentW, presentH, 0, 0, presentW, presentH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    // restore the redirected binding so "framebuffer 0" stays current from the game's POV
    gl.bindFramebuffer(gl.FRAMEBUFFER, presentFbo);
  }
  global.GL_SHIM_present = presentToScreen;

  native('glBindFramebuffer', async (lib, target, id) =>
    gl.bindFramebuffer(target, id === 0 ? (presentFbo || (createPresentFbo(), presentFbo)) : framebuffers.get(id)));
  native('glIsFramebuffer', async (lib, id) => gl.isFramebuffer(framebuffers.get(id)));
  native('glCheckFramebufferStatus', async (lib, target) => gl.checkFramebufferStatus(target));
  native('glFramebufferTexture2D', async (lib, target, attach, textarget, id, level) => gl.framebufferTexture2D(target, attach, textarget, textures.get(id), level));
  native('glFramebufferRenderbuffer', async (lib, target, attach, rbTarget, id) => gl.framebufferRenderbuffer(target, attach, rbTarget, renderbuffers.get(id)));
  native('glFramebufferTextureLayer', async (lib, target, attach, id, level, layer) => gl.framebufferTextureLayer(target, attach, textures.get(id), level, layer));
  native('glBlitFramebuffer', async (lib, sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter) => gl.blitFramebuffer(sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter));
  native('glInvalidateFramebuffer', async (lib, target, n, attachmentsBuf) => {
    const a = await readBuffer(lib, attachmentsBuf, Int32Array);
    gl.invalidateFramebuffer(target, Array.from(a.subarray(0, n)));
  });

  native('glGenRenderbuffer', async () => renderbuffers.alloc(gl.createRenderbuffer()));
  native('glDeleteRenderbuffer', async (lib, id) => { gl.deleteRenderbuffer(renderbuffers.get(id)); renderbuffers.free(id); });
  native('glBindRenderbuffer', async (lib, target, id) => gl.bindRenderbuffer(target, renderbuffers.get(id)));
  native('glIsRenderbuffer', async (lib, id) => gl.isRenderbuffer(renderbuffers.get(id)));
  native('glRenderbufferStorage', async (lib, target, ifmt, w, h) => gl.renderbufferStorage(target, ifmt, w, h));
  native('glRenderbufferStorageMultisample', async (lib, target, samples, ifmt, w, h) => gl.renderbufferStorageMultisample(target, samples, ifmt, w, h));

  // ---- shaders / programs -------------------------------------------------------
  // Mindustry's bundled shaders are written in desktop GLSL (#version 130 and up),
  // which WebGL2's GLSL ES 3.00 compiler flatly rejects ("client/version number not
  // supported") - not a semantic incompatibility, just the wrong dialect header. GLSL
  // 130+ already uses in/out (not the old attribute/varying), so the actual syntax
  // matches GLSL ES 300 almost exactly; the two real gaps are the #version line itself
  // and GLSL ES's mandatory float precision qualifier in fragment shaders (desktop GLSL
  // has no concept of precision qualifiers and omits them entirely). translateGlsl()
  // below patches exactly those two things and leaves everything else untouched.
  const shaderTypes = new Map(); // WebGLShader -> gl.VERTEX_SHADER/FRAGMENT_SHADER, set at glCreateShader

  function translateGlsl(src, glType) {
    if (!/^\s*#version\s+\d+/m.test(src)) return src; // no version line - already ES-style or empty, leave alone
    // [ \t] (not \s) for the optional profile suffix (e.g. "130 core") - \s would also
    // match the newline and swallow the next line's first token.
    let out = src.replace(/#version\s+\d+([ \t]+\w+)?/, '#version 300 es');
    if (glType === gl.FRAGMENT_SHADER) {
      // Always inject right after #version, unconditionally - even if the shader
      // already has its own `#ifdef GL_ES / precision mediump float; / #endif` block
      // (Mindustry's shaders generally do, as cross-platform desktop/ES boilerplate).
      // Redundant precision statements are legal GLSL (a later one just overrides an
      // earlier one for subsequent code), and that boilerplate block is placed *after*
      // other declarations like `out vec4 fragColor;` - fine on desktop, which has no
      // precision concept at all, but GLSL ES 300 requires a precision to already be in
      // effect before the first declaration that needs one, so relying solely on the
      // shader's own (correctly-written-for-ES, just misplaced-for-ES) block isn't
      // enough. Confirmed via real testing: leaving this conditional on "not already
      // present anywhere" produced exactly this failure - `ERROR: 0:2: '' : No
      // precision specified for (float)` pointing at the `out vec4 fragColor;` line,
      // one line before the shader's own precision block took effect.
      out = out.replace('#version 300 es', '#version 300 es\nprecision mediump float;');
    }
    return out;
  }

  native('glCreateShader', async (lib, type) => {
    const shader = gl.createShader(type);
    shaderTypes.set(shader, type);
    return shaders.alloc(shader);
  });
  native('glDeleteShader', async (lib, id) => { const s = shaders.get(id); shaderTypes.delete(s); gl.deleteShader(s); shaders.free(id); });
  native('glIsShader', async (lib, id) => gl.isShader(shaders.get(id)));
  native('glShaderSource', async (lib, id, src) => {
    const shader = shaders.get(id);
    const translated = translateGlsl(src, shaderTypes.get(shader));
    if (translated !== src) console.log('[gl-shim] translated shader source to GLSL ES 300:\n' + translated);
    gl.shaderSource(shader, translated);
  });
  native('glCompileShader', async (lib, id) => gl.compileShader(shaders.get(id)));
  native('glGetShaderInfoLog', async (lib, id) => gl.getShaderInfoLog(shaders.get(id)) || '');
  native('glGetShaderiv', async (lib, id, pname, out) => {
    const v = gl.getShaderParameter(shaders.get(id), pname);
    await writeIntBuffer(lib, out, [typeof v === 'boolean' ? (v ? 1 : 0) : v]);
  });
  native('glGetShaderPrecisionFormat', async (lib, shaderType, precType, rangeOut, precOut) => {
    const f = gl.getShaderPrecisionFormat(shaderType, precType);
    await writeIntBuffer(lib, rangeOut, [f.rangeMin, f.rangeMax]);
    await writeIntBuffer(lib, precOut, [f.precision]);
  });
  native('glReleaseShaderCompiler', async () => {});

  native('glCreateProgram', async () => programs.alloc(gl.createProgram()));
  native('glDeleteProgram', async (lib, id) => { gl.deleteProgram(programs.get(id)); programs.free(id); });
  native('glIsProgram', async (lib, id) => gl.isProgram(programs.get(id)));
  native('glAttachShader', async (lib, p, s) => gl.attachShader(programs.get(p), shaders.get(s)));
  native('glDetachShader', async (lib, p, s) => gl.detachShader(programs.get(p), shaders.get(s)));
  native('glLinkProgram', async (lib, p) => gl.linkProgram(programs.get(p)));
  native('glUseProgram', async (lib, p) => gl.useProgram(programs.get(p)));
  native('glValidateProgram', async (lib, p) => gl.validateProgram(programs.get(p)));
  native('glGetProgramInfoLog', async (lib, p) => gl.getProgramInfoLog(programs.get(p)) || '');
  native('glGetProgramiv', async (lib, p, pname, out) => {
    const v = gl.getProgramParameter(programs.get(p), pname);
    await writeIntBuffer(lib, out, [typeof v === 'boolean' ? (v ? 1 : 0) : v]);
  });
  native('glProgramParameteri', async (lib, p, pname, val) => gl.programParameteri?.(programs.get(p), pname, val));
  native('glBindAttribLocation', async (lib, p, index, name) => gl.bindAttribLocation(programs.get(p), index, name));
  native('glGetAttribLocation', async (lib, p, name) => gl.getAttribLocation(programs.get(p), name));
  native('glGetFragDataLocation', async (lib, p, name) => gl.getFragDataLocation(programs.get(p), name));

  native('glGetUniformLocation', async (lib, p, name) => {
    const loc = gl.getUniformLocation(programs.get(p), name);
    return loc ? uniformLocs.alloc(loc) : -1;
  });
  native('glGetUniformBlockIndex', async (lib, p, name) => gl.getUniformBlockIndex(programs.get(p), name));
  native('glUniformBlockBinding', async (lib, p, idx, binding) => gl.uniformBlockBinding(programs.get(p), idx, binding));

  // uniform setters
  const U = (name, arity, fn) => native(name, async (lib, loc, ...args) => fn(uniformLocs.get(loc), ...args));
  U('glUniform1f', 1, (l, x) => gl.uniform1f(l, x));
  U('glUniform2f', 2, (l, x, y) => gl.uniform2f(l, x, y));
  U('glUniform3f', 3, (l, x, y, z) => gl.uniform3f(l, x, y, z));
  U('glUniform4f', 4, (l, x, y, z, w) => gl.uniform4f(l, x, y, z, w));
  U('glUniform1i', 1, (l, x) => gl.uniform1i(l, x));
  U('glUniform2i', 2, (l, x, y) => gl.uniform2i(l, x, y));
  U('glUniform3i', 3, (l, x, y, z) => gl.uniform3i(l, x, y, z));
  U('glUniform4i', 4, (l, x, y, z, w) => gl.uniform4i(l, x, y, z, w));

  // vector/matrix uniform setters have FloatBuffer/IntBuffer AND array+offset overloads.
  // Both are registered under the plain name; if CheerpJ requires mangled overload
  // resolution here, see OVERLOAD NOTES at the bottom of this file.
  native('glUniform1fv', async (lib, loc, count, v, offset) => {
    const arr = v && v.BYTES_PER_ELEMENT ? v.subarray(offset || 0) : await readBuffer(lib, v, Float32Array);
    gl.uniform1fv(uniformLocs.get(loc), arr.subarray(0, count));
  });
  native('glUniform2fv', async (lib, loc, count, v, offset) => {
    const arr = v && v.BYTES_PER_ELEMENT ? v.subarray(offset || 0) : await readBuffer(lib, v, Float32Array);
    gl.uniform2fv(uniformLocs.get(loc), arr.subarray(0, count * 2));
  });
  native('glUniform3fv', async (lib, loc, count, v, offset) => {
    const arr = v && v.BYTES_PER_ELEMENT ? v.subarray(offset || 0) : await readBuffer(lib, v, Float32Array);
    gl.uniform3fv(uniformLocs.get(loc), arr.subarray(0, count * 3));
  });
  native('glUniform4fv', async (lib, loc, count, v, offset) => {
    const arr = v && v.BYTES_PER_ELEMENT ? v.subarray(offset || 0) : await readBuffer(lib, v, Float32Array);
    gl.uniform4fv(uniformLocs.get(loc), arr.subarray(0, count * 4));
  });
  native('glUniform1iv', async (lib, loc, count, v, offset) => {
    const arr = v && v.BYTES_PER_ELEMENT ? v.subarray(offset || 0) : await readBuffer(lib, v, Int32Array);
    gl.uniform1iv(uniformLocs.get(loc), arr.subarray(0, count));
  });
  native('glUniformMatrix3fv', async (lib, loc, count, transpose, v, offset) => {
    const arr = v && v.BYTES_PER_ELEMENT ? v.subarray(offset || 0) : await readBuffer(lib, v, Float32Array);
    gl.uniformMatrix3fv(uniformLocs.get(loc), transpose, arr.subarray(0, count * 9));
  });
  native('glUniformMatrix4fv', async (lib, loc, count, transpose, v, offset) => {
    const arr = v && v.BYTES_PER_ELEMENT ? v.subarray(offset || 0) : await readBuffer(lib, v, Float32Array);
    gl.uniformMatrix4fv(uniformLocs.get(loc), transpose, arr.subarray(0, count * 16));
  });

  native('glGetUniformfv', async (lib, p, loc, out) => {
    const v = gl.getUniform(programs.get(p), uniformLocs.get(loc));
    await writeFloatBuffer(lib, out, v.length !== undefined ? Array.from(v) : [v]);
  });
  native('glGetUniformiv', async (lib, p, loc, out) => {
    const v = gl.getUniform(programs.get(p), uniformLocs.get(loc));
    await writeIntBuffer(lib, out, v.length !== undefined ? Array.from(v) : [v]);
  });

  native('glGetActiveAttrib', async (lib, p, index) => {
    const info = gl.getActiveAttrib(programs.get(p), index);
    return info ? info.name : '';
  });
  native('glGetActiveUniform', async (lib, p, index) => {
    const info = gl.getActiveUniform(programs.get(p), index);
    return info ? info.name : '';
  });

  // ---- vertex attributes / drawing ------------------------------------------------
  native('glEnableVertexAttribArray', async (lib, i) => gl.enableVertexAttribArray(i));
  native('glDisableVertexAttribArray', async (lib, i) => gl.disableVertexAttribArray(i));
  native('glVertexAttrib1f', async (lib, i, x) => gl.vertexAttrib1f(i, x));
  native('glVertexAttrib2f', async (lib, i, x, y) => gl.vertexAttrib2f(i, x, y));
  native('glVertexAttrib3f', async (lib, i, x, y, z) => gl.vertexAttrib3f(i, x, y, z));
  native('glVertexAttrib4f', async (lib, i, x, y, z, w) => gl.vertexAttrib4f(i, x, y, z, w));
  native('glVertexAttribDivisor', async (lib, i, d) => gl.vertexAttribDivisor(i, d));
  native('glVertexAttribIPointer', async (lib, i, size, type, stride, offset) => gl.vertexAttribIPointer(i, size, type, stride, offset));
  // int-offset overload (the common libGDX/Arc path: a bound ARRAY_BUFFER + byte offset)
  native('glVertexAttribPointer', async (lib, i, size, type, normalized, stride, ptr) => {
    gl.vertexAttribPointer(i, size, type, normalized, stride, typeof ptr === 'number' ? ptr : 0);
  });

  native('glDrawArrays', async (lib, mode, first, count) => gl.drawArrays(mode, first, count));
  native('glDrawArraysInstanced', async (lib, mode, first, count, instances) => gl.drawArraysInstanced(mode, first, count, instances));
  // int-offset overload (used when indices already live in a bound ELEMENT_ARRAY_BUFFER,
  // which is how Arc's SDL backend drives it - the common libGDX path)
  native('glDrawElements', async (lib, mode, count, type, indices) => {
    gl.drawElements(mode, count, type, typeof indices === 'number' ? indices : 0);
  });
  native('glDrawElementsInstanced', async (lib, mode, count, type, offset, instances) => gl.drawElementsInstanced(mode, count, type, offset, instances));
  native('glDrawRangeElements', async (lib, mode, start, end, count, type, offset) => {
    gl.drawRangeElements ? gl.drawRangeElements(mode, start, end, count, type, offset) : gl.drawElements(mode, count, type, offset);
  });

  native('glGenVertexArrays', async (lib, n, out) => {
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(vaos.alloc(gl.createVertexArray()));
    await writeIntBuffer(lib, out, ids);
  });
  native('glDeleteVertexArrays', async (lib, n, idsBuf) => {
    const ids = await readBuffer(lib, idsBuf, Int32Array);
    for (let i = 0; i < n; i++) { gl.deleteVertexArray(vaos.get(ids[i])); vaos.free(ids[i]); }
  });
  native('glBindVertexArray', async (lib, id) => gl.bindVertexArray(vaos.get(id)));
  native('glIsVertexArray', async (lib, id) => gl.isVertexArray(vaos.get(id)));

  native('glReadPixels', async (lib, x, y, w, h, format, type, out) => {
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(x, y, w, h, format, type, buf);
    await writeByteBuffer(lib, out, buf);
  });

  // ---- getters that need Buffer output ------------------------------------------
  // NOTE: this used to try to reach into the buffer's backing array via
  // hasArray()/array(). That's a real dead end for these specific buffers, not just a
  // CheerpJ quirk: Buffers.newIntBuffer()/newFloatBuffer()/newShortBuffer() all do
  // `ByteBuffer.allocate(...).asIntBuffer()` (etc) - and per standard java.nio.Buffer
  // semantics, a *view* buffer returned by .asIntBuffer()/.asFloatBuffer() never
  // reports hasArray()==true, even when the underlying ByteBuffer is heap-backed (this
  // is true in a real JVM too, not something CheerpJ does differently - the view class
  // just doesn't expose the array). Confirmed via real testing: even after patching
  // Buffers.class to use allocate() instead of allocateDirect() (see HANDOFF Round 7),
  // the exact same fallback warning kept firing for glGetShaderiv's IntBuffer, causing
  // shader compile-status to always read back as 0/false - including for shaders that
  // actually compiled fine, producing a "Failed to compile shader: " exception with an
  // *empty* log (no real GLSL errors, just a broken status readback).
  // Fix: use the buffer's own absolute put(index, value) method instead - one scalar
  // call per element. This is a completely normal java.nio.Buffer API call on the real
  // object reference the native call received as an argument, and works on every
  // buffer (direct, heap, view, whatever), since a view buffer's put() writes straight
  // through into its backing ByteBuffer's storage - no need to reach around into a
  // backing array at all. (A bulk put(index, array, off, len) call would be fewer round
  // trips, but per readBuffer()'s header comment above, CheerpJ can't resolve a regular
  // instance method call against a JS typed-array argument at all - only scalars work,
  // so there's no bulk variant to fall back to here.)
  async function writeIntBuffer(lib, buf, values) {
    try {
      const pos = await buf.position();
      // Same reasoning as readBuffer's scalar path above: absolute put(index, value)
      // is order-independent and position-safe, so batch the round trips.
      const CHUNK = 64;
      for (let start = 0; start < values.length; start += CHUNK) {
        const end = Math.min(start + CHUNK, values.length);
        await Promise.all(
          Array.from({ length: end - start }, (_, k) => buf.put(pos + start + k, values[start + k]))
        );
      }
    } catch (e) {
      console.error('[gl-shim] writeIntBuffer via put() failed - see gl-shim.js', e, buf, values);
    }
  }
  async function writeFloatBuffer(lib, buf, values) { return writeIntBuffer(lib, buf, values); } // put() dispatches on buf's real runtime type (IntBuffer vs FloatBuffer)
  async function writeByteBuffer(lib, buf, bytes) {
    // Fast path for JS-aliased buffers (see buffers-shim.js): one set() instead of a
    // put() round trip per byte.
    const aliased = global.__BUFFERS_ALIAS && global.__BUFFERS_ALIAS.get(buf);
    if (aliased && bytes instanceof Uint8Array) {
      try {
        const pos = await buf.position();
        aliased.set(bytes, pos);
        return;
      } catch (e) {
        console.error('[gl-shim] writeByteBuffer aliased fast path failed', e);
      }
    }
    // Scalar put(index, byte) only, same reasoning as readBuffer above - a bulk
    // put(index, byte[], off, len) call was tried here originally but real testing
    // showed CheerpJ can't resolve *any* regular (non-native) instance method overload
    // against a JS typed-array argument, so there's no bulk path worth attempting first.
    try {
      const pos = await buf.position();
      const CHUNK = 64;
      for (let start = 0; start < bytes.length; start += CHUNK) {
        const end = Math.min(start + CHUNK, bytes.length);
        await Promise.all(
          Array.from({ length: end - start }, (_, k) => buf.put(pos + start + k, bytes[start + k]))
        );
      }
    } catch (e) {
      console.error('[gl-shim] writeByteBuffer via put() failed - see gl-shim.js', e, buf);
    }
  }

  native('glGetIntegerv', async (lib, pname, out) => {
    const v = gl.getParameter(pname);
    await writeIntBuffer(lib, out, v && v.length !== undefined ? Array.from(v) : [v | 0]);
  });
  native('glGetFloatv', async (lib, pname, out) => {
    const v = gl.getParameter(pname);
    await writeFloatBuffer(lib, out, v && v.length !== undefined ? Array.from(v) : [v]);
  });
  native('glGetBooleanv', async (lib, pname, out) => {
    const v = gl.getParameter(pname);
    await writeIntBuffer(lib, out, v && v.length !== undefined ? Array.from(v).map(b => b ? 1 : 0) : [v ? 1 : 0]);
  });
  native('glGetTexParameteriv', async (lib, target, pname, out) => writeIntBuffer(lib, out, [gl.getTexParameter(target, pname)]));
  native('glGetTexParameterfv', async (lib, target, pname, out) => writeFloatBuffer(lib, out, [gl.getTexParameter(target, pname)]));
  native('glGetBufferParameteriv', async (lib, target, pname, out) => writeIntBuffer(lib, out, [gl.getBufferParameter(target, pname)]));
  native('glGetRenderbufferParameteriv', async (lib, target, pname, out) => writeIntBuffer(lib, out, [gl.getRenderbufferParameter(target, pname)]));
  native('glGetFramebufferAttachmentParameteriv', async (lib, target, attach, pname, out) => writeIntBuffer(lib, out, [gl.getFramebufferAttachmentParameter(target, attach, pname)]));
  native('glGetVertexAttribfv', async (lib, i, pname, out) => writeFloatBuffer(lib, out, [gl.getVertexAttrib(i, pname)]));
  native('glGetVertexAttribiv', async (lib, i, pname, out) => writeIntBuffer(lib, out, [gl.getVertexAttrib(i, pname)]));

  // ---- unsupported-in-practice / rarely used by Mindustry's 2D pipeline ---------
  // Left as safe no-ops so an unexpected call doesn't hard-crash the app; if Mindustry
  // actually depends on one of these for a visible feature we'll see it and fill it in.
  for (const stub of [
    'glGenQueries','glDeleteQueries','glIsQuery','glBeginQuery','glEndQuery','glGetQueryiv','glGetQueryObjectuiv',
    'glUnmapBuffer','glGetBufferPointerv','glDrawBuffers','glFlushMappedBufferRange',
    'glBeginTransformFeedback','glEndTransformFeedback','glTransformFeedbackVaryings',
    'glPauseTransformFeedback','glResumeTransformFeedback','glBindTransformFeedback',
    'glGenTransformFeedbacks','glDeleteTransformFeedbacks','glIsTransformFeedback',
    'glGenSamplers','glDeleteSamplers','glIsSampler','glBindSampler','glSamplerParameteri',
    'glSamplerParameteriv','glSamplerParameterf','glSamplerParameterfv','glGetSamplerParameteriv','glGetSamplerParameterfv',
    'glGetUniformIndices','glGetActiveUniformsiv','glGetActiveUniformBlockiv','glGetActiveUniformBlockName',
    'glGetInteger64v','glGetBufferParameteri64v','glInvalidateSubFramebuffer',
    'glVertexAttribI4i','glVertexAttribI4ui','glGetVertexAttribIiv','glGetVertexAttribIuiv',
    'glGetUniformuiv','glUniform1uiv','glUniform3uiv','glUniform4uiv',
    'glClearBufferiv','glClearBufferuiv','glClearBufferfv','glClearBufferfi',
    'glUniformMatrix2fv','glUniformMatrix2x3fv','glUniformMatrix3x2fv','glUniformMatrix2x4fv','glUniformMatrix4x2fv','glUniformMatrix3x4fv','glUniformMatrix4x3fv',
    'glTexImage3D','glTexSubImage3D','glCopyTexSubImage3D',
  ]) {
    if (!NATIVES['Java_arc_backend_sdl_jni_SDLGL_' + stub]) {
      native(stub, async () => { console.warn('[gl-shim] unimplemented GL call:', stub); return 0; });
    }
  }

  global.GL_SHIM_NATIVES = NATIVES;
  global.GL_SHIM_setContext = setGL;
})(window);

// ===========================================================================
// OVERLOAD NOTES (read this if the browser console shows "native method not
// found" for one of these, or the wrong overload silently gets called):
//
// Real Java/JNI (and very likely CheerpJ, since it says it mirrors JNI) only
// lets you use the short "Java_Class_method" name when a class has exactly ONE
// native method with that name. SDLGL.java has several overloaded natives:
//   glDrawElements(int,int,int,Buffer)      vs (int,int,int,int)
//   glDrawRangeElements(...,int offset)     vs (...,Buffer indices)
//   glVertexAttribPointer(...,Object ptr)   vs (...,int ptr)
//   glUniform{1,2,3,4}fv/iv(...,XBuffer)    vs (...,x[],int offset)
//   glUniformMatrix{2,3,4}fv(...,FloatBuffer) vs (...,float[],int offset)
//   glTexImage3D / glTexSubImage3D          (int offset) vs (Buffer)
//
// If short names don't bind, JNI's mangled long form is:
//   Java_arc_backend_sdl_jni_SDLGL_<method>__<mangled-signature>
// where I=int F=float Z=boolean, [X=array of X, LClass_2=object of Class
// (dots -> underscores, ';' -> "_2", '[' -> "_3"). E.g. the Buffer overload of
// glDrawElements would be:
//   Java_arc_backend_sdl_jni_SDLGL_glDrawElements__IIILjava_nio_Buffer_2
// and the int-offset overload:
//   Java_arc_backend_sdl_jni_SDLGL_glDrawElements__IIII
//
// This file currently registers only the short name, guessing which overload
// Arc's SdlGL20/SdlGL30 classes actually call (the offset/int-pointer path,
// since that's the common libGDX-style "bind buffer, pass byte offset" usage).
// If Mindustry's textures/geometry come out wrong, this mismatch is the first
// place to look - paste the exact console error back and we'll add the
// mangled variant.
// ===========================================================================