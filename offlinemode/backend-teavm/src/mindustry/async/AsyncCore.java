package mindustry.async;

import arc.*;
import arc.struct.*;
import mindustry.game.EventType.*;

import static mindustry.Vars.*;

/**
 * Copy of core/src/mindustry/async/AsyncCore.java for the TeaVM build.
 *
 * Upstream runs each AsyncProcess on a fixed thread pool and barriers on the
 * futures at frame end. TeaVM's threads are cooperative coroutines on one
 * physical JS thread, so the pool would deliver zero real parallelism -- the
 * processes are simply executed inline in begin() instead. (The README's
 * setup section describes this as the objectively-right call for this
 * platform, not a compromise.)
 * Swapped in via source-set filtering in backend-teavm/build.gradle.
 */
public class AsyncCore{
    //all processes to be executed each frame
    public final Seq<AsyncProcess> processes = Seq.with(
        unitPhysics = new PhysicsProcess(),
        avoidance = new AvoidanceProcess()
    );

    public AsyncCore(){
        Events.on(WorldLoadEvent.class, e -> {
            for(AsyncProcess p : processes){
                p.init();
            }
        });

        Events.on(ResetEvent.class, e -> {
            for(AsyncProcess p : processes){
                p.reset();
            }
        });
    }

    public void begin(){
        if(state.isPlaying()){
            //sync begin
            for(AsyncProcess p : processes){
                p.begin();
            }

            //run all processes inline -- no parallelism exists on this platform
            for(AsyncProcess p : processes){
                if(p.shouldProcess()){
                    try{
                        p.process();
                    }catch(Throwable t){
                        throw new RuntimeException(t);
                    }
                }
            }
        }
    }

    public void end(){
        if(state.isPlaying()){
            //sync end (flush data)
            for(AsyncProcess p : processes){
                p.end();
            }
        }
    }
}
