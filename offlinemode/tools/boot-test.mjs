// Headless boot test for the TeaVM build.
//
// Serves backend-teavm/build/web over localhost HTTP, loads it in headless
// Chrome (SwiftShader WebGL2), and prints everything the page logs to the
// console plus any uncaught JS exceptions, then exits non-zero if --expect
// (a required console substring) never appeared before the timeout.
//
// Usage:
//   node tools/boot-test.mjs [--wait 15000] [--expect SUBSTRING] [--screenshot out.png] [--url path]
//
// puppeteer-core is borrowed from the CheerpJ reference checkout rather than
// installed here, to keep this project dependency-free.
import {createRequire} from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const require = createRequire('/Users/chon/code/mindustry-web/package.json');
const puppeteer = require('puppeteer-core');

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '../backend-teavm/build/web');

const args = process.argv.slice(2);
function arg(name, def){
    const i = args.indexOf('--' + name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const waitMs = parseInt(arg('wait', '15000'), 10);
const expect = arg('expect', null);
const screenshot = arg('screenshot', null);
const urlPath = arg('url', '/index.html');
const profileMs = parseInt(arg('profile', '0'), 10);
const localeOverride = arg('locale', null);
const interact = args.includes('--interact');
const interactArgs = arg('click', null); // "x,y" CSS-pixel click point, forces --interact timing

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.ogg': 'audio/ogg',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json',
    '.wasm': 'application/wasm', '.atls': 'application/octet-stream', '.msav': 'application/octet-stream'
};

const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if(p.endsWith('/')) p += 'index.html';
    const file = path.join(webDir, p);
    if(!file.startsWith(webDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()){
        res.writeHead(404); res.end('not found: ' + p);
        console.log(`[http 404] ${p}`);
        return;
    }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
    fs.createReadStream(file).pipe(res);
});

// --file PATH: load a local file (file:// origin) directly instead of serving
// the web dir -- used to verify the standalone single-file build, where
// fetch()/XHR are blocked and everything must come from the page itself.
const filePath = arg('file', null);
let pageUrl;
if(filePath){
    pageUrl = 'file://' + path.resolve(filePath);
    console.log(`[boot-test] loading file -> ${pageUrl}`);
    server.close();
}else{
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    pageUrl = `http://127.0.0.1:${port}${urlPath}`;
    console.log(`[boot-test] serving ${webDir} -> ${pageUrl}`);
}

const lines = [];
let pageErrors = 0;

const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.HOME + '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800'
    ]
});

const page = await browser.newPage();
await page.setViewport({width: 1280, height: 800, deviceScaleFactor: 1});
page.on('console', m => {
    const line = `[console.${m.type()}] ${m.text()}`;
    lines.push(line);
    console.log(line);
});
page.on('pageerror', e => {
    pageErrors++;
    const line = `[pageerror] ${e.message}`;
    lines.push(line);
    console.log(line);
});
page.on('requestfailed', r => {
    const line = `[requestfailed] ${r.url()} ${r.failure()?.errorText}`;
    lines.push(line);
    console.log(line);
});
page.on('response', r => {
    if(r.status() >= 400){
        const line = `[http ${r.status()}] ${r.url()}`;
        lines.push(line);
        console.log(line);
    }
});

// The standalone file is huge; give its parse+boot plenty of headroom.
if(localeOverride){
    // CDP's Emulation.setLocaleOverride only affects Intl.* formatting, not
    // navigator.language -- which is what TeaVM's default Locale derives
    // from. Override the property itself before any page script runs.
    await page.evaluateOnNewDocument(l => {
        try{
            Object.defineProperty(navigator, 'language', {configurable: true, get: () => l});
            Object.defineProperty(navigator, 'languages', {configurable: true, get: () => [l]});
        }catch(e){ console.warn('[boot-test] locale override failed: ' + e); }
    }, localeOverride);
    console.log(`[boot-test] navigator.language overridden to ${localeOverride}`);
}
await page.goto(pageUrl, {waitUntil: 'load', timeout: filePath ? 300000 : 30000});

// --profile N: run a CDP CPU profile for N seconds after load, then print
// the hottest functions (self-time). Works even when the page is stuck in
// a busy JS loop -- the profiler runs on a separate thread -- which is
// exactly the situation it exists to diagnose.
if(profileMs){
    const delayMs = parseInt(arg('profile-delay', '0'), 10);
    if(delayMs) await new Promise(r => setTimeout(r, delayMs));
    const client = await page.createCDPSession();
    await client.send('Profiler.enable');
    await client.send('Profiler.setSamplingInterval', {interval: 1000}); // 1ms
    await client.send('Profiler.start');
    await new Promise(r => setTimeout(r, profileMs));
    const {profile} = await client.send('Profiler.stop');
    // Aggregate self time per function; then print top 15 with URLs:lines.
    const nodes = new Map(profile.nodes.map(n => [n.id, n]));
    const self = new Map();
    const totalSamples = profile.samples?.length || 0;
    for(const id of (profile.samples || [])){
        self.set(id, (self.get(id) || 0) + 1);
    }
    const rows = [...self.entries()].map(([id, samples]) => {
        const n = nodes.get(id);
        const cf = n?.callFrame || {};
        return {
            samples,
            pct: (100 * samples / Math.max(1, totalSamples)).toFixed(1),
            fn: cf.functionName || '(anonymous)',
            url: (cf.url || '').replace(webDir + '/', ''),
            line: cf.lineNumber >= 0 ? cf.lineNumber + 1 : '?'
        };
    }).sort((a, b) => b.samples - a.samples).slice(0, 15);
    console.log(`[boot-test] profile: ${totalSamples} samples over ${profileMs}ms; top functions by self time:`);
    for(const r of rows){
        console.log(`[profile] ${String(r.pct).padStart(5)}% ${String(r.samples).padStart(5)}samples ${r.fn} @ ${r.url}:${r.line}`);
    }
}

// Drive real DOM input events so keyboard/mouse/wheel wiring can be verified
// headlessly (CSS-pixel coordinates, matching what a real browser delivers).
if(interact || interactArgs || process.argv.includes('--clicks')){
    await new Promise(r => setTimeout(r, 2000));
    if(interactArgs && !process.argv.includes('--clicks')){
        const [x, y] = interactArgs.split(',').map(Number);
        await page.mouse.click(x, y);
        console.log(`[boot-test] sent: click ${x},${y} (viewport ${page.viewport().width}x${page.viewport().height} dpr ${page.viewport().deviceScaleFactor})`);
    }else if(process.argv.includes('--clicks')){
        // --clicks "x,y[,delayBeforeMs];x,y;..." -- wait for boot to finish
        // (or --clicks-wait ms), then fire each click with optional delay.
        const i = args.indexOf('--clicks');
        const seqArg = args[i + 1];
        const bootWait = parseInt(arg('clicks-wait', '0'), 10);
        const expectBoot = arg('clicks-expect', 'Total time to load');
        const deadline2 = Date.now() + (bootWait || 240000);
        while(Date.now() < deadline2 && !lines.some(l => l.includes(expectBoot))){
            await new Promise(r => setTimeout(r, 250));
        }
        for(const step of seqArg.split(';')){
            if(!step.trim()) continue;
            const [x, y, d] = step.split(',').map(Number);
            if(d) await new Promise(r => setTimeout(r, d));
            await page.mouse.click(x, y);
            console.log(`[boot-test] clicked ${x},${y}`);
            await new Promise(r => setTimeout(r, 700));
        }
    }else{
        await page.keyboard.down('a');
        await new Promise(r => setTimeout(r, 150));
        await page.keyboard.up('a');
        await new Promise(r => setTimeout(r, 300));
        await page.mouse.click(640, 400);
        await new Promise(r => setTimeout(r, 300));
        await page.mouse.wheel({deltaY: 100});
        console.log('[boot-test] sent: key a, click 640,400, wheel +100');
    }
}

// --upload FILE: after the click sequence, upload a file through the game's
// hidden native-picker input (fires real change events), then optionally
// --reload-verify to reload and dump the IdbVfs IndexedDB store keys -- used
// to reproduce data-import-then-reload persistence end to end.
const uploadFile = arg('upload', null);
if(uploadFile){
    let input = null;
    const upDeadline = Date.now() + 15000;
    while(Date.now() < upDeadline){
        input = await page.$('#ms-file-input');
        if(input) break;
        await new Promise(r => setTimeout(r, 100));
    }
    if(!input){
        console.error('[boot-test] FAIL: game never created #ms-file-input');
        process.exit(1);
    }
    await input.uploadFile(path.resolve(uploadFile));
    console.log('[boot-test] uploaded through picker:', uploadFile);
    await new Promise(r => setTimeout(r, 8000));

    if(args.includes('--reload-verify')){
        const dumpKeys = async(tag) => {
            const keys = await page.evaluate(async() => {
                return await new Promise((res, rej) => {
                    const rq = indexedDB.open('mindustry-fs');
                    rq.onsuccess = () => {
                        const db = rq.result;
                        const kr = db.transaction('files', 'readonly').objectStore('files').getAllKeys();
                        kr.onsuccess = () => { db.close(); res(kr.result); };
                        kr.onerror = () => rej(kr.error);
                    };
                    rq.onerror = () => rej(rq.error);
                });
            });
            const rel = keys.filter(k => /settings\.bin|saves\//.test(k));
            console.log(`[boot-test] ${tag}: ${keys.length} VFS entries, relevant ${rel.length}: ${JSON.stringify(rel.slice(0, 6))}`);
            return rel.length;
        };
        await dumpKeys('after-import');
        lines.length = 0;
        await page.reload({waitUntil: 'load', timeout: 120000});
        const rd = Date.now() + 120000;
        while(Date.now() < rd && !lines.some(l => l.includes('Total time to load'))){
            await new Promise(r => setTimeout(r, 250));
        }
        await new Promise(r => setTimeout(r, 3000));
        const rel = await dumpKeys('after-reload');
        if(rel === 0){
            console.error('[boot-test] FAIL: imported data did not survive reload');
            process.exit(1);
        }
        console.log('[boot-test] imported data survived reload');
    }
}

const deadline = Date.now() + waitMs;
let matched = false;
while(Date.now() < deadline){
    await new Promise(r => setTimeout(r, 250));
    if(expect && lines.some(l => l.includes(expect))){
        matched = true;
        break;
    }
}

if(screenshot){
    fs.mkdirSync(path.dirname(screenshot), {recursive: true});
    await page.screenshot({path: screenshot});
    console.log(`[boot-test] screenshot -> ${screenshot}`);
}

console.log(`[boot-test] done: ${lines.length} log lines, ${pageErrors} page errors`);

await browser.close();
server.close();

if(expect && !matched){
    console.error(`[boot-test] FAIL: expected console output containing "${expect}" within ${waitMs}ms`);
    process.exit(1);
}
