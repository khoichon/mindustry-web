package mindustry.net;

import arc.*;
import arc.func.*;
import arc.math.*;
import arc.struct.*;
import arc.util.*;
import arc.util.io.*;
import arc.util.serialization.*;
import mindustry.core.*;
import mindustry.game.*;
import mindustry.gen.*;
import mindustry.game.EventType.*;
import mindustry.net.Packets.*;
import org.teavm.jso.*;
import org.teavm.jso.typedarrays.*;

import java.io.*;
import java.nio.*;

import static mindustry.Vars.*;

/**
 * Browser multiplayer provider: WebRTC DataChannels for game data, a
 * signaling room (Supabase Realtime, or a local test relay) for everything
 * else. The page-level glue (resources/net-glue.js) owns the sockets and
 * RTCPeerConnections; this class implements mindustry's NetProvider on top of
 * the window.__msNet* bridge and mirrors desktop's ArcNetProvider semantics:
 *
 *  - JS callbacks fire in native context, so every one is marshalled through
 *    Core.app.post exactly like arcnet's net-thread -> main-thread hop
 *    (ordering preserved, no coroutine hazards).
 *  - The wire format is ArcNetProvider's PacketSerializer shape minus
 *    compression: [packet id byte][short payload length][0x00][payload].
 *    Both peers run the same bundle, so packet ids always agree; LZ4 and the
 *    arcnet framework messages (RegisterTCP etc.) are deliberately absent --
 *    they only matter for desktop-server compatibility (a later phase).
 *  - Hosting = this tab runs NetServer and one RTCPeerConnection per client;
 *    the room code is shared as ?join=CODE links. "Local Servers" discovery
 *    is the host list announced on the signaling lobby channel.
 *
 * Degrades gracefully when net-glue.js is absent (standalone build): the
 * provider throws the same friendly errors the old offline stub did.
 */
@SuppressWarnings("unused")
public class WebRtcNetProvider implements Net.NetProvider{
    /** Grows on demand; packets above ~32 kB break desktop's serializer too. */
    private ByteBuffer writeBuf = ByteBuffer.allocate(1 << 16);
    private ByteBuffer readBuf = ByteBuffer.allocate(1 << 16);

    private final Seq<WebRtcConnection> connections = new Seq<>();
    private final Seq<String> emittedRooms = new Seq<>();

    private boolean hosting, inited;
    private String room;
    private int updateTick;

    public WebRtcNetProvider(){
    }

    // ------------------------------------------------------------------ lifecycle

    private void ensureInit(){
        if(inited) return;
        inited = true;

        onClientData(view -> Core.app.post(() -> clientReceived(view)));
        onClientOpen(() -> {});
        onClientClose(reason -> Core.app.post(() -> {
            Disconnect d = new Disconnect();
            d.reason = reason;
            try{
                net.handleClientReceived(d);
            }catch(Throwable t){
                handleSilently(t);
            }
        }));
        onPeerOpen(peer -> Core.app.post(() -> peerConnected(peer)));
        onPeerClose(peer -> Core.app.post(() -> peerDisconnected(peer)));
        onPeerData((peer, view) -> Core.app.post(() -> peerReceived(peer, view)));
        onRooms(json -> Core.app.post(() -> roomsReceived(json)));
        onError(msg -> Core.app.post(() -> Log.err("[p2p] @", msg)));

        // refresh lobby presence metadata while hosting (players/map/wave)
        Events.run(Trigger.update, () -> {
            if(++updateTick % 600 == 0 && hosting){
                pushStatus();
            }
        });
        Events.on(PlayerJoin.class, e -> pushStatus());
        Events.on(PlayerLeave.class, e -> pushStatus());
    }

    private static boolean gluePresent(){
        return jsGluePresent();
    }

    // ------------------------------------------------------------------ client side

