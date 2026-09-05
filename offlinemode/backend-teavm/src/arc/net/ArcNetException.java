package arc.net;

/**
 * Copy of extensions/arcnet/src/arc/net/ArcNetException.java, verbatim.
 * mindustry.net.Net (upstream, unmodified) instanceof-checks against this
 * type in handleException, so it must exist even though the browser build
 * never opens a socket. See Server.java for the rest of the arcnet stub.
 */
public class ArcNetException extends RuntimeException{
    public ArcNetException(){
        super();
    }

    public ArcNetException(String message, Throwable cause){
        super(message, cause);
    }

    public ArcNetException(String message){
        super(message);
    }

    public ArcNetException(Throwable cause){
        super(cause);
    }
}
