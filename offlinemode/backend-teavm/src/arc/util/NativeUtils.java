package arc.util;

/**
 * WEB REPLACEMENT for arc-core's native NativeUtils.java.
 *
 * The original's three native methods (setEnv/unsetEnv/getEnv, wrapping
 * POSIX setenv/unsetenv/getenv) are only ever called from forceUtf8Locale(),
 * which itself is guarded by `if(!OS.isLinux) return;` -- so on every
 * platform except desktop Linux this was already a no-op at runtime. This
 * replacement keeps that exact behavior (there is no "Linux" in a browser)
 * without declaring any native methods, since TeaVM can't compile an
 * unresolved native method the way a real JVM/JNI toolchain can.
 */
public class NativeUtils {
    public static int setEnv(String name, String value, boolean overwrite) {
        return -1;
    }

    public static int unsetEnv(String name) {
        return -1;
    }

    public static String getEnv(String name) {
        return "";
    }

    public static void forceUtf8Locale() {
        // OS.isLinux is never true under TeaVM; nothing to do.
    }
}
