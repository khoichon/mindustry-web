# CLAUDE.md — working guide for this repo

Offline web port of Mindustry: full game compiled Java→JS with TeaVM,
running on WebGL2 + Web Audio + IndexedDB, servable as static files.
The README.md is the complete step-by-step project log with reasoning —
read it before making major changes.

## Commands

```bash
./gradlew :backend-teavm:buildWeb        # full build: javac + annotation
                                         # processing + TeaVM (minified JS)
                                         # + assets; add -PdebugJs for the
                                         # readable/unminified build
node tools/boot-test.mjs --wait 60000 \
  --screenshot build/shots/x.png         # headless-Chrome boot test; prints
                                         # every console line, exits 1 if
                                         # --expect SUBSTRING never appears
node tools/fileio-test.mjs \
  --export 838,333                       # end-to-end file IO: import a save
                                         # via the native picker input, then
                                         # export it as a browser download;
                                         # exits 1 unless the downloaded
                                         # bytes match the picked file
```

Fast iteration loop: edit → `buildWeb` (~1 min) → `boot-test.mjs`. TeaVM
translation errors ("Class/Method X was not found" + full Java call path)
are the work list — fix each site, rebuild, repeat.

## Repositories, their rules, and where changes go

| Local checkout | Remote | Role |
|---|---|---|
| `./arc/` | `https://github.com/khoichon/arc` | Arc engine fork, patched in place (all patches currently UNCOMMITTED working-tree changes, incl. TEMP diagnostics) |
| `../mindustry/` (= `../../mindustry` relative to `backend-teavm/`) | `https://github.com/khoichon/mindustry` | Mindustry fork, kept clean locally; Mindustry-side changes live in this repo until upstreamed |
| `~/code/mindustry-web/` | `https://github.com/khoichon/mindustry-web` | CheerpJ reference (`shim/` = prior art; `mindustry.jar` = asset source). Locally not a git clone |
| `../teavmbackend/` | — | Snapshot of this project at an earlier milestone; pristine-Arc reference for diffing |

**Durable destinations (the upstreaming model):**

- Mindustry source changes → commits on **https://github.com/khoichon/Mindustry**
- Arc changes → commits on **https://github.com/khoichon/Arc**
- Everything else (backend-teavm, tools, annotations subproject, build
  scripts, docs) → the **`offlinemode/` folder** of
  **https://github.com/khoichon/mindustry-web**
- Final assembly may use **git submodules** to link it all up: the
  `offlinemode` repo holds this project's files plus submodule pointers
  pinning the two forks at the exact commits the build expects — which
  replaces diff-file bookkeeping entirely.

Working method (now) vs destination (final): develop Mindustry-side changes
as wholesale copies under `backend-teavm/src/mindustry/` (keeps the local
fork checkout clean for diffing), then upstream them into the fork and drop
the copies + exclusions; develop Arc changes directly in `./arc`, then
commit them to the fork on a branch.

## How the build composes sources (backend-teavm/build.gradle)

One Gradle module, ONE compilation unit (arc and replacements call each
other in both directions; separate sourceSets cannot express that):

- `filterArcCoreSources` — staged copy of `arc/arc-core/src` + extensions
  `g3d`, `fx`, `flabel`, `freetype`, minus files replaced in
  `backend-teavm/src/` (Soloud, Buffers, NativeUtils, FreeType).
- `filterMindustrySources` — staged copy of `../../mindustry/core/src`
  minus files replaced in `backend-teavm/src/mindustry/` (see the exclude
  list for the full inventory and per-file reasons).
- `rewriteTeavmIncompatible` — regexes `isAnonymousClass()` idioms out of
  the staged Mindustry copy (TeaVM's Class lacks the method; ~8 files,
  including comp sources that flow into generated entity code).
- `:annotations` — compiles Mindustry's annotation processors read-only
  from the reference checkout (one patched file: `BaseProcessor` +
  `-AmindustryRoot` option). `stageProcessorRoot` stages a WRITABLE copy
  of the subtrees the processors read/write (`assets/`, `revisions/`,
  `classids.properties`) — processors write entity-ID state back, and the
  reference must stay pristine. Generated output:
  `backend-teavm/build/generated/sources/annotationProcessor/…` (~289
  classes: `mindustry.gen.*`, Call, Sounds, Iconc, Tex…).

