import { describe, expect, it } from "vitest";
import { describe as describeError, isNotFound } from "./errors.js";

describe("describeError", () => {
  it("uses an Error's message", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("stringifies anything else", () => {
    expect(describeError("plain")).toBe("plain");
    expect(describeError(undefined)).toBe("undefined");
  });
});

describe("isNotFound", () => {
  it.each([
    [{ status: 404 }],
    [{ statusCode: 404 }],
    [{ code: "not_found" }],
    [{ code: "NOTFOUND" }],
    [Object.assign(new Error("thread thr_1 not found"), {})],
    [new Error("request failed with 404")],
  ])("recognises %j as a definite absence", (error) => {
    expect(isNotFound(error)).toBe(true);
  });

  it.each([
    [new Error("socket hang up")],
    [new Error("request failed with 500")],
    [new Error("ECONNREFUSED")],
    [{ status: 503 }],
    [{}],
    ["a string"],
    [null],
    [undefined],
  ])("treats %j as transient, because losing a live thread's cursor is worse", (error) => {
    // The caller deletes stored cursors on a definite absence, so anything
    // ambiguous must fall on the "keep it" side.
    expect(isNotFound(error)).toBe(false);
  });
});
