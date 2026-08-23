# HANDOFF: Mindustry-in-browser via CheerpJ

Read this first if you're picking this project up fresh. It covers what this is, every
fix made so far and *why*, the current status, and what to do next.

## The goal
Run the **unmodified** official `Mindustry.jar` (a Java/libGDX-family game, using Arc as
its framework) inside a browser tab, using **CheerpJ** (a WebAssembly-based JVM) rather
than porting/recompiling the game. CheerpJ runs the real bytecode; our job is to supply
JavaScript replacements for the handful of native (JNI) libraries Arc normally loads as
platform `.so`/`.dll` files, since those obviously can't run as native machine code inside
a WASM sandbox.

## Files in this project
- `Mindustry.jar` - the official v158.1 release jar, **already bytecode-patched**
  (Rounds 2, 7, 11, 12, 15 - see the fix log) - don't re-download a fresh copy without
  re-applying those patches. `Mindustry.jar.bak-round15` is the backup from just
  before Round 15's jar patches.
- `index.html` - the CheerpJ harness: boots the runtime, wires up all native shims,
  starts the game. Has an on-page error log (red text at the bottom) since whoever is
  testing is the only one who can see the real browser console.
- `gl-shim.js` - SDLGL native methods (~236 of them) mapped onto a real WebGL2 context.
  ID-table-based (GL uses int "names" for textures/buffers/etc, WebGL uses opaque
  objects, so we translate both ways).
- `sdl-shim.js` - SDL native methods (~44) mapped onto a `<canvas>` + DOM input events.
  Includes a USB-HID/SDL scancode table built from `KeyboardEvent.code`.
- `stub-natives.js` - SoLoud audio (real implementation via Web Audio API) + file dialogs
  (stubbed to always-cancelled). FreeType used to be stubbed here too; it's been split
  out into its own file now that it's a real implementation - see below.
- `pixmap-shim.js` - `arc.graphics.Pixmap`'s native image decoding, replaced with the
  browser's own `createImageBitmap`/canvas decoder instead of porting stb_image.
- `buffers-shim.js` - `arc.util.Buffers`' native memory allocation for
  Mesh/VertexBufferObject, replaced with plain array-backed Java `ByteBuffer`s.
- `freetype-shim.js` - **new this round.** Full implementation of all 58 native methods
  Arc's `FreeType.java` declares, backed by the browser's own `FontFace` API + Canvas2D
  instead of real libfreetype. See "Round 5" below for details - this was the last
  fully-stubbed native class and is the most likely place for new bugs to show up.
- `README.md` - the same fix log as this file but written incrementally as things were
  found; this HANDOFF.md is the up-to-date consolidated version. Keep both updated.

## How to test
Unzip everything into one folder, then from that folder:
```
python3 -m http.server 8080
```
Open `http://localhost:8080/` in **Chrome** (needs WebGL2 + WASM).
**Hard-refresh (Cmd/Ctrl+Shift+R) or use an incognito window every time** - plain browser
JS caching has already caused at least one confusing "fix didn't work" report that turned
out to just be a stale cached copy of a shim file. This is the single most common false
alarm to rule out first.

## Architecture notes worth knowing before touching anything
- **CheerpJ native registration**: natives are plain JS functions in a big object passed
  to `cheerpjInit({natives: {...}})`, keyed by a JNI-style name:
  `Java_<package_with_underscores>_<ClassName>_<methodName>`. Each shim file builds this
  object and exposes it on `window.SOMETHING_NATIVES`; `index.html` merges them all
  together before calling `cheerpjInit`.
- **JNI name mangling matters and bit us once already**: a literal underscore *inside* a
  Java method name (e.g. `SDL_Init`) must be escaped as `_1` in the native symbol name,
  separately from the underscores used as `Java_pkg_Class_method` separators. This is why
  `sdl-shim.js` has a `mangle()` helper - SDL's naming convention is full of underscores.
  camelCase Arc/Java method names (the vast majority elsewhere) don't have this problem.
  **If a fresh `UnsatisfiedLinkError` shows a method name that itself contains an
  underscore, check this first.**
- **Overloaded native methods** need JNI's *long* mangled form
  (`Java_..._method__<mangled-signature>`) to disambiguate, not just the short form.
  `gl-shim.js` has ~15 of these (e.g. `glDrawElements(int,int,int,Buffer)` vs
  `glDrawElements(int,int,int,int)`) - only the short name is currently registered, on a
  guess about which overload Arc actually calls. See the **OVERLOAD NOTES** comment block
  at the bottom of `gl-shim.js` for precomputed mangled names ready to add if this turns
  out to be wrong (would show up as broken rendering, not a crash, since JS doesn't error
  on unfound short names the same way - worth an active look, not just a console check).
- **Constructing real Java objects from JS**: some natives need to *return* a genuine Java
  object (e.g. `Pixmap.loadJni` returns a `java.nio.ByteBuffer`), not just a primitive.
  This needs a live handle into the running JVM via CheerpJ's "library mode"
  (`cheerpjRunLibrary`), set up once in `index.html` and exposed as `window.CJ_LIB` so any
  shim file can use it: `await window.CJ_LIB.java.nio.ByteBuffer.wrap(byteArray)` etc.
- **Prefer `ByteBuffer.wrap(array)` over `allocateDirect()+put()`** when constructing
  buffers from JS. The latter hit a `CheerpJ: Invalid type conversion attempted` error -
  passing a JS typed array as an argument to an *instance* method (`.put()`) doesn't
  convert the same way passing one to a *static factory call* (`wrap()`) does. Bonus:
  `wrap()` produces an **array-backed** buffer, which is required for the next point.
- **`readBuffer()` helper in `gl-shim.js`** pulls raw bytes out of `java.nio.Buffer`
  arguments (pixel/vertex data) via `buf.hasArray()`/`buf.array()`. This only works for
  **array-backed** buffers, not real direct/native ones (which don't exist for us anyway).
  This is *why* `pixmap-shim.js` and `buffers-shim.js` both deliberately use
  array-backed buffers (`wrap()` / `allocate()`) instead of `allocateDirect()` - direct
  buffers would silently fail this read later on.
- **Long (`long`) values in native args/arrays - SETTLED in Round 15**: scalar `long`
  args/returns use plain JS **`Number`** (CheerpJ follows LiveConnect for scalars); a
  BigInt return reads back as `0` in Java. `long[]` **arrays** use `BigInt64Array` with
  BigInt elements (documented extension). So: fake addresses/handles in shims are
  Numbers, incoming long args are normalized (`typeof x === 'bigint' ? Number(x) : x`,
  see `h()`/`H()` helpers) since either representation may arrive, and only array
  elements are BigInt (`nativeData[0] = 0n` in pixmap-shim.js is correct as-is).
- **The jar is ground truth for native declarations, not the Arc repo source**: this
  build's jar has drifted from upstream (`Soloud` declares `wavLoad`/`streamLoad`,
  repo says `wavLoadBytes`/`wavLoadFile`; FreeType declares 68 natives here vs 58 in
  the repo). Before registering or auditing natives, extract the class from
  `Mindustry.jar` and `javap` it: `unzip Mindustry.jar 'arc/...Class.class' && javap -p ...`.
  Overloaded natives need long-form names computed from the *jar's* descriptors.
