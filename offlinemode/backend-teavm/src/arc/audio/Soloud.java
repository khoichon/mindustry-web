package arc.audio;

import org.teavm.jso.webaudio.AudioContext;
import org.teavm.jso.webaudio.AudioBuffer;
import org.teavm.jso.webaudio.AudioBufferSourceNode;
import org.teavm.jso.webaudio.GainNode;
import org.teavm.jso.webaudio.StereoPannerNode;
import org.teavm.jso.typedarrays.ArrayBuffer;
import org.teavm.jso.typedarrays.Uint8Array;

/**
 * WEB REPLACEMENT for Arc's native Soloud.java bindings.
 *
 * This is a drop-in replacement, not a wrapper: same package (arc.audio),
 * same class name (Soloud), same static method signatures as the original
 * JNI-bound file. That means Audio.java, AudioSource.java, Sound.java,
 * Music.java, AudioBus.java and AudioFilter.java -- which all do
 * `import static arc.audio.Soloud.*` -- compile and run against this
 * completely unmodified. To use it: replace arc-core's real
 * src/arc/audio/Soloud.java with this file in the TeaVM build's source set
 * (or shadow it via source-set ordering), leaving every other backend's
 * copy of arc-core untouched.
 *
 * Design notes (read before extending):
 *
 * - SoLoud's "long handle" values are native C++ pointers to AudioSource
 *   subclasses (Wav/WavStream/Bus/Filter). Here they're just int keys into
 *   Java-side maps -- same technique as TeavmGL20's texture/buffer handle
 *   tables, for the same reason (opaque native things need a Java-visible
 *   proxy id).
 * - SoLoud loads audio synchronously; Web Audio's decodeAudioData() is a
 *   callback/Promise-based async API. wavLoadBytes/streamLoadBytes/
 *   streamLoadFile all return a handle immediately (matching the sync
 *   signature callers expect) and kick off decoding in the background;
 *   the handle's DecodedSource starts "not ready" and flips ready once the
 *   callback fires. sourcePlay on a not-ready handle currently no-ops and
 *   returns -1, same failure contract Sound.play() already handles (it
 *   treats -1 as "didn't play"), rather than blocking.
 * - Web Audio's AudioBufferSourceNode is one-shot: once started, it can't
 *   be paused and resumed, only stopped permanently. To support
 *   idPause/idGetPause (which Music.java relies on for its play/pause
 *   button), we stop the underlying node and remember the playback offset
 *   in the Voice record, then build a *new* source node at resume time
 *   seeked to that offset -- reusing the same voice id and the same
 *   Gain/StereoPanner nodes, so external code (Music, AudioBus) sees no
 *   change in the source it's holding a handle to. This is the standard
 *   pattern for faking pause in Web Audio.
 * - Buses (busNew/AudioBus) are modeled as a GainNode wired straight into
 *   audioContext.destination; sourcePlayBus connects a played sound's
 *   chain into that bus's gain node instead of the destination directly.
 * - streamLoadFile(path) needs actual bytes for that path -- it delegates
 *   to TeavmFi's static byte-loading helper (same IndexedDB/classpath
 *   resolution the Files subsystem uses), since Music.java streams by path
 *   on every platform, not by bytes.
 * - NOT implemented (explicitly, not silently): the SoLoud DSP filter
 *   graph (echo/lofi/flanger/bassboost/robotize/freeverb/biquad) and the
 *   Arc-side concurrency-limiting hints (priority/maxConcurrent/
 *   concurrentGroup/minConcurrentInterrupt/singleInstance). These no-op
 *   with a one-time log warning rather than throwing, since callers don't
 *   check return values for them and Mindustry's core sound playback does
 *   not depend on them -- but they are a real functional gap versus native
 *   SoLoud, not an oversight to be quietly patched over later.
 */
public class Soloud {
    private static AudioContext ctx;
    private static GainNode masterGain;

    private static final java.util.Map<Long, DecodedSource> sources = new java.util.HashMap<>();
    private static final java.util.Map<Long, GainNode> buses = new java.util.HashMap<>();
    private static final java.util.Map<Integer, Voice> voices = new java.util.HashMap<>();
    private static long nextSourceHandle = 1;
    private static int nextVoiceId = 1;
    private static boolean warnedFilters, warnedConcurrency;

    // ---- lifecycle ----

