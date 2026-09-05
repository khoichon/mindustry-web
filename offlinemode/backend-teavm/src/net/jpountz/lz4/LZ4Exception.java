package net.jpountz.lz4;

/**
 * Minimal offline stub of lz4-java's LZ4Exception.
 *
 * mindustry.net.Net (upstream, unmodified) references it once, in a packet
 * error-classification branch. In the browser build compression only ever
 * ran inside ArcNetProvider's socket path, which is excluded; nothing
 * constructs or throws this. It exists purely so the wildcard import in
 * upstream Net.java resolves.
 */
public class LZ4Exception extends RuntimeException{
    public LZ4Exception(){
    }

    public LZ4Exception(String message){
        super(message);
    }

    public LZ4Exception(String message, Throwable cause){
        super(message, cause);
    }
}
