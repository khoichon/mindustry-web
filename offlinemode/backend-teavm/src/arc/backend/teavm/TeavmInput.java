package arc.backend.teavm;

import arc.Input;
import arc.input.InputEventQueue;
import arc.input.KeyCode;
import arc.struct.ObjectMap;
import org.teavm.jso.JSBody;
import org.teavm.jso.JSObject;
import org.teavm.jso.dom.events.KeyboardEvent;
import org.teavm.jso.dom.events.MouseEvent;
import org.teavm.jso.dom.events.WheelEvent;
import org.teavm.jso.dom.html.HTMLCanvasElement;
import org.teavm.jso.browser.Window;

/**
 * Feeds browser pointer/keyboard/wheel events into Arc's input system the
 * same way SdlInput does: DOM callbacks push into an {@link InputEventQueue},
 * and update()/postUpdate() -- called from TeavmApplication's frame loop in
 * the same before-listeners/after-listeners slots SDL uses -- drain that
 * queue into the InputMultiplexer and then reset per-frame state.
 *
 * Coordinate conventions (matching every other arc backend):
 *  - mouseX/mouseY and all queue events are in *backing-store* pixels with
 *    the origin at the BOTTOM-left (arc's Input contract, see
 *    arc/Input.java's mouseY() javadoc; Scene flips back to y-down itself).
 *    Browser clientX/Y is CSS pixels, origin top-left, so both a scale and a
 *    flip are applied in toX()/toY().
 *  - wheel: browsers report deltaY>0 for scrolling toward the user, in pixel
 *    units on most platforms (~100/notch) or lines on Firefox. SDL's
 *    SdlInput calls queue.scrolled(-dx, -dy), so the same sign flip is used
 *    here, after normalizing to "notches" (~1.0 per detent).
 */
public class TeavmInput extends Input{
    private final InputEventQueue queue = new InputEventQueue();
    private final HTMLCanvasElement canvas;

    private int mouseX, mouseY;
    private int deltaX, deltaY;
    private int mousePressed;
    private long lastEventTime;

    // Fractional wheel notches accumulated between frames (trackpads emit
    // many sub-notch deltas; a mouse detent is ~1.0). Flushed once per frame.
    private float pendingScrollX, pendingScrollY;

    private static final ObjectMap<String, KeyCode> domCodes = new ObjectMap<>();

    static{
        // Letters / digits.
        for(char c = 'a'; c <= 'z'; c++) domCodes.put("Key" + Character.toUpperCase(c), KeyCode.valueOf(String.valueOf(c)));
        for(char d = '0'; d <= '9'; d++) domCodes.put("Digit" + d, KeyCode.valueOf("num" + d));
        // Function row. F12 deliberately unmapped-and-not-prevented so devtools stays reachable.
        for(int f = 1; f <= 11; f++) domCodes.put("F" + f, KeyCode.valueOf("f" + f));
        // Numpad.
        for(int d = 0; d <= 9; d++) domCodes.put("Numpad" + d, KeyCode.valueOf("numpad" + d));
        domCodes.put("NumpadMultiply", KeyCode.asterisk);
        domCodes.put("NumpadAdd", KeyCode.plus);
        domCodes.put("NumpadSubtract", KeyCode.minus);
        domCodes.put("NumpadDecimal", KeyCode.period);
        domCodes.put("NumpadDivide", KeyCode.slash);
        domCodes.put("NumpadEnter", KeyCode.enter);
        domCodes.put("NumLock", KeyCode.num);

        // Navigation + editing keys.
        domCodes.put("ArrowUp", KeyCode.up);
        domCodes.put("ArrowDown", KeyCode.down);
        domCodes.put("ArrowLeft", KeyCode.left);
        domCodes.put("ArrowRight", KeyCode.right);
        domCodes.put("Enter", KeyCode.enter);
        domCodes.put("NumpadEnter", KeyCode.enter);
        domCodes.put("Tab", KeyCode.tab);
        domCodes.put("Escape", KeyCode.escape);
        domCodes.put("Backspace", KeyCode.back);
        domCodes.put("Delete", KeyCode.forwardDel);
        domCodes.put("Insert", KeyCode.insert);
        domCodes.put("Home", KeyCode.home);
        domCodes.put("End", KeyCode.end);
        domCodes.put("PageUp", KeyCode.pageUp);
        domCodes.put("PageDown", KeyCode.pageDown);
        domCodes.put("Space", KeyCode.space);

        // Modifiers.
        domCodes.put("ShiftLeft", KeyCode.shiftLeft);
        domCodes.put("ShiftRight", KeyCode.shiftRight);
        domCodes.put("ControlLeft", KeyCode.controlLeft);
        domCodes.put("ControlRight", KeyCode.controlRight);
        domCodes.put("AltLeft", KeyCode.altLeft);
        domCodes.put("AltRight", KeyCode.altRight);
        // arc has no plain "meta" key; application is the closest unused slot.
        domCodes.put("MetaLeft", KeyCode.application);
        domCodes.put("MetaRight", KeyCode.application);

        // Punctuation.
        domCodes.put("Minus", KeyCode.minus);
        domCodes.put("Equal", KeyCode.equals);
        domCodes.put("BracketLeft", KeyCode.leftBracket);
        domCodes.put("BracketRight", KeyCode.rightBracket);
        domCodes.put("Backslash", KeyCode.backslash);
        domCodes.put("Semicolon", KeyCode.semicolon);
        domCodes.put("Quote", KeyCode.apostrophe);
        domCodes.put("Comma", KeyCode.comma);
        domCodes.put("Period", KeyCode.period);
        domCodes.put("Slash", KeyCode.slash);
        domCodes.put("Backquote", KeyCode.backtick);
        domCodes.put("ContextMenu", KeyCode.menu);

        // Lock/pause keys.
        domCodes.put("CapsLock", KeyCode.capsLock);
        domCodes.put("Pause", KeyCode.pause);
        domCodes.put("PrintScreen", KeyCode.printScreen);
        domCodes.put("ScrollLock", KeyCode.scrollLock);
    }