    static void init() {
        ctx = new AudioContext();
        masterGain = ctx.createGain();
        masterGain.connect(ctx.getDestination());

        // Browsers start every AudioContext "suspended" until a user gesture
        // (autoplay policy). Belt and braces: (1) resume on the first
        // pointer/key/touch event on window AND document -- no initial-state
        // gate, several event types, in case any single registration fails
        // to fire in a given browser; (2) ensureRunning() retries resume()
        // opportunistically at every voice start, so audio recovers even if
        // the listeners somehow never ran. resume() on a running context is
        // a no-op, and a resume() outside a gesture just rejects a promise
        // we don't inspect.
        org.teavm.jso.dom.events.EventListener<org.teavm.jso.dom.events.Event> resumeOnce =
            new org.teavm.jso.dom.events.EventListener<org.teavm.jso.dom.events.Event>() {
                boolean done = false;
                @Override
                public void handleEvent(org.teavm.jso.dom.events.Event evt) {
                    if (done) return;
                    done = true;
                    ensureRunning();
                    detachResumeListeners();
                }
            };
        resumeOnce_ = resumeOnce;
        for (String ev : new String[]{"pointerdown", "mousedown", "touchstart", "keydown", "click"}) {
            org.teavm.jso.browser.Window.current().addEventListener(ev, resumeOnce);
            org.teavm.jso.browser.Window.current().getDocument().addEventListener(ev, resumeOnce);
        }
    }

    private static org.teavm.jso.dom.events.EventListener<org.teavm.jso.dom.events.Event> resumeOnce_;

    private static void detachResumeListeners() {
        if (resumeOnce_ == null) return;
        for (String ev : new String[]{"pointerdown", "mousedown", "touchstart", "keydown", "click"}) {
            org.teavm.jso.browser.Window.current().removeEventListener(ev, resumeOnce_);
            org.teavm.jso.browser.Window.current().getDocument().removeEventListener(ev, resumeOnce_);
        }
        resumeOnce_ = null;
    }

    /** Resume the AudioContext if the browser still has it gated. Safe to call anywhere, any number of times. */
    static void ensureRunning() {
        if (ctx != null && AudioContext.STATE_SUSPENDED.equals(ctx.getState())) {
            ctx.resume();
        }
    }

    static void deinit() {
        stopAll();
        if (ctx != null) ctx.close();
        ctx = null;
    }

    static String backendString() { return "WebAudio"; }
    static int backendId() { return 0; }
    static int backendChannels() { return 2; }
    static int backendSamplerate() { return ctx != null ? (int) ctx.getSampleRate() : 44100; }
    static int backendBufferSize() { return 0; } // not exposed by Web Audio
    static int version() { return 1; }

    static int activeVoiceCount() {
        int n = 0;
        for (Voice v : voices.values()) if (v.active && !v.paused) n++;
        return n;
    }

    static void stopAll() {
        for (Integer id : new java.util.ArrayList<>(voices.keySet())) idStop(id);
    }

    static void pauseAll(boolean paused) {
        for (Integer id : voices.keySet()) idPause(id, paused);
    }

    // ---- filters / DSP: not implemented, see class doc ----

    static void biquadSet(long h, int t, float f, float r) { warnFilters(); }
    static void echoSet(long h, float d, float dec, float f) { warnFilters(); }
    static void lofiSet(long h, float sr, float bd) { warnFilters(); }
    static void flangerSet(long h, float d, float f) { warnFilters(); }
    static void waveShaperSet(long h, float a) { warnFilters(); }
    static void bassBoostSet(long h, float a) { warnFilters(); }
    static void robotizeSet(long h, float f, int w) { warnFilters(); }
    static void freeverbSet(long h, float m, float rs, float d, float w) { warnFilters(); }
    static long filterBiquad() { warnFilters(); return 0; }
    static long filterEcho() { warnFilters(); return 0; }
    static long filterLofi() { warnFilters(); return 0; }
    static long filterFlanger() { warnFilters(); return 0; }
    static long filterBassBoost() { warnFilters(); return 0; }
    static long filterWaveShaper() { warnFilters(); return 0; }
    static long filterRobotize() { warnFilters(); return 0; }
    static long filterFreeverb() { warnFilters(); return 0; }
    static void setGlobalFilter(int index, long handle) { warnFilters(); }
    static void filterFade(int voice, int filter, int attribute, float value, float timeSec) { warnFilters(); }
    static void filterSet(int voice, int filter, int attribute, float value) { warnFilters(); }

    private static void warnFilters() {
        if (!warnedFilters) {
            warnedFilters = true;
            arc.util.Log.warn("[Audio] DSP filters are not implemented on the web backend; ignoring.");
        }
    }

    // ---- buses ----

    static long busNew() {
        long handle = nextSourceHandle++;
        GainNode gain = ctx.createGain();
        gain.connect(masterGain);
        buses.put(handle, gain);
        return handle;
    }

    // ---- loading ----

    static long wavLoadBytes(byte[] bytes, int length) {
        return decodeAsync(bytes, length);
    }

