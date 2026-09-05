// End-to-end test for the browser-native file chooser (task #5):
//
//  1. boots the game to the main menu,
//  2. navigates Play -> Load Game -> Import Save, which now creates the
//     hidden <input type=file id="ms-file-input"> and clicks it (the OS
//     picker in a real browser). Headless Chrome never surfaces that
//     dialog, so this drives the input directly: puppeteer's uploadFile
//     sets .files and fires real input/change events -- exactly what a
//     user picking the file produces. The game stages the file into its
//     VFS and imports it as a save slot,
//  3. (--export x,y) clicks the imported slot's export icon, which must
//     arrive as a real browser download (captured via CDP
//     Browser.setDownloadBehavior into a temp dir) and be byte-identical
//     to the picked file (exportFile round-trips the slot's bytes).
//
// Usage:
//   node tools/fileio-test.mjs [--file some.msav] [--export x,y] [--screenshot out.png]
//   (default --file is maps/default/fortress.msav; --export 838,333 for the
//    standard 1280x800 layout after import)
import {createRequire} from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
const pickedFile = path.resolve(arg('file', path.join(webDir, 'maps/default/fortress.msav')));
const exportCoord = arg('export', null);
const dataZip = arg('data-zip', null); // Settings -> Game Data -> Import Data flow
const screenshot = arg('screenshot', null);

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png',
    '.ogg': 'audio/ogg', '.atls': 'application/octet-stream', '.msav': 'application/octet-stream'
};

const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if(p.endsWith('/')) p += 'index.html';
    const file = path.join(webDir, p);
    if(!file.startsWith(webDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()){
        res.writeHead(404); res.end('not found: ' + p);
        return;
    }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
    fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const lines = [];
let pageErrors = 0;

const browser = await puppeteer.launch({
    headless: !args.includes('--headed'),
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
    lines.push(line); console.log(line);
});
page.on('pageerror', e => { pageErrors++; console.log(`[pageerror] ${e.message}`); });

// Capture browser downloads into a temp dir.
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-downloads-'));
const cdp = await browser.target().createCDPSession();
await cdp.send('Browser.setDownloadBehavior', {behavior: 'allow', downloadPath: downloadDir});
console.log(`[fileio-test] downloads -> ${downloadDir}`);

console.log(`[fileio-test] serving ${webDir} -> http://127.0.0.1:${port}/ (picked file: ${pickedFile})`);
await page.goto(`http://127.0.0.1:${port}/index.html`, {waitUntil: 'load', timeout: 60000});

// Wait for boot.
const bootDeadline = Date.now() + 120000;
while(Date.now() < bootDeadline && !lines.some(l => l.includes('Total time to load'))){
    await new Promise(r => setTimeout(r, 250));
}
if(!lines.some(l => l.includes('Total time to load'))){
    console.error('[fileio-test] FAIL: game never reached the menu');
    process.exit(1);
}

const click = async(x, y, settle) => {
    await page.mouse.click(x, y);
    await new Promise(r => setTimeout(r, settle));
};

// Waits for the game's hidden picker input, uploads a file into it (fires
// real change events -- the headless stand-in for the OS picker), and
// settles afterwards.
async function uploadThroughPicker(file, settleMs){
    let input = null;
    const deadline = Date.now() + 10000;
    while(Date.now() < deadline){
        input = await page.$('#ms-file-input');
        if(input) break;
        await new Promise(r => setTimeout(r, 100));
    }
    if(!input) throw new Error('game never created #ms-file-input');
    await input.uploadFile(file);
    await new Promise(r => setTimeout(r, settleMs));
}

if(dataZip){
    // Settings -> Game Data -> Import Data -> confirm -> pick zip. The menu
    // is not interactive the instant the console prints "Total time to
    // load" -- cushion the first click, and retry the whole navigation a
    // few times since headless click timing occasionally misses a dialog.
        let input = null;
    // Coordinates verified by pixel-scanning the rendered dialogs (the
    // Settings rows and Game Data buttons shift between builds; don't trust
    // old numbers).
    for(let attempt = 1; attempt <= 3 && !input; attempt++){
        await click(240, 509, 3000); // Settings
        await click(660, 506, 2500); // Game Data
        await click(640, 506, 1500); // Import Data
        await page.screenshot({path: `build/shots/dataimport-confirm-${attempt}.png`});
        await click(695, 483, 2000); // confirm OK
        const deadline = Date.now() + 4000;
        while(Date.now() < deadline){
            input = await page.$('#ms-file-input');
            if(input) break;
            await new Promise(r => setTimeout(r, 100));
        }
        if(!input) console.log(`[fileio-test] nav attempt ${attempt} did not reach the picker; retrying`);
    }
    if(!input){
        console.error('[fileio-test] FAIL: never reached the file picker');
        await browser.close(); server.close();
        process.exit(1);
    }
    await input.uploadFile(path.resolve(dataZip));
    console.log('[fileio-test] uploaded data zip:', dataZip);
    // importData deletes old data, copies the zip contents, reloads
    // settings, and exits the app -- settle for all of that.
    await new Promise(r => setTimeout(r, 8000));

    if(args.includes('--verify-persist')){
        // Reproduce the user's exact scenario: import -> game exits -> page
        // reload. Dump the IdbVfs IndexedDB store keys after each phase;
        // the imported settings.bin/saves must SURVIVE the reload.
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
            const interesting = keys.filter(k => /settings\.bin|saves\//.test(k));
            console.log(`[fileio-test] ${tag}: ${keys.length} VFS entries; relevant: ${JSON.stringify(interesting.slice(0, 8))}`);
            return interesting.length;
        };
        await dumpKeys('after-import');
        await page.reload({waitUntil: 'load', timeout: 60000});
        const relDeadline = Date.now() + 120000;
        while(Date.now() < relDeadline && !lines.some(l => l.includes('Total time to load'))){
            await new Promise(r => setTimeout(r, 250));
        }
        await new Promise(r => setTimeout(r, 3000));
        const relevant = await dumpKeys('after-reload');
        if(relevant === 0){
            console.error('[fileio-test] FAIL: imported data did not survive reload (user-reported reset reproduced)');
            await browser.close(); server.close();
            process.exit(1);
        }
        console.log('[fileio-test] imported data survived reload');
        if(screenshot){
            fs.mkdirSync(path.dirname(screenshot), {recursive: true});
            await page.screenshot({path: screenshot});
        }
    }
    const bad = lines.filter(l => /FileNotFoundException|ArcRuntimeException|ZipException|DataFormatException/.test(l));
    if(bad.length > 0){
        console.error('[fileio-test] FAIL: import errors:');
        for(const l of bad) console.error('  ' + l);
        process.exit(1);
    }
    console.log('[fileio-test] data zip import clean (no file/zip errors in console)');
    await browser.close();
    server.close();
    process.exit(0);
}

if(args.includes('--boot-save')){
    // Import a save via Load Game, then click the slot and Play -- exercises
    // loading INTO a real save (world load + loading screen).
    await click(240, 231, 2500); // Play
    await click(506, 437, 2500); // Load Game
    await page.screenshot({path: 'build/shots/bootsave-dialog.png'});
    await page.mouse.click(747, 765); // Import Save
    let input = null;
    let dl = Date.now() + 10000;
    while(Date.now() < dl){
        input = await page.$('#ms-file-input');
        if(input) break;
        await new Promise(r => setTimeout(r, 100));
    }
    if(!input){ console.error('[fileio-test] FAIL: no picker'); process.exit(1); }
    await input.uploadFile(pickedFile);
    await new Promise(r => setTimeout(r, 5000));
    await page.screenshot({path: 'build/shots/bootsave-imported.png'});
    // click the imported slot (first row) then the Play button
    await page.mouse.click(400, 250);
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({path: 'build/shots/bootsave-selected.png'});
    await page.mouse.click(742, 676); // Play (dialog bottom right)
    console.log('[fileio-test] clicked play on imported slot; watching load...');
    const spam = Date.now() + 25000;
    const counts = {};
    while(Date.now() < spam){
        await new Promise(r => setTimeout(r, 1000));
    }
    for(const l of lines){
        const m = l.match(/(TypeError|RuntimeException|SaveException|DataFormat[^\n]*)/);
        if(m) counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
    console.log('[fileio-test] load-in error counts:', JSON.stringify(counts));
    const meshSpam = lines.filter(l => l.includes('$mesh9')).length;
    console.log('[fileio-test] $mesh9 spam lines:', meshSpam);
    await page.screenshot({path: 'build/shots/bootsave-world.png'});
    process.exit(0);
}

if(args.includes('--export-roundtrip')){
    // Export Data via the UI, then import the downloaded zip back -- the
    // full export->import cycle with a zip produced by THIS build (its
    // ZipOutputStream), not a desktop-made file.
    await new Promise(r => setTimeout(r, 3000));
    await click(240, 509, 3000); // Settings
    await click(660, 506, 2500); // Game Data
    await click(640, 446, 1000); // Export Data -> browser download
    let file = null;
    const dl = Date.now() + 20000;
    while(Date.now() < dl){
        const files = fs.readdirSync(downloadDir).filter(f => !f.endsWith('.crdownload'));
        if(files.length > 0){ file = path.join(downloadDir, files[0]); break; }
        await new Promise(r => setTimeout(r, 250));
    }
    if(!file){
        console.error('[fileio-test] FAIL: export produced no download');
        process.exit(1);
    }
    const data = fs.readFileSync(file);
    console.log('[fileio-test] export downloaded:', file, data.length, 'bytes; zip magic:', data[0] === 0x50 && data[1] === 0x4B ? 'OK' : 'BAD');
    if(!(data[0] === 0x50 && data[1] === 0x4B)){ process.exit(1); }
    // reload to a clean menu, then import the exported zip
    lines.length = 0;
    await page.reload({waitUntil: 'load', timeout: 120000});
    let dl2 = Date.now() + 120000;
    while(Date.now() < dl2 && !lines.some(l => l.includes('Total time to load'))) await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 3000));
    await click(240, 509, 3000); // Settings
    await click(660, 506, 2500); // Game Data
    await click(640, 506, 1500); // Import Data
    await page.screenshot({path: 'build/shots/roundtrip-confirm.png'});
    await click(695, 483, 2000); // confirm OK
    let input = null;
    dl2 = Date.now() + 10000;
    while(Date.now() < dl2){
        input = await page.$('#ms-file-input');
        if(input) break;
        await new Promise(r => setTimeout(r, 100));
    }
    if(!input){ console.error('[fileio-test] FAIL: no picker on re-import'); process.exit(1); }
    await input.uploadFile(file);
    await new Promise(r => setTimeout(r, 8000));
    const picker = lines.filter(l => l.includes('file-picker') || l.includes('data.invalid') || l.includes('[E]'));
    for(const l of picker) console.log('  ' + l);
    const stagedOk = lines.some(l => l.includes('picker done, 1 file(s) staged'));
    console.log('[fileio-test] re-import staged:', stagedOk);
    process.exit(stagedOk ? 0 : 1);
}

