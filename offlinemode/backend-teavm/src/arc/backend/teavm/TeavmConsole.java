package arc.backend.teavm;

import org.teavm.jso.JSBody;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;

/**
 * TeaVM's java.lang.System starts with stdout/stderr wired to nothing at all
 * -- arc.util.Log (and therefore every Mindustry log line and stack trace)
 * writes through System.out.println and would simply vanish in the browser.
 * This installs line-buffered replacements backed by console.log/error.
 */
public final class TeavmConsole{

    private TeavmConsole(){}

    public static void install(){
        System.setOut(new ConsoleStream(false));
        System.setErr(new ConsoleStream(true));
    }

    static class ConsoleStream extends PrintStream{
        final boolean error;
        final StringBuilder buf = new StringBuilder(256);

        ConsoleStream(boolean error){
            // The sink is never used; every print/println overload below is
            // intercepted instead. UTF-8 charset to keep the super-constructor
            // happy on JDK18+ where the default-charset overload is deprecated.
            super(new ByteArrayOutputStream(), false, StandardCharsets.UTF_8);
            this.error = error;
        }

        private void write(String s){
            buf.append(s);
            int i;
            while((i = buf.indexOf("\n")) >= 0){
                emit(buf.substring(0, i));
                buf.delete(0, i + 1);
            }
        }

        private void emit(String line){
            if(error){
                consoleError(line);
            }else{
                consoleLog(line);
            }
        }

        @Override public void print(String s){ write(s == null ? "null" : s); }
        @Override public void println(String s){ write((s == null ? "null" : s) + "\n"); }
        @Override public void print(Object obj){ write(String.valueOf(obj)); }
        @Override public void println(Object obj){ write(String.valueOf(obj) + "\n"); }
        @Override public void print(char c){ write(String.valueOf(c)); }
        @Override public void println(char c){ write(c + "\n"); }
        @Override public void print(char[] c){ write(String.valueOf(c)); }
        @Override public void println(char[] c){ write(String.valueOf(c) + "\n"); }
        @Override public void print(boolean b){ write(String.valueOf(b)); }
        @Override public void println(boolean b){ write(b + "\n"); }
        @Override public void print(int i){ write(String.valueOf(i)); }
        @Override public void println(int i){ write(i + "\n"); }
        @Override public void print(long l){ write(String.valueOf(l)); }
        @Override public void println(long l){ write(l + "\n"); }
        @Override public void print(float f){ write(String.valueOf(f)); }
        @Override public void println(float f){ write(f + "\n"); }
        @Override public void print(double d){ write(String.valueOf(d)); }
        @Override public void println(double d){ write(d + "\n"); }
        @Override public void println(){ write("\n"); }
        @Override public PrintStream printf(String format, Object... args){ write(String.format(format, args)); return this; }
        @Override public PrintStream printf(java.util.Locale l, String format, Object... args){ write(String.format(format, args)); return this; }
        @Override public void write(int b){ write(String.valueOf((char)b)); }
        @Override public void write(byte[] b, int off, int len){ write(new String(b, off, len, StandardCharsets.UTF_8)); }
        @Override public void flush(){}
        @Override public void close(){}
    }

    @JSBody(params = "msg", script = "console.log(msg);")
    static native void consoleLog(String msg);

    @JSBody(params = "msg", script = "console.error(msg);")
    static native void consoleError(String msg);
}
