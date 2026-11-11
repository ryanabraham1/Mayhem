import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenuHost, closeContextMenu, openContextMenu } from "../src/suite/ContextMenu";

afterEach(() => {
  act(() => closeContextMenu());
  cleanup();
});

const at = { clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} };

it("drops falsy items and stray separators, then runs the picked action and closes", () => {
  render(<ContextMenuHost />);
  const rename = vi.fn();
  act(() =>
    openContextMenu(
      at,
      ["separator", false, { label: "Rename", onSelect: rename }, "separator", "separator", null, { label: "Delete", danger: true, onSelect() {} }, "separator"],
      "Goal 1",
    ),
  );
  const menu = screen.getByRole("menu", { name: "Goal 1" });
  expect(menu.querySelectorAll("[role=menuitem]")).toHaveLength(2);
  expect(menu.querySelectorAll("[role=separator]")).toHaveLength(1);
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  expect(rename).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).toBeNull();
});

it("closes on Escape and on a click elsewhere", () => {
  render(<ContextMenuHost />);
  act(() => openContextMenu(at, [{ label: "A", onSelect() {} }]));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  act(() => openContextMenu(at, [{ label: "A", onSelect() {} }]));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("hides the webview menu except in text fields", () => {
  render(
    <>
      <ContextMenuHost />
      <div data-testid="plain" />
      <input aria-label="name" />
    </>,
  );
  expect(fireEvent.contextMenu(screen.getByTestId("plain"))).toBe(false);
  expect(fireEvent.contextMenu(screen.getByLabelText("name"))).toBe(true);
});