- **Bytecode patches must pass `java -Xverify:all`** before shipping (load the patched
  classes via `Class.forName` from a tiny harness on the jar's classpath). CheerpJ's
  verifier is lenient enough to accept StackMapTable inconsistencies that a real JVM
  rejects - Round 15 found Rounds 11/12 had shipped exactly such a bug. Equal-length
  edits keep offsets stable but only verification proves frame consistency.

## Fix log (chronological, root causes explained)

### Round 1: getting the window open
1. **"Java 25 is required" error** - `DesktopLauncher.checkJavaVersion()` actually checks
   `arc.util.OS.javaVersionNumber >= 17` (found by disassembling with `javap`, not by
   reading the misleading error text). Fixed by `cheerpjInit({version: 17})`.
2. **`GLEW failed to initialize: SDLGL (WebGL2 shim)`** - not a real GPU problem. Arc's
   `SdlGraphics` does `String err = SDLGL.init(); if (err != null) throw ...` - `init()`
   must return `null` on success. Was returning a debug label string by mistake.
3. **`OpenGL 2.0 or higher with the FBO extension is required`** - not a real GPU
   problem either. Arc's `GLVersion` parser regex-matches the *first* number pattern in
   the `GL_VERSION` string; the browser's real string
   (`"WebGL 2.0 (OpenGL ES 3.0 Chromium)"`) has a misleading "2.0" before the "3.0" that
   reflects actual capability. Fixed by special-casing `glGetString(GL_VERSION)` to
   return `"3.0.0 WebGL2 ..."` instead of forwarding the raw browser string.
4. **`UnsatisfiedLinkError: ..._SDL_SDL_1Init`** - JNI mangling issue, see architecture
   notes above. Fixed with the `mangle()` helper in `sdl-shim.js`.

### Round 2: native library loading (the hardest one)
5. **`Couldn't load shared library 'libarc.so'`** - Arc's `SharedLibraryLoader` tries to
   extract-and-`System.load()` a real x86 `.so`, which can never work in a WASM JVM.
   - First attempt: called Arc's own `SharedLibraryLoader.setLoaded(name)` escape hatch
     via `cheerpjRunLibrary` before starting the game with `cheerpjRunMain`. **Did not
     work** - the same crash came back, meaning library-mode calls and the actual app run
     don't reliably share static class state the way hoped.
   - **What actually worked**: patched `arc/util/SharedLibraryLoader.class` **directly
     inside `Mindustry.jar`** so `load(String)` is permanently a no-op (single `return`
     instruction). Tooling: `jawa` (`pip install jawa`, pure-Python JVM classfile
     library) to read/write the classfile. Had to **write a `StackMapTableAttribute.pack()`
     implementation from scratch and monkeypatch it in** - jawa can read stack maps but
     its own `pack()` is a bare `raise NotImplementedError()`, so essentially no
     real-world Java 7+ classfile can be saved through it without this. Also had to clear
     the patched method's now-stale exception table / line-number table / local-variable
     table (they referenced byte offsets from the original ~124-byte method body that no
     longer exist in the 1-byte replacement).
   - **Verified against a real JDK 21 (`java -Xverify:all`)**, not just hoped CheerpJ
     would accept it - loaded the patched class, called `.load("nonexistent-lib")` on it,
     confirmed it returns cleanly instead of throwing, *before* ever testing in-browser.
   - This patch is baked into the `Mindustry.jar` sitting in this project already.
     `index.html` calls plain `cheerpjRunJar` - no JS-side workaround needed anymore.
   - **If this exact crash ever comes back** (a fresh `.so`-loading `UnsatisfiedLinkError`
     from a *different* class than `SharedLibraryLoader`), the same patching technique
     applies - see the Python snippet pattern in git history / prior chat, or ask for it
     to be redone for the new class.

### Round 3: image decoding
6. **`UnsatisfiedLinkError: Java_arc_graphics_Pixmap_loadJni`** - new native class,
   `arc.graphics.Pixmap`, decodes PNG/JPG bytes via bundled stb_image normally. Replaced
   entirely with the browser's own decoder (`createImageBitmap` + canvas
   `getImageData`) - see `pixmap-shim.js`. Simpler and more format-robust than porting
   stb_image to wasm would have been.
7. **`CheerpJ: Invalid type conversion attempted`** (cascading into
   `ArrayIndexOutOfBoundsException` in `Pixmap.load()`) - the `allocateDirect()+put()`
   bug described in the architecture notes above. Fixed with `ByteBuffer.wrap()`.

### Round 4: mesh/vertex buffer allocation
8. **`UnsatisfiedLinkError: Java_arc_util_Buffers_newDisposableByteBuffer`** - new native
   class, `arc.util.Buffers`, used by `Mesh`/`VertexBufferObjectWithVAO` for vertex data
   allocation. Implemented in `buffers-shim.js` using the same array-backed-buffer
   strategy as the Pixmap fix (`ByteBuffer.allocate()`, fake incrementing "addresses" in a
   JS `Map`/`WeakMap` for `getBufferAddress`/`freeMemory` bookkeeping since there's no
   real native heap to hand out addresses into).
   - Deliberately did **not** implement `Buffers.copyJni`'s several overloads - confirmed
     by reading `Pixmap.java` that `supportsBufferCopy = OS.javaVersionNumber >= 16` is
     `true` for us (we report Java 17), so Arc prefers `Java16Buffers.copy()` (a plain
     `dst.put(src, ...)` call, zero native code) and the JNI copy path should never
     actually be reached. If a `copyJni` `UnsatisfiedLinkError` shows up anyway, this
     assumption was wrong and those need implementing too.

### Round 5: FreeType (font rendering) - the last stubbed native class
9. **FreeType was fully stubbed** (fake incrementing handles, no real glyph data) - this
   was the known next blocker per the previous handoff, since Mindustry can't show any
   UI text without it and the main menu needs text almost immediately. Replaced with a
   real implementation in `freetype-shim.js`, backed by the browser's own font engine
   (`FontFace` API to load the ttf/otf bytes Arc hands us, then plain Canvas2D
   `ctx.font`/`measureText`/`fillText` to measure and rasterize each glyph) instead of
   porting libfreetype.
   - **Found and fixed a mangling bug in the old stub while replacing it**: every
     FreeType native was registered under the flat name
     `Java_arc_freetype_FreeType_<method>`. That's only correct for the two methods
     that are true direct members of the `FreeType` class (`getLastErrorCode`,
     `initFreeTypeJni`) - the other 56 are declared on nested static classes
     (`Face`, `Library`, `Bitmap`, `GlyphSlot`, `Glyph`, `Size`, `SizeMetrics`,
     `GlyphMetrics`, `Stroker`), which need an extra `_00024<ClassName>_` segment
     under real JNI mangling (the same family of issue as the `SDL_1Init` underscore
     bug from Round 1, just for `$` instead of `_`). Verified all 58 declared native
     methods in Arc's `FreeType.java` are now registered with the correct name by
     cross-checking against the source directly (see the git history of this fix for
     the check script) - none missing, and the split between flat/nested names matches
     the source exactly (2 flat, 56 nested).
   - **Object model**: FreeType's real API is entirely `long`-pointer-based (Library,
     Face, Size, SizeMetrics, GlyphSlot, Glyph, Bitmap, GlyphMetrics, Stroker are all
     just addresses). Reproduced with a JS handle table (`BigInt` address -> plain JS
     object), same pattern as `buffers-shim.js`'s fake addresses - there's no real
     native heap to hand out pointers into either.
   - **26.6 fixed-point**: real FreeType reports most metrics (advance, bearings,
     ascender, etc.) in 26.6 fixed-point - Arc's own `FreeType.toInt()` does
     `((v + 63) & -64) >> 6` to convert back to pixels. Our shim measures everything in
     plain pixels via Canvas2D `TextMetrics`, then multiplies by 64 (`fx()` helper) to
     produce fixed-point values FreeTypeFontGenerator.java expects - confirmed correct
     by tracing every call site in `FreeTypeFontGenerator.java` back to `toInt()`.
   - **Kerning intentionally not implemented** - `hasKerning()` always returns `false`,
     which makes `FreeTypeFontGenerator`'s kerning-table code path a no-op rather than
     something we'd need to fake convincingly. Matches the plan the previous stub
     already flagged (Mindustry's UI doesn't need pixel-perfect kerning).
   - **Bitmap-strike fonts (embedded bitmap glyphs) not supported** - `getFaceFlags()`
     always returns 0 (never `FT_FACE_FLAG_FIXED_SIZES`), so Arc's
     `checkForBitmapFont()` always takes the normal scalable-outline path, which is
     what every font Mindustry ships actually is.
   - **Stroker/outline text is a rough approximation**, not real FT outline stroking -
     `Glyph.toBitmap()` draws the requested radius with `ctx.strokeText()` in addition
     to the normal fill. Good enough for drop-shadow/outlined UI text, not pixel-exact
     against what real FreeType would produce.
   - **Not yet tested in an actual browser** (no browser available in the sandbox that
     built this) - verified the shim loads without syntax errors, registers every
     expected native under the right mangled name, and reasoned through the metric math
     against Arc's source, but the *first* real signal on whether text actually renders
     correctly (right size, right position, not upside-down, etc.) will be an actual
     screenshot/description from testing this in Chrome.

