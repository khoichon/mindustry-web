package mindustry.net;

import arc.func.Boolc;
import arc.util.Log;

/**
 * Offline replacement for core/src/mindustry/net/BeControl.java.
 *
 * Upstream periodically polls the MindustryBuilds GitHub API for bleeding-edge
 * updates, resolves its own jar via Class.getProtectionDomain(), downloads a
 * new build and Runtime.exec()s a restart script -- none of which exists or
 * makes sense in a browser tab, and all of which reference classlib APIs TeaVM
 * doesn't implement (getProtectionDomain, Runtime.exec). The browser build is
 * offline-first: it ships as one version and updates by being re-deployed,
 * so every update-related entry point is a no-op. Swapped in via source-set
 * filtering in backend-teavm/build.gradle.
 */
public class BeControl{

    public boolean active(){
        return false;
    }

    public void init(){
    }

    /** asynchronously checks for updates. */
    public void checkUpdate(Boolc done){
        Log.debug("[be] update checks are disabled in the browser build.");
        done.get(false);
    }

    /** @return whether a new update is available */
    public boolean isUpdateAvailable(){
        return false;
    }

    /** shows the dialog for updating the game on desktop, or a prompt for doing so on the server */
    public void showUpdateDialog(){
    }
}
