// net-test.mjs -- end-to-end multiplayer test between two full game pages.
//
//  1. Serves the folder build + the mock signal relay (no Supabase needed),
//     or a real Supabase project when --supabase 'URL|anonkey' is given
//     (live-check mode: real Realtime signaling, real STUN/WebRTC)
//  2. Page A boots the game and hosts: Play -> Custom Game -> Glacier -> PvP
//     -> Play (PvP maps auto-host on world load, Control.java's autohost)
//  3. Page B opens the invite link (?join=CODE&signal=...) which auto-joins
//     after boot
//  4. Passes when: A hosts with 1 peer, B is connected, B received the
//     world ("Received world data"), and both pages show an in-game world.
//
// Exits 1 on any failure. Coordinates are calibrated for 1280x800
// (see build/shots/net-cal-*.png for the calibration trail).
import {createRequire} from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import {spawn} from 'child_process';

const require = createRequire('/Users/chon/code/mindustry-web/package.json');
const puppeteer = require('puppeteer-core');

const repo = '/Users/chon/code/mindustry-weboffline/teavmbackend-cc';
const webDir = path.join(repo, 'backend-teavm/build/web');
const shots = path.join(repo, 'build/shots');
fs.mkdirSync(shots, {recursive: true});
const SIGNAL_PORT = 9081;
const signalUrl = `ws://127.0.0.1:${SIGNAL_PORT}`;

// --supabase 'https://<ref>.supabase.co|<publishable/anon key>' switches the
// whole test onto a real Supabase project (no mock relay is started).
function arg(name){
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : null;
}
const supabase = arg('--supabase');

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

const relay = supabase ? null : spawn('node', [path.join(repo, 'tools/mock-signal-server.mjs'), String(SIGNAL_PORT)], {stdio:['ignore','pipe','pipe']});
if(relay) relay.stdout.on('data', d => process.stdout.write('[relay] ' + d));
// page query: mock relay override, or Supabase credential preload
const pageQuery = supabase
    ? `supabase=${encodeURIComponent(supabase)}`
    : `signal=${encodeURIComponent(signalUrl)}`;
await new Promise(r=>setTimeout(r,600));

const browserArgs = ['--no-sandbox','--disable-dev-shm-usage','--disable-features=WebRtcHideLocalIpsWithMdns',
     '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'];
// TWO SEPARATE BROWSER INSTANCES, one per player. This is load-bearing: in a
// single headless browser only one page is ever "visible", and Chrome stops
// producing requestAnimationFrame callbacks entirely for occluded pages --
// the backgrounded host's game loop (and posted-task queue) froze solid the
// moment the client page opened, which looked exactly like a deadlock. Two
// instances also mirror real usage (two machines) faithfully.
const browserA = await puppeteer.launch({
    headless: true,
    executablePath: process.env.HOME+'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: browserArgs
});
const browserB = await puppeteer.launch({
    headless: true,
    executablePath: process.env.HOME+'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: browserArgs
});

