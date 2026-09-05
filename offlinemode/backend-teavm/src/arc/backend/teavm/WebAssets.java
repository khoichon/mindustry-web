package arc.backend.teavm;

import arc.struct.ObjectMap;
import arc.struct.Seq;
import arc.util.Log;
import org.teavm.jso.JSBody;
import org.teavm.jso.JSFunctor;
import org.teavm.jso.JSObject;
import org.teavm.jso.typedarrays.ArrayBuffer;
import org.teavm.jso.typedarrays.Uint8Array;

/**
 * Serves Mindustry's asset tree to the game.
 *
 * TeaVM's built-in classpath resources can't be used for this: its
 * ClassLoader.getResourceAsStream materializes every resource as a String
 * (text), which silently corrupts binary data -- PNGs, the packed sprite
 * atlas, fonts, .msav maps. Instead, the Gradle build extracts the asset
 * tree next to the generated JS as plain static files and writes
 * asset-manifest.txt listing every file.
 *
 * At boot (before ApplicationListener.init, alongside IdbVfs.init) the
 * manifest is fetched and every non-music entry is fetched into an
 * in-memory map -- the game reads assets synchronously, and the browser has
 * no synchronous HTTP, so the only options are "already in memory" or
 * "async"; this makes the former true for everything the game loads
 * synchronously. Music stays out: it loads through Music.load ->
 * streamLoadFile -> TeavmFi.readBytesAsync, which fetches over HTTP and
 * decodes in the background.
 *
 * The manifest also powers TeavmFi.list()/exists() on internal paths --
 * there is no directory listing for TeaVM classpath resources either, so
 * without this, FileTree-style asset folder walks would silently see
 * nothing.
 */
public final class WebAssets{
    /** Paths known to exist (manifest entries, files and directories derived from them). */
    private static final Seq<String> manifest = new Seq<>();
    /** Prefetched file contents. */
    private static final ObjectMap<String, byte[]> files = new ObjectMap<>();

    public static boolean loaded = false;

    private WebAssets(){}

    /** Fetches the manifest, then prefetches every entry. Calls done when ready (or on unrecoverable error, after logging). */
    public static void load(Runnable done){
        // Standalone single-file build: the page carries every asset inline
        // (see :backend-teavm:buildStandalone) and fetch() is typically
        // unavailable anyway (file:// origins block it) -- populate straight
        // from the embedded base64 blob, no server involved.
        if(embeddedCount() > 0){
            int count = embeddedCount();
            for(int i = 0; i < count; i++){
                String path = embeddedKey(i);
                if(!path.isEmpty()) manifest.add(path);
            }
            Log.info("[assets] embedded manifest: @ files", manifest.size);
            for(String path : manifest){
                ArrayBuffer buffer = embeddedBuffer(path);
                if(buffer == null){
                    Log.err("[assets] missing embedded entry '@'", path);
                    continue;
                }
                try{
                    int len = buffer.getByteLength();
                    Uint8Array view = new Uint8Array(buffer);
                    byte[] out = new byte[len];
                    for(int i = 0; i < len; i++) out[i] = (byte)view.get(i);
                    files.put(path, out);
                }catch(Throwable t){
                    Log.err("[assets] error decoding embedded '@'", path);
                }
            }
            loaded = true;
            Log.info("[assets] decoded @ embedded files into memory", files.size);
            done.run();
            return;
        }

        fetchBytes("asset-manifest.txt", data -> {
            if(data == null){
                Log.err("[assets] asset-manifest.txt not found next to the page -- was buildWeb run? Continuing without bundled assets.");
                loaded = true;
                done.run();
                return;
            }

            String text = new String(data, arc.util.Strings.utf8);
            for(String line : text.split("\n")){
                String path = line.trim();
                if(!path.isEmpty()) manifest.add(path);
            }
            Log.info("[assets] manifest: @ files", manifest.size);

            prefetch(0, () -> {
                loaded = true;
                Log.info("[assets] prefetched @ files into memory", files.size);
                done.run();
            });
        });
    }

    private static void prefetch(int index, Runnable done){
        if(index >= manifest.size){
            done.run();
            return;
        }
        String path = manifest.get(index);
        fetchBytes(path, data -> {
            if(data != null){
                files.put(path, data);
            }else{
                Log.err("[assets] failed to prefetch '@'", path);
            }
            prefetch(index + 1, done);
        });
    }

    /** Synchronous read of a prefetched asset; null when absent. */
    public static byte[] get(String path){
        byte[] data = files.get(path);
        if(data != null) return data;

        // Allow callers that hand us a leading slash (absolute-ish paths).
        if(path.startsWith("/")) return files.get(path.substring(1));

        return null;
    }

