import { describe, expect, it } from "vitest";
import { compactDuration, parseTodayText } from "./duration.js";

describe("compactDuration", () => {
  it.each([
    ["1 hr 2 mins", "1h 2m"],
    ["28 mins", "28m"],
    ["4 hrs", "4h"],
    ["1 hr", "1h"],
    ["1 min", "1m"],
    ["12 hrs 45 mins", "12h 45m"],
    // wakatime-cli prints seconds when there is almost nothing yet.
    ["0 secs", "0m"],
    ["43 secs", "0m"],
  ])("squeezes %j into %j for the sidebar", (input, expected) => {
    expect(compactDuration(input)).toBe(expected);
  });

  it("returns null rather than inventing a number it cannot read", () => {
    expect(compactDuration(null)).toBeNull();
    expect(compactDuration("")).toBeNull();
    expect(compactDuration("something unexpected")).toBeNull();
  });

  it("stays short enough for the host's clipped box", () => {
    for (const input of ["12 hrs 45 mins", "1 hr 2 mins", "28 mins"]) {
      expect(compactDuration(input)!.length).toBeLessThanOrEqual(7);
    }
  });
});

describe("parseTodayText", () => {
  it("reads hours and minutes independently", () => {
    expect(parseTodayText("2 hrs 5 mins")).toEqual({ hours: 2, minutes: 5 });
    expect(parseTodayText("5 mins")).toEqual({ hours: 0, minutes: 5 });
    expect(parseTodayText("2 hrs")).toEqual({ hours: 2, minutes: 0 });
  });

  it("returns null for text with no duration in it", () => {
    expect(parseTodayText("error: unauthorized")).toBeNull();
  });
});