    @Override
    public void connectClient(String address, int port, Runnable success) throws IOException{
        ensureInit();
        String code = normalizeRoom(address);
        if(code == null){
            throw new IOException("The browser build joins room codes (from a friend's invite link), not IP addresses.");
        }
        if(!gluePresent()){
            throw new IOException("Multiplayer is not available in this build.");
        }

        jsJoin(code, (ok, info) -> {
            if(!ok){
                Core.app.post(() -> net.handleException(new IOException(info == null || info.isEmpty() ? "connect failed" : info)));
                return;
            }
            Core.app.post(() -> {
                Connect c = new Connect();
                c.addressTCP = "p2p:" + code;
                try{
                    net.handleClientReceived(c);
                }catch(Throwable t){
                    handleSilently(t);
                }
                success.run();
            });
        });
    }

    private void clientReceived(Uint8Array view){
        try{
            Packet packet = decode(toBytes(view));
            if(packet != null){
                net.handleClientReceived(packet);
            }
        }catch(Throwable t){
            net.handleException(t);
        }
    }

    @Override
    public void sendClient(Object object, boolean reliable){
        if(!gluePresent()) return;
        byte[] data = encode(object);
        if(data != null){
            jsSend(toView(data));
        }
    }

    @Override
    public void disconnectClient(){
        if(gluePresent()) jsCloseClient();
    }

    // ------------------------------------------------------------------ host side

    @Override
    public void hostServer(int port) throws IOException{
        ensureInit();
        if(!gluePresent()){
            throw new IOException("Multiplayer is not available in this build.");
        }

        String name = Strings.stripColors(Core.settings.getString("name", "Player"));
        if(name.isEmpty()) name = "Player";

        jsHost(name, (ok, codeOrErr) -> Core.app.post(() -> {
            if(ok){
                hosting = true;
                room = codeOrErr;
                connections.clear();
                jsShowRoom(room);
                pushStatus();
                Log.info("[p2p] Hosting room @", room);
            }else{
                // Net.host() already flipped the active/server flags -- undo them
                net.closeServer();
                net.showError(new IOException("Hosting failed: " + codeOrErr));
            }
        }));
    }

    private void peerConnected(String peer){
        WebRtcConnection con = new WebRtcConnection(peer);
        connections.add(con);
        Connect c = new Connect();
        c.addressTCP = con.address;
        try{
            net.handleServerReceived(con, c);
        }catch(Throwable t){
            handleSilently(t);
        }
    }

    private void peerDisconnected(String peer){
        WebRtcConnection con = find(peer);
        if(con == null) return;
        connections.remove(con);
        Disconnect d = new Disconnect();
        d.reason = "closed";
        try{
            net.handleServerReceived(con, d);
        }catch(Throwable t){
            handleSilently(t);
        }
    }

    private void peerReceived(String peer, Uint8Array view){
        WebRtcConnection con = find(peer);
        if(con == null) return;
        try{
            Packet packet = decode(toBytes(view));
            if(packet != null){
                net.handleServerReceived(con, packet);
            }
        }catch(Throwable t){
            Log.err("[p2p] Error reading packet from @", con.address, t);
        }
    }

    @Override
    public Iterable<? extends NetConnection> getConnections(){
        return connections;
    }

    @Override
    public void closeServer(){
        hosting = false;
        room = null;
        connections.clear();
        if(gluePresent()){
            jsStopHost();
            jsHideRoom();
        }
    }

    // ------------------------------------------------------------------ discovery

    @Override
    public void discoverServers(Cons<Host> callback, Runnable done){
        ensureInit();
        if(!gluePresent()){
            done.run();
            return;
        }
        emittedRooms.clear();
        pendingDiscovery = callback;
        jsDiscover();
        // the glue snapshots the lobby a few times over ~2.6 s while presence
        // settles; Java dedups, and `done` lands after the last snapshot
        Time.runTask(3.2f, () -> {
            pendingDiscovery = null;
            done.run();
        });
    }

    private @Nullable Cons<Host> pendingDiscovery;