### Round 6: the CJ_LIB bug (real testing finally caught it)
10. **Root-caused a bug that had been silently lurking since Round 3.** Real browser
    testing hit two crashes with the identical fingerprint - `CheerpJ: Invalid type
    conversion attempted` immediately followed by a garbled Java exception
    (`ArrayIndexOutOfBoundsException` in both cases, from unrelated call sites: once in
    `Pixmap.load()` during icon loading, once in `Buffers.newUnsafeByteBuffer()` during
    `Mesh` construction for the planet-select 3D view). Both call sites had one thing in
    common: constructing a `java.nio.ByteBuffer` via `window.CJ_LIB` to hand back as a
    native method's return value.
    - **Root cause**: `window.CJ_LIB` was set up via a *separate*
      `cheerpjRunLibrary('/app/Mindustry.jar')` call in `index.html` - a second,
      independent JVM instance of the same jar, distinct from the one `cheerpjRunJar`
      actually runs the game in. A `ByteBuffer` constructed in that separate instance is
      foreign to the bytecode of the instance actually executing, hence the "invalid
      type conversion" the moment it's handed back as a native return value and the
      running app tries to use it. This is the same *family* of bug as Round 2's
      discovery that `cheerpjRunLibrary` and `cheerpjRunMain`/`cheerpjRunJar` don't
      reliably share state - it just wasn't caught for *this* use of library mode until
      real testing exercised these particular code paths.
    - **Fix**: every native function already receives a `lib` handle as its first
      argument, scoped to the actual running instance (`gl-shim.js`'s `readBuffer()` had
      already been relying on this via `lib.getJNIDataView()`, which should have been
      the tell). `pixmap-shim.js`, `buffers-shim.js`, and `freetype-shim.js`'s
      `Bitmap.getBuffer` now all construct `ByteBuffer`s through `lib.java.nio.ByteBuffer`
      instead, with a try/catch fallback to the old `window.CJ_LIB` path kept only in
      case some other class's `lib` handle doesn't expose the same shape (untested
      hedge, not expected to be needed).
    - **Not yet re-verified in-browser** - reasoned through from the error pattern and
      the existing `lib.getJNIDataView()` precedent, not confirmed working yet. This is
      the first thing to check on the next test.

### Round 7: GLSL version translation + the writeIntBuffer buffer-write bug
11. **First shader-compile error from real testing**: `#version 130 client/version number
    not supported`. Mindustry's bundled shaders are desktop GLSL (`#version 130`+), and
    WebGL2's ANGLE compiler only accepts GLSL ES 3.00 (`#version 300 es`). GLSL 130
    already uses `in`/`out` (not the older `attribute`/`varying`), so the actual syntax
    is almost identical to GLSL ES 300 - the real gaps are just the version line itself
    and GLSL ES's mandatory float precision qualifier in fragment shaders (desktop GLSL
    has no concept of precision qualifiers at all). Added `translateGlsl()` in
    `gl-shim.js`, called from `glShaderSource`, which rewrites `#version 130` (or any
    `#version <N> [profile]`) to `#version 300 es` and injects
    `precision mediump float;` right after it for fragment shaders only (tracked via a
    `shaderTypes` map populated at `glCreateShader` time, since `glShaderSource` alone
    doesn't know if it's compiling a vertex or fragment shader). Logs the translated
    source to the console so mismatches are easy to spot by eye.
    - **Caught my own regex bug while writing this**: the optional version-profile-suffix
      group used `\s+\w+`, and `\s` matches newlines - it was silently swallowing the
      next line's first token (e.g. `#version 130\nuniform` became `#version 300
      es` with `uniform` eaten entirely). Fixed to `[ \t]+\w+` (space/tab only, not
      newline) and re-tested against representative vertex/fragment shader strings
      before shipping.
    - The same crash's error log also showed some likely-cascading diagnostics on a
      `texture()` call (dimension mismatch, no matching overload) - very plausibly just
      parser confusion from the whole shader failing at the `#version` line, not a real
      separate bug, but worth a second look if that specific error persists after
      retesting with the version fix in.
12. **`writeIntBuffer` fallback warning, spotted in the same log**: this is the code path
    `glGetShaderiv`/`glGetProgramiv`/etc. use to write GL query results (e.g. compile
    status) back into a Java `IntBuffer` argument. It only works for *array-backed*
    buffers (`hasArray()`); Arc's `Buffers.newIntBuffer()`/`newFloatBuffer()`/
    `newByteBuffer()`/`newShortBuffer()` all allocate via `ByteBuffer.allocateDirect()`,
    which is a genuinely direct buffer with no JS-visible backing array - so every write
    through this path was silently falling through to a no-op warning. Left unfixed,
    this would mean shader compile-status queries always read back as `0`/`false`
    **even for shaders that compiled successfully** - the GLSL translation fix above
    would very likely have just traded one `IllegalArgumentException: Failed to compile
    shader` for another, indistinguishable one, on shaders that actually worked.
    - **Fix: bytecode-patched `Buffers.class` inside `Mindustry.jar`** so those four
      allocator methods call `ByteBuffer.allocate()` instead of `allocateDirect()` -
      same signature, so no code restructuring needed, just retargeting the
      `invokestatic` operand to a different constant-pool method reference. This makes
      every `IntBuffer`/`FloatBuffer`/`ByteBuffer`/`ShortBuffer` Arc hands to a native
      call array-backed, so the existing `hasArray()`/`array()`-based read/write helpers
      in `gl-shim.js` (already used for everything else) just work for these too,
      without needing raw WASM-linear-memory access.
    - **Hit jawa's `cf.save()` StackMapTable limitation again** (same class of problem
      Round 2's `SharedLibraryLoader` patch ran into) - jawa can locate/parse
      `StackMapTable` attributes fine but raises `NotImplementedError` trying to
      re-serialize them, so any patch route through `cf.save()` fails on a
      `StackMapTable`-bearing method (which is any method compiled for Java 6+). Worked
      around it the same way as before: hand-rolled the binary edit directly -
      appended 3 new constant-pool entries (`Utf8("allocate")`, a `NameAndType`, and a
      `Methodref`, reusing the existing `java/nio/ByteBuffer` class-index and
      `(I)Ljava/nio/ByteBuffer;` descriptor-index already present from `allocateDirect`)
      right after the existing constant pool, bumped `constant_pool_count` by 3, then
      did a byte-level find/replace of the 3-byte `invokestatic <old-methodref-index>`
      sequence with the new index at all 4 call sites. Verified afterward: re-parsed and
      disassembled the patched class with jawa and confirmed all four methods
      (`newFloatBuffer`/`newShortBuffer`/`newByteBuffer`/`newIntBuffer`) now call
      `allocate` instead of `allocateDirect`, and that the class still disassembles
      cleanly end-to-end (proof the untouched `StackMapTable` bytes are still internally
      consistent, since we never changed any instruction's length - only the 2-byte
      constant-pool index each `invokestatic` points at). The patch script isn't saved
      anywhere in this repo (it was a one-off run in the sandbox); if another
      `allocateDirect`-based Java-side buffer bug turns up elsewhere, redo the same
      "append constant pool entries, raw-replace `invokestatic` operand bytes" recipe
      rather than fighting jawa's `cf.save()` again.
    - **Neither fix has been re-verified in an actual browser yet** - both are reasoned
      from the error text and Arc's source, not confirmed against a fresh test run.

### Round 8: precision-injection ordering bug (found via real testing)
13. Round 7's `translateGlsl()` skipped injecting `precision mediump float;` when the
    shader already had one anywhere in its source - reasonable in principle (redundant
    precision statements are legal GLSL), but real testing showed why it's not
    sufficient here: Mindustry's fragment shaders carry their own
    `#ifdef GL_ES / precision mediump float; / #else #define lowp ... #endif` block as
    cross-platform desktop/ES boilerplate, but it's positioned *after* other global
    declarations like `out vec4 fragColor;` - harmless on desktop (no precision concept
    at all there) but GLSL ES 300 requires a precision already in effect before the
    first declaration that needs one, producing exactly the observed
    `ERROR: 0:2: '' : No precision specified for (float)` pointing at that `out`
    line, one line before the shader's own block took effect.
    - **Fix**: inject unconditionally, immediately after `#version 300 es`, regardless
      of whether the shader has its own precision block further down - two precision
      statements for the same type is legal GLSL, the later one just overrides the
      earlier one for subsequent code, so there's no downside to always doing this.
      Re-tested against the exact shader source from the real failure (visible in the
      `[gl-shim] translated shader source to...` console log this bug was caught from)
      to confirm the ordering is correct post-fix.
    - The same log still showed the `writeIntBuffer` fallback warning from Round 7's
      other fix (the `Buffers.class` `allocateDirect`->`allocate` bytecode patch) - that
      test run was very likely still on the pre-patch jar build, not a sign the patch
      didn't work. Worth explicitly confirming that warning is actually gone on the next
      test, now that both fixes are in the same build.

