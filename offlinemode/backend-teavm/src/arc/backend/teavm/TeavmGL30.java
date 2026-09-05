package arc.backend.teavm;

import arc.graphics.GL30;
import org.teavm.jso.webgl.*;

import java.nio.Buffer;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;
import java.nio.LongBuffer;
import java.util.HashMap;
import java.util.Map;

/**
 * GL30 implemented against the same WebGL2 context as TeavmGL20.
 *
 * This is what unlocks Arc's real renderer path: Mesh checks
 * `Core.gl30 != null` to decide between the legacy client-side-array
 * VertexArray (which WebGL has no equivalent for, at all) and
 * VertexBufferObjectWithVAO + IndexBufferObject -- i.e. every desktop
 * Mindustry build's rendering route. WebGL2 carries VAOs, instanced draws,
 * integer vertex attributes and multiple render targets as core features, so
 * nearly all of GL30's surface maps 1:1.
 *
 * Implemented: everything Mesh/VertexBufferObjectWithVAO/GLFrameBuffer/
 * instanced-rendering call sites touch. The rest throws
 * UnsupportedOperationException naming the method -- transform feedback and
 * UBO introspection have no Mindustry call sites and some have no WebGL2
 * equivalent either; TeaVM's reachability analysis means unimplemented stubs
 * cost nothing at runtime unless actually called.
 */
public class TeavmGL30 extends TeavmGL20 implements GL30 {
    private final Map<Integer, WebGLVertexArrayObject> vaos = new HashMap<>();
    private final Map<Integer, WebGLSampler> samplers = new HashMap<>();
    private final Map<Integer, WebGLQuery> queries = new HashMap<>();

    public TeavmGL30(WebGLRenderingContext gl) {
        super(gl);
    }

    private static UnsupportedOperationException unsupported(String method) {
        return new UnsupportedOperationException("GL30 method " + method + " is not implemented in the TeaVM backend.");
    }

    // ---- vertex array objects (the whole point of this class) ----

    @Override public void glGenVertexArrays(int n, IntBuffer arrays) {
        // Desktop GL writes generated handles at the buffer's current
        // position WITHOUT advancing it (callers do clear(); glGen*(); get()).
        // A relative put here advances position and breaks that idiom with a
        // BufferUnderflowException on the following relative get.
        for (int i = 0; i < n; i++) {
            int handle = nextHandle++;
            vaos.put(handle, gl.createVertexArray());
            arrays.put(arrays.position() + i, handle);
        }
    }

    @Override public void glBindVertexArray(int array) {
        gl.bindVertexArray(array == 0 ? null : vaos.get(array));
    }

    @Override public void glDeleteVertexArrays(int n, IntBuffer arrays) {
        for (int i = 0; i < n; i++) {
            int handle = arrays.get(arrays.position() + i);
            WebGLVertexArrayObject vao = vaos.remove(handle);
            if (vao != null) gl.deleteVertexArray(vao);
        }
    }

    @Override public boolean glIsVertexArray(int array) {
        WebGLVertexArrayObject vao = vaos.get(array);
        return vao != null && gl.isVertexArray(vao);
    }

    // ---- instanced rendering ----

    @Override public void glDrawArraysInstanced(int mode, int first, int count, int instanceCount) { gl.drawArraysInstanced(mode, first, count, instanceCount); }
    @Override public void glDrawElementsInstanced(int mode, int count, int type, int indicesOffset, int instanceCount) { gl.drawElementsInstanced(mode, count, type, indicesOffset, instanceCount); }
    @Override public void glVertexAttribDivisor(int index, int divisor) { gl.vertexAttribDivisor(index, divisor); }
    @Override public void glVertexAttribIPointer(int index, int size, int type, int stride, int offset) { gl.vertexAttribIPointer(index, size, type, stride, offset); }
    @Override public void glVertexAttribI4i(int index, int x, int y, int z, int w) { gl.vertexAttribI4i(index, x, y, z, w); }
    @Override public void glVertexAttribI4ui(int index, int x, int y, int z, int w) { gl.vertexAttribI4ui(index, x, y, z, w); }

    // ---- multiple render targets / framebuffers ----