    private void roomsReceived(String json){
        if(pendingDiscovery == null) return;
        try{
            Json value = new Json();
            var rooms = value.fromJson(Seq.class, RoomEntry.class, json);
            for(int i = 0; i < rooms.size; i++){
                RoomEntry r = (RoomEntry)rooms.get(i);
                if(emittedRooms.contains(r.room)) continue;
                emittedRooms.add(r.room);
                Gamemode mode;
                try{
                    mode = Gamemode.valueOf(r.mode == null ? "survival" : r.mode);
                }catch(IllegalArgumentException ex){
                    mode = Gamemode.survival;
                }
                Host host = new Host(0, r.name == null ? "Room" : r.name, r.room, port,
                    r.map == null ? "Unknown" : r.map, r.wave, Math.max(1, r.players),
                    Version.build, "official", mode, r.limit, "", r.mode);
                pendingDiscovery.get(host);
            }
        }catch(Throwable t){
            Log.err("[p2p] malformed room list", t);
        }
    }

    @Override
    public void pingHost(String address, int port, Cons<Host> valid, Cons<Exception> invalid){
        ensureInit();
        String code = normalizeRoom(address);
        if(code == null){
            invalid.get(new IOException("not a room code"));
            return;
        }
        if(!gluePresent()){
            invalid.get(new IOException("multiplayer unavailable"));
            return;
        }
        jsPing(code, (ok, jsonOrErr) -> Core.app.post(() -> {
            if(!ok){
                invalid.get(new IOException(jsonOrErr));
                return;
            }
            try{
                Json value = new Json();
                RoomEntry r = value.fromJson(RoomEntry.class, jsonOrErr);
                Gamemode mode;
                try{
                    mode = Gamemode.valueOf(r.mode == null ? "survival" : r.mode);
                }catch(IllegalArgumentException ex){
                    mode = Gamemode.survival;
                }
                Host host = new Host(0, r.name == null ? "Room" : r.name, code, port,
                    r.map == null ? "Unknown" : r.map, r.wave, Math.max(1, r.players),
                    r.version <= 0 ? Version.build : r.version, "official", mode, r.limit, "", r.mode);
                valid.get(host);
            }catch(Throwable t){
                invalid.get(new IOException(t));
            }
        }));
    }

    /** Pushes current lobby metadata (name/map/players/wave) to the signaling channel. */
    private void pushStatus(){
        if(!hosting) return;
        StringBuilder sb = new StringBuilder(128);
        sb.append("{\"name\":\"").append(escape(Core.settings.getString("name", "Server"))).append('"');
        sb.append(",\"map\":\"").append(escape(state.map == null ? "Unknown" : state.map.name())).append('"');
        sb.append(",\"players\":").append(Math.max(1, Groups.player.size()));
        sb.append(",\"wave\":").append(state.wave);
        sb.append(",\"version\":").append(Version.build);
        sb.append(",\"limit\":").append(netServer.admins.getPlayerLimit());
        sb.append(",\"mode\":\"").append(escape(state.rules.modeName == null ? "custom" : state.rules.modeName)).append('"');
        sb.append('}');
        jsUpdateStatus(sb.toString());
    }

    // ------------------------------------------------------------------ connections

    /** One WebRTC DataChannel to a client, presented to NetServer as a NetConnection. */
    public class WebRtcConnection extends NetConnection{
        public final String peerId;

        public WebRtcConnection(String peerId){
            super("p2p:" + peerId);
            this.peerId = peerId;
        }

        @Override
        public boolean isConnected(){
            return hosting && connections.contains(this);
        }

        @Override
        public void send(Object object, boolean reliable){
            if(!gluePresent()) return;
            try{
                byte[] data = encode(object);
                if(data != null){
                    jsSendTo(peerId, toView(data));
                }
            }catch(Throwable t){
                Log.err("[p2p] send failed: @", object.getClass().getSimpleName(), t);
            }
        }

        @Override
        public void close(){
            connections.remove(this);
            if(gluePresent()) jsDropPeer(peerId);
        }
    }

    private @Nullable WebRtcConnection find(String peerId){
        for(int i = 0; i < connections.size; i++){
            if(connections.get(i).peerId.equals(peerId)) return connections.get(i);
        }
        return null;
    }

    // ------------------------------------------------------------------ serializer

