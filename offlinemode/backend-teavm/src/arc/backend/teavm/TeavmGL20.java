package arc.backend.teavm;

import arc.graphics.GL20;
import org.teavm.jso.webgl.*;

import java.nio.Buffer;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;
import java.util.HashMap;
import java.util.Map;

/**
 * GL20 implemented against a WebGL2RenderingContext.
 *
 * UPDATE: the original assumption below (that every java.nio.Buffer-taking
 * method needs manual typed-array conversion) turned out to be wrong for
 * most of them. TeaVM's jso-apis WebGLRenderingContext binding has direct
 * java.nio.Buffer/FloatBuffer/IntBuffer overloads for bufferData/
 * bufferSubData/texImage2D/texSubImage2D/every uniform*v and
 * uniformMatrix*fv/vertexAttrib*fv call -- no manual conversion needed,
 * just pass the Buffer straight through. Checked against TeaVM's actual
 * source (jso/apis/.../webgl/WebGLRenderingContext.java) before writing
 * these, not assumed.
 *
 * What's genuinely still unimplemented, and why each one is different:
 *
 *  - glReadPixels: WebGL's readPixels only accepts ArrayBufferView, no
 *    plain-Buffer overload exists for it specifically -- a real TODO,
 *    needs the typed-array bridge originally described here. Not on the
 *    hot render path (screenshots/pixel readback, not per-frame drawing).
 *  - glDrawElements(Buffer) / glVertexAttribPointer(Buffer): NOT a
 *    marshalling gap -- WebGL has no client-side-array draw path at all,
 *    ever. Always requires a bound buffer object + integer offset (the
 *    other overloads of these two methods, which ARE implemented). If
 *    Mindustry's renderer hits these, the fix is routing that call site
 *    through a real GL buffer object, not implementing this method.
 *  - glCompressedTex(Sub)Image2D: real TODO, not yet needed for a first
 *    triangle/quad.
 *  - Most glGet* / glTexParameter*v (except glGetProgramiv/glGetShaderiv,
 *    which ARE implemented via getProgramParameteri/getShaderParameteri --
 *    needed for checking shader compile/link status): real TODOs, lower
 *    priority than getting something on screen first.
 *
 * Separately, GL20's ~140 methods still split into two buckets worth
 * knowing about:
 *
 *  1. Int-handle + primitive-only calls (bind*, create/delete*, compile,
 *     link, enable/disable, clear, viewport, drawArrays,
 *     drawElements-by-offset...). WebGL objects (WebGLTexture, WebGLBuffer,
 *     WebGLUniformLocation, ...) are opaque JS objects, not ints -- Arc's
 *     API hands out ints everywhere, so this class keeps side tables
 *     mapping int handle -> JS object, same technique gdx's old GWT
 *     backend and every other browser GL wrapper uses.
 *
 *  2. Buffer-taking calls -- as described above, almost all of these are
 *     direct pass-throughs now, not conversions.
 *
 * Everything still unimplemented throws UnsupportedOperationException with
 * a specific note, so the interface compiles and it's obvious what's left
 * rather than silently no-op-ing.
 */
public class TeavmGL20 implements GL20 {
    protected final WebGL2RenderingContext gl;

    protected final Map<Integer, WebGLTexture> textures = new HashMap<>();
    private final Map<Integer, WebGLBuffer> buffers = new HashMap<>();
    private final Map<Integer, WebGLShader> shaders = new HashMap<>();
    protected final Map<Integer, WebGLProgram> programs = new HashMap<>();
    private final Map<Integer, WebGLFramebuffer> framebuffers = new HashMap<>();
    private final Map<Integer, WebGLRenderbuffer> renderbuffers = new HashMap<>();
    private final Map<Integer, WebGLUniformLocation> uniformLocations = new HashMap<>();
    protected int nextHandle = 1;

    public TeavmGL20(WebGLRenderingContext gl) {
        // Constructed with a WebGL2 context (see TeavmLauncher); cast once here
        // so every call below can use WebGL2-only entry points (e.g. proper
        // UNSIGNED_INT element indices, vertex array objects later on).
        this.gl = (WebGL2RenderingContext) gl;
    }

