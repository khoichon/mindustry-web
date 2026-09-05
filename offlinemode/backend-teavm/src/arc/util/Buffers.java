package arc.util;

import arc.struct.Seq;

import java.nio.*;
import java.util.IdentityHashMap;
import java.util.Map;

/**
 * WEB REPLACEMENT for arc-core's native Buffers.java.
 *
 * Same package, same class name, same public method signatures as the
 * original -- every `copy(...)` overload and the `newXBuffer`/unsafe-buffer
 * bookkeeping methods are byte-for-byte identical to upstream. Only the five
 * private `native` methods at the bottom (freeMemory/newDisposableByteBuffer/
 * getBufferAddress/clear/copyJni×5) are reimplemented, since those are JNI
 * memcpy calls with no software fallback in the original -- unlike Pixmap's
 * natives, these are on Mindustry's actual per-frame vertex/index upload
 * path, so this had to be a real implementation, not a stub.
 *
 * DESIGN: the original's copyJni methods do raw byte-level memcpy against a
 * `Buffer` regardless of its element type (dst/src offsets and lengths are
 * always in bytes, per the `positionInBytes()`/`elementShift()` helpers
 * below, unchanged from upstream). Plain java.nio has no portable way to
 * reinterpret an arbitrary typed Buffer (FloatBuffer, ShortBuffer, ...) as
 * raw bytes -- a type-erased Buffer doesn't expose its backing ByteBuffer.
 * So: newFloatBuffer/newShortBuffer/newIntBuffer (below) now additionally
 * record the parent ByteBuffer each returned view was created from, in
 * `parents`. copyJni resolves a Buffer to its byte-level view via that map
 * (or the buffer itself, if it's already a ByteBuffer), then does the copy
 * as a sequence of typed relative puts on a `.duplicate()` of that view --
 * duplicate() shares the same backing memory but has an independent
 * position/limit, so this never disturbs whatever position/limit the
 * caller was separately tracking on `dst` itself.
 *
 * SCOPE LIMIT, stated plainly: this only works for Buffers created via this
 * class's own newFloatBuffer/newShortBuffer/newByteBuffer/newIntBuffer
 * factories (which the class's own javadoc already treats as the supported
 * path). A FloatBuffer manufactured some other way (e.g. calling
 * ByteBuffer.allocateDirect(...).asFloatBuffer() directly, bypassing this
 * class) won't be in `parents` and copyJni will throw a clear error rather
 * than silently doing nothing -- if that turns out to happen anywhere in
 * Mindustry's actual code, the fix is adding that call site's buffer to
 * `parents` too, not a redesign.
 *
 * Perf note: this is a per-element loop instead of a native memcpy, so it's
 * slower than upstream -- correctness first pass. If vertex upload shows up
 * as a bottleneck later, the loop bodies below are the place to optimize
 * (e.g. bulk `put(float[], offset, length)` where src is contiguous and no
 * byte-offset misalignment is in play).
 */
public final class Buffers {
    static final Seq<ByteBuffer> unsafeBuffers = new Seq<>();
    static int allocatedUnsafe = 0;

    private static final Map<Buffer, ByteBuffer> parents = new IdentityHashMap<>();

    public static void copy(float[] src, Buffer dst, int numFloats, int offset) {
        if (dst instanceof ByteBuffer)
            dst.limit(numFloats << 2);
        else if (dst instanceof FloatBuffer) dst.limit(numFloats);

        copyJni(src, dst, numFloats, offset);
        dst.position(0);
    }

    public static void copy(byte[] src, int srcOffset, Buffer dst, int numElements) {
        dst.limit(dst.position() + bytesToElements(dst, numElements));
        copyJni(src, srcOffset, dst, positionInBytes(dst), numElements);
    }

    public static void copy(short[] src, int srcOffset, Buffer dst, int numElements) {
        dst.limit(dst.position() + bytesToElements(dst, numElements << 1));
        copyJni(src, srcOffset, dst, positionInBytes(dst), numElements << 1);
    }

    public static void copy(float[] src, int srcOffset, int numElements, Buffer dst) {
        copyJni(src, srcOffset, dst, positionInBytes(dst), numElements << 2);
    }

