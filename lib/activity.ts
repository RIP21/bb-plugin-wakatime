/**
 * Turns bb thread events into WakaTime heartbeats.
 *
 * The only input is plain data shaped like bb's `item/completed` event rows, so
 * every rule here is testable against a recorded payload.
 */

import {
  classifyCommand,
  countDiffLines,
  toWakatimeTime,
  type PendingHeartbeat,
  type WakatimeCategory,
  type WakatimeHeartbeat,
} from "./heartbeat.js";

/** Where a thread's work happens, resolved from bb's environment record. */
export interface ThreadContext {
  threadId: string;
  hostId: string;
  /** Absolute worktree root, or null for a thread with no workspace. */
  worktreePath: string | null;
  branchName: string | null;
  projectName: string | null;
}

export interface ExtractOptions {
  /** Category for work the agent did. */
  agentCategory: WakatimeCategory;
  /** Category for work the human did, or null to skip human activity. */
  humanCategory: WakatimeCategory | null;
  /** Derive `building` / `running tests` categories from shell commands. */
  classifyCommands: boolean;
  /** Emit heartbeats for files the agent read or searched, not just wrote. */
  trackFileReads: boolean;
  /** Allow entities outside the thread's worktree. */
  trackOutsideWorkspace: boolean;
}

/** The subset of a bb thread event row this module reads. */
export interface ThreadEventRowLike {
  seq: number;
  createdAt: number;
  type: string;
  data?: { item?: ThreadItemLike } | null;
}

export interface ThreadItemLike {
  type: string;
  status?: string;
  approvalStatus?: string | null;
  /** fileChange */
  changes?: readonly { path?: string; kind?: string; diff?: string; movePath?: string }[];
  /** commandExecution */
  command?: string;
  cwd?: string;
  /** toolCall */
  tool?: string;
  arguments?: Record<string, unknown>;
}

/**
 * Argument keys that always name a single file. Claude Code uses `file_path`
 * and `notebook_path`, Gemini uses `absolute_path`, and MCP servers vary.
 */
const FILE_PATH_KEYS = [
  "file_path",
  "filePath",
  "notebook_path",
  "notebookPath",
  "absolute_path",
  "absolutePath",
  "filename",
  "file",
] as const;

/**
 * Keys that may name either a file or a directory. Read passes a file in
 * `path`; Grep, Glob, and LS pass a directory in the same key, so the tool
 * name has to break the tie.
 */
const AMBIGUOUS_PATH_KEYS = ["path"] as const;

/** Tools whose ambiguous `path` argument is a directory to search, not a file. */
const DIRECTORY_TOOLS = new Set([
  "grep",
  "glob",
  "ls",
  "list_dir",
  "listdirectory",
  "search",
  "file_search",
  "codebase_search",
  "find",
]);

/**
 * Tools that carry no file at all. Writes arrive as `fileChange` items, so
 * anything else reaching the toolCall branch with a path is treated as a read.
 */
const IGNORED_TOOLS = new Set(["skill", "toolsearch", "askuserquestion", "todowrite", "task", "agent"]);

const MAX_LINE_CHANGES = 1_000_000;

/**
 * Extracts heartbeats from a batch of thread event rows, oldest first.
 *
 * Rows the plugin has no opinion about are ignored; a thread that produces
 * none still gets counted through the caller's keepalive heartbeat.
 */
export function extractHeartbeats(
  rows: readonly ThreadEventRowLike[],
  context: ThreadContext,
  options: ExtractOptions,
): PendingHeartbeat[] {
  const pending: PendingHeartbeat[] = [];
  for (const row of rows) {
    if (row.type !== "item/completed") continue;
    const item = row.data?.item;
    if (!item) continue;
    collectFromItem(item, row.createdAt, context, options, pending);
  }
  return pending;
}

function collectFromItem(
  item: ThreadItemLike,
  createdAt: number,
  context: ThreadContext,
  options: ExtractOptions,
  out: PendingHeartbeat[],
): void {
  switch (item.type) {
    case "fileChange":
      collectFileChange(item, createdAt, context, options, out);
      return;
    case "commandExecution":
      collectCommand(item, createdAt, context, options, out);
      return;
    case "toolCall":
      if (options.trackFileReads) collectToolCall(item, createdAt, context, options, out);
      return;
    case "userMessage":
      if (options.humanCategory) collectHumanMessage(createdAt, context, options.humanCategory, out);
      return;
    default:
      return;
  }
}

function collectFileChange(
  item: ThreadItemLike,
  createdAt: number,
  context: ThreadContext,
  options: ExtractOptions,
  out: PendingHeartbeat[],
): void {
  // A denied or failed edit never reached the disk, so it is not a write.
  if (item.approvalStatus === "denied") return;
  if (item.status && item.status !== "completed") return;

  for (const change of item.changes ?? []) {
    // A rename reports the destination in `movePath`; that is the live file.
    const path = change.movePath ?? change.path;
    if (!path) continue;
    if (!isTrackablePath(path, context, options)) continue;

    const lineChanges = change.diff ? countDiffLines(change.diff) : null;
    const heartbeat: WakatimeHeartbeat = {
      entity: path,
      entity_type: "file",
      category: options.agentCategory,
      time: toWakatimeTime(createdAt),
      is_write: true,
    };
    if (change.kind === "delete") {
      // wakatime-cli silently drops heartbeats for files missing from disk.
      heartbeat.is_unsaved_entity = true;
    }
    if (lineChanges) {
      const total = lineChanges.added + lineChanges.removed;
      if (total > 0 && total <= MAX_LINE_CHANGES) heartbeat.ai_line_changes = total;
    }
    out.push(withFallbacks(heartbeat, context, path, "file"));
  }
}

function collectCommand(
  item: ThreadItemLike,
  createdAt: number,
  context: ThreadContext,
  options: ExtractOptions,
  out: PendingHeartbeat[],
): void {
  // A denied command never ran, so it consumed no time. A command that ran
  // and failed did consume time: a failing test suite is real work.
  if (item.approvalStatus === "denied") return;

  const cwd = item.cwd;
  if (!cwd || !isTrackablePath(cwd, context, options)) return;

  const classified = options.classifyCommands && item.command ? classifyCommand(item.command) : null;
  const heartbeat: WakatimeHeartbeat = {
    entity: cwd,
    entity_type: "file",
    category: classified ?? options.agentCategory,
    time: toWakatimeTime(createdAt),
  };
  out.push(withFallbacks(heartbeat, context, cwd, "directory"));
}

function collectToolCall(
  item: ThreadItemLike,
  createdAt: number,
  context: ThreadContext,
  options: ExtractOptions,
  out: PendingHeartbeat[],
): void {
  const tool = item.tool?.toLowerCase();
  if (tool && IGNORED_TOOLS.has(tool)) return;
  if (item.approvalStatus === "denied") return;
  // A read that failed usually means the file is not there, and wakatime-cli
  // drops a missing entity silently. Skipping keeps the local log honest.
  if (item.status && item.status !== "completed") return;

  const found = readPathArgument(item.arguments);
  if (!found) return;
  const resolved = resolvePath(found.path, context);
  if (!resolved || !isTrackablePath(resolved, context, options)) return;

  const entityKind = resolvedEntityKind(found, tool);
  out.push(
    withFallbacks(
      {
        entity: resolved,
        entity_type: "file",
        category: options.agentCategory,
        time: toWakatimeTime(createdAt),
      },
      context,
      resolved,
      entityKind,
    ),
  );
}

/**
 * Decides whether a tool's path argument named a file or a directory.
 *
 * Getting this wrong is not cosmetic: a directory sent as a file makes
 * wakatime-cli log a warning per heartbeat into the log it shares with the
 * user's other editors, and lets a directory become the keepalive target.
 * An unrecognised tool passing a bare `path` is assumed to mean a file, which
 * is what every read-style tool means by it.
 */
function resolvedEntityKind(found: FoundPath, tool: string | undefined): "file" | "directory" {
  if (found.key === "unambiguous") return "file";
  if (found.path.endsWith("/") || found.path.endsWith("\\")) return "directory";
  return tool && DIRECTORY_TOOLS.has(tool) ? "directory" : "file";
}

function collectHumanMessage(
  createdAt: number,
  context: ThreadContext,
  category: WakatimeCategory,
  out: PendingHeartbeat[],
): void {
  // A prompt is not tied to a file, so it counts against the worktree root.
  if (!context.worktreePath) return;
  out.push(
    withFallbacks(
      {
        entity: context.worktreePath,
        entity_type: "file",
        category,
        time: toWakatimeTime(createdAt),
      },
      context,
      context.worktreePath,
      "directory",
    ),
  );
}

/**
 * Builds the keepalive heartbeat that keeps a busy thread counting while the
 * agent is thinking or streaming rather than touching files.
 *
 * It targets the last file the thread touched, the way an editor keepalives
 * against the open file: the time lands on a real file with a real language,
 * and wakatime-cli is not asked to read a directory as a file. Only a thread
 * that has touched nothing yet falls back to the worktree root.
 */
export function keepaliveHeartbeat(
  context: ThreadContext,
  nowMs: number,
  category: WakatimeCategory,
  lastFileEntity?: string | null,
): PendingHeartbeat | null {
  const entity =
    lastFileEntity && context.worktreePath && isInside(lastFileEntity, context.worktreePath)
      ? lastFileEntity
      : context.worktreePath;
  if (!entity) return null;
  return withFallbacks(
    {
      entity,
      entity_type: "file",
      category,
      time: toWakatimeTime(nowMs),
    },
    context,
    entity,
    entity === context.worktreePath ? "directory" : "file",
  );
}

/**
 * The most recent real file among a batch of heartbeats, for the next
 * keepalive to reuse. Directory entities from shell commands are skipped.
 */
export function lastFileEntityOf(pending: readonly PendingHeartbeat[]): string | null {
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const entry = pending[index]!;
    if (entry.entityKind === "file" && entry.heartbeat.entity_type === "file") return entry.heartbeat.entity;
  }
  return null;
}

/**
 * Attaches bb's own project and branch as *fallbacks*. WakaTime's plugin guide
 * is explicit that plugins pass `--alternate-project` and never `--project`,
 * so wakatime-cli's own detection always wins.
 */
function withFallbacks(
  heartbeat: WakatimeHeartbeat,
  context: ThreadContext,
  entityPath: string,
  entityKind: "file" | "directory",
): PendingHeartbeat {
  const inWorktree = context.worktreePath !== null && isInside(entityPath, context.worktreePath);
  if (context.projectName && inWorktree) heartbeat.alternate_project = context.projectName;
  if (context.branchName && inWorktree) heartbeat.alternate_branch = context.branchName;
  if (entityKind === "directory") {
    // Supplying the line count stops wakatime-cli from trying to read the
    // directory as a file, which it logs a warning for on every heartbeat.
    // Project, branch, and root-count detection are unaffected.
    heartbeat.lines = 0;
  }
  return {
    hostId: context.hostId,
    // A path outside the worktree gets no project root, so wakatime-cli
    // detects that file's own project instead of misfiling it under this one.
    projectFolder: inWorktree ? context.worktreePath : null,
    threadId: context.threadId,
    entityKind,
    heartbeat,
  };
}

interface FoundPath {
  path: string;
  /** Whether the key itself proves this is a file. */
  key: "unambiguous" | "ambiguous";
}

function readPathArgument(args: Record<string, unknown> | undefined): FoundPath | null {
  if (!args) return null;
  for (const key of FILE_PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return { path: value, key: "unambiguous" };
  }
  for (const key of AMBIGUOUS_PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return { path: value, key: "ambiguous" };
  }
  return null;
}

/** Resolves a relative tool argument against the thread's worktree. */
function resolvePath(path: string, context: ThreadContext): string | null {
  if (isAbsolute(path)) return normalize(path);
  if (!context.worktreePath) return null;
  return normalize(`${context.worktreePath}/${path}`);
}

function isTrackablePath(path: string, context: ThreadContext, options: ExtractOptions): boolean {
  if (!isAbsolute(path)) return false;
  if (options.trackOutsideWorkspace) return true;
  return context.worktreePath !== null && isInside(path, context.worktreePath);
}

export function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** True when `path` is `root` itself or sits beneath it. */
export function isInside(path: string, root: string): boolean {
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(root).replace(/\/+$/, "");
  if (normalizedPath === normalizedRoot) return true;
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

/** Collapses duplicate separators and resolves `.` / `..` without touching disk. */
export function normalize(path: string): string {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(path);
  const unified = path.replace(/\\/g, "/");
  const rooted = unified.startsWith("/");
  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const last = segments[segments.length - 1];
      if (segments.length > 0 && last !== ".." && !(windowsPath && segments.length === 1)) {
        segments.pop();
        continue;
      }
      if (rooted) continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (windowsPath) return joined;
  return rooted ? `/${joined}` : joined;
}
