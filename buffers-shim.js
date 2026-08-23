// buffers-shim.js
// arc.util.Buffers normally malloc()s raw native memory for "unsafe"/direct ByteBuffers
// used by Mesh/VertexBufferObject. We have no real native heap to allocate from, so
// instead we back these with ordinary array-backed java.nio.ByteBuffer objects
// (ByteBuffer.allocate(), not allocateDirect()) - deliberately, so they stay compatible
// with the readBuffer() helper in gl-shim.js, which only knows how to pull bytes out of
// array-backed buffers via hasArray()/array().
//
// copyJni: this was assumed unreachable (a previous version of this comment claimed
// Arc's Java16Buffers.copy() path - a plain dst.put(...) call, no native code - would
// always be preferred once OS.javaVersionNumber >= 16, which we report). Real testing
// showed that assumption was wrong: Buffers.copy()'s several overloads call copyJni()
// directly and unconditionally - there's no Java16Buffers branch in this class at all,
// that must have been a different call path this project hasn't hit. So copyJni needs a
// real implementation; see below.
//
// IMPORTANT: newDisposableByteBuffer constructs a real java.nio.ByteBuffer and must do so
// through the `lib` handle passed into every native call (scoped to the JVM instance
// actually running the game), not `window.CJ_LIB` (a separate cheerpjRunLibrary instance
// of the same jar) - see pixmap-shim.js's header comment for the full story on why the
// latter produces a "CheerpJ: Invalid type conversion attempted" + garbled exception.