    private static UnsupportedOperationException notYetImplemented(String method) {
        return new UnsupportedOperationException(
            method + " needs java.nio Buffer -> JS typed array marshalling; see class-level TODO.");
    }

    // ---- lifecycle / state ----

    @Override public void glClearColor(float r, float g, float b, float a) { gl.clearColor(r, g, b, a); }
    @Override public void glClear(int mask) { gl.clear(mask); }
    @Override public void glClearDepthf(float depth) { gl.clearDepth(depth); }
    @Override public void glClearStencil(int s) { gl.clearStencil(s); }
    @Override public void glColorMask(boolean r, boolean g, boolean b, boolean a) { gl.colorMask(r, g, b, a); }
    @Override public void glViewport(int x, int y, int width, int height) { gl.viewport(x, y, width, height); }
    @Override public void glScissor(int x, int y, int width, int height) { gl.scissor(x, y, width, height); }
    @Override public void glEnable(int cap) { gl.enable(cap); }
    @Override public void glDisable(int cap) { gl.disable(cap); }
    @Override public boolean glIsEnabled(int cap) { return gl.isEnabled(cap); }
    @Override public void glDepthFunc(int func) { gl.depthFunc(func); }
    @Override public void glDepthMask(boolean flag) { gl.depthMask(flag); }
    @Override public void glDepthRangef(float zNear, float zFar) { gl.depthRange(zNear, zFar); }
    @Override public void glCullFace(int mode) { gl.cullFace(mode); }
    @Override public void glFrontFace(int mode) { gl.frontFace(mode); }
    @Override public void glLineWidth(float width) { gl.lineWidth(width); }
    @Override public void glPolygonOffset(float factor, float units) { gl.polygonOffset(factor, units); }
    @Override public void glPixelStorei(int pname, int param) { gl.pixelStorei(pname, param); }
    @Override public void glHint(int target, int mode) { gl.hint(target, mode); }
    @Override public void glFinish() { gl.finish(); }
    @Override public void glFlush() { gl.flush(); }
    @Override public int glGetError() { return gl.getError(); }
    @Override public String glGetString(int name) { return gl.getParameter(name).toString(); }

    @Override
    public void glBlendFunc(int sfactor, int dfactor) { gl.blendFunc(sfactor, dfactor); }
    @Override
    public void glBlendFuncSeparate(int srcRGB, int dstRGB, int srcAlpha, int dstAlpha) {
        gl.blendFuncSeparate(srcRGB, dstRGB, srcAlpha, dstAlpha);
    }
    @Override public void glBlendEquation(int mode) { gl.blendEquation(mode); }
    @Override public void glBlendEquationSeparate(int modeRGB, int modeAlpha) { gl.blendEquationSeparate(modeRGB, modeAlpha); }
    @Override public void glBlendColor(float r, float g, float b, float a) { gl.blendColor(r, g, b, a); }

    @Override public void glStencilFunc(int func, int ref, int mask) { gl.stencilFunc(func, ref, mask); }
    @Override public void glStencilFuncSeparate(int face, int func, int ref, int mask) { gl.stencilFuncSeparate(face, func, ref, mask); }
    @Override public void glStencilMask(int mask) { gl.stencilMask(mask); }
    @Override public void glStencilMaskSeparate(int face, int mask) { gl.stencilMaskSeparate(face, mask); }
    @Override public void glStencilOp(int fail, int zfail, int zpass) { gl.stencilOp(fail, zfail, zpass); }
    @Override public void glStencilOpSeparate(int face, int fail, int zfail, int zpass) { gl.stencilOpSeparate(face, fail, zfail, zpass); }
    @Override public void glSampleCoverage(float value, boolean invert) { gl.sampleCoverage(value, invert); }

    // ---- textures ----

