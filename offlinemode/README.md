# mindustry-teavm — Mindustry, offline, in the browser via TeaVM

An offline web port of Mindustry: the full game compiled from Java to
JavaScript with TeaVM, running on WebGL2 + Web Audio + IndexedDB, servable
from a plain static directory with no server-side component and no network
required to play.

This README is the complete working log of the project: architecture, every
step taken (with the reasoning behind it), current state, and what's next.

---

## 1. Repositories and how they relate

| Path | Remote | Role |
|---|---|---|
| `./` | The TeaVM backend + build system + all source-swapped replacements (this folder lives at `offlinemode/` of the khoichon/mindustry-web monorepo) |
| `./arc/` | git submodule → https://github.com/khoichon/arc, branch `teavm-backend` |
| `./mindustry/` | git submodule → https://github.com/khoichon/mindustry (pristine v8-era source, commit `f92db08`, 2026-08-27) |
| `~/code/mindustry-web/` (the monorepo root) | `https://github.com/khoichon/mindustry-web` | The CheerpJ-based online reference build. Its `shim/` (natives-gl.js, natives-freetype.js + opentype.min.js, natives-audio.js, …) is prior art for browser glue; `opentype.min.js` and the freetype conventions were reused here |
| `~/code/mindustry-web/mindustry.jar` | — | Prebuilt desktop jar (v8 build 159.7, 2026-07-19) — the **asset source** (packed sprite atlas, bundles, sounds, maps). ~5 weeks older than the source tree: new sprites referenced by newer code render as the error texture until the jar is rebuilt |

### Where changes go (the upstreaming model)

- **Mindustry source changes** → commits on
  **https://github.com/khoichon/Mindustry**. During development they live
  as wholesale copies under `backend-teavm/src/mindustry/` (plus
  `filterMindustrySources` exclusions and the
  `rewriteTeavmIncompatible` transform) so the local fork checkout stays
  clean; upstreaming means committing the equivalent change to the fork
  and then deleting the copy + exclusion here.
- **Arc changes** → commits on **https://github.com/khoichon/Arc**.
  During development they are edited in place in `./arc` (a clone of that
  fork) and later committed to a fork branch.
- **Everything else** (backend-teavm module, tools/, annotations/,
  build scripts, docs) → the **`offlinemode/` folder** of
  **https://github.com/khoichon/mindustry-web** — the offline sibling of
  its existing `onlinemode` (CheerpJ) work.
- **Final assembly may use git submodules**: the `offlinemode` repo holds
  this project's files plus submodule pointers pinning the Arc and
  Mindustry forks at the exact commits the build expects. That replaces
  all diff-file bookkeeping — the build's filtered-source composition then
  reads straight from the submodule checkouts, and the swap-copies in
  `src/mindustry/` shrink to only what hasn't been upstreamed yet.

Sibling `../teavmbackend/` is an older snapshot of this project at the
"triangle test" milestone — useful as a pristine Arc reference when diffing
in-place arc patches.

## 2. Architecture (as of now)

```
settings.gradle               -- :annotations + :backend-teavm
annotations/
  build.gradle                -- compiles Mindustry's annotation processors
  patched/…/BaseProcessor.java -- + -AmindustryRoot override
backend-teavm/
  build.gradle                -- the whole composition (see §4)
  resources/                  -- index.html, freetype-glue.js, opentype.min.js
  src/
    arc/backend/teavm/        -- Application, Graphics, GL20, GL30, Input,
                                 Files, Fi, IdbVfs, WebAssets, Console, Launcher
    arc/audio/Soloud.java     -- Web Audio drop-in for the JNI Soloud
    arc/freetype/FreeType.java-- opentype.js drop-in for the JNI FreeType
    arc/net/{Server,ArcNetException}.java -- arcnet stubs (offline)
    arc/util/{Buffers,NativeUtils,UnsafeBuffers,TeavmSimpleExecutor,TeavmFuture}.java
    mindustry/**              -- wholesale replacement copies (see §4.4)
  build/web/                  -- OUTPUT: mindustry.js + assets + manifest
tools/boot-test.mjs           -- headless-Chrome boot harness (puppeteer-core
                                 borrowed from the CheerpJ checkout)
build/shots/                  -- screenshots from boot tests
```

The final artifact is `backend-teavm/build/web/`: `index.html` +
`mindustry.js` (13.6 MB obfuscated; ~47 MB with -PdebugJs) + the extracted asset tree +
`asset-manifest.txt`. Serve it over localhost HTTP (browsers disallow
IndexedDB/fetch on `file://`), e.g. via `tools/boot-test.mjs`.

## 3. How to build and run

```
./gradlew :backend-teavm:buildWeb          # compile + TeaVM + assets + manifest
node tools/boot-test.mjs --wait 60000 --screenshot build/shots/x.png
```

Requirements (mirrored in `gradle.properties`):
- Gradle runs on JDK 17/21 (`org.gradle.java.home`); `teavm-classlib:0.15.0`
  itself requires 17+.
- `org.gradle.jvmargs` carries `--add-opens jdk.compiler/...=ALL-UNNAMED` —
  required at RUNTIME for the annotation processors (they use
  `com.sun.tools.javac` internals; Mindustry's own gradle.properties does the
  same thing).
