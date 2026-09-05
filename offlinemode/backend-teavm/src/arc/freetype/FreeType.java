package arc.freetype;

import arc.files.Fi;
import arc.graphics.Color;
import arc.graphics.Pixmap;
import arc.struct.LongMap;
import arc.util.ArcRuntimeException;
import arc.util.Buffers;
import arc.util.Disposable;
import org.teavm.jso.JSBody;
import org.teavm.jso.typedarrays.Uint8Array;

import java.nio.ByteBuffer;
import java.nio.IntBuffer;

/**
 * Drop-in replacement for arc-freetype's JNI-bound FreeType.java, backed by
 * opentype.js + Canvas2D rasterization instead of the native FreeType
 * library. Same package, same class name, same public surface as the
 * original, so FreeTypeFontGenerator and the asset loaders compile and run
 * unmodified; swapped in via source-set filtering in the TeaVM build (the
 * original is excluded; TeaVM cannot compile classes with `native` methods,
 * even dead ones).
 *
 * Ported from the CheerpJ reference build's shim/natives-freetype.js, which
 * encodes the conventions that matter:
 *  - every metric handed to Java is in 26.6 fixed point (toInt() converts);
 *  - rasterized bitmaps are 8-bit alpha (FT_PIXEL_MODE_GRAY == 2);
 *  - the stroker takes a radius, so canvas lineWidth = radius * 2;
 *  - bitmap top is rows above the baseline (y-up).
 *
 * The JS side lives in resources/freetype-glue.js (globalThis.ArcFreeType);
 * objects are referenced from Java through int handles.
 */
public class FreeType{
    public static final int FT_PIXEL_MODE_NONE = 0;
    public static final int FT_PIXEL_MODE_MONO = 1;
    public static final int FT_PIXEL_MODE_GRAY = 2;
    public static final int FT_PIXEL_MODE_GRAY2 = 3;
    public static final int FT_PIXEL_MODE_GRAY4 = 4;
    public static final int FT_PIXEL_MODE_LCD = 5;
    public static final int FT_PIXEL_MODE_LCD_V = 6;

    public static final int FT_FACE_FLAG_SCALABLE = 1 << 0;
    public static final int FT_FACE_FLAG_FIXED_SIZES = 1 << 1;
    public static final int FT_FACE_FLAG_FIXED_WIDTH = 1 << 2;
    public static final int FT_FACE_FLAG_SFNT = 1 << 3;
    public static final int FT_FACE_FLAG_HORIZONTAL = 1 << 4;
    public static final int FT_FACE_FLAG_VERTICAL = 1 << 5;
    public static final int FT_FACE_FLAG_KERNING = 1 << 6;
    public static final int FT_FACE_FLAG_FAST_GLYPHS = 1 << 7;
    public static final int FT_FACE_FLAG_MULTIPLE_MASTERS = 1 << 8;
    public static final int FT_FACE_FLAG_GLYPH_NAMES = 1 << 9;
    public static final int FT_FACE_FLAG_HINTER = 1 << 10;
    public static final int FT_FACE_FLAG_CID_KEYED = 1 << 11;
    public static final int FT_FACE_FLAG_TRICKY = 1 << 12;

    public static final int FT_STYLE_FLAG_ITALIC = 1 << 0;
    public static final int FT_STYLE_FLAG_BOLD = 1 << 1;

    public static final int FT_LOAD_DEFAULT = 0x0;
    public static final int FT_LOAD_NO_SCALE = 0x1;
    public static final int FT_LOAD_NO_HINTING = 0x2;
    public static final int FT_LOAD_RENDER = 0x4;
    public static final int FT_LOAD_NO_BITMAP = 0x8;
    public static final int FT_LOAD_VERTICAL_LAYOUT = 0x10;
    public static final int FT_LOAD_FORCE_AUTOHINT = 0x20;
    public static final int FT_LOAD_CROP_BITMAP = 0x40;
    public static final int FT_LOAD_PEDANTIC = 0x80;
    public static final int FT_LOAD_IGNORE_GLOBAL_ADVANCE_WIDTH = 0x200;
    public static final int FT_LOAD_NO_RECURSE = 0x400;
    public static final int FT_LOAD_IGNORE_TRANSFORM = 0x800;
    public static final int FT_LOAD_MONOCHROME = 0x1000;
    public static final int FT_LOAD_LINEAR_DESIGN = 0x2000;
    public static final int FT_LOAD_NO_AUTOHINT = 0x8000;
    public static final int FT_LOAD_TARGET_NORMAL = 0x0;
    public static final int FT_LOAD_TARGET_LIGHT = 0x10000;
    public static final int FT_LOAD_TARGET_MONO = 0x20000;
    public static final int FT_LOAD_TARGET_LCD = 0x30000;
    public static final int FT_LOAD_TARGET_LCD_V = 0x40000;