    @Override
    public int glGenTexture() {
        int handle = nextHandle++;
        textures.put(handle, gl.createTexture());
        return handle;
    }
    @Override public void glDeleteTexture(int texture) { gl.deleteTexture(textures.remove(texture)); }
    @Override public void glBindTexture(int target, int texture) {
        gl.bindTexture(target, texture == 0 ? null : textures.get(texture));
    }
    @Override public void glActiveTexture(int texture) { gl.activeTexture(texture); }
    @Override public void glTexParameterf(int target, int pname, float param) { gl.texParameterf(target, pname, param); }
    @Override public void glTexParameteri(int target, int pname, int param) { gl.texParameteri(target, pname, param); }
    @Override public void glGenerateMipmap(int target) { gl.generateMipmap(target); }
    @Override public boolean glIsTexture(int texture) { return gl.isTexture(textures.get(texture)); }
    @Override public void glCopyTexImage2D(int target, int level, int internalformat, int x, int y, int width, int height, int border) {
        gl.copyTexImage2D(target, level, internalformat, x, y, width, height, border);
    }
    @Override public void glCopyTexSubImage2D(int target, int level, int xoffset, int yoffset, int x, int y, int width, int height) {
        gl.copyTexSubImage2D(target, level, xoffset, yoffset, x, y, width, height);
    }

    // ---- buffers (VBO/IBO) ----

    @Override
    public int glGenBuffer() {
        int handle = nextHandle++;
        buffers.put(handle, gl.createBuffer());
        return handle;
    }
    @Override public void glDeleteBuffer(int buffer) { gl.deleteBuffer(buffers.remove(buffer)); }
    @Override public void glBindBuffer(int target, int buffer) {
        gl.bindBuffer(target, buffer == 0 ? null : buffers.get(buffer));
    }
    @Override public boolean glIsBuffer(int buffer) { return gl.isBuffer(buffers.get(buffer)); }

    // ---- shaders / programs ----

    @Override
    public int glCreateShader(int type) {
        int handle = nextHandle++;
        shaders.put(handle, gl.createShader(type));
        return handle;
    }
    @Override public void glShaderSource(int shader, String source) {
        // GLSL ES (WebGL) requires a default float precision before the first
        // float-typed declaration. Arc's Shader.preprocess emits `out vec4
        // fragColor;` BEFORE its `#ifdef GL_ES precision ...` block on the
        // GL30 path (fine on desktop GL, which has no precision requirement,
        // and masked on mobile by the `lowp` on that same line -- but bare on
        // WebGL), and desktop-style sources may omit precision entirely.
        // Re-declaring default precision is legal in GLSL ES, so highp
        // defaults are injected unconditionally, directly after any #version
        // directive (which must remain the first line).
        String defaults = "precision highp float;\nprecision highp int;\n";
        if (source.startsWith("#version")) {
            int newline = source.indexOf('\n');
            source = source.substring(0, newline + 1) + defaults + source.substring(newline + 1);
        } else {
            source = defaults + source;
        }
        gl.shaderSource(shaders.get(shader), source);
    }
    @Override public void glCompileShader(int shader) { gl.compileShader(shaders.get(shader)); }
    @Override public void glDeleteShader(int shader) { gl.deleteShader(shaders.remove(shader)); }
    @Override public boolean glIsShader(int shader) { return gl.isShader(shaders.get(shader)); }
    @Override public String glGetShaderInfoLog(int shader) { return gl.getShaderInfoLog(shaders.get(shader)); }
    @Override public void glReleaseShaderCompiler() { /* no browser equivalent; no-op */ }

