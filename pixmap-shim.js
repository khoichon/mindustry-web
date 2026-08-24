// pixmap-shim.js
// arc.graphics.Pixmap normally decodes PNG/JPG bytes via a bundled C library (stb_image)
// through JNI, returning a direct java.nio.ByteBuffer of raw RGBA8888 pixels plus
// [address, width, height] in a long[] out-param. We don't need stb_image at all - the
// browser already has a very good image decoder built in (createImageBitmap + canvas),
// and it's simpler and more format-robust than porting stb_image to wasm would be.
//
// The one real wrinkle: loadJni's *return type* is java.nio.ByteBuffer, a Java object -
// we have to actually construct one from JS, not just hand back a typed array. That
// needs a live handle into the JVM that's actually running the game.
//
// IMPORTANT: earlier versions of this file (and buffers-shim.js/freetype-shim.js) used
// `window.CJ_LIB`, obtained via a *separate* `cheerpjRunLibrary('/app/Mindustry.jar')`
// call in index.html, to construct these ByteBuffers. That turned out to be the actual
// bug behind a `CheerpJ: Invalid type conversion attempted` + garbled downstream
// exception seen in real testing: cheerpjRunLibrary spins up its own JVM instance of the
// jar, separate from the one cheerpjRunJar is actually executing the game in, so an
// object built through it is foreign to the running app's bytecode - this is the same
// family of "library mode and the actual run don't share state" issue Round 2 already
// hit once with SharedLibraryLoader. Every native function (this one included) already
// receives a `lib` handle as its first argument, scoped to the actual running instance
// (gl-shim.js's readBuffer() already relies on this via `lib.getJNIDataView()`) - so we
// now construct Java objects through *that* instead, with a fallback to the old
// window.CJ_LIB path in case `lib` doesn't expose the same java.* namespace shape.

(function (global) {
  'use strict';
  const NATIVES = {};
  function native(name, fn) { NATIVES['Java_arc_graphics_Pixmap_' + name] = fn; }

  let lastFailureReason = '';

  async function getByteBufferClass(lib) {
    try {
      return await lib.java.nio.ByteBuffer; // scoped to the actually-running JVM instance
    } catch (e) {
      console.warn('[pixmap-shim] lib.java.nio.ByteBuffer unavailable, falling back to separate CJ_LIB instance', e);
      const cjLib = await global.getCJLibFallback();
      return await cjLib.java.nio.ByteBuffer;
    }
  }

  async function makeDirectByteBuffer(lib, bytes) {
    // bytes: Uint8Array/Int8Array/Uint8ClampedArray of raw content to wrap.
    // Despite the name (kept for readability at call sites - this used to allocateDirect+put),
    // this now uses ByteBuffer.wrap(byte[]), a *heap* buffer backed by a real Java array:
    //   1. It sidesteps a "CheerpJ: Invalid type conversion attempted" error that
    //      allocateDirect()+put(typedArray) hit in testing - wrap() is a single static
    //      factory call, which goes through CheerpJ's documented array<->byte[]
    //      conversion cleanly, unlike passing a typed array as an *instance method*
    //      argument (put()), which apparently doesn't convert the same way.
    //   2. It's array-backed (hasArray()==true), which is exactly what gl-shim.js's
    //      readBuffer() needs later to pull the pixel bytes back out - a real
    //      allocateDirect() buffer would have failed that same read on the way back out.
    //   3. If buffers-shim's alias probe confirms wrap() shares memory with the JS
    //      typed array, this also registers the buffer there, so gl-shim's reads of
    //      these pixels become a single TypedArray.slice() instead of per-element
    //      awaited gets.
    const ByteBufferClass = await getByteBufferClass(lib);
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (global.__wrapAliased) return global.__wrapAliased(ByteBufferClass, u8);
    // fallback if buffers-shim didn't load: plain wrap
    const signed = new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength);
    return ByteBufferClass.wrap(signed);
  }

  native('loadJni', async (lib, nativeData, buffer, offset, len) => {
    try {
      // `buffer` is the Java `byte[]` argument - CheerpJ should hand this to us as a
      // signed Int8Array per its documented primitive-array conversion. Defensive
      // coercion here in case it arrives as something without .subarray (e.g. a plain
      // array-like) - cheap insurance, not expected to trigger in practice.
      const src = (typeof buffer.subarray === 'function') ? buffer : Uint8Array.from(buffer);
      const encoded = src.subarray(offset, offset + len);
      // createImageBitmap sniffs the actual format from content, so this works for
      // PNG/JPG/etc regardless of what Mindustry's asset happens to be.
      const blob = new Blob([encoded]);
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height); // RGBA8888, matches STBI_rgb_alpha
      const directBuf = await makeDirectByteBuffer(lib, imgData.data);
      nativeData[0] = 0n;                     // "address" - unused by our shim, nothing to free
      nativeData[1] = BigInt(bitmap.width);
      nativeData[2] = BigInt(bitmap.height);
      return directBuf;
    } catch (e) {
      lastFailureReason = 'browser image decode failed: ' + (e && e.message || e);
      console.error('[pixmap-shim] loadJni failed (offset=' + offset + ' len=' + len +
        ' bufferLen=' + (buffer && buffer.length) + '):', e);
      return null; // Pixmap.load() checks for null and throws using getFailureReason()
    }
  });

  native('createJni', async (lib, nativeData, width, height) => {
    try {
      const blank = new Uint8Array(width * height * 4); // zero-filled = transparent black
      const directBuf = await makeDirectByteBuffer(lib, blank);
      nativeData[0] = 0n;
      nativeData[1] = BigInt(width);
      nativeData[2] = BigInt(height);
      return directBuf;
    } catch (e) {
      lastFailureReason = 'pixmap allocation failed: ' + (e && e.message || e);
      return null;
    }
  });

  native('free', async () => { /* no real native memory - the direct ByteBuffer is GC'd normally */ });
  native('getFailureReason', async () => lastFailureReason);

  global.PIXMAP_SHIM_NATIVES = NATIVES;
})(window);