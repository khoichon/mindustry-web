// web-bridge.js
// JS implementation of mindustry.web.WebBridge's natives (see the WebLauncher/
// WebBridge classes compiled into Mindustry.jar). DesktopLauncher.main was patched
// to construct WebLauncher, which overrides showFileChooser/showMultiFileChooser to
// route through here - so whenever the game asks for a file, the *browser's* native
// picker/downloader is what the user sees:
//
//   open dialog  -> <input type=file> picker -> bytes written into the JVM's virtual
//                   filesystem -> a Fi for that path is handed to the game's callback
//   save dialog  -> a writable path in the virtual FS is handed to the callback; the
//                   game writes the file; WebBridge.finished() then reads it back out
//                   and triggers a browser download of those bytes
//
// All JVM interaction uses patterns proven elsewhere in this project: static calls
// through the running instance's `lib` handle (Paths.get / Files.write /
// Files.readAllBytes / Files.createDirectories / System.getProperty / Fi.get), with
// typed-array arguments only ever passed to static methods.

(function (global) {
  'use strict';
  const NATIVES = {};

  function sanitize(n) { return String(n).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120); }

  function pickLocalFile(extList) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      if (extList && extList.length) {
        inp.accept = extList.map(e => '.' + String(e).replace(/^\./, '')).join(',');
      }
      inp.addEventListener('change', () => resolve(inp.files[0] || null));
      inp.addEventListener('cancel', () => resolve(null)); // Chrome 113+
      inp.click();
    });
  }

  async function jvm(lib) {
    const Paths = await lib.java.nio.file.Paths;
    const Files = await lib.java.nio.file.Files;
    return { Paths, Files };
  }

  let cachedDir = null;
  async function bridgeDir(lib, Files, Paths) {
    if (cachedDir) return cachedDir;
    const System = await lib.java.lang.System;
    const home = await System.getProperty('user.home');
    for (const dir of [home + '/web-files', '/tmp/web-files', '/files/web-files']) {
      try {
        await Files.createDirectories(await Paths.get(dir));
        cachedDir = dir;
        console.log('[web-bridge] using exchange directory:', dir);
        return cachedDir;
      } catch (e) { console.warn('[web-bridge] not writable:', dir, (e && e.message) || e); }
    }
    throw new Error('no writable directory in the JVM filesystem');
  }

  async function fiFor(lib, path) {
    const FiClass = await lib.arc.files.Fi;
    return FiClass.get(path); // static Fi.get(String) - resolves by the String argument
  }

  NATIVES['Java_mindustry_web_WebBridge_choose'] = async (lib, save, title, extensionsCsv) => {
    try {
      save = !!save;
      // extensions arrive pre-joined by WebLauncher ("msav,msch") - Java String[]
      // args marshal as opaque proxies JS can't iterate, so never pass arrays here
      const extList = String(extensionsCsv || '').split(',').map(e => e.trim()).filter(Boolean);
      const { Paths, Files } = await jvm(lib);
      const dir = await bridgeDir(lib, Files, Paths);
      if (!save) {
        const file = await pickLocalFile(extList);
        if (!file) return null; // user cancelled -> game treats null as no-op
        const path = dir + '/' + sanitize(file.name);
        const bytes = new Int8Array(await file.arrayBuffer());
        await Files.write(await Paths.get(path), bytes);
        console.log(`[web-bridge] imported ${file.name} (${bytes.byteLength} bytes) -> ${path}`);
        return await fiFor(lib, path);
      } else {
        const ext = extList.length ? '.' + String(extList[0]).replace(/^\./, '') : '';
        const path = dir + '/' + sanitize(title || 'export') + ext;
        console.log('[web-bridge] save target:', path);
        return await fiFor(lib, path);
      }
    } catch (e) {
      console.error('[web-bridge] choose failed', e);
      return null;
    }
  };

  NATIVES['Java_mindustry_web_WebBridge_finished'] = async (lib, save, path) => {
    if (!save || !path) return;
    try {
      const { Paths, Files } = await jvm(lib);
      const p = String(path);
      const bytes = await Files.readAllBytes(await Paths.get(p)); // Java byte[] -> Int8Array
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = p.split('/').pop() || 'export';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      console.log(`[web-bridge] downloaded ${p} (${bytes.byteLength} bytes)`);
    } catch (e) {
      console.error('[web-bridge] download failed', e);
    }
  };

  global.WEB_BRIDGE_NATIVES = NATIVES;
})(window);
