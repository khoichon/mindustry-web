package arc.backend.teavm;

import arc.Core;
import org.teavm.jso.JSObject;
import org.teavm.jso.browser.Window;
import org.teavm.jso.dom.html.HTMLCanvasElement;
import org.teavm.jso.dom.html.HTMLDocument;
import org.teavm.jso.webgl.WebGLRenderingContext;

/**
 * Entry point: sets up the canvas, WebGL2 context, and the
 * requestAnimationFrame loop, then hands off to TeavmTriangleTest --
 * the first real rendering milestone (compiled/linked shader, interleaved
 * vertex buffer, index buffer, indexed draw call), superseding the earlier
 * clear-color-only placeholder now that the render loop itself is confirmed
 * working end to end.
 *
 * Nothing here touches Mindustry or Arc's renderer yet -- this is
 * intentionally the smallest possible slice that proves the toolchain,
 * matching how backend-headless / backend-sdl bootstrap before any
 * game-specific code runs.
 */
public final class TeavmLauncher {

    public static void main(String[] args) {
        // Before anything else: TeaVM's System.out/err go nowhere by default,
        // and every arc/Mindustry log line and stack trace depends on them.
        TeavmConsole.install();

        HTMLDocument document = Window.current().getDocument();
        HTMLCanvasElement canvas = (HTMLCanvasElement) document.getElementById("mindustry-canvas");
        if (canvas == null) {
            throw new IllegalStateException("index.html must contain <canvas id=\"mindustry-canvas\">");
        }

        // "webgl2" gives us a WebGL2RenderingContext, which is what Arc's
        // GL30-capable path wants; TeaVM's jso-apis models it as a subtype
        // of WebGLRenderingContext so the GL20 surface still applies.
        // getContext() itself is typed as a generic JSObject in TeaVM's
        // HTMLCanvasElement -- there's no CanvasRenderingContext marker
        // type to go through, so this casts straight to what we actually want.
        JSObject raw = canvas.getContext("webgl2");
        if (raw == null) {
            throw new IllegalStateException("WebGL2 is not available in this browser");
        }
        WebGLRenderingContext gl = (WebGLRenderingContext) raw;

        TeavmApplication app = new TeavmApplication(canvas, gl);
        Core.app = app;

        // Boot the actual game. This mirrors DesktopLauncher.main()'s
        // essential sequence minus everything desktop-specific (Discord RPC,
        // Steam, JVM version gates); TeavmClientLauncher on top of
        // ClientLauncher does the rest.
        //
        // DesktopLauncher runs Version.init/loadLogger before the application
        // object even exists; here they must instead run as the FIRST
        // listener's init(), because both read bundled files (version.properties,
        // the settings store) that only exist once TeavmApplication.start()'s
        // WebAssets/IdbVfs gates have completed -- running them from main()
        // races the prefetch and reads nothing.
        app.addInitialListener(new arc.ApplicationListener(){
            @Override
            public void init(){
                // Data-directory state at boot, logged before anything else can
                // fail -- makes import/persistence issues visible in one line.
                byte[] settings = IdbVfs.read("mindustry/settings.bin");
                TeavmApplication.bootLog("[data] boot: " + IdbVfs.list("mindustry/saves").size()
                    + " saves, settings.bin " + (settings == null ? "absent" : settings.length + " bytes")
                    + ", " + IdbVfs.list("mindustry").size() + " top-level entries");

                mindustry.core.Version.init();
                mindustry.Vars.loadLogger();
                // Saves/settings live under one IdbVfs namespace (IndexedDB),
                // the browser equivalent of an app-data directory.
                Core.settings.setDataDirectory(Core.files.local("mindustry"));
            }
        });

        app.addInitialListener(new mindustry.teavm.TeavmClientLauncher());

        app.start();
    }
}
