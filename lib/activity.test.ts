import { describe, expect, it } from "vitest";
import {
  extractHeartbeats,
  isInside,
  keepaliveHeartbeat,
  lastFileEntityOf,
  normalize,
  type ExtractOptions,
  type ThreadContext,
  type ThreadEventRowLike,
} from "./activity.js";

const context: ThreadContext = {
  threadId: "thr_1",
  hostId: "host_1",
  worktreePath: "/work/app",
  branchName: "feature/probe",
  projectName: "app",
};

const options: ExtractOptions = {
  agentCategory: "ai coding",
  humanCategory: "coding",
  classifyCommands: true,
  trackFileReads: true,
  trackOutsideWorkspace: false,
};

function row(item: unknown, seq = 1, createdAt = 1_700_000_000_000): ThreadEventRowLike {
  return { seq, createdAt, type: "item/completed", data: { item: item as never } };
}

/** Recorded verbatim from a real bb thread event. */
const RECORDED_FILE_CHANGE = {
  type: "fileChange",
  id: "toolu_01XRqe896Rv9MtGXZD54cJh8",
  changes: [
    {
      path: "/work/app/src/probe.txt",
      kind: "update",
      diff: "--- a/work/app/src/probe.txt\n+++ b/work/app/src/probe.txt\n-line two\n+line two changed\n+line two point five\n",
    },
  ],
  status: "completed",
  approvalStatus: null,
};

describe("extractHeartbeats: file changes", () => {
  it("turns a recorded fileChange into a write heartbeat with line churn", () => {
    const [heartbeat, ...rest] = extractHeartbeats([row(RECORDED_FILE_CHANGE)], context, options);
    expect(rest).toHaveLength(0);
    expect(heartbeat).toMatchObject({
      hostId: "host_1",
      projectFolder: "/work/app",
      threadId: "thr_1",
      heartbeat: {
        entity: "/work/app/src/probe.txt",
        entity_type: "file",
        category: "ai coding",
        is_write: true,
        // One line removed plus two added is three lines of churn.
        ai_line_changes: 3,
        alternate_project: "app",
        alternate_branch: "feature/probe",
      },
    });
    expect(heartbeat!.heartbeat.time).toBe(1_700_000_000);
  });

  it("marks a deleted file unsaved so wakatime-cli does not drop it", () => {
    const item = { type: "fileChange", status: "completed", changes: [{ path: "/work/app/gone.ts", kind: "delete" }] };
    const [heartbeat] = extractHeartbeats([row(item)], context, options);
    expect(heartbeat!.heartbeat.is_unsaved_entity).toBe(true);
    expect(heartbeat!.heartbeat.is_write).toBe(true);
  });

  it("reports a rename against its destination path", () => {
    const item = {
      type: "fileChange",
      status: "completed",
      changes: [{ path: "/work/app/old.ts", movePath: "/work/app/new.ts", kind: "update" }],
    };
    const [heartbeat] = extractHeartbeats([row(item)], context, options);
    expect(heartbeat!.heartbeat.entity).toBe("/work/app/new.ts");
  });

  it("ignores a denied edit, which never reached the disk", () => {
    const item = { ...RECORDED_FILE_CHANGE, approvalStatus: "denied" };
    expect(extractHeartbeats([row(item)], context, options)).toHaveLength(0);
  });

  it("ignores a failed edit", () => {
    const item = { ...RECORDED_FILE_CHANGE, status: "failed" };
    expect(extractHeartbeats([row(item)], context, options)).toHaveLength(0);
  });

  it("omits line churn when the diff carries no changes", () => {
    const item = { type: "fileChange", status: "completed", changes: [{ path: "/work/app/x.ts", kind: "update", diff: "--- a/x\n+++ b/x\n" }] };
    const [heartbeat] = extractHeartbeats([row(item)], context, options);
    expect(heartbeat!.heartbeat.ai_line_changes).toBeUndefined();
  });

  it("emits one heartbeat per changed file", () => {
    const item = {
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "/work/app/a.ts", kind: "update" },
        { path: "/work/app/b.ts", kind: "add" },
      ],
    };
    expect(extractHeartbeats([row(item)], context, options)).toHaveLength(2);
  });
});