## Conventions

- **Mindustry-side change (working state)** = wholesale copy into
  `backend-teavm/src/mindustry/...` with a header comment documenting the
  deltas vs upstream + an exclude line in `filterMindustrySources`.
  Mechanical-pattern changes prefer a Gradle-side transform. **Durable
  home: a commit on khoichon/Mindustry** — once upstreamed, the copy and
  its exclusion are deleted and the build picks the change up from the
  (submodule-pinned) fork checkout.
- **Arc-side change (working state)** = edit `./arc/` in place (it is a
  clone of khoichon/Arc). **Durable home: a commit on khoichon/Arc.**
  ⚠️ All current patches are uncommitted; the root-level `*.diff` files are
  STALE (they predate this milestone's arc patches: Threads,
  Strings/SHA-256, Fi, Json, SpriteBatch) — committing the patches to the
  fork branch supersedes and retires the diff files.
- **Everything else** (this repo's backend-teavm module, tools/,
  annotations/, build scripts, docs) → the `offlinemode/` folder of
  khoichon/mindustry-web, assembled with git submodules per the model
  above.
- Assets come from the prebuilt desktop jar (5 weeks older than source —
  new sprites show as error texture). TeaVM classpath resources corrupt
  binaries (Strings), hence the extract + manifest + `WebAssets` prefetch
  pipeline; games reads assets synchronously, so everything non-music is
  prefetched into memory at boot.

## Environment requirements (gradle.properties)

- JDK 17/21 for Gradle (`org.gradle.java.home`); TeaVM classlib needs 17+.
- `org.gradle.jvmargs` carries `--add-opens jdk.compiler/...` — REQUIRED at
  runtime for the annotation processors (javac internals). Symptom if
  missing: processors die with InaccessibleObjectException.
- Arc at `./arc`, Mindustry reference at `../../mindustry` (override:
  `-PmindustrySrc=`, `-PmindustryRoot=`, `-PmindustryJar=`).

## Known TeaVM facts (verified against the 0.15.0 classlib jar)

- Absent: `ExecutorService`, `Future`, `ThreadPoolExecutor`, `Executors`,
  `LinkedBlockingQueue`, `CountDownLatch`, `MessageDigest`,
  `Class.isAnonymousClass`, `Runtime.maxMemory`, `getProtectionDomain`,
  `Runtime.exec`, `FileChannel.map`, `Thread.sleep(long,int)`,
  `Class.getResource→URL`.
- Present (useful): atomics, `ConcurrentHashMap`, `ArrayDeque`,
  `Integer.rotateRight`, `Thread`/`wait`/`notify` (coroutines), direct
  ByteBuffers in "linear memory" (acceptable to GL interop), JSO bindings
  for WebGL2 incl. VAOs/instancing/MRT.
- javac compiles against the REAL JDK's `java.util.concurrent` — missing
  classes only fail at the TeaVM translation stage, not javac.
- `@JSBody` methods on non-JSO classes must be `static`; prefer the typed
  binding overloads first (check `javap` on `teavm-jso-apis-0.15.0.jar`).
- **Reflection is reachability-gated**: `getDeclaredFields()` (and
  ctor/method lookup) only sees members statically reached somewhere.
  Widen via the extension SPI: `@Autoregistered` class extending
  `SimpleReflectionPolicy` (deps: `teavm-extension-apis`/`-spi`
  compileOnly + `teavm-extension-annotation-processor`). Caveats hit:
  reflectable FIELDS on `arc.struct` crash the compiler with a bare NPE;
  a policy covering all arc+mindustry fields OOMs the 8 GiB Gradle
  daemon. If arc Json reports "Field not found"/"Error constructing",
  grow `TeavmReflectionPolicy`'s package list.