if(false){ // (replaced anchor guard)
    console.log('[fileio-test] data zip import clean (no file/zip errors in console)');
    await browser.close();
    server.close();
    process.exit(0);
}

// Play -> Load Game -> Import File (native picker).
await click(240, 231, 2500);
await click(506, 437, 2500);
await page.screenshot({path: 'build/shots/fileio-predialog.png'});

// Click Import File. The game creates its hidden <input type=file
// id="ms-file-input"> and clicks it; in a real browser that opens the OS
// picker. Headless Chrome never surfaces that dialog, so drive the input
// directly instead: puppeteer's uploadFile sets .files and fires real
// input/change events -- exactly what a user picking the file produces.
await page.mouse.click(747, 765);
let input = null;
const inputDeadline = Date.now() + 10000;
while(Date.now() < inputDeadline){
    input = await page.$('#ms-file-input');
    if(input) break;
    await new Promise(r => setTimeout(r, 100));
}
if(!input){
    console.error('[fileio-test] FAIL: game never created #ms-file-input');
    await browser.close(); server.close();
    process.exit(1);
}
console.log('[fileio-test] game created the native picker input; uploading file...');
await input.uploadFile(pickedFile);
console.log('[fileio-test] uploaded file:', pickedFile);

await new Promise(r => setTimeout(r, 5000));
if(screenshot){
    fs.mkdirSync(path.dirname(screenshot), {recursive: true});
    await page.screenshot({path: screenshot});
    console.log('[fileio-test] screenshot ->', screenshot);
}

let failed = false;
if(exportCoord){
    const [x, y] = exportCoord.split(',').map(Number);
    await page.mouse.click(x, y);
    console.log(`[fileio-test] clicked export at ${x},${y}; waiting for download...`);
    const dlDeadline = Date.now() + 20000;
    let found = null;
    while(Date.now() < dlDeadline){
        const files = fs.readdirSync(downloadDir).filter(f => !f.endsWith('.crdownload'));
        if(files.length > 0){ found = path.join(downloadDir, files[0]); break; }
        await new Promise(r => setTimeout(r, 250));
    }
    if(!found){
        console.error('[fileio-test] FAIL: no download arrived');
        failed = true;
    }else{
        const data = fs.readFileSync(found);
        // .msav files are zlib-wrapped on disk (0x78 ...) with "MSAV" only
        // after inflate; accept either shape.
        const zlib = data[0] === 0x78;
        const msav = data.length > 4 && data[0] === 0x4D && data[1] === 0x53 && data[2] === 0x41 && data[3] === 0x56;
        const src = fs.readFileSync(pickedFile);
        const same = src.equals(data);
        console.log(`[fileio-test] download arrived: ${found} (${data.length} bytes, header: ${zlib ? 'zlib' : msav ? 'MSAV' : 'BAD'}, matches picked file: ${same})`);
        if(!(zlib || msav) || data.length < 100 || !same) failed = true;
    }
}else{
    console.log('[fileio-test] import phase done (pass --export x,y to also test the export download)');
}

if(screenshot){
    await page.screenshot({path: screenshot.replace(/\.png$/, '') + '-final.png'});
}

await browser.close();
server.close();
console.log(`[fileio-test] done: ${lines.length} log lines, ${pageErrors} page errors`);
if(failed || pageErrors > 0) process.exit(1);
