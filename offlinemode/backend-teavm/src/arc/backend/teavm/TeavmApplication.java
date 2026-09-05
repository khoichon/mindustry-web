package arc.backend.teavm;

import arc.Application;
import arc.ApplicationListener;
import arc.Core;
import arc.struct.Seq;
import org.teavm.jso.JSBody;
import org.teavm.jso.browser.AnimationFrameCallback;
import org.teavm.jso.browser.Window;
import org.teavm.jso.dom.html.HTMLCanvasElement;
import org.teavm.jso.webgl.WebGLRenderingContext;

public class TeavmApplication implements Application {
    private final Seq<ApplicationListener> listeners = new Seq<>();
    private final Seq<Runnable> postRunnables = new Seq<>();
    private final HTMLCanvasElement canvas;
    private final TeavmGraphics graphics;
    private final TeavmInput input;
    private final TeavmGL20 gl20;
    private boolean running;
    private int lastWidth = -1, lastHeight = -1;
    private long lastFrameErrorId;
    private long lastFrameErrorFrame = Long.MIN_VALUE;

    public TeavmApplication(HTMLCanvasElement canvas, WebGLRenderingContext gl) {
        this.canvas = canvas;

        // GL30 (WebGL2 carries VAOs/instancing natively) -- Mesh checks
        // Core.gl30 != null to pick VertexBufferObjectWithVAO over the
        // legacy client-side-array VertexArray, which WebGL cannot support
        // at all. See TeavmGL30's class doc.
        this.gl20 = new TeavmGL30(gl);
        this.graphics = new TeavmGraphics(canvas, gl);
        // Graphics must know about the GL implementation too -- anything that
        // reaches GL through Core.graphics.getGL20() instead of Core.gl20
        // would otherwise NPE.
        graphics.setGL20(gl20);

        this.input = new TeavmInput(canvas);

        Core.graphics = graphics;
        Core.gl = Core.gl20 = gl20;
        Core.gl30 = (arc.graphics.GL30) gl20;
        Core.input = input;
        Core.files = new TeavmFiles();
        // Every backend installs a Settings instance before the first frame;
        // Application.defaultUpdate() autosaves through Core.settings.
        Core.settings = new arc.Settings();
        // Core.audio is deliberately NOT constructed here -- Audio's constructor
        // calls initialize() -> Soloud.init() immediately, but Sound/Music
        // loading (via Core.audio.newSound/newMusic) can happen from asset-load
        // code that runs before start() -- so audio is brought up explicitly in
        // start(), after the IndexedDB VFS is ready, since streamLoadFile-backed
        // Music loading depends on Files already working (see Soloud.java's
        // streamLoadFile, which reads through TeavmFi).
    }

    /** Registers a listener before the app has started (i.e. before start()). */
    public void addInitialListener(ApplicationListener listener) {
        listeners.add(listener);
    }

    public void start() {
        // Two async gates before the app proper starts, run concurrently:
        //  - WebAssets: fetch manifest + prefetch every sync-read asset
        //    (sprites, fonts, sounds, maps, bundles) into memory.
        //  - IdbVfs: open IndexedDB and load the persisted save/settings
        //    namespace into memory.
        // Everything past this point (Audio init, ApplicationListener.init(),
        // and the RAF loop) waits for both, same as any other backend waits
        // for its synchronous filesystem to simply be there.
        int[] outstanding = {2};
        Runnable gate = () -> {
            bootLog("gate outstanding=" + outstanding[0]);
            if(--outstanding[0] == 0){
                Core.audio = new arc.audio.Audio();
                running = true;

                listenForLifecycleEvents();

                for (ApplicationListener l : listeners) {
                    bootLog("listener init: " + l.getClass().getName());
                    try{
                        l.init();
                    }catch(Throwable t){
                        // init() failures would otherwise vanish into the
                        // async gate callback with no trace of who threw.
                        // Printed in small independent steps: a diagnostic
                        // that itself throws (e.g. class-init during
                        // getClass()) must not lose the message.
                        try{ bootError(l.getClass().getName() + " init failed:"); }catch(Throwable ignored){}
                        // Log.err formats the throwable through printStackTrace,
                        // which has worked for every TeaVM exception so far --
                        // unlike direct getMessage()/toString(), which can
                        // themselves throw for native JS errors.
                        try{ arc.util.Log.err("init failed", t); }catch(Throwable ignored){}
                        throw t instanceof RuntimeException ? (RuntimeException)t : new RuntimeException(t);
                    }
                }
                bootLog("all listeners initialized");
                checkResize(true);

                Window.requestAnimationFrame(new AnimationFrameCallback() {
                    @Override
                    public void onAnimationFrame(double timestamp) {
                        if (!running) return;
                        try{
                            frame(timestamp);
                        }catch(Throwable t){
                            // A throw out of frame() would otherwise kill the RAF
                            // chain silently; keep the loop alive and surface the
                            // error (once per distinct exception, then every 60
                            // frames, to avoid console floods).
                            long id = System.identityHashCode(t);
                            if(id != lastFrameErrorId || Core.graphics.getFrameId() - lastFrameErrorFrame > 60){
                                lastFrameErrorId = id;
                                lastFrameErrorFrame = Core.graphics.getFrameId();
                                arc.util.Log.err("Frame error", t);
                            }
                        }
                        Window.requestAnimationFrame(this);
                    }
                });
            }
        };
        WebAssets.load(gate);
        IdbVfs.init(gate::run);
    }