- **Reflective walks over ANONYMOUS classes die silently** (task #4):
  TeaVM's Class has no `isAnonymousClass()`, and its reflective
  `getDeclaredClasses()`/superclass walk on an `Outer$N` class fails
  inside any surrounding catch. `Block.initBuilding()`'s buildType
  resolution thus fell back to base `mindustry.gen.Building` for every
  content block, whose empty `read()` desynced building chunks in
  legacy map/save reads (preview failures + campaign
  `Error reading region "map"`). Fix: replace `isAnonymousClass()` hops
  with the name check `getName().matches(".+\\$\\d+")` (works on JVM and
  TeaVM alike) — implemented for `Block.java` in
  `rewriteTeavmIncompatible`; the replacement text must stay out of
  files the annotation processors parse (its `\$` breaks them).
- **Coroutines**: `Thread.yield`/`wait`/`sleep` are suspension points
  that THROW when reached from a native JS callback (the RAF frame loop).
  Conversely, a coroutine worker only runs when another thread suspends —
  so `while(!done) update();` spin-waits deadlock against queued workers
  (hence `TeavmSimpleExecutor` executes inline).
- **Buffer→JS bridge**: TeaVM converts a `ByteBuffer` argument to an
  Int8Array, which WebGL rejects for UNSIGNED_BYTE pixel data; wrap with
  `Uint8Array.fromJavaBuffer(buf)` (floats/int/short likewise) — see
  `TeavmGL20.pixelView`.
- **GL out-param convention**: desktop GL writes gen*/get* results at the
  buffer's `position()` WITHOUT advancing it; arc's `clear(); gen*();
  get()` idiom breaks if a backend uses relative put/get (was the
  BufferUnderflow root cause).

## Current state (see README §5–§9 for detail)

- Build is green end to end (~1m50s); the game **boots to the main menu**
  in headless Chrome (`Total time to load: ~8.5s`; screenshot shows logo,
  icon buttons, campaign-map background). All bisection diagnostics from
  the underflow/deadlock hunts have been stripped (README §7 lists what was
  kept deliberately: `bootLog`/`bootError`, per-phase frame catches,
  `boot-test.mjs --profile`).
- Key mechanisms landed this milestone: relative→absolute IntBuffer
  access in all array-of-handles GL calls; `pixelView()` typed-array
  wrapping for pixel transfers; `TeavmReflectionPolicy` (compile-time TeaVM
  extension restoring `getDeclaredFields()`/no-arg-ctor reflection for arc
  Json — scope is mindustry.\* + arc.graphics/math fields, arc.struct +
  mindustry `<init>` only); `TeavmSimpleExecutor` runs tasks INLINE on the
  submitting thread (coroutine workers deadlock against spin-wait loops);
  arc-side `Thread.yield` removal in AssetManager, non-null
  `OS.username`/`userHome`; `buildStandalone` single-file build (all
  assets incl. music base64-embedded, boots from file://); anonymous-class
  `buildType` fix in `rewriteTeavmIncompatible` (README §5 item 10).
- Open runtime issues: favicon 404; DSP filters unimplemented. Map
  previews are fixed (all render; previously-broken Archipelago loads
  into a playable world).
- File import/export is browser-native: `TeavmFileChooser` (imports stage
  into IdbVfs `picked/` via the native picker; exports download via
  `DownloadFi`) — verified byte-exact round-trip with
  `tools/fileio-test.mjs` (README §5 item 11). Zip imports go through the
  patched in-memory `ZipFi` (arc checkout: ZipInputStream parse instead of
  ZipFile), and `TeavmApplication.exit()` drains IdbVfs's pending
  IndexedDB writes (up to 2s) before stopping so a post-import reload
  can't abort them (README §5 item 12). `LoadRenderer` is disabled in the
  ClientLauncher replacement (its draw() crashed per-frame on real GPUs and
  stalled boot — README §5 item 13); the boot loading animation is a few
  seconds of black screen. A language-only default locale crashes TeaVM's
  Currency lookup ("Currency not found: CYP") — Vars.java's replacement
  always gives the Java default locale a country (README §5 item 14).
- Not yet exercised in a live browser: campaign sector launch (the
  buildType fix is expected to clear its `Error reading region "map"`),
  in-game save slots via the pause menu, audio playback end-to-end.
