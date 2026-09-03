# Mindustry in the Browser

An unofficial web port of [Mindustry](https://github.com/Anuken/Mindustry) with two separate browser builds:

* **Online / CheerpJ** — runs the actual Mindustry JAR inside a WebAssembly JVM.
* **Offline / TeaVM** — compiles a modified Arc + Mindustry directly to JavaScript, with the goal of producing a completely self-contained HTML file.

**Play:** https://khoichon.dev/mindustry-web/

---

## How it works

This project takes two different approaches to getting Mindustry running on the web.

```text
                         Mindustry
                            source
                              │
                 ┌────────────┴────────────┐
                 │                         │
                 ▼                         ▼
          Online / CheerpJ          Offline / TeaVM
                 │                         │
        Mindustry.jar + patches      Modified Arc
                 │                    + Mindustry
                 ▼                         │
          CheerpJ JVM → WASM               ▼
                 │                  TeaVM → JavaScript
                 │                         │
                 ▼                         ▼
            Browser tab              Single HTML file
```

The two builds are **not the same implementation**. They exist as separate pipelines with different goals and trade-offs.

---

## Online build — CheerpJ

The online version runs the **actual Mindustry `.jar`** rather than reimplementing the game in JavaScript.

[CheerpJ](https://cheerpj.com/) provides a JVM implemented using WebAssembly, allowing the game's Java bytecode to execute inside the browser.

However, Mindustry's desktop build expects native libraries and desktop APIs that aren't available in a browser. The JAR is therefore patched after compilation, and browser-side JavaScript shims provide replacements for the native functionality that the game expects.

Current shims include functionality for:

* SDL windowing and input
* OpenGL / WebGL rendering
* Audio through Web Audio
* FreeType/font handling
* Pixmap/image loading
* Buffer and mesh allocation
* Browser-compatible storage and file handling

The goal is to make the original desktop bytecode behave as if the required desktop/native environment exists.

### Requirements

The online build requires:

* A modern browser
* WebAssembly
* WebGL2
* An internet connection while playing

Chrome/Chromium is currently the primary target and has the best compatibility with the CheerpJ-based build.

The JAR and CheerpJ runtime are loaded over HTTP(S), so opening the build directly with `file://` is not supported.

---

## Offline build — TeaVM

The offline build takes a completely different approach.

Instead of executing the desktop JAR inside a JVM, the project works further upstream by modifying **Arc**, the engine Mindustry is built on.

The modified Arc engine provides web-compatible implementations for functionality such as:

* Rendering
* Audio
* Input
* File/I/O operations
* Other platform-dependent functionality

The modified engine is then built together with Mindustry using **TeaVM**, compiling the Java code ahead-of-time into JavaScript.

The eventual result is intended to be:

> **One self-contained `.html` file containing the game and its assets.**

Once downloaded, the file should be able to run locally without:

* A server
* A JVM
* An internet connection

In other words:

```text
Download mindustry.html
        │
        ▼
Double-click it
        │
        ▼
Play Mindustry
        │
        └── No internet required
```

### Current status

**The offline build is still in development.**

It is not currently considered complete or production-ready. The TeaVM pipeline requires additional work to adapt parts of Mindustry and Arc that were originally designed around desktop Java/runtime behavior.

The online CheerpJ build and the offline TeaVM build should therefore be considered **separate projects sharing the same goal**, rather than one being a different version of the other.

---

## Current limitations

This is an experimental port, so some things are expected to break.

Known issues include:

* The minimap currently does not display correctly.
* Some mods crash during startup.
* External save-file importing has compatibility issues with some campaign progression data.
* Browser compatibility varies between engines.

If something breaks, **the browser console is usually the first place to look**.

---

## Development

The repository contains the browser-side shims and tooling used by the CheerpJ build, as well as the work-in-progress components for the TeaVM/offline build.

Some of the more interesting pieces include:

* `sdl-shim.js` — browser implementation of SDL functionality
* `gl-shim.js` — OpenGL/WebGL compatibility layer
* `freetype-shim.js` — FreeType compatibility
* `pixmap-shim.js` — browser-side image decoding
* `buffers-shim.js` — buffer/memory functionality
* `web-bridge.js` — browser ↔ Java runtime integration
* `stub-natives.js` — native-function replacements

The project involves a mixture of Java bytecode patching, JavaScript/WASM interop, browser APIs, and modifications to the Arc engine.

Because this is experimental, some parts of the implementation are intentionally rough and subject to change.

---

## Running locally

For the CheerpJ build, serve the repository over HTTP rather than opening `index.html` directly:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080/
```

A browser with good WebAssembly/WebGL2 support is recommended.

---

## Why two builds?

The two approaches solve different problems.

|              | Online — CheerpJ            | Offline — TeaVM                 |
| ------------ | --------------------------- | ------------------------------- |
| Runtime      | CheerpJ JVM                 | JavaScript                      |
| Compilation  | JVM → WebAssembly           | Java → JavaScript               |
| Game source  | Original Mindustry bytecode | Modified Arc + Mindustry source |
| Native code  | Replaced with browser shims | Ported/adapted to web           |
| Internet     | Required while playing      | Only needed to download         |
| Installation | None                        | None                            |
| Output       | Browser application         | Self-contained HTML             |
| Status       | Playable                    | In development                  |

The CheerpJ build is the practical **"get Mindustry running in a browser now"** approach.

The TeaVM build is the much more ambitious **"put Mindustry into one HTML file and take it anywhere"** approach.

---

## Disclaimer

This is an unofficial, fan-made project.

Mindustry is developed by **Anuken and contributors** and is distributed under the **GNU General Public License v3.0**.

Arc is the engine used by Mindustry.

This project is not affiliated with or endorsed by the original Mindustry developers.

---

## Links

* **Web build:** https://khoichon.dev/mindustry-web/
* **Mindustry:** https://github.com/Anuken/Mindustry
* **Arc:** https://github.com/Anuken/Arc

---

### Project status

> 🚧 **Experimental**
>
> The browser build is functional, while the standalone offline build is still being developed.
>
> If you do notice any issues, do report them in the [Issues tab](https://github.com/khoichon/mindustry-web/issues/new). 