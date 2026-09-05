package arc.backend.teavm;

import arc.Files.FileType;
import arc.util.Log;
import mindustry.ui.FileChooser.FileChooserParams;
import org.teavm.jso.JSBody;
import org.teavm.jso.JSFunctor;
import org.teavm.jso.JSObject;
import org.teavm.jso.typedarrays.ArrayBuffer;
import org.teavm.jso.typedarrays.Uint8Array;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.UnsupportedEncodingException;
import java.io.Writer;
import java.util.ArrayList;
import java.util.List;

/**
 * Browser-native replacement for Mindustry's file chooser on the web backend
 * (wired from TeavmClientLauncher.showFileChooser). Every import/export flow
 * in the game funnels through FileChooserParams, so this one class covers
 * saves, schematics, maps, mods and data export:
 *
 * - open/import: a hidden &lt;input type="file"&gt; is clicked, opening the
 *   browser's native picker. Selected files are staged into IdbVfs under
 *   "picked/" and the params' handler receives Fi handles to them, so the
 *   rest of the game code reads them like ordinary local files.
 * - save/export: the handler receives a DownloadFi under "downloads/"; every
 *   write to it is persisted to IdbVfs like any TeavmFi write AND pushed to
 *   the user through a Blob + <a download> click -- the browser's
 *   "save file" experience.
 */
public final class TeavmFileChooser{

    /** Where picked (imported) files are staged inside the IdbVfs namespace. */
    private static final String PICKED_DIR = "picked/";

    private TeavmFileChooser(){}

    /** Entry point; see TeavmClientLauncher.showFileChooser. */
    public static void choose(FileChooserParams params){
        Log.info("[file-picker] @ (extensions: @)", params.open ? "open" : "save", String.join(",", params.extensions));
        if(params.open){
            StringBuilder accept = new StringBuilder();
            for(String ext : params.extensions){
                if(accept.length() > 0) accept.append(',');
                accept.append('.').append(ext);
            }
            List<arc.files.Fi> staged = new ArrayList<>();
            Log.info("[file-picker] opening native picker (accept=@, multiple=@)", accept, params.allowMultiple);
            pickFiles(accept.toString(), params.allowMultiple, (name, buffer) -> {
                try{
                    staged.add(stagePicked(name, buffer));
                }catch(Throwable t){
                    Log.err("[file-picker] failed to stage '" + name + "': " + t);
                }
            }, () -> {
                Log.info("[file-picker] picker done, @ file(s) staged", staged.size());
                if(staged.isEmpty()) return; // user cancelled
                params.handleChooseResult(staged.toArray(new arc.files.Fi[0]));
            });
        }else{
            // Mirror the fallback chooser's naming rule: make sure the
            // default name carries the primary extension.
            String name = params.fileName;
            boolean hasExt = false;
            for(String ext : params.extensions){
                if(name.endsWith("." + ext)) hasExt = true;
            }
            if(!hasExt) name = name + "." + params.extensions[0];
            params.handleChooseResult(new DownloadFi("downloads/" + name));
        }
    }

    /** Writes a picked file's bytes into the writable VFS and returns a handle to it. */
    private static arc.files.Fi stagePicked(String name, ArrayBuffer buffer){
        int len = buffer.getByteLength();
        Uint8Array view = new Uint8Array(buffer);
        byte[] bytes = new byte[len];
        for(int i = 0; i < len; i++) bytes[i] = (byte)view.get(i);

        // The browser already filtered by extension (accept attr), but the
        // name is user-chosen: keep it clear of path separators.
        String clean = name.replace('/', '_').replace('\\', '_');
        String path = PICKED_DIR + clean;
        IdbVfs.write(path, bytes);
        Log.info("[file-picker] staged '@' (@ bytes)", path, bytes.length);
        return new TeavmFi(path, FileType.local);
    }

    /** Pushes bytes to the user as a browser download. */
    static void download(String name, byte[] bytes){
        Uint8Array view = Uint8Array.create(bytes.length);
        for(int i = 0; i < bytes.length; i++) view.set(i, (short)(bytes[i] & 0xFF));
        triggerDownload(name, view);
    }

    @JSFunctor
    interface FileCallback extends JSObject{
        void call(String name, ArrayBuffer data);
    }

    @JSFunctor
    interface DoneCallback extends JSObject{
        void call();
    }

