// net-glue.js -- P2P multiplayer glue for the TeaVM Mindustry build.
//
// Layer cake (bottom to top):
//   1. Signal bus: either Supabase Realtime (Phoenix protocol over wss://,
//      channel names prefixed `mindustryweb_` per the shared-project naming
//      rule) or a dumb JSON WebSocket relay for local tests (`?signal=ws://`).
//      The bus carries ONLY signaling: room presence, hello/welcome,
//      offer/answer/ICE, ping. Game bytes never touch it.
//   2. WebRTC: one RTCPeerConnection per client (browser host) or one to the
//      host (browser client). All game data flows over an ordered+reliable
//      DataChannel, peer to peer. SCTP interoperability caps safe message
//      sizes near 16 KB cross-browser, so every logical message is framed:
//      one or more fragments, each prefixed with a continuation byte
//      (0 = last, 1 = more follow), and the reassembled message carries a
//      1-byte type header (0x01 = game bytes, 0x02 = heartbeat).
//   3. Java bridge: window.__msNet* entry points called from
//      WebRtcNetProvider via @JSBody, plus __msNetOn* registrars receiving
//      Java @JSFunctor callbacks. Byte payloads cross as Uint8Array views.
//      Everything degrades to an error callback when the glue is absent
//      (standalone build without this script) or signaling fails.
//
// Credentials: the Supabase project URL + anon key are entered by the user in
// a DOM dialog (shown on first use) and kept in localStorage -- they are sent
// nowhere except to that Supabase project. `?signal=` swaps in the test relay;
// `?join=CODE` records a pending join the game picks up after boot
// (__msNetAutoJoin). All names inside the shared project start with
// `mindustryweb_` (channels today; tables/functions if ever needed).
(function () {
'use strict';

var PREFIX = 'mindustryweb_';
var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I L O 0 1
var CHUNK = 16000;        // max fragment payload (SCTP-safe)
var HB_INTERVAL = 4000;   // datachannel heartbeat period
var HB_TIMEOUT = 15000;   // silence before a peer is declared dead
var JOIN_TIMEOUT = 25000; // whole join handshake budget
var PING_TIMEOUT = 3000;  // signal ping round-trip budget

var S = {
    mode: null,               // 'supabase' | 'mock'
    signalUrl: null,          // mock relay ws url
    ws: null, wsReady: false, ref: 0,
    myId: null,
    creds: null,              // {url, key}
    hosting: false, room: null,
    joined: false,            // client: on the room channel
    peers: {},                // host: peerId -> peer record
    client: null,             // client: connection record
    lobbyJoined: false, lobby: {}, lobbyWantRooms: false,
    hbTimer: null, wsHbTimer: null,
    status: { name: 'Server', map: 'Unknown', players: 1, wave: 0, version: -1, limit: 16, mode: '' },
    cbs: {},                  // java callbacks
    join: null,               // {cb, timer, done} while joining
    ping: null,               // {cb, timer} while pinging
    pendingJoins: {},         // topic -> {onReady}
    lastDiscover: 0,
    debug: false,
    stats: { rx: 0, tx: 0, rxMsg: 0, txMsg: 0 }
};

// ---------------------------------------------------------------- utils

function log() {
    try { console.log.apply(console, ['[net]'].concat([].slice.call(arguments))); } catch (e) {}
}
function err() {
    try { console.error.apply(console, ['[net]'].concat([].slice.call(arguments))); } catch (e) {}
}
function rid() {
    var s = '';
    for (var i = 0; i < 12; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return s;
}
function genCode() {
    var s = '';
    for (var i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return s;
}
function normCode(code) {
    return String(code || '').trim().toUpperCase().replace(/^MSWEB:/, '');
}
function validCode(code) {
    return /^[A-Z0-9]{4,10}$/.test(code);
}

// ---------------------------------------------------------------- credentials

function loadCreds() {
    try {
        var raw = localStorage.getItem('mindustryweb.creds');
        if (!raw) return null;
        var c = JSON.parse(raw);
        if (c && typeof c.url === 'string' && typeof c.key === 'string' && c.url.length > 8 && c.key.length > 20) return c;
    } catch (e) {}
    return null;
}
function saveCreds(url, key) {
    try { localStorage.setItem('mindustryweb.creds', JSON.stringify({ url: url, key: key })); } catch (e) {}
}
function normalizeUrl(u) {
    u = (u || '').trim().replace(/\/+$/, '');
    if (u.indexOf('http://') === 0) u = 'ws' + u.slice(4);
    else if (u.indexOf('https://') === 0) u = 'wss' + u.slice(5);
    return u;
}

var credsDialogOpen = false;
function askCreds(cb) {
    if (S.mode === 'mock') { cb(true); return; }
    if (credsDialogOpen) { cb(false); return; }
    var existing = loadCreds() || { url: '', key: '' };
    credsDialogOpen = true;

    var shade = document.createElement('div');
    shade.id = 'msnet-shade';
    shade.innerHTML =
        '<div id="msnet-box">' +
        '<div class="msnet-title">Multiplayer setup</div>' +
        '<div class="msnet-text">This build connects players peer-to-peer and needs a Supabase project ' +
        'only for signaling (finding each other). Enter the project URL and anon (public) key. They are ' +
        'stored in this browser and sent nowhere else. Everything created in the project is prefixed ' +
        '<code>' + PREFIX + '</code>, so a shared project stays tidy.</div>' +
        '<label class="msnet-label">Project URL</label>' +
        '<input id="msnet-url" type="text" spellcheck="false" placeholder="https://xxxx.supabase.co">' +
        '<label class="msnet-label">Anon public key</label>' +
        '<input id="msnet-key" type="text" spellcheck="false" placeholder="eyJ...">' +
        '<div id="msnet-err"></div>' +
        '<div class="msnet-row">' +
        '<button id="msnet-cancel">Cancel</button>' +
        '<button id="msnet-save">Save</button>' +
        '</div></div>';
    document.body.appendChild(shade);
    var urlF = shade.querySelector('#msnet-url'), keyF = shade.querySelector('#msnet-key');
    urlF.value = existing.url; keyF.value = existing.key;

    function close(ok) {
        credsDialogOpen = false;
        shade.remove();
        cb(ok);
    }
    shade.querySelector('#msnet-cancel').onclick = function () { close(false); };
    shade.querySelector('#msnet-save').onclick = function () {
        var url = normalizeUrl(urlF.value), key = keyF.value.trim();
        var bad = shade.querySelector('#msnet-err');
        if (!/\.supabase\.co$/i.test(url.replace(/^wss?:\/\//i, '').split('/')[0]) || key.length < 20) {
            bad.textContent = 'That does not look like a Supabase project URL + anon key.';
            return;
        }
        saveCreds(url, key);
        S.creds = { url: url, key: key };
        close(true);
    };
    setTimeout(function () { try { urlF.focus(); } catch (e) {} }, 50);
}

// room-code share overlay
var roomOverlay = null;
function showRoom(code) {
    hideRoom();
    var link = location.origin + location.pathname + '?join=' + code;
    if (S.mode === 'mock') link += '&signal=' + encodeURIComponent(S.signalUrl);
    roomOverlay = document.createElement('div');
    roomOverlay.id = 'msnet-room';
    roomOverlay.innerHTML =
        '<div id="msnet-room-box">' +
        '<div class="msnet-title">Room open</div>' +
        '<div class="msnet-text">Friends join with this code from the Join Game dialog, or with the link ' +
        'below (it opens the game and joins automatically).</div>' +
        '<div id="msnet-code">' + code + '</div>' +
        '<input id="msnet-link" type="text" readonly spellcheck="false">' +
        '<div class="msnet-row">' +
        '<button id="msnet-copy">Copy link</button>' +
        '<button id="msnet-close">Close</button>' +
        '</div></div>';
    document.body.appendChild(roomOverlay);
    roomOverlay.querySelector('#msnet-link').value = link;
    roomOverlay.querySelector('#msnet-copy').onclick = function () {
        var inp = roomOverlay.querySelector('#msnet-link'), btn = this;
        try {
            inp.select();
            document.execCommand('copy');
            if (navigator.clipboard) navigator.clipboard.writeText(link);
            btn.textContent = 'Copied!';
            setTimeout(function () { btn.textContent = 'Copy link'; }, 1200);
        } catch (e) {}
    };
    roomOverlay.querySelector('#msnet-close').onclick = hideRoom;
}
function hideRoom() {
    if (roomOverlay) { roomOverlay.remove(); roomOverlay = null; }
}

// ---------------------------------------------------------------- signal bus

function roomTopic(room) {
    return 'realtime:' + PREFIX + 'room_' + room;
}
function lobbyTopic() {
    return 'realtime:' + PREFIX + 'lobby';
}

function busConnect(cb) {
    if (S.ws && S.wsReady) { cb(true, ''); return; }
    if (S.ws) { cb(false, 'reconnecting'); return; }
    if (S.mode !== 'mock' && !S.creds) {
        askCreds(function (ok) {
            if (!ok) { cb(false, 'no credentials'); return; }
            busConnect(cb);
        });
        return;
    }
    // NOTE vsn: '1.0.0' exactly -- realtime-js sends this value and the server
    // rejects unknown protocol versions with HTTP 403 on the websocket
    // upgrade ('vsn=1' measured against a live project).
    var url = S.mode === 'mock' ? S.signalUrl : S.creds.url + '/realtime/v1/websocket?apikey=' + encodeURIComponent(S.creds.key) + '&vsn=1.0.0';
    if (!url) { cb(false, 'no signal url'); return; }
    var ws;
    try { ws = new WebSocket(url); }
    catch (e) { cb(false, 'bad url'); return; }
    S.ws = ws;
    ws.onopen = function () {
        S.wsReady = true;
        if (S.mode === 'supabase') {
            S.wsHbTimer = setInterval(function () {
                busRaw({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++S.ref) });
            }, 25000);
        }
        log('signal bus connected (' + S.mode + ')');
        cb(true, '');
    };
    ws.onclose = function () { busDown(); };
    ws.onerror = function () { /* onclose follows */ };
    ws.onmessage = function (ev) {
        var m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        busHandle(m);
    };
}

function busDown() {
    var wasReady = S.wsReady;
    S.ws = null; S.wsReady = false; S.joined = false; S.lobbyJoined = false; S.lobby = {};
    if (S.wsHbTimer) { clearInterval(S.wsHbTimer); S.wsHbTimer = null; }
    if (wasReady) {
        err('signal bus disconnected');
        if (S.hosting) stopHost();
        else if (S.client) clientDown('signal lost');
    }
}

function busRaw(obj) {
    if (!S.ws || !S.wsReady) return false;
    try { S.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}

// join a channel/room; onReady fires once the join is acknowledged.
// The supabase payload mirrors realtime-js exactly -- notably
// presence.enabled, without which the server never tracks presence on the
// channel (so hosts would never appear in discovery).
function roomJoin(room, onReady) {
    if (S.mode === 'supabase') {
        var topic = room === 'lobby' ? lobbyTopic() : roomTopic(room);
        S.pendingJoins[topic] = { onReady: onReady };
        busRaw({ topic: topic, event: 'phx_join', ref: String(++S.ref),
            payload: { config: {
                broadcast: { ack: false, self: false },
                presence: { key: S.myId, enabled: true },
                postgres_changes: [],
                private: false
            } } });
    } else {
        busRaw({ t: 'join', room: room, id: S.myId });
        if (onReady) onReady();
    }
}

function roomLeave(room) {
    if (S.mode === 'supabase') {
        var topic = room === 'lobby' ? lobbyTopic() : roomTopic(room);
        delete S.pendingJoins[topic];
        busRaw({ topic: topic, event: 'phx_leave', ref: String(++S.ref), payload: {} });
    } else {
        busRaw({ t: 'leave', room: room, id: S.myId });
    }
}

// broadcast obj on the room channel (supabase broadcast is room-wide, so
// recipients filter by `to` when it is set; the mock relay delivers `to` only).
function roomSend(room, obj, to) {
    obj.from = S.myId;
    if (to) obj.to = to;
    if (S.mode === 'supabase') {
        busRaw({ topic: roomTopic(room), event: 'broadcast', ref: String(++S.ref),
            payload: { type: 'broadcast', event: 'g', payload: obj } });
    } else {
        busRaw({ t: 'msg', room: room, from: S.myId, to: to || null, payload: obj });
    }
}

// update our presence metadata on the lobby channel (host status changes)
function lobbyTrack(metas) {
    if (S.mode === 'supabase') {
        // payload shape mirrors realtime-js send(): the inner type matters
        busRaw({ topic: lobbyTopic(), event: 'presence', ref: String(++S.ref),
            payload: { type: 'presence', event: 'track', payload: metas } });
    } else {
        busRaw({ t: 'metas', room: 'lobby', id: S.myId, metas: metas });
    }
}

function busHandle(m) {
    if (S.mode === 'supabase') {
        var topic = m.topic || '';
        if (m.event === 'phx_reply' && S.pendingJoins[topic]) {
            var pj = S.pendingJoins[topic];
            delete S.pendingJoins[topic];
            if (m.payload && m.payload.status === 'ok' && pj.onReady) pj.onReady();
            return;
        }
        if (m.event === 'presence_state' || m.event === 'presence_diff') {
            if (topic === lobbyTopic()) lobbyPresence(m);
            return;
        }
        if (m.event === 'broadcast' && m.payload && m.payload.type === 'broadcast') {
            var obj = m.payload.payload;
            if (obj && obj.from !== S.myId) roomMsg(obj);
            return;
        }
        return;
    }
    // mock relay dispatch
    if (m.t === 'msg') {
        var p = m.payload || {};
        if (p.from !== S.myId) roomMsg(p);
    } else if (m.t === 'roster' || m.t === 'join' || m.t === 'metas' || m.t === 'leave') {
        if (m.room === 'lobby') mockPresence(m);
    }
}

// ---------------------------------------------------------------- lobby presence

function lobbyPresence(m) {
    if (m.event === 'presence_state') {
        // the payload IS the presence map: {key: {metas: [...]}} (phoenix
        // protocol; realtime-js's transformState reads it the same way --
        // there is no .responses wrapper)
        S.lobby = {};
        var res = m.payload || {};
        for (var k in res) applyMetas((res[k] && res[k].metas) || []);
    } else {
        var joins = (m.payload && m.payload.joins) || {};
        var leaves = (m.payload && m.payload.leaves) || {};
        for (var j in joins) applyMetas((joins[j] && joins[j].metas) || []);
        for (var l in leaves) removeMetas((leaves[l] && leaves[l].metas) || []);
    }
    pushRooms();
}
function applyMetas(metas) {
    for (var i = 0; i < metas.length; i++) {
        var mt = metas[i];
        if (mt && mt.room) {
            mt.players = mt.players | 0;
            mt.wave = mt.wave | 0;
            S.lobby[mt.room] = mt;
        }
    }
}
function removeMetas(metas) {
    for (var i = 0; i < metas.length; i++) {
        var mt = metas[i];
        if (mt && mt.room) delete S.lobby[mt.room];
    }
}
function mockPresence(m) {
    if (m.t === 'roster') {
        S.lobby = {};
        var list = m.members || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i].metas && list[i].metas.room) S.lobby[list[i].metas.room] = list[i].metas;
        }
    } else if ((m.t === 'join' || m.t === 'metas') && m.metas && m.metas.room) {
        S.lobby[m.metas.room] = m.metas;
    } else if (m.t === 'leave' && m.metas && m.metas.room) {
        delete S.lobby[m.metas.room];
    }
    pushRooms();
}

function pushRooms() {
    if (!S.lobbyWantRooms || typeof S.cbs.rooms !== 'function') return;
    var arr = [];
    for (var r in S.lobby) {
        var mt = S.lobby[r];
        arr.push({
            room: r, name: mt.name || 'Room', map: mt.map || '', players: mt.players || 1,
            wave: mt.wave || 0, version: mt.version != null ? mt.version : -1,
            limit: mt.limit || 16, mode: mt.mode || ''
        });
    }
    try { S.cbs.rooms(JSON.stringify(arr)); } catch (e) { err('rooms-cb', e); }
}

// ---------------------------------------------------------------- signaling

function roomMsg(o) {
    if (o.to && o.to !== S.myId) return; // supabase broadcast is room-wide

    if (S.hosting && S.room) {
        if (o.ev === 'hello') {
            var full = Object.keys(S.peers).length >= ((S.status.limit | 0) || 16);
            roomSend(S.room, { ev: 'welcome', ok: !full, reason: full ? 'server is full' : '' }, o.from);
            if (!full) makeHostPeer(o.from);
        } else if (o.ev === 'answer' && S.peers[o.from]) {
            S.peers[o.from].pc.setRemoteDescription(o.sdp).catch(function (e) { err('answer', e); dropPeer(o.from); });
        } else if (o.ev === 'ice' && S.peers[o.from]) {
            if (o.c) S.peers[o.from].pc.addIceCandidate(o.c).catch(function (e) { err('ice-host', e); });
        } else if (o.ev === 'pingreq') {
            roomSend(S.room, { ev: 'pingresp', st: S.status }, o.from);
        }
        return;
    }

    // client side
    if (o.ev === 'welcome' && S.join && !S.join.done) {
        if (o.ok) return; // offer arrives next and completes the handshake
        settleJoin(false, o.reason || 'refused');
    } else if (o.ev === 'offer' && S.client && !S.client.pc.remoteDescription) {
        var pc = S.client.pc;
        pc.setRemoteDescription(o.sdp)
            .then(function () { return pc.createAnswer(); })
            .then(function (a) { return pc.setLocalDescription(a); })
            .then(function () { roomSend(S.room, { ev: 'answer', sdp: pc.localDescription }); })
            .catch(function (e) { err('offer', e); settleJoin(false, 'handshake failed'); });
    } else if (o.ev === 'ice' && S.client) {
        if (o.c) S.client.pc.addIceCandidate(o.c).catch(function (e) { err('ice-client', e); });
    } else if (o.ev === 'pingresp' && S.ping) {
        var p = S.ping; S.ping = null;
        clearTimeout(p.timer);
        p.cb(true, JSON.stringify(o.st || {}));
    }
}

// ---------------------------------------------------------------- webrtc: host side

function makeHostPeer(peerId) {
    if (S.peers[peerId]) return; // duplicate hello
    var peer = { pc: null, ch: null, parts: null, lastRecv: Date.now() };
    S.peers[peerId] = peer;
    try {
        peer.pc = new RTCPeerConnection(iceConfig());
    } catch (e) { delete S.peers[peerId]; err('pc', e); return; }
    peer.pc.onicecandidate = function (e) {
        roomSend(S.room, { ev: 'ice', c: candJson(e.candidate) });
    };
    var ch = peer.pc.createDataChannel('ms', { ordered: true });
    peer.ch = ch;
    wireChannel(ch, peer,
        function () {
            log('peer connected');
            callCb('peerOpen', peerId);
        },
        function (view) { callCb('peerData', peerId, view); },
        function () { dropPeer(peerId); });
    peer.pc.createOffer()
        .then(function (o) { return peer.pc.setLocalDescription(o); })
        .then(function () { roomSend(S.room, { ev: 'offer', sdp: peer.pc.localDescription }); })
        .catch(function (e) { err('offer-host', e); dropPeer(peerId); });
}

function dropPeer(peerId) {
    var p = S.peers[peerId];
    if (!p) return;
    delete S.peers[peerId];
    try { if (p.ch) p.ch.close(); } catch (e) {}
    try { if (p.pc) p.pc.close(); } catch (e) {}
    log('peer left');
    callCb('peerClose', peerId);
}

// ---------------------------------------------------------------- webrtc: client side

function startClientPeer() {
    var c = { pc: null, ch: null, parts: null, lastRecv: Date.now() };
    S.client = c;
    c.pc = new RTCPeerConnection(iceConfig());
    c.pc.onicecandidate = function (e) {
        roomSend(S.room, { ev: 'ice', c: candJson(e.candidate) });
    };
    c.pc.ondatachannel = function (e) {
        c.ch = e.channel;
        wireChannel(c.ch, c,
            function () {
                log('connected to host');
                settleJoin(true, '');
                callCb('clientOpen');
            },
            function (view) { callCb('clientData', view); },
            function () { clientDown('connection closed'); });
    };
}

function settleJoin(ok, reason) {
    if (!S.join || S.join.done) return;
    S.join.done = true;
    clearTimeout(S.join.timer);
    var cb = S.join.cb;
    S.join = null;
    if (!ok) clientAbort(reason);
    cb(ok, reason || '');
}
function clientAbort(reason) {
    if (S.client) {
        try { if (S.client.ch) S.client.ch.close(); } catch (e) {}
        try { S.client.pc.close(); } catch (e) {}
        S.client = null;
    }
    if (S.joined && S.room) { roomLeave(S.room); S.joined = false; }
    log('client aborted:', reason);
}
function clientDown(reason) {
    var had = !!S.client;
    clientAbort(reason);
    if (S.join && !S.join.done) settleJoin(false, String(reason || 'closed'));
    if (had) {
        log('client down:', reason);
        callCb('clientClose', String(reason || 'closed'));
    }
}

// ---------------------------------------------------------------- datachannel framing

function iceConfig() {
    return { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
}
function candJson(c) {
    return c ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } : null;
}

// wire a datachannel: framing + liveness. onOpen(), onData(Uint8Array), onClose().
function wireChannel(ch, holder, onOpen, onData, onClose) {
    var closed = false;
    try { ch.binaryType = 'arraybuffer'; } catch (e) {}
    ch.onopen = function () { holder.lastRecv = Date.now(); onOpen(); };
    ch.onmessage = function (e) {
        holder.lastRecv = Date.now();
        var v = new Uint8Array(e.data);
        if (v.length < 1) return;
        var piece = v.subarray(1);
        if (v[0] === 0) {
            if (holder.parts && holder.parts.length) {
                // final fragment of a multi-fragment message; appends + completes
                deliver(holder, piece, onData);
            } else {
                deliverSingle(holder, piece, onData);
            }
        } else {
            if (!holder.parts) holder.parts = [];
            holder.parts.push(piece);
        }
    };
    ch.onclose = function () { if (!closed) { closed = true; onClose(); } };
    ch.onerror = function () { /* onclose usually follows */ };
}

function deliver(holder, piece, onData) {
    var msg;
    if (holder.parts && holder.parts.length) {
        holder.parts.push(piece);
        var total = 0, i;
        for (i = 0; i < holder.parts.length; i++) total += holder.parts[i].length;
        msg = new Uint8Array(total);
        var off = 0;
        for (i = 0; i < holder.parts.length; i++) { msg.set(holder.parts[i], off); off += holder.parts[i].length; }
        holder.parts = null;
    } else {
        msg = piece;
    }
    if (msg.length < 1) return;
    if (msg[0] === 0x02) return; // heartbeat
    if (msg[0] === 0x01 && msg.length > 1) {
        S.stats.rx += msg.length - 1;
        S.stats.rxMsg++;
        if (S.debug) log('rx', msg.length - 1, 'bytes');
        onData(msg.subarray(1));
    }
}
// A complete single-fragment message arriving while a multi-fragment message
// is mid-reassembly (e.g. a heartbeat between fragments) must NOT be appended
// to the partial message -- it is its own message; only heartbeats can safely
// interleave, game messages never do (the sender emits fragments
// back-to-back), so anything else here is dropped with a note.
function deliverSingle(holder, piece, onData) {
    if (holder.parts && holder.parts.length) {
        if (piece.length === 1 && piece[0] === 0x02) return; // heartbeat mid-stream
        err('dropped out-of-band message during reassembly');
        return;
    }
    deliver(holder, piece, onData);
}

// frame and send game bytes (Uint8Array); null sends a heartbeat.
function chanSend(ch, bytes) {
    if (!ch || ch.readyState !== 'open') return false;
    try {
        if (!bytes) { ch.send(new Uint8Array([0, 0x02])); return true; }
        S.stats.tx += bytes.length;
        S.stats.txMsg++;
        if (S.debug) log('tx', bytes.length, 'bytes');
        var n = bytes.length;
        var msg = new Uint8Array(1 + n); // type header + payload
        msg[0] = 0x01;
        msg.set(bytes, 1);
        var off = 0;
        do {
            var take = Math.min(CHUNK, msg.length - off);
            var more = off + take < msg.length;
            var frag = new Uint8Array(1 + take);
            frag[0] = more ? 1 : 0;
            frag.set(msg.subarray(off, off + take), 1);
            ch.send(frag);
            off += take;
        } while (off < msg.length);
        return true;
    } catch (e) { err('send', e); return false; }
}

function startHbLoop() {
    if (S.hbTimer) return;
    S.hbTimer = setInterval(function () {
        var now = Date.now();
        if (S.hosting) {
            for (var id in S.peers) {
                var p = S.peers[id];
                if (p.ch && p.ch.readyState === 'open') {
                    if (now - p.lastRecv > HB_TIMEOUT) { log('peer timed out'); dropPeer(id); continue; }
                    chanSend(p.ch, null);
                }
            }
        } else if (S.client && S.client.ch && S.client.ch.readyState === 'open') {
            if (now - S.client.lastRecv > HB_TIMEOUT) { clientDown('timed out'); return; }
            chanSend(S.client.ch, null);
        }
    }, HB_INTERVAL);
}

function callCb(name) {
    var f = S.cbs[name];
    if (typeof f !== 'function') return;
    try { f.apply(null, [].slice.call(arguments, 1)); } catch (e) { err(name + '-cb', e); }
}

// ---------------------------------------------------------------- public API

window.__msNetOnClientData = function (cb) { S.cbs.clientData = cb; };
window.__msNetOnClientOpen = function (cb) { S.cbs.clientOpen = cb; };
window.__msNetOnClientClose = function (cb) { S.cbs.clientClose = cb; };
window.__msNetOnPeerOpen = function (cb) { S.cbs.peerOpen = cb; };
window.__msNetOnPeerClose = function (cb) { S.cbs.peerClose = cb; };
window.__msNetOnPeerData = function (cb) { S.cbs.peerData = cb; };
window.__msNetOnRooms = function (cb) { S.cbs.rooms = cb; };
window.__msNetOnError = function (cb) { S.cbs.error = cb; };

window.__msNetSetSignal = function (url) {
    S.signalUrl = String(url || '');
    S.mode = 'mock';
};

function hostMetas() {
    return {
        room: S.room, hostId: S.myId,
        name: S.status.name, map: S.status.map, players: S.status.players,
        wave: S.status.wave, version: S.status.version, limit: S.status.limit, mode: S.status.mode
    };
}

window.__msNetHost = function (name, cb) {
    if (typeof cb !== 'function') cb = function () {};
    if (S.hosting) { cb(true, S.room); return; }
    if (S.client) { cb(false, 'already connecting to a room'); return; }
    if (!S.myId) S.myId = rid();
    S.status.name = String(name || 'Server').slice(0, 40);
    startHbLoop();
    busConnect(function (ok, why) {
        if (!ok) { cb(false, 'signal connect failed: ' + why); return; }
        var code = genCode();
        S.room = code;
        roomJoin(code, function () {
            S.hosting = true;
            roomJoin('lobby', function () {
                S.lobbyJoined = true;
                lobbyTrack(hostMetas()); // presence metas ride a track push in supabase mode
                setTimeout(function () { if (S.hosting) lobbyTrack(hostMetas()); }, 3000);
                log('hosting room', code);
                cb(true, code);
            });
        });
    });
};

window.__msNetUpdateStatus = function (json) {
    try {
        var st = JSON.parse(json);
        if (typeof st.name === 'string') S.status.name = st.name.slice(0, 40);
        if (typeof st.map === 'string') S.status.map = st.map;
        if (typeof st.players === 'number') S.status.players = st.players;
        if (typeof st.wave === 'number') S.status.wave = st.wave;
        if (typeof st.version === 'number') S.status.version = st.version;
        if (typeof st.limit === 'number') S.status.limit = st.limit;
        if (typeof st.mode === 'string') S.status.mode = st.mode;
    } catch (e) { return; }
    if (S.hosting && S.lobbyJoined) lobbyTrack(hostMetas());
};

function stopHost() {
    if (!S.hosting && !S.room) return;
    S.hosting = false;
    var room = S.room;
    S.room = null;
    hideRoom();
    for (var id in S.peers) {
        try { if (S.peers[id].ch) S.peers[id].ch.close(); } catch (e) {}
        try { if (S.peers[id].pc) S.peers[id].pc.close(); } catch (e) {}
    }
    S.peers = {};
    if (room) { roomLeave(room); roomLeave('lobby'); }
    S.lobbyJoined = false;
    log('host stopped');
}
window.__msNetStopHost = stopHost;

window.__msNetJoin = function (code, cb) {
    if (typeof cb !== 'function') cb = function () {};
    if (S.hosting) { cb(false, 'cannot join while hosting'); return; }
    if (S.client) { cb(false, 'already connecting'); return; }
    code = normCode(code);
    if (!validCode(code)) { cb(false, 'not a room code'); return; }
    if (!S.myId) S.myId = rid();
    startHbLoop();
    busConnect(function (ok, why) {
        if (!ok) { cb(false, 'signal connect failed: ' + why); return; }
        S.room = code;
        S.joined = true;
        S.join = {
            cb: cb, done: false,
            timer: setTimeout(function () {
                settleJoin(false, 'could not reach the room (wrong code, or the host is gone)');
            }, JOIN_TIMEOUT)
        };
        roomJoin(code, function () {
            startClientPeer();
            roomSend(code, { ev: 'hello' });
        });
    });
};

window.__msNetSend = function (view) {
    if (S.client && S.client.ch) chanSend(S.client.ch, view);
};
window.__msNetSendTo = function (peerId, view) {
    var p = S.peers[peerId];
    if (!p || !p.ch || p.ch.readyState !== 'open') {
        log('sendTo MISSING', JSON.stringify(String(peerId)), 'keys=' + Object.keys(S.peers).join(','),
            p ? (p.ch ? 'state=' + p.ch.readyState : 'no-ch') : 'no-peer');
    }
    if (p && p.ch) chanSend(p.ch, view);
};
window.__msNetDropPeer = function (peerId) { dropPeer(String(peerId || '')); };
window.__msNetCloseClient = function () { clientDown('closed'); };

window.__msNetDiscoverRooms = function () {
    var now = Date.now();
    if (now - S.lastDiscover < 700) return; // JoinDialog double-fires; debounce
    S.lastDiscover = now;
    if (!S.myId) S.myId = rid();
    S.lobbyWantRooms = true;
    startHbLoop();
    busConnect(function (ok) {
        if (!ok) {
            S.lobbyWantRooms = false;
            pushRooms();
            return;
        }
        if (S.lobbyJoined) { pushRooms(); return; }
        roomJoin('lobby', function () {
            S.lobbyJoined = true;
            if (S.hosting) lobbyTrack(hostMetas());
            // presence syncs asynchronously; snapshot a few times after join
            setTimeout(pushRooms, 600);
            setTimeout(pushRooms, 1600);
            setTimeout(pushRooms, 2600);
        });
    });
    // stop listening for presence diffs after the snapshot window -- later
    // pushes would re-deliver rooms to a Java side that already finished
    setTimeout(function () { S.lobbyWantRooms = false; }, 3400);
};

window.__msNetPing = function (code, cb) {
    if (typeof cb !== 'function') cb = function () {};
    code = normCode(code);
    if (!validCode(code)) { cb(false, 'not a room code'); return; }
    if (!S.myId) S.myId = rid();
    busConnect(function (ok) {
        if (!ok) { cb(false, 'signal unavailable'); return; }
        if (S.lobby[code]) { cb(true, JSON.stringify(S.lobby[code])); return; }
        S.ping = {
            cb: cb,
            timer: setTimeout(function () {
                if (S.ping) { var d = S.ping; S.ping = null; d.cb(false, 'no response'); }
            }, PING_TIMEOUT)
        };
        // a direct ping needs us on the room channel to receive the reply
        if (!S.joined && S.room !== code) {
            var prev = S.room;
            S.room = code;
            roomJoin(code, function () {
                roomSend(code, { ev: 'pingreq' });
                setTimeout(function () { // leave again; we were only asking
                    if (!S.client && !S.hosting && S.room === code) { roomLeave(code); S.room = prev; }
                }, PING_TIMEOUT + 200);
            });
        } else {
            roomSend(code, { ev: 'pingreq' });
        }
    });
};

window.__msNetShowRoom = function (code) { showRoom(normCode(code)); };
window.__msNetHideRoom = hideRoom;

window.__msNetState = function () {
    return JSON.stringify({
        mode: S.mode, hosting: S.hosting, room: S.room,
        peers: Object.keys(S.peers).length,
        connected: !!(S.client && S.client.ch && S.client.ch.readyState === 'open'),
        knownRooms: Object.keys(S.lobby).length,
        rx: S.stats.rx, tx: S.stats.tx, rxMsg: S.stats.rxMsg, txMsg: S.stats.txMsg
    });
};
window.__msNetDebug = function (on) { S.debug = !!on; };

window.__msNetAutoJoin = function () {
    var q = location.search.substring(1).split('&');
    var code = null, signal = null;
    for (var i = 0; i < q.length; i++) {
        var kv = q[i].split('=');
        var k = decodeURIComponent(kv[0] || '');
        var v = decodeURIComponent(kv[1] || '');
        if (k === 'join') code = v.toUpperCase();
        if (k === 'signal' && !S.mode) signal = v;
    }
    if (signal) window.__msNetSetSignal(signal);
    return code || '';
};

// credential preload from the URL: ?supabase=https://x.supabase.co|ANONKEY
(function () {
    try {
        var q = location.search.substring(1).split('&');
        for (var i = 0; i < q.length; i++) {
            var kv = q[i].split('=');
            if (decodeURIComponent(kv[0] || '') === 'supabase' && kv[1]) {
                var parts = decodeURIComponent(kv[1]).split('|');
                if (parts.length === 2) {
                    saveCreds(normalizeUrl(parts[0]), parts[1]);
                    S.creds = { url: normalizeUrl(parts[0]), key: parts[1] };
                }
            }
        }
    } catch (e) {}
    // stored credentials count from the start -- without this the glue would
    // re-ask for credentials (and report mode:null) despite a prior save
    if (!S.creds) {
        var stored = loadCreds();
        if (stored) S.creds = stored;
    }
    if (S.creds) S.mode = 'supabase';
})();

// dialog/overlay styling (injected once)
(function () {
    var css =
        '#msnet-shade,#msnet-room{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(10,10,14,0.75);font:14px/1.5 -apple-system,\'Segoe UI\',Roboto,sans-serif}' +
        '#msnet-box,#msnet-room-box{width:420px;max-width:90vw;background:#1d1d24;border:1px solid #3a3a44;border-radius:8px;padding:22px;color:#c9c9d4;box-shadow:0 12px 40px rgba(0,0,0,.5)}' +
        '.msnet-title{font-size:18px;font-weight:600;color:#ffd37f;margin-bottom:10px}' +
        '.msnet-text{font-size:13px;color:#9c9ca8;margin-bottom:14px}' +
        '.msnet-label{display:block;font-size:12px;color:#7d7d8a;margin:10px 0 4px}' +
        '#msnet-box input,#msnet-room input{width:100%;box-sizing:border-box;background:#131318;border:1px solid #3a3a44;border-radius:4px;color:#e6e6ee;padding:8px 10px;font:13px/1.4 monospace}' +
        '#msnet-err{color:#ff7b72;font-size:12px;min-height:16px;margin-top:8px}' +
        '.msnet-row{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}' +
        '.msnet-row button{background:#2c2c36;color:#e6e6ee;border:1px solid #4a4a56;border-radius:4px;padding:8px 16px;cursor:pointer;font-size:13px}' +
        '.msnet-row button:hover{background:#3a3a48}' +
        '#msnet-code{font:28px/1.2 monospace;letter-spacing:.35em;text-align:center;color:#ffd37f;background:#131318;border:1px dashed #4a4a56;border-radius:6px;padding:14px 0;margin:6px 0 10px}' +
        '#msnet-room input{font-size:11px}' +
        '#msnet-box code{color:#ffd37f}';
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
})();

window.__msNetLoads = (window.__msNetLoads | 0) + 1; // double-load detector for debugging
log('net glue loaded');
})();