    @Override
    public int glCreateProgram() {
        int handle = nextHandle++;
        programs.put(handle, gl.createProgram());
        return handle;
    }
    @Override public void glAttachShader(int program, int shader) { gl.attachShader(programs.get(program), shaders.get(shader)); }
    @Override public void glDetachShader(int program, int shader) { gl.detachShader(programs.get(program), shaders.get(shader)); }
    @Override public void glLinkProgram(int program) { gl.linkProgram(programs.get(program)); }
    @Override public void glUseProgram(int program) { gl.useProgram(program == 0 ? null : programs.get(program)); }
    @Override public void glValidateProgram(int program) { gl.validateProgram(programs.get(program)); }
    @Override public void glDeleteProgram(int program) { gl.deleteProgram(programs.remove(program)); }
    @Override public boolean glIsProgram(int program) { return gl.isProgram(programs.get(program)); }
    @Override public String glGetProgramInfoLog(int program) { return gl.getProgramInfoLog(programs.get(program)); }
    @Override public void glBindAttribLocation(int program, int index, String name) { gl.bindAttribLocation(programs.get(program), index, name); }
    @Override public int glGetAttribLocation(int program, String name) { return gl.getAttribLocation(programs.get(program), name); }
    @Override public int glGetUniformLocation(int program, String name) {
        WebGLUniformLocation loc = gl.getUniformLocation(programs.get(program), name);
        if (loc == null) return -1; // matches desktop GL's "-1 = not found/optimized out" convention
        int handle = nextHandle++;
        uniformLocations.put(handle, loc);
        return handle;
    }

    /** Resolves a GL20-style int uniform location to the real WebGLUniformLocation every gl.uniform*() call needs. */
    private WebGLUniformLocation loc(int location) {
        return uniformLocations.get(location);
    }

    @Override public void glEnableVertexAttribArray(int index) { gl.enableVertexAttribArray(index); }
    @Override public void glDisableVertexAttribArray(int index) { gl.disableVertexAttribArray(index); }
    @Override public void glVertexAttribPointer(int indx, int size, int type, boolean normalized, int stride, int ptr) {
        gl.vertexAttribPointer(indx, size, type, normalized, stride, ptr);
    }

    // ---- draw calls (offset-based; the path Mindustry's SpriteBatch/mesh code uses) ----

    @Override public void glDrawArrays(int mode, int first, int count) { gl.drawArrays(mode, first, count); }
    @Override public void glDrawElements(int mode, int count, int type, int indices) { gl.drawElements(mode, count, type, indices); }

    // ---- framebuffers / renderbuffers ----

    @Override
    public int glGenFramebuffer() {
        int handle = nextHandle++;
        framebuffers.put(handle, gl.createFramebuffer());
        return handle;
    }
    @Override public void glBindFramebuffer(int target, int framebuffer) {
        gl.bindFramebuffer(target, framebuffer == 0 ? null : framebuffers.get(framebuffer));
    }
    @Override public void glDeleteFramebuffer(int framebuffer) { gl.deleteFramebuffer(framebuffers.remove(framebuffer)); }
    @Override public boolean glIsFramebuffer(int framebuffer) { return gl.isFramebuffer(framebuffers.get(framebuffer)); }
    @Override public int glCheckFramebufferStatus(int target) { return gl.checkFramebufferStatus(target); }
    @Override public void glFramebufferTexture2D(int target, int attachment, int textarget, int texture, int level) {
        gl.framebufferTexture2D(target, attachment, textarget, textures.get(texture), level);
    }
    @Override public void glFramebufferRenderbuffer(int target, int attachment, int renderbuffertarget, int renderbuffer) {
        gl.framebufferRenderbuffer(target, attachment, renderbuffertarget, renderbuffers.get(renderbuffer));
    }
    @Override
    public int glGenRenderbuffer() {
        int handle = nextHandle++;
        renderbuffers.put(handle, gl.createRenderbuffer());
        return handle;
    }
    @Override public void glBindRenderbuffer(int target, int renderbuffer) {
        gl.bindRenderbuffer(target, renderbuffer == 0 ? null : renderbuffers.get(renderbuffer));
    }
    @Override public void glDeleteRenderbuffer(int renderbuffer) { gl.deleteRenderbuffer(renderbuffers.remove(renderbuffer)); }
    @Override public boolean glIsRenderbuffer(int renderbuffer) { return gl.isRenderbuffer(renderbuffers.get(renderbuffer)); }
    @Override public void glRenderbufferStorage(int target, int internalformat, int width, int height) {
        gl.renderbufferStorage(target, internalformat, width, height);
    }

