package arc.backend.teavm;

import arc.Application.ApplicationType;
import arc.Graphics;
import arc.Graphics.Cursor.SystemCursor;
import arc.graphics.Pixmap;
import arc.graphics.gl.GLVersion;
import arc.graphics.GL20;
import arc.graphics.GL30;
import org.teavm.jso.dom.html.HTMLCanvasElement;
import org.teavm.jso.webgl.WebGLRenderingContext;

public class TeavmGraphics extends Graphics {
    private final HTMLCanvasElement canvas;
    private GL20 gl20;
    private GL30 gl30;
    private final GLVersion glVersion;
    private long frameId;
    private float deltaTime;
    private double lastFrameTime = -1;

    public TeavmGraphics(HTMLCanvasElement canvas, WebGLRenderingContext gl) {
        this.canvas = canvas;
        // WebGL2's getParameter(VERSION) returns strings like "WebGL 2.0 (...)",
        // which GLVersion's WebGL regex branch already knows how to parse --
        // this is the same trick GLVersion uses for GLES's "OpenGL ES 2.0" string.
        String versionString = gl.getParameter(WebGLRenderingContext.VERSION).toString();
        String vendorString = gl.getParameter(WebGLRenderingContext.VENDOR).toString();
        String rendererString = gl.getParameter(WebGLRenderingContext.RENDERER).toString();
        this.glVersion = new GLVersion(ApplicationType.web, versionString, vendorString, rendererString);
    }

    /** Called once per requestAnimationFrame tick, before listeners fire. */
    void nextFrame(double timestampMs) {
        if (lastFrameTime < 0) lastFrameTime = timestampMs;
        deltaTime = (float) ((timestampMs - lastFrameTime) / 1000.0);
        lastFrameTime = timestampMs;
        frameId++;
    }

    @Override
    public GL20 getGL20() {
        return gl20;
    }

    @Override
    public void setGL20(GL20 gl20) {
        this.gl20 = gl20;
    }

    @Override
    public GL30 getGL30() {
        return gl30;
    }

    @Override
    public void setGL30(GL30 gl30) {
        this.gl30 = gl30;
        if (gl30 != null) this.gl20 = gl30;
    }

    @Override
    public int getWidth() {
        return canvas.getWidth();
    }

    @Override
    public int getHeight() {
        return canvas.getHeight();
    }

    @Override
    public int getBackBufferWidth() {
        return canvas.getWidth();
    }

    @Override
    public int getBackBufferHeight() {
        return canvas.getHeight();
    }

    @Override
    public long getFrameId() {
        return frameId;
    }

    @Override
    public float getDeltaTime() {
        return deltaTime;
    }

    @Override
    public int getFramesPerSecond() {
        return deltaTime > 0 ? (int) (1f / deltaTime) : 0;
    }

    @Override
    public GLVersion getGLVersion() {
        return glVersion;
    }

    @Override
    public float getPpiX() {
        return 96f;
    }

    @Override
    public float getPpiY() {
        return 96f;
    }

    @Override
    public float getPpcX() {
        return 96f / 2.54f;
    }

    @Override
    public float getPpcY() {
        return 96f / 2.54f;
    }

    @Override
    public float getDensity() {
        // index.html scales the canvas backing store by devicePixelRatio, so
        // UI scale corrections need the same factor here.
        return (float) org.teavm.jso.browser.Window.current().getDevicePixelRatio();
    }

    @Override
    public void setTitle(String title) {
        org.teavm.jso.browser.Window.current().getDocument().setTitle(title);
    }

    @Override
    public void setVSync(boolean vsync) {
        // requestAnimationFrame is always vsync-paced in the browser; no-op.
    }

    @Override
    public BufferFormat getBufferFormat() {
        return new BufferFormat(8, 8, 8, 8, 16, 0, 0, false);
    }

    @Override
    public boolean supportsExtension(String extension) {
        return false; // TODO: gl.getSupportedExtensions()
    }

    @Override
    public boolean isContinuousRendering() {
        return true;
    }

    @Override
    public void setContinuousRendering(boolean isContinuous) {
        // Always continuous via requestAnimationFrame for now.
    }

    @Override
    public void requestRendering() {
        // No-op: we render every RAF tick already.
    }

    @Override
    public boolean isFullscreen() {
        return false; // TODO: document.fullscreenElement
    }

    @Override
    public Cursor newCursor(Pixmap pixmap, int xHotspot, int yHotspot) {
        return null; // TODO: CSS custom cursor via canvas.toDataURL()
    }

    @Override
    protected void setCursor(Cursor cursor) {
    }

    @Override
    protected void setSystemCursor(SystemCursor systemCursor) {
        // TODO: map to CSS cursor property, e.g. canvas.getStyle().setProperty("cursor", ...)
    }
}