    /** ArcNetProvider's wire format minus compression: [id][short len][0][payload]. */
    private byte[] encode(Object object){
        if(!(object instanceof Packet pack)) return null;
        byte id = Net.getPacketId(pack);
        for(int attempt = 0; attempt < 2; attempt++){
            try{
                writeBuf.clear();
                writeBuf.put(id);
                int lenPos = writeBuf.position();
                writeBuf.putShort((short)0);
                writeBuf.put((byte)0);
                pack.write(new Writes(new ByteBufferOutput(writeBuf)));
                int len = writeBuf.position() - lenPos - 3;
                if(len > 0xffff) throw new BufferOverflowException();
                writeBuf.putShort(lenPos, (short)len);
                byte[] out = new byte[writeBuf.position()];
                writeBuf.position(0);
                writeBuf.get(out);
                return out;
            }catch(BufferOverflowException e){
                writeBuf = ByteBuffer.allocate(writeBuf.capacity() * 2);
            }
        }
        return null;
    }

    /** Inverse of {@link #encode}; returns null for empty/unknown frames. */
    private @Nullable Packet decode(byte[] data) throws IOException{
        if(data.length < 4) return null;
        ByteBuffer buf = ByteBuffer.wrap(data);
        byte id = buf.get();
        // -2 (0xFE) is arcnet's framework-message marker, which browser peers
        // never send; anything else -- including ids >= 128, which read as
        // negative bytes -- is a registered packet id (there are 200+ Call
        // packets, so high ids are the norm, not the exception).
        if(id == -2){
            StringBuilder head = new StringBuilder();
            for(int i = 0; i < Math.min(16, data.length); i++) head.append(String.format("%02x ", data[i]));
            throw new IOException("framework packet rejected, len=" + data.length + " head=[" + head + "]");
        }
        int len = buf.getShort() & 0xffff;
        byte compression = buf.get();
        if(compression != 0) throw new IOException("compressed packets are not supported between browsers");
        if(len > 0){
            if(readBuf.capacity() < len) readBuf = ByteBuffer.allocate(Math.max(len, readBuf.capacity() * 2));
            readBuf.clear();
            readBuf.put(buf.array(), buf.position(), Math.min(len, buf.remaining()));
            readBuf.position(0);
            Packet packet = Net.newPacket(id);
            packet.read(new Reads(new ByteBufferInput(readBuf)), len);
            return packet;
        }
        return null;
    }

    // ------------------------------------------------------------------ helpers

    /** "msweb:AB12CD" / "ab12cd" -> "AB12CD"; null when it is not a room code. */
    static @Nullable String normalizeRoom(String address){
        if(address == null) return null;
        String code = address.trim();
        if(code.regionMatches(true, 0, "msweb:", 0, 6)) code = code.substring(6).trim();
        return code.matches("[A-Za-z0-9]{4,10}") ? code.toUpperCase() : null;
    }

    static String escape(String s){
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for(int i = 0; i < s.length(); i++){
            char c = s.charAt(i);
            if(c == '"' || c == '\\') sb.append('\\').append(c);
            else if(c < 0x20) sb.append(' ');
            else sb.append(c);
        }
        return sb.toString();
    }

    private static void handleSilently(Throwable t){
        if(t instanceof InterruptedException) return;
        Log.err("[p2p] packet handler error", t);
    }

    static Uint8Array toView(byte[] bytes){
        Uint8Array view = new Uint8Array(bytes.length);
        for(int i = 0; i < bytes.length; i++) view.set(i, bytes[i]);
        return view;
    }

    static byte[] toBytes(Uint8Array view){
        int len = view.getLength();
        byte[] out = new byte[len];
        for(int i = 0; i < len; i++) out[i] = (byte)view.get(i);
        return out;
    }

    /** Called by the launcher replacement after boot: joins a ?join=CODE room. */
    public static void autoJoinIfPending(){
        if(!jsGluePresent()) return;
        String code = jsAutoJoin();
        if(code == null || code.isEmpty()) return;
        Time.runTask(60f, () -> {
            if(!net.active() && !state.isGame()){
                // JoinDialog refuses to connect without a name; invite links
                // often land on fresh browsers where the default is empty.
                if(player.name == null || Strings.stripColors(player.name).trim().isEmpty()){
                    String name = "Player" + Mathf.random(100, 999);
                    Core.settings.put("name", name);
                    player.name(name);
                }
                Log.info("[p2p] auto-joining room @", code);
                ui.join.connect(code, port);
            }
        });
    }

