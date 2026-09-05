package arc.backend.teavm;

import org.teavm.extension.Autoregistered;
import org.teavm.extension.spi.reflection.SimpleReflectionPolicy;

/**
 * Compile-time TeaVM extension, NOT part of the emitted game code (nothing
 * references it at runtime, so dead-code elimination drops it from the JS).
 *
 * Why this exists: TeaVM only exposes a field to java.lang.reflect when the
 * dependency analyzer saw it accessed by ordinary code somewhere in the
 * program. arc's Json -- which Mindustry uses for settings, saves,
 * schematics, rules and mod metadata -- enumerates fields purely
 * reflectively via getDeclaredFields(), so under a stock TeaVM build every
 * serialized class degenerates to
 * "SerializationException: Field not found: <name> (<Class>)" at runtime
 * (first observed: Rules.spawns while loading the Vars asset).
 *
 * The fix per TeaVM's "Compiler extensions" docs: a ReflectionPolicy,
 * discovered by the TeaVM compiler through ServiceLoader (the
 * \@Autoregistered annotation processor writes the META-INF/services
 * entry), declaring which members reflection may see. Here: every
 * non-transient instance field of every arc/mindustry class, restoring
 * JVM-like behavior for Json at the cost of keeping those fields alive.
 */
@Autoregistered
public class TeavmReflectionPolicy extends SimpleReflectionPolicy{
    @Override
    protected void setup(){
        // INSTANCE to skip statics (Json never reads them), not(TRANSIENT)
        // because arc Json skips transient fields anyway -- neither needs
        // reflection metadata paid for in output size.
        //
        // Scope deliberately narrow: every reflectable field drags its TYPE
        // into TeaVM's dependency graph, and a policy covering all of
        // arc+mindustry exhausts the Gradle daemon's 8 GiB heap during the
        // TeaVM compile (and arc.struct alone crashes the compiler outright
        // with a bare NPE in its metadata generation). What Json actually
        // walks reflectively is the Mindustry data classes (Rules,
        // Schematics, mod metadata, map objectives, content) plus the arc
        // VALUE types those reference (Color, Vec2/geometry). Collections
        // (Seq/ObjectMap/IntSeq) have their own Json read/write paths and
        // never need their internal fields reflectable. If a serialized
        // type is ever missing, arc Json names it precisely at runtime:
        // "SerializationException: Field not found: <field> (<class>)" --
        // add that class's package here.
        selectPackage("mindustry", true)
            .reflectableFields(f -> INSTANCE.test(f) && !TRANSIENT.test(f))
            // arc Json instantiates deserialized classes through their
            // no-arg constructor reflectively (Json.newDefaultInstance ->
            // getDeclaredConstructor); TeaVM models constructors as methods
            // named <init>, so they ride the same reflectable-methods path.
            .reflectableMethods(m -> m.name().equals("<init>"));
        selectPackage("arc.graphics", true)
            .reflectableFields(f -> INSTANCE.test(f) && !TRANSIENT.test(f))
            // Json also CONSTRUCTS arc value types it finds in serialized
            // data (Color, Vec2, ...) through their no-arg ctors -- without
            // this, launching a map dies at "Error constructing instance of
            // class: arc.math.geom.Vec2" inside Rules.objectives.
            .reflectableMethods(m -> m.name().equals("<init>"));
        selectPackage("arc.math", true)
            .reflectableFields(f -> INSTANCE.test(f) && !TRANSIENT.test(f))
            .reflectableMethods(m -> m.name().equals("<init>"));
        // arc.struct gets constructors only: arc Json special-cases the
        // collection VALUES but still instantiates the collection class
        // itself reflectively (e.g. an ObjectIntMap field), and reflectable
        // FIELDS on arc.struct crash the TeaVM compiler (see note above).
        selectPackage("arc.struct", true).reflectableMethods(m -> m.name().equals("<init>"));
    }
}