    public TeavmInput(HTMLCanvasElement canvas){
        this.canvas = canvas;

        // Pointer position: tracked on window so drags leaving the canvas
        // ( Mindustry gameplay drags) keep updating instead of sticking.
        Window.current().addEventListener("mousemove", (MouseEvent e) -> {
            int nx = toX(e), ny = toY(e);
            deltaX += nx - mouseX;
            deltaY += ny - mouseY;
            mouseX = nx;
            mouseY = ny;
            lastEventTime = System.currentTimeMillis();

            if(mousePressed > 0){
                queue.touchDragged(mouseX, mouseY, 0);
            }else{
                queue.mouseMoved(mouseX, mouseY);
            }
        });

        canvas.addEventListener("mousedown", (MouseEvent e) -> {
            KeyCode button = mouseButton(e);
            if(button == null) return;
            mousePressed++;
            updatePosition(e);
            lastEventTime = System.currentTimeMillis();
            queue.touchDown(mouseX, mouseY, 0, button);
            e.preventDefault();
        });

        Window.current().addEventListener("mouseup", (MouseEvent e) -> {
            KeyCode button = mouseButton(e);
            if(button == null) return;
            mousePressed = Math.max(0, mousePressed - 1);
            updatePosition(e);
            lastEventTime = System.currentTimeMillis();
            queue.touchUp(mouseX, mouseY, 0, button);
        });

        // Right-click is a core Mindustry interaction; never let the
        // browser's context menu eat it.
        canvas.addEventListener("contextmenu", e -> e.preventDefault());

        canvas.addEventListener("wheel", (WheelEvent e) -> {
            e.preventDefault();
            // Normalize to notches: ~100px per detent on Chrome/Safari
            // (DOM_DELTA_PIXEL), 3 lines per detent on Firefox (DOM_DELTA_LINE).
            double unit = switch(e.getDeltaMode()){
                case WheelEvent.DOM_DELTA_LINE -> 3.0;
                case WheelEvent.DOM_DELTA_PAGE -> 40.0;
                default -> 100.0;
            };
            pendingScrollX += (float)(e.getDeltaX() / unit);
            pendingScrollY += (float)(e.getDeltaY() / unit);
        });

        // Keyboard: on window (the canvas is not a focusable element), with
        // the same DOM physical-code -> KeyCode mapping SDL's scanmap does.
        Window.current().addEventListener("keydown", (KeyboardEvent e) -> {
            KeyCode key = domCodes.get(e.getCode());
            if(shouldPreventDefault(e)){
                e.preventDefault();
            }
            if(key == null || e.isRepeat()) return;
            queue.keyDown(key);

            // SDL synthesizes keyTyped for control keys; everything else
            // comes from the character the browser reports for the event.
            String k = e.getKey();
            if(k.length() == 1 && !e.isCtrlKey() && !e.isAltKey() && !e.isMetaKey()){
                queue.keyTyped(k.charAt(0));
            }else if(key == KeyCode.back){
                queue.keyTyped((char)8);
            }else if(key == KeyCode.tab){
                queue.keyTyped('\t');
            }else if(key == KeyCode.enter){
                queue.keyTyped((char)13);
            }else if(key == KeyCode.forwardDel){
                queue.keyTyped((char)127);
            }
        });

        Window.current().addEventListener("keyup", (KeyboardEvent e) -> {
            KeyCode key = domCodes.get(e.getCode());
            if(key == null) return;
            queue.keyUp(key);
        });

        // TODO: touchstart/touchmove/touchend for real multi-pointer mobile-web support
    }

