package arc.net;

/**
 * Minimal offline stub of the arcnet Server type.
 *
 * mindustry.net.Net (upstream, unmodified) references exactly one arcnet
 * symbol -- Server.ServerConnectFilter, in NetProvider's default
 * setConnectFilter/getConnectFilter methods -- so this keeps the whole
 * upstream Net.java compiling without pulling in the arcnet module, whose
 * NIO-socket implementation cannot compile under TeaVM. ArcNetProvider (the
 * only real consumer) is excluded from the TeaVM build; networking goes
 * through TeavmNetProvider instead.
 */
public class Server{
    public interface ServerConnectFilter{
        boolean accept(String address);
    }
}
