import { initTheme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { RUNNER_MENU_OPTIONS, RunnerMenuScreen, runnerMenuFallbackOptions, runnerMenuValue } from "../runners-menu.js";

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };

describe("runners command menu", () => {
  it("maps readable fallback navigation back to the preserved CLI literals", () => {
    expect(runnerMenuValue(runnerMenuFallbackOptions()[0])).toBe("setup");
    expect(runnerMenuValue(runnerMenuFallbackOptions()[8])).toBe("destroy");
    expect(runnerMenuValue("missing")).toBeUndefined();
    expect(RUNNER_MENU_OPTIONS.map(option => option.value)).toContain("reaper install");
  });

  it("searches labels and descriptions, navigates, and stays within every rendered width", () => {
    initTheme("dark");
    let choice: string | undefined;
    const screen = new RunnerMenuScreen(value => { choice = value; }, () => { choice = "cancel"; }, theme);
    for (const width of [1, 8, 24, 80]) expect(screen.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
    const narrow = screen.render(24).join("\n");
    expect(narrow).toContain("Plan drain");
    expect(narrow).toContain("Plan destroy");
    screen.handleInput("\u001b[1;1B");
    screen.handleInput("\u001b[13u");
    expect(choice).toBe("reset");
    for (const character of "inventory") screen.handleInput(character);
    screen.handleInput("\u001b[13u");
    expect(choice).toBe("status");
    screen.handleInput("\u001b[27u");
    expect(choice).toBe("cancel");
  });

  it("recognizes Kitty navigation keys and forwards focus to its input", () => {
    expect(matchesKey("\u001b[1;1A", Key.up)).toBe(true);
    expect(matchesKey("\u001b[1;1B", Key.down)).toBe(true);
    expect(matchesKey("\u001b[13u", Key.enter)).toBe(true);
    expect(matchesKey("\u001b[27u", Key.escape)).toBe(true);

    const screen = new RunnerMenuScreen(() => {}, () => {}, theme);
    const input = (screen as unknown as { input: { focused: boolean } }).input;
    expect(screen.focused).toBe(false);
    expect(input.focused).toBe(false);
    screen.focused = true;
    expect(screen.focused).toBe(true);
    expect(input.focused).toBe(true);
    screen.focused = false;
    expect(input.focused).toBe(false);
  });
});