    /** Keys whose browser default action (scroll, focus-nav, quick-find) would break the game. */
    private static boolean shouldPreventDefault(KeyboardEvent e){
        return switch(e.getCode()){
            case "Tab", "Backspace", "Space", "Slash", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
                 "PageUp", "PageDown", "Home", "End", "Quote", "QuickFind" -> true;
            default -> e.getCode().startsWith("F") && !e.getCode().equals("F12") && !e.isMetaKey() && !e.isCtrlKey();
        };
    }

    private static KeyCode mouseButton(MouseEvent e){
        return switch(e.getButton()){
            case MouseEvent.LEFT_BUTTON -> KeyCode.mouseLeft;
            case MouseEvent.MIDDLE_BUTTON -> KeyCode.mouseMiddle;
            case MouseEvent.RIGHT_BUTTON -> KeyCode.mouseRight;
            case 3 -> KeyCode.mouseBack;
            case 4 -> KeyCode.mouseForward;
            default -> null;
        };
    }

    private void updatePosition(MouseEvent e){
        mouseX = toX(e);
        mouseY = toY(e);
    }

    /** CSS-pixel client coords -> backing-store pixels, x axis. */
    private int toX(MouseEvent e){
        return (int)Math.floor((e.getClientX() - rectLeft(canvas)) * scaleX());
    }

    /** CSS-pixel client coords -> backing-store pixels, y axis, flipped to arc's bottom-left origin. */
    private int toY(MouseEvent e){
        return canvas.getHeight() - (int)Math.floor((e.getClientY() - rectTop(canvas)) * scaleY());
    }

    private double scaleX(){
        double css = rectWidth(canvas);
        return css <= 0 ? 1.0 : canvas.getWidth() / css;
    }

    private double scaleY(){
        double css = rectHeight(canvas);
        return css <= 0 ? 1.0 : canvas.getHeight() / css;
    }

    /** Called by TeavmApplication before listeners update -- drains the DOM event queue. */
    void update(){
        queue.setProcessor(inputMultiplexer);
        queue.drain();

        if(pendingScrollX != 0 || pendingScrollY != 0){
            queue.scrolled(-pendingScrollX, -pendingScrollY);
            pendingScrollX = pendingScrollY = 0;
        }
    }

    /** Called by TeavmApplication after listeners update -- mirrors SdlInput.postUpdate(). */
    void postUpdate(){
        keyboard.postUpdate();
        deltaX = deltaY = 0;
    }

    @Override public int mouseX(){ return mouseX; }
    @Override public int mouseX(int pointer){ return pointer == 0 ? mouseX : 0; }
    @Override public int deltaX(){ return deltaX; }
    @Override public int deltaX(int pointer){ return pointer == 0 ? deltaX : 0; }
    @Override public int mouseY(){ return mouseY; }
    @Override public int mouseY(int pointer){ return pointer == 0 ? mouseY : 0; }
    @Override public int deltaY(){ return deltaY; }
    @Override public int deltaY(int pointer){ return pointer == 0 ? deltaY : 0; }

    @Override public boolean isTouched(){
        return keyDown(KeyCode.mouseLeft) || keyDown(KeyCode.mouseRight);
    }

    @Override public boolean justTouched(){
        return keyTap(KeyCode.mouseLeft) || keyTap(KeyCode.mouseRight);
    }

    @Override public boolean isTouched(int pointer){
        return pointer == 0 && isTouched();
    }

    @Override public long getCurrentEventTime(){ return lastEventTime; }

    // TextRectangle's int accessors lose sub-pixel precision on fractional
    // layouts; read the doubles directly instead.
    @JSBody(params = "el", script = "return el.getBoundingClientRect().left;")
    private static native double rectLeft(JSObject el);
    @JSBody(params = "el", script = "return el.getBoundingClientRect().top;")
    private static native double rectTop(JSObject el);
    @JSBody(params = "el", script = "return el.getBoundingClientRect().width;")
    private static native double rectWidth(JSObject el);
    @JSBody(params = "el", script = "return el.getBoundingClientRect().height;")
    private static native double rectHeight(JSObject el);
}
