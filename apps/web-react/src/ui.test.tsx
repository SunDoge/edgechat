// @vitest-environment jsdom
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TextInput } from "./ui";

function ControlledField() {
  const [value, setValue] = useState("");
  return <TextInput label="显示名称" value={value} onChange={setValue} inputProps={{ name: "display_name" }} />;
}

describe("TextInput", () => {
  it("keeps controlled input text stable through React Aria", async () => {
    render(<ControlledField />);
    const input = screen.getByRole("textbox", { name: "显示名称" });
    await userEvent.type(input, "爱丽丝");
    expect((input as HTMLInputElement).value).toBe("爱丽丝");
    expect(document.activeElement).toBe(input);
  });
});
