# opencode-大肥鱼

A pixel whale that sits on your desktop and reacts to what your coding agent is
actually doing — thinking, reading files, running commands, proposing diffs,
compacting, waiting on you.

Not a toy that guesses. It reads the agent's local session database, read-only,
and maps real events to animation frames.

![states](widget/assets/frames/idle/idle-00.png)

## What it does

- 33 animation states, 64×64 pixel art, transparent overlay
- One whale per active session, with a nametag, up to three side by side
- Click a whale and it eats a bowl of rice
- Drag to move, position remembered, click-through by default
- No network, no telemetry, nothing leaves the machine

## Sources

It ships with two adapters and picks automatically:

| adapter | reads | notes |
|---|---|---|
| **opencode** | `~/.local/share/opencode/opencode.db` | preferred when a turn is running |
| **freebuff** | `~/.config/freebuff-desktop/projects/*/desktop-v2.db` | fallback source |

Both open the database **read-only**. Neither writes to it. A source only counts
as live if its state file updated in the last 15 seconds, so a leftover file from
a crash can't keep the whale pretending to work.

Whichever one has a turn in flight wins; opencode takes over only when it is busy
and the other is not.

## Requirements

- Windows 10/11
- Node.js 22 or newer (`node:sqlite` is built in — no native modules)

## Run it

```bash
npm install
npm start
```

The window appears in the bottom-right corner. It is click-through until you
hover the whale itself.

| action | result |
|---|---|
| hover a whale | window becomes interactive |
| click a whale | it eats a bowl of rice |
| drag | move the widget |
| tray icon | click-through toggle, reset position, quit |

To check a source is reading correctly:

```bash
node opencode-hook.js     # prints one state sample
node freebuff-hook.js
```

During a live turn you should see `"turn": "running"` and a tool or part name.

## How it works

```
agent's SQLite  ──read-only, 200ms──▶  hook (child process)
                                          │
                                    runtime/state-*.json
                                          │
                                    main process  ──IPC──▶  renderer
                                          │
                              http://127.0.0.1:8791/state     (freebuff)
                              http://127.0.0.1:8792/state     (opencode)
```

Both hooks also serve their state over loopback HTTP + SSE, so anything local
can drive off the same feed. CORS is open; there is no auth because there is
nothing to protect — it is read-only and machine-local.

## State vocabulary

`long-think`, `streaming`, `thinking`, `read-file`, `writing-code`,
`running-cmd`, `searching`, `propose-diff`, `compacting`, `tool-call`,
`tests-fail`, `blocked`, `waiting-prompt`, `idle`, `sleeping`, `chonk-idle`,
`error`.

A state must persist ~250ms before it is adopted and is held ~380ms once shown,
so a flapping tool/reasoning boundary doesn't strobe the sprite.

## Known gaps

- **`blocked` is a heuristic.** A tool part stuck in `running` for 45s is assumed
  to be a permission prompt. It is usually right, not always.
- **`success` and `tests-pass` never fire.** A finished turn is recorded as
  `completed`, not as a success event, so those two need an edge rule that isn't
  written yet.
- **Windows only.** The transparency and click-through handling is Win32-specific.
- **Schema drift.** Both adapters read private databases that the host apps can
  change without notice. If a source stops reporting, that's the first suspect.
- **Some states never play.** Roughly sixteen of the 33 in the manifest — the
  chonk family, yawn, look-around, pop-idea, success, done-flop — are art
  waiting on a trigger. Only click-driven ones (boba, eating-rice) fire today.

## Licence

Code is MIT. Sprites are CC BY-NC-SA 4.0 — attribution, non-commercial,
share-alike. See [LICENSE.md](LICENSE.md).

Fan project. Not affiliated with, endorsed by, or connected to opencode,
Freebuff, DeepSeek, or any AI vendor.
