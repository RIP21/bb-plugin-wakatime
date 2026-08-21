/**
 * Finds, and if necessary downloads, wakatime-cli on a host machine.
 *
 * All I/O arrives through `InstallerDeps` so the resolution and download rules
 * can be tested without a network or a real filesystem.
 */

import { describe } from "./errors.js";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Bounds every network call in the install path. */
export const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Quiet period after a failed install before the network is touched again. */
export const INSTALL_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

export interface InstallerDeps {
  /** `process.platform`. */
  platform: string;
  /** `process.arch`. */
  arch: string;
  homeDir: string;
  env: Record<string, string | undefined>;
  pathExists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  writeFile(path: string, data: Uint8Array, mode: number): Promise<void>;
  /** Best-effort convenience symlink; falls back to a copy where unsupported. */
  linkOrCopy(target: string, linkPath: string): Promise<void>;
  run(command: string, args: string[], options?: { stdin?: string; timeoutMs?: number }): Promise<CommandResult>;
  /** Must honour `signal`; nothing here may block forever. */
  fetch(url: string, init?: { signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
  unzip(bytes: Uint8Array): Record<string, Uint8Array>;
  sha256(bytes: Uint8Array): string;
  log(message: string): void;
  now(): number;
  /** Bounded wait used to time out a download. */
  timeout(ms: number): { signal: AbortSignal; dispose(): void };
}

export interface ResolvedCli {
  path: string;
  version: string | null;
  origin: "existing" | "downloaded";
}

const RELEASE_API = "https://api.github.com/repos/wakatime/wakatime-cli/releases/latest";
const RELEASE_DOWNLOAD = "https://github.com/wakatime/wakatime-cli/releases/download";

const GOOS: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
  freebsd: "freebsd",
  openbsd: "openbsd",
  netbsd: "netbsd",
  android: "android",
};

const GOARCH: Record<string, string> = {
  x64: "amd64",
  arm64: "arm64",
  ia32: "386",
  x86: "386",
  arm: "arm",
  riscv64: "riscv64",
};

/** The release asset for a platform, e.g. `wakatime-cli-darwin-arm64`. */
export function assetBaseName(platform: string, arch: string): string {
  const goos = GOOS[platform];
  const goarch = GOARCH[arch];
  if (!goos || !goarch) {
    throw new Error(`wakatime-cli has no release for ${platform}/${arch}`);
  }
  return `wakatime-cli-${goos}-${goarch}`;
}

/** `$WAKATIME_HOME` when set, else `~/.wakatime`, matching every other plugin. */
export function wakatimeHome(deps: Pick<InstallerDeps, "env" | "homeDir">): string {
  const configured = deps.env.WAKATIME_HOME?.trim();
  if (configured) return stripTrailingSlash(configured);
  return `${stripTrailingSlash(deps.homeDir)}/.wakatime`;
}

function stripTrailingSlash(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

function executableSuffix(platform: string): string {
  return platform === "win32" ? ".exe" : "";
}

/**
 * Locates an installed wakatime-cli without downloading anything.
 *
 * The shared `~/.wakatime/wakatime-cli` path is checked first because that is
 * where every other WakaTime editor plugin installs it.
 */
export async function findInstalledCli(deps: InstallerDeps): Promise<ResolvedCli | null> {
  const home = wakatimeHome(deps);
  const suffix = executableSuffix(deps.platform);
  const candidates = [`${home}/wakatime-cli${suffix}`];
  try {
    candidates.push(`${home}/${assetBaseName(deps.platform, deps.arch)}${suffix}`);
  } catch {
    // Unsupported platform; the PATH lookup below may still find a binary.
  }

  for (const candidate of candidates) {
    if (!(await deps.pathExists(candidate))) continue;
    const version = await readVersion(deps, candidate);
    if (version !== null) return { path: candidate, version, origin: "existing" };
  }

  // Fall back to whatever is on PATH, which covers package-manager installs.
  const onPath = `wakatime-cli${suffix}`;
  const version = await readVersion(deps, onPath);
  if (version !== null) return { path: onPath, version, origin: "existing" };

  return null;
}

async function readVersion(deps: InstallerDeps, command: string): Promise<string | null> {
  try {
    const result = await deps.run(command, ["--version"], { timeoutMs: 15_000 });
    if (result.code !== 0) return null;
    const version = result.stdout.trim().split("\n")[0]?.trim();
    return version && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * Returns a usable wakatime-cli, downloading the latest release only when the
 * host has none.
 *
 * An existing binary is deliberately never upgraded: `~/.wakatime/wakatime-cli`
 * is shared with the user's other editors, and a bb plugin should not move it
 * under them.
 */
export async function ensureCli(
  deps: InstallerDeps,
  autoInstall: boolean,
  signal?: AbortSignal,
): Promise<ResolvedCli> {
  const existing = await findInstalledCli(deps);
  if (existing) return existing;
  if (!autoInstall) {
    throw new Error(
      "wakatime-cli is not installed on this machine. Enable automatic install in the WakaTime plugin settings, or install it from https://github.com/wakatime/wakatime-cli/releases",
    );
  }
  return downloadCli(deps, signal);
}

async function downloadCli(deps: InstallerDeps, signal?: AbortSignal): Promise<ResolvedCli> {
  // Bound the whole download. Node's fetch has no default timeout, and a
  // request that never settles would wedge every later heartbeat send.
  const bound = deps.timeout(DOWNLOAD_TIMEOUT_MS);
  try {
    return await downloadWithin(deps, signal ?? bound.signal, bound.signal);
  } finally {
    bound.dispose();
  }
}

async function downloadWithin(
  deps: InstallerDeps,
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): Promise<ResolvedCli> {
  const signal = anySignal([callerSignal, timeoutSignal]);
  const base = assetBaseName(deps.platform, deps.arch);
  const tag = await latestReleaseTag(deps, signal);
  const zipName = `${base}.zip`;
  deps.log(`downloading wakatime-cli ${tag} (${zipName})`);

  const zipBytes = await fetchBytes(deps, `${RELEASE_DOWNLOAD}/${tag}/${zipName}`, signal);
  await verifyChecksum(deps, tag, zipName, zipBytes, signal);

  const entries = deps.unzip(zipBytes);
  const suffix = executableSuffix(deps.platform);
  const wanted = `${base}${suffix}`;
  const binary = entries[wanted] ?? pickSingleEntry(entries);
  if (!binary) {
    throw new Error(`release archive ${zipName} did not contain ${wanted}`);
  }

  const home = wakatimeHome(deps);
  await deps.mkdirp(home);
  const versionedPath = `${home}/${wanted}`;
  await deps.writeFile(versionedPath, binary, 0o755);

  const sharedPath = `${home}/wakatime-cli${suffix}`;
  if (!(await deps.pathExists(sharedPath))) {
    try {
      await deps.linkOrCopy(versionedPath, sharedPath);
    } catch (error) {
      // The versioned path still works, so this is not fatal.
      deps.log(`could not create ${sharedPath}: ${describe(error)}`);
    }
  }

  const version = await readVersion(deps, versionedPath);
  if (version === null) {
    throw new Error(`downloaded wakatime-cli at ${versionedPath} is not executable`);
  }
  return { path: versionedPath, version, origin: "downloaded" };
}

function pickSingleEntry(entries: Record<string, Uint8Array>): Uint8Array | null {
  const names = Object.keys(entries).filter((name) => !name.endsWith("/"));
  return names.length === 1 ? (entries[names[0]!] ?? null) : null;
}

async function latestReleaseTag(deps: InstallerDeps, signal: AbortSignal): Promise<string> {
  const response = await deps.fetch(RELEASE_API, { signal });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for the latest wakatime-cli release`);
  }
  const parsed: unknown = JSON.parse(await response.text());
  const tag =
    typeof parsed === "object" && parsed !== null ? (parsed as { tag_name?: unknown }).tag_name : undefined;
  if (typeof tag !== "string" || tag.length === 0) {
    throw new Error("GitHub release response had no tag_name");
  }
  return tag;
}

async function fetchBytes(deps: InstallerDeps, url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await deps.fetch(url, { signal });
  if (!response.ok) throw new Error(`download failed with ${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Verifies the archive against the release's `checksums_sha256.txt`, because
 * this downloads a binary and then executes it.
 */
async function verifyChecksum(
  deps: InstallerDeps,
  tag: string,
  zipName: string,
  zipBytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  const response = await deps.fetch(`${RELEASE_DOWNLOAD}/${tag}/checksums_sha256.txt`, { signal });
  if (!response.ok) {
    throw new Error(`could not fetch checksums for wakatime-cli ${tag} (HTTP ${response.status})`);
  }
  const expected = parseChecksums(await response.text())[zipName];
  if (!expected) {
    throw new Error(`checksums file for ${tag} has no entry for ${zipName}`);
  }
  const actual = deps.sha256(zipBytes);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`checksum mismatch for ${zipName}: expected ${expected}, got ${actual}`);
  }
}

/** Parses `<sha256>  <filename>` lines into a lookup by filename. */
export function parseChecksums(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (!match) continue;
    const name = match[2]!.replace(/^\.\//, "");
    result[name] = match[1]!;
  }
  return result;
}

/** Aborts as soon as any input signal does. */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * True when a platform will never have a release, so retrying is pointless.
 * Distinguishing this from a network failure keeps the caller from hammering
 * GitHub's unauthenticated rate limit on a machine that can never succeed.
 */
export function isPermanentInstallFailure(deps: Pick<InstallerDeps, "platform" | "arch">): boolean {
  try {
    assetBaseName(deps.platform, deps.arch);
    return false;
  } catch {
    return true;
  }
}