    public static void copy(int[] src, int srcOffset, Buffer dst, int numElements) {
        dst.limit(dst.position() + bytesToElements(dst, numElements << 2));
        copyJni(src, srcOffset, dst, positionInBytes(dst), numElements << 2);
    }

    public static void copy(float[] src, int srcOffset, Buffer dst, int numElements) {
        dst.limit(dst.position() + bytesToElements(dst, numElements << 2));
        copyJni(src, srcOffset, dst, positionInBytes(dst), numElements << 2);
    }

    public static void copy(Buffer src, Buffer dst, int numElements) {
        int numBytes = elementsToBytes(src, numElements);
        dst.limit(dst.position() + bytesToElements(dst, numBytes));
        copyJni(src, positionInBytes(src), dst, positionInBytes(dst), numBytes);
    }

    private static int positionInBytes(Buffer dst) {
        return dst.position() << elementShift(dst);
    }

    private static int bytesToElements(Buffer dst, int bytes) {
        return bytes >>> elementShift(dst);
    }

    private static int elementsToBytes(Buffer dst, int elements) {
        return elements << elementShift(dst);
    }

    private static int elementShift(Buffer dst) {
        if (dst instanceof ByteBuffer)
            return 0;
        else if (dst instanceof ShortBuffer || dst instanceof CharBuffer)
            return 1;
        else if (dst instanceof IntBuffer)
            return 2;
        else if (dst instanceof LongBuffer)
            return 3;
        else if (dst instanceof FloatBuffer)
            return 2;
        else if (dst instanceof DoubleBuffer)
            return 3;
        else
            throw new ArcRuntimeException("Can't copy to a " + dst.getClass().getName() + " instance");
    }


    public static FloatBuffer newFloatBuffer(int numFloats) {
        ByteBuffer buffer = ByteBuffer.allocateDirect(numFloats * 4);
        buffer.order(ByteOrder.nativeOrder());
        FloatBuffer view = buffer.asFloatBuffer();
        parents.put(view, buffer);
        return view;
    }

    public static ShortBuffer newShortBuffer(int numShorts) {
        ByteBuffer buffer = ByteBuffer.allocateDirect(numShorts * 2);
        buffer.order(ByteOrder.nativeOrder());
        ShortBuffer view = buffer.asShortBuffer();
        parents.put(view, buffer);
        return view;
    }

    public static ByteBuffer newByteBuffer(int numBytes) {
        ByteBuffer buffer = ByteBuffer.allocateDirect(numBytes);
        buffer.order(ByteOrder.nativeOrder());
        return buffer;
    }

    public static IntBuffer newIntBuffer(int numInts) {
        ByteBuffer buffer = ByteBuffer.allocateDirect(numInts * 4);
        buffer.order(ByteOrder.nativeOrder());
        IntBuffer view = buffer.asIntBuffer();
        parents.put(view, buffer);
        return view;
    }

    public static void disposeUnsafeByteBuffer(ByteBuffer buffer) {
        int size = buffer.capacity();
        synchronized (unsafeBuffers) {
            if (!unsafeBuffers.remove(buffer, true))
                throw new IllegalArgumentException("buffer not allocated with newUnsafeByteBuffer or already disposed");
        }
        allocatedUnsafe -= size;
        freeMemory(buffer);
    }

    public static boolean isUnsafeByteBuffer(ByteBuffer buffer) {
        synchronized (unsafeBuffers) {
            return unsafeBuffers.contains(buffer, true);
        }
    }

    public static ByteBuffer newUnsafeByteBuffer(int numBytes) {
        ByteBuffer buffer = newDisposableByteBuffer(numBytes);
        buffer.order(ByteOrder.nativeOrder());
        allocatedUnsafe += numBytes;
        synchronized (unsafeBuffers) {
            unsafeBuffers.add(buffer);
        }
        return buffer;
    }

    public static long getUnsafeBufferAddress(Buffer buffer) {
        return getBufferAddress(buffer) + buffer.position();
    }

    public static ByteBuffer newUnsafeByteBuffer(ByteBuffer buffer) {
        allocatedUnsafe += buffer.capacity();
        synchronized (unsafeBuffers) {
            unsafeBuffers.add(buffer);
        }
        return buffer;
    }