    @Override public void glDrawBuffers(int n, IntBuffer bufs) {
        int[] targets = new int[n];
        for (int i = 0; i < n; i++) targets[i] = bufs.get(bufs.position() + i);
        gl.drawBuffers(targets);
    }

    @Override public void glReadBuffer(int mode) { gl.readBuffer(mode); }

    @Override public void glBlitFramebuffer(int srcX0, int srcY0, int srcX1, int srcY1, int dstX0, int dstY0, int dstX1, int dstY1, int mask, int filter) {
        gl.blitFramebuffer(srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1, dstY1, mask, filter);
    }

    @Override public void glRenderbufferStorageMultisample(int target, int samples, int internalformat, int width, int height) {
        gl.renderbufferStorageMultisample(target, samples, internalformat, width, height);
    }

    @Override public void glFramebufferTextureLayer(int target, int attachment, int texture, int level, int layer) {
        gl.framebufferTextureLayer(target, attachment, textures.get(texture), level, layer);
    }

    // ---- 3D textures / texture storage ----

    @Override public void glTexImage3D(int target, int level, int internalformat, int width, int height, int depth, int border, int format, int type, Buffer pixels) {
        if (pixels == null) {
            gl.texImage3D(target, level, internalformat, width, height, depth, border, format, type, (org.teavm.jso.typedarrays.ArrayBufferView) null);
        } else {
            // pixelView: TeaVM's Buffer bridge yields Int8Array, which WebGL
            // rejects for UNSIGNED_BYTE pixel data (see TeavmGL20.pixelView).
            gl.texImage3D(target, level, internalformat, width, height, depth, border, format, type, TeavmGL20.pixelView(pixels));
        }
    }

    @Override public void glTexImage3D(int target, int level, int internalformat, int width, int height, int depth, int border, int format, int type, int offset) {
        gl.texImage3D(target, level, internalformat, width, height, depth, border, format, type, offset);
    }

