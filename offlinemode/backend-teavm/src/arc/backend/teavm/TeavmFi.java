package arc.backend.teavm;

import arc.Files.FileType;
import arc.files.Fi;
import arc.util.ArcRuntimeException;

import java.io.*;
import java.util.List;

/**
 * Fi implementation for the web backend.
 *
 * - FileType.local / external / absolute -> IdbVfs (writable, persisted).
 *   These three are treated identically here (no real distinction between
 *   "SD card" vs "app-private" vs "absolute path" in a browser) -- all keyed
 *   by path() in one flat IndexedDB-backed namespace.
 * - FileType.internal / classpath -> read-only. Served from WebAssets
 *   (Mindustry's asset tree, prefetched over HTTP into memory at boot --
 *   see WebAssets.java for why TeaVM's own classpath resources can't be
 *   used for binary data), falling back to TeaVM's classpath resources for
 *   small text files embedded at compile time. Write/delete/mkdirs on
 *   these throw, matching what Fi already documents for classpath/internal
 *   on other backends.
 *
 * Requires the arc-core Fi.java patch (see /fi-patch.diff) so child()/
 * sibling()/parent() return TeavmFi instances instead of reverting to
 * plain java.io.File-backed Fi.
 */
public class TeavmFi extends Fi {
    protected TeavmFi(File file, FileType type) {
        super(file, type);
    }

    public TeavmFi(String path, FileType type) {
        super(new File(path), type);
    }

    @Override
    protected Fi instance(File file, FileType type) {
        return new TeavmFi(file, type);
    }

    private boolean writable() {
        return type == FileType.local || type == FileType.external || type == FileType.absolute;
    }

    // ---- reads ----

    @Override
    public byte[] readBytes() {
        if (writable()) {
            byte[] data = IdbVfs.read(path());
            if (data == null) throw new ArcRuntimeException("File not found: " + this);
            return data;
        }
        byte[] asset = WebAssets.get(path());
        if (asset != null) return asset;
        return readClasspathBytes(path());
    }

    @Override
    public InputStream read() {
        return new ByteArrayInputStream(readBytes());
    }

    private static byte[] readClasspathBytes(String path) {
        try (InputStream in = TeavmFi.class.getClassLoader().getResourceAsStream(path)) {
            if (in == null) throw new ArcRuntimeException("Resource not found: " + path);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } catch (IOException e) {
            throw new ArcRuntimeException("Error reading resource: " + path, e);
        }
    }

    // ---- writes ----

    @Override
    public void writeBytes(byte[] bytes) {
        writeBytes(bytes, false);
    }

    @Override
    public void writeBytes(byte[] bytes, boolean append) {
        if (!writable()) throw new ArcRuntimeException("Cannot write to a classpath/internal file: " + this);
        if (append) {
            byte[] existing = IdbVfs.read(path());
            if (existing != null) {
                byte[] combined = new byte[existing.length + bytes.length];
                System.arraycopy(existing, 0, combined, 0, existing.length);
                System.arraycopy(bytes, 0, combined, existing.length, bytes.length);
                bytes = combined;
            }
        }
        IdbVfs.write(path(), bytes);
    }

    @Override
    public OutputStream write() {
        return write(false);
    }

    @Override
    public OutputStream write(boolean append) {
        if (!writable()) throw new ArcRuntimeException("Cannot write to a classpath/internal file: " + this);
        // Buffer in memory, flush to IdbVfs on close() -- Fi's OutputStream
        // contract doesn't require streaming writes, and nothing in Mindustry's
        // save/schematic export path needs a file bigger than fits in memory.
        byte[] prefix = append ? IdbVfs.read(path()) : null;
        return new ByteArrayOutputStream() {
            @Override
            public void close() throws IOException {
                super.close();
                byte[] written = toByteArray();
                if (prefix != null) {
                    byte[] combined = new byte[prefix.length + written.length];
                    System.arraycopy(prefix, 0, combined, 0, prefix.length);
                    System.arraycopy(written, 0, combined, prefix.length, written.length);
                    written = combined;
                }
                IdbVfs.write(path(), written);
            }
        };
    }

