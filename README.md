# bb-plugin-wakatime

Reports the time your bb threads spend on code to [WakaTime](https://wakatime.com).

Editor plugins track a human typing in a file. bb is different: an agent is
doing the work, across threads, on machines that may not be the one in front of
you. This plugin tracks that, and keeps your own time separate from the agent's.

## What it does

It watches bb thread events and turns them into WakaTime heartbeats:

| bb activity | Heartbeat |
| --- | --- |
| Agent edits a file | that file, marked as a write, with the diff's added and removed lines as `ai_line_changes` |
| Agent reads or greps a file | that file, no write flag |
| Agent runs a command | the working directory, categorized `building` or `running tests` when the command says so |
| You send a prompt | the worktree root, category `coding` |
| Thread running, touching nothing | the worktree root every 2 minutes, so thinking time still counts |

Agent work is filed as `ai coding` and yours as `coding`, so your dashboard can
split them. A `--project-folder`, `--alternate-project`, and
`--alternate-branch` come from bb's own environment record, which is how a
worktree on a remote machine still lands under the right project and branch.

## Install

```sh
bb plugin install .
bb plugin reload wakatime
```

You need a WakaTime API key. If you already use a WakaTime editor plugin, there
is nothing to do: the key in `~/.wakatime.cfg` is picked up. Otherwise set it in
Extensions → Plugins → WakaTime, or:

```sh
bb plugin config wakatime set apiKey waka_xxxxxxxx
bb plugin reload wakatime
```

Then check it:

```sh
bb wakatime doctor
```

## Where to see it

- **A live total in the sidebar.** The WakaTime row shows today's coding time
  (`41m`) beside it, refreshed when it changes.
- **The WakaTime page.** Click that row for today's total, threads running,
  heartbeats sent, and a per-project and per-category breakdown.
- **A button in the sidebar footer**, next to Settings, that jumps to the
  plugin's page.

On placement: bb's footer actions are host-rendered icon buttons with a static
tooltip, so a plugin cannot paint live text down there. A nav row's
`experimental_sidebarAccessory` is the one place it can, which is why the number
lives on the row and the footer button is a shortcut.

## Commands

```
bb wakatime status    # tracking state, wakatime-cli version, today's totals
bb wakatime today     # today's coding time per machine
bb wakatime sync      # flush heartbeats wakatime-cli queued offline
bb wakatime doctor    # diagnose a missing CLI or API key; exits 1 on a problem
bb wakatime log -n 20 # the last heartbeats this plugin sent
```

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `apiKey` | empty | Secret. Empty falls back to `~/.wakatime.cfg` on each machine. |
| `apiUrl` | empty | Point at a self-hosted server such as Wakapi or Hakatime. |
| `agentCategory` | `ai coding` | Set to `coding` to merge agent time with your own. |
| `trackHumanActivity` | on | Count the prompts you send. |
| `trackFileReads` | on | Count files the agent read, not only the ones it changed. |
| `classifyCommands` | on | Report test and build commands under their own categories. |
| `trackOutsideWorkspace` | off | Report files touched outside the thread's worktree. |
| `privacy` | `none` | `hide-project-folder` sends relative paths; `obfuscate-file-names` sends no filenames. |
| `autoInstallCli` | on | Download `wakatime-cli` on a machine that has none. |
| `allowCliAiLogParsing` | off | Let `wakatime-cli` also parse Claude and Codex transcripts. |

## How it works

WakaTime's [plugin guide](https://wakatime.com/help/creating-plugin) says to
shell out to `wakatime-cli` rather than call the API, so it owns language
detection, project detection, the offline queue, and the API key. This plugin
follows that.

Because bb is multi-machine, `wakatime-cli` runs in a `bb.host` worker on
whichever enrolled machine holds the worktree. That machine has the real files
and the real git repository, so detection works, and its `~/.wakatime.cfg` is
the same one the user's other editors use.

```
thread events ──▶ server: extract, throttle, group by machine
                              │
                              ▼  host RPC
                  host worker: wakatime-cli --extra-heartbeats
                              │
                              ▼
                        api.wakatime.com
```

Heartbeats carry the timestamp of the event that produced them, not of the
flush, so a delayed or requeued heartbeat still lands at the right minute.

### On totals and parallel threads

WakaTime derives a duration from the gaps between heartbeats, so a denser
heartbeat stream cannot inflate a project's time. Durations are computed per
project and then summed, though, so several threads running at once in
different worktrees can add up to more than wall-clock time for the day. That
is genuinely parallel work, and it is worth knowing before you read the number
as "hours at the keyboard".

### Deliberate choices

- **An existing `wakatime-cli` is never upgraded.** `~/.wakatime/wakatime-cli`
  is shared with your other editors, and a bb plugin should not move it under
  them. A missing one is downloaded, with its SHA-256 verified against the
  release's `checksums_sha256.txt` before it is ever executed.
- **`--alternate-project`, never `--project`.** WakaTime's guide is explicit
  that plugins pass fallbacks so `wakatime-cli`'s own detection wins.
- **A newly watched thread starts from when the plugin first saw it**, not
  from its current tip. Installing the plugin does not backfill your history,
  but a thread that starts working before the next poll does not lose those
  first seconds either. Cursors persist, so a bb restart resumes where it left
  off; anything older than 24 hours is dropped rather than backfilled.
- **`wakatime-cli`'s own AI transcript parsing is off on our runs.** The CLI
  parses Claude, Codex, and Cursor transcripts by default, including sessions
  run inside bb. This plugin knows bb's project, worktree, and branch, so it is
  the better source. Set `allowCliAiLogParsing` if you want both.
- **Your file paths stay local unless you send them.** The plugin's own
  activity log lives in bb's data directory; with
  `privacy: obfuscate-file-names` the filenames are redacted there too.
- **A failed send is retried, not dropped.** A thread's read cursor only
  advances once its heartbeats reach the machine, so a closed laptop means the
  next poll picks them up again rather than losing that stretch of time. After
  20 failed attempts it gives up and moves on, with a warning in the log.

Extra heartbeats reach `wakatime-cli` as a single-line JSON array. A
pretty-printed array is silently dropped while the CLI still exits 0, which is
worth knowing if you ever touch that code.

### Known limits

- **The API key is passed as `--key`.** `wakatime-cli` also reads
  `WAKATIME_API_KEY`, but only *after* a key in the machine's config file, so
  using it would silently break the plugin setting's precedence. `--key` is
  visible in the process list to other users on that machine, which matters on
  a shared build host. The key is stripped from anything the plugin reports
  back. Leaving the setting empty and using `~/.wakatime.cfg` avoids the
  exposure entirely, and is the default.
- **`wakatime-cli` exits 0 even when it drops a heartbeat** whose file is
  missing from disk, so `bb wakatime log` records those as sent. Deletes are
  flagged so they survive; a file that vanished for another reason is not
  detectable from the exit code.
- **A directory path from an unrecognised tool is assumed to be a file.**
  Known search tools are handled, and a trailing slash is respected.

## Development

```sh
npm install
npm test          # 242 tests
npm run typecheck
bb plugin dev     # rebuild and reload on save
```

The interesting logic is dependency-injected and tested without a bb server:

- `lib/heartbeat.ts` — diff line counting, command categorizing, the throttle
- `lib/activity.ts` — thread events to heartbeats
- `lib/cli-args.ts` — the exact `wakatime-cli` argv
- `lib/cli-install.ts` — finding and verifying the binary
- `lib/tracker.ts` — cursors, keepalives, grouping per machine
- `lib/duration.ts` — squeezing `--today` text into the sidebar's narrow box

`server.test.ts` and `host.test.ts` drive the real entry points through the
SDK's own harnesses.
