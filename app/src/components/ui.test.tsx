import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NumberField, SelectField, TextField } from "./ui";

const input = () => screen.getByRole("textbox") as HTMLInputElement;

describe("NumberField", () => {
  it("commits typed values on blur, clamped to its range", () => {
    const onChange = vi.fn();
    render(<NumberField value={1} min={0} max={5} onChange={onChange} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "9" } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenLastCalledWith(5);
  });

  it("restores the value when the text isn't a number", () => {
    const onChange = vi.fn();
    render(<NumberField value={1.5} onChange={onChange} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "abc" } });
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
    expect(input().value).toBe("1.5");
  });

  it("steps with the arrow keys (x10 with shift) without leaving its range", () => {
    const onChange = vi.fn();
    render(<NumberField value={0.5} step={0.1} min={0} max={1} onChange={onChange} />);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(0.6);
    fireEvent.keyDown(input(), { key: "ArrowUp", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(input(), { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(input(), { key: "ArrowDown", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(0);
    expect(input().value).toBe("0");
  });

  it("doesn't let key presses reach the app's shortcuts", () => {
    const onKey = vi.fn();
    render(<div onKeyDown={onKey}><NumberField value={1} onChange={() => {}} /></div>);
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(onKey).not.toHaveBeenCalled();
  });
});

describe("TextField", () => {
  it("only reports a change on blur when the text changed", () => {
    const onChange = vi.fn();
    render(<TextField value="a" onChange={onChange} />);
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input(), { target: { value: "b" } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("SelectField", () => {
  it("passes back the option's original (numeric) value", () => {
    const onChange = vi.fn();
    render(<SelectField value={0} options={[{ value: 0, label: "A" }, { value: 1, label: "B" }]} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "1" } });
    expect(onChange).toHaveBeenCalledWith(1);
  });
});