    @Override
    public java.io.Writer writer(boolean append, String charset){
        // Base Fi.writer() constructs a FileOutputStream directly, bypassing
        // the overridden write(boolean) -- without this override every
        // writeString() call would land on TeaVM's unimplemented disk File
        // API and fail with FileNotFoundException. Same buffering approach
        // as write(boolean): bytes accumulate in memory and reach IdbVfs on
        // close().
        if (!writable()) throw new ArcRuntimeException("Cannot write to a classpath/internal file: " + this);
        byte[] prefix = append ? IdbVfs.read(path()) : null;
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream() {
            @Override
            public void close() throws IOException {
                super.close();
                byte[] written = toByteArray();
                if (prefix != null) {
                    byte[] combined = new byte[prefix.length + written.length];
                    System.arraycopy(prefix, 0, combined, 0, prefix.length);
                    System.arraycopy(written, 0, combined, prefix.length, written.length);
                    written = combined;
                }
                IdbVfs.write(path(), written);
            }
        };
        try{
            return charset == null
                ? new java.io.OutputStreamWriter(out)
                : new java.io.OutputStreamWriter(out, charset);
        }catch(UnsupportedEncodingException e){
            throw new ArcRuntimeException("Unsupported charset: " + charset, e);
        }
    }

    // ---- metadata / directory ops ----

    @Override
    public boolean exists() {
        if (!writable()) {
            if (WebAssets.hasEntry(path())) return true;
            // TeaVM's classlib has getResourceAsStream but not
            // ClassLoader.getResource (URL-returning) -- probing the stream is
            // the portable form.
            try (InputStream in = TeavmFi.class.getClassLoader().getResourceAsStream(path())) {
                return in != null;
            } catch (IOException e) {
                return false;
            }
        }
        return IdbVfs.exists(path());
    }

    @Override
    public boolean isDirectory() {
        return writable() && IdbVfs.isDirectory(path());
    }

    @Override
    public boolean mkdirs() {
        if (!writable()) throw new ArcRuntimeException("Cannot mkdirs a classpath/internal file: " + this);
        // IdbVfs has no explicit directory records -- directories exist
        // implicitly wherever a file path is nested under them (see
        // IdbVfs.isDirectory). Nothing to create eagerly; treat as success,
        // matching how most virtual filesystems handle mkdir on an
        // already-implicit path.
        return true;
    }

    @Override
    public boolean delete() {
        if (!writable()) return false;
        boolean existed = IdbVfs.exists(path());
        IdbVfs.delete(path());
        return existed;
    }

    @Override
    public boolean deleteDirectory() {
        if (!writable()) return false;
        IdbVfs.deleteDirectory(path());
        return true;
    }

    @Override
    public long length() {
        if (!writable()) {
            byte[] asset = WebAssets.get(path());
            if (asset != null) return asset.length;
            return readClasspathBytes(path()).length;
        }
        byte[] data = IdbVfs.read(path());
        return data != null ? data.length : 0;
    }

    @Override
    public long lastModified() {
        // Not tracked -- IdbVfs doesn't store mtimes. Used by Mindustry mainly
        // to sort/compare save files; returning 0 means "unknown" rather than
        // wrong, but sorting by recency won't work until this is added
        // (would just mean storing a second `path+"\u0000mtime"` entry).
        return 0;
    }

    @Override
    public Fi[] list() {
        if (!writable()) {
            // Internal directory listings come from the asset manifest --
            // there is no listing facility for TeaVM classpath resources.
            arc.struct.Seq<String> children = WebAssets.listFiles(path());
            Fi[] result = new Fi[children.size];
            for (int i = 0; i < children.size; i++) result[i] = child(children.get(i));
            return result;
        }
        List<String> children = IdbVfs.list(path());
        Fi[] result = new Fi[children.size()];
        for (int i = 0; i < children.size(); i++) result[i] = child(children.get(i));
        return result;
    }

    // ---- async helper used by Soloud.streamLoadFile ----

    public interface BytesCallback { void onBytes(byte[] bytes); }
    public interface ErrorCallback { void onError(Exception e); }

    /**
     * Resolves a raw path string to bytes the same way TeavmFi does, but
     * async-flavored for Soloud's streamLoadFile (see Soloud.java's class
     * doc). IdbVfs reads are actually synchronous once booted (in-memory
     * cache), so those and already-prefetched assets resolve immediately;
     * anything else (music) is fetched over HTTP. Kept as its own method so
     * Soloud doesn't need to know FileType at all, only a path string.
     */
    public static void readBytesAsync(String path, BytesCallback onBytes, ErrorCallback onError) {
        String clean = path.startsWith("/") ? path.substring(1) : path;
        try {
            byte[] data = IdbVfs.read(clean);
            if (data == null) data = WebAssets.get(clean);
            if (data != null) {
                onBytes.onBytes(data);
                return;
            }
        } catch (Exception e) {
            onError.onError(e);
            return;
        }
        WebAssets.fetchBytes(clean, bytes -> {
            if (bytes != null) {
                onBytes.onBytes(bytes);
            } else {
                onError.onError(new ArcRuntimeException("Failed to fetch: " + path));
            }
        });
    }
}
