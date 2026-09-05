package mindustry.teavm;

import arc.backend.teavm.TeavmFileChooser;
import mindustry.ClientLauncher;
import mindustry.ui.FileChooser.FileChooserParams;

/**
 * Game-side launcher for the TeaVM browser build, mirroring the CheerpJ
 * reference build's browser.BrowserLauncher: ClientLauncher does all the
 * real setup (assets, content, modules); this only overrides the
 * platform-specific bits that need browser behavior -- the file chooser
 * becomes the browser's native picker/downloader (TeavmFileChooser), and
 * there is no rich presence.
 */
public class TeavmClientLauncher extends ClientLauncher{

    @Override
    public void showFileChooser(FileChooserParams params){
        // The browser IS the file selector: imports open the native picker,
        // exports arrive as downloads (see TeavmFileChooser). The in-game
        // fallback chooser (FileChooser.showFallbackFileChooser) browses a
        // VFS directory the user has no files in, so it is useless here.
        TeavmFileChooser.choose(params);
    }

    @Override
    public void updateRPC(){
        // No Discord/Steam rich presence in the browser build.
    }
}