    static long streamLoadBytes(byte[] bytes, int length) {
        return decodeAsync(bytes, length);
    }

    static long streamLoadFile(String path) {
        long handle = nextSourceHandle++;
        DecodedSource src = new DecodedSource();
        sources.put(handle, src);
        // Delegate byte-loading to whatever the Files subsystem uses to resolve a
        // path -- e.g. TeavmFi.readBytesForPath(path) once that's wired up
        // (IndexedDB for local/external, embedded resources for internal/classpath).
        // Kept as an explicit hook rather than guessed at here, since it must use
        // the exact same path-resolution logic Files.get()/Fi use.
        arc.backend.teavm.TeavmFi.readBytesAsync(path, bytes -> {
            long inner = decodeAsync(bytes, bytes.length);
            // splice the async-decoded source into the handle we already returned
            sources.put(handle, sources.get(inner));
            sources.remove(inner);
        }, err -> arc.util.Log.err("[Audio] Failed to stream-load " + path));
        return handle;
    }

    private static long decodeAsync(byte[] bytes, int length) {
        long handle = nextSourceHandle++;
        DecodedSource src = new DecodedSource();
        sources.put(handle, src);

        ArrayBuffer buf = new ArrayBuffer(length);
        Uint8Array view = new Uint8Array(buf);
        for (int i = 0; i < length; i++) view.set(i, (short) (bytes[i] & 0xFF));

        ctx.decodeAudioData(buf,
            decoded -> { src.buffer = decoded; src.ready = true; },
            err -> arc.util.Log.err("[Audio] decodeAudioData failed"));
        return handle;
    }

    static double streamLength(long handle) { return wavLength(handle); }

    static double wavLength(long handle) {
        DecodedSource src = sources.get(handle);
        return (src != null && src.ready) ? src.buffer.getDuration() : 0.0;
    }

    static void sourceDestroy(long handle) {
        sources.remove(handle);
        buses.remove(handle);
    }

    static void sourceInaudible(long handle, boolean tick, boolean play) { /* no browser equivalent */ }
    static void sourcePriority(long handle, float priority) { warnConcurrency(); }
    static void sourceMinConcurrentInterrupt(long handle, float value) { warnConcurrency(); }
    static void sourceMaxConcurrent(long handle, int maxConcurrent) { warnConcurrency(); }
    static void sourceConcurrentGroup(long handle, int group) { warnConcurrency(); }
    static void sourceSingleInstance(long handle, boolean single) { warnConcurrency(); }
    static void sourceFilter(long handle, int index, long filter) { warnFilters(); }

    private static void warnConcurrency() {
        if (!warnedConcurrency) {
            warnedConcurrency = true;
            arc.util.Log.warn("[Audio] Concurrency-limit hints (priority/maxConcurrent/...) are not enforced on the web backend.");
        }
    }

    static void sourceLoop(long handle, boolean loop) {
        // Applies to already-playing voices of this source; SoLoud's semantics
        // here are per-source-default, which we don't track separately -- callers
        // (Sound/Music) always pass loop explicitly into sourcePlay/sourcePlayBus
        // instead, so this is rarely load-bearing. No-op is safe for that path.
    }

    static void sourceStop(long handle) {
        for (Voice v : voices.values()) {
            if (v.sourceHandle == handle) stopVoice(v);
        }
    }

    static int sourceCount(long handle) {
        int n = 0;
        for (Voice v : voices.values()) if (v.sourceHandle == handle && v.active) n++;
        return n;
    }

    // ---- playback ----

    static int sourcePlay(long handle) {
        return sourcePlayBus(handle, 0, 1f, 1f, 0f, false);
    }

    static int sourcePlay(long handle, float volume, float pitch, float pan, boolean loop) {
        return sourcePlayBus(handle, 0, volume, pitch, pan, loop);
    }

    static int sourcePlayBus(long handle, long busHandle, float volume, float pitch, float pan, boolean loop) {
        // A "bus" being played (AudioBus.init()) has no AudioBuffer of its own --
        // it's just marking its own gain node active so idVolume/idValid work on it.
        GainNode selfBus = buses.get(handle);
        if (selfBus != null) {
            int id = nextVoiceId++;
            Voice v = new Voice();
            v.sourceHandle = handle;
            v.isBusSelf = true;
            v.gain = selfBus;
            v.active = true;
            voices.put(id, v);
            return id;
        }

        DecodedSource src = sources.get(handle);
        if (src == null || !src.ready) return -1;

        GainNode destBus = busHandle != 0 ? buses.get(busHandle) : masterGain;
        if (destBus == null) destBus = masterGain;

        Voice v = new Voice();
        v.sourceHandle = handle;
        v.buffer = src.buffer;
        v.loop = loop;
        v.volume = volume;
        v.pitch = pitch;
        v.pan = pan;
        v.destBus = destBus;
        v.offset = 0;
        v.startedAt = ctx.getCurrentTime();
        startVoiceNode(v);

        int id = nextVoiceId++;
        v.active = true;
        voices.put(id, v);
        return id;
    }