    public static final int FT_RENDER_MODE_NORMAL = 0;
    public static final int FT_RENDER_MODE_LIGHT = 1;
    public static final int FT_RENDER_MODE_MONO = 2;
    public static final int FT_RENDER_MODE_LCD = 3;
    public static final int FT_RENDER_MODE_LCD_V = 4;
    public static final int FT_RENDER_MODE_MAX = 5;

    public static final int FT_KERNING_DEFAULT = 0;
    public static final int FT_KERNING_UNFITTED = 1;
    public static final int FT_KERNING_UNSCALED = 2;

    public static final int FT_STROKER_LINECAP_BUTT = 0;
    public static final int FT_STROKER_LINECAP_ROUND = 1;
    public static final int FT_STROKER_LINECAP_SQUARE = 2;
    public static final int FT_STROKER_LINEJOIN_ROUND = 0;
    public static final int FT_STROKER_LINEJOIN_BEVEL = 1;
    public static final int FT_STROKER_LINEJOIN_MITER_VARIABLE = 2;
    public static final int FT_STROKER_LINEJOIN_MITER = FT_STROKER_LINEJOIN_MITER_VARIABLE;
    public static final int FT_STROKER_LINEJOIN_MITER_FIXED = 3;

    public static Library initFreeType(){
        return new Library(glueInit());
    }

    public static int toInt(int value){
        return ((value + 63) & -64) >> 6;
    }

    public static int fromInt(int value){
        return value << 6;
    }

    private static class Pointer{
        final int address;

        Pointer(int address){
            this.address = address;
        }
    }

    public static class Library extends Pointer implements Disposable{
        LongMap<ByteBuffer> fontData = new LongMap<>();

        Library(int address){
            super(address);
        }

        @Override
        public void dispose(){
            glueDispose(address);
        }

        public Face newFace(Fi font, int faceIndex){
            byte[] data = font.readBytes();
            return newMemoryFace(data, data.length, faceIndex);
        }

        public Face newMemoryFace(byte[] data, int dataSize, int faceIndex){
            ByteBuffer buffer = Buffers.newUnsafeByteBuffer(data.length);
            Buffers.copy(data, 0, buffer, data.length);
            return newMemoryFace(buffer, faceIndex);
        }

        public Face newMemoryFace(ByteBuffer buffer, int faceIndex){
            // Copy the Java-side bytes into a JS typed array for opentype.js.
            int n = buffer.remaining();
            Uint8Array bytes = new Uint8Array(n);
            for(int i = 0; i < n; i++){
                bytes.set(i, buffer.get(buffer.position() + i));
            }
            int face = glueNewFace(address, bytes, faceIndex);
            if(face == 0){
                throw new ArcRuntimeException("Couldn't parse font file (opentype.js): " + glueParseError());
            }
            Face result = new Face(face);
            result.sizePx = 16;
            return result;
        }

        public Stroker createStroker(){
            return new Stroker(glueStrokerNew(address));
        }
    }

    public static class Face extends Pointer implements Disposable{
        int sizePx;

        Face(int address){
            super(address);
        }

        @Override
        public void dispose(){
            glueDispose(address);
        }

        public int getFaceFlags(){
            return glueGetFaceFlags(address);
        }

        public int getStyleFlags(){
            return 0;
        }

        public int getNumGlyphs(){
            return glueGetNumGlyphs(address);
        }

        public boolean selectSize(int strikeIndex){
            return false;
        }

        public boolean setCharSize(int charWidth, int charHeight, int horzResolution, int vertResolution){
            return glueSetCharSize(address, charWidth, charHeight, horzResolution, vertResolution);
        }

        public boolean setPixelSizes(int pixelWidth, int pixelHeight){
            return glueSetPixelSizes(address, pixelWidth, pixelHeight);
        }

        public int getAscender(){
            return glueGetAscender(address);
        }

        public int getDescender(){
            return glueGetDescender(address);
        }

        public int getHeight(){
            return glueGetHeight(address);
        }

        public int getMaxAdvanceWidth(){
            return glueGetMaxAdvance(address);
        }

        public int getMaxAdvanceHeight(){
            return glueGetMaxAdvance(address);
        }

        public int getUnderlinePosition(){
            return glueGetUnderlinePosition();
        }

        public int getUnderlineThickness(){
            return glueGetUnderlineThickness();
        }

        public boolean hasKerning(){
            return glueHasKerning(address);
        }

        public int getKerning(int leftGlyph, int rightGlyph, int kernMode){
            return glueGetKerning(address, leftGlyph, rightGlyph);
        }

        public int getCharIndex(int charCode){
            return glueGetCharIndex(address, charCode);
        }

        public boolean loadGlyph(int glyphIndex, int loadFlags){
            return glueLoadGlyph(address, glyphIndex);
        }

        public boolean loadChar(int charCode, int loadFlags){
            return glueLoadChar(address, charCode);
        }

        public GlyphSlot getGlyph(){
            if(!glueSlotHasGlyph(address)) return null;
            return new GlyphSlot(this);
        }

        public Size getSize(){
            return new Size(this);
        }
    }

    public static class Size extends Pointer{
        final Face face;

        Size(Face face){
            super(face.address);
            this.face = face;
        }

        public SizeMetrics getMetrics(){
            return new SizeMetrics(face);
        }
    }

    public static class SizeMetrics extends Pointer{
        final Face face;

        SizeMetrics(Face face){
            super(face.address);
            this.face = face;
        }

        public int getXppem(){
            return face.sizePx;
        }

        public int getYppem(){
            return face.sizePx;
        }

        public int getXscale(){
            return 0;
        }

        public int getYscale(){
            return 0;
        }

        public int getAscender(){
            return glueGetAscender(address);
        }

        public int getDescender(){
            return glueGetDescender(address);
        }

        public int getHeight(){
            return glueGetHeight(address);
        }

        public int getMaxAdvance(){
            return glueGetMaxAdvance(address);
        }
    }

    public static class GlyphSlot extends Pointer{
        final Face face;

        GlyphSlot(Face face){
            super(face.address);
            this.face = face;
        }

        public GlyphMetrics getMetrics(){
            return new GlyphMetrics(face);
        }

        public int getLinearHoriAdvance(){
            return glueSlotAdvanceX(address);
        }

        public int getLinearVertAdvance(){
            return 0;
        }

        public int getAdvanceX(){
            return glueSlotAdvanceX(address);
        }

        public int getAdvanceY(){
            return 0;
        }

        public int getFormat(){
            return 0x6f75746c; // 'outl' -- outline format
        }

        public Bitmap getBitmap(){
            return null;
        }

        public int getBitmapLeft(){
            return 0;
        }

        public int getBitmapTop(){
            return 0;
        }

        public boolean renderGlyph(int renderMode){
            return true;
        }

        /** Each call returns a fresh Glyph, matching FreeType's copy-out semantics
         * (FreeTypeFontGenerator relies on this to draw a stroked border copy
         * separately from the main glyph). */
        public Glyph getGlyph(){
            return new Glyph(face, 0);
        }
    }

    public static class Glyph extends Pointer implements Disposable{
        final Face face;
        float stroked;
        int bitmap;

        Glyph(Face face, int unused){
            super(face.address);
            this.face = face;
        }

        @Override
        public void dispose(){
            if(bitmap != 0) glueDispose(bitmap);
            bitmap = 0;
        }

        public int strokeBorder(Stroker stroker, boolean destroy){
            stroked = stroker == null ? 0 : stroker.widthPx;
            return 0;
        }

        public int toBitmap(int renderMode){
            bitmap = glueRasterize(address, stroked);
            if(bitmap == 0){
                // FreeTypeFontGenerator catches ArcRuntimeException from this
                // call and skips the glyph; match that contract.
                throw new ArcRuntimeException("Couldn't rasterize glyph");
            }
            return 0;
        }

        public Bitmap getBitmap(){
            return bitmap == 0 ? null : new Bitmap(bitmap);
        }

        public int getLeft(){
            return bitmap == 0 ? 0 : glueBitmapLeft(bitmap);
        }

        public int getTop(){
            return bitmap == 0 ? 0 : glueBitmapTop(bitmap);
        }
    }

    public static class Bitmap extends Pointer{
        private byte[] alpha;

        Bitmap(int address){
            super(address);
        }

        public int getRows(){
            return glueBitmapRows(address);
        }

        public int getWidth(){
            return glueBitmapWidth(address);
        }

        public int getPitch(){
            return getWidth();
        }

        public ByteBuffer getBuffer(){
            if(getRows() == 0) return Buffers.newByteBuffer(1);
            byte[] data = alpha();
            ByteBuffer out = Buffers.newByteBuffer(data.length);
            Buffers.copy(data, 0, out, data.length);
            return out;
        }

        private byte[] alpha(){
            if(alpha == null){
                int len = getWidth() * getRows();
                Uint8Array view = new Uint8Array(len);
                glueCopyAlpha(address, view);
                byte[] data = new byte[len];
                for(int i = 0; i < len; i++) data[i] = (byte)view.get(i);
                alpha = data;
            }
            return alpha;
        }

        // @off
        public Pixmap getPixmap(Color color, float gamma){
            int width = getWidth(), rows = getRows();
            byte[] src = alpha();
            Pixmap pixmap = new Pixmap(width, rows);
            int rgba = color.rgba8888();
            int rowBytes = Math.abs(getPitch()); // We currently ignore negative pitch.
            byte[] srcRow = new byte[rowBytes];
            int[] dstRow = new int[width];
            IntBuffer dst = pixmap.pixels.asIntBuffer();
            // Use the specified color for RGB, blend the FreeType bitmap with alpha.
            int rgb = rgba & 0xffffff00;
            int a = rgba & 0xff;
            for(int y = 0; y < rows; y++){
                System.arraycopy(src, y * rowBytes, srcRow, 0, rowBytes);
                for(int x = 0; x < width; x++){
                    // Zero raised to any power is always zero.
                    // 255 (=one) raised to any power is always one.
                    // We only need Math.pow() when alpha is NOT zero and NOT one.
                    int alphaV = srcRow[x] & 0xff;
                    if(alphaV == 0)
                        dstRow[x] = rgb;
                    else if(alphaV == 255)
                        dstRow[x] = rgb | a;
                    else
                        dstRow[x] = rgb | (int)(a * (float)Math.pow(alphaV / 255f, gamma)); // Inverse gamma.
                }
                dst.put(dstRow);
            }

            return pixmap;
        }
        // @on

        public int getNumGray(){
            return 256;
        }

        public int getPixelMode(){
            return FT_PIXEL_MODE_GRAY;
        }
    }

    public static class GlyphMetrics extends Pointer{
        final Face face;

        GlyphMetrics(Face face){
            super(face.address);
            this.face = face;
        }

        public int getWidth(){
            return glueSlotAdvanceX(address);
        }

        public int getHeight(){
            return glueSlotAdvanceX(address);
        }

        public int getHoriBearingX(){
            return 0;
        }

        public int getHoriBearingY(){
            return 0;
        }

        public int getHoriAdvance(){
            return glueSlotAdvanceX(address);
        }

        public int getVertBearingX(){
            return 0;
        }

        public int getVertBearingY(){
            return 0;
        }

        public int getVertAdvance(){
            return 0;
        }
    }

    public static class Stroker extends Pointer implements Disposable{
        float widthPx;

        Stroker(int address){
            super(address);
        }

        public void set(int radius, int lineCap, int lineJoin, int miterLimit){
            widthPx = radius / 64f;
            glueStrokerSet(address, radius);
        }

        @Override
        public void dispose(){
            glueDispose(address);
        }
    }

    // ---- glue calls into resources/freetype-glue.js ----

    @JSBody(script = "return ArcFreeType.init();")
    static native int glueInit();

