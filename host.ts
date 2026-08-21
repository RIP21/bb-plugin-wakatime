/**
 * Host worker: the only place that runs wakatime-cli.
 *
 * It runs on whichever enrolled machine owns the worktree, so wakatime-cli sees
 * the real files and the real git repository and can do its own project,
 * language, and branch detection. It also means the API key can come from that
 * machine's `~/.wakatime.cfg`, shared with the user's other editors.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { access, constants } from "node:fs";
import { homedir } from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { unzipSync } from "fflate";
import { hostContract, type HeartbeatPayload } from "./contract.js";
import { describe } from "./lib/errors.js";
import { buildHeartbeatInvocation, commonArgs, type CliInvocationOptions } from "./lib/cli-args.js";
import {
  INSTALL_RETRY_COOLDOWN_MS,
  ensureCli,
  findInstalledCli,
  isPermanentInstallFailure,
  type CommandResult,
  type InstallerDeps,
  type ResolvedCli,
} from "./lib/cli-install.js";

const CLI_TIMEOUT_MS = 120_000;
/** Keep the tail of stderr for diagnostics without unbounded buffering. */
const MAX_CAPTURED_OUTPUT = 64 * 1024;

const deps: InstallerDeps = {
  platform: process.platform,
  arch: process.arch,
  homeDir: homedir(),
  env: process.env,
  pathExists: (path) =>
    new Promise<boolean>((resolve) => {
      access(path, constants.X_OK, (error) => resolve(!error));
    }),
  mkdirp: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeFile: async (path, data, mode) => {
    await writeFile(path, data);
    await chmod(path, mode);
  },
  linkOrCopy: async (target, linkPath) => {
    try {
      await symlink(target, linkPath);
    } catch {
      // Windows without developer mode, or a filesystem with no symlinks.
      await unlink(linkPath).catch(() => undefined);
      await copyFile(target, linkPath);
      await chmod(linkPath, 0o755);
    }
  },
  run: runCommand,
  fetch: (url, init) => fetch(url, { signal: init?.signal, redirect: "follow" }),
  unzip: (bytes) => unzipSync(bytes),
  sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
  log: (message) => console.error(`[wakatime] ${message}`),
  now: () => Date.now(),
  timeout: (ms) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms);
    return { signal: controller.signal, dispose: () => clearTimeout(timer) };
  },
};

/**
 * One in-flight install at a time. Concurrent `sendHeartbeats` calls would
 * otherwise race to write the same binary.
 */
let cliPromise: Promise<ResolvedCli> | null = null;
/** Earliest time a failed install may touch the network again. */
let installBlockedUntil = 0;
let installPermanentlyFailed: string | null = null;

async function resolveCli(autoInstall: boolean, signal?: AbortSignal): Promise<ResolvedCli> {
  if (installPermanentlyFailed) throw new Error(installPermanentlyFailed);
  if (deps.now() < installBlockedUntil) {
    throw new Error(
      `wakatime-cli is unavailable; not retrying the install for another ${Math.ceil((installBlockedUntil - deps.now()) / 1000)}s`,
    );
  }

  if (!cliPromise) {
    cliPromise = ensureCli(deps, autoInstall, signal).catch((error: unknown) => {
      cliPromise = null;
      if (isPermanentInstallFailure(deps)) {
        // This platform has no release, so retrying can never help.
        installPermanentlyFailed = describe(error);
      } else {
        // Back off. GitHub's unauthenticated API allows 60 requests an hour,
        // and a 30s poll would burn through that in half an hour.
        installBlockedUntil = deps.now() + INSTALL_RETRY_COOLDOWN_MS;
      }
      throw error;
    });
  }
  return cliPromise;
}

/** Drops a cached binary that has since been moved or deleted. */
function invalidateCliIfGone(error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "EACCES") cliPromise = null;
}