    @Override public void glTexSubImage3D(int target, int level, int xoffset, int yoffset, int zoffset, int width, int height, int depth, int format, int type, Buffer pixels) {
        gl.texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, TeavmGL20.pixelView(pixels));
    }

    @Override public void glTexSubImage3D(int target, int level, int xoffset, int yoffset, int zoffset, int width, int height, int depth, int format, int type, int offset) {
        gl.texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, offset);
    }

    @Override public void glCopyTexSubImage3D(int target, int level, int xoffset, int yoffset, int zoffset, int x, int y, int width, int height) {
        gl.copyTexSubImage3D(target, level, xoffset, yoffset, zoffset, x, y, width, height);
    }

    // ---- buffer copies / clears ----

    @Override public void glCopyBufferSubData(int readTarget, int writeTarget, int readOffset, int writeOffset, int size) {
        gl.copyBufferSubData(readTarget, writeTarget, readOffset, writeOffset, size);
    }

    @Override public void glClearBufferiv(int buffer, int drawbuffer, IntBuffer value) { gl.clearBufferiv(buffer, drawbuffer, toArray(value)); }
    @Override public void glClearBufferuiv(int buffer, int drawbuffer, IntBuffer value) { throw unsupported("glClearBufferuiv"); }
    @Override public void glClearBufferfv(int buffer, int drawbuffer, FloatBuffer value) { gl.clearBufferfv(buffer, drawbuffer, toFloatArray(value)); }
    @Override public void glClearBufferfi(int buffer, int drawbuffer, float depth, int stencil) { gl.clearBufferfi(buffer, drawbuffer, depth, stencil); }

    private static int[] toArray(IntBuffer b) {
        int[] out = new int[b.remaining()];
        for (int i = 0; i < out.length; i++) out[i] = b.get(b.position() + i);
        return out;
    }

    private static float[] toFloatArray(FloatBuffer b) {
        float[] out = new float[b.remaining()];
        for (int i = 0; i < out.length; i++) out[i] = b.get(b.position() + i);
        return out;
    }

    // ---- integer uniforms / attribute queries ----

    @Override public void glUniform1uiv(int location, int count, IntBuffer value) { throw unsupported("glUniform1uiv"); }
    @Override public void glUniform3uiv(int location, int count, IntBuffer value) { throw unsupported("glUniform3uiv"); }
    @Override public void glUniform4uiv(int location, int count, IntBuffer value) { throw unsupported("glUniform4uiv"); }

    // ---- 64-bit queries (JS numbers hold the value fine) ----

    @Override public void glGetInteger64v(int pname, LongBuffer params) {
        params.put(0, gl.getParameteri(pname));
    }

    @Override public void glGetBufferParameteri64v(int target, int pname, LongBuffer params) { throw unsupported("glGetBufferParameteri64v"); }


    @Override public int glGetFragDataLocation(int program, String name) {
        return gl.getFragDataLocation(programs.get(program), name);
    }

    // ---- queries (occlusion etc.; Mindustry doesn't use them, but they map) ----

    @Override public void glGenQueries(int n, IntBuffer ids) {
        for (int i = 0; i < n; i++) {
            int handle = nextHandle++;
            queries.put(handle, gl.createQuery());
            ids.put(ids.position() + i, handle);
        }
    }

    @Override public void glDeleteQueries(int n, IntBuffer ids) {
        for (int i = 0; i < n; i++) {
            WebGLQuery q = queries.remove(ids.get(ids.position() + i));
            if (q != null) gl.deleteQuery(q);
        }
    }

    @Override public void glBeginQuery(int target, int id) { gl.beginQuery(target, queries.get(id)); }
    @Override public void glEndQuery(int target) { gl.endQuery(target); }
    @Override public boolean glIsQuery(int id) { WebGLQuery q = queries.get(id); return q != null && gl.isQuery(q); }
    @Override public void glGetQueryiv(int target, int pname, IntBuffer params) { throw unsupported("glGetQueryiv"); }
    @Override public void glGetQueryObjectuiv(int id, int pname, IntBuffer params) { throw unsupported("glGetQueryObjectuiv"); }

    // ---- samplers ----

    @Override public void glGenSamplers(int count, IntBuffer samplersOut) {
        for (int i = 0; i < count; i++) {
            int handle = nextHandle++;
            samplers.put(handle, gl.createSampler());
            samplersOut.put(samplersOut.position() + i, handle);
        }
    }

    @Override public void glDeleteSamplers(int count, IntBuffer samplersIn) {
        for (int i = 0; i < count; i++) {
            WebGLSampler s = samplers.remove(samplersIn.get(samplersIn.position() + i));
            if (s != null) gl.deleteSampler(s);
        }
    }

    @Override public boolean glIsSampler(int sampler) { WebGLSampler s = samplers.get(sampler); return s != null && gl.isSampler(s); }
    @Override public void glBindSampler(int unit, int sampler) { gl.bindSampler(unit, samplers.get(sampler)); }
    @Override public void glSamplerParameteri(int sampler, int pname, int param) { gl.samplerParameteri(samplers.get(sampler), pname, param); }
    @Override public void glSamplerParameterf(int sampler, int pname, float param) { gl.samplerParameterf(samplers.get(sampler), pname, param); }
    @Override public void glSamplerParameteriv(int sampler, int pname, IntBuffer param) { throw unsupported("glSamplerParameteriv"); }
    @Override public void glSamplerParameterfv(int sampler, int pname, FloatBuffer param) { throw unsupported("glSamplerParameterfv"); }
    @Override public void glGetSamplerParameteriv(int sampler, int pname, IntBuffer params) { throw unsupported("glGetSamplerParameteriv"); }
    @Override public void glGetSamplerParameterfv(int sampler, int pname, FloatBuffer params) { throw unsupported("glGetSamplerParameterfv"); }

    // ---- no Mindustry call sites / no WebGL2 equivalent ----

    @Override public void glDrawRangeElements(int mode, int start, int end, int count, int type, Buffer indices) { throw unsupported("glDrawRangeElements"); }
    @Override public void glDrawRangeElements(int mode, int start, int end, int count, int type, int offset) { throw unsupported("glDrawRangeElements"); }
    @Override public void glUniformMatrix2x3fv(int location, int count, boolean transpose, FloatBuffer value) { throw unsupported("glUniformMatrix2x3fv"); }
    @Override public void glUniformMatrix3x2fv(int location, int count, boolean transpose, FloatBuffer value) { throw unsupported("glUniformMatrix3x2fv"); }
    @Override public void glUniformMatrix2x4fv(int location, int count, boolean transpose, FloatBuffer value) { throw unsupported("glUniformMatrix2x4fv"); }
    @Override public void glUniformMatrix4x2fv(int location, int count, boolean transpose, FloatBuffer value) { throw unsupported("glUniformMatrix4x2fv"); }
    @Override public void glUniformMatrix3x4fv(int location, int count, boolean transpose, FloatBuffer value) { throw unsupported("glUniformMatrix3x4fv"); }
    @Override public void glUniformMatrix4x3fv(int location, int count, boolean transpose, FloatBuffer value) { throw unsupported("glUniformMatrix4x3fv"); }
    @Override public boolean glUnmapBuffer(int target) { throw unsupported("glUnmapBuffer"); }
    @Override public void glFlushMappedBufferRange(int target, int offset, int length) { throw unsupported("glFlushMappedBufferRange"); }
    @Override public void glBeginTransformFeedback(int primitiveMode) { throw unsupported("glBeginTransformFeedback"); }
    @Override public void glEndTransformFeedback() { throw unsupported("glEndTransformFeedback"); }
    @Override public void glBindBufferRange(int target, int index, int buffer, int offset, int size) { throw unsupported("glBindBufferRange"); }
    @Override public void glBindBufferBase(int target, int index, int buffer) { throw unsupported("glBindBufferBase"); }
    @Override public void glTransformFeedbackVaryings(int program, String[] varyings, int bufferMode) { throw unsupported("glTransformFeedbackVaryings"); }
    @Override public void glGetVertexAttribIiv(int index, int pname, IntBuffer params) { throw unsupported("glGetVertexAttribIiv"); }
    @Override public void glGetVertexAttribIuiv(int index, int pname, IntBuffer params) { throw unsupported("glGetVertexAttribIuiv"); }
    @Override public void glGetUniformuiv(int program, int location, IntBuffer params) { throw unsupported("glGetUniformuiv"); }
    @Override public String glGetStringi(int name, int index) { throw unsupported("glGetStringi"); }
    @Override public void glGetUniformIndices(int program, String[] uniformNames, IntBuffer uniformIndices) { throw unsupported("glGetUniformIndices"); }
    @Override public void glGetActiveUniformsiv(int program, int uniformCount, IntBuffer uniformIndices, int pname, IntBuffer params) { throw unsupported("glGetActiveUniformsiv"); }
    @Override public int glGetUniformBlockIndex(int program, String uniformBlockName) { throw unsupported("glGetUniformBlockIndex"); }
    @Override public void glGetActiveUniformBlockiv(int program, int uniformBlockIndex, int pname, IntBuffer params) { throw unsupported("glGetActiveUniformBlockiv"); }
    @Override public void glGetActiveUniformBlockName(int program, int uniformBlockIndex, Buffer length, Buffer uniformBlockName) { throw unsupported("glGetActiveUniformBlockName"); }
    @Override public void glUniformBlockBinding(int program, int uniformBlockIndex, int uniformBlockBinding) { throw unsupported("glUniformBlockBinding"); }
    @Override public void glBindTransformFeedback(int target, int id) { throw unsupported("glBindTransformFeedback"); }
    @Override public void glDeleteTransformFeedbacks(int n, IntBuffer ids) { throw unsupported("glDeleteTransformFeedbacks"); }
    @Override public void glGenTransformFeedbacks(int n, IntBuffer ids) { throw unsupported("glGenTransformFeedbacks"); }
    @Override public boolean glIsTransformFeedback(int id) { throw unsupported("glIsTransformFeedback"); }
    @Override public void glPauseTransformFeedback() { throw unsupported("glPauseTransformFeedback"); }
    @Override public void glResumeTransformFeedback() { throw unsupported("glResumeTransformFeedback"); }
    @Override public void glProgramParameteri(int program, int pname, int value) { throw unsupported("glProgramParameteri"); }
    @Override public java.nio.Buffer glGetBufferPointerv(int target, int pname) { throw unsupported("glGetBufferPointerv"); }
    @Override public void glInvalidateFramebuffer(int target, int numAttachments, IntBuffer attachments) { throw unsupported("glInvalidateFramebuffer"); }
    @Override public void glInvalidateSubFramebuffer(int target, int numAttachments, IntBuffer attachments, int x, int y, int width, int height) { throw unsupported("glInvalidateSubFramebuffer"); }
}
