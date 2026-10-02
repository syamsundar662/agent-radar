# How Agent Radar works

This is the design reference: where the data comes from, how it is turned into a
snapshot, and how the page and the village use it. For setup and everyday use, see the
[README](../README.md).

## Overview

```text
 ~/.claude/sessions/*.json ─┐
 ~/.claude/projects/...     ├─> collector.mjs ──> village.mjs ──> server.mjs ──SSE──> browser
 process list (ps)         ─┘    (snapshot)       (saved          (127.0.0.1)         app.js   (radar, cards, wire)
                                                   buildings)                         floor.js (3D village)
                                                       │
                                            ~/.agent-radar/village.json
```

1. **`collector.mjs`** builds a point-in-time snapshot of every agent on the machine.
2. **`village.mjs`** records each conversation it sees and adds the buildings of
   conversations that have ended (`saved`).
3. **`server.mjs`** serves the page and streams the snapshot to every open tab.
4. **`public/app.js`** and **`public/floor.js`** render it.

There is no database and no build step. The only state Agent Radar keeps is
`~/.agent-radar/village.json`.

## The refresh loop

- While at least one tab is open, the server takes a snapshot **every 2 seconds** and
  pushes it to all tabs.
- With no tab open it still takes one **every 15 seconds**, so the village keeps
  recording conversations (and the level they reached) while nobody is watching.
- Requests that arrive while a snapshot is being built share it instead of starting
  another one.
- In `--demo` mode the snapshot comes from `demo.mjs` instead, and nothing is recorded.

## Where the data comes from

### Live sessions: `~/.claude/sessions/<pid>.json`

Claude Code writes one small JSON file per running session, named after its process
id. Agent Radar reads `pid`, `sessionId`, `cwd`, `name`, `status`, `statusUpdatedAt`,
`startedAt`, `version`, `kind` and `entrypoint`.

A session counts as live only if its pid is in the process list **and** that process's
command contains `claude`. Session files can outlive a crashed process, and the
operating system reuses pids, so the file alone isn't proof.

`status` is what Claude Code reports: `busy` (working), `idle` (waiting for your
prompt) or `shell` (a shell command has the foreground). Other values are shown as-is.

### Transcripts: `~/.claude/projects/<folder>/<sessionId>.jsonl`

Each conversation is a JSON-lines transcript. `<folder>` is the session's working
directory with every character that isn't a letter or digit replaced by `-`. Very long
paths get a shortened folder name, so if the direct path doesn't exist Agent Radar
searches the project folders once and remembers the answer.

Transcripts can reach hundreds of megabytes, so only the **end** is read: the last
512 KB, widened 4x at a time (up to 16 MB) until it contains at least 24 assistant
messages, because large screenshots or tool results can crowd them out. The result is
cached until the file's size or modification time changes.

From those records Agent Radar works out:

| Field | From |
| --- | --- |
| `title` | the latest `ai-title` record |
| `lastPrompt` | the latest `last-prompt` record or plain user message |
| `model` | the latest assistant message |
| `contextTokens` | the latest assistant message's usage: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` |
| `gitBranch` | the latest record that has one |
| `lastActivityAt` | the latest timestamp |
| `finished` | whether the latest assistant message ended its turn (`stop_reason: end_turn`) |
| `events` | the last 24 events (see below) |
| `last` | the most recent event, or `thinking` if the model was last thinking |

Event kinds:

| Kind | Meaning |
| --- | --- |
| `prompt` | something you typed |
| `tool` | a tool call, with a one-line summary (command description, file path, search pattern, URL, ...) |
| `say` | text Claude wrote back |
| `err` | a tool call that returned an error |
| `cmd` | a slash command such as `/clear` |
| `notify` | a background task notification |
| `interrupt` | you interrupted the turn |
| `done` | a turn finished (with its duration) |

### Subagents: `.../<sessionId>/subagents/`

