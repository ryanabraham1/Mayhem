// jsdom gaps the app relies on. SVG screen transforms are the identity, so in tests
// clientX/clientY are field coordinates in meters.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

if (typeof window !== "undefined") {
  if (!("PointerEvent" in window)) {
    class PointerEventStub extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.assign(window, { PointerEvent: PointerEventStub });
  }

  // uPlot reads the device pixel ratio through matchMedia when it loads.
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  const identity = () => {
    const m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, inverse: () => m, multiply: () => m };
    return m;
  };
  const proto = window.SVGElement.prototype as any;
  proto.getScreenCTM ??= identity;
  proto.createSVGPoint ??= () => {
    const p = { x: 0, y: 0, matrixTransform: () => ({ x: p.x, y: p.y }) };
    return p;
  };
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
}
