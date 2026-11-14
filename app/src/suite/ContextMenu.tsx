import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import { createPortal } from "react-dom";

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;

export interface MenuAction {
  label: string;
  icon?: Icon;
  /** Short secondary text, e.g. a keyboard shortcut. */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}
/** Falsy entries are dropped so callers can write `cond && {...}`. */
export type MenuItem = MenuAction | "separator" | "" | 0 | false | null | undefined;

interface OpenMenu {
  x: number;
  y: number;
  title?: string;
  items: (MenuAction | "separator")[];
}

let current: OpenMenu | null = null;
const listeners = new Set<() => void>();
const set = (next: OpenMenu | null) => {
  current = next;
  listeners.forEach((l) => l());
};

export const closeContextMenu = () => set(null);

/**
 * Show the app's context menu at the pointer. Falsy items are dropped so callers can write
 * `cond && {...}`; leading, trailing and doubled separators are trimmed.
 */
export function openContextMenu(
  event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void },
  items: MenuItem[],
  title?: string,
) {
  event.preventDefault();
  event.stopPropagation();
  const kept: OpenMenu["items"] = [];
  for (const item of items) {
    if (!item) continue;
    if (item === "separator" && (!kept.length || kept.at(-1) === "separator")) continue;
    kept.push(item);
  }
  while (kept.at(-1) === "separator") kept.pop();
  if (!kept.length) return closeContextMenu();
  set({ x: event.clientX, y: event.clientY, items: kept, title });
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/**
 * Right-clicks that land where Mayhem has no menu of its own show nothing, rather than the
 * webview's menu (Reload, Inspect Element…). Text fields and selected text keep the native menu,
 * where Cut/Copy/Paste are useful, and so does Shift.
 */
function fallbackMenu(e: MouseEvent) {
  if (e.defaultPrevented || e.shiftKey) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable=true]")) return;
  if (window.getSelection()?.toString()) return;
  e.preventDefault();
  closeContextMenu();
}

/** Mount once near the app root. */
export function ContextMenuHost() {
  const menu = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.addEventListener("contextmenu", fallbackMenu);
    return () => document.removeEventListener("contextmenu", fallbackMenu);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8))}px`;
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) closeContextMenu();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      if (!buttons.length) return;
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === "Home" ? 0
        : e.key === "End" ? buttons.length - 1
        : e.key === "ArrowDown" ? (at + 1) % buttons.length
        : (at - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    const close = () => closeContextMenu();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", away, true);
    document.addEventListener("wheel", away, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", away, true);
      document.removeEventListener("wheel", away, true);
    };
  }, [menu]);

  if (!menu) return null;
  return createPortal(
    <div
      ref={ref}
      className="mx-menu is-floating is-context"
      role="menu"
      aria-label={menu.title ?? "Actions"}
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.title && <div className="mx-menu-title">{menu.title}</div>}
      {menu.items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="mx-menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={item.danger ? "is-danger" : undefined}
            onClick={() => {
              closeContextMenu();
              item.onSelect();
            }}
          >
            {item.icon ? <item.icon size={14} /> : <span className="mx-menu-icon-gap" />}
            <span className="mx-menu-label">{item.label}</span>
            {item.hint && <kbd className="mx-menu-hint">{item.hint}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
