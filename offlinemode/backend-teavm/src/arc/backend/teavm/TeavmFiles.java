package arc.backend.teavm;

import arc.Files;
import arc.files.Fi;

public class TeavmFiles implements Files {
    @Override
    public Fi get(String path, FileType type) {
        return new TeavmFi(path, type);
    }

    @Override
    public String getExternalStoragePath() {
        return "/external/"; // namespace prefix only -- IdbVfs is a flat keyed store, not a real filesystem
    }

    @Override
    public boolean isExternalStorageAvailable() {
        return true; // IndexedDB is available wherever this code runs at all
    }

    @Override
    public String getLocalStoragePath() {
        return "/local/";
    }

    @Override
    public boolean isLocalStorageAvailable() {
        return true;
    }
}
