/**
 * Pure WakaTime heartbeat helpers. Nothing here touches bb or the filesystem,
 * so the interesting decisions stay unit-testable.
 */

/** Categories wakatime-cli v2 accepts for `--category`. */
export const WAKATIME_CATEGORIES = [
  "coding",
  "ai coding",
  "building",
  "indexing",
  "debugging",
  "learning",
  "notes",
  "meeting",
  "planning",
  "researching",
  "communicating",
  "supporting",
  "advising",
  "running tests",
  "writing tests",
  "manual testing",
  "writing docs",
  "code reviewing",
  "browsing",
  "translating",
  "designing",
] as const;

export type WakatimeCategory = (typeof WAKATIME_CATEGORIES)[number];

export type WakatimeEntityType = "file" | "app" | "domain" | "url";

/**
 * One heartbeat in the shape wakatime-cli reads from `--extra-heartbeats`.
 * Key names come from wakatime-cli's own `ExtraHeartbeat` struct, so they are
 * snake_case and deliberately not camelCase.
 */
export interface WakatimeHeartbeat {
  entity: string;
  entity_type: WakatimeEntityType;
  category: WakatimeCategory;
  /** Epoch seconds, fractional. */
  time: number;
  is_write?: boolean;
  /** Tracks an entity that no longer exists on disk, such as a deleted file. */
  is_unsaved_entity?: boolean;
  ai_line_changes?: number;
  human_line_changes?: number;
  lines?: number;
  alternate_project?: string;
  alternate_branch?: string;
  alternate_language?: string;
}

/** A heartbeat plus the routing bb needs to pick a host and a project root. */
export interface PendingHeartbeat {
  hostId: string;
  /** Worktree root passed as `--project-folder`, or null to let the CLI decide. */
  projectFolder: string | null;
  threadId: string;
  /**
   * Whether the entity is a real file or a directory. wakatime-cli accepts a
   * directory entity and still detects the project, but it cannot count its
   * lines, so a directory is never reused as a keepalive target.
   */
  entityKind: "file" | "directory";
  heartbeat: WakatimeHeartbeat;
}

/**
 * Counts added and removed lines in a bb `fileChange` diff.
 *
 * bb emits `--- a/path` and `+++ b/path` headers with no `@@` hunk markers, so
 * the header lines have to be skipped before counting the +/- prefixes.
 */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

const TEST_RUNNERS = new Set([
  "vitest",
  "jest",
  "pytest",
  "mocha",
  "ava",
  "tox",
  "rspec",
  "phpunit",
  "nose2",
  "ctest",
  "gotestsum",
  "playwright",
  "cypress",
  "nextest",
]);

const BUILD_TOOLS = new Set([
  "tsc",
  "make",
  "cmake",
  "webpack",
  "rollup",
  "esbuild",
  "vite",
  "gradle",
  "gradlew",
  "maven",
  "mvn",
  "ninja",
  "bazel",
  "swiftc",
  "gcc",
  "clang",
  "rustc",
  "javac",
]);

const DEBUGGERS = new Set(["gdb", "lldb", "pdb", "delve", "dlv"]);

const PACKAGE_RUNNERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "npx",
  "pnpx",
  "poetry",
  "uv",
  "rye",
  "pdm",
]);

const TOOLCHAINS = new Set(["cargo", "go", "dotnet", "swift", "flutter", "dart", "mix", "sbt"]);

/** Shell operators that separate independently classifiable commands. */
const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\|)\s*/;

const REVIEW_VERBS = new Set(["diff", "log", "show", "blame", "pr", "status"]);

/**
 * Package script names, which are conventionally prefixed: `test:unit`,
 * `build-prod`, `test_e2e`. A path argument like `tests/` will not match.
 */
const TEST_SCRIPT = /^tests?(?:[:\-_].*)?$/;
const BUILD_SCRIPT = /^(?:build|compile)(?:[:\-_].*)?$/;

/**
 * Guesses a WakaTime category from a shell command, or returns null when the
 * command says nothing useful about the kind of work.
 *
 * Only a segment's leading program and its own arguments are inspected, so
 * `cat test.txt` stays unclassified instead of counting as a test run.
 */
export function classifyCommand(command: string): WakatimeCategory | null {
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const category = classifySegment(segment);
    if (category) return category;
  }
  return null;
}

function classifySegment(segment: string): WakatimeCategory | null {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  while (tokens.length > 0) {
    const head = tokens[0]!;
    // Skip sudo, time, env, and leading KEY=value environment assignments.
    if (head === "sudo" || head === "time" || head === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      tokens.shift();
      continue;
    }
    break;
  }
  if (tokens.length === 0) return null;

  const program = basename(tokens[0]!).toLowerCase();
  const args = tokens.slice(1).map((token) => token.toLowerCase());

  if (TEST_RUNNERS.has(program)) return "running tests";
  if (DEBUGGERS.has(program)) return "debugging";
  if (BUILD_TOOLS.has(program)) return "building";

  if (program === "git" || program === "gh" || program === "jj") {
    return args.some((arg) => REVIEW_VERBS.has(arg)) ? "code reviewing" : null;
  }

  if (TOOLCHAINS.has(program) || PACKAGE_RUNNERS.has(program)) {
    // Covers `npm run build`, `cargo test`, `go build ./...`, `uv run pytest`,
    // and prefixed script names such as `test:unit` or `build-prod`.
    for (const arg of args) {
      if (TEST_SCRIPT.test(arg) || TEST_RUNNERS.has(basename(arg))) return "running tests";
      if (BUILD_SCRIPT.test(arg) || BUILD_TOOLS.has(basename(arg))) return "building";
    }
    return null;
  }

  return null;
}

function basename(pathLike: string): string {
  const normalized = pathLike.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/**
 * Applies WakaTime's plugin throttle rule: a write always sends, and anything
 * else sends only when the same entity has been quiet for `minIntervalMs`.
 *
 * This mirrors the rule in WakaTime's plugin guide, which says to skip a
 * heartbeat when it is not a write, the file has not changed, and less than
 * two minutes have passed since the last one.
 */
export class HeartbeatThrottle {
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly minIntervalMs = 120_000,
    private readonly maxEntries = 4096,
  ) {}

  /** Returns true when the heartbeat should be sent, and records it. */
  admit(key: string, timeMs: number, isWrite: boolean): boolean {
    const previous = this.lastSentAt.get(key);
    if (!isWrite && previous !== undefined && timeMs - previous < this.minIntervalMs) {
      return false;
    }
    // Re-inserting keeps Map iteration order newest-last so pruning is FIFO.
    this.lastSentAt.delete(key);
    this.lastSentAt.set(key, timeMs);
    while (this.lastSentAt.size > this.maxEntries) {
      const oldest = this.lastSentAt.keys().next();
      if (oldest.done) break;
      this.lastSentAt.delete(oldest.value);
    }
    return true;
  }
}

/** Throttle key: the same file counts separately per host and per category. */
export function throttleKey(pending: PendingHeartbeat): string {
  return `${pending.hostId} ${pending.heartbeat.category} ${pending.heartbeat.entity}`;
}

/** Converts bb's epoch-millisecond timestamps to WakaTime's fractional seconds. */
export function toWakatimeTime(epochMs: number): number {
  return Math.round(epochMs) / 1000;
}
