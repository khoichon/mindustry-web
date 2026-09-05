package arc.util;

import java.util.*;
import java.util.concurrent.Callable;
import java.util.concurrent.TimeUnit;

/**
 * Minimal background-task runner for the web backend.
 *
 * IMPORTANT, and different from this class's first draft: this does NOT
 * implement java.util.concurrent.ExecutorService. TeaVM's own published JCL
 * compatibility report (https://teavm.org/jcl-report/recent/packages/java.util.concurrent.html)
 * shows ExecutorService, Executors, Future, ThreadPoolExecutor, ThreadFactory,
 * TimeoutException, and RejectedExecutionException as entirely unimplemented
 * (blank, not even partial) -- confirmed directly by a real build error
 * ("Class ... implements java.util.concurrent.ExecutorService, which is
 * missing in the classpath") when this class first tried to implement that
 * interface. Only Executor (the single-method execute(Runnable) interface),
 * Callable, and ExecutionException are actually supported (100%) from that
 * part of the package.
 *
 * So: this is a plain class with its own method names, and every call site
 * across arc-core that used to declare a field as `ExecutorService` now
 * declares it as `TeavmSimpleExecutor` instead (see the accompanying
 * patches), and every `Future<T>` field/variable is `TeavmFuture<T>` (see
 * TeavmFuture.java) -- same reasoning, same fix shape.
 *
 * SCHEDULING NOTE: tasks run INLINE on the submitting thread, not on worker
 * coroutines. The first draft spawned real TeaVM coroutine workers fed by a
 * queue, but a coroutine only gets CPU time when another thread suspends --
 * and arc's synchronous wait loops (AssetManager.finishLoadingAsset's
 * "while(!isLoaded(fileName)) update();") spin the main thread without ever
 * suspending, so a queued worker would never run: deadlock, first seen as
 * new PlanetDialog() wedging the boot forever. Running inline makes every
 * submit-then-poll pattern (AssetLoadingTask's depsFuture/loadFuture dance
 * included) complete within the caller's own loop, at the cost of "async"
 * loaders executing on the main thread -- which is where they executed
 * anyway, the browser having exactly one JS thread. The worker threads are
 * still spawned so shutdown/awaitTermination keep their usual shape; they
 * simply never see a task.
 */
public class TeavmSimpleExecutor {
    private boolean shutdown, terminated;
    private final Object lock = new Object();

    public TeavmSimpleExecutor(int threads, String name, boolean daemon) {
        // No threads are spawned: tasks run inline (see the class-level
        // SCHEDULING NOTE). The parameters only preserve the signature of
        // the earlier worker-pool draft.
    }

    public void execute(Runnable command) {
        synchronized (lock) {
            if (shutdown) throw new ArcRuntimeException("Executor already shut down");
        }
        try {
            command.run();
        } catch (Throwable t) {
            Log.err(t);
        }
    }

    public <T> TeavmFuture<T> submit(Callable<T> task) {
        TeavmFuture<T> future = new TeavmFuture<>();
        execute(() -> {
            try {
                future.complete(task.call());
            } catch (Throwable t) {
                future.fail(t);
            }
        });
        return future;
    }

    public TeavmFuture<?> submit(Runnable task) {
        return submit(() -> {
            task.run();
            return null;
        });
    }

    public void shutdown() {
        synchronized (lock) {
            shutdown = true;
            terminated = true; // nothing was ever queued: see SCHEDULING NOTE
        }
    }

    public boolean isShutdown() {
        synchronized (lock) { return shutdown; }
    }

    public boolean isTerminated() {
        synchronized (lock) { return terminated; }
    }

    public boolean awaitTermination(long timeout, TimeUnit unit) throws InterruptedException {
        long deadline = System.currentTimeMillis() + unit.toMillis(timeout);
        synchronized (lock) {
            while (!terminated) {
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) return false;
                lock.wait(remaining);
            }
            return true;
        }
    }
}