    /** Lobby presence entry as pushed by net-glue.js. */
    public static class RoomEntry{
        public String room, name, map, mode;
        public int players, wave, version, limit;
    }

    // ------------------------------------------------------------------ JS bridge

    @JSFunctor static interface BoolStrCallback extends JSObject{
        void call(boolean ok, String s);
    }
    @JSFunctor static interface StrCallback extends JSObject{
        void call(String s);
    }
    @JSFunctor static interface VoidCallback extends JSObject{
        void call();
    }
    @JSFunctor static interface BytesCallback extends JSObject{
        void call(Uint8Array data);
    }
    @JSFunctor static interface PeerBytesCallback extends JSObject{
        void call(String peer, Uint8Array data);
    }

    @JSBody(script = "return typeof window.__msNetHost === 'function';")
    static native boolean jsGluePresent();

    @JSBody(params = "cb", script = "window.__msNetOnClientData(function(v){cb(v);});")
    static native void onClientData(BytesCallback cb);
    @JSBody(params = "cb", script = "window.__msNetOnClientOpen(function(){cb();});")
    static native void onClientOpen(VoidCallback cb);
    @JSBody(params = "cb", script = "window.__msNetOnClientClose(function(r){cb(r);});")
    static native void onClientClose(StrCallback cb);
    @JSBody(params = "cb", script = "window.__msNetOnPeerOpen(function(p){cb(p);});")
    static native void onPeerOpen(StrCallback cb);
    @JSBody(params = "cb", script = "window.__msNetOnPeerClose(function(p){cb(p);});")
    static native void onPeerClose(StrCallback cb);
    @JSBody(params = "cb", script = "window.__msNetOnPeerData(function(p, v){cb(p, v);});")
    static native void onPeerData(PeerBytesCallback cb);
    @JSBody(params = "cb", script = "window.__msNetOnRooms(function(j){cb(j);});")
    static native void onRooms(StrCallback cb);
    @JSBody(params = "cb", script = "window.__msNetOnError(function(m){cb(m);});")
    static native void onError(StrCallback cb);

    @JSBody(params = {"name", "cb"}, script = "window.__msNetHost(name, function(ok, s){cb(ok, s);});")
    static native void jsHost(String name, BoolStrCallback cb);
    @JSBody(params = {"code", "cb"}, script = "window.__msNetJoin(code, function(ok, s){cb(ok, s);});")
    static native void jsJoin(String code, BoolStrCallback cb);
    @JSBody(params = {"code", "cb"}, script = "window.__msNetPing(code, function(ok, s){cb(ok, s);});")
    static native void jsPing(String code, BoolStrCallback cb);
    @JSBody(params = "view", script = "window.__msNetSend(view);")
    static native void jsSend(Uint8Array view);
    @JSBody(params = {"peer", "view"}, script = "window.__msNetSendTo(peer, view);")
    static native void jsSendTo(String peer, Uint8Array view);
    @JSBody(script = "window.__msNetCloseClient();")
    static native void jsCloseClient();
    @JSBody(script = "window.__msNetStopHost();")
    static native void jsStopHost();
    @JSBody(params = "peer", script = "window.__msNetDropPeer(peer);")
    static native void jsDropPeer(String peer);
    @JSBody(params = "json", script = "window.__msNetUpdateStatus(json);")
    static native void jsUpdateStatus(String json);
    @JSBody(script = "window.__msNetDiscoverRooms();")
    static native void jsDiscover();
    @JSBody(params = "code", script = "window.__msNetShowRoom(code);")
    static native void jsShowRoom(String code);
    @JSBody(script = "window.__msNetHideRoom();")
    static native void jsHideRoom();
    @JSBody(script = "return window.__msNetAutoJoin();")
    static native String jsAutoJoin();
}
