# Mindustry in the browser (CheerpJ + custom SDL/GL/audio/font shims)

## What this is
Runs the **unmodified** `Mindustry.jar` (v158.1, straight from GitHub releases) inside
a WebAssembly JVM (CheerpJ), with hand-written JavaScript replacements for the native
libraries Arc (Mindustry's framework) normally loads as `.so`/`.dll` files:

| Native lib (desktop)      | Shim file          | Status                                   |
|----------------------------|--------------------|-------------------------------------------|
| SDL (window/input/events)  | `sdl-shim.js`       | Implemented                              |
| SDL_GL (OpenGL ES 3)       | `gl-shim.js`        | Implemented, some overload risk (see below) |
| SoLoud (audio)              | `stub-natives.js`   | Implemented via Web Audio (no DSP filters yet) |
| FreeType (fonts)            | `stub-natives.js`   | **Stubbed only** - no text will render yet |

No Box2D shim needed - Mindustry doesn't use it.

## Running it
CheerpJ needs to load the jar over HTTP(S), so `file://` won't work. From this folder:

```
python3 -m http.server 8080
```

Then open **http://localhost:8080/** in a recent **Chrome** (WebGL2 + WebAssembly required;
Chrome has the best CheerpJ compatibility right now). Open DevTools console before loading -
that's where every error will show up, and there's also an on-page error log at the bottom
of the window for anything that reaches `console.error`/an uncaught exception.

First load will be slow (CheerpJ fetches a JVM runtime + the 81MB jar).

## Progress log
1. ~~"Java 25 is required" error~~ - fixed. `DesktopLauncher.checkJavaVersion()` actually
   just checks `arc.util.OS.javaVersionNumber >= 17` (disassembled with `javap` to confirm) -
   the "25" in the message is just alarmist wording. Set `cheerpjInit({version: 17})`.
2. ~~`Couldn't load shared library 'libarc.so'`~~ - fixed, see below.

### About the native-library-loading fix
The crash came from Arc's `SharedLibraryLoader` trying to extract and `System.load()` a
real x86 `.so` file - something that can never work in a WebAssembly JVM, no OS to
`dlopen()` into.