    /** Async fetch of any served file, cached. Calls back with null on failure. */
    public static void fetchBytes(String path, BytesCallback callback){
        // Embedded (standalone) assets win over any server fetch -- on a
        // file:// page fetch() is blocked outright, and even when it isn't,
        // the inline copy is the one that matches the inlined game code.
        String key = path.startsWith("/") ? path.substring(1) : path;
        if(embeddedCount() > 0){
            ArrayBuffer buffer = embeddedBuffer(key);
            if(buffer != null){
                try{
                    int len = buffer.getByteLength();
                    Uint8Array view = new Uint8Array(buffer);
                    byte[] out = new byte[len];
                    for(int i = 0; i < len; i++) out[i] = (byte)view.get(i);
                    callback.call(out);
                }catch(Throwable t){
                    Log.err("[assets] error decoding embedded '@'", path);
                    callback.call(null);
                }
                return;
            }
            callback.call(null);
            return;
        }

        // Request relative to the page ("./") so the game also works when
        // hosted under a subpath; an absolute "/path" only resolves when the
        // server root IS the game directory.
        String url = "./" + (path.startsWith("/") ? path.substring(1) : path);
        fetchArrayBuffer(url, buffer -> {
            if(buffer == null){
                callback.call(null);
                return;
            }
            try{
                int len = buffer.getByteLength();
                Uint8Array view = new Uint8Array(buffer);
                byte[] out = new byte[len];
                for(int i = 0; i < len; i++) out[i] = (byte)view.get(i);
                callback.call(out);
            }catch(Throwable t){
                Log.err("[assets] error decoding response for '@'", path);
                callback.call(null);
            }
        });
    }

    /** Lists manifest entries under a directory prefix (no trailing slash), as bare file names. */
    public static Seq<String> listFiles(String dir){
        Seq<String> out = new Seq<>();
        String prefix = dir.isEmpty() || dir.endsWith("/") ? dir : dir + "/";
        for(String path : manifest){
            if(path.startsWith(prefix) && !path.equals(prefix)){
                String rest = path.substring(prefix.length());
                if(!rest.isEmpty() && !rest.startsWith(".")) out.add(rest);
            }
        }
        return out;
    }

    /** Whether any manifest entry lives under this directory. */
    public static boolean hasDirectory(String dir){
        String prefix = dir.isEmpty() || dir.endsWith("/") ? dir : dir + "/";
        for(String path : manifest){
            if(path.startsWith(prefix) && path.length() > prefix.length()) return true;
        }
        return false;
    }

    /** Whether a file is known at all -- prefetched or not (music counts). */
    public static boolean hasEntry(String path){
        if(path.startsWith("/")) path = path.substring(1);
        return files.containsKey(path) || manifest.contains(path);
    }

    public interface BytesCallback{
        void call(byte[] data);
    }

    @JSFunctor
    interface ArrayBufferCallback extends JSObject{
        void call(ArrayBuffer buffer);
    }

    @JSBody(params = {"url", "cb"}, script =
        "fetch(url).then(function(r){ if(!r.ok) throw new Error(r.status + ' ' + url); return r.arrayBuffer(); })" +
        ".then(function(b){ cb(b); }).catch(function(e){ console.error('[assets] ' + e); cb(null); });")
    static native void fetchArrayBuffer(String url, ArrayBufferCallback cb);

    // ---- embedded (standalone single-file) asset access ----
    // buildStandalone writes every asset, base64, into
    // globalThis.__MINDUSTRY_EMBEDDED__[path]; these helpers read it back.

    @JSBody(script = "var e = globalThis.__MINDUSTRY_EMBEDDED__; return e ? Object.keys(e).length : 0;")
    static native int embeddedCount();

    @JSBody(params = "i", script = "return Object.keys(globalThis.__MINDUSTRY_EMBEDDED__)[i];")
    static native String embeddedKey(int i);

    /** Decodes the embedded base64 entry to a fresh ArrayBuffer; null when absent. */
    @JSBody(params = "key", script =
        "var e = globalThis.__MINDUSTRY_EMBEDDED__;" +
        "if(!e || !e[key]) return null;" +
        "var bin = atob(e[key]);" +
        "var buf = new ArrayBuffer(bin.length);" +
        "var u8 = new Uint8Array(buf);" +
        "for(var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);" +
        "return buf;")
    static native ArrayBuffer embeddedBuffer(String key);
}