    /**
     * Opens the browser's native file picker. onFile fires once per selected
     * file (after its bytes are read), onDone after the last one (also when
     * the picker is cancelled with no files).
     */
    @JSBody(params = {"accept", "multiple", "onFile", "onDone"}, script =
        "var inp = document.getElementById('ms-file-input');" +
        "if(!inp){" +
        "    inp = document.createElement('input');" +
        "    inp.type = 'file';" +
        "    inp.id = 'ms-file-input';" +
        "    inp.style.display = 'none';" +
        "    document.body.appendChild(inp);" +
        "}" +
        "inp.value = '';" +
        "inp.accept = accept;" +
        "inp.multiple = !!multiple;" +
        "inp.onchange = function(){" +
        "    var files = Array.prototype.slice.call(inp.files || []);" +
        "    if(files.length === 0){ onDone(); return; }" +
        "    var pending = files.length;" +
        "    var finish = function(){ if(--pending === 0) onDone(); };" +
        "    files.forEach(function(f){" +
        "        var done = false;" +
        "        var once = function(){ if(!done){ done = true; finish(); } };" +
        "        try{" +
        "            f.arrayBuffer().then(function(buf){ try{ onFile(f.name, buf); }catch(e){ console.error('[file-picker] ' + e); } once(); })" +
        "                .catch(function(e){ console.error('[file-picker] ' + e); once(); });" +
        "        }catch(e){ console.error('[file-picker] ' + e); once(); }" +
        "    });" +
        "};" +
        "inp.click();")
    static native void pickFiles(String accept, boolean multiple, FileCallback onFile, DoneCallback onDone);

    /** Saves `data` as a file via a Blob + programmatic <a download> click. */
    @JSBody(params = {"name", "data"}, script =
        "var blob = new Blob([data], {type: 'application/octet-stream'});" +
        "var url = URL.createObjectURL(blob);" +
        "var a = document.createElement('a');" +
        "a.href = url;" +
        "a.download = name;" +
        "document.body.appendChild(a);" +
        "a.click();" +
        "setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 10000);")
    static native void triggerDownload(String name, Uint8Array data);

    /**
     * A TeavmFi whose writes are also delivered to the user as a browser
     * download. Persists to IdbVfs exactly like the base class (the file
     * then also exists in the VFS if the game reads it back), and fires the
     * download with the final combined contents on stream/close.
     */
    static class DownloadFi extends TeavmFi{
        DownloadFi(String path){
            super(path, FileType.local);
        }

        @Override
        public void writeBytes(byte[] bytes, boolean append){
            super.writeBytes(bytes, append);
            download(name(), IdbVfs.read(path()));
        }

        @Override
        public OutputStream write(boolean append){
            byte[] prefix = append ? IdbVfs.read(path()) : null;
            ByteArrayOutputStream out = new ByteArrayOutputStream(){
                @Override
                public void close() throws IOException{
                    super.close();
                    byte[] written = toByteArray();
                    if(prefix != null){
                        byte[] combined = new byte[prefix.length + written.length];
                        System.arraycopy(prefix, 0, combined, 0, prefix.length);
                        System.arraycopy(written, 0, combined, prefix.length, written.length);
                        written = combined;
                    }
                    IdbVfs.write(path(), written);
                    download(name(), written);
                }
            };
            return out;
        }

        @Override
        public Writer writer(boolean append, String charset){
            // Same shape as TeavmFi.writer, plus the download on close --
            // writeString() lands here, which several export flows use.
            byte[] prefix = append ? IdbVfs.read(path()) : null;
            ByteArrayOutputStream out = new ByteArrayOutputStream(){
                @Override
                public void close() throws IOException{
                    super.close();
                    byte[] written = toByteArray();
                    if(prefix != null){
                        byte[] combined = new byte[prefix.length + written.length];
                        System.arraycopy(prefix, 0, combined, 0, prefix.length);
                        System.arraycopy(written, 0, combined, prefix.length, written.length);
                        written = combined;
                    }
                    IdbVfs.write(path(), written);
                    download(name(), written);
                }
            };
            try{
                return charset == null
                    ? new OutputStreamWriter(out)
                    : new OutputStreamWriter(out, charset);
            }catch(UnsupportedEncodingException e){
                throw new arc.util.ArcRuntimeException("Unsupported charset: " + charset, e);
            }
        }
    }
}