    // ---- uniforms (scalar/vector -- no Buffer marshalling needed) ----

    @Override public void glUniform1f(int location, float x) { gl.uniform1f(loc(location), x); }
    @Override public void glUniform1i(int location, int x) { gl.uniform1i(loc(location), x); }
    @Override public void glUniform2f(int location, float x, float y) { gl.uniform2f(loc(location), x, y); }
    @Override public void glUniform2i(int location, int x, int y) { gl.uniform2i(loc(location), x, y); }
    @Override public void glUniform3f(int location, float x, float y, float z) { gl.uniform3f(loc(location), x, y, z); }
    @Override public void glUniform3i(int location, int x, int y, int z) { gl.uniform3i(loc(location), x, y, z); }
    @Override public void glUniform4f(int location, float x, float y, float z, float w) { gl.uniform4f(loc(location), x, y, z, w); }
    @Override public void glUniform4i(int location, int x, int y, int z, int w) { gl.uniform4i(loc(location), x, y, z, w); }

    // =====================================================================
    // Everything below needs java.nio Buffer <-> JS typed array marshalling
    // (bucket 2 from the class doc). Implemented as explicit TODOs rather
    // than guessed at.
    // =====================================================================

    @Override public void glCompressedTexImage2D(int t, int l, int f, int w, int h, int b, int s, Buffer d) { throw notYetImplemented("glCompressedTexImage2D"); }
    @Override public void glCompressedTexSubImage2D(int t, int l, int xo, int yo, int w, int h, int f, int s, Buffer d) { throw notYetImplemented("glCompressedTexSubImage2D"); }

    /**
     * WebGL validates the VIEW TYPE against the pixel `type` argument:
     * UNSIGNED_BYTE uploads demand a Uint8Array (Uint8ClampedArray also
     * works), FLOAT demands Float32Array, UNSIGNED_SHORT/INT likewise. TeaVM's
     * automatic java.nio.Buffer bridge produces an Int8Array for ByteBuffers,
     * which WebGL rejects with INVALID_OPERATION ("type UNSIGNED_BYTE but
     * ArrayBufferView not Uint8Array or Uint8ClampedArray") -- so pixel data
     * is re-wrapped in the typed-array flavor matching its Java element type.
     * fromJavaBuffer keeps the buffer's position..limit window, same as the
     * automatic bridge.
     */
    static org.teavm.jso.typedarrays.ArrayBufferView pixelView(Buffer pixels){
        if(pixels instanceof java.nio.FloatBuffer) return org.teavm.jso.typedarrays.Float32Array.fromJavaBuffer(pixels);
        if(pixels instanceof java.nio.IntBuffer)   return org.teavm.jso.typedarrays.Int32Array.fromJavaBuffer(pixels);
        if(pixels instanceof java.nio.ShortBuffer) return org.teavm.jso.typedarrays.Uint16Array.fromJavaBuffer(pixels);
        return org.teavm.jso.typedarrays.Uint8Array.fromJavaBuffer(pixels);
    }

    @Override
    public void glTexImage2D(int target, int level, int internalformat, int width, int height, int border, int format, int type, Buffer pixels) {
        // A null Buffer (legal GL for "allocate uninitialized storage") must
        // go through the ArrayBufferView overload as JS null; non-null data
        // goes through pixelView for the right typed-array flavor.
        if (pixels == null) {
            gl.texImage2D(target, level, internalformat, width, height, border, format, type,
                (org.teavm.jso.typedarrays.ArrayBufferView) null);
        } else {
            gl.texImage2D(target, level, internalformat, width, height, border, format, type, pixelView(pixels));
        }
    }