Subagent transcripts (`agent-*.jsonl`) live next to the main transcript, with a
`*.meta.json` holding `agentType`, `description` and whether it ran in the background.
Only subagents written to in the last 6 hours are shown, at most 12 per session. Each
one is:

- **done** if its last message ended its turn,
- **running** if not, and it was written to in the last 10 minutes,
- **stalled** otherwise.

### Processes

On macOS and Linux the process list comes from
`ps -axo pid=,ppid=,pcpu=,rss=,etime=,tty=,command=`. On Windows it comes from
PowerShell's `Get-CimInstance Win32_Process`, which has no cheap CPU figure, so CPU
shows 0 there. If the list can't be read at all, sessions are checked one by one with
signal 0 (which tests that a pid exists without affecting it) and CPU and memory show 0.

CPU, memory and process count for a session cover its **whole process tree**: Claude
Code plus every shell, language server and tool it started.

**Other agents** are matched by executable name (`codex`, `gemini`, `aider`, `ollama`,
`copilot-language-server`, `cursor`, `windsurf`, and `claude` processes that aren't
interactive sessions) or, for macOS apps, by the full path of the app's main
process (Claude Desktop, ChatGPT, Cursor, Windsurf). Worker processes started by
another process of the same kind are counted once. Agents running inside an editor are
labelled with it (Cursor, VS Code or Windsurf).

### Secret masking

Before any text reaches the page it goes through `redact()` in `collector.mjs`, which
masks credentials in URLs (`https://user:pass@...`), keys shaped like `sk-...`,
`ghp_...` (and the other GitHub token prefixes), `AKIA...` and Slack `xox?-...`, and
values after `password`, `passwd`, `secret`, `token` or `api_key`. It is a safety net
for screen sharing, not a guarantee.

## The snapshot

`GET /api/snapshot` returns the current snapshot as JSON; `GET /api/stream` sends the
same object as a Server-Sent Event (`data: {...}`) on every refresh.

```jsonc
{
  "generatedAt": 1790932539342,          // ms since epoch
  "host": "my-laptop",
  "cores": 10,
  "loadavg": [1.2, 1.6, 1.9],
  "totals": { "cpu": 54.2, "rssMB": 2650, "processes": 39 },  // all agents together
  "sessions": [
    {
      "pid": 41021,
      "sessionId": "0b5c...",
      "buildingId": "0b5c...",           // one building per conversation
      "buildingSince": 1790930000000,     // when this conversation's building started
      "name": "storefront-a1",
      "cwd": "/home/you/code/storefront",
      "cwdShort": "~/code/storefront",
      "project": "storefront",
      "status": "busy",                   // busy | idle | shell | ...
      "statusSince": 1790932500000,
      "startedAt": 1790928000000,
      "version": "2.1.0",
      "cpu": 22.4, "rssMB": 360, "processCount": 7, "uptimeSec": 4200,
      "transcript": { "title": "...", "lastPrompt": "...", "model": "claude-opus-5-5",
                      "contextTokens": 321000, "gitBranch": "feat/checkout",
                      "lastActivityAt": 1790932539000, "finished": false, "last": { } },
      "events": [ { "id": "uuid:0", "at": 1790932530000, "kind": "tool", "tool": "Bash", "text": "Run the tests" } ],
      "subagents": [ { "id": "agent-...", "type": "Explore", "description": "...", "state": "running",
                       "background": false, "lastActivityAt": 1790932539000, "last": { } } ]
    }
  ],
  "others": [ { "id": "codex", "label": "Codex", "count": 1, "hosts": [], "cpu": 1.4, "rssMB": 120, "uptimeSec": 10800 } ],
  "feed": [ /* the newest 80 events across sessions and subagents, each with "agent" and "pid" */ ],
  "saved": [ /* buildings of finished conversations, see below */ ]
}
```

## The page

