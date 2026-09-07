// mock-signal-server.mjs -- minimal signaling relay for tests.
//
// Stands in for Supabase Realtime so the WebRTC multiplayer path can be
// exercised end-to-end without any Supabase project (tools/net-test.mjs,
// glue tests). Speaks the JSON protocol net-glue.js expects in mock mode:
//
//   client -> server:
//     {t:'join',  room, id, metas?}   join a room (announces presence)
//     {t:'leave', room, id}           leave it
//     {t:'metas', room, id, metas}    update presence metadata
//     {t:'msg',   room, from, to?, payload}  relay (to=null: everyone else)
//   server -> client:
//     {t:'roster', room, members:[{id, metas}]}  sent to the joiner
//     {t:'join'|'leave'|'metas', room, id, metas} broadcast to the room
//     {t:'msg', room, from, to, payload}         relayed message
//
// Usage: node tools/mock-signal-server.mjs [port]   (default 9022)
import {createRequire} from 'module';
const require = createRequire('/Users/chon/code/mindustry-web/package.json');
const {WebSocketServer} = require('ws');

const port = Number(process.argv[2] || 9022);
const wss = new WebSocketServer({port});
/** room -> Map(id -> {ws, metas}) */
const rooms = new Map();

function roomOf(name){
    if(!rooms.has(name)) rooms.set(name, new Map());
    return rooms.get(name);
}
function broadcast(room, obj, exceptId){
    const text = JSON.stringify(obj);
    for(const [id, m] of roomOf(room)){
        if(id !== exceptId && m.ws.readyState === 1) m.ws.send(text);
    }
}
function send(ws, obj){ if(ws.readyState === 1) ws.send(JSON.stringify(obj)); }

wss.on('connection', ws => {
    let joined = new Set();

    ws.on('message', data => {
        let m;
        try{ m = JSON.parse(data.toString()); }catch(e){ return; }
        if(!m || typeof m.t !== 'string') return;

        if(m.t === 'join' && m.room && m.id){
            const room = roomOf(m.room);
            room.set(m.id, {ws, metas: m.metas || {}});
            joined.add(m.room);
            send(ws, {t:'roster', room: m.room, members: [...room].map(([id, v]) => ({id, metas: v.metas}))});
            broadcast(m.room, {t:'join', room: m.room, id: m.id, metas: m.metas || {}}, m.id);
        }else if(m.t === 'leave' && m.room && m.id){
            const room = roomOf(m.room);
            const metas = room.get(m.id)?.metas || {};
            room.delete(m.id);
            joined.delete(m.room);
            broadcast(m.room, {t:'leave', room: m.room, id: m.id, metas});
        }else if(m.t === 'metas' && m.room && m.id){
            const entry = roomOf(m.room).get(m.id);
            if(entry) entry.metas = m.metas || {};
            broadcast(m.room, {t:'metas', room: m.room, id: m.id, metas: m.metas || {}}, m.id);
        }else if(m.t === 'msg' && m.room && m.from){
            const room = roomOf(m.room);
            if(m.to){
                const target = room.get(m.to);
                if(target) send(target.ws, m);
            }else{
                for(const [id, v] of room){
                    if(id !== m.from && v.ws.readyState === 1) v.ws.send(JSON.stringify(m));
                }
            }
        }
    });

    ws.on('close', () => {
        // leave every room this socket joined (ids are message-level; scan)
        for(const name of joined){
            const room = roomOf(name);
            for(const [id, v] of [...room]){
                if(v.ws === ws){
                    room.delete(id);
                    broadcast(name, {t:'leave', room: name, id, metas: v.metas || {}});
                }
            }
        }
        joined.clear();
    });
});

// test introspection over plain http (GET /state -> rooms + presence)
import http from 'http';
http.createServer((req, res) => {
    const out = {};
    for(const [name, room] of rooms) out[name] = [...room].map(([id, v]) => ({id, metas: v.metas}));
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(out));
}).listen(port + 1);

console.log(`[mock-signal] listening on ws://127.0.0.1:${port} (state on :${port + 1})`);