describe("extractHeartbeats: commands", () => {
  it("categorizes a test run and reports it against the working directory", () => {
    const item = { type: "commandExecution", status: "completed", command: "npm test", cwd: "/work/app" };
    const [heartbeat] = extractHeartbeats([row(item)], context, options);
    expect(heartbeat!.heartbeat).toMatchObject({ entity: "/work/app", category: "running tests" });
    expect(heartbeat!.heartbeat.is_write).toBeUndefined();
  });

  it("falls back to the agent category for an unremarkable command", () => {
    const item = { type: "commandExecution", status: "completed", command: "ls -la", cwd: "/work/app" };
    const [heartbeat] = extractHeartbeats([row(item)], context, options);
    expect(heartbeat!.heartbeat.category).toBe("ai coding");
  });

  it("keeps the agent category when classification is disabled", () => {
    const item = { type: "commandExecution", status: "completed", command: "npm test", cwd: "/work/app" };
    const [heartbeat] = extractHeartbeats([row(item)], context, { ...options, classifyCommands: false });
    expect(heartbeat!.heartbeat.category).toBe("ai coding");
  });

  it("skips a command that ran outside the worktree", () => {
    const item = { type: "commandExecution", status: "completed", command: "npm test", cwd: "/elsewhere" };
    expect(extractHeartbeats([row(item)], context, options)).toHaveLength(0);
  });
});

describe("extractHeartbeats: tool calls", () => {
  it("reads a file path from provider-specific argument keys", () => {
    for (const key of ["file_path", "path", "absolute_path", "notebook_path"]) {
      const item = { type: "toolCall", tool: "Read", arguments: { [key]: "/work/app/src/read.ts" } };
      const [heartbeat] = extractHeartbeats([row(item)], context, options);
      expect(heartbeat!.heartbeat.entity, key).toBe("/work/app/src/read.ts");
      expect(heartbeat!.heartbeat.is_write, key).toBeUndefined();
    }
  });

  it("resolves a relative argument against the worktree", () => {
    const item = { type: "toolCall", tool: "Read", arguments: { file_path: "src/./nested/../read.ts" } };
    const [heartbeat] = extractHeartbeats([row(item)], context, options);
    expect(heartbeat!.heartbeat.entity).toBe("/work/app/src/read.ts");
  });

  it("skips tools that carry no file, such as Skill and ToolSearch", () => {
    const item = { type: "toolCall", tool: "Skill", arguments: { skill: "some:skill", path: "/work/app/x.ts" } };
    expect(extractHeartbeats([row(item)], context, options)).toHaveLength(0);
  });

  it("skips reads entirely when the setting is off", () => {
    const item = { type: "toolCall", tool: "Read", arguments: { file_path: "/work/app/x.ts" } };
    expect(extractHeartbeats([row(item)], context, { ...options, trackFileReads: false })).toHaveLength(0);
  });

  it("ignores arguments that are not paths", () => {
    const item = { type: "toolCall", tool: "Grep", arguments: { pattern: "TODO" } };
    expect(extractHeartbeats([row(item)], context, options)).toHaveLength(0);
  });
});