    @JSBody(params = "h", script = "ArcFreeType.dispose(h);")
    static native void glueDispose(int h);

    @JSBody(params = {"lib", "bytes", "faceIndex"}, script = "return ArcFreeType.newFace(lib, bytes, faceIndex);")
    static native int glueNewFace(int lib, Uint8Array bytes, int faceIndex);

    @JSBody(script = "return ArcFreeType.parseError;")
    static native String glueParseError();

    @JSBody(params = "lib", script = "return ArcFreeType.strokerNew(lib);")
    static native int glueStrokerNew(int lib);

    @JSBody(params = {"h", "radius"}, script = "ArcFreeType.strokerSet(h, radius);")
    static native void glueStrokerSet(int h, int radius);

    @JSBody(params = "h", script = "return ArcFreeType.getFaceFlags(h);")
    static native int glueGetFaceFlags(int h);

    @JSBody(params = "h", script = "return ArcFreeType.getNumGlyphs(h);")
    static native int glueGetNumGlyphs(int h);

    @JSBody(params = {"h", "cw", "ch", "hres", "vres"}, script = "return ArcFreeType.setCharSize(h, cw, ch, hres, vres);")
    static native boolean glueSetCharSize(int h, int cw, int ch, int hres, int vres);

    @JSBody(params = {"h", "w", "hh"}, script = "return ArcFreeType.setPixelSizes(h, w, hh);")
    static native boolean glueSetPixelSizes(int h, int w, int hh);

    @JSBody(params = "h", script = "return ArcFreeType.getAscender(h);")
    static native int glueGetAscender(int h);

    @JSBody(params = "h", script = "return ArcFreeType.getDescender(h);")
    static native int glueGetDescender(int h);

    @JSBody(params = "h", script = "return ArcFreeType.getHeight(h);")
    static native int glueGetHeight(int h);

    @JSBody(params = "h", script = "return ArcFreeType.getMaxAdvance(h);")
    static native int glueGetMaxAdvance(int h);

    @JSBody(script = "return ArcFreeType.getUnderlinePosition();")
    static native int glueGetUnderlinePosition();

    @JSBody(script = "return ArcFreeType.getUnderlineThickness();")
    static native int glueGetUnderlineThickness();

    @JSBody(params = "h", script = "return ArcFreeType.hasKerning(h);")
    static native boolean glueHasKerning(int h);

    @JSBody(params = {"h", "l", "r"}, script = "return ArcFreeType.getKerning(h, l, r);")
    static native int glueGetKerning(int h, int l, int r);

    @JSBody(params = {"h", "cp"}, script = "return ArcFreeType.getCharIndex(h, cp);")
    static native int glueGetCharIndex(int h, int cp);

    @JSBody(params = {"h", "gi"}, script = "return ArcFreeType.loadGlyph(h, gi);")
    static native boolean glueLoadGlyph(int h, int gi);

    @JSBody(params = {"h", "cp"}, script = "return ArcFreeType.loadChar(h, cp);")
    static native boolean glueLoadChar(int h, int cp);

    @JSBody(params = "h", script = "return ArcFreeType.slotAdvanceX(h);")
    static native int glueSlotAdvanceX(int h);

    @JSBody(params = "h", script = "return ArcFreeType.slotHasGlyph(h);")
    static native boolean glueSlotHasGlyph(int h);

    @JSBody(params = {"h", "strokeW"}, script = "return ArcFreeType.rasterize(h, strokeW);")
    static native int glueRasterize(int h, float strokeW);

    @JSBody(params = "h", script = "return ArcFreeType.bitmapRows(h);")
    static native int glueBitmapRows(int h);

    @JSBody(params = "h", script = "return ArcFreeType.bitmapWidth(h);")
    static native int glueBitmapWidth(int h);

    @JSBody(params = "h", script = "return ArcFreeType.bitmapLeft(h);")
    static native int glueBitmapLeft(int h);

    @JSBody(params = "h", script = "return ArcFreeType.bitmapTop(h);")
    static native int glueBitmapTop(int h);

    @JSBody(params = {"h", "out"}, script = "ArcFreeType.copyAlpha(h, out);")
    static native void glueCopyAlpha(int h, Uint8Array out);
}