    public static int getAllocatedBytesUnsafe() {
        return allocatedUnsafe;
    }

    // ---- reimplementations of the five native methods (see class doc) ----

    /** Resolves any Buffer this class knows about to its byte-level ByteBuffer view. */
    private static ByteBuffer byteView(Buffer buf) {
        if (buf instanceof ByteBuffer) return (ByteBuffer) buf;
        ByteBuffer parent = parents.get(buf);
        if (parent == null) {
            throw new ArcRuntimeException(
                "Buffer " + buf.getClass().getSimpleName() + " was not created via Buffers.newFloatBuffer/" +
                "newShortBuffer/newIntBuffer -- its byte-level view is unknown. See Buffers.java's class doc " +
                "'SCOPE LIMIT' note.");
        }
        return parent;
    }

    private static void freeMemory(ByteBuffer buffer) {
        // No manual free needed -- TeaVM's direct buffers are backed by a JS
        // ArrayBuffer, reclaimed by the garbage collector like anything else.
    }

    private static ByteBuffer newDisposableByteBuffer(int numBytes) {
        return ByteBuffer.allocateDirect(numBytes);
    }

    private static long getBufferAddress(Buffer buffer) {
        // No real memory address exists in a browser. This is only meaningful
        // as an opaque per-buffer identity today (nothing does real pointer
        // arithmetic with it once compiled for the web, since every native/JNI
        // code path is excluded from this build) -- flagged here rather than
        // silently assumed, in case some call site turns out to need a real
        // address after all.
        return System.identityHashCode(buffer);
    }

    private static void clear(ByteBuffer buffer, int numBytes) {
        ByteBuffer scratch = buffer.duplicate();
        scratch.order(buffer.order());
        scratch.clear();
        for (int i = 0; i < numBytes; i++) scratch.put(i, (byte) 0);
    }

    private static void copyJni(float[] src, Buffer dst, int numFloats, int offset) {
        ByteBuffer scratch = byteView(dst).duplicate();
        scratch.order(byteView(dst).order());
        scratch.clear();
        for (int i = 0; i < numFloats; i++) scratch.putFloat(i * 4, src[offset + i]);
    }

    private static void copyJni(byte[] src, int srcOffset, Buffer dst, int dstOffset, int numBytes) {
        ByteBuffer scratch = byteView(dst).duplicate();
        scratch.order(byteView(dst).order());
        scratch.clear();
        scratch.position(dstOffset);
        scratch.put(src, srcOffset, numBytes);
    }

    private static void copyJni(short[] src, int srcOffset, Buffer dst, int dstOffset, int numBytes) {
        ByteBuffer scratch = byteView(dst).duplicate();
        scratch.order(byteView(dst).order());
        scratch.clear();
        int count = numBytes >>> 1;
        for (int i = 0; i < count; i++) scratch.putShort(dstOffset + i * 2, src[srcOffset + i]);
    }

    private static void copyJni(int[] src, int srcOffset, Buffer dst, int dstOffset, int numBytes) {
        ByteBuffer scratch = byteView(dst).duplicate();
        scratch.order(byteView(dst).order());
        scratch.clear();
        int count = numBytes >>> 2;
        for (int i = 0; i < count; i++) scratch.putInt(dstOffset + i * 4, src[srcOffset + i]);
    }

    private static void copyJni(float[] src, int srcOffset, Buffer dst, int dstOffset, int numBytes) {
        ByteBuffer scratch = byteView(dst).duplicate();
        scratch.order(byteView(dst).order());
        scratch.clear();
        int count = numBytes >>> 2;
        for (int i = 0; i < count; i++) scratch.putFloat(dstOffset + i * 4, src[srcOffset + i]);
    }

    public static void copyJni(Buffer src, int srcOffset, Buffer dst, int dstOffset, int numBytes) {
        ByteBuffer srcView = byteView(src).duplicate();
        srcView.order(byteView(src).order());
        srcView.clear();
        ByteBuffer dstView = byteView(dst).duplicate();
        dstView.order(byteView(dst).order());
        dstView.clear();

        byte[] tmp = new byte[numBytes];
        srcView.position(srcOffset);
        srcView.get(tmp);
        dstView.position(dstOffset);
        dstView.put(tmp);
    }
}