function runCommand(
  command: string,
  args: string[],
  options?: { stdin?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal: options?.signal,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeoutMs = options?.timeoutMs ?? CLI_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURED_OUTPUT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        // Distinguish a kill from the CLI's own non-zero exit.
        resolve({ code, stdout, stderr: `${stderr}\nwakatime-cli timed out after ${timeoutMs}ms`.trim() });
        return;
      }
      resolve({ code, stdout, stderr });
    });

    // A CLI that exits before draining a large --extra-heartbeats payload
    // makes stdin emit EPIPE. Unhandled, that would take down this worker.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options?.stdin ?? "");
  });
}

/** Reports whether this machine's wakatime.cfg already holds an API key. */
async function hasConfiguredApiKey(cliPath: string): Promise<boolean> {
  try {
    // Only the emptiness of the value crosses back to the server, never the key.
    const result = await runCommand(cliPath, ["--config-read", "api_key"], { timeoutMs: 15_000 });
    return result.code === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

interface CliState {
  path: string | null;
  version: string | null;
  origin: "existing" | "downloaded" | "missing";
  hasConfiguredApiKey: boolean;
  error: string | null;
}

async function cliState(
  autoInstall: boolean,
  needApiKeyCheck: boolean,
  signal?: AbortSignal,
): Promise<CliState & { cli: ResolvedCli | null }> {
  try {
    const cli = await resolveCli(autoInstall, signal);
    return {
      cli,
      path: cli.path,
      version: cli.version,
      origin: cli.origin,
      hasConfiguredApiKey: needApiKeyCheck ? await hasConfiguredApiKey(cli.path) : false,
      error: null,
    };
  } catch (error) {
    return {
      cli: null,
      path: null,
      version: null,
      origin: "missing",
      hasConfiguredApiKey: false,
      error: describe(error),
    };
  }
}

function toInvocationOptions(options: {
  apiKey: string | null;
  apiUrl: string | null;
  pluginUserAgent: string;
  privacy: "none" | "hide-project-folder" | "obfuscate-file-names";
  allowCliAiLogParsing: boolean;
}): CliInvocationOptions {
  return {
    apiKey: options.apiKey,
    apiUrl: options.apiUrl,
    pluginUserAgent: options.pluginUserAgent,
    privacy: options.privacy,
    allowCliAiLogParsing: options.allowCliAiLogParsing,
  };
}

async function readOfflineCount(cliPath: string, options: CliInvocationOptions): Promise<number | null> {
  try {
    const result = await runCommand(cliPath, ["--offline-count", ...commonArgs(options)], { timeoutMs: 20_000 });
    if (result.code !== 0) return null;
    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,

  handlers: {
    async sendHeartbeats({ groups, options }, context) {
      const state = await cliState(options.autoInstall, false, context.signal);
      const cliStatus = {
        path: state.path,
        version: state.version,
        origin: state.origin,
        hasConfiguredApiKey: state.hasConfiguredApiKey,
        error: state.error,
      };
      if (!state.cli) {
        const total = groups.reduce((sum, group) => sum + group.heartbeats.length, 0);
        return {
          cli: cliStatus,
          accepted: 0,
          failures: [
            {
              projectFolder: null,
              count: total,
              exitCode: null,
              message: state.error ?? "wakatime-cli is unavailable",
            },
          ],
        };
      }

      const invocationOptions = toInvocationOptions(options);
      let accepted = 0;
      const failures: { projectFolder: string | null; count: number; exitCode: number | null; message: string }[] = [];

      for (const group of groups) {
        if (context.signal.aborted) break;
        const heartbeats: HeartbeatPayload[] = [...group.heartbeats];
        const invocation = buildHeartbeatInvocation({ ...group, heartbeats }, invocationOptions);
        try {
          const result = await runCommand(state.cli.path, invocation.args, {
            stdin: invocation.stdin ?? undefined,
            signal: context.signal,
            timeoutMs: CLI_TIMEOUT_MS,
          });
          if (result.code === 0) {
            accepted += heartbeats.length;
          } else {
            failures.push({
              projectFolder: group.projectFolder,
              count: heartbeats.length,
              exitCode: result.code,
              message:
                redactKey(tail(result.stderr || result.stdout), options.apiKey) ||
                `wakatime-cli exited ${result.code}`,
            });
          }
        } catch (error) {
          invalidateCliIfGone(error);
          failures.push({
            projectFolder: group.projectFolder,
            count: heartbeats.length,
            exitCode: null,
            message: redactKey(describe(error), options.apiKey),
          });
        }
      }

      return { cli: cliStatus, accepted, failures };
    },

    async probe({ options, includeToday }) {
      // A probe reports what is already there; it never triggers a download.
      const found = await findInstalledCli(deps).catch(() => null);
      if (!found) {
        return {
          cli: {
            path: null,
            version: null,
            origin: "missing" as const,
            hasConfiguredApiKey: false,
            error: "wakatime-cli was not found on this machine",
          },
          offlineQueueCount: null,
          today: null,
          todayError: null,
        };
      }

      const invocationOptions = toInvocationOptions(options);
      const cli = {
        path: found.path,
        version: found.version,
        origin: found.origin,
        hasConfiguredApiKey: await hasConfiguredApiKey(found.path),
        error: null,
      };
      const offlineQueueCount = await readOfflineCount(found.path, invocationOptions);

      let today: string | null = null;
      let todayError: string | null = null;
      if (includeToday) {
        try {
          // `--today` reaches the API, so it fails without a usable key.
          const result = await runCommand(found.path, ["--today", ...commonArgs(invocationOptions)], {
            timeoutMs: 30_000,
          });
          // Empty output with a clean exit means no time recorded today, which
          // is different from a failure to ask.
          if (result.code === 0) today = result.stdout.trim() || "0 secs";
          else todayError = tail(result.stderr || result.stdout) || `wakatime-cli exited ${result.code}`;
        } catch (error) {
          todayError = describe(error);
        }
      }

      return { cli, offlineQueueCount, today, todayError };
    },

    async syncOffline({ options }, context) {
      const state = await cliState(options.autoInstall, false, context.signal);
      const cliStatus = {
        path: state.path,
        version: state.version,
        origin: state.origin,
        hasConfiguredApiKey: state.hasConfiguredApiKey,
        error: state.error,
      };
      if (!state.cli) {
        return { cli: cliStatus, queuedBefore: null, queuedAfter: null, error: state.error };
      }

      const invocationOptions = toInvocationOptions(options);
      const queuedBefore = await readOfflineCount(state.cli.path, invocationOptions);
      let error: string | null = null;
      try {
        // Zero syncs the whole queue, and no --entity means no new heartbeat.
        const result = await runCommand(
          state.cli.path,
          ["--sync-offline-activity", "0", ...commonArgs(invocationOptions)],
          { signal: context.signal, timeoutMs: CLI_TIMEOUT_MS },
        );
        if (result.code !== 0) {
          error = tail(result.stderr || result.stdout) || `wakatime-cli exited ${result.code}`;
        }
      } catch (caught) {
        error = describe(caught);
      }
      const queuedAfter = await readOfflineCount(state.cli.path, invocationOptions);
      return { cli: cliStatus, queuedBefore, queuedAfter, error };
    },
  },
});

/**
 * Removes the API key from captured output.
 *
 * The key is passed as `--key` because that is the only way to make the plugin
 * setting win over a machine's own wakatime.cfg. Captured stderr flows back to
 * the server and into the settings UI, so anything that ever echoed argv would
 * otherwise carry the key with it.
 */
function redactKey(text: string, apiKey: string | null): string {
  if (!apiKey || apiKey.length < 8) return text;
  return text.split(apiKey).join("<redacted>");
}

/** Last few lines of command output, trimmed for a status message. */
function tail(text: string, maxLength = 600): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `...${trimmed.slice(trimmed.length - maxLength)}`;
}
