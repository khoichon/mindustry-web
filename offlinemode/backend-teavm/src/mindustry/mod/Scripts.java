package mindustry.mod;

import arc.files.Fi;
import arc.util.Log;
import arc.util.Log.LogLevel;
import arc.util.Disposable;

/**
 * No-op replacement for mindustry's Rhino-backed script engine, for the
 * offline browser build. Rhino is ~350 classes that would all have to
 * compile under TeaVM, and JS mods are an online/optional feature; the base
 * game only uses Scripts for the mod API (scripts/global.js) and mod content
 * scripts, none of which exist offline.
 *
 * Same package/class name and public surface as upstream so Mods.java and
 * Platform compile unmodified; swapped in via source-set filtering.
 */
public class Scripts implements Disposable{
    private boolean errored;

    public Scripts(){
        Log.debug("[scripts] JavaScript mods are disabled in the browser build.");
    }

    public boolean hasErrored(){
        return errored;
    }

    public String runConsole(String text){
        return "JavaScript console is disabled in the browser build.";
    }

    public void log(String source, String message){
        log(LogLevel.info, source, message);
    }

    public void log(LogLevel level, String source, String message){
        Log.log(level, "[@]: @", source, message);
    }

    public float[] newFloats(int capacity){
        return new float[capacity];
    }

    public Class<?> getClass(Object object){
        return object == null ? null : object.getClass();
    }

    public void run(Mods.LoadedMod mod, Fi file){
        Log.warn("[scripts] Skipped script '@' -- JavaScript mods are disabled in the browser build.", file);
    }

    @Override
    public void dispose(){
    }
}