**First attempt (didn't work):** called Arc's own `SharedLibraryLoader.setLoaded(name)`
escape hatch via CheerpJ's library mode (`cheerpjRunLibrary`) before starting the game with
`cheerpjRunMain`, hoping that "loaded" flag would carry over into the actual run. It didn't -
the exact same crash came back, meaning `cheerpjRunLibrary` and `cheerpjRunMain`/`cheerpjRunJar`
apparently don't share the same static class state after all (or at least not reliably).

**What actually worked:** patched `arc/util/SharedLibraryLoader.class` directly, inside
`Mindustry.jar` itself, so `load(String)` is unconditionally a no-op (single `return`
instruction, `0xB1`). This required:
- `jawa` (pure-Python JVM classfile library, `pip install jawa`) to read/write the classfile
- A from-scratch `StackMapTableAttribute.pack()` implementation, monkey-patched in - jawa can
  *read* stack maps but its own `pack()` is a bare `raise NotImplementedError()`, so any class
  containing one (nearly all Java 7+ bytecode) can't be saved without this
- Clearing the patched method's now-stale exception table / line-number table / local-variable
  table / stack-map-table, since they referenced byte offsets from the original ~124-byte
  method body that no longer exist once it's a single instruction
- **Verification against a real JDK 21 (`java -Xverify:all`)**, not just CheerpJ, to confirm
  the patched class actually passes strict bytecode verification and behaves as a no-op
  before ever loading it in a browser
- Injecting the patched `.class` back into `Mindustry.jar` with `zip` (same relative path,
  so it replaces rather than duplicates the entry) and byte-diffing the result to confirm

This patch is already baked into the `Mindustry.jar` in this folder - `index.html` now just
calls `cheerpjRunJar` directly, no JS-side workaround needed.

## What's likely to come up next, in rough order
1. **GL overload resolution.** SDLGL.java has ~15 overloaded native methods (e.g.
   `glDrawElements` has both an `int offset` and a `Buffer` version). CheerpJ, like real
   JNI, may require the *mangled* long name to disambiguate these instead of the short
   name I registered. If rendering is garbled/missing or the console shows an "unresolved
   native" error for one of these, see the **OVERLOAD NOTES** comment block at the bottom
   of `gl-shim.js` - it has the exact mangled names precomputed and ready to add.
2. **No text rendering.** FreeType is fully stubbed right now (see the TODO block in
   `stub-natives.js`) - the game will very likely get stuck as soon as it needs to
   render its first piece of UI text. This is the next real chunk of work.
3. Anything else that shows up as `[gl-shim] unimplemented GL call: ...` in the console -
   means Mindustry called something outside the ~150 GL functions I implemented; tell me
   the name and I'll add it.
4. If another class hits the same "can't System.load a real .so" problem via a different
   code path (a fresh `UnsatisfiedLinkError` or native-extraction crash naming a different
   class), it's the same family of issue - the same bytecode-patch technique applies.
5. More native classes we haven't hit yet may show up as fresh `UnsatisfiedLinkError`s the
   same way `arc.util.Buffers` did (round 4, below) - each is usually a small, contained
   addition once we know the exact method signatures from Arc's source.

## Round 4: Pixmap (image decoding) + Buffers (mesh/VBO allocation)
Got past window/GL/icon init and into real game asset loading - `initIcon()`'s failure
turned out to be non-fatal (Arc logs and moves on), and execution reached
`ClientLauncher.setup()` building the planet-select 3D mesh. Two things came up:

**Pixmap type-conversion bug.** The `loadJni` implementation in `pixmap-shim.js` (added
last round to decode PNGs via the browser instead of stb_image) hit `CheerpJ: Invalid type
conversion attempted`, which cascaded into an `ArrayIndexOutOfBoundsException` back in
`Pixmap.load()`. Root cause: constructing the return `ByteBuffer` via
`ByteBuffer.allocateDirect(n)` followed by an instance-method call `buf.put(typedArray)` -
passing a JS typed array as an argument to an *instance* method apparently isn't converted
the same way CheerpJ converts array arguments to a *static* factory call. Switched to
`ByteBuffer.wrap(byteArray)` - a single static call - which fixed it, and has a nice side
effect: `wrap()` produces an array-backed buffer, which is exactly what `gl-shim.js`'s
`readBuffer()` needs later when this pixel data gets uploaded as a texture (a real
`allocateDirect()` buffer would *not* have been array-backed, and would have silently
failed that later read).

**New native class: `arc.util.Buffers`.** Needed for `Mesh`/`VertexBufferObjectWithVAO`
allocation (`newDisposableByteBuffer`, `getBufferAddress`, `freeMemory`, `clear`) - see
`buffers-shim.js`. Same array-backed-buffer strategy as the Pixmap fix, for the same
reason. Deliberately did **not** implement `Buffers.copyJni`'s several overloads - Arc's
own code (`Pixmap.copyMem()` and friends) prefers `Java16Buffers.copy()` (a plain
`dst.put(src, ...)` call, zero native code) whenever `OS.javaVersionNumber >= 16`, which is
always true for us since we report Java 17 - so that JNI path should never actually be
reached. If a `copyJni` `UnsatisfiedLinkError` shows up anyway, that assumption was wrong
and those need implementing too.

## How to iterate
Paste back whatever shows up in the DevTools console (or the on-page red log) and I'll
patch the relevant shim directly - I can't run a browser myself, so you're the only one
who can actually see these errors, but each one should be a quick, surgical fix once we
know what it is.

> **Update (Round 15)**: this README's per-fix entries stop at the early rounds;
> `HANDOFF.md` is the up-to-date consolidated log. Latest state: browser test reached
> the loading screen's 2nd frame, then hit the FreeType-init crash - root-caused to
> CheerpJ marshalling scalar `long` as JS Number (BigInt returns read as 0), plus a
> jar-vs-repo native-name drift (`Soloud.wavLoad`) that would have been the next
> crash. Both fixed, plus dispose-path NPEs nop'd out of the jar and a stale
> StackMapTable from the earlier net patches repaired (`java -Xverify:all` now clean).
> Not yet re-tested in a browser.