    private static void startVoiceNode(Voice v) {
        ensureRunning(); // autoplay policy: contexts created pre-gesture stay suspended
        AudioBufferSourceNode node = ctx.createBufferSource();
        node.setBuffer(v.buffer);
        node.setLoop(v.loop);
        node.getPlaybackRate().setValue(Math.max(v.pitch, 0.0001f));

        GainNode gain = ctx.createGain();
        gain.getGain().setValue(v.volume);

        StereoPannerNode panner = ctx.createStereoPanner();
        panner.getPan().setValue(v.pan);

        node.connect(gain);
        gain.connect(panner);
        panner.connect(v.destBus);
        node.start(0, v.offset);

        v.node = node;
        v.gain = gain;
        v.panner = panner;
    }

    private static void stopVoice(Voice v) {
        if (v.node != null) {
            try { v.node.stop(); } catch (Exception ignored) {}
        }
        v.active = false;
    }

    // ---- per-voice controls ----

    static void idSeek(int id, float seconds) {
        Voice v = voices.get(id);
        if (v == null || v.isBusSelf) return;
        boolean wasPaused = v.paused;
        if (v.node != null) { try { v.node.stop(); } catch (Exception ignored) {} }
        v.offset = seconds;
        v.startedAt = ctx.getCurrentTime() - seconds;
        if (!wasPaused) startVoiceNode(v);
    }

    static void idVolume(int id, float volume) {
        Voice v = voices.get(id);
        if (v != null && v.gain != null) v.gain.getGain().setValue(volume);
        if (v != null) v.volume = volume;
    }

    static float idGetVolume(int id) {
        Voice v = voices.get(id);
        return v != null ? v.volume : 0f;
    }

    static void idPan(int id, float pan) {
        Voice v = voices.get(id);
        if (v != null && v.panner != null) v.panner.getPan().setValue(pan);
        if (v != null) v.pan = pan;
    }

    static void idPitch(int id, float pitch) {
        Voice v = voices.get(id);
        if (v != null) {
            v.pitch = pitch;
            if (v.node != null) v.node.getPlaybackRate().setValue(Math.max(pitch, 0.0001f));
        }
    }

    static void idPause(int id, boolean pause) {
        Voice v = voices.get(id);
        if (v == null || v.isBusSelf || v.paused == pause) return;
        v.paused = pause;
        if (pause) {
            v.offset += ctx.getCurrentTime() - v.startedAt;
            if (v.node != null) { try { v.node.stop(); } catch (Exception ignored) {} }
            v.node = null;
        } else {
            v.startedAt = ctx.getCurrentTime();
            startVoiceNode(v);
        }
    }

    static boolean idGetPause(int voice) {
        Voice v = voices.get(voice);
        return v != null && v.paused;
    }

    static void idProtected(int id, boolean protect) {
        Voice v = voices.get(id);
        if (v != null) v.protectedVoice = protect;
    }

    static void idStop(int voice) {
        Voice v = voices.get(voice);
        if (v != null) stopVoice(v);
    }

    static void idLooping(int voice, boolean looping) {
        Voice v = voices.get(voice);
        if (v != null) {
            v.loop = looping;
            if (v.node != null) v.node.setLoop(looping);
        }
    }

    static boolean idGetLooping(int voice) {
        Voice v = voices.get(voice);
        return v != null && v.loop;
    }

    static float idPosition(int voice) {
        Voice v = voices.get(voice);
        if (v == null || v.isBusSelf) return 0f;
        return (float) (v.paused ? v.offset : (v.offset + (ctx.getCurrentTime() - v.startedAt)));
    }

    static boolean idValid(int voice) {
        Voice v = voices.get(voice);
        return v != null && v.active;
    }

    // ---- iOS-only in the original; no-ops here ----
    static int pauseDevice() { return 0; }
    static int resumeDevice() { return 0; }

    // ---- internal records ----

    private static class DecodedSource {
        volatile boolean ready;
        AudioBuffer buffer;
    }

    private static class Voice {
        long sourceHandle;
        boolean isBusSelf;
        AudioBuffer buffer;
        AudioBufferSourceNode node;
        GainNode gain;
        StereoPannerNode panner;
        GainNode destBus;
        boolean loop, paused, active, protectedVoice;
        float volume = 1f, pitch = 1f, pan = 0f;
        double offset, startedAt;
    }
}