(function (global) {
  'use strict';
  const NATIVES = {};
  function native(name, fn) { NATIVES['Java_arc_util_Buffers_' + name] = fn; }

  // Addresses are plain Numbers, NOT BigInt: CheerpJ marshals scalar Java `long`
  // LiveConnect-style (JS Number <-> long), and a BigInt return value reads back
  // as 0 on the Java side (proven by real-browser testing of freetype-shim.js's
  // initFreeTypeJni). getBufferAddress returns long, so its handles must be Numbers.
  let nextAddress = 1;
  const addressToBuffer = new Map();   // fake address -> Java ByteBuffer proxy
  const bufferToAddress = new WeakMap(); // Java ByteBuffer proxy -> fake address

  async function getByteBufferClass(lib) {
    try {
      return await lib.java.nio.ByteBuffer;
    } catch (e) {
      console.warn('[buffers-shim] lib.java.nio.ByteBuffer unavailable, falling back to window.CJ_LIB', e);
      return await global.CJ_LIB.java.nio.ByteBuffer;
    }
  }

  // ---- JS-aliased buffers: the bulk-copy fast path --------------------------------
  // CheerpJ's documented array conversion is *by reference* (Int8Array <-> byte[]).
  // If that holds through ByteBuffer.wrap(byte[]) too, then a buffer we create via
  // wrap(int8) SHARES memory with our JS typed array - and every bulk copy into/out
  // of it (copyJni's font bytes & vertex data, Pixmap pixel reads, glyph bitmaps)
  // collapses from one-awaited-put-per-element (catastrophically slow: a ~300KB font
  // is 300k sequential JS<->JVM round trips) to a single TypedArray.set(). Verified
  // at runtime with a one-time probe (write sentinel through JS, read it back through
  // the Java object); if the probe fails we keep the slow-but-correct scalar path.
  const aliasedBuffers = new WeakMap(); // Java ByteBuffer -> shared Uint8Array
  let aliasMode = 'unknown'; // 'unknown' | 'on' | 'off'
  // What bulk-write strategies this CheerpJ runtime actually supports, discovered by
  // probing once (real-run data: System.arraycopy path threw with no message, meaning
  // array() likely fails on wrap()-created buffers => they're direct, not heap).
  const caps = { alias: null, wrapArray: null, allocateArray: null, putByteBuffer: null, putInt: null };
  let createMode = 'wrap'; // 'wrap' (aliased) | 'allocate' (heap, array() usable) | 'wrap' (direct, last resort)
  async function probeCapabilities(ByteBufferClass) {
    const t8 = new Int8Array([1, 2, 3, 4]);
    try { // does array() work on a wrap() buffer, and is it live (by-reference)?
      const b = await ByteBufferClass.wrap(Int8Array.from(t8));
      const arr = await b.array();
      caps.wrapArray = !!arr;
      if (arr) { arr[0] = 9; caps.wrapArrayLive = (await b.get(0)) === 9; }
    } catch (e) { caps.wrapArray = false; }
    try { // does array() work on allocate() buffers, and is it live?
      const b = await ByteBufferClass.allocate(8);
      const arr = await b.array();
      caps.allocateArray = !!arr;
      if (arr) { arr[7] = 9; caps.allocateArrayLive = (await b.get(7)) === 9; }
    } catch (e) { caps.allocateArray = false; }
    try { // relative put(ByteBuffer) bulk transfer
      const b = await ByteBufferClass.allocate(8);
      const src2 = await ByteBufferClass.wrap(Int8Array.from(t8));
      await b.put(src2);
      caps.putByteBuffer = (await b.get(3)) === 4;
    } catch (e) { caps.putByteBuffer = false; }
    try { // absolute putInt (4 bytes per round trip)
      const b = await ByteBufferClass.allocate(8);
      await b.putInt(0, 0x04030201);
      caps.putInt = (await b.get(0)) === 1; // little-endian host
    } catch (e) { caps.putInt = false; }
    createMode = aliasMode === 'on' ? 'wrap'
      : (caps.allocateArray && caps.allocateArrayLive) ? 'allocate' : 'wrap';
    const msg = '[buffers-shim] bulk-copy capabilities: ' + JSON.stringify(caps) + ' -> creating buffers via ' + createMode;
    console.log(msg);
    if (!(aliasMode === 'on' || (caps.allocateArray && caps.allocateArrayLive))) console.error(msg);
  }
  async function wrapAliased(ByteBufferClass, bytes) {
    const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buf = await ByteBufferClass.wrap(signed);
    if (aliasMode === 'unknown') {
      const sentinel = 90, save = bytes[0];
      bytes[0] = sentinel;
      try {
        const probe = await buf.get(0);
        aliasMode = probe === sentinel ? 'on' : 'off';
        const msg = '[buffers-shim] ByteBuffer.wrap JS-aliasing: ' + (aliasMode === 'on'
          ? 'WORKS (bulk-copy fast path enabled)'
          : 'not available (probe read ' + probe + ') - using System.arraycopy bulk path');
        console.log(msg);
        if (aliasMode !== 'on') console.error(msg); // also surface on the page's red log
      } catch (e) {
        aliasMode = 'off';
        console.warn('[buffers-shim] alias probe threw', e);
      } finally {
        bytes[0] = save;
      }
    }
    if (aliasMode === 'on') aliasedBuffers.set(buf, bytes);
    return buf;
  }
  global.__BUFFERS_ALIAS = aliasedBuffers;
  global.__wrapAliased = wrapAliased; // shared with pixmap/freetype shims

  native('newDisposableByteBuffer', async (lib, numBytes) => {
    const ByteBufferClass = await getByteBufferClass(lib);
    let buf;
    if (aliasMode === 'unknown') {
      // first allocation doubles as the capability probe
      buf = await wrapAliased(ByteBufferClass, new Uint8Array(numBytes));
      await probeCapabilities(ByteBufferClass);
    } else if (createMode === 'allocate') {
      buf = await ByteBufferClass.allocate(numBytes);
    } else {
      buf = await wrapAliased(ByteBufferClass, new Uint8Array(numBytes));
    }
    const addr = nextAddress++;
    addressToBuffer.set(addr, buf);
    bufferToAddress.set(buf, addr);
    return buf;
  });

  native('getBufferAddress', async (lib, buffer) => {
    let addr = bufferToAddress.get(buffer);
    if (addr === undefined) {
      // Buffer wasn't allocated through newDisposableByteBuffer (e.g. registered via
      // Buffers.newUnsafeByteBuffer(ByteBuffer) on an already-existing buffer) - assign
      // it a fresh fake address on first sight so getBufferAddress/freeMemory stay
      // self-consistent regardless of how the buffer originated.
      addr = nextAddress++;
      addressToBuffer.set(addr, buffer);
      bufferToAddress.set(buffer, addr);
    }
    return addr; // long
  });

  native('freeMemory', async (lib, buffer) => {
    const addr = bufferToAddress.get(buffer);
    if (addr !== undefined) addressToBuffer.delete(addr);
    // no real native memory to free - the ByteBuffer is a normal GC'd Java object
  });

  native('clear', async (lib, buffer, numBytes) => {
    const js = aliasedBuffers.get(buffer);
    if (js) { // fast path: shared memory, zero it JS-side
      const pos = await buffer.position();
      js.fill(0, pos, pos + numBytes);
      return;
    }
    // Array-backed, so we can zero it directly on the JS side rather than looping
    // individual buffer.put(i, 0) calls through the JVM boundary.
    const arr = await buffer.array();
    const pos = await buffer.position();
    arr.fill(0, pos, pos + numBytes);
  });

  // ---- copyJni ------------------------------------------------------------------
  // 6 overloaded native signatures, all declared directly on Buffers (not nested), all
  // doing a straight memcpy per their JNI comment blocks:
  //   copyJni(float[] src, Buffer dst, int numFloats, int offset)              memcpy(dst, src+offset, numFloats<<2)
  //   copyJni(byte[]  src, int srcOffset, Buffer dst, int dstOffset, int numBytes)  memcpy(dst+dstOffset, src+srcOffset, numBytes)
  //   copyJni(short[] src, int srcOffset, Buffer dst, int dstOffset, int numBytes)  ditto
  //   copyJni(int[]   src, int srcOffset, Buffer dst, int dstOffset, int numBytes)  ditto
  //   copyJni(float[] src, int srcOffset, Buffer dst, int dstOffset, int numBytes)  ditto
  //   copyJni(Buffer  src, int srcOffset, Buffer dst, int dstOffset, int numBytes)  ditto
  // For the 5 "array src" overloads, srcOffset is in units of *src's own element type*
  // (a short-index for short[], a float-index for float[], etc - real C pointer
  // arithmetic on a typed pointer scales automatically), while dstOffset and numBytes
  // are always plain bytes (dst is treated as a raw byte target regardless of its
  // actual java.nio.Buffer subtype - that's exactly why the Java-side wrapper methods
  // in Buffers.copy() go through positionInBytes()/bytesToElements() before calling
  // down into this). The 4-arg float[] overload is the odd one out: offset/numFloats
  // are both in float units, and it always writes to dst starting at byte 0 (not
  // dst's position) - matches its call site, which does dst.position(0) itself
  // afterward.
  //
  // Same JNI-overload problem this project has hit twice before (GL overloads,
  // Soloud.sourcePlay): 6 native methods sharing the plain name `copyJni`, so every
  // overload needs its own long-form, argument-type-suffixed mangled name - the short
  // form registered below is kept too as a generic best-effort dispatcher (by argument
  // count/runtime type), but the long-form registrations are the ones actually relied
  // on to resolve correctly.
  //
  // WRITING INTO dst: per Round 9/10's discovery, only *scalar* arguments resolve when
  // calling a method on a live Java object instance from JS (bulk array arguments -
  // put(index, array, off, len) - don't). So this always ends up as one dst.put(index,
  // value) call per element, with `value`'s type and `index`'s unit depending on dst's
  // *actual* concrete Buffer subtype (ByteBuffer needs byte values at byte indices,
  // FloatBuffer needs float values at float indices, etc - Arc's own Java code
  // determines this the same way, via instanceof, in Buffers.elementShift()). We can't
  // do `instanceof` on a CheerpJ object proxy from JS, so this classifies dst by
  // `dst.constructor.name` instead - the same technique already used to inspect
  // argument types while diagnosing this. NOT YET CONFIRMED against real CheerpJ output
  // for what these constructor names actually are for HeapFloatBuffer/HeapIntBuffer/
  // HeapShortBuffer/HeapByteBuffer-equivalent view classes - the regexes below are a
  // reasonable first guess (matching literal "Float"/"Int"/"Short" in the class name,
  // falling back to byte-oriented access otherwise) but should be checked against
  // whatever the browser actually reports at the first opportunity.
  const seenCtorNames = new Set();
  function classifyDst(name) {
    // Log each distinct constructor.name once so a real browser run tells us what
    // CheerpJ's buffer classes are actually called (vs the regex guesses below).
    const key = name || '(no constructor.name)';
    if (!seenCtorNames.has(key)) {
      seenCtorNames.add(key);
      console.log('[buffers-shim] buffer class seen:', key);
    }
    if (name && /Float/.test(name)) return 'float';
    if (name && /Short/.test(name)) return 'short';
    if (name && /Int(?!eger)/.test(name)) return 'int';
    return 'byte'; // ByteBuffer / HeapByteBuffer / unrecognized - safest default
  }
  const ELEM_SIZE = { byte: 1, short: 2, int: 4, float: 4 };

  // Writes `bytes` (a Uint8Array of raw source bytes, native byte order) into `dst`
  // starting at `dstByteOffset` bytes in, using scalar put(index, value) calls in
  // whatever unit dst's real type needs.
  let slowScalarCount = 0;
  function toSignedBytes(bytes) {
    return bytes instanceof Int8Array ? bytes : new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  async function copyBytesIntoBuffer(lib, dst, dstByteOffset, bytes) {
    // Strategy 1: JS-aliased buffer (probe-verified shared memory) - one TypedArray.set.
    const js = aliasedBuffers.get(dst);
    if (js) { js.set(bytes, dstByteOffset); return; }
    const signed = toSignedBytes(bytes);
    // Strategies 2+3 share one array() attempt: if dst is heap, we get its byte[].
    let dstArr = null, arrOff = 0;
    try { dstArr = await dst.array(); arrOff = (await dst.arrayOffset()) | 0; } catch (e) { /* direct or view buffer */ }
    if (dstArr) {
      // Strategy 2: arrays convert by-reference (pixmap-shim's long[] out-params proved
      // it for native args) - write JS-side, then VERIFY through Java: if array() came
      // back as a copy, the write silently vanished and we must fall through. (Note
      // System.arraycopy with a copied array would be equally dead - Java would write
      // the copy - so there's no separate arraycopy strategy worth having here.)
      dstArr.set(signed, arrOff + dstByteOffset);
      try {
        const check = await dst.get(dstByteOffset + signed.byteLength - 1);
        if (check === signed[signed.byteLength - 1]) return;
      } catch (e) { /* fall through */ }
    }
    // Strategy 4: relative put(ByteBuffer) - instance call with a Java-object argument
    // (only typed-array args are known-broken on instance dispatch). Juggles
    // dst.position to hit dstByteOffset, restores it after.
    if (lib) {
      try {
        const ByteBufferClass = await getByteBufferClass(lib);
        const b2 = await ByteBufferClass.wrap(signed);
        const savedPos = await dst.position();
        if (savedPos !== dstByteOffset) await dst.position(dstByteOffset);
        await dst.put(b2);
        if (savedPos !== dstByteOffset) await dst.position(savedPos);
        return;
      } catch (e) {
        if (slowScalarCount === 0) console.warn('[buffers-shim] put(ByteBuffer) bulk path failed:', String((e && e.message) || e));
      }
    }
    // Strategy 5: scalar, but 4 bytes per round trip via putInt when aligned.
    const kind = classifyDst(dst?.constructor?.name);
    if (caps.putInt && kind === 'byte' && dstByteOffset % 4 === 0 && signed.byteLength % 4 === 0) {
      try {
        const dv = new DataView(signed.buffer, signed.byteOffset, signed.byteLength);
        for (let i = 0; i < signed.byteLength; i += 4) await dst.putInt(dstByteOffset + i, dv.getInt32(i, true));
        return;
      } catch (e) { /* fall through to per-byte */ }
    }
    // Strategy 6 (last resort): one awaited put() per element. Real-run data showed
    // multi-KB copies here at ~200ms each - the log line says what landed on this path.
    if (++slowScalarCount % 20 === 1) {
      console.error(`[buffers-shim] SLOW scalar copy path in use #${slowScalarCount}: ${signed.byteLength} bytes, dst=${dst?.constructor?.name}, caps=${JSON.stringify(caps)}`);
    }
    const size = ELEM_SIZE[kind];
    const dv = new DataView(signed.buffer, signed.byteOffset, signed.byteLength);
    const count = signed.byteLength / size;
    const dstElemOffset = dstByteOffset / size; // real call sites always keep this aligned to dst's element size
    for (let i = 0; i < count; i++) {
      let value;
      if (kind === 'float') value = dv.getFloat32(i * size, true); // true = little-endian; matches Buffers.order(ByteOrder.nativeOrder()) on every real desktop/browser platform
      else if (kind === 'short') value = dv.getInt16(i * size, true);
      else if (kind === 'int') value = dv.getInt32(i * size, true);
      else value = dv.getInt8(i * size);
      await dst.put(dstElemOffset + i, value);
    }
  }

  // Reads `numBytes` raw bytes out of `src` (a live Buffer, for the Buffer->Buffer
  // overload) starting at `srcByteOffset`, using the same scalar-get-then-reinterpret
  // approach as readBuffer() in gl-shim.js.
  async function readBytesFromBuffer(src, srcByteOffset, numBytes) {
    // heap-buffer fast path: pull the backing byte[] in one call
    try {
      const arr = await src.array();
      const arrOff = (await src.arrayOffset()) | 0;
      return new Uint8Array(arr.buffer, arr.byteOffset + arrOff + srcByteOffset, numBytes);
    } catch (e) { /* view/direct buffer - fall through to scalar reads */ }
    const kind = classifyDst(src?.constructor?.name); // same classification logic applies to src here
    const size = ELEM_SIZE[kind];
    const count = numBytes / size;
    const srcElemOffset = srcByteOffset / size;
    const out = new Uint8Array(numBytes);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < count; i++) {
      const v = await src.get(srcElemOffset + i); // scalar get(index) - see gl-shim.js's readBuffer() for why not bulk get(array)
      if (kind === 'float') dv.setFloat32(i * size, v, true);
      else if (kind === 'short') dv.setInt16(i * size, v, true);
      else if (kind === 'int') dv.setInt32(i * size, v, true);
      else dv.setInt8(i * size, v);
    }
    return out;
  }

  function typedArrayBytes(arr, elemOffset, elemCount, srcElemSize) {
    return new Uint8Array(arr.buffer, arr.byteOffset + elemOffset * srcElemSize, elemCount * srcElemSize);
  }

  // copyJni(float[] src, Buffer dst, int numFloats, int offset) - always writes to dst byte 0
  NATIVES['Java_arc_util_Buffers_copyJni___3FLjava_nio_Buffer_2II'] = async (lib, src, dst, numFloats, offset) => {
    await copyBytesIntoBuffer(lib, dst, 0, typedArrayBytes(src, offset, numFloats, 4));
  };
  // copyJni(byte[] src, int srcOffset, Buffer dst, int dstOffset, int numBytes)
  NATIVES['Java_arc_util_Buffers_copyJni___3BILjava_nio_Buffer_2II'] = async (lib, src, srcOffset, dst, dstOffset, numBytes) => {
    await copyBytesIntoBuffer(lib, dst, dstOffset, typedArrayBytes(src, srcOffset, numBytes, 1));
  };
  // copyJni(short[] src, int srcOffset, Buffer dst, int dstOffset, int numBytes) - srcOffset in shorts, numBytes already in bytes
  NATIVES['Java_arc_util_Buffers_copyJni___3SILjava_nio_Buffer_2II'] = async (lib, src, srcOffset, dst, dstOffset, numBytes) => {
    await copyBytesIntoBuffer(lib, dst, dstOffset, typedArrayBytes(src, srcOffset, numBytes / 2, 2));
  };
  // copyJni(int[] src, int srcOffset, Buffer dst, int dstOffset, int numBytes) - srcOffset in ints
  NATIVES['Java_arc_util_Buffers_copyJni___3IILjava_nio_Buffer_2II'] = async (lib, src, srcOffset, dst, dstOffset, numBytes) => {
    await copyBytesIntoBuffer(lib, dst, dstOffset, typedArrayBytes(src, srcOffset, numBytes / 4, 4));
  };
  // copyJni(float[] src, int srcOffset, Buffer dst, int dstOffset, int numBytes) - srcOffset in floats
  NATIVES['Java_arc_util_Buffers_copyJni___3FILjava_nio_Buffer_2II'] = async (lib, src, srcOffset, dst, dstOffset, numBytes) => {
    await copyBytesIntoBuffer(lib, dst, dstOffset, typedArrayBytes(src, srcOffset, numBytes / 4, 4));
  };
  // copyJni(Buffer src, int srcOffset, Buffer dst, int dstOffset, int numBytes)
  NATIVES['Java_arc_util_Buffers_copyJni__Ljava_nio_Buffer_2ILjava_nio_Buffer_2II'] = async (lib, src, srcOffset, dst, dstOffset, numBytes) => {
    await copyBytesIntoBuffer(lib, dst, dstOffset, await readBytesFromBuffer(src, srcOffset, numBytes));
  };

  // Short-form generic dispatcher, kept as a fallback in case CheerpJ resolves some
  // call sites via the plain name rather than the long mangled forms - best-effort
  // classification by argument count/runtime type rather than a guaranteed-correct
  // overload match, since the short form can't disambiguate the way the long forms do.
  native('copyJni', async (lib, ...args) => {
    try {
      if (args.length === 4) {
        const [src, dst, numFloats, offset] = args;
        return await NATIVES['Java_arc_util_Buffers_copyJni___3FLjava_nio_Buffer_2II'](lib, src, dst, numFloats, offset);
      }
      if (args.length === 5) {
        const [src, srcOffset, dst, dstOffset, numBytes] = args;
        if (src?.get) { // src is itself a Buffer object (has a .get method), not a typed array
          return await NATIVES['Java_arc_util_Buffers_copyJni__Ljava_nio_Buffer_2ILjava_nio_Buffer_2II'](lib, src, srcOffset, dst, dstOffset, numBytes);
        }
        const ctorName = src?.constructor?.name || '';
        if (ctorName.includes('Float32')) return await NATIVES['Java_arc_util_Buffers_copyJni___3FILjava_nio_Buffer_2II'](lib, src, srcOffset, dst, dstOffset, numBytes);
        if (ctorName.includes('Int16')) return await NATIVES['Java_arc_util_Buffers_copyJni___3SILjava_nio_Buffer_2II'](lib, src, srcOffset, dst, dstOffset, numBytes);
        if (ctorName.includes('Int32')) return await NATIVES['Java_arc_util_Buffers_copyJni___3IILjava_nio_Buffer_2II'](lib, src, srcOffset, dst, dstOffset, numBytes);
        return await NATIVES['Java_arc_util_Buffers_copyJni___3BILjava_nio_Buffer_2II'](lib, src, srcOffset, dst, dstOffset, numBytes);
      }
      console.error('[buffers-shim] copyJni: unrecognized argument count', args.length, args);
    } catch (e) {
      console.error('[buffers-shim] copyJni failed - see buffers-shim.js', e, args);
    }
  });

  global.BUFFERS_SHIM_NATIVES = NATIVES;
})(window);