### Round 9: the real fix for buffer read/write - put()/get(), not hasArray()/array()
14. Round 7's `Buffers.class` bytecode patch (`allocateDirect` -> `allocate`) turned out
    to be necessary but not sufficient. Real testing after that patch still showed the
    `writeIntBuffer` fallback firing, now producing `Failed to compile shader: ` with an
    **empty** log - meaning the shader had genuinely compiled fine (no GLSL errors to
    report) but the compile-status readback was still stuck at 0/false.
    - **Root cause**: `Buffers.newIntBuffer()`/`newFloatBuffer()`/`newShortBuffer()`
      don't return the `ByteBuffer` they allocate - they return a *view* of it via
      `.asIntBuffer()`/`.asFloatBuffer()`/etc. Per standard `java.nio.Buffer` semantics
      (true in a real JVM too, not a CheerpJ-specific quirk), a view buffer's
      `hasArray()` always reports `false`, *regardless of whether the underlying
      `ByteBuffer` is heap- or direct-backed* - the view class just doesn't expose the
      array. So the Round 7 patch fixed the underlying storage but couldn't have fixed
      `writeIntBuffer`, since `hasArray()`-based access was never going to work for
      these specific view buffers no matter what backs them. This is exactly the buffer
      type `Shader.loadShader()` uses for `GL_COMPILE_STATUS` (`Buffers.newIntBuffer(1)`),
      which is why this specific call site kept failing.
    - **The actual fix**: stop trying to reach into a buffer's backing array at all.
      `writeIntBuffer`/`writeFloatBuffer`/`writeByteBuffer` in `gl-shim.js` now use the
      buffer's own absolute `put(index, value)` method (bulk `put(index, byte[], off,
      len)` for the byte case, since that path also handles potentially-large
      `glReadPixels` calls) - completely ordinary `java.nio.Buffer` API calls on the
      real object reference the native call already received as an argument. This works
      identically for direct, heap, or view buffers, since a view buffer's `put()`
      writes straight through into its backing `ByteBuffer`'s storage - there's no need
      to know or care what's backing it.
    - **Found and fixed the same latent bug in the read direction too**, before it had a
      chance to cause a separate confusing failure later: `readBuffer()` (used for
      pulling data *out* of Java buffers passed as native arguments - vertex data,
      uniform arrays, etc.) had the identical `hasArray()`-based approach, with a
      fallback path whose own comment admitted it was `"not a real java.nio.Buffer
      method - placeholder"` and had never actually been implemented. Any `FloatBuffer`/
      `IntBuffer` view passed to e.g. a `glUniform4fv` call would have hit this exact
      same dead end. Replaced with the read-direction mirror of the same fix: the
      buffer's own bulk relative `get(dst[])`, saving/restoring `position()` around the
      call so it behaves like a non-destructive read from the caller's point of view.
    - **Verified the new logic (not just syntax) against a mock buffer** that reproduces
      the actual failure mode - `hasArray()` hardcoded to `false` like a real view
      buffer, but `put`/`get`/`position`/`remaining` behaving like the real NIO API -
      and confirmed a write-then-read-back round-trip works correctly through it.
    - Double-checked `buffers-shim.js` and `freetype-shim.js`'s own `hasArray()`/
      `.array()` uses (`Buffers.clear()`, FreeType's `newMemoryFace` font-byte read) are
      **not** affected by this - both operate on genuine top-level `ByteBuffer`s from our
      own `newDisposableByteBuffer` implementation (never a view), so left as-is rather
      than changing something that wasn't broken.
    - **Not yet re-verified in an actual browser.**

### Round 10: bulk array arguments don't resolve on instance method calls either
15. Round 9's `readBuffer()` fix (bulk `get(dst[])`) failed in real testing with
    `Method 'get' cannot be resolved for these parameters` - a CheerpJ-level overload
    resolution error, not a JS exception. Root cause: CheerpJ's dynamic dispatch for
    *regular* (non-native) Java instance method calls - i.e. calling a method on a live
    object reference we received, like `buf.get(...)` - apparently can't resolve any
    overload when a JS typed array is passed as an argument, even though passing plain
    scalars (ints/floats) works fine and is what `writeIntBuffer`'s `put(index, value)`
    calls already relied on. This is a *different* mechanism from native-method-argument
    marshalling (which does handle typed arrays - see `pixmap-shim.js`'s
    `ByteBufferClass.wrap(signed)`), and also different from calling a **static** method
    through a class reference obtained via `lib`/`CJ_LIB` (which also appears to handle
    typed-array arguments fine - `wrap()` and `allocate()` elsewhere in this codebase
    are exactly that, and haven't shown this failure). So the emerging rule of thumb:
    typed-array arguments are fine for natives and for static factory calls through a
    class reference, but not for calling a method on a live object instance.
    - **Fix**: `readBuffer()` now loops absolute scalar `get(index)` calls instead of
      one bulk `get(array)` call - mirrors the scalar-only shape that was already
      working on the write side. Also dropped the bulk `put(index, byte[], off, len)`
      attempt from `writeByteBuffer` (same underlying limitation would apply to it too,
      it just hadn't been exercised by testing yet) rather than leave a call that's now
      known to always fail as a wasted first attempt on every invocation.
    - Re-verified against a mock buffer that specifically throws the exact CheerpJ error
      text when given a non-scalar argument, confirming the new scalar-only path
      round-trips correctly through it.
    - Performance note for later: this makes `readBuffer`/`writeByteBuffer` O(n) JS<->JVM
      round trips instead of O(1) - fine for the small status/id buffers most call sites
      use, worth watching if it turns out to bottleneck a large `glReadPixels` capture.

### Round 11: raw sockets don't exist in a browser - Client's Selector.open()
16. **First error past all rendering/shader/font init** - `UnsatisfiedLinkError:
    Java_sun_nio_ch_EPoll_eventSize`, from `arc.net.Client`'s constructor calling
    `Selector.open()`. This one's a fundamentally different situation from every
    previous fix: `sun.nio.ch.EPoll` is JDK-internal Linux epoll machinery backing
    `java.nio.channels.Selector` - there's no browser equivalent to shim at all, since a
    browser sandbox has no raw TCP socket API in the first place. This isn't a "find the
    right JS API and wire it up" problem like GL/SDL/FreeType were.
    - **The actual goal isn't "make real networking work"** (that would need an entirely
      different transport - WebSocket/WebRTC through a relay, the way the person's other
      browser-porting projects like the v86 Linux emulator and webssh use a Wisp relay
      for real TCP - a whole separate feature, out of scope for "reach the menu and play
      singleplayer"). The goal here is just: don't let this crash startup.
    - `Client`'s constructor already wraps `Selector.open()` in
      `try{...}catch(IOException ex){ throw new RuntimeException(...); }`, but
      `UnsatisfiedLinkError` is an `Error`, not an `Exception` - `IOException extends
      Exception`, so it was never going to be caught by this handler, matching the
      observed uncaught propagation all the way to `DesktopLauncher.main()`.
    - **Fix: bytecode-patched `arc/net/Client.class`** (widened the same file's existing
      constructor, not a new one) so the catch clause catches `java/lang/Throwable`
      instead of `java/io/IOException`, and replaced the handler body (which threw a
      wrapped `RuntimeException`) with `pop; nop×13` - discards the caught
      throwable and falls straight through into the constructor's existing `return`,
      leaving `this.selector` at its default `null` instead of propagating anything.
      `Client` construction now completes successfully; any later attempt to actually
      *use* the connection (multiplayer) would presumably NPE on the null selector at
      that point, which is fine for now since it's decoupled from reaching the menu.
    - **Different patching technique than Round 7's `Buffers.class` fix**, worth noting
      for next time: that one only needed to retarget a constant-pool index (same
      instruction length, trivially safe). This one needed to change actual instruction
      bytes inside a method body (the handler's `throw new RuntimeException(...)`
      sequence), which risks invalidating a `StackMapTable`'s frame offsets if the code
      *length* changes anywhere before/after the edit. Sidestepped that entirely by
      replacing the 14-byte handler with an *equal-length* 14-byte replacement (`pop` +
      13 `nop`s, padding out to the original length) - every instruction on every side of
      the edit keeps the exact same byte offset, so the `StackMapTable` (never touched)
      stays valid without needing to understand or regenerate it. This "same-length
      replacement, pad with `nop`" trick is the general escape hatch for future patches
      that need to change *behavior* inside a method body, not just *which* constant an
      instruction references - reach for it before trying to fight jawa's `cf.save()`
      into re-serializing a `StackMapTable` again (it can't, per Round 7's discovery).
    - Verified by re-disassembling the patched method afterward: exception table now
      reads `catch java/lang/Throwable`, handler body is `pop; nop×13; return`
      exactly as intended, and every instruction before/after keeps its original byte
      offset (confirms the `StackMapTable` wasn't invalidated).
    - **Not yet re-verified in an actual browser.**

### Round 12: same Selector.open() fix, for Server this time
17. `ArcNetProvider`'s constructor builds both a `Client` (Round 11) and a `Server` (for
    hosting) - same `Selector.open()` pattern, same `UnsatisfiedLinkError` on
    `sun.nio.ch.EPoll`, just one constructor further along. Applied the exact same fix:
    widened `arc/net/Server.class`'s constructor catch clause from `IOException` to
    `Throwable`, replaced the 14-byte `throw new RuntimeException(...)` handler body
    with the same `pop; nop×13` equal-length no-op, verified by re-disassembly. Nothing
    new here technique-wise, just the same recipe applied to the sibling class - noting
    it in case a third `Selector.open()`-alike site turns up somewhere else in the net
    stack (`arc.net` has other Selector/Channel usage - e.g. `updateConnection()`s
    - that hasn't been reached by startup yet and might surface once `ArcNetProvider`
      construction actually succeeds).

## Networking beyond "don't crash on startup"
Both fixes above only make `ArcNetProvider` construction *not throw* - `Client`/
`Server`'s `selector` fields end up `null`, so actually trying to connect/host later
would presumably NPE rather than work. That's fine for reaching the menu/singleplayer,
which was the actual goal, but real multiplayer needs an actual transport, and raw TCP
sockets fundamentally don't exist in a browser sandbox - there's no native API to shim
here the way GL/SDL/FreeType had one.

The person has already solved exactly this problem before in other projects (per their
own notes: the v86 Linux-in-browser port and the browser SSH client both bridge real TCP
through a **Wisp** relay over WebSocket) and suggested the same approach here, which is
the right call - it's the standard "give a browser real sockets" pattern. Scoping it
honestly since it's a substantially bigger piece of work than anything done so far,
worth doing as its own dedicated round once singleplayer is confirmed working, not
bundled into this one:
- `arc.net.Client`/`Server` use a custom KryoNet-derived binary wire protocol over raw
  `SocketChannel`/`DatagramChannel` (TCP for reliable traffic, UDP for the rest) - a
  genuinely different shape of problem than anything shimmed so far, since it's ongoing
  bidirectional async I/O against a live connection, not one-shot request/response calls
  like GL or FreeType.
- Two realistic approaches once it's time to build this:
  1. **Shim at the `SocketChannel`/`Selector` level** - keep `Client`/`Server`'s Java
     code as-is, and back `SocketChannel.read/write/connect` and `Selector.select()`
     with a WebSocket-to-Wisp-relay connection under the hood. Bigger surface (more of
     `java.nio.channels` to cover) but Mindustry's own protocol code needs zero changes.
  2. **Replace `NetProvider` at the Mindustry layer** - implement `mindustry.net.NetProvider`
     directly against a WebSocket (bypassing `arc.net`'s `Client`/`Server` and its NIO
     usage entirely). Less to shim, but means reimplementing the KryoNet-style framing
     Mindustry's servers actually speak, so it'd only work if a real Mindustry server is
     reachable through the relay and expecting that exact protocol.
  Given the person's precedent (bridging to a *real* remote endpoint through Wisp in
  both prior projects, not reimplementing a foreign wire protocol), (1) is probably the
  better fit here too - it keeps Mindustry's actual multiplayer protocol working
  unmodified against any real Mindustry server, the relay just needs to move bytes.
- Needs a Wisp relay reachable from the deployed page (self-hosted or an existing public
  one), plus whatever CORS/WSS setup that implies - a deployment concern as much as a
  code one.

### Round 13: SoLoud coverage gaps - the same "cross-check every declared native" fix
18. **First error past networking init** - `UnsatisfiedLinkError: Soloud.sourceFilter`,
    from `SoundControl.setupFilters()`. Rather than patch this one method and wait for
    the next missing one to surface individually (which is how the last several SoLoud
    gaps got found), cross-checked every `static native` declaration in Arc's
    `Soloud.java` against what `stub-natives.js` actually registers - same approach
    Round 5 used for FreeType. Found 8 gaps total: `sourceFilter` (the reported one),
    `sourceLoop`, `sourceSingleInstance`, `sourceStop`, `wavLoadFile`, `streamLoadFile`,
    `pauseDevice`, `resumeDevice`. All 65 declared methods are now registered.
    - `sourceFilter` itself is a no-op (attaches a DSP filter handle to a source),
      consistent with this file's already-documented status that filter DSP effects are
      deferred - sound will play, just without biquad/echo/lofi/etc processing.
    - `sourceLoop`/`sourceSingleInstance`/`sourceStop` got real (not just non-throwing)
      implementations: `playVoice()` now tracks which source handle produced each voice
      and honors a `singleInstance` flag (stopping any already-playing instance of the
      same source before starting a new one) and a `defaultLoop` flag (used when
      `sourcePlay(long)`'s single-arg overload is called, where JS receives `loop ===
      undefined`).
    - `wavLoadFile`/`streamLoadFile` (load-by-path, as opposed to load-by-bytes) are
      left as an explicit stub that warns and returns an invalid handle rather than
      silently no-op'ing - Mindustry's actual asset loading goes through
      `Fi.readBytes()` + `wavLoadBytes`, so this path very likely never gets hit in
      practice, but if it ever is, this makes that visible instead of a silent bug.
    - **Proactively hedged against a repeat of the GL-overload/nested-class mangling
      class of bug**, before it had a chance to surface as yet another confusing
      `UnsatisfiedLinkError`: `sourcePlay` is declared with two overloads
      (`sourcePlay(long)` and `sourcePlay(long,float,float,float,boolean)`) in the Java
      source, and real JNI requires the long-form, argument-type-suffixed mangled name
      for every overload of a method that's overloaded - the short form alone (which is
      all that was registered) likely wouldn't resolve either one the moment Mindustry
      actually tries to play a sound. Registered both
      `Java_arc_audio_Soloud_sourcePlay__J` and `..._sourcePlay__JFFFZ` alongside the
      existing short-form registration, rather than waiting for a real playback call to
      hit this and produce a third SoLoud-related crash report.
    - Verified via a Node harness (mocking just enough of `AudioContext` to load the
      file) that all 65 declared names now resolve to a registered handler, and smoke-
      tested the new source-tracking natives against a handle with no backing source
      (the common early-call case) to confirm they degrade gracefully rather than
      throwing.
    - **Not yet re-verified in an actual browser.**

### Round 14: copyJni - a real implementation, 6 overloads, and one open question
19. **User-driven finding**: real testing reached `Buffers.copyJni` after all - the
    earlier claim (Round 6-era comment in `buffers-shim.js`) that Arc's
    `Java16Buffers.copy()` would always be preferred once we report Java 17, making
    `copyJni` unreachable, was simply wrong. Looking at the actual `Buffers.java`
    source: `Buffers.copy()`'s several overloads call `copyJni()` directly and
    unconditionally - there's no Java-version branch in this class at all. That must
    have been describing a different call path this project hasn't actually exercised.
    The person had already added a non-crashing but functionally no-op debug stub
    (logs args, returns without copying) to unblock testing - good call to make it safe
    first, but it needed a real implementation since silently not-copying vertex/mesh
    data would cause quiet rendering corruption rather than a loud error.
    - **6 overloaded native signatures**, all declared directly on `Buffers` (not
      nested) - same JNI-overload-mangling situation as GL overloads and
      `Soloud.sourcePlay` before it. Computed the long-form mangled name for each from
      the exact declarations in Arc's source (not just inferred from call sites) and
      registered all 6, e.g.
      `Java_arc_util_Buffers_copyJni___3FLjava_nio_Buffer_2II` for
      `copyJni(float[], Buffer, int, int)`. Kept the short-form name too as a
      best-effort generic dispatcher (by argument count + runtime type sniffing),
      matching the shape of what was already there, in case CheerpJ resolves some call
      sites through the plain name.
    - **Real memcpy semantics implemented per-overload** from the JNI comment blocks
      (all straightforward `memcpy(dst+dstOffset, src+srcOffset, numBytes)`, with one
      wrinkle: for the 5 array-src overloads, `srcOffset` is in units of *src's own
      element type* - a short-index for `short[]`, a float-index for `float[]`, etc,
      since real C pointer arithmetic on a typed pointer scales automatically - while
      `dstOffset`/`numBytes` are always plain bytes regardless of `dst`'s type).
    - **The one genuinely unverified piece**: writing into `dst` has to go through
      scalar `put(index, value)` calls (bulk array arguments don't resolve on live
      object instances - Round 9/10), and the *unit* of `index`/`value` depends on
      `dst`'s real concrete `java.nio.Buffer` subtype (`ByteBuffer` needs byte values at
      byte indices, `FloatBuffer` needs float values at float indices, etc - Arc's own
      Java code determines this via `instanceof` in `Buffers.elementShift()`, which we
      obviously can't do on a CheerpJ object proxy from JS). Classified `dst` via
      `dst.constructor.name` instead - the exact technique the person's own debug
      logging already used - with a regex guess (`/Float/`, `/Short/`, `/Int(?!eger)/`,
      else byte) for what CheerpJ's heap-buffer-view class names actually look like.
      **This hasn't been checked against real output** - the person's debug code was
      already printing `arg?.constructor?.name` for every argument, so their actual
      console output has the real answer sitting in it already; need those exact string
      values to confirm or correct the classification regexes.
    - Verified with a Node harness: the confirmed-live 4-arg float case (exact
      offset/length math), the short-form generic dispatcher landing on the same
      result, and an `int[]`-into-byte-classified-`dst` case (checked the actual
      little-endian byte layout came out correct) - all matched expected output. Not
      verified against real CheerpJ constructor names, since that requires the actual
      browser output.
    - Added one-time instrumentation since: `classifyDst()` logs each distinct buffer
      `constructor.name` once (`[buffers-shim] buffer class seen: ...`), so the next
      real console output settles whether the classification regexes are right.

### Round 15: scalar `long` marshalling is Number, NOT BigInt (+ jar-is-ground-truth)
20. **Real browser test reached the 2nd frame of the loading screen, then died** with
    `Couldn't initialize FreeType library, FreeType error code: 0` - i.e.
    `initFreeTypeJni()` returned a value Java read as `0`. This was the first native
    in the project whose Java *return type* is `long`, and it was returning a BigInt
    handle (`1n`) - the exact "long/BigInt assumption not verified" risk flagged in
    the architecture notes since Round 3.
    - **Root cause, now settled**: CheerpJ marshals **scalar** `long` args/returns
      between JS natives and Java LiveConnect-style (**JS `Number` <-> `long**). A
      BigInt return reads back as `0`. `long[]` **arrays** are different - those map
      to `BigInt64Array` with BigInt elements (documented extension; that's why
      `pixmap-shim.js`'s `nativeData[0] = 0n` is *correct* and was left alone).
      Corroborating evidence: `sdl-shim.js` has returned plain Numbers for its
      `long`-returning natives all along, and window creation worked from Round 1.
    - **`freetype-shim.js` rewritten to Number addresses**: handle table now keyed by
      Numbers, `h()` normalizer converts any *incoming* long arg (Number or BigInt,
      whichever CheerpJ actually passes) to the stored Number key, all `0n`
      null-sentinels became `0`, and `strokeBorder`/`toBitmap` return `h(addr)` (a
      raw BigInt arg returned unchanged would read as 0 in Java). Fixed `setCharSize`
      to its real 5-arg signature with dpi scaling (generator only uses
      `setPixelSizes`, but correct is correct).
    - **`buffers-shim.js`**: `getBufferAddress` returns `long` -> its fake addresses
      are now Numbers too.
    - **Cross-checked every FreeType native against the JAR (not the repo)** with
      `javap`: the jar declares **68** natives (the "58" from Round 5 was counted
      against Arc's repo source). Computed proper JNI-mangled names for all 68 from
      the jar's descriptors and diffed against the shim's registrations: exact match,
      nothing missing, nothing extra.
21. **The jar and the Arc repo source have DRIFTED - always `javap` the jar.** The
    v158.1 jar's `Soloud` declares `wavLoad(byte[], int)` and `streamLoad(String)`,
    but `stub-natives.js` (built from repo-source names) registered
    `wavLoadBytes`/`streamLoadBytes`/`wavLoadFile`/`streamLoadFile` - none of which
    match, so the first sound load would have been an `UnsatisfiedLinkError`.
    Registered `wavLoad`/`streamLoad` under the jar's names (repo-named ones kept,
    harmless). Also normalized all Soloud long handle args (`H()`/`src()` helpers,
    same Number/BigInt robustness as freetype's `h()`) and made `wavLoadFile`'s
    invalid-handle return `0` instead of `0n`. Diffed the remaining shim files
    against the jar's declared natives too: GL/SDL/Pixmap/Buffers all match (SDL
    already returned Numbers everywhere).
22. **Dispose-path NPE log hygiene (jar patch)**: the `NullPointerException` in
    `Client.close()` seen in the same log is the predicted fallout of Rounds 11/12
    (constructor leaves `selector` null; any later fatal error triggers
    `dispose -> disconnectClient -> close -> selector.wakeup()` NPE, which prints
    *before* the real error and muddies diagnosis). Nop'd all five unguarded
    selector derefs - `Client.close` (`selector.wakeup()`), `Client.dispose`
    (`selector.close()`), `Server.close` (`selector.wakeup()` + `selector.selectNow()`),
    `Server.dispose` (`selector.close()`) - equal-length nop replacements, exception
    tables untouched.
23. **Retroactively fixed a latent verify bug from Rounds 11/12 (jar patch)**: widening
    the ctors' catch clause to `Throwable` back then left the `StackMapTable`'s
    handler frame still declaring `IOException` on the stack. CheerpJ's lenient
    verifier tolerates the mismatch (why it ran at all), but a strict JVM rejects
    the class - caught by running a `Class.forName` harness with `java -Xverify:all`
    against the patched jar, which is now a standing step for every bytecode patch.
    Fixed by rewriting the handler frame's stack verification-type CP index from
    IOException to Throwable in both ctors (2-byte, equal-length edit inside the
    attribute). After the fix: `java -Xverify:all` loads both classes cleanly.
    - Technique note: `javap -v` prints the full StackMapTable frames *and* the
      constant pool, which is all you need to build an exact byte pattern for this
      kind of patch - no classfile parser required. Assert the pattern matches
      exactly once before writing.
    - `Mindustry.jar.bak-round15` is the jar immediately before this round's patches
      (still contains Rounds 2/7/11/12); the live `Mindustry.jar` has this round's.
24. **None of this round's changes are browser-verified yet** - the long/Number fix,
    the Soloud rename, and both jar patches are all reasoned + Node/JVM-verified
    only. Next test should specifically watch for: text rendering at all (and
    whether it's right-side-up / right size), the `[buffers-shim] buffer class seen:`
    instrumentation lines (settles Round 14's `classifyDst` question), and whether
    the FreeType init error is gone.

### Round 16: the loading freeze - per-element round trips + a freeze watchdog
25. **Real browser test (Round 15's changes in)**: passed `[Mindustry] Version: 158.1`
    (FreeType init error GONE), then the page freezes. Log also showed
    `Uncaught (in promise) Error: Could not establish connection. Receiving end does
    not exist.` - that fingerprint is **browser-extension noise** (chrome.runtime
    messaging to a dead receiver), not the page; test in an incognito window to
    eliminate it.
26. **Prime suspect for the freeze: bulk data copies are O(n) awaited round trips.**
    Round 14's `copyJni` writes one `await dst.put(i, v)` per element; a font file is
    ~100-700KB, so font loading alone is 10^5+ sequential JS<->JVM round trips before
    the loading screen can advance - indistinguishable from a hang. Every mesh vertex
    update repeats smaller versions of the same cost per frame.
    - **Fix: JS-aliased buffers.** CheerpJ's documented array conversion is *by
      reference* (`Int8Array` <-> `byte[]`), and `ByteBuffer.wrap(byte[])` aliases its
      array - so a buffer created via `wrap(int8)` potentially shares memory with a JS
      typed array. `buffers-shim.js` now probes this ONCE at runtime (write sentinel
      JS-side, read it back through the Java object; logs
      `[buffers-shim] ByteBuffer.wrap JS-aliasing: WORKS/not available`), and when it
      works, registers every wrap-created buffer in a shared WeakMap
      (`window.__BUFFERS_ALIAS`). Consumers:
      - `copyJni` all overloads -> one `TypedArray.set(bytes, dstOffset)`, zero JVM
        round trips (the font-copy freeze fix).
      - `clear` -> `fill(0)`.
      - `gl-shim.js` `readBuffer`/`writeByteBuffer` -> `slice()`/`set()` for aliased
        Uint8Array reads/writes (icon/texture/glyph-atlas uploads and readbacks).
      - `freetype-shim.js` `newMemoryFace` reads font bytes with zero round trips;
        `Bitmap.getBuffer` registers glyph bitmaps for fast GL upload.
      - `pixmap-shim.js` registers its pixel buffers via the same helper.
      - If the probe says aliasing does NOT work, everything silently stays on the
        old scalar paths (correct but slow) - no behavior change, just a warning log.
      Verified in Node against both a by-reference mock (fast path engaged, bytes
      visible from both sides) and a copy-in mock (probe detects, falls back, copies
      still land correctly).
27. **Freeze watchdog added to `index.html`**: every merged native is wrapped with a
    tracer, and a 3s heartbeat logs `[watchdog] alive; N native calls; recent: ...`
    with the last 8 native names (package-stripped). Reading a frozen page's console
    now distinguishes the failure modes directly:
    - heartbeats STOP -> synchronous infinite loop; last `recent:` names the native
      it died inside.
    - heartbeats CONTINUE + same native repeating -> hot loop or glacial slowness.
    - heartbeats CONTINUE + no natives flowing -> async stall (a promise that never
      settles, or Java-side logic waiting on something).
    The wrapper also counts total native calls - useful as a rough progress meter.
28. **Watchdog's first data point**: heartbeats alive at ~2000-2200 calls per 3s
    interval (~700/sec) while frozen - NOT a synchronous loop; the JVM is steadily
    working. ~700/sec implies ~1.4ms per native dispatch, which reframes the whole
    problem: native *count* is the currency, not bytes. Font generation (traced
    through `createGlyph` bytecode: getCharIndex, loadChar, getGlyph x2, toBitmap,
    getBitmap, + getPixmap's getWidth/getRows/getBuffer/getPixelMode/getPitch, +
    Pixmap createJni ~= 12 natives/glyph) costs ~17ms/glyph => ~8-10s per font as
    ONE uninterruptible AssetManager task during which the render loop cannot
    advance - i.e. "frozen at that frame" may simply be *slow*, not stuck.
    Accordingly: watchdog upgraded from last-8-names to a per-interval **histogram**
    (top 6 natives by count, printed every heartbeat), freetype-shim got a
    `[freetype-shim] N glyphs rasterized` progress counter (every 100, on the
    toBitmap path createGlyph actually uses), face-metrics are cached per pixelSize
    (invalidated on setPixelSizes/setCharSize; was 2-3 measureText per metric
    native), and rasterize() reuses the cached per-char metrics instead of
    re-measuring. Next test should *wait 2-3 minutes* at the frozen frame and report
    whether glyph progress keeps climbing and which natives dominate the histogram.

### Round 17: the histogram verdict - copyJni at ~200ms/call
29. **Watchdog histogram (real run) nailed it**: frames DO render (VAO/viewport/
    framebuffer binds + clears + PollEvent per interval), but intervals degenerate
    into pure `Buffers_copyJni x17 / x10` - i.e. **~200ms per copyJni call**. The
    per-element scalar `put()` fallback was in full effect: the JS-alias WeakMap
    fast path wasn't engaging, either because the alias probe found wrap() copies
    (no shared memory) or because CheerpJ object proxies aren't identity-stable
    across native calls (same Java buffer arrives as a different JS proxy, WeakMap
    miss). Each copy of a ~10-50KB vertex/mesh buffer then costs thousands of
    awaited puts, and loading advances only at copy-completion speed.
    - **Fix: let Java do the copy.** `copyBytesIntoBuffer` now tries
      `System.arraycopy(srcInt8, 0, dstArr, arrayOffset + dstOffset, numBytes)` for
      any heap dst - a *static* call so typed-array arguments resolve (same
      precedent as ByteBuffer.wrap), ~3 round trips total regardless of size.
      `readBytesFromBuffer` (the Buffer->Buffer overload) got the mirror-image
      `array()` bulk read. `gl-shim.js`'s `readBuffer` gained an `array()`-based
      bulk read for heap ByteBuffers (view buffers still use the scalar loop).
      Scalar loops remain as the last-resort fallback, so a CheerpJ quirk can slow
      things but not break them.
    - All six copyJni overloads verified in Node against a copy-in (no-aliasing)
      mock: exactly one arraycopy per call, correct byte/float/short/int offset and
      little-endian layouts confirmed.
    - The alias probe result is now also printed via console.error when it FAILS,
      so it shows up in the page's red on-page log (easy to spot in reports).
30. **Not yet browser-verified.** Next test expectations: copyJni intervals should
    show hundreds+ of calls per 3s (not 10-17), the loading bar should visibly
    advance, and `[freetype-shim] N glyphs rasterized` should climb. If the probe
    says aliasing WORKS, even better (zero-round-trip copies).

### Round 18: arraycopy path dead too - capability probe + strategy chain
31. **Real run**: `System.arraycopy bulk path unavailable ... undefined` x13, then
    `Buffers_copyJni x13` in the interval - i.e. ~230ms/call still, loading still
    frozen. The rejection had no message; combined with the earlier failed alias
    probe, the coherent story is that CheerpJ's `ByteBuffer.wrap(typedArray)`
    produces a **direct** buffer - so `array()` throws, killing both the alias and
    arraycopy strategies for the very buffers we create. Exactly which strategies
    this runtime supports is now DISCOVERED AT RUNTIME instead of assumed:
    - `newDisposableByteBuffer`'s first call runs `probeCapabilities()`, which tests
      aliasing, `array()` on wrap/allocate buffers (+ whether writes are LIVE),
      `put(ByteBuffer)`, and `putInt`, then logs
      `[buffers-shim] bulk-copy capabilities: {...} -> creating buffers via X`
      (also on the red page log when nothing zero-copy works). Future buffers are
      created via `allocate()` if that yields a live array(), else wrap().
    - `copyBytesIntoBuffer` is now a strategy chain, each step verified before
      trusting it: (1) aliased JS memory -> `set()`; (2) `array()` live write +
      read-back verification (a copied array() would silently swallow the write -
      and `System.arraycopy` into a copied array is equally dead, so the old
      strategy 3 was removed as redundant); (4) relative `put(ByteBuffer)` with
      position juggling - an *instance* call but with a Java-object argument, which
      is not the known-broken typed-array case; (5) `putInt` scalar - 4 bytes per
      round trip when 4-aligned; (6) per-byte scalar, now with a loud every-20th
      `[buffers-shim] SLOW scalar copy path` error including byte count and caps.
    - All strategies verified in Node against capability-specific mocks (live
      array, dead array, put(ByteBuffer) only, putInt only, nothing).
32. **Not yet browser-verified.** The capabilities JSON line is now the single most
    valuable line in the next report - it says definitively what this CheerpJ
    build can do, and the chain should engage the best available strategy
    automatically.

### Round 19: MAIN MENU REACHED - flicker + dead clicks
33. **Real run made it through loading to the main menu.** Two presentation bugs:
    - **Dead clicks = DPR mismatch (sdl-shim.js)**: mouse events were reported in
      CSS pixels, but the canvas backing store (and the game's viewport/mouse
      coordinate space) is `devicePixelRatio`-scaled - on the Retina Mac running
      these tests every click landed in the top-left quadrant at half coordinates,
      so the UI ignored them. `canvasXY()` now scales event coords by
      `canvas.width / rect.width`.
    - **Flicker = mid-frame compositing (gl-shim.js)**: CheerpJ natives are async,
      so the event loop can yield between the GL calls of one logical frame, and
      Chrome happily composites the canvas in a half-drawn state (right after
      glClear, before the UI pass). Desktop GL's double buffering hides exactly
      this. Fix: `glBindFramebuffer(name 0)` now redirects to an offscreen FBO
      (RGBA8 + DEPTH24_STENCIL8, resized with the canvas), and
      `SDL_GL_SwapWindow` blits it onto the real default framebuffer and restores
      the redirected binding - every composite now shows the last complete frame.
      Verified with a mocked WebGL2 context: redirect, blit/restore ordering, and
      resize-recreation all check out.
    - Also made `SDL_GetWindowFlags` return SHOWN|MOUSE_FOCUS|INPUT_FOCUS instead
      of 0 ("window never focused" could gate input/focus logic).
34. **Not yet browser-verified.** Watch: stable image between frames, working
    clicks, and the watchdog's native rate as a rough fps gauge.

### Round 20: mouse coordinates - it's logical pixels all the way down
35. **Round 19's DPR scaling was wrong** (real run: "mouse appears everywhere
    except my actual position"). Disassembling the jar settled the real model:
    - `SdlConfig` defaults `hdpiMode = HdpiMode.logical` (DesktopLauncher never
      overrides it), so `SdlGraphics.getWidth()/getHeight()` return
      **logicalWidth/logicalHeight**, not the backing-store size.
    - `logicalWidth/Height` are ONLY set by `updateSize(w, h)`, whose arguments
      come from the window-event path (`lambda$loop$0` reads `inputs[2]/[3]`) or
      the initial config size - and `updateSize` separately reads
      `SDL_GL_GetDrawableSize` into `backBufferWidth/Height` and points
      `glViewport` at THAT. So real-SDL semantics: events and mouse coords in
      **logical points**, drawable size in **device pixels**, viewport on the
      backing store.
    - Our shim never sent an initial SIZE_CHANGED at window creation, so the
      game kept Mindustry's config size as its logical size while the viewport
      was full backing-store - every mouse coordinate mapped against a stale,
      differently-scaled rectangle.
    - **Fixes in sdl-shim.js**: mouse events back to plain CSS px (CSS px ==
      logical px); SIZE_CHANGED events now carry logical sizes
      (`clientWidth/clientHeight`, or the requested w/h for SDL_SetWindowSize);
      `SDL_CreateWindow` pushes an initial SIZE_CHANGED so the game's logical
      size is correct from frame one. `SDL_GL_GetDrawableSize` keeps returning
    the DPR-scaled backing size - that part was already right.

### Round 21: transparent browser file dialogs (upload/download)
36. **User request**: when the game asks for a file, trigger the browser's own
    picker/downloader. There are no native file dialogs in this jar (the old
    `FileDialogs` stubs were dead code - class absent; removed). The real seam is
    `mindustry.core.Platform.showFileChooser(boolean save, String title, String
    ext, Cons<Fi> cb)` (interface with defaults; `ClientLauncher` assigns
    `Vars.platform = this`, and `DesktopLauncher.main` constructs the instance).
    DesktopLauncher's own implementation shells out to zenity/AppleScript - dead
    in a browser.
    - **New Java classes compiled into the jar** (`javac --release 8 -cp
      Mindustry.jar`, source in /tmp/arc-src/webbridge - copy back if needed):
      `mindustry/web/WebLauncher extends DesktopLauncher` overriding
      showFileChooser/showMultiFileChooser to call `WebBridge.choose(...)` (a
      static native), run the game's callback with the returned Fi, then call
      `WebBridge.finished(save, path)`; `mindustry/web/WebBridge` declares those
      two natives.
    - **DesktopLauncher.main patched** (Round 7 CP recipe): `new #43;
      invokespecial #52` -> WebLauncher's Class/Methodref (3 appended CP entries,
      reusing the existing `<init>(String[])V` NameAndType). Equal-length operand
      swaps only. Verified: javap shows `new #1180 // class
      mindustry/web/WebLauncher`, and `java -Xverify:all` loads the whole chain
      (the StackMapTable tolerates the subtype, unlike Round 15's catch-type
      widening). `Mindustry.jar.bak-round21` is the pre-round backup.
    - **web-bridge.js** implements the natives:
      - `choose(lib, save=false, ...)`: shows `<input type=file>` (accept list
        from the extension args), writes the picked bytes into the JVM's virtual
        FS via static `Files.write(Paths.get(dir), bytes)` under a discovered
        writable exchange dir (`<user.home>/web-files`, falling back to
        `/tmp/web-files`, `/files/web-files`), and returns `Fi.get(path)` so the
        game's callback reads a real file. Cancel resolves null -> game no-ops.
      - `choose(lib, save=true, ...)`: returns a Fi for an empty writable path;
        the game's callback writes the export there; then
      - `finished(save=true, path)`: `Files.readAllBytes` -> Blob -> `<a
        download>` browser download of exactly what the game wrote.
    - The manual file-bridge buttons (Import/Download/Locate) from the previous
      iteration remain as a fallback for flows that don't go through
      showFileChooser; the boot status text now auto-hides after 15s.
37. **Not yet browser-verified.** Test via Maps -> import/export, schematic
    import/export, editor export. Watch `[web-bridge]` console lines; the
    exchange-directory log says where files land.
38. **First real test**: `choose failed TypeError: Cannot convert a Symbol value to
    a number` on both directions - the Java `String[]` extensions argument marshals
    as an opaque proxy that `Array.from()` can't iterate. New rule: **never pass
    Java object arrays across the native boundary** (primitive arrays are fine as
    typed arrays; object arrays are not JS-iterable). Recompiled WebBridge/WebLauncher
    with `choose(boolean, String title, String extensionsCsv)` - WebLauncher joins
    the extensions into a CSV itself - and updated the jar (DesktopLauncher patch
    untouched, `-Xverify:all` still clean). web-bridge.js splits the CSV.
39. **Second real test**: export opened the browser *upload* picker; import crashed.
    Bytecode explains the first: `Platform.export(name, ext, writer)`'s DEFAULT
    implementation calls `showFileChooser(FALSE, ...)` even for exports - the game
    just writes inside the callback, so the flag carries no intent on that path.
    Fix: WebLauncher now also **overrides `export()`** directly (choose(true) ->
    writer.write(fi) -> finished(true) = download), and only trusts the flag on
    direct showFileChooser calls. Callbacks are additionally wrapped in
    try/catch + `Log.err(...)` so whatever the import crash was, its stack will
    land in the game log (visible on the page red log) instead of an opaque
    propagate. `Fi.get(String)` verified un-overloaded (no resolution risk).
    Import crash cause still unidentified - next report should contain the stack.
40. **Third real test produced the smoking gun**: import-data's stack showed
    `choose(save=true, "@open", "zip")` - i.e. the flag said SAVE for an obvious
    open (SettingsMenuDialog.importData), mirroring export()'s false-for-saves.
    Conclusion: **the save boolean is unreliable in both directions across
    Mindustry's call sites; the dialog title (bundle key "@open"/"@save") carries
    the real intent.** web-bridge.js now decides open-vs-save from the title
    (regex open|import|load; else fall back to the flag), logs its decision, and
    `choose` records the decision per path so `finished` only downloads when the
    flow was really a save (no spurious downloads of imported files). Jar
    unchanged this round - JS only.
41. **Fourth real test**: import-data works, but the game then freezes with the
    watchdog showing `alive; ... no native calls` repeating - JS event loop
    healthy, JVM making ZERO native crossings. That means the game loop is stuck
    inside pure-Java code (no native in the loop). importData's tail is
    `Fi.copyTo -> ZipFi walk -> deleteDirectory -> Settings.clear/load ->
    rebuildMenu` - pure Java + CheerpJ virtual-FS calls. To pinpoint the exact
    frame, a **Stack dump** button was added to the bridge toolbar:
    `Thread.getAllStackTraces().toString()` via the running lib (static + no-arg
    instance call, both proven) printed through console.error so it also hits the
    on-page red log. If THAT hangs instead, the CheerpJ dispatcher itself is
    blocked with the main thread - a different (also informative) diagnosis.
    **Resolved without needing it**: the user reports it wasn't a freeze at all -
    the settings import just takes a very long time (pure-Java zip walk + settings
    reload in CheerpJ, no native crossings, hence the silent watchdog). Slow but
    functional. The Stack dump button stays as a diagnostic for real freezes.

## Current status as of handoff
Last real browser test: passed the version log (Round 15's FreeType crash is confirmed
fixed), then **froze** during loading - diagnosed in Round 16 as most likely the
per-element awaited round trips in `copyJni`/buffer I/O (font bytes alone are 10^5+
sequential JS<->JVM calls). Round 16 shipped the JS-aliased-buffer fast path (probe-
verified at runtime, graceful fallback) and a native-call watchdog in index.html.
Not yet browser-verified - the next Chrome run should show either progress or a
watchdog trail pinpointing the stall.

## What's next, roughly in order
1. **Run it in Chrome (hard refresh / incognito - the usual cache discipline) and
   report back.** Specifically:
   - Is the FreeType init error gone, and does the game get further into the loading
     screen?
   - Does text render at all, and does it look roughly right (right-side-up, correct
     size)? First-try bearing-math inaccuracies in `freetype-shim.js` are expected to
     be tunable once "wrong" is visible.
   - The `[buffers-shim] buffer class seen: ...` instrumentation lines - settles
     Round 14's `classifyDst` regex question (what CheerpJ names its buffer classes).
   - Any `[freetype-shim] newMemoryFace failed` error (font bytes not reaching us
     intact - would point at `copyJni` or the array-backed-buffer chain).
   - Any new `UnsatisfiedLinkError` (next missing native; audit against the *jar* via
     `javap`, per the architecture notes).
2. **GL overload resolution** - see architecture notes. Hasn't caused a visible
   problem yet but hasn't been actively checked either; worth a look once rendering is
   visible, since a silently-wrong overload wouldn't necessarily throw.
3. Any `[gl-shim] unimplemented GL call: ...` console warnings mean Mindustry called a
   GL function outside the ~150 implemented; these are usually one-line additions
   once named.
4. **Real networking** (multiplayer) remains out of scope until singleplayer works -
   see "Networking beyond don't crash on startup" above for the Wisp-relay plan.
