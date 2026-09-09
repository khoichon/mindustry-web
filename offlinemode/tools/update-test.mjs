// update-test.mjs -- boot-time update check + persistent cache bypass.
//  1. Boot the folder build; the page records its manifest hash.
//  2. Mutate the served manifest (simulates a newer build deployed by the
//     hoster / CI); trigger the update check; the reload banner must appear.
//  3. Dismissal sticks for the session.
//  4. localStorage 'mindustryweb.nocache=1' (written by the Settings ->
//     Developer options toggle) must make the next boot fetch everything
//     over the network (what the ?nocache URL flag does).
import {createRequire} from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';

const require = createRequire('/Users/chon/code/mindustry-web/package.json');
const puppeteer = require('puppeteer-core');

const repo = '/Users/chon/code/mindustry-weboffline/teavmbackend-cc';
const webDir = path.join(repo, 'backend-teavm/build/web');
const manifestPath = path.join(webDir, 'asset-manifest.txt');

const MIME = {'.html':'text/html','.js':'text/javascript','.png':'image/png','.ogg':'audio/ogg','.ttf':'font/ttf','.atls':'application/octet-stream','.msav':'application/octet-stream'};
const server = http.createServer((req,res)=>{
    let p = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(p.endsWith('/')) p += 'index.html';
    const f = path.join(webDir,p);
    if(!f.startsWith(webDir)||!fs.existsSync(f)||!fs.statSync(f).isFile()){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream','Cache-Control':'no-cache'});
    fs.createReadStream(f).pipe(res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port = server.address().port;

const browser = await puppeteer.launch({
    headless:true, executablePath: process.env.HOME+'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--no-sandbox','--disable-dev-shm-usage']
});
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok?'PASS':'FAIL'}  ${name}${detail?' -- '+detail:''}`); if(!ok) failures++; };

const page = await browser.newPage();
await page.setViewport({width:1280,height:800,deviceScaleFactor:1});
let net = 0;
page.on('request', r => { if(!r.url().includes('favicon')) net++; });
await page.goto(`http://127.0.0.1:${port}/index.html`, {waitUntil:'domcontentloaded'});
await page.waitForFunction(() => document.getElementById('ms-boot') === null, {timeout: 120000});
console.log('[update-test] booted');

// 1. banner appears when the served manifest changes after boot
const original = fs.readFileSync(manifestPath, 'utf8');
try{
    fs.appendFileSync(manifestPath, '# build 9999999999999\n');
    await page.evaluate(() => window.__msUpdateCheck());
    await new Promise(r => setTimeout(r, 1500));
    const banner = await page.evaluate(() => !!document.getElementById('ms-update'));
    check('update banner appears on newer manifest', banner);
    // 2. dismissal sticks for the session
    await page.evaluate(() => document.getElementById('ms-update-dismiss') && document.getElementById('ms-update-dismiss').click());
    await page.evaluate(() => window.__msUpdateCheck());
    await new Promise(r => setTimeout(r, 1000));
    const again = await page.evaluate(() => !!document.getElementById('ms-update'));
    check('dismissal sticks for the session', !again);
}finally{
    fs.writeFileSync(manifestPath, original);
}

// 3. localStorage nocache marker (what the Developer options toggle writes)
await page.evaluate(() => localStorage.setItem('mindustryweb.nocache', '1'));
net = 0;
await page.goto(`http://127.0.0.1:${port}/index.html`, {waitUntil:'domcontentloaded'});
await page.waitForFunction(() => document.getElementById('ms-boot') === null, {timeout: 120000});
check('localStorage nocache marker bypasses the cache', net > 300, 'requests=' + net);

await browser.close(); server.close();
console.log(failures === 0 ? 'UPDATE TEST PASS' : `UPDATE TEST FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