    /**
     * One tick of the main loop, in the same order SdlApplication runs its
     * loop: graphics timekeeping -> resize handling -> input queue drain ->
     * default update (settings autosave, global time) -> listeners ->
     * posted runnables -> input per-frame state reset.
     */
    private void frame(double timestamp) {
        try{ graphics.nextFrame(timestamp); }catch(Throwable t){ bootErrorOnce("frame: graphics.nextFrame", t); }
        try{ checkResize(false); }catch(Throwable t){ bootErrorOnce("frame: checkResize", t); }
        try{ input.update(); }catch(Throwable t){ bootErrorOnce("frame: input.update", t); }
        try{ defaultUpdate(); }catch(Throwable t){ bootErrorOnce("frame: defaultUpdate", t); }

        for (ApplicationListener l : listeners) {
            try{ l.update(); }catch(Throwable t){ bootErrorOnce("frame: listener " + l.getClass().getName(), t); }
        }

        synchronized (postRunnables) {
            for (Runnable r : postRunnables) {
                try{ r.run(); }catch(Throwable t){ bootErrorOnce("frame: posted runnable", t); }
            }
            postRunnables.clear();
        }

        try{ input.postUpdate(); }catch(Throwable t){ bootErrorOnce("frame: input.postUpdate", t); }
    }

    private static long lastPhaseErrorTime;
    private static String lastPhase;
    private static void bootErrorOnce(String phase, Throwable t){
        // Rate-limit to one distinct phase per second; these fire per frame.
        long now = System.currentTimeMillis();
        if(phase.equals(lastPhase) && now - lastPhaseErrorTime < 1000) return;
        lastPhase = phase; lastPhaseErrorTime = now;
        bootError("[" + phase + "] " + String.valueOf(t));
    }

    /**
     * Resizing the canvas backing store clears the drawing buffer and resets
     * the GL viewport (index.html's resize handler reassigns canvas.width/
     * height on window resize / DPR change), so viewport + listener.resize
     * must be re-issued whenever the size has changed since last frame.
     */
    private void checkResize(boolean force) {
        int w = canvas.getWidth(), h = canvas.getHeight();
        if (force || w != lastWidth || h != lastHeight) {
            lastWidth = w;
            lastHeight = h;
            gl20.glViewport(0, 0, w, h);
            for (ApplicationListener l : listeners) l.resize(w, h);
        }
    }

    private void listenForLifecycleEvents() {
        // Tab hidden/shown maps to pause/resume; pagehide (tab close, mobile
        // app switch) maps to exit so settings/save state gets flushed.
        Window.current().getDocument().addEventListener("visibilitychange", e -> {
            if (isDocumentHidden()) {
                for (ApplicationListener l : listeners) l.pause();
            } else if (running) {
                for (ApplicationListener l : listeners) l.resume();
            }
        });
        Window.current().addEventListener("pagehide", e -> exit());
    }

    @Override
    public Seq<ApplicationListener> getListeners() {
        return listeners;
    }

    @Override
    public ApplicationType getType() {
        return ApplicationType.web;
    }

    @Override
    public String getClipboardText() {
        // Reading the real system clipboard requires an async permission-gated
        // API, which cannot be served from this synchronous call -- so like
        // the CheerpJ reference build, reads come from a page-local clipboard
        // that writeClipboardText keeps in sync (best effort).
        return localClipboard();
    }

    @Override
    public void setClipboardText(String text) {
        setLocalClipboard(text);
        // Fire-and-forget: also push to the real clipboard when the browser
        // allows it (requires a user gesture in most browsers).
        writeSystemClipboard(text);
    }

    @Override
    public void post(Runnable runnable) {
        synchronized (postRunnables) {
            postRunnables.add(runnable);
        }
    }

    @Override
    public void exit() {
        if (!running) return;
        // IdbVfs persistence is fire-and-forget: every file write/delete
        // queues an IndexedDB transaction that commits asynchronously. If
        // the page stops (or the user reloads) while transactions are
        // pending, they ABORT -- and after a data import (which deletes the
        // old saves before copying the new ones) that can lose everything
        // just written. So keep the app alive, still rendering, until the
        // write queue drains (2s cap) before tearing down.
        if (IdbVfs.pendingWrites() > 0) {
            if (flushRetries < 20) {
                flushRetries++;
                Window.current().setTimeout(() -> exit(), 100);
                return;
            }
            arc.util.Log.warn("[Files] exit: {0} IndexedDB writes still pending after 2s; stopping anyway.", IdbVfs.pendingWrites());
        }
        flushRetries = 0;
        running = false;
        // Application.dispose()'s default body: persist settings, tear down audio.
        Application.super.dispose();
        for (ApplicationListener l : listeners) l.exit();
        for (ApplicationListener l : listeners) l.pause();
        for (ApplicationListener l : listeners) l.dispose();
    }

    /** exit() flush-retry counter (see exit). */
    private int flushRetries;

    @JSBody(script = "return document.hidden;")
    private static native boolean isDocumentHidden();

    /** Boot diagnostics; routed straight to console.log, bypassing arc's Log (whose handler changes during boot). */
    @JSBody(params = "m", script = "console.log('[teavm-boot] ' + m);")
    public static native void bootLog(String m);

    @JSBody(params = "m", script = "console.error('[teavm-boot] ' + m);")
    public static native void bootError(String m);

    @JSBody(script = "return globalThis.__arcLocalClipboard || '';")
    private static native String localClipboard();

    @JSBody(params = "text", script = "globalThis.__arcLocalClipboard = text;")
    private static native void setLocalClipboard(String text);

    @JSBody(params = "text", script = "try{navigator.clipboard && navigator.clipboard.writeText(text);}catch(e){}")
    private static native void writeSystemClipboard(String text);
}