- Arc submodule at `./arc` (branch `teavm-backend`,
  https://github.com/khoichon/arc/tree/teavm-backend). After cloning the
  monorepo: `git submodule update --init offlinemode/arc offlinemode/mindustry`.
- Mindustry submodule at `./mindustry` (the build resolves it via
  `../mindustry` automatically; override with `-PmindustrySrc=` /
  `-PmindustryRoot=` for exotic layouts).
- `mindustry.jar` resolved automatically from `../../mindustry.jar`
  (monorepo root) or `/Users/chon/code/mindustry-web/mindustry.jar`;
  override with `-PmindustryJar=`. (The jar is a ~150 MB binary and is
  deliberately NOT committed.)

## 4. The build composition (backend-teavm/build.gradle)

One Gradle module, one compilation unit — deliberately. Several arc files
(Pixmap, Shader, VertexBufferObject…) call `Buffers.*` directly, so arc and
the replacements must compile *together*, not as two source sets (a two-way
dependency no sourceSet graph can express).

### 4.1 Arc side — `filterArcCoreSources` (Sync)
Copies `arc/arc-core/src` minus the files replaced in `src/`:
- `arc/audio/Soloud.java` → Web Audio replacement
- `arc/util/Buffers.java` → pure-java.nio replacement
- `arc/util/NativeUtils.java` → no-op stub

Plus the pure-Java extension modules Mindustry's core needs:
`extensions/g3d`, `extensions/fx`, `extensions/flabel`,
`extensions/freetype` (minus its `FreeType.java`, replaced by the
opentype.js-backed copy in `src/`). `arcnet` is **not** included — no
sockets in a browser; `mindustry.net.Net` compiles against a two-class stub
(`src/arc/net/Server.java` + `ArcNetException.java`).

Other arc files are **patched in place** in the vendored checkout (see §8).

### 4.2 Mindustry side — `filterMindustrySources` (Sync) + `rewriteTeavmIncompatible`
Copies `../../mindustry/core/src` minus every file replaced in `src/`
(full list and reasons in §4.4), then `rewriteTeavmIncompatible` rewrites
three "anonymous subclass reports its superclass" idioms
(`X.isAnonymousClass() ? X.getSuperclass() : X`, one-line if, braced if)
out of the staged copy — TeaVM's `Class` has no `isAnonymousClass()`.
Most sites are simply deleted (using the raw class is fine there), but
`Block.java`'s braced site gets a *semantic* replacement — a name-based
anonymous check (`X.getName().matches(".+\\$\\d+")`) — because deleting
it broke every block's reflective `buildType` resolution (§5 item 10);
the replacement is scoped to Block.java since its text contains `\$`,
which the annotation processors reject in files they parse. A Gradle-side
regex transform was chosen over ~8 wholesale copies because the idiom is
mechanical and scattered, including in `BuildingComp` sources that flow
into *generated* entity code (where a copy can't reach).

### 4.3 The annotation processors — `:annotations` subproject
core/src does not compile without generated classes (`mindustry.gen.Player`,
`Call`, `Sounds`, `Iconc`, `Tex`, `Groups`, …) produced by Mindustry's own
annotation processors (`EntityProcess`, `RemoteProcess`, `AssetsProcess`,
`StructProcess`, `LoadRegionProcessor`, `LogicStatementProcessor`).

The subproject:
- compiles the processor sources **read-only from the reference checkout**
  (upstream's build *writes* the META-INF/services registration into the
  checkout — we must not, so `writeProcessorServices` generates it into our
  own build dir instead);
- patches exactly one file: `BaseProcessor` gains a
  `-AmindustryRoot=<path>` processor-option override for the "root
  directory" that upstream infers by climbing 7 parents from the compiler
  output directory (a heuristic that lands outside the repo for our layout);
- `stageProcessorRoot` stages a **writable** copy of exactly the subtrees
  the processors touch — `core/assets/{sounds,music}`,
  `core/assets-raw/{sprites/ui,fontgen/config.json}`,
  `core/assets/icons/icons.properties`, and
  `annotations/src/main/resources/{revisions,classids.properties}` —
  because `EntityProcess` *writes back* classids/revisions as it assigns
  entity IDs, and the reference checkout must stay pristine. (Copy, not
  Sync, deliberately: Sync would prune the processor's written state each
  build.)
- compiles patched arc-core (+ `TeavmSimpleExecutor`, `TeavmFuture`,
  `UnsafeBuffers`, which the patched arc references) and javapoet 1.12.1
  into the processor jar;
- passes `--add-exports` when compiling (javac internals) — and the daemon
  needs `--add-opens` (gradle.properties) when *running* them.

backend-teavm consumes it as `compileOnly` + `annotationProcessor` (none of
it belongs in the browser bundle) and passes
`-AmindustryRoot=…/annotations/build/mindustry-root`. Note javac warns
"options were not recognized by any processor" for `mindustryRoot` —
harmless; the value still reaches `processingEnv.getOptions()`.

Verified output: 289 generated classes (Sounds with 208 sound fields,
Iconc with 764 glyphs, Call.java ~2900 lines) — i.e. the staged root was
actually walked, not silently empty.

### 4.4 Mindustry files replaced in `src/` (each documents its own deltas in-file)

| File | Why |
|---|---|
| `core/Platform.java` | `getNet()` → offline `TeavmNetProvider`; `loadJar` throws (no URLClassLoader); Rhino bits removed |
| `ClientLauncher.java` | `Runtime.maxMemory()` log dropped (not in classlib); currently also carries TEMP boot diagnostics (§7) |
| `async/AsyncCore.java`, `async/PhysicsProcess.java` | run processes inline — no real parallelism exists under TeaVM, a thread pool would be pure overhead |
| `mod/Scripts.java` | no-op script engine (Rhino ~350 classes, optional feature) |
| `net/BeControl.java` | rewritten offline no-op — upstream pokes GitHub for BE updates, resolves its own jar via `getProtectionDomain()`, and `Runtime.exec()`s a restart script; all reference classlib APIs TeaVM lacks |
| `net/Net.java` | `ExecutorService pingExecutor` → `TeavmSimpleExecutor` |
| `net/Streamable.java` | `LinkedBlockingQueue` (absent from TeaVM) → nested wait/notify `ByteQueue` with identical contract |
| `Vars.java` | `ExecutorService mainExecutor` → `TeavmSimpleExecutor` |
| `game/Saves.java`, `mod/Mods.java`, `mod/DataImagePacker.java`, `editor/MapGenerateDialog.java`, `graphics/ParticleRenderer.java`, `editor/data/MapImagesView.java` | `Future`/`ExecutorService` retypings (`TeavmFuture`/`TeavmSimpleExecutor`); `Mods.waitForMain` CountDownLatch → inline run (blocking on the only physical thread could only deadlock) |
| `audio/SoundControl.java` | `LinkedBlockingQueue` → `ArrayDeque` (only `add`/`poll` used, single thread); `Thread.sleep(ms,ns)` → `sleep(ms)` |
| `graphics/LoadRenderer.java` | TEMP instrumented copy for the underflow bisection (§7) — delete and un-exclude when done |

### 4.5 Assets — `extractAssets` + `generateAssetManifest`
TeaVM's classpath resources materialize as *Strings* (corrupts binary
data), so Mindustry's asset tree is extracted from the prebuilt desktop jar
as plain static files. `assetDirs` covers sprites, fonts, sounds, music,
maps, bundles, shaders, cursors, cubemaps, icons, scripts, planets,
baseparts, `logicids.dat`, `version.properties`, and (added this session)
the root-level `locales`, `basepartnames`, `contributors` — all read via
`files.internal()` during boot. At boot, `WebAssets` fetches the manifest
and prefetches every non-music entry into memory (the game reads assets
synchronously; the browser has no sync HTTP). Music streams lazily via
fetch.

## 5. Session log — milestone 3: wiring the whole game in

(The project reached "triangle renders in browser" in milestone 2; this
session is everything since. Steps in order, with reasoning.)

1. **Survey.** Read the milestone-2 README, build scripts, all `src/`
   replacements, the reference repos, and the sibling snapshot. Found the
   `src/mindustry/**` and `src/arc/freetype` replacements already prepared
   but **not wired**: `filterMindustrySources` did not exist and
   `TeavmLauncher` already referenced mindustry classes, so HEAD could not
   have compiled. Decided to follow the established conventions: filtered
   source copies + in-file-documented wholesale replacements; never touch
   the reference checkout.

2. **First compile attempt** surfaced the real dependency list (exactly as
   the old README predicted, plus more):
   - missing `arc.graphics.g3d.*`, `arc.fx.*`, `arc.flabel.*` (Arc
     extension modules) → added to `filterArcCoreSources`; all pure Java,
     no natives (verified by grep for `native `/jnigen).
   - missing generated types (`Player`, `TypeIOHandler`, …) → the
   annotations processor subproject (§4.3).
   - `arc.freetype.FreeTypeFontGenerator`/`FreetypeFontLoader` → the
   freetype extension sources (minus the replaced `FreeType.java`).

3. **`:annotations` bring-up.** Failed twice for instructive reasons:
   (a) patched arc references `TeavmSimpleExecutor`/`TeavmFuture`/
   `UnsafeBuffers` which live in backend-teavm/src → include those three
   files in the annotations source set too; (b) Gradle 8.7 task-validation
   rejected `processResources` reading `writeProcessorServices`' output
   without a dependency → explicit `dependsOn`. The processors then ran and
   generated the full class set — confirmed by counting generated members
   rather than trusting "BUILD SUCCESSFUL" (an empty staged root would have
   compiled "successfully" and produced a useless `Sounds`).

4. **javac-vs-TeaVM realization.** `ExecutorService`/`Future` *resolve*
   fine at compile time (javac sees the real JDK's `java.util.concurrent`)
   — they explode at **TeaVM translation** ("Class … was not found"). So
   the retyping work was driven by TeaVM-stage errors, not compile errors;
   `LinkedBlockingQueue`/`CountDownLatch` were confirmed absent by
   inspecting the classlib jar (`unzip -l | grep T…`) before choosing
   replacements. Wholesale copies were made for the ten files with
   type-level changes; behavior-level changes (BeControl, waitForMain,
   ByteQueue) got in-file comments explaining the web-specific reasoning.

5. **TeaVM translation fixes**, each found by reading the "was not found"
   traces (TeaVM prints the full Java call path — treat those traces as
   the work list):
   - `Thread.sleep(JI)` → arc `Threads.sleep(ms,ns)` now delegates to
     `sleep(ms)`.
   - `java.text.StringCharacterIterator` → `Strings.formatByteCount`
     rewritten with a plain index.
   - `Class.getResource→URL` → `Fi.exists()` classpath branch probes
     `getResourceAsStream` instead.
   - `FileChannel.map` → `Fi.map()` returns `ByteBuffer.wrap(readBytes())`
     (heap buffer, same contents; only in-tree caller is FreeType font
     loading, which just reads bytes). The no-arg `map()` passes `null`
     mode rather than touching `MapMode.READ_ONLY` (absent field).
   - `ForkJoinPool`/`RecursiveAction`/`Future[]` in **SpriteBatch**: excised
     the entire multithreaded request-sort path — one physical JS thread
     means it could never deliver parallelism, and TeaVM has none of those
     classes. `sortRequests()` always takes the standard path now;
     `ForkJoinHolder.java` deleted; `countingSortMap` (the single-threaded
     sort the standard path uses) initially got cut by my line-surgery and
     was restored from the pristine sibling Arc — **always diff against
     `../teavmbackend/arc` after butchering a vendored file**.
   - `Class.isAnonymousClass()` (arc Json ×3, then ~8 Mindustry files) →
     arc sites patched by hand; Mindustry sites handled by the
     `rewriteTeavmIncompatible` regex transform (§4.2). The transform's
     first draft silently missed `.getClass()`-based sites — the optional
     regex group was written `(\(\)\.getClass\(\))?` instead of
     `(\.getClass\(\))?`; test regexes against the real tree before
     wiring them into the build.
   - `java.security.MessageDigest` → wrote a pure-Java SHA-256
     (`Strings.sha256(byte[])`, `Streams`/`Fi` delegate). **Verified
     against `shasum`** for the empty/`abc`/448-bit/1 MB vectors. The
     first version passed the empty-vector test and failed everything
     else: Java shift counts are **mod 32**, so `bitLen >>> 32` returned
     `bitLen` instead of 0 and corrupted the high length bytes. Cast to
     `long` before shifting. Lesson: a digest that matches one vector
     proves nothing; test the boundaries.
   - `Runtime.maxMemory()` → dropped the log line in the ClientLauncher
     copy rather than fake a number.
   - `getProtectionDomain`/`Runtime.exec` (BeControl) → offline no-op
     rewrite (§4.4).

6. **GL30 (the big unlock).** First full boot reached the RAF loop and
   failed on `glVertexAttribPointer(Buffer)` — WebGL has **no client-side
   vertex arrays, ever**. Arc's `Mesh` picks `VertexArray` (client arrays)
   only when `useVertexArray && Core.gl30 == null`; with `Core.gl30 != null`
   every mesh takes the `VertexBufferObjectWithVAO` + `IndexBufferObject`
   route — i.e. the desktop renderer path. WebGL2 carries VAOs, instanced
   draws, integer attributes and MRTs natively, so I wrote
   `TeavmGL30 extends TeavmGL20` (§ later: file details): implemented VAOs,
   instancing, `drawBuffers`/`readBuffer`, blit, multisample renderbuffer
   storage, 3D textures, buffer copies, clear-buffer family, samplers,
   queries, 64-bit `getParameter`; explicit throwing stubs for transform
   feedback / UBO introspection (no Mindustry call sites; TeaVM drops
   unreachable code so stubs are free). Gotchas hit while writing it:
   - `@JSBody` methods on a **non-JSO class must be static** (no `this`);
     prefer the typed binding overloads that TeaVM's
     `WebGL2RenderingContext` already provides (checked via `javap` on
     `teavm-jso-apis` — the jar is the ground truth for what exists).
   - `clearBufferuiv` has no `int[]` overload (only `Uint32Array`) —
     stubbed rather than converted; unused by Mindustry.
   - GL30 has ~80 *additional* methods vs GL20 beyond the obvious ones
     (`glInvalidateFramebuffer`, `glGetBufferPointerv`) — extract the full
     interface signature list programmatically and diff against the
     implementation instead of trusting a grep pattern for return types
     (my `void|int|boolean|String|long|float` pattern missed
     `java.nio.Buffer` returns).

7. **Boot debugging chain** (each fix found by a marker-instrumentation
   cycle through `tools/boot-test.mjs`; ~1 min per build, so markers were
   batched aggressively):
   - `Version.init()` read `version.properties` **before** the WebAssets
     prefetch completed → moved the whole boot sequence (Version.init,
     loadLogger, `Core.settings.setDataDirectory`) from `main()` into the
     first listener's `init()`, which runs inside the
     WebAssets/IdbVfs completion gate. This mirrors DesktopLauncher's
     ordering but shifted later in wall-time — a browser-specific
     necessity, since "the filesystem exists" is async here.
   - `launchid.dat` write failed with `FileNotFoundException: Could not
     create file`: **base `Fi.writer(boolean,String)` constructs a
     `FileOutputStream` directly**, bypassing the overridden
     `write(boolean)`. Fixed by overriding `writer(boolean,String)` in
     `TeavmFi` (same buffer-in-memory→IdbVfs-on-close pattern). Lesson:
     audit the base class for *every* stream-producing method, not just
     the obvious ones.
   - `glGetActiveAttrib/glGetActiveUniform` implemented via
     `WebGLActiveInfo` (out-params written from the returned object).
   - `glGetIntegerv/glGetFloatv` via `getParameteri/getParameterf`
     (single-value out-param convention).
   - `texImage2D(..., null pixels)` (legal GL for "allocate uninitialized
     storage") threw TeaVM's "buffer is not allocated in linear memory":
     the Buffer overload's conversion runs even for null — the null case
     must go through the `ArrayBufferView`-typed overload cast to JS null.
     Found by adding try/catch diagnostics to every Buffer-taking GL call
     (`[gl-diag] buffer=null`).
   - **GLSL precision**: fragment shaders failed with "No precision
     specified for (float)". Arc's `Shader.preprocess` emits
     `out vec4 fragColor;` **before** its `#ifdef GL_ES precision …` block
     on the GL30 path — an upstream ordering bug that desktop GL never
     sees (no precision requirement) and mobile masks (the same line
     carries `lowp` there). Fix: `glShaderSource` injects
     `precision highp float; precision highp int;` **unconditionally**,
     directly after any `#version` line (which must remain first — an
     earlier draft prepended before `#version` and broke every ES3
     shader). Re-declaring default precision is legal GLSL ES, and
     sources that later set `mediump` still get their intent.
   - After these, **all listeners initialize** and the RAF loop runs —
     ClientLauncher.setup() completes end to end (GL info logged,
     content loaders registered, asset loading starts).

8. **The BufferUnderflow, solved — and the domino chain it was hiding.**
   The discriminating markers (rebuilt into the JS after a first run on a
   stale bundle) named `[vbomark create]`: `VertexBufferObjectWithVAO.bind`'s
   buffer-creation block. Root cause: `TeavmGL30.glGenVertexArrays` wrote
   generated handles with a *relative* `IntBuffer.put`, advancing the
   buffer's position; arc's `tmpHandle.clear(); glGen*(…, tmpHandle);
   tmpHandle.get()` idiom then underflowed, because desktop GL writes
   results at the buffer's base without moving position. Fixed by switching
   every array-of-handles GL method (gen/delete VAOs, queries, samplers,
   drawBuffers, and GL20's get*-out-param writers) to absolute
   `put(position() + i, …)` / `get(position() + i)` access — desktop
   semantics, position untouched.

   That unmasked the next six failures, each found by marker-bisecting the
   newly-reached code (all diagnostics stripped afterwards; see §7's note):

   - **`Thread.yield()` in arc's `AssetManager`** (`update(int)`,
     `finishLoading`, `finishLoadingAsset`) is a coroutine suspension point
     and threw "Suspension point reached from non-threading context" from
     the RAF frame. Yielding is pointless for this single-worker design —
     removed (arc-side patch).
   - **`texImage2D` INVALID_OPERATION** — TeaVM's automatic
     java.nio.Buffer→JS bridge produces an `Int8Array`, which WebGL rejects
     for UNSIGNED_BYTE data. Fixed with `pixelView(Buffer)`: re-wrap via
     `Uint8Array/Int32Array/Float32Array/Uint16Array.fromJavaBuffer`
     (texImage2D/texSubImage2D/readPixels, GL30 3D variants). Also
     implemented `glReadPixels` for real while there.
   - **`OS.username` null** crashed TeaVM's `String.replace` (reads
     `$nativeString` off the null target) in LoadRenderer's asset-text
     scrubber on frame 2. Arc-side fix: non-null sentinels for `username`
     (`"\u0000"` — a NUL that never matches) and `userHome`.
   - **TeaVM reflection vs arc Json** — `getDeclaredFields()` only returns
     statically-reached fields, so every Json-deserialized class failed
     ("Field not found: spawns (mindustry.game.Rules)" while parsing the
     bundled maps' rules during the `Vars` asset). Fixed with a compile-time
     **`TeavmReflectionPolicy`** (TeaVM's extension SPI: `@Autoregistered` +
     `SimpleReflectionPolicy`, wired via teavm-extension-spi/annotation-
     processor deps): non-transient instance fields of `mindustry.**` +
     `arc.graphics/math` reflectable, plus `<init>` methods for `mindustry`
     and `arc.struct` (Json instantiates collections through their no-arg
     ctor). Scope notes: `arc.struct` *fields* crash the TeaVM 0.15.0
     compiler with a bare NPE (bisected), and a full arc+mindustry field
     policy exhausts the 8 GiB Gradle daemon heap — both documented in the
     policy's comments.
   - **`Vars.init()` NPE** — `new Fi(OS.prop("java.home"))` with no
     `java.home` property in the browser. Null-guarded (javaPath is only
     for spawning processes, which the web backend never does).
   - **The big one: a scheduling deadlock.** After all listeners
     initialized, `new PlanetDialog()` wedged the page forever — it calls
     `assets.finishLoadingAsset(...)` (a `while(!isLoaded) update();` spin),
     whose async loader part waited on a `TeavmSimpleExecutor` worker
     *coroutine* — and a TeaVM coroutine only runs when another thread
     suspends, which the spinning main thread never does. Diagnosed with a
     new `tools/boot-test.mjs --profile N [--profile-delay MS]` mode (CDP
     CPU sampling; the t=0 profile showed healthy inflate work, the delayed
     one couldn't even attach — renderer wedged). Fix: `TeavmSimpleExecutor`
     now runs tasks **inline on the submitting thread**; the browser has
     one JS thread, so "async" loaders were always main-thread work anyway,
     and every submit-then-poll pattern (AssetLoadingTask's future dance)
     completes inside the caller's own loop.

9. **The game boots to the main menu.** `Total time to load: ~8.5s`,
   `boot-test.mjs --expect 'Total time to load'` exits 0, and the
   screenshot shows the full menu: logo, version string, icon buttons,
   campaign-map background.

10. **Every block was silently building as the base `mindustry.gen.Building`
    class (task #4, root cause).** Two symptoms shared one bug: map
    preview generation failed twice per boot (`Error reading region
    "preview_map"` → EOF/IndexOutOfBounds on fortress.msav/archipelago.msav)
    and campaign sector launch died with `Error reading region "map"` +
    `DataFormatException: -3`. Chain of evidence, each step verified:
    - A desktop-JVM harness running `MapIO.generatePreview` over the same
      compiled classes parsed both maps fine → TeaVM-runtime divergence,
      not data.
    - A probe proved TeaVM's inflate + DataInputStream are byte-exact on
      the failing files (sha256 + region lengths match CPython).
    - A traced wholesale copy of `ShortChunkSaveVersion` (rolling-hash
      checkpoints every 4096 tiles, per-building-chunk logging, a counting
      `DataInput` decorator) diffed against the same trace from the
      harness localized the desync to `tile.build.readAll` under-reading
      building chunks (`duo` consumed 13 of 22 bytes).
    - Op-level logging showed both runtimes read identical bytes until
      `read()` returned without consuming anything — the behavior of the
      EMPTY generated `Building.read`. A class probe confirmed it: in the
      browser, `block.buildType.get().getClass()` was `mindustry.gen.Building`
      for every content block (walls only *appeared* healthy because
      `WallBuild.read` is empty too, so the wrong class consumed the same
      zero bytes).
    - Why: `Block.initBuilding()` resolves `buildType` reflectively —
      `getDeclaredClasses()`/`getDeclaredConstructor` over the class chain,
      inside `try{...}catch(Throwable ignored){}`. Upstream first hops
      anonymous subclasses off with `isAnonymousClass()`; our
      `rewriteTeavmIncompatible` had been DELETING that hop (TeaVM's Class
      lacks the method), leaving `current` = the anonymous `Blocks$N`
      class — on which TeaVM's reflective walk dies silently, so every
      block fell back to `buildType = Building::create`. Blocks with
      non-empty `read()` bodies (turrets, drills, conveyors…) then
      under-consumed their building chunks, desyncing the save stream.
    - **Fix** (in `rewriteTeavmIncompatible`, build.gradle): the rewrite
      now replaces that hop with a name-based anonymous-class check —
      `if(current.getName().matches(".+\\$\\d+")) current = current.getSuperclass();`
      — semantically identical on JVM and TeaVM (anonymous classes are
      `Outer$<digits>` everywhere). Scoped to `Block.java` only: the
      rewrite's replacement text contains `\$`, which the annotation
      processors choke on when it lands in files they parse (comp
      sources, JsonIO).
    - Verified: zero preview failures at boot (was 2), the map list shows
      real previews for Archipelago and Fortress, and **Archipelago — a
      previously-broken map — loads into a fully playable world** (core,
      drills, conveyors, vaults, power nodes, turrets, HUD; screenshot
      `build/shots/preview-fix-world.png`), with no SaveException/
      DataFormat errors. All TEMP tracing was stripped; the traced copy
      and its exclusion deleted.
    - Gotcha recorded for future staged-source edits: when this task's
      in-place edits land while compileJava considers inputs unchanged,
      Gradle skips the recompile — force with `:compileJava
      --rerun-tasks` when iterating on staged instrumentation.

11. **Save/load file dialogs are the browser's own (task #5).** The game's
    import/export flows (saves, schematics, maps, mods, data export) all
    funnel through `FileChooserParams` → `platform.showFileChooser`, which
    this build had routed to arc's in-game fallback chooser — a VFS
    directory browser parked at `/external/` with nothing in it (the
    user-visible "../external, empty" bug; imports impossible, exports
    trapped in IndexedDB). Replaced with `TeavmFileChooser`
    (`src/arc/backend/teavm/TeavmFileChooser.java`):
    - **open/import**: clicks a hidden `<input type=file
      id="ms-file-input">` (accept built from the requested extensions,
      `multiple` when the flow wants multi-select) — the browser's native
      picker. Picked files are read as ArrayBuffers, staged into IdbVfs
      under `picked/`, and the game's handler receives ordinary local Fi
      handles, so nothing downstream changes.
    - **save/export**: the handler receives a `DownloadFi` under
      `downloads/` — a TeavmFi subclass whose `writeBytes`/`write`/
      `writer` persist to IdbVfs like any Fi *and* push the final bytes
      to the user as a Blob + `<a download>` click (the browser's "save
      file" experience). All three write entry points are overridden
      because different flows use different ones (exportFile streams,
      writeString uses a Writer, copyTo writes bytes).
    - Default export names keep the requested extension, mirroring the
      fallback chooser's naming rule.
    - Verified end-to-end headlessly with `tools/fileio-test.mjs` (exit
      0): boot → Play → Load Game → Import Save (the game's hidden input
      driven via puppeteer `uploadFile`, which fires real change events —
      the headless stand-in for the OS picker) → the save slot appears →
      its export icon produces a CDP-captured download whose sha256 is
      byte-identical to the picked file.

12. **Zip import crashed, and data import could lose everything on a fast
    reload (task #6).** User report #1: re-importing an exported data zip
    failed with `ArcRuntimeException ← FileNotFoundException`. Root cause:
    arc's `ZipFi` opens archives with `java.util.zip.ZipFile`, which needs
    random-access file IO TeaVM's virtual `java.io` cannot provide (our
    files are bytes in IdbVfs). Patched `ZipFi` in place in the arc
    checkout (arc-patch convention): the constructor parses the archive
    eagerly with `ZipInputStream` over `readBytes()` into a name→bytes map
    shared by every tree node; `read()`/`length()`/`isDirectory()` serve
    from it. Covers data import AND mod zips.
    User report #2: after the (now working) import exited the game, a page
    reload showed ALL data reset. Verified with the user's own export via a
    TEMP boot-probe replicating importData's file operations: the zip
    parses, 78 entries copy under `mindustry/`, everything persists and
    **survives a reload** — the file layer is sound. The remaining loss
    window was IdbVfs's fire-and-forget persistence: importData deletes the
    old saves BEFORE copying, and a page reload racing uncommitted
    IndexedDB transactions aborts them — old data deleted, new data
    unwritten = total reset. **Fix:** `IdbVfs` now counts pending
    persistence transactions (`setOnComplete`/`setOnError`/`setOnAbort`),
    and `TeavmApplication.exit()` keeps the app alive (still rendering) up
    to 2s until the queue drains before tearing down. Not reproducible
    headlessly end-to-end (the Settings dialog intermittently renders
    empty under SwiftShader, breaking click navigation), so the full
    import→exit→reload path is marked manual-verify; the single-save
    import/export round-trip remains an automated green test.
    TEMP probe stripped; `zz-test.zip` staging removed from build/web
    (never entered the manifest or the standalone build).

13. **LoadRenderer crashed every frame on real GPUs, freezing boot at the
    loading screen (user report #4).** Loading a page with imported data
    produced per-frame spam `RuntimeException: (JavaScript) TypeError:
    Cannot read properties of null (reading '$mesh9')` — `$mesh9` is
    TeaVM's mangled name of `LoadRenderer.mesh` (the boot loading
    animation). draw() died inside a corrupted coroutine receiver each
    frame; the per-frame catch then aborted the frame body, so
    `assets.update()` never advanced and the boot stalled forever.
    Reproduced only in real browsers (SwiftShader headless never hit it).
    Fix: our `ClientLauncher` replacement no longer creates the
    `LoadRenderer` at all (with a null-guarded dispose) — the boot loading
    animation is gone (a few seconds of black screen instead), everything
    else unchanged. Boot verified clean (~7.6s, zero errors).

14. **`Currency not found: CYP` spam froze boot with imported settings
    (user report #5).** TeaVM's `Currency.getInstance(Locale)` takes a
    garbage path for a LANGUAGE-ONLY default locale (empty country) and
    throws from every locale-derived formatter — surfacing per frame as
    `assets.update failed: IllegalArgumentException: Currency not found:
    CYP`, which stalls the asset loop exactly like the LoadRenderer crash
    in item 13. Triggered by a saved `locale` setting without a country
    (typical in imported desktop settings.bin; the navigator-derived
    `en_US` default never hits it). Diagnosed by accident: the first fix
    attempt (stripping the country from the default locale) reproduced the
    crash deterministically headlessly, proving empty-country is the
    poison. Fix (Vars.java replacement): if the chosen locale has no
    country, the JAVA default locale gets "US" appended — the bundle
    lookup still uses the full locale. Verified: clean boot, and the full
    import-their-data → exit → reload cycle boots with 70 saves and zero
    Currency errors.

15. **The folder build now shows a boot progress bar (follow-up to item
    13).** With LoadRenderer gone, the asset prefetch was pure black
    screen — the slowest phase of a real-network boot (693 files / ~95 MB
    before the game starts) was also the least communicated one.
    `index.html` carries a DOM overlay (thin bar + label, no canvas/GL —
    nothing that can crash the way LoadRenderer did); `WebAssets.prefetch`
    reports each completed file through a guarded `@JSBody` callback
    (failures count too, or the bar stalls one file short), and
    `TeavmApplication` hides the overlay on the first successfully
    rendered frame, so the gap between prefetch-done and first frame shows
    "Starting game..." rather than black. All callbacks no-op where the
    overlay is absent (the standalone build embeds its assets and never
    prefetches). Verified on a throttled connection (3 MB/s): bar visible
    with live counts at t+4s, removed at first frame; on localhost the
    label sweeps continuously 0→693 in ~2.2s and the whole boot stays
    ~7.5s with zero page errors. Follow-up: the prefetch chain was
    originally one-file-at-a-time, which on a real host costs one full
    round-trip per file — measured ~2 files/s against GitHub Pages
    (~6 min for the whole manifest, bar crawling) — so it now runs as an
    8-worker pool (TeaVM is single-threaded; the cursor/counters need no
    locks); with 300 ms injected RTT, 693 files complete in ~38 s
    (~5.5x), and the completion bookkeeping still closes the gate
    exactly once. Second follow-up: even at full parallelism the first
    visit still pays ~60MB, and GitHub Pages sends max-age=600 — so
    every visit past ten minutes re-downloaded everything. Assets are
    now cached in IndexedDB by the page itself (deliberately NOT a
    service worker): the manifest — now "path\tsize" lines, fetched
    fresh every boot — is hashed into a cache version, so any asset
    change invalidates the whole cache, and repeat visits resolve every
    entry from the cache before hitting the network. The prefetch pool
    also grew to 24 workers (Chrome allows ~100 concurrent HTTP/2
    streams per host). Measured locally: warm boot 1.1 s with 5 network
    requests (vs 698 cold); on GitHub Pages the full first boot dropped
    from a projected ~6 min (serial) to ~25 s (pool) — cache cuts the
    repeat visit to little more than script + game init.

## 6. Verification status

- `:backend-teavm:buildWeb` — **green** end to end (javac + annotation
  processing + TeaVM translation + asset extraction + manifest), ~1m50s.
- Headless Chrome boot: manifest fetched (692 entries), all prefetched,
  IndexedDB VFS opens, Web Audio initializes, all listeners initialize,
  **asset loading completes (`Total time to load: ~8.5s`)** and the **main
  menu renders** — logo, icon buttons, campaign-map background
  (`build/shots/after-strip.png`; verified visually). `boot-test.mjs
  --expect 'Total time to load'` exits 0.
- Known runtime issues: favicon 404 (trivial), DSP filters unimplemented
  (logged). Map preview generation is **fixed** (§5 item 10).
- Exercised and working: menu input (clicks navigate Play → Custom Game →
  map card → launch dialog → play), full world load on built-in maps
  including previously-broken Archipelago (`build/shots/preview-fix-world.png`),
  all map previews render.
- **File import/export is browser-native and round-trips byte-exact**
  (`tools/fileio-test.mjs`, exit 0): Import Save opens the browser's file
  picker (headless test drives the game's hidden `#ms-file-input` via
  puppeteer `uploadFile`), the picked `.msav` is staged into IdbVfs under
  `picked/` and imported as a save slot; the slot's export icon then
  delivers a real browser download (CDP-captured) whose sha256 matches the
  picked file exactly. Zip-archive imports (data import, mod zips) work
  through the patched in-memory `ZipFi`, and `exit()` drains pending
  IndexedDB writes before stopping (§5 item 12). See §5 item 11.
- Not yet exercised: campaign sector launch in a live browser (the
  §5-item-10 fix is expected to clear its `Error reading region "map"`),
  the full data-import → exit → reload UI path (file layer verified with a
  real export; the Settings dialog intermittently renders empty under
  headless SwiftShader, blocking click automation — manual-verify),
  in-game save slots via the pause menu, audio playback end-to-end,
  standalone-file IndexedDB persistence on file:// origins.

## 7. Diagnostics (stripped; permanent pieces kept)

All bisection instrumentation from the underflow/hang hunts has been
removed: `[meshmark]`, `[vbomark]`, `[sbmark]`, `[gl-diag]`,
`[buffers-diag]`, `[module …]`, the vars-init/ui-init step markers, the
`LoadRenderer`/`UI.java` instrumented wholesale copies (deleted; exclusions
dropped from build.gradle), and `Buffers.selfTest()`.

Kept deliberately, as permanent backend behavior:

- `TeavmApplication.bootLog`/`bootError` (JSBody console bridges) — cheap,
  and the only output that works before/around arc's logger swaps; the
  start() gate and listener-init sequence still logs a handful of lines
  (set to fire only at boot, not per frame).
- Per-phase try/catch in `TeavmApplication.frame()` (`bootErrorOnce`,
  rate-limited) — TeaVM swallows exceptions out of native-callback frames
  silently; these make any future per-frame failure visible.
- `ClientLauncher`'s try/catch around `loader.draw()` / the success path
  of `assets.update()`, printing via `arc.util.Log.err` — same rationale.
- `tools/boot-test.mjs --profile N [--profile-delay MS]` — CDP CPU
  sampling mode, added to diagnose the wedged-renderer deadlock; works on
  busy pages at t=0 (attach fails on an already-wedged renderer).

## 8. Caveats & debts

- **Arc patches are committed** on the fork branch **`teavm-backend`**
  (https://github.com/khoichon/arc/tree/teavm-backend): AssetManager
  (Thread.yield removal), Music (web stream path), Fi (instance()
  delegation, sha256/map/getResourceAsStream TeaVM forms), ZipFi
  (in-memory ZipInputStream parse), SpriteBatch (MT sort excised,
  ForkJoinHolder deleted), OS (sentinels), Strings (pure-Java SHA-256),
  Threads (sleep shim), Streams (sha256 delegation), Json (name-based
  anonymous check). The stale root `*.diff` files are retired and
  deleted; a submodule pin can replace the branch reference at final
  assembly.
- `TeavmReflectionPolicy` scope is a maintenance surface: if arc Json ever
  hits "Field not found: X (Y)" or "Error constructing instance of class:
  Y" at runtime, add Y's package to the policy (its class comment explains
  the arc.struct/heap constraints).
- `rewriteTeavmIncompatible` and the arc patches mean the staged source
  differs from upstream in ways that only surface as TeaVM/runtime
  behavior — the transform's regex list should grow if new idioms appear
  (they fail loudly at translation time, which is the desired failure
  mode). Note the `Block.java` hop replacement is semantic, not a
  deletion, and deliberately scoped: its replacement text contains `\$`,
  which breaks the annotation processors if it lands in files they parse
  (§5 item 10).
- Asset jar is 5 weeks older than the source (new sprites → error
  texture) — rebuild the jar or run `:tools:pack` to refresh.
- `TeavmSimpleExecutor` runs everything inline (see its SCHEDULING NOTE);
  code that genuinely needs cross-thread overlap (none found yet) would
  need revisiting.
- `IdbVfs` doesn't track mtimes (`Fi.lastModified()` returns 0) — save
  sorting by recency won't work until added.
- JS is minified by default (13.6 MB raw / ~2.6 MB gzipped); `-PdebugJs`
  builds the readable ~47 MB variant with source maps for debugging.

## 9. Suggested next steps, in order

1. **Exercise the menu**: input events (TeavmInput keyboard mapping is
   implemented but untested), start a campaign sector in a live browser —
   the buildType fix (§5 item 10) is expected to clear the campaign
   `Error reading region "map"` failure, but it needs a live
   confirmation.
2. Verify audio (music/sfx through the Soloud Web Audio replacement;
   autoplay resume-on-first-gesture is wired but unverified).
3. Rebuild `mindustry.jar` assets or wire `:tools:pack` output.
4. **Upstream per §1's model**: commit the Arc patches to a branch of
   khoichon/Arc (retiring the stale root diffs); upstream the
   `src/mindustry/` swap-copies into khoichon/Mindustry commits where the
   change belongs in the source tree proper; move this repo's backend
   into the `offlinemode/` folder of khoichon/mindustry-web.
5. **Assemble with git submodules** (allowed for the final commits): the
   `offlinemode` repo carries submodule pointers to the two forks at the
   pinned commits the build expects, wired so `filterArcCoreSources` /
   `filterMindustrySources` read from the submodule checkouts. From then
   on the diff files and remaining swap-copies exist only for
   not-yet-upstreamed deltas.
6. Serve with compression (any static host does gzip/brotli; the JS is
   ~2.6 MB gzipped) and long-lived asset cache headers for a deployable
   build. `tools/serve.mjs` is the local no-store dev server.
