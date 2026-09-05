package arc.backend.teavm;

import arc.ApplicationListener;
import arc.Core;
import arc.graphics.GL20;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;
import java.nio.ShortBuffer;

/**
 * First real rendering milestone: a colored quad built from an interleaved
 * position+color vertex buffer and an index buffer, drawn via the
 * offset-based glDrawElements path -- the same shape of pipeline
 * Mindustry's own Mesh/SpriteBatch rendering uses (interleaved attributes,
 * IBO-based indexed draws), not just a trivial single-triangle sanity check.
 *
 * Exercises, in one pass: shader compile + link + status checking
 * (glGetShaderiv/glGetProgramiv, added specifically for this), vertex
 * buffer upload (glBufferData(Buffer)), index buffer upload, attribute
 * binding with a real stride/offset (glVertexAttribPointer), and an
 * indexed draw call (glDrawElements, offset-based overload).
 *
 * If this renders a quad with four different-colored corners blending
 * smoothly toward the center, every one of those pieces is confirmed
 * working together, not just individually.
 */
public class TeavmTriangleTest implements ApplicationListener {
    private long[] frameProbe;
    private int program;
    private int vbo, ibo;
    private int positionLoc, colorLoc;

    // Vertex shader: GLSL ES 1.00 (attribute/varying, no #version pragma) --
    // deliberately matching the style Arc/Mindustry's own shaders use
    // (targeting GL20/GLES2), not GLSL ES 3.00. WebGL2 accepts ES 1.00
    // shaders in backward-compatible mode, so this doubles as a check that
    // Mindustry's actual shader sources will compile here too.
    private static final String VERTEX_SHADER =
        "attribute vec2 a_position;\n" +
        "attribute vec4 a_color;\n" +
        "varying vec4 v_color;\n" +
        "void main() {\n" +
        "    v_color = a_color;\n" +
        "    gl_Position = vec4(a_position, 0.0, 1.0);\n" +
        "}\n";

    private static final String FRAGMENT_SHADER =
        "precision mediump float;\n" +
        "varying vec4 v_color;\n" +
        "void main() {\n" +
        "    gl_FragColor = v_color;\n" +
        "}\n";

    @Override
    public void init() {
        GL20 gl = Core.gl20;

        int vertexShader = compileShader(gl, GL20.GL_VERTEX_SHADER, VERTEX_SHADER);
        int fragmentShader = compileShader(gl, GL20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER);

        program = gl.glCreateProgram();
        gl.glAttachShader(program, vertexShader);
        gl.glAttachShader(program, fragmentShader);
        gl.glLinkProgram(program);

        IntBuffer linkStatus = IntBuffer.allocate(1);
        gl.glGetProgramiv(program, GL20.GL_LINK_STATUS, linkStatus);
        if (linkStatus.get(0) == 0) {
            throw new RuntimeException("Program link failed: " + gl.glGetProgramInfoLog(program));
        }
        gl.glDeleteShader(vertexShader);
        gl.glDeleteShader(fragmentShader);

        positionLoc = gl.glGetAttribLocation(program, "a_position");
        colorLoc = gl.glGetAttribLocation(program, "a_color");

        // Interleaved per-vertex layout: x, y, r, g, b, a (6 floats = 24 bytes
        // stride) -- same interleaving pattern Mindustry's Mesh class uses for
        // position+color(+uv) vertex attributes, not a simplified separate-
        // arrays layout, so this is a real test of the stride/offset math in
        // glVertexAttribPointer, not just of "can we draw anything at all."
        float[] vertices = {
            -0.5f, -0.5f,   1f, 0.2f, 0.2f, 1f, // bottom-left: red
             0.5f, -0.5f,   0.2f, 1f, 0.2f, 1f, // bottom-right: green
             0.5f,  0.5f,   0.2f, 0.2f, 1f, 1f, // top-right: blue
            -0.5f,  0.5f,   1f, 1f, 1f, 1f,     // top-left: white
        };
        short[] indices = { 0, 1, 2, 2, 3, 0 };

        FloatBuffer vertexBuffer = ByteBuffer.allocateDirect(vertices.length * 4)
            .order(ByteOrder.nativeOrder()).asFloatBuffer();
        vertexBuffer.put(vertices).flip();

        ShortBuffer indexBuffer = ByteBuffer.allocateDirect(indices.length * 2)
            .order(ByteOrder.nativeOrder()).asShortBuffer();
        indexBuffer.put(indices).flip();

        vbo = gl.glGenBuffer();
        gl.glBindBuffer(GL20.GL_ARRAY_BUFFER, vbo);
        gl.glBufferData(GL20.GL_ARRAY_BUFFER, vertices.length * 4, vertexBuffer, GL20.GL_STATIC_DRAW);

        ibo = gl.glGenBuffer();
        gl.glBindBuffer(GL20.GL_ELEMENT_ARRAY_BUFFER, ibo);
        gl.glBufferData(GL20.GL_ELEMENT_ARRAY_BUFFER, indices.length * 2, indexBuffer, GL20.GL_STATIC_DRAW);
    }

