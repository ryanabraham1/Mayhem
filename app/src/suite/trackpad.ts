import { useEffect, useRef, type RefObject } from "react";

export interface ZoomPanHandlers {
  /** Zoom by `factor` (> 1 zooms in) keeping the point under (clientX, clientY) fixed. */
  zoomAt: (factor: number, clientX: number, clientY: number) => void;
  /** Pan by screen pixels; omit to let the element scroll natively. */
  pan?: (dx: number, dy: number) => void;
}

/**
 * Trackpad and mouse zoom/pan for a canvas: a pinch (a wheel event with ctrlKey in Chromium and
 * WebKit, or Safari's gesture events), or Cmd/Ctrl + wheel, zooms around the cursor; a plain
 * two-finger scroll pans. The listeners are not passive, so the page itself never zooms.
 */
export function useTrackpadZoom(ref: RefObject<HTMLElement | SVGSVGElement | null>, handlers: ZoomPanHandlers) {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let pointer = { x: 0, y: 0 };
    let gesture: number | null = null;
    const wheel = (e: WheelEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight || 600 : 1;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (gesture !== null) return; // Safari reports the same pinch as gesture events
        // Pinches send small deltas; a mouse wheel notch is ~100. Clamp so neither jumps.
        const delta = Math.max(-30, Math.min(30, e.deltaY * unit));
        current.current.zoomAt(Math.exp(-delta * 0.01), e.clientX, e.clientY);
      } else if (current.current.pan) {
        e.preventDefault();
        current.current.pan(e.deltaX * unit, e.deltaY * unit);
      }
    };
    const move = (e: Event) => {
      const p = e as PointerEvent;
      pointer = { x: p.clientX, y: p.clientY };
    };
    const start = (e: Event) => {
      e.preventDefault();
      gesture = 1;
    };
    const change = (e: Event) => {
      e.preventDefault();
      const scale = (e as Event & { scale?: number }).scale ?? 1;
      if (gesture && scale > 0) current.current.zoomAt(scale / gesture, pointer.x, pointer.y);
      gesture = scale;
    };
    const end = (e: Event) => {
      e.preventDefault();
      gesture = null;
    };
    el.addEventListener("wheel", wheel as EventListener, { passive: false });
    el.addEventListener("pointermove", move);
    el.addEventListener("gesturestart", start, { passive: false } as AddEventListenerOptions);
    el.addEventListener("gesturechange", change, { passive: false } as AddEventListenerOptions);
    el.addEventListener("gestureend", end, { passive: false } as AddEventListenerOptions);
    return () => {
      el.removeEventListener("wheel", wheel as EventListener);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("gesturestart", start);
      el.removeEventListener("gesturechange", change);
      el.removeEventListener("gestureend", end);
    };
  }, [ref]);
}
