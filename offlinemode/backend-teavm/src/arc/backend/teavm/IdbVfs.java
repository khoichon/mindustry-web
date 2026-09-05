package arc.backend.teavm;

import org.teavm.jso.core.JSString;
import org.teavm.jso.indexeddb.*;
import org.teavm.jso.typedarrays.Uint8Array;

import java.util.HashMap;
import java.util.Map;
import java.util.TreeSet;

/**
 * A synchronous-looking virtual filesystem backed by IndexedDB, using the
 * standard browser-VFS trick (same one Emscripten's IDBFS uses): keep a full
 * in-memory copy for instant synchronous reads/writes -- because IndexedDB
 * itself is async and TeaVM can't block the JS event loop waiting on it --
 * and mirror every write/delete into IndexedDB in the background so it
 * survives a reload.
 *
 * Tradeoff to be upfront about: this is "eventually consistent" persistence,
 * not durable-on-every-write -- if the tab is killed mid-flush, the very
 * last write(s) can be lost even though the in-memory state (and anything
 * the user saw succeed within that session) was correct. This is the same
 * tradeoff IDBFS makes; there's no way around it without making every save
 * call in Mindustry async, which is a much bigger change.
 *
 * Only backs FileType.local/external/absolute (writable data: settings,
 * saves, schematics, mods). FileType.internal/classpath (read-only bundled
 * game assets) should instead be served from TeaVM-embedded resources --
 * that's a separate, simpler path handled in TeavmFi, not here.
 */
public final class IdbVfs {
    private static final String DB_NAME = "mindustry-fs";
    private static final String STORE_NAME = "files";
    private static final int DB_VERSION = 1;

    private static final Map<String, byte[]> files = new HashMap<>();
    private static final TreeSet<String> knownPaths = new TreeSet<>();
    private static IDBDatabase db;
    private static boolean ready;

    public interface ReadyCallback {
        void onReady();
    }

    /** Call once at boot, before starting the ApplicationListener loop. */
    public static void init(ReadyCallback onReady) {
        IDBFactory factory = IDBFactory.getInstance();
        IDBOpenDBRequest openReq = factory.open(DB_NAME, DB_VERSION);

        openReq.setOnUpgradeNeeded(evt -> {
            IDBDatabase database = openReq.getResult();
            if (!contains(database.getObjectStoreNames(), STORE_NAME)) {
                database.createObjectStore(STORE_NAME);
            }
        });

        openReq.setOnSuccess(() -> {
            db = openReq.getResult();
            loadAll(onReady);
        });

        openReq.setOnError(() -> {
            arc.util.Log.err("[Files] IndexedDB open failed; falling back to in-memory-only (nothing will persist across reloads).");
            ready = true;
            onReady.onReady();
        });
    }

    private static boolean contains(String[] arr, String s) {
        for (String x : arr) if (x.equals(s)) return true;
        return false;
    }

    private static void loadAll(ReadyCallback onReady) {
        IDBTransaction tx = db.transaction(STORE_NAME, IDBDatabase.TRANSACTION_READONLY);
        IDBObjectStore store = tx.objectStore(STORE_NAME);
        IDBCursorRequest cursorReq = store.openCursor();

        cursorReq.setOnSuccess(() -> {
            IDBCursor cursor = cursorReq.getResult();
            if (cursor != null) {
                String path = cursor.getKey().<JSString>cast().stringValue();
                Uint8Array data = cursor.getValue().cast();
                byte[] bytes = new byte[data.getLength()];
                for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) data.get(i);
                files.put(path, bytes);
                knownPaths.add(path);
                cursor.doContinue();
            } else {
                ready = true;
                onReady.onReady();
            }
        });
        cursorReq.setOnError(() -> {
            arc.util.Log.err("[Files] IndexedDB cursor read failed during boot load.");
            ready = true;
            onReady.onReady();
        });
    }

    public static boolean isReady() {
        return ready;
    }

    public static boolean exists(String path) {
        return files.containsKey(path) || isDirectory(path);
    }

    public static boolean isDirectory(String path) {
        String prefix = path.isEmpty() ? "" : path + "/";
        for (String known : knownPaths.tailSet(prefix)) {
            if (!known.startsWith(prefix)) break;
            return true;
        }
        return false;
    }

    public static byte[] read(String path) {
        return files.get(path);
    }

    public static void write(String path, byte[] data) {
        files.put(path, data);
        knownPaths.add(path);
        persist(path, data);
    }

    public static void delete(String path) {
        files.remove(path);
        knownPaths.remove(path);
        persistDelete(path);
    }

    public static void deleteDirectory(String path) {
        String prefix = path.isEmpty() ? "" : path + "/";
        for (String known : new TreeSet<>(knownPaths.tailSet(prefix))) {
            if (!known.startsWith(prefix)) break;
            delete(known);
        }
    }

    /** Immediate children (files and subdirectory names) of a directory path. */
    public static java.util.List<String> list(String path) {
        String prefix = path.isEmpty() ? "" : path + "/";
        java.util.LinkedHashSet<String> children = new java.util.LinkedHashSet<>();
        for (String known : knownPaths.tailSet(prefix)) {
            if (!known.startsWith(prefix)) break;
            String rest = known.substring(prefix.length());
            int slash = rest.indexOf('/');
            children.add(slash < 0 ? rest : rest.substring(0, slash));
        }
        return new java.util.ArrayList<>(children);
    }

    // ---- async background persistence; fire-and-forget by design (see class doc) ----

    /** Persistence transactions queued but not yet committed/failed. */
    private static int pendingWrites;

    /** See TeavmApplication.exit(): the app drains this queue before stopping. */
    public static int pendingWrites() {
        return pendingWrites;
    }

    private static void persist(String path, byte[] data) {
        if (db == null) return;
        Uint8Array arr = Uint8Array.create(data.length);
        for (int i = 0; i < data.length; i++) arr.set(i, (short) (data[i] & 0xFF));
        IDBTransaction tx = db.transaction(STORE_NAME, IDBDatabase.TRANSACTION_READWRITE);
        tx.objectStore(STORE_NAME).put(arr, JSString.valueOf(path));
        pendingWrites++;
        tx.setOnComplete(() -> pendingWrites--);
        tx.setOnError(() -> {
            pendingWrites--;
            arc.util.Log.err("[Files] Failed to persist " + path + " to IndexedDB.");
        });
        tx.setOnAbort(() -> pendingWrites--);
    }

    private static void persistDelete(String path) {
        if (db == null) return;
        IDBTransaction tx = db.transaction(STORE_NAME, IDBDatabase.TRANSACTION_READWRITE);
        tx.objectStore(STORE_NAME).delete(JSString.valueOf(path));
        pendingWrites++;
        tx.setOnComplete(() -> pendingWrites--);
        tx.setOnError(() -> pendingWrites--);
    }
}