describe("extractHeartbeats: work that never happened", () => {
  it("ignores a command the user denied", () => {
    const item = {
      type: "commandExecution",
      status: "completed",
      approvalStatus: "denied",
      command: "npm test",
      cwd: "/work/app",
    };
    expect(extractHeartbeats([row(item)], context, options)).toHaveLength(0);
  });

  it("still counts a command that ran and failed, because that is real work", () => {
    const item = { type: "commandExecution", status: "failed", command: "npm test", cwd: "/work/app" };
    const [heartbeat] = extractHeartbeats([row(item)], context, options);
    expect(heartbeat!.heartbeat.category).toBe("running tests");
  });

  it("ignores a failed read, which wakatime-cli would drop anyway", () => {
    const item = { type: "toolCall", tool: "Read", status: "failed", arguments: { file_path: "/work/app/gone.ts" } };
    expect(extractHeartbeats([row(item)], context, options)).toHaveLength(0);
  });

  it("ignores a denied tool call", () => {
    const item = {
      type: "toolCall",
      tool: "Read",
      status: "completed",
      approvalStatus: "denied",
      arguments: { file_path: "/work/app/a.ts" },
    };
    expect(extractHeartbeats([row(item)], context, options)).toHaveLength(0);
  });
});

describe("extractHeartbeats: files versus directories", () => {
  it("treats a search tool's path as a directory", () => {
    // Grep and Glob pass a directory in the same `path` key Read uses for a
    // file. Getting it wrong makes wakatime-cli warn on every heartbeat.
    for (const tool of ["Grep", "Glob", "LS"]) {
      const item = { type: "toolCall", tool, arguments: { path: "/work/app/src" } };
      const [heartbeat] = extractHeartbeats([row(item)], context, options);
      expect(heartbeat!.entityKind, tool).toBe("directory");
      expect(heartbeat!.heartbeat.lines, tool).toBe(0);
    }
  });

  it("treats a read tool's path as a file", () => {
    const item = { type: "toolCall", tool: "Read", arguments: { path: "/work/app/src/a.ts" } };
    const [heartbeat] = extractHeartbeats([row(item)], context, options);
    expect(heartbeat!.entityKind).toBe("file");
    expect(heartbeat!.heartbeat.lines).toBeUndefined();
  });

  it("trusts an unambiguous key over the tool name", () => {
    const item = { type: "toolCall", tool: "Grep", arguments: { file_path: "/work/app/src/a.ts" } };
    const [heartbeat] = extractHeartbeats([row(item)], context, options);
    expect(heartbeat!.entityKind).toBe("file");
  });

  it("reads a trailing slash as a directory", () => {
    const item = { type: "toolCall", tool: "Unknown", arguments: { path: "/work/app/src/" } };
    const [heartbeat] = extractHeartbeats([row(item)], context, options);
    expect(heartbeat!.entityKind).toBe("directory");
  });

  it("never adopts a directory as the keepalive target", () => {
    const item = { type: "toolCall", tool: "Grep", arguments: { path: "/work/app/src" } };
    const collected = extractHeartbeats([row(item)], context, options);
    expect(lastFileEntityOf(collected)).toBeNull();
  });

  it("adopts a real file as the keepalive target", () => {
    const item = { type: "toolCall", tool: "Read", arguments: { file_path: "/work/app/src/a.ts" } };
    const collected = extractHeartbeats([row(item)], context, options);
    expect(lastFileEntityOf(collected)).toBe("/work/app/src/a.ts");
  });
});

describe("extractHeartbeats: humans", () => {
  it("counts a prompt against the worktree using the human category", () => {
    const item = { type: "userMessage", id: "m1", content: [] };
    const [heartbeat] = extractHeartbeats([row(item)], context, options);
    expect(heartbeat!.heartbeat).toMatchObject({ entity: "/work/app", category: "coding" });
  });

  it("skips human activity when disabled", () => {
    const item = { type: "userMessage", id: "m1", content: [] };
    expect(extractHeartbeats([row(item)], context, { ...options, humanCategory: null })).toHaveLength(0);
  });
});

describe("extractHeartbeats: scoping and safety", () => {
  it("ignores events that are not completed items", () => {
    const started: ThreadEventRowLike = { seq: 1, createdAt: 1, type: "item/started", data: { item: RECORDED_FILE_CHANGE as never } };
    const delta: ThreadEventRowLike = { seq: 2, createdAt: 2, type: "item/reasoning/textDelta" };
    expect(extractHeartbeats([started, delta], context, options)).toHaveLength(0);
  });

  it("drops files outside the worktree by default", () => {
    const item = { type: "fileChange", status: "completed", changes: [{ path: "/etc/hosts", kind: "update" }] };
    expect(extractHeartbeats([row(item)], context, options)).toHaveLength(0);
  });

  it("sends outside files with no project root when explicitly allowed", () => {
    const item = { type: "fileChange", status: "completed", changes: [{ path: "/etc/hosts", kind: "update" }] };
    const [heartbeat] = extractHeartbeats([row(item)], context, { ...options, trackOutsideWorkspace: true });
    // No projectFolder, so wakatime-cli detects that file's own project rather
    // than filing it under this thread's project.
    expect(heartbeat!.projectFolder).toBeNull();
    expect(heartbeat!.heartbeat.alternate_project).toBeUndefined();
  });

  it("is not fooled by a sibling directory sharing a prefix", () => {
    const item = { type: "fileChange", status: "completed", changes: [{ path: "/work/app-other/x.ts", kind: "update" }] };
    expect(extractHeartbeats([row(item)], context, options)).toHaveLength(0);
  });

  it("produces nothing for a thread with no worktree", () => {
    const noWorktree: ThreadContext = { ...context, worktreePath: null };
    const item = { type: "userMessage", id: "m1", content: [] };
    expect(extractHeartbeats([row(item)], noWorktree, options)).toHaveLength(0);
  });

  it("tolerates malformed items without throwing", () => {
    const rows: ThreadEventRowLike[] = [
      { seq: 1, createdAt: 1, type: "item/completed", data: null },
      { seq: 2, createdAt: 2, type: "item/completed", data: { item: { type: "fileChange" } } },
      { seq: 3, createdAt: 3, type: "item/completed", data: { item: { type: "commandExecution", status: "completed" } } },
    ];
    expect(extractHeartbeats(rows, context, options)).toHaveLength(0);
  });
});

describe("keepaliveHeartbeat", () => {
  it("reports the worktree so a thinking agent still counts", () => {
    const keepalive = keepaliveHeartbeat(context, 1_700_000_000_000, "ai coding");
    expect(keepalive!.heartbeat).toMatchObject({ entity: "/work/app", category: "ai coding", lines: 0 });
    expect(keepalive!.heartbeat.is_write).toBeUndefined();
  });

  it("reuses the last file touched, with no zero line count", () => {
    const keepalive = keepaliveHeartbeat(context, 1_700_000_000_000, "ai coding", "/work/app/src/a.ts");
    expect(keepalive!.heartbeat.entity).toBe("/work/app/src/a.ts");
    expect(keepalive!.heartbeat.lines).toBeUndefined();
    expect(keepalive!.entityKind).toBe("file");
  });

  it("ignores a remembered file from outside the worktree", () => {
    const keepalive = keepaliveHeartbeat(context, 1_700_000_000_000, "ai coding", "/etc/hosts");
    expect(keepalive!.heartbeat.entity).toBe("/work/app");
  });

  it("returns nothing without a worktree", () => {
    expect(keepaliveHeartbeat({ ...context, worktreePath: null }, 1, "ai coding")).toBeNull();
  });
});

describe("path helpers", () => {
  it("normalizes traversal without touching disk", () => {
    expect(normalize("/a/b/../c//d/./e")).toBe("/a/c/d/e");
    expect(normalize("/a/../..")).toBe("/");
  });

  it("treats a root as inside itself", () => {
    expect(isInside("/work/app", "/work/app")).toBe(true);
    expect(isInside("/work/app/x", "/work/app/")).toBe(true);
    expect(isInside("/work/application", "/work/app")).toBe(false);
  });
});
