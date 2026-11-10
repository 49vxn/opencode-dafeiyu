# 大肥鱼 (da fei yu)

A whale that lives in the corner of your screen and mirrors your coding
agents in real time. It reads the local state of **OpenCode** and **Freebuff**
and reacts with matching sprite states. Read-only, loopback-only, no telemetry.

## Run

```
cd widget
npm install
npm start
```

Whale arrives bottom-right. Two read-only hooks ship in `widget/` and spawn
with the app; each one is used only when its agent's local database exists:

- `~/.local/share/opencode/opencode.db` (OpenCode)
- `~/.config/freebuff-desktop/projects/<project>/desktop-v2.db` (Freebuff)

Interaction: click to feed rice, drag to move, Ctrl+Shift+X toggles
click-through, Ctrl+Shift+R re-centers.


## States

`thinking` `long-think` `streaming` `running-cmd` `read-file` `writing-code`
`searching` `tool-call` `blocked` `tests-fail` `waiting-prompt` `idle`
`sleeping` `chonk-idle` `error`

## Ownership

© 2026.
Do not redistribute. Unofficial fan project — not affiliated with any agent
vendor.

p.s. I have a couple easter eggs --

the first one -- click to watch it eat rice
