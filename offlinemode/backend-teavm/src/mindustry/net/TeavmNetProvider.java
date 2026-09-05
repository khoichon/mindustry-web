package mindustry.net;

import arc.func.Cons;
import arc.struct.Seq;

import java.io.IOException;

/**
 * Offline NetProvider for the browser build: the browser cannot open raw
 * TCP/UDP sockets, and TeaVM's classlib has no socket APIs at all.
 *
 * Ported from the CheerpJ reference build's browser.OfflineNetProvider
 * (written against this same Net.NetProvider interface); a future milestone
 * could replace it with a WebSocket/WebTransport bridge for real multiplayer.
 */
public class TeavmNetProvider implements Net.NetProvider{
    @Override
    public void connectClient(String address, int port, Runnable success) throws IOException{
        throw new IOException("Multiplayer is not yet available in the browser build");
    }

    @Override
    public void sendClient(Object object, boolean reliable){
    }

    @Override
    public void disconnectClient(){
    }

    @Override
    public void discoverServers(Cons<Host> callback, Runnable done){
        done.run();
    }

    @Override
    public void pingHost(String address, int port, Cons<Host> valid, Cons<Exception> invalid){
        invalid.get(new IOException("Network unavailable in browser build"));
    }

    @Override
    public void hostServer(int port) throws IOException{
        throw new IOException("Hosting is not yet available in the browser build");
    }

    @Override
    public Iterable<? extends NetConnection> getConnections(){
        return new Seq<>();
    }

    @Override
    public void closeServer(){
    }
}
