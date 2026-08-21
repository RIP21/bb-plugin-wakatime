/**
 * Builds wakatime-cli invocations. Pure, so the exact argv is testable.
 *
 * wakatime-cli always requires `--entity`, even alongside `--extra-heartbeats`,
 * so the first heartbeat of a group becomes flags and the rest go to stdin.
 */

import type { HeartbeatPayload } from "../contract.js";

export type PrivacyMode = "none" | "hide-project-folder" | "obfuscate-file-names";

export interface CliInvocationOptions {
  apiKey: string | null;
  apiUrl: string | null;
  pluginUserAgent: string;
  privacy: PrivacyMode;
  allowCliAiLogParsing: boolean;
}

export interface HeartbeatInvocation {
  args: string[];
  /** Single-line JSON for `--extra-heartbeats`, or null when the group has one. */
  stdin: string | null;
}

/**
 * wakatime-cli parses `--extra-heartbeats` stdin as one JSON document per line.
 * A pretty-printed array is rejected, and the CLI then drops every extra
 * heartbeat while still exiting 0, so this must stay on a single line.
 */
export function encodeExtraHeartbeats(heartbeats: readonly HeartbeatPayload[]): string {
  return JSON.stringify(heartbeats);
}

export function buildHeartbeatInvocation(
  group: { projectFolder: string | null; heartbeats: readonly HeartbeatPayload[] },
  options: CliInvocationOptions,
): HeartbeatInvocation {
  const [main, ...extras] = group.heartbeats;
  if (!main) throw new Error("buildHeartbeatInvocation requires at least one heartbeat");

  const args = [
    "--entity",
    main.entity,
    "--entity-type",
    main.entity_type,
    "--category",
    main.category,
    "--time",
    formatTime(main.time),
  ];

  if (main.is_write) args.push("--write");
  if (main.is_unsaved_entity) args.push("--is-unsaved-entity");
  if (main.ai_line_changes !== undefined) args.push("--ai-line-changes", String(main.ai_line_changes));
  if (main.human_line_changes !== undefined) args.push("--human-line-changes", String(main.human_line_changes));
  if (main.lines !== undefined) args.push("--lines-in-file", String(main.lines));
  if (main.alternate_project) args.push("--alternate-project", main.alternate_project);
  if (main.alternate_branch) args.push("--alternate-branch", main.alternate_branch);
  if (main.alternate_language) args.push("--alternate-language", main.alternate_language);
  if (group.projectFolder) args.push("--project-folder", group.projectFolder);

  args.push(...commonArgs(options));

  if (extras.length === 0) return { args, stdin: null };
  args.push("--extra-heartbeats");
  return { args, stdin: encodeExtraHeartbeats(extras) };
}

/** Flags every invocation shares, including the one-shot status commands. */
export function commonArgs(options: CliInvocationOptions): string[] {
  const args = ["--plugin", options.pluginUserAgent];
  if (options.apiKey) args.push("--key", options.apiKey);
  if (options.apiUrl) args.push("--api-url", options.apiUrl);

  if (options.privacy === "hide-project-folder") {
    args.push("--hide-project-folder");
  } else if (options.privacy === "obfuscate-file-names") {
    args.push("--hide-file-names", ".*");
  }

  // wakatime-cli parses local Claude, Codex, and Cursor transcripts on every
  // run by default. This plugin already reports bb's agent activity with bb's
  // own project and branch, so that second source is off unless asked for.
  if (!options.allowCliAiLogParsing) args.push("--sync-ai-disabled");

  return args;
}

/** Avoids exponent notation, which wakatime-cli would fail to parse as a float. */
function formatTime(seconds: number): string {
  return seconds.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
