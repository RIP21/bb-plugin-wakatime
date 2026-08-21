import { describe, expect, it } from "vitest";
import { HeartbeatThrottle, classifyCommand, countDiffLines, toWakatimeTime } from "./heartbeat.js";

describe("countDiffLines", () => {
  it("counts the recorded bb diff format, which has no hunk headers", () => {
    const diff =
      "--- a/tmp/probe.txt\n+++ b/tmp/probe.txt\n-line two\n+line two changed\n+line two point five\n";
    expect(countDiffLines(diff)).toEqual({ added: 2, removed: 1 });
  });

  it("does not count the file headers as changes", () => {
    expect(countDiffLines("--- a/x\n+++ b/x\n")).toEqual({ added: 0, removed: 0 });
  });

  it("ignores git and hunk metadata lines", () => {
    const diff = "diff --git a/x b/x\nindex 1234567..89abcde 100644\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n context\n+added\n";
    expect(countDiffLines(diff)).toEqual({ added: 1, removed: 0 });
  });

  it("handles an empty diff", () => {
    expect(countDiffLines("")).toEqual({ added: 0, removed: 0 });
  });
});

describe("classifyCommand", () => {
  it.each([
    ["npm test", "running tests"],
    ["npm run test:unit -- --watch=false", "running tests"],
    ["pnpm vitest run", "running tests"],
    ["cargo test --all", "running tests"],
    ["go test ./...", "running tests"],
    ["uv run pytest -q", "running tests"],
    ["pytest tests/", "running tests"],
    ["npm run build", "building"],
    ["tsc --noEmit", "building"],
    ["cargo build --release", "building"],
    ["make -j8", "building"],
    ["git diff --stat", "code reviewing"],
    ["gh pr view 42", "code reviewing"],
    ["lldb ./target/debug/app", "debugging"],
  ] as const)("classifies %s as %s", (command, expected) => {
    expect(classifyCommand(command)).toBe(expected);
  });

  it.each(["cat test.txt", "ls -la", "echo build", "rg buildable src/", "grep -r test .", "cd /tmp"])(
    "leaves %s unclassified rather than guessing from a filename",
    (command) => {
      expect(classifyCommand(command)).toBeNull();
    },
  );

  it("skips sudo and leading environment assignments", () => {
    expect(classifyCommand("sudo make install")).toBe("building");
    expect(classifyCommand("CI=1 NODE_ENV=test npm test")).toBe("running tests");
  });

  it("classifies the first meaningful segment of a chain", () => {
    expect(classifyCommand("cd packages/app && npm run build")).toBe("building");
    expect(classifyCommand("mkdir -p out | tee log")).toBeNull();
  });

  it("does not treat a plain git command as review work", () => {
    expect(classifyCommand("git commit -m wip")).toBeNull();
    expect(classifyCommand("git push origin main")).toBeNull();
  });
});

describe("HeartbeatThrottle", () => {
  it("always admits writes, matching WakaTime's rule", () => {
    const throttle = new HeartbeatThrottle(120_000);
    expect(throttle.admit("a", 0, true)).toBe(true);
    expect(throttle.admit("a", 1_000, true)).toBe(true);
    expect(throttle.admit("a", 2_000, true)).toBe(true);
  });

  it("suppresses a repeated read inside the window", () => {
    const throttle = new HeartbeatThrottle(120_000);
    expect(throttle.admit("a", 0, false)).toBe(true);
    expect(throttle.admit("a", 119_999, false)).toBe(false);
    expect(throttle.admit("a", 120_000, false)).toBe(true);
  });

  it("tracks each key independently", () => {
    const throttle = new HeartbeatThrottle(120_000);
    expect(throttle.admit("a", 0, false)).toBe(true);
    expect(throttle.admit("b", 0, false)).toBe(true);
    expect(throttle.admit("a", 1_000, false)).toBe(false);
  });

  it("prunes oldest keys past its cap instead of growing forever", () => {
    const throttle = new HeartbeatThrottle(120_000, 2);
    throttle.admit("a", 0, false);
    throttle.admit("b", 1, false);
    throttle.admit("c", 2, false);
    // "a" was evicted, so it is admitted again despite being inside the window.
    expect(throttle.admit("a", 3, false)).toBe(true);
    expect(throttle.admit("c", 4, false)).toBe(false);
  });

  it("refreshes a key's window when a write passes through", () => {
    const throttle = new HeartbeatThrottle(120_000);
    throttle.admit("a", 0, false);
    throttle.admit("a", 60_000, true);
    expect(throttle.admit("a", 100_000, false)).toBe(false);
    expect(throttle.admit("a", 180_001, false)).toBe(true);
  });
});

describe("toWakatimeTime", () => {
  it("converts bb's epoch milliseconds to fractional seconds", () => {
    expect(toWakatimeTime(1787216564695)).toBe(1787216564.695);
  });
});