`public/app.js` keeps one DOM element per card and per feed entry and only touches
markup that changed, so hover states and scroll positions survive the 2-second
refreshes. Relative times ("4m ago") are updated by a 1-second ticker.

**Radar.** A blip's distance from the centre is a log scale of the time since the
session last did anything: 0 for a working session, the outer ring at 6 hours or more.
Its bearing is a hash of the project folder, nudged slightly by the session's name, so
sessions in one project cluster together.

**Themes.** Every colour is a CSS custom property in a theme block at the top of
`public/styles.css`. The radar canvas and the village read the same properties, so a
theme change restyles everything at once.

## The village

`public/floor.js` is a three.js scene. It is loaded separately, so if WebGL isn't
available the rest of the dashboard still works. Rendering pauses while the village is
scrolled out of view or the tab is hidden.

**Buildings and levels.** A building has one level per 100,000 tokens of
`contextTokens`, up to 8. The fraction towards the next level is the share of bricks
laid on the level under construction. The label shows the level being built (or `MAX`).
Because it follows the context size, a building can lose levels when Claude Code
compacts the conversation.

**Builder poses** come from the session's status and its latest event:

| Pose | When |
| --- | --- |
| Hit a snag | working, and the latest event is a tool error less than 20 seconds old |
| Planning | working, model is thinking |
| Reading plans | working, latest event is your prompt or a read-only tool (`Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, ...) |
| Directing apprentices | working, latest event is an `Agent`/`Task` call |
| Building | working, anything else |
| Shell | status is `shell` |
| Standing by | idle, active in the last 10 minutes |
| Napping | idle for longer |

Each running subagent (up to 3) appears as an apprentice working another wall.

**Districts.** Buildings are grouped by working directory. Each district is a grid of
plots sized to its building count, and districts are packed into rows. Within a
district, buildings are ordered by when their conversation started, so a new
conversation takes the next plot.

## Saved buildings

`village.mjs` gives every conversation a building, keyed by its session id. A `/clear`
starts a new session id, so it starts a new building; resuming a conversation reuses
its id, so it reopens the same building.

On every refresh it:

1. updates the record of every live conversation (name, title, project, model, context
   size, and when it was last seen);
2. closes any record whose conversation is no longer live: it reads that transcript one
   last time for the final context size and title, then sets `closedAt` to when the
   conversation was last seen. Conversations that never reached any tokens are dropped
   instead of saved;
3. adds the closed records to the snapshot as `saved`.

Records are written to `~/.agent-radar/village.json` (or `$AGENT_RADAR_DATA`) at most
every 5 seconds, through a temporary file and a rename, so a crash can't leave a
half-written file. If the file can't be parsed it is moved aside to `village.json.bad`
rather than overwritten.

```jsonc
[
  {
    "id": "0b5c...",                   // the conversation's session id
    "sessionId": "0b5c...",
    "name": "storefront-a1",
    "title": "Checkout page redesign",
    "project": "storefront",
    "cwd": "/home/you/code/storefront",
    "model": "claude-opus-5-5",
    "contextTokens": 321000,           // the level it is frozen at
    "since": 1790928000000,            // when the building was started
    "seenAt": 1790932539342,           // when the conversation was last seen live
    "closedAt": 1790932539342          // null while the conversation is live
  }
]
```

On the page, a saved building keeps its level and roof colour, its windows go dark, its
builder disappears in a puff of smoke, and its label shrinks to level and name, with the
title on hover.

## Security model

- The server binds to `127.0.0.1` only.
- Every request must carry a loopback `Host` header (`localhost`, `127.0.0.1` or
  `[::1]`). A website that points its own domain at `127.0.0.1` (DNS rebinding) sends
  its own domain in `Host`, so it gets `403 Forbidden`.
- Only `GET` is accepted. Static files are served from `public/` only; paths that try
  to leave it get a 404.
- Snapshots are sent with `Cache-Control: no-store`.
- Claude Code's files are opened read-only. The only file written is the village file.
