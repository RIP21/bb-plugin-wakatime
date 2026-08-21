import { describe, expect, it } from "vitest";
import type { HeartbeatPayload } from "../contract.js";
import { buildHeartbeatInvocation, commonArgs, encodeExtraHeartbeats, type CliInvocationOptions } from "./cli-args.js";

const options: CliInvocationOptions = {
  apiKey: null,
  apiUrl: null,
  pluginUserAgent: "bb/0.39.0 bb-wakatime/0.1.0",
  privacy: "none",
  allowCliAiLogParsing: false,
};

const write: HeartbeatPayload = {
  entity: "/work/app/src/a.ts",
  entity_type: "file",
  category: "ai coding",
  time: 1787216428.61818,
  is_write: true,
  ai_line_changes: 12,
  alternate_project: "app",
  alternate_branch: "feature/probe",
};

/** Reads the value that follows a flag, so order changes do not break tests. */
function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("buildHeartbeatInvocation", () => {
  it("passes the first heartbeat as flags", () => {
    const { args, stdin } = buildHeartbeatInvocation({ projectFolder: "/work/app", heartbeats: [write] }, options);
    expect(valueOf(args, "--entity")).toBe("/work/app/src/a.ts");
    expect(valueOf(args, "--entity-type")).toBe("file");
    expect(valueOf(args, "--category")).toBe("ai coding");
    expect(valueOf(args, "--ai-line-changes")).toBe("12");
    expect(valueOf(args, "--project-folder")).toBe("/work/app");
    expect(args).toContain("--write");
    expect(stdin).toBeNull();
  });

  it("uses --alternate-project, never --project, so the CLI's detection wins", () => {
    const { args } = buildHeartbeatInvocation({ projectFolder: "/work/app", heartbeats: [write] }, options);
    expect(valueOf(args, "--alternate-project")).toBe("app");
    expect(valueOf(args, "--alternate-branch")).toBe("feature/probe");
    expect(args).not.toContain("--project");
    expect(args).not.toContain("--branch");
  });

  it("formats time as a plain decimal, never exponent notation", () => {
    const { args } = buildHeartbeatInvocation({ projectFolder: null, heartbeats: [write] }, options);
    expect(valueOf(args, "--time")).toBe("1787216428.61818");
    expect(valueOf(args, "--time")).not.toMatch(/e/i);
  });

  it("sends the remaining heartbeats through --extra-heartbeats", () => {
    const second: HeartbeatPayload = { ...write, entity: "/work/app/src/b.ts", ai_line_changes: 3 };
    const { args, stdin } = buildHeartbeatInvocation(
      { projectFolder: "/work/app", heartbeats: [write, second] },
      options,
    );
    expect(args).toContain("--extra-heartbeats");
    expect(JSON.parse(stdin!)).toEqual([second]);
  });

  it("keeps extras on one line, since the CLI drops a multi-line array", () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ ...write, entity: `/work/app/${index}.ts` }));
    const { stdin } = buildHeartbeatInvocation({ projectFolder: null, heartbeats: many }, options);
    expect(stdin).not.toContain("\n");
    expect(JSON.parse(stdin!)).toHaveLength(4);
  });

  it("omits --project-folder when the entity has no known project root", () => {
    const { args } = buildHeartbeatInvocation({ projectFolder: null, heartbeats: [write] }, options);
    expect(args).not.toContain("--project-folder");
  });

  it("flags a deleted file as unsaved", () => {
    const deleted: HeartbeatPayload = { ...write, is_unsaved_entity: true };
    const { args } = buildHeartbeatInvocation({ projectFolder: null, heartbeats: [deleted] }, options);
    expect(args).toContain("--is-unsaved-entity");
  });

  it("omits --write for a read", () => {
    const read: HeartbeatPayload = { entity: "/work/app/r.ts", entity_type: "file", category: "ai coding", time: 1 };
    const { args } = buildHeartbeatInvocation({ projectFolder: null, heartbeats: [read] }, options);
    expect(args).not.toContain("--write");
    expect(args).not.toContain("--ai-line-changes");
  });

  it("refuses an empty group rather than running a broken command", () => {
    expect(() => buildHeartbeatInvocation({ projectFolder: null, heartbeats: [] }, options)).toThrow();
  });
});

describe("commonArgs", () => {
  it("always identifies the plugin for the User-Agent header", () => {
    expect(valueOf(commonArgs(options), "--plugin")).toBe("bb/0.39.0 bb-wakatime/0.1.0");
  });

  it("disables the CLI's own AI transcript parsing by default", () => {
    expect(commonArgs(options)).toContain("--sync-ai-disabled");
    expect(commonArgs({ ...options, allowCliAiLogParsing: true })).not.toContain("--sync-ai-disabled");
  });

  it("omits the key and URL so the machine's own config applies", () => {
    const args = commonArgs(options);
    expect(args).not.toContain("--key");
    expect(args).not.toContain("--api-url");
  });

  it("passes an explicit key and self-hosted URL when configured", () => {
    const args = commonArgs({ ...options, apiKey: "secret", apiUrl: "https://wakapi.example/api/v1" });
    expect(valueOf(args, "--key")).toBe("secret");
    expect(valueOf(args, "--api-url")).toBe("https://wakapi.example/api/v1");
  });

  it("maps the privacy modes to the CLI's own flags", () => {
    expect(commonArgs({ ...options, privacy: "hide-project-folder" })).toContain("--hide-project-folder");
    const obfuscated = commonArgs({ ...options, privacy: "obfuscate-file-names" });
    expect(valueOf(obfuscated, "--hide-file-names")).toBe(".*");
  });
});

describe("encodeExtraHeartbeats", () => {
  it("emits a single-line JSON array", () => {
    const encoded = encodeExtraHeartbeats([write, { ...write, entity: "/b.ts" }]);
    expect(encoded.split("\n")).toHaveLength(1);
    expect(JSON.parse(encoded)).toHaveLength(2);
  });
});
