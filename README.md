# opencode-大肥鱼

A pixel whale that sits on your desktop and reacts to what your coding agent is
actually doing — thinking, reading files, running commands, proposing diffs,
compacting, waiting on you.

Not a timer that guesses. It reads your agent's local session database,
read-only, and maps real events to real frames.

![dafeiyu cycling through states](widget/assets/demo-a.gif)

---

## What it actually looks like

| | state | when you see it |
|---|---|---|
| ![idle](widget/assets/gifs/idle.gif) | `idle` | nothing running |
| ![long-think](widget/assets/gifs/long-think.gif) | `long-think` | the reasoning trace is streaming |
| ![running-cmd](widget/assets/gifs/running-cmd.gif) | `running-cmd` | a shell command is executing |
| ![read-file](widget/assets/gifs/read-file.gif) | `read-file` | it's reading source |
| ![propose-diff](widget/assets/gifs/propose-diff.gif) | `propose-diff` | an edit is being staged |
| ![compacting](widget/assets/gifs/compacting.gif) | `compacting` | context is being compacted |
| ![sleeping](widget/assets/gifs/sleeping.gif) | `sleeping` | idle for a while |
| ![boba](widget/assets/gifs/boba.gif) | `boba` | click it |

![four states at once](widget/assets/demo-b.gif)

---

## Why this exists

Checking whether your agent finished means alt-tabbing out of what you're doing.
So the agent gets a face instead: one whale per live session, a nametag over each
one, and a state you can read from three metres away.

- **33 animation states**, 64×64 pixel art, transparent overlay
- **Up to three sessions** shown side by side, each with its own nametag
- **Click a whale** and it eats a bowl of rice
- **Click-through by default** — it never eats your clicks, only when you hover it
- **No network, no telemetry, no account.** Nothing leaves the machine

## Sources

It ships two adapters and picks automatically:

| adapter | reads | notes |
|---|---|---|
| **opencode** | `~/.local/share/opencode/opencode.db` | preferred when a turn is running |
| **freebuff** | `~/.config/freebuff-desktop/projects/*/desktop-v2.db` | fallback source |

Both open the database **read-only** and never write to it. A source only counts
as live if its state file updated in the last 15 seconds, so a file left behind by
a crash can't keep the whale pretending to work.

Whichever source has a turn in flight wins; the other takes over only when it is
busy and the first is not.

---

## Install

**Windows only for now.** You need [Node.js 22 or newer](https://nodejs.org) —
there are no native modules, so nothing compiles.

```bash
git clone https://github.com/49vxn/opencode-dafeiyu.git
```

Then **double-click `widget\start.cmd`**. It installs once, starts the widget, and
leaves no terminal open. Second run is instant.

Prefer the terminal:

```bash
cd opencode-dafeiyu/widget
npm install
npm start
```

The whale appears in the bottom-right corner. It is click-through until you hover
the whale itself.

## Something not working?

Run the doctor:

```bash
cd widget
node doctor.js
```

It prints what it found — which agents are installed, the newest session in each,
and whether the hooks are listening:

```
  ok     node 24.18.0
  ok     electron installed
  ok     opencode database found
         newest session: review pass  (2m ago)
  ok     freebuff: 37 project database(s)
         most recently written: my-project  (0m ago)
```

If a source is missing it says so instead of failing quietly. The two databases
are the only things it touches, and it opens them read-only.

**Common causes of "it just sits there":**

| symptom | cause |
|---|---|
| whale idle, doctor says no database | agent not installed, or never run a turn |
| doctor finds a database but the whale is still | the agent finished — it'll move on the next turn |
| nothing appears on screen | transparency failed; check `runtime/*.log` |
| hooks not listening on 8791/8792 | the widget isn't running |

## Controls

| action | result |
|---|---|
| hover a whale | window becomes interactive |
| click a whale | it eats a bowl of rice |
| drag | move the widget |
| tray icon | click-through toggle, reset position, quit |

## How it works

```
agent's SQLite  ──read-only, 200ms──▶  hook (child process)
                                          │
                                    runtime/state-*.json
                                          │
                                    main process  ──IPC──▶  renderer
                                          │
                              http://127.0.0.1:8791/state   (freebuff)
                              http://127.0.0.1:8792/state   (opencode)
```

Both hooks also serve their state over loopback HTTP and SSE, so anything local
can drive off the same feed. CORS is restricted to loopback origins.

### State vocabulary

`long-think` `streaming` `thinking` `read-file` `writing-code` `running-cmd`
`searching` `propose-diff` `compacting` `tool-call` `tests-fail` `blocked`
`waiting-prompt` `idle` `sleeping` `chonk-idle` `error`

A state must persist ~250ms before it is adopted and is held ~380ms once shown,
so a flapping tool/reasoning boundary can't strobe the sprite.

---

## Known gaps

- **`blocked` is a heuristic.** A tool stuck in `running` for 45s is assumed to be
  a permission prompt. Usually right, not always.
- **`success` and `tests-pass` never fire.** A finished turn is recorded as
  `completed`, not as a success event, so those two need an edge rule.
- **Some states never play.** Roughly sixteen of the 33 in the manifest — the
  chonk family, yawn, look-around, pop-idea — are art waiting on a trigger.
- **Windows only.** The transparency and click-through handling is Win32-specific.
- **Schema drift.** Both adapters read private databases the host apps can change
  without notice. If a source stops reporting, that's the first suspect.

## Licence

Code is MIT. Sprites are CC BY-NC-SA 4.0 — attribution, non-commercial,
share-alike. See [LICENSE.md](LICENSE.md).

Fan project. Not affiliated with, endorsed by, or connected to opencode,
Freebuff, DeepSeek, or any AI vendor.