const sleep = ms => new Promise(r=>setTimeout(r,ms));
let failures = 0;
function check(name, ok, detail){
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' -- ' + detail : ''}`);
    if(!ok) failures++;
}

function watch(page, tag){
    const t0 = Date.now();
    const lines = [];
    page.on('console', m => {
        const t = m.text();
        lines.push(t);
        if(/\[net\]|\[p2p\]|world|connect|host|error|Error|kick|Failed|Timed|load/i.test(t)) console.log(`  [${tag} +${((Date.now()-t0)/1000).toFixed(1)}s] ${t.slice(0, 160)}`);
    });
    page.on('pageerror', e => { lines.push('PAGEERROR ' + e.message); console.log(`  [${tag}] PAGEERROR ${e.message}`); });
    return lines;
}

async function newGamePage(tag, browser){
    const page = await browser.newPage();
    const lines = watch(page, tag);
    await page.setViewport({width:1280,height:800,deviceScaleFactor:1});
    return {page, lines};
}
async function bootAndWaitLoaded(page, url){
    let loaded = false;
    const listener = m => { if(m.text().includes('Total time to load')) loaded = true; };
    page.on('console', listener);
    await page.goto(url, {waitUntil:'domcontentloaded'});
    const t0 = Date.now();
    while(!loaded && Date.now() - t0 < 120000) await sleep(500);
    page.off('console', listener);
    if(!loaded) throw new Error('boot timeout');
    await sleep(2000);
}

const click = async(page, x, y, settle) => { await page.mouse.click(x, y); await sleep(settle); };

try{
    // --- page A: boot + host a PvP world (autohosts) ---
    const {page: A} = await newGamePage('A', browserA);
    await bootAndWaitLoaded(A, `http://127.0.0.1:${port}/index.html?${pageQuery}`);
    console.log('[net-test] A booted; navigating to a PvP world');
    await click(A, 240, 231, 2500);   // Play
    await click(A, 493, 370, 2500);   // Custom Game
    await click(A, 419, 528, 2500);   // Glacier map card
    await click(A, 701, 268, 1200);   // PvP mode button
    await click(A, 772, 663, 2000);   // Play
    await sleep(8000);                // world load + autohost

    let stA = JSON.parse(await A.evaluate(() => window.__msNetState()));
    check('A hosts a room', stA.hosting && /^[A-Z0-9]{6}$/.test(stA.room || ''), JSON.stringify(stA));
    const code = stA.room;
    await A.screenshot({path: path.join(shots, 'net-host-world.png')});

    // --- discovery check: a third page must list the room (the "Local
    // Servers" tab path -- lobby presence, not the invite link) ---
    {
        const {page: C} = await newGamePage('C', browserB);
        await bootAndWaitLoaded(C, `http://127.0.0.1:${port}/index.html?${pageQuery}`);
        await C.evaluate(() => window.__msNetDiscoverRooms());
        let found = false;
        for(let i = 0; i < 12 && !found; i++){
            await sleep(600);
            const st = JSON.parse(await C.evaluate(() => window.__msNetState()));
            found = (st.knownRooms || 0) > 0;
        }
        check('Local Servers sees the room (lobby presence)', found);
        await C.close();
    }

    // --- page B: invite link, auto-join ---
    const {page: B, lines: linesB} = await newGamePage('B', browserB);
    console.log(`[net-test] B joining room ${code} via invite link`);
    await bootAndWaitLoaded(B, `http://127.0.0.1:${port}/index.html?${pageQuery}&join=${code}`);
    await B.evaluate(() => window.__msNetDebug && window.__msNetDebug(true));

    // world stream can take a while headless; poll for up to 90 s
    let stB = null, worldReceived = false, probed = false;
    const t0 = Date.now();
    while(Date.now() - t0 < 90000){
        stB = JSON.parse(await B.evaluate(() => window.__msNetState()));
        if(stB.connected && linesB.some(l => l.includes('Received world data'))){
            worldReceived = true;
            break;
        }
        if(!probed && Date.now() - t0 > 20000){
            probed = true;
            // diagnostic: if the join stalls, is the host's RAF loop even ticking?
            const rafA = await A.evaluate(() => new Promise(res => {
                const t0 = performance.now();
                requestAnimationFrame(() => res('alive +' + (performance.now() - t0).toFixed(0) + 'ms'));
                setTimeout(() => res('DEAD (no RAF for 3s)'), 3000);
            }));
            console.log(`[net-test] host RAF probe: ${rafA}`);
        }
        await sleep(1500);
    }

    check('B connects to the room', !!stB && stB.connected, JSON.stringify(stB));
    check('B received the world stream', worldReceived);
    if(worldReceived){
        // stability window: the post-join packet flow (snapshots, confirm
        // packets) must survive too, not just the initial world download
        await sleep(5000);
        stB = JSON.parse(await B.evaluate(() => window.__msNetState()));
        check('B stays connected after the join', stB.connected, JSON.stringify(stB));
    }
    stA = JSON.parse(await A.evaluate(() => window.__msNetState()));
    check('A sees the peer', stA.peers === 1, JSON.stringify(stA));
    await A.screenshot({path: path.join(shots, 'net-host-with-peer.png')});
    await B.screenshot({path: path.join(shots, 'net-client-world.png')});

    console.log(failures === 0 && worldReceived ? 'NET TEST PASS' : 'NET TEST FAIL');
}catch(e){
    check('test ran to completion', false, String(e));
    console.log('NET TEST FAIL');
    failures++;
}

await browserA.close(); await browserB.close(); server.close(); if(relay) relay.kill();
process.exit(failures === 0 ? 0 : 1);
