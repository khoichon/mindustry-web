package arc.util;

import java.nio.Buffer;

/**
 * WEB REPLACEMENT for arc-core's UnsafeBuffers.
 *
 * The real UnsafeBuffers isn't part of arc-core/src at all -- it's compiled
 * separately (from arc-core/unsafe/UnsafeBuffers.java) into a standalone
 * unsafe.jar and added as a compileOnly dependency by arc-core's own
 * build.gradle, which we don't evaluate (see settings.gradle). Since
 * Pixmap.java references UnsafeBuffers.checkInit()/.failed/.copy() directly,
 * something with that name needs to exist for arc-core/src to compile at all.
 *
 * This mirrors exactly the fallback the real UnsafeBuffers already documents
 * for platforms without sun.misc.Unsafe (Android/iOS, per its own comments):
 * checkInit() sets failed=true and every call site in Pixmap.java already
 * checks `!UnsafeBuffers.failed` before using it, falling back to a plain
 * ByteBuffer copy otherwise. TeaVM has no sun.misc.Unsafe at all, so this
 * is the correct behavior here, not a workaround.
 */
public class UnsafeBuffers {
    public static boolean failed = true, initialized = true;

    public static void checkInit() {
        // Already "initialized" with failed=true above -- nothing to do.
    }

    public static void copy(Buffer src, int srcPos, Buffer dst, int dstPos, int length) {
        throw new UnsupportedOperationException(
            "UnsafeBuffers.copy is never reachable on the web backend (failed=true, callers already check this).");
    }
}
