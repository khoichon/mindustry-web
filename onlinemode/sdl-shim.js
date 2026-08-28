// sdl-shim.js
// Maps arc.backend.sdl.jni.SDL's native methods onto a <canvas> + WebGL2 context +
// real browser input events. The event encoding below is copied verbatim from the
// JNI comment in Arc's SDL.java (backends/backend-sdl/src/arc/backend/sdl/jni/SDL.java) -
// that comment is effectively the spec for what SDL_PollEvent must write into `data`.
//
// Key point confirmed by reading Arc's source: SdlInput.java only ever consults the
// *scancode* (data[4] in the KEYDOWN/KEYUP case), via SdlScanmap - never the keysym
// path (SdlKeymap). SDL scancodes are the USB HID keyboard usage-page codes, which is
// exactly what we build below from the browser's KeyboardEvent.code.

(function (global) {
  'use strict';

  const NATIVES = {};
  // JNI mangling: a literal underscore *inside* the Java method name (e.g. the "_" in
  // "SDL_Init") must be escaped as "_1", separately from the "_" used to join
  // Java_<package>_<Class>_<method>. SDL's naming convention is full of underscores
  // (SDL_Init, SDL_GL_CreateContext, ...) so this affects nearly every entry below -
  // this was the actual cause of "UnsatisfiedLinkError: ..._SDL_SDL_1Init" not binding
  // to a plain "Java_..._SDL_SDL_Init" registration.
  function mangle(javaMethodName) { return javaMethodName.replace(/_/g, '_1'); }
  function native(name, fn) { NATIVES['Java_arc_backend_sdl_jni_SDL_' + mangle(name)] = fn; }

  let canvas = null;
  let glctx = null;
  const eventQueue = [];

  const SDL_WINDOWEVENT_SIZE_CHANGED = 6;
  const SDL_WINDOWEVENT_FOCUS_GAINED = 12;
  const SDL_WINDOWEVENT_FOCUS_LOST = 13;

  // --- USB HID / SDL scancode table, keyed by KeyboardEvent.code -------------
  const SCANCODE = {
    KeyA:4, KeyB:5, KeyC:6, KeyD:7, KeyE:8, KeyF:9, KeyG:10, KeyH:11, KeyI:12,
    KeyJ:13, KeyK:14, KeyL:15, KeyM:16, KeyN:17, KeyO:18, KeyP:19, KeyQ:20,
    KeyR:21, KeyS:22, KeyT:23, KeyU:24, KeyV:25, KeyW:26, KeyX:27, KeyY:28, KeyZ:29,
    Digit1:30, Digit2:31, Digit3:32, Digit4:33, Digit5:34, Digit6:35, Digit7:36,
    Digit8:37, Digit9:38, Digit0:39,
    Enter:40, Escape:41, Backspace:42, Tab:43, Space:44,
    Minus:45, Equal:46, BracketLeft:47, BracketRight:48, Backslash:49,
    Semicolon:51, Quote:52, Backquote:53, Comma:54, Period:55, Slash:56,
    CapsLock:57,
    F1:58, F2:59, F3:60, F4:61, F5:62, F6:63, F7:64, F8:65, F9:66, F10:67, F11:68, F12:69,
    PrintScreen:70, ScrollLock:71, Pause:72,
    Insert:73, Home:74, PageUp:75, Delete:76, End:77, PageDown:78,
    ArrowRight:79, ArrowLeft:80, ArrowDown:81, ArrowUp:82,
    NumLock:83, NumpadDivide:84, NumpadMultiply:85, NumpadSubtract:86, NumpadAdd:87,
    NumpadEnter:88, Numpad1:89, Numpad2:90, Numpad3:91, Numpad4:92, Numpad5:93,
    Numpad6:94, Numpad7:95, Numpad8:96, Numpad9:97, Numpad0:98, NumpadDecimal:99,
    ControlLeft:224, ShiftLeft:225, AltLeft:226, MetaLeft:227,
    ControlRight:228, ShiftRight:229, AltRight:230, MetaRight:231,
  };

  function scancodeFor(e) { return SCANCODE[e.code] || 0; }

  // eventReadIndex-based dequeue instead of Array.shift(): shift() re-indexes the
  // entire remaining array on every call, and SDL_PollEvent is called in a drain
  // loop (once per queued event, every frame) - shift() turns a burst of N queued
  // events (e.g. several mousemoves between frames) into O(N^2) work. Advancing a
  // read index is O(1) per poll; the array is only physically compacted
  // (occasionally, amortized) once it's fully drained or has grown large.
  let eventReadIndex = 0;
  function pushEvent(arr) {
    if (eventReadIndex > 0 && eventReadIndex >= eventQueue.length) {
      eventQueue.length = 0;
      eventReadIndex = 0;
    }
    eventQueue.push(arr);
  }

  function attachInputListeners(el) {
    el.tabIndex = 0; // canvas needs to be focusable to receive key events
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    // Mouse coordinates are delivered in LOGICAL pixels (CSS px), matching Arc's
    // SdlConfig default hdpiMode=logical: getWidth()/getHeight() return
    // logicalWidth/Height (fed from SIZE_CHANGED events), and SdlInput maps mouse
    // coords against those. The DPR-scaled canvas backing store is a *rendering*
    // concern only (updateSize points glViewport at SDL_GL_GetDrawableSize's backing
    // pixels) - input must NOT be scaled to it, or every coordinate lands wrong.
    const canvasXY = (e) => {
      const r = el.getBoundingClientRect();
      return [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)];
    };
    el.addEventListener('mousemove', (e) => {
      const [x, y] = canvasXY(e);
      pushEvent([2, x, y]);
    });
    el.addEventListener('mousedown', (e) => {
      el.focus();
      const [x, y] = canvasXY(e);
      pushEvent([3, 1, x, y, e.button + 1]);
    });
    el.addEventListener('mouseup', (e) => {
      const [x, y] = canvasXY(e);
      pushEvent([3, 0, x, y, e.button + 1]);
    });
    el.addEventListener('wheel', (e) => {
      pushEvent([4, e.deltaX > 0 ? 1 : (e.deltaX < 0 ? -1 : 0), e.deltaY > 0 ? -1 : (e.deltaY < 0 ? 1 : 0)]);
      e.preventDefault();
    }, { passive: false });

    el.addEventListener('keydown', (e) => {
      pushEvent([5, 1, e.key.codePointAt(0) || 0, e.repeat ? 1 : 0, scancodeFor(e), 0, 0]);
      if (e.key.length === 1) pushEvent([6, ...Array.from(e.key).map(c => c.codePointAt(0))]);
      if (['Tab', 'F5', 'F11', 'F12'].includes(e.code)) e.preventDefault();
    });
    el.addEventListener('keyup', (e) => {
      pushEvent([5, 0, e.key.codePointAt(0) || 0, 0, scancodeFor(e), 0, 0]);
    });

    window.addEventListener('resize', () => {
      resizeCanvasToDisplaySize();
      // SIZE_CHANGED carries LOGICAL (CSS) pixels - real SDL semantics; the game's
      // logicalWidth/Height (and therefore its whole input coordinate space) come
      // from these values.
      pushEvent([1, SDL_WINDOWEVENT_SIZE_CHANGED, el.clientWidth, el.clientHeight]);
    });
    window.addEventListener('focus', () => pushEvent([1, SDL_WINDOWEVENT_FOCUS_GAINED, 0, 0]));
    window.addEventListener('blur', () => pushEvent([1, SDL_WINDOWEVENT_FOCUS_LOST, 0, 0]));
  }

  function resizeCanvasToDisplaySize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  // --- lifecycle ---------------------------------------------------------------
  native('SDL_Init', async () => 0);
  native('SDL_InitSubSystem', async () => 0);
  native('SDL_QuitSubSystem', async () => {});
  native('SDL_WasInit', async () => 1);
  native('SDL_Quit', async () => {});
  native('SDL_SetHint', async () => true);
  native('SDL_GetError', async () => '');
  native('SDL_GetVersion', async (lib, arr) => { arr[0] = 2; arr[1] = 30; arr[2] = 0; });
  native('SDL_GetCompiledVersion', async (lib, arr) => { arr[0] = 2; arr[1] = 30; arr[2] = 0; });

  native('SDL_CreateWindow', async (lib, title, w, h, flags) => {
    canvas = window.mindustryCanvasElement || document.getElementById('mindustry-canvas');
    if (!canvas) throw new Error('window.mindustryCanvasElement / #mindustry-canvas not found - see index.html');
    document.title = title;
    resizeCanvasToDisplaySize();
    attachInputListeners(canvas);
    // Without an initial SIZE_CHANGED, SdlGraphics keeps the config's width/height as
    // its logical size and every mouse coordinate maps against that stale value.
    pushEvent([1, SDL_WINDOWEVENT_SIZE_CHANGED, canvas.clientWidth, canvas.clientHeight]);
    return 1; // opaque window "handle"
  });
  native('SDL_DestroyWindow', async () => {});
  native('SDL_SetWindowTitle', async (lib, handle, title) => { document.title = title; });
  native('SDL_SetWindowSize', async (lib, handle, w, h) => {
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    resizeCanvasToDisplaySize();
    pushEvent([1, SDL_WINDOWEVENT_SIZE_CHANGED, w, h]); // logical px, like real SDL
  });
  native('SDL_SetWindowPosition', async () => {});
  native('SDL_SetWindowBordered', async () => {});
  native('SDL_SetWindowAlwaysOnTop', async () => {});
  native('SDL_RestoreWindow', async () => {});
  native('SDL_MaximizeWindow', async () => {});
  native('SDL_MinimizeWindow', async () => {});
  native('SDL_SetWindowFullscreen', async (lib, handle, flags) => {
    if (flags) canvas.requestFullscreen?.(); else document.exitFullscreen?.();
    return 0;
  });
  native('SDL_GetWindowFlags', async () => 0x1 | 0x200 | 0x400); // SHOWN | MOUSE_FOCUS | INPUT_FOCUS - returning 0 reads as "never focused"
  native('SDL_GetWindowDisplayIndex', async () => 0);
  native('SDL_GetNumVideoDisplays', async () => 1);
  native('SDL_GetDisplayBounds', async (lib, display, xywh) => { xywh[0] = 0; xywh[1] = 0; xywh[2] = window.screen.width; xywh[3] = window.screen.height; return 0; });
  native('SDL_GetDisplayUsableBounds', async (lib, display, xywh) => { xywh[0] = 0; xywh[1] = 0; xywh[2] = window.innerWidth; xywh[3] = window.innerHeight; return 0; });
  native('SDL_GetCurrentDisplayMode', async (lib, display, wh) => { wh[0] = window.screen.width; wh[1] = window.screen.height; return 0; });
  native('SDL_GetDesktopDisplayMode', async (lib, display, wh) => { wh[0] = window.screen.width; wh[1] = window.screen.height; return 0; });

  // --- GL context ---------------------------------------------------------------
  native('SDL_GL_SetAttribute', async () => 0);
  native('SDL_GL_ExtensionSupported', async (lib, name) => !!glctx?.getExtension(name));
  native('SDL_GL_CreateContext', async () => {
    glctx = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
    if (!glctx) throw new Error('WebGL2 is not available in this browser');
    global.GL_SHIM_setContext(glctx);
    return 1;
  });
  native('SDL_GL_SetSwapInterval', async () => 0);
  native('SDL_GL_SwapWindow', async () => { if (global.GL_SHIM_present) global.GL_SHIM_present(); });
  native('SDL_GL_GetDrawableSize', async (lib, handle, values) => { values[0] = canvas.width; values[1] = canvas.height; });

  // --- events ---------------------------------------------------------------------
  native('SDL_PollEvent', async (lib, data) => {
    if (eventReadIndex >= eventQueue.length) {
      if (eventQueue.length) { eventQueue.length = 0; eventReadIndex = 0; } // fully drained - compact
      return false;
    }
    const ev = eventQueue[eventReadIndex++];
    for (let i = 0; i < ev.length && i < data.length; i++) data[i] = ev[i];
    // Bound unbounded growth during a heavy event burst: splice off consumed
    // entries every 256 events instead of on every single poll (amortized cost).
    if (eventReadIndex > 256) { eventQueue.splice(0, eventReadIndex); eventReadIndex = 0; }
    return true;
  });

  // --- clipboard / cursor / misc ---------------------------------------------------
  native('SDL_SetClipboardText', async (lib, text) => { try { await navigator.clipboard.writeText(text); } catch (e) {} return 0; });
  native('SDL_GetClipboardText', async () => { try { return await navigator.clipboard.readText(); } catch (e) { return ''; } });
  native('SDL_CreateSystemCursor', async (lib, type) => type);
  native('SDL_CreateColorCursor', async () => 1);
  native('SDL_CreateRGBSurfaceFrom', async () => 1);
  native('SDL_FreeSurface', async () => {});
  native('SDL_FreeCursor', async () => {});
  native('SDL_SetCursor', async () => {});
  native('SDL_SetWindowIcon', async () => {});
  native('SDL_ShowSimpleMessageBox', async (lib, flags, title, message) => { window.alert(title + '\n\n' + message); return 0; });
  native('SDL_StartTextInput', async () => {});
  native('SDL_StopTextInput', async () => {});
  native('SDL_SetTextInputRect', async () => {});
  native('SDL_IsTextInputActive', async () => true);

  global.SDL_SHIM_NATIVES = NATIVES;
})(window);