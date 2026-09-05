package arc.util;

/**
 * Minimal future for the web backend -- see TeavmSimpleExecutor's class doc
 * for why this doesn't implement java.util.concurrent.Future (that
 * interface itself is unimplemented in TeaVM's classlib, same as
 * ExecutorService). Built directly on wait/notify. Exposes exactly the two
 * members arc-core's actual call sites use: isDone() (polled once per frame
 * by AssetLoadingTask, non-blocking) and get() (called only after isDone()
 * is already true in that pattern, so it doesn't actually block there --
 * but does block correctly if called earlier, matching Future's contract).
 */
public class TeavmFuture<T> {
    private final Object lock = new Object();
    private boolean done;
    private T result;
    private Throwable error;

    void complete(T value) {
        synchronized (lock) {
            result = value;
            done = true;
            lock.notifyAll();
        }
    }

    void fail(Throwable t) {
        synchronized (lock) {
            error = t;
            done = true;
            lock.notifyAll();
        }
    }

    public boolean isDone() {
        synchronized (lock) { return done; }
    }

    public T get() throws Exception {
        synchronized (lock) {
            while (!done) lock.wait();
            if (error != null) {
                if (error instanceof Exception) throw (Exception) error;
                // Message matters: native JS errors reaching here (worker
                // coroutines run browser code) otherwise surface as bare
                // null-message ArcRuntimeExceptions that hide the real fault.
                throw new ArcRuntimeException(String.valueOf(error), error);
            }
            return result;
        }
    }
}