    @Override
    public void glTexSubImage2D(int target, int level, int xoffset, int yoffset, int width, int height, int format, int type, Buffer pixels) {
        if (pixels == null) {
            gl.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type,
                (org.teavm.jso.typedarrays.ArrayBufferView) null);
        } else {
            gl.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixelView(pixels));
        }
    }

    @Override public void glReadPixels(int x, int y, int width, int height, int format, int type, Buffer pixels) {
        // WebGL's readPixels has no plain java.nio.Buffer overload in TeaVM's
        // jso-apis, and like texImage2D it validates the view type against
        // `type` -- pixelView supplies the right unsigned/float flavor. Off
        // the per-frame path (screenshots / pixel readback only).
        gl.readPixels(x, y, width, height, format, type, pixels == null ? null : pixelView(pixels));
    }


    @Override
    public void glBufferData(int target, int size, Buffer data, int usage) {
        // Same direct-Buffer-overload situation as texImage2D. Note: WebGL's
        // bufferData(target, Buffer, usage) uploads bytes from the buffer's
        // own position..limit range -- it has no separate "size" parameter
        // the way desktop GL's C-level glBufferData does. `size` here is
        // trusted to already match that range (standard practice: callers
        // set the buffer's position/limit to describe exactly what they want
        // uploaded before calling this, same as every other Arc backend
        // assumes), so it's intentionally unused rather than silently wrong.
        gl.bufferData(target, data, usage);
    }

    @Override
    public void glBufferSubData(int target, int offset, int size, Buffer data) {
        gl.bufferSubData(target, offset, data);
    }

    @Override
    public void glDrawElements(int mode, int count, int type, Buffer indices) {
        // This isn't a marshalling gap to fill in later -- WebGL has no
        // client-side-array draw path at all, ever. glDrawElements always
        // requires a bound ELEMENT_ARRAY_BUFFER and an integer byte offset
        // into it (the other glDrawElements overload above, which IS
        // implemented). Desktop/mobile GL support this Buffer-taking
        // overload because they allow drawing straight from unbound client
        // memory; WebGL's spec simply doesn't have that capability. If
        // Mindustry's renderer hits this, the fix is routing that call site
        // through a real GL buffer object (IndexBufferObject, not the
        // legacy client-array IndexArray path), not implementing this method.
        throw new UnsupportedOperationException(
            "WebGL has no client-side-array glDrawElements -- requires a bound ELEMENT_ARRAY_BUFFER " +
            "and the int-offset overload instead. See this method's comment.");
    }

    @Override
    public void glVertexAttribPointer(int indx, int size, int type, boolean normalized, int stride, Buffer ptr) {
        // Same permanent WebGL limitation as glDrawElements(Buffer) above --
        // not a TODO, a hard spec limit. Needs a bound ARRAY_BUFFER and the
        // int-offset overload instead.
        throw new UnsupportedOperationException(
            "WebGL has no client-side vertexAttribPointer -- requires a bound ARRAY_BUFFER " +
            "and the int-offset overload instead. See this method's comment.");
    }
    // WebGL's getParameter returns the value directly (typed overloads
    // getParameteri/getParameterf); written at the buffer's current position
    // -- like desktop GL, without advancing it -- to match the out-param
    // convention. Multi-value pnames (color masks etc.) would need array
    // results -- none are queried by Mindustry/Arc.
    @Override public void glGetIntegerv(int pname, IntBuffer params) { params.put(params.position(), gl.getParameteri(pname)); }
    @Override public void glGetBooleanv(int pname, Buffer params) { throw notYetImplemented("glGetBooleanv"); }
    @Override public void glGetFloatv(int pname, FloatBuffer params) { params.put(params.position(), gl.getParameterf(pname)); }
    @Override public void glGetBufferParameteriv(int target, int pname, IntBuffer params) { throw notYetImplemented("glGetBufferParameteriv"); }
    @Override public void glGetFramebufferAttachmentParameteriv(int target, int attachment, int pname, IntBuffer params) { throw notYetImplemented("glGetFramebufferAttachmentParameteriv"); }

    @Override
    public void glGetProgramiv(int program, int pname, IntBuffer params) {
        // WebGL returns parameter queries directly (getProgramParameter) rather
        // than through an out-param the way desktop GL's glGetProgramiv does --
        // getProgramParameteri is TeaVM's typed overload for the common
        // int-valued params (LINK_STATUS, ACTIVE_UNIFORMS, etc.), written at
        // the buffer's current position (unadvanced, like desktop GL) to match
        // the out-param calling convention every caller here already expects
        // (e.g. Shader.java checking link status).
        params.put(params.position(), gl.getProgramParameteri(programs.get(program), pname));
    }

    @Override public void glGetRenderbufferParameteriv(int target, int pname, IntBuffer params) { throw notYetImplemented("glGetRenderbufferParameteriv"); }

    @Override
    public void glGetShaderiv(int shader, int pname, IntBuffer params) {
        // Same reasoning as glGetProgramiv above -- this is the one that
        // actually matters most for getting a first shader compiling, since
        // it's how COMPILE_STATUS gets checked.
        params.put(params.position(), gl.getShaderParameteri(shaders.get(shader), pname));
    }

    @Override public void glGetShaderPrecisionFormat(int shadertype, int precisiontype, IntBuffer range, IntBuffer precision) { throw notYetImplemented("glGetShaderPrecisionFormat"); }
    @Override public void glGetTexParameterfv(int target, int pname, FloatBuffer params) { throw notYetImplemented("glGetTexParameterfv"); }
    @Override public void glGetTexParameteriv(int target, int pname, IntBuffer params) { throw notYetImplemented("glGetTexParameteriv"); }
    @Override public void glGetUniformfv(int program, int location, FloatBuffer params) { throw notYetImplemented("glGetUniformfv"); }
    @Override public void glGetUniformiv(int program, int location, IntBuffer params) { throw notYetImplemented("glGetUniformiv"); }
    @Override public void glGetVertexAttribfv(int index, int pname, FloatBuffer params) { throw notYetImplemented("glGetVertexAttribfv"); }
    @Override public void glGetVertexAttribiv(int index, int pname, IntBuffer params) { throw notYetImplemented("glGetVertexAttribiv"); }
    @Override public String glGetActiveAttrib(int program, int index, IntBuffer size, IntBuffer type) {
        // WebGL hands back a WebGLActiveInfo object instead of writing
        // through out-pointers; unpack into the caller's buffers at their
        // current position, which desktop GL leaves unadvanced.
        org.teavm.jso.webgl.WebGLActiveInfo info = gl.getActiveAttrib(programs.get(program), index);
        size.put(size.position(), info.getSize());
        type.put(type.position(), info.getType());
        return info.getName();
    }
    @Override public String glGetActiveUniform(int program, int index, IntBuffer size, IntBuffer type) {
        org.teavm.jso.webgl.WebGLActiveInfo info = gl.getActiveUniform(programs.get(program), index);
        size.put(size.position(), info.getSize());
        type.put(type.position(), info.getType());
        return info.getName();
    }
    @Override public void glTexParameterfv(int target, int pname, FloatBuffer params) { throw notYetImplemented("glTexParameterfv"); }
    @Override public void glTexParameteriv(int target, int pname, IntBuffer params) { throw notYetImplemented("glTexParameteriv"); }
    @Override public void glUniform1fv(int location, int count, FloatBuffer v) { gl.uniform1fv(loc(location), v); }
    @Override public void glUniform1fv(int location, int count, float[] v, int offset) { gl.uniform1fv(loc(location), java.util.Arrays.copyOfRange(v, offset, offset + count)); }
    @Override public void glUniform1iv(int location, int count, IntBuffer v) { gl.uniform1iv(loc(location), v); }
    @Override public void glUniform1iv(int location, int count, int[] v, int offset) { gl.uniform1iv(loc(location), java.util.Arrays.copyOfRange(v, offset, offset + count)); }
    @Override public void glUniform2fv(int location, int count, FloatBuffer v) { gl.uniform2fv(loc(location), v); }
    @Override public void glUniform2fv(int location, int count, float[] v, int offset) { gl.uniform2fv(loc(location), java.util.Arrays.copyOfRange(v, offset, offset + count * 2)); }
    @Override public void glUniform2iv(int location, int count, IntBuffer v) { gl.uniform2iv(loc(location), v); }
    @Override public void glUniform2iv(int location, int count, int[] v, int offset) { gl.uniform2iv(loc(location), java.util.Arrays.copyOfRange(v, offset, offset + count * 2)); }
    @Override public void glUniform3fv(int location, int count, FloatBuffer v) { gl.uniform3fv(loc(location), v); }
    @Override public void glUniform3fv(int location, int count, float[] v, int offset) { gl.uniform3fv(loc(location), java.util.Arrays.copyOfRange(v, offset, offset + count * 3)); }
    @Override public void glUniform3iv(int location, int count, IntBuffer v) { gl.uniform3iv(loc(location), v); }
    @Override public void glUniform3iv(int location, int count, int[] v, int offset) { gl.uniform3iv(loc(location), java.util.Arrays.copyOfRange(v, offset, offset + count * 3)); }
    @Override public void glUniform4fv(int location, int count, FloatBuffer v) { gl.uniform4fv(loc(location), v); }
    @Override public void glUniform4fv(int location, int count, float[] v, int offset) { gl.uniform4fv(loc(location), java.util.Arrays.copyOfRange(v, offset, offset + count * 4)); }
    @Override public void glUniform4iv(int location, int count, IntBuffer v) { gl.uniform4iv(loc(location), v); }
    @Override public void glUniform4iv(int location, int count, int[] v, int offset) { gl.uniform4iv(loc(location), java.util.Arrays.copyOfRange(v, offset, offset + count * 4)); }
    @Override public void glUniformMatrix2fv(int location, int count, boolean transpose, FloatBuffer value) { gl.uniformMatrix2fv(loc(location), transpose, value); }
    @Override public void glUniformMatrix2fv(int location, int count, boolean transpose, float[] value, int offset) { gl.uniformMatrix2fv(loc(location), transpose, java.util.Arrays.copyOfRange(value, offset, offset + count * 4)); }
    @Override public void glUniformMatrix3fv(int location, int count, boolean transpose, FloatBuffer value) { gl.uniformMatrix3fv(loc(location), transpose, value); }
    @Override public void glUniformMatrix3fv(int location, int count, boolean transpose, float[] value, int offset) { gl.uniformMatrix3fv(loc(location), transpose, java.util.Arrays.copyOfRange(value, offset, offset + count * 9)); }
    @Override public void glUniformMatrix4fv(int location, int count, boolean transpose, FloatBuffer value) { gl.uniformMatrix4fv(loc(location), transpose, value); }
    @Override public void glUniformMatrix4fv(int location, int count, boolean transpose, float[] value, int offset) { gl.uniformMatrix4fv(loc(location), transpose, java.util.Arrays.copyOfRange(value, offset, offset + count * 16)); }
    @Override public void glVertexAttrib1f(int indx, float x) { gl.vertexAttrib1f(indx, x); }
    @Override public void glVertexAttrib1fv(int indx, FloatBuffer values) { gl.vertexAttrib1fv(indx, values); }
    @Override public void glVertexAttrib2f(int indx, float x, float y) { gl.vertexAttrib2f(indx, x, y); }
    @Override public void glVertexAttrib2fv(int indx, FloatBuffer values) { gl.vertexAttrib2fv(indx, values); }
    @Override public void glVertexAttrib3f(int indx, float x, float y, float z) { gl.vertexAttrib3f(indx, x, y, z); }
    @Override public void glVertexAttrib3fv(int indx, FloatBuffer values) { gl.vertexAttrib3fv(indx, values); }
    @Override public void glVertexAttrib4f(int indx, float x, float y, float z, float w) { gl.vertexAttrib4f(indx, x, y, z, w); }
    @Override public void glVertexAttrib4fv(int indx, FloatBuffer values) { gl.vertexAttrib4fv(indx, values); }
}