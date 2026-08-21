import { describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import {
  assetBaseName,
  ensureCli,
  findInstalledCli,
  isPermanentInstallFailure,
  parseChecksums,
  wakatimeHome,
  type InstallerDeps,
} from "./cli-install.js";

interface HarnessOptions {
  platform?: string;
  arch?: string;
  existing?: string[];
  env?: Record<string, string | undefined>;
  /** Commands whose `--version` succeeds. */
  runnable?: string[];
  releaseTag?: string;
  corruptChecksum?: boolean;
  missingAsset?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const existing = new Set(options.existing ?? []);
  const runnable = new Set(options.runnable ?? [...existing]);
  const written = new Map<string, Uint8Array>();
  const links: { target: string; linkPath: string }[] = [];
  const tag = options.releaseTag ?? "v2.24.4";
  const assetName = `${assetBaseName(options.platform ?? "darwin", options.arch ?? "arm64")}.zip`;
  const binaryName = assetName.replace(/\.zip$/, "");
  const payload = new TextEncoder().encode("#!/bin/sh\necho v2.24.4\n");
  const zip = zipSync({ [options.missingAsset ? "unexpected-name" : binaryName]: payload });
  const digest = createHash("sha256").update(zip).digest("hex");

  const fetched: string[] = [];
  const deps: InstallerDeps = {
    platform: options.platform ?? "darwin",
    arch: options.arch ?? "arm64",
    homeDir: "/home/me",
    env: options.env ?? {},
    pathExists: async (path) => existing.has(path) || written.has(path),
    mkdirp: vi.fn(async () => undefined),
    writeFile: async (path, data) => {
      written.set(path, data);
      runnable.add(path);
    },
    linkOrCopy: async (target, linkPath) => {
      links.push({ target, linkPath });
    },
    run: async (command) => {
      if (!runnable.has(command)) return { code: 1, stdout: "", stderr: "not found" };
      return { code: 0, stdout: "v2.24.4\n", stderr: "" };
    },
    fetch: async (url) => {
      fetched.push(url);
      if (url.endsWith("/releases/latest")) {
        return response(JSON.stringify({ tag_name: tag }));
      }
      if (url.endsWith("checksums_sha256.txt")) {
        const value = options.corruptChecksum ? "0".repeat(64) : digest;
        return response(`${value}  ${assetName}\n`);
      }
      if (url.endsWith(assetName)) return response(zip);
      return { ok: false, status: 404, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    },
    unzip: (bytes) => {
      const { unzipSync } = require("fflate") as typeof import("fflate");
      return unzipSync(bytes);
    },
    sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
    log: vi.fn(),
    now: () => 1_700_000_000_000,
    timeout: () => ({ signal: new AbortController().signal, dispose: () => undefined }),
  };

  return { deps, written, links, fetched };
}

function response(body: string | Uint8Array) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    ok: true,
    status: 200,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

describe("assetBaseName", () => {
  it.each([
    ["darwin", "arm64", "wakatime-cli-darwin-arm64"],
    ["darwin", "x64", "wakatime-cli-darwin-amd64"],
    ["linux", "x64", "wakatime-cli-linux-amd64"],
    ["linux", "arm64", "wakatime-cli-linux-arm64"],
    ["win32", "x64", "wakatime-cli-windows-amd64"],
    ["linux", "ia32", "wakatime-cli-linux-386"],
  ])("maps %s/%s to the published asset", (platform, arch, expected) => {
    expect(assetBaseName(platform, arch)).toBe(expected);
  });

  it("fails loudly on a platform with no release", () => {
    expect(() => assetBaseName("sunos", "sparc")).toThrow(/no release/);
  });
});

describe("wakatimeHome", () => {
  it("defaults to ~/.wakatime, the path other editors share", () => {
    expect(wakatimeHome({ env: {}, homeDir: "/home/me" })).toBe("/home/me/.wakatime");
  });

  it("honours WAKATIME_HOME", () => {
    expect(wakatimeHome({ env: { WAKATIME_HOME: "/opt/wt/" }, homeDir: "/home/me" })).toBe("/opt/wt");
  });
});

describe("findInstalledCli", () => {
  it("prefers the shared ~/.wakatime/wakatime-cli path", async () => {
    const { deps } = harness({ existing: ["/home/me/.wakatime/wakatime-cli"] });
    await expect(findInstalledCli(deps)).resolves.toMatchObject({
      path: "/home/me/.wakatime/wakatime-cli",
      version: "v2.24.4",
      origin: "existing",
    });
  });

  it("falls back to the versioned filename", async () => {
    const { deps } = harness({ existing: ["/home/me/.wakatime/wakatime-cli-darwin-arm64"] });
    await expect(findInstalledCli(deps)).resolves.toMatchObject({
      path: "/home/me/.wakatime/wakatime-cli-darwin-arm64",
    });
  });

  it("falls back to PATH", async () => {
    const { deps } = harness({ existing: [], runnable: ["wakatime-cli"] });
    await expect(findInstalledCli(deps)).resolves.toMatchObject({ path: "wakatime-cli" });
  });

  it("returns null when nothing is installed", async () => {
    const { deps } = harness({ existing: [], runnable: [] });
    await expect(findInstalledCli(deps)).resolves.toBeNull();
  });

  it("ignores a present file that will not execute", async () => {
    const { deps } = harness({ existing: ["/home/me/.wakatime/wakatime-cli"], runnable: [] });
    await expect(findInstalledCli(deps)).resolves.toBeNull();
  });

  it("uses the .exe suffix on Windows", async () => {
    const { deps } = harness({
      platform: "win32",
      existing: ["/home/me/.wakatime/wakatime-cli.exe"],
    });
    await expect(findInstalledCli(deps)).resolves.toMatchObject({ path: "/home/me/.wakatime/wakatime-cli.exe" });
  });
});

describe("ensureCli", () => {
  it("never touches an existing install", async () => {
    const { deps, written, fetched } = harness({ existing: ["/home/me/.wakatime/wakatime-cli"] });
    const resolved = await ensureCli(deps, true);
    expect(resolved.origin).toBe("existing");
    expect(written.size).toBe(0);
    expect(fetched).toEqual([]);
  });

  it("downloads, verifies, and installs when nothing is present", async () => {
    const { deps, written, links } = harness({ existing: [], runnable: [] });
    const resolved = await ensureCli(deps, true);
    expect(resolved.origin).toBe("downloaded");
    expect(resolved.path).toBe("/home/me/.wakatime/wakatime-cli-darwin-arm64");
    expect(written.has("/home/me/.wakatime/wakatime-cli-darwin-arm64")).toBe(true);
    // The shared name is linked so other editors find the same binary.
    expect(links).toEqual([
      { target: "/home/me/.wakatime/wakatime-cli-darwin-arm64", linkPath: "/home/me/.wakatime/wakatime-cli" },
    ]);
  });

  it("refuses a download whose checksum does not match", async () => {
    const { deps, written } = harness({ existing: [], runnable: [], corruptChecksum: true });
    await expect(ensureCli(deps, true)).rejects.toThrow(/checksum mismatch/);
    expect(written.size).toBe(0);
  });

  it("accepts a single-entry archive whose binary is named differently", async () => {
    // The release asset name is not load-bearing: a one-file archive is
    // unpacked whatever it is called, and the bytes were already checksummed.
    const { deps } = harness({ existing: [], runnable: [], missingAsset: true });
    await expect(ensureCli(deps, true)).resolves.toMatchObject({ origin: "downloaded" });
  });

  it("passes an abort signal into every request", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const { deps } = harness({ existing: [], runnable: [] });
    const original = deps.fetch;
    deps.fetch = (url, init) => {
      seen.push(init?.signal);
      return original(url, init);
    };
    await ensureCli(deps, true);
    // Node's fetch has no default timeout, so an unsignalled request could
    // hang forever and wedge every later heartbeat send.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("aborts a download that outlives its timeout", async () => {
    const { deps } = harness({ existing: [], runnable: [] });
    const controller = new AbortController();
    deps.timeout = () => ({ signal: controller.signal, dispose: () => undefined });
    deps.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        controller.abort();
      });
    await expect(ensureCli(deps, true)).rejects.toThrow(/aborted/);
  });
});

describe("isPermanentInstallFailure", () => {
  it("is true only where no release can ever exist", () => {
    expect(isPermanentInstallFailure({ platform: "sunos", arch: "sparc" })).toBe(true);
    expect(isPermanentInstallFailure({ platform: "darwin", arch: "arm64" })).toBe(false);
  });

  it("explains itself instead of downloading when auto-install is off", async () => {
    const { deps, fetched } = harness({ existing: [], runnable: [] });
    await expect(ensureCli(deps, false)).rejects.toThrow(/not installed/);
    expect(fetched).toEqual([]);
  });
});

describe("parseChecksums", () => {
  it("parses the release checksums file", () => {
    const text = [
      `${"a".repeat(64)}  wakatime-cli-darwin-arm64.zip`,
      `${"b".repeat(64)} *./wakatime-cli-linux-amd64.zip`,
      "not a checksum line",
      "",
    ].join("\n");
    expect(parseChecksums(text)).toEqual({
      "wakatime-cli-darwin-arm64.zip": "a".repeat(64),
      "wakatime-cli-linux-amd64.zip": "b".repeat(64),
    });
  });
});
