// Static file server for backend-teavm/build/web with no-store caching --
// python's http.server sends no cache headers, and Chrome's heuristic
// caching then serves STALE mindustry.js builds after rebuilds, which has
// caused real debugging confusion (old ZipFi code running in a "fresh"
// page). This always revalidates from disk.
//
// Usage: node tools/serve.mjs [port]   (default 8174)
import http from 'http';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '../backend-teavm/build/web');
const port = parseInt(process.argv[2] || '8174', 10);

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.ogg': 'audio/ogg',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json',
    '.wasm': 'application/wasm', '.atls': 'application/octet-stream', '.msav': 'application/octet-stream',
    '.zip': 'application/zip', '.dat': 'application/octet-stream', '.properties': 'text/plain'
};

const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if(p.endsWith('/')) p += 'index.html';
    const file = path.join(webDir, p);
    if(!file.startsWith(webDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()){
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end('not found: ' + p);
        console.log(`[404] ${p}`);
        return;
    }
    res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
    });
    fs.createReadStream(file).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
    console.log(`serving ${webDir} -> http://localhost:${port}/ (no-store)`);
});