    private int compileShader(GL20 gl, int type, String source) {
        int shader = gl.glCreateShader(type);
        gl.glShaderSource(shader, source);
        gl.glCompileShader(shader);

        IntBuffer status = IntBuffer.allocate(1);
        gl.glGetShaderiv(shader, GL20.GL_COMPILE_STATUS, status);
        if (status.get(0) == 0) {
            String log = gl.glGetShaderInfoLog(shader);
            throw new RuntimeException("Shader compile failed (" +
                (type == GL20.GL_VERTEX_SHADER ? "vertex" : "fragment") + "): " + log);
        }
        return shader;
    }

    @Override
    public void update() {
        GL20 gl = Core.gl20;

        // TEMP instrumentation: prove the RAF loop + delta time are alive.
        if(frameProbe == null) frameProbe = new long[]{Core.graphics.getFrameId(), System.currentTimeMillis()};
        if(Core.graphics.getFrameId() - frameProbe[0] >= 30){
            arc.util.Log.info("[probe] frameId=@ dt=@ fps=@",
                Core.graphics.getFrameId(), Core.graphics.getDeltaTime(), Core.graphics.getFramesPerSecond());
            frameProbe[0] = Core.graphics.getFrameId();
        }

        // TEMP instrumentation: prove input wiring (keys, taps, wheel, mouse
        // position in arc's bottom-left-origin pixel space) works end to end.
        if(Core.input.keyTap(arc.input.KeyCode.a)) arc.util.Log.info("[probe] keyTap a");
        if(Core.input.keyTap(arc.input.KeyCode.mouseLeft)) arc.util.Log.info("[probe] tap mouseLeft @ @", Core.input.mouseX(), Core.input.mouseY());
        float scroll = Core.input.axis(arc.input.KeyCode.scroll);
        if(scroll != 0) arc.util.Log.info("[probe] scroll axis @", scroll);

        gl.glClearColor(0.10f, 0.10f, 0.14f, 1f);
        gl.glClear(GL20.GL_COLOR_BUFFER_BIT);

        gl.glUseProgram(program);

        gl.glBindBuffer(GL20.GL_ARRAY_BUFFER, vbo);
        gl.glEnableVertexAttribArray(positionLoc);
        gl.glVertexAttribPointer(positionLoc, 2, GL20.GL_FLOAT, false, 24, 0);
        gl.glEnableVertexAttribArray(colorLoc);
        gl.glVertexAttribPointer(colorLoc, 4, GL20.GL_FLOAT, false, 24, 8);

        gl.glBindBuffer(GL20.GL_ELEMENT_ARRAY_BUFFER, ibo);
        gl.glDrawElements(GL20.GL_TRIANGLES, 6, GL20.GL_UNSIGNED_SHORT, 0);
    }
}
