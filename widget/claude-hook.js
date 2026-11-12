#!/usr/bin/env node
/**
 * claude-hook — reads Claude Code's live agent state and publishes it.
 *
 * © 2026 Kevin — private fan project, all rights reserved. See LICENSE.txt
 * in the project root. Independently written; not based on any vendor code.
 *
 * WHERE THE STATE LIVES — two channels, best available wins:
 *
 *   1. HOOK EVENTS (precise). Claude Code fires hooks at fixed points and
 *      pipes a JSON payload to the hook command's stdin. The recommended
 *      hook command simply curls that payload to this server:
 *
 *        curl -s -o NUL -X POST --data-binary @- http://127.0.0.1:8793/event
 *
 *      Consumed events and what they mean here:
 *        UserPromptSubmit        turn starting
 *        PreToolUse              tool starting -> tool pose by name
 *        PostToolUse             tool done, model continues
 *        PostToolUseFailure      tool failed -> tests-fail
 *        Notification            permission_prompt -> blocked,
 *                                idle_prompt / agent_completed -> waiting
 *        Stop                    turn finished
 *        StopFailure             API error -> error (detail = error type)
 *        SubagentStart/Stop      tool-call
 *        PreCompact/PostCompact  compacting
 *
 *   2. TRANSCRIPT TAILING (zero config). ~/.claude/projects/<slug>/<id>.jsonl
 *      appends one JSON object per line; assistant entries carry content
 *      blocks { type: 'text' | 'thinking' | 'tool_use', name, ... }, user
 *      entries carry { type: 'tool_result', tool_use_id, is_error }.
 *      A tool_use with no later tool_result is still running — the same
 *      missing-confirmation trick the other two adapters use. A tool left
 *      running ~45s is usually a permission prompt -> blocked.
 *
 * Hook events outrank tailing while fresh. Everything is read-only: the
 * tailer never writes to ~/.claude, and the event channel only receives.
 *
 * COST NOTES (the traps that bit the other hooks):
 *   - The projects tree is listed every 5s, but per-file stats happen in
 *     full only on a slow 60s deep sweep. Between deep sweeps only
 *     transcripts known to be recently active are stat'ed, so hundreds of
 *     old sessions cost a listing per 5s, not a stat per file.
 *   - Transcript reads are incremental: only the bytes appended since the
 *     last read are ingested, and a never-read transcript older than the
 *     activity window is parked at its end without reading history.
 *   - CORS is an allowlist (http(s)://localhost and 127.0.0.1 only), same
 *     as the other two hooks. A "*" here would expose session titles and
 *     project paths to any web page.
 *
 *   node claude-hook.js            one sample, printed
 *   node claude-hook.js --watch    poll, serve, write runtime/state-claude.json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// ---------------------------------------------------------------- tuning
const POLL_MS = 250;            // tail sweep cadence
const SCAN_MS = 5000;           // directory sweep cadence (listing only)
const FULL_SCAN_MS = 60000;     // deep sweep: re-read even parked transcripts
const CONFIRM_MS = 350;         // a candidate state must persist this long
const MIN_HOLD_MS = 550;        // once adopted, hold at least this long
const STALE_MS = 120000;        // tail heartbeat older than this = dead turn
const BLOCK_AFTER_MS = 45000;   // tool with no result this long = waiting on user
const EVENT_FRESH_MS = 60000;   // hook events outrank the tail for this long
const START_GRACE_MS = 90000;   // prompt submitted, nothing from the model yet
const ACTIVE_MS = 45 * 60000;   // transcripts newer than this are polled
const TAIL_START = 131072;      // first ingest of an active file: last 128 KiB
const PORT = Number(process.env.DAFEIYU_CLAUDE_PORT || 8793);
const OUT = path.join(process.env.DAFEIYU_RUNTIME || path.join(__dirname, 'runtime'), 'state-claude.json');

const claudeHome = () => process.env.DAFEIYU_CLAUDE_HOME
  || path.join(os.homedir(), '.claude');
const projectsRoot = () => path.join(claudeHome(), 'projects');

/** CORS allowlist shared by all three adapters. Echo a local origin only. */

// How eagerly a state should win a tie. Higher beats lower once confirmed.
// Same weights as the other two adapters — all three must agree.
const WEIGHT = {
  error: 9,
  blocked: 8,
  'running-cmd': 6,
  'tests-fail': 6,
  'tests-pass': 6,
  'writing-code': 5,
  'propose-diff': 5,
  'read-file': 4,
  searching: 4,
  'tool-call': 4,
  compacting: 4,
  streaming: 3,
  'long-think': 3,
  thinking: 2,
  'waiting-prompt': 1,
  idle: 1,
  sleeping: 0,
  'chonk-idle': 0,
};

// tool name -> sprite state (Claude Code's tool vocabulary, case-insensitive)
const TOOL_STATE = {
  bash: 'running-cmd',
  shell: 'running-cmd',
  read: 'read-file',
  glob: 'read-file',
  ls: 'read-file',
  grep: 'searching',
  webfetch: 'searching',
  websearch: 'searching',
  write: 'writing-code',
  edit: 'writing-code',
  multiedit: 'writing-code',
  notebookedit: 'writing-code',
  task: 'tool-call',            // subagents
  agent: 'tool-call',
};

const toolState = (name) => TOOL_STATE[String(name || '').toLowerCase()] || 'tool-call';

/** The idle ladder, shared by both channels. */
function waitState(sinceEnd) {
  if (sinceEnd < 60000) return { state: 'waiting-prompt', detail: 'finished', confident: true };
  if (sinceEnd < 10 * 60000) return { state: 'idle', detail: 'resting', confident: true };
  if (sinceEnd < 30 * 60000) return { state: 'sleeping', detail: 'asleep', confident: true };
  return { state: 'chonk-idle', detail: 'long idle', confident: true };
}

// ---------------------------------------------------------------- events
/**
 * Per-session record of the newest hook event. Only structural fields are
 * kept; `prompt` text is truncated for the nametag and never persisted.
 */
const events = new Map();       // sessionId -> { at, kind, state, detail, confident, cwd, mode, title }

function noteEvent(ev) {
  const id = String(ev.session_id || 'unknown');
  const kind = ev.hook_event_name || '';
  const at = Date.now();
  const cwd = ev.cwd || null;
  const prev = events.get(id);
  const rec = {
    at, kind, cwd,
    mode: ev.permission_mode || (prev && prev.mode) || null,
    title: prev && prev.title || null,
    state: null, detail: null, confident: true,
  };

  if (kind === 'UserPromptSubmit') {
    // The user's own first line doubles as the session label, same as a title.
    const first = String(ev.prompt || '').split('\n')[0].trim();
    if (first) rec.title = first.slice(0, 24);
    rec.state = 'thinking'; rec.detail = 'starting';
  } else if (kind === 'PreToolUse') {
    rec.state = toolState(ev.tool_name); rec.detail = ev.tool_name || 'tool';
  } else if (kind === 'PostToolUse') {
    rec.state = toolState(ev.tool_name); rec.detail = ev.tool_name || 'tool';
    rec.confident = false;         // tool done; the model is between moves
  } else if (kind === 'PostToolUseFailure') {
    rec.state = 'tests-fail'; rec.detail = `${ev.tool_name || 'tool'} failed`;
  } else if (kind === 'Notification') {
    const t = ev.notification_type || ev.type || '';
    if (t === 'permission_prompt' || t === 'agent_needs_input') {
      rec.state = 'blocked'; rec.detail = 'waiting for you';
    } else if (t === 'idle_prompt' || t === 'agent_completed') {
      rec.state = 'waiting-prompt'; rec.detail = 'finished';
    } else {
      return;                      // unrelated notification type
    }
  } else if (kind === 'Stop') {
    rec.state = 'waiting-prompt'; rec.detail = 'finished';
  } else if (kind === 'StopFailure') {
    rec.state = 'error'; rec.detail = ev.error || 'turn failed';
  } else if (kind === 'SubagentStart') {
    rec.state = 'tool-call'; rec.detail = ev.agent_type || 'subagent';
  } else if (kind === 'SubagentStop') {
    rec.state = 'thinking'; rec.detail = 'continuing'; rec.confident = false;
  } else if (kind === 'PreCompact') {
    rec.state = 'compacting'; rec.detail = `compacting (${ev.trigger || 'auto'})`;
  } else if (kind === 'PostCompact') {
    rec.state = 'thinking'; rec.detail = 'compacted'; rec.confident = false;
  } else {
    return;                        // unknown event — ignore, never guess
  }

  events.set(id, rec);
}

/** Classify purely from the newest event. */
function eventCandidate(rec, now) {
  const age = now - rec.at;

  // Transient poses decay: once the event is old, stop trusting it.
  if (age > EVENT_FRESH_MS) return null;

  // A tool that started but never finished is the classic permission wait.
  if ((rec.kind === 'PreToolUse') && age >= BLOCK_AFTER_MS) {
    return { state: 'blocked', detail: 'waiting for you', confident: true };
  }
  if (rec.state) {
    return { state: rec.state, detail: rec.detail, confident: rec.confident };
  }
  return null;
}

// ---------------------------------------------------------------- tail
/**
 * Incremental transcript reader. One reader per jsonl file; it remembers its
 * byte offset and the set of tool_use ids that never got a tool_result.
 */
const tailCache = new Map();    // file -> reader

function makeReader(file) {
  return {
    file,
    offset: 0,
    size: 0,
    mtime: 0,
    cwd: null,
    title: null,                // first user line in the ingested slice
    pending: new Map(),         // tool_use_id -> { name, at }
    lastAt: 0,                  // newest entry timestamp seen
    lastKind: null,             // text | thinking | tool_use | result | end
    lastTool: null,             // name of the newest tool_use
    lastError: false,           // newest tool_result was an error
    stopReason: null,
  };
}

/**
 * Ingest only what changed. Reads the bytes appended since the last call and
 * consumes complete lines; a partial trailing line waits for its newline.
 * A never-read file older than the activity window is parked at its end
 * without reading history. (Titles for such sessions come from the event
 * channel, or fall back to 'claude'.)
 */
function readAppends(r, now) {
  let size = 0, mtime = 0;
  try { const st = fs.statSync(r.file); size = st.size; mtime = st.mtimeMs; } catch { return; }
  r.size = size; r.mtime = mtime;
  if (size < r.offset) { r.offset = 0; r.pending.clear(); }  // truncated/rewritten
  if (size === r.offset) return;

  if (r.offset === 0 && size > TAIL_START) {
    if (now - mtime > ACTIVE_MS) { r.offset = size; return; }  // history: park
    r.offset = size - TAIL_START;                              // active: tail
  }

  const fh = fs.openSync(r.file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(size - r.offset);
    const got = fs.readSync(fh, buf, 0, buf.length, r.offset);
    if (got < buf.length) buf = buf.subarray(0, got);
  } catch {
    fs.closeSync(fh);
    return;
  }
  fs.closeSync(fh);

  const text = buf.toString('utf8');
  const cut = text.lastIndexOf('\n');          // only complete lines
  if (cut < 0) return;                         // partial line: wait for more
  const chunk = text.slice(0, cut);
  r.offset += Buffer.byteLength(chunk, 'utf8') + 1;

  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    consumeEntry(r, e);
  }
}

function consumeEntry(r, e) {
  if (e.timestamp) {
    const t = Date.parse(e.timestamp);
    if (Number.isFinite(t)) r.lastAt = Math.max(r.lastAt, t);
  }
  if (e.cwd) r.cwd = e.cwd;

  if (e.type === 'summary' && e.summary && !r.title) {
    r.title = String(e.summary).slice(0, 24);
  }

  const msg = e.message;
  if (!msg || !Array.isArray(msg.content)) {
    if (e.type === 'system' && /compact/i.test(String(e.subtype || ''))) {
      r.lastKind = 'compacting';
    }
    return;
  }

  for (const block of msg.content) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'thinking') {
      r.lastKind = 'thinking';
      r.stopReason = msg.stop_reason ?? r.stopReason;
    } else if (block.type === 'text') {
      if (r.title === null && e.type === 'user') {
        const first = String(block.text || '').split('\n')[0].trim();
        if (first) r.title = first.slice(0, 24);
      }
      if (e.type === 'assistant') {
        r.lastKind = 'text';
        r.stopReason = msg.stop_reason ?? r.stopReason;
      }
    } else if (block.type === 'tool_use') {
      r.pending.set(block.id, { name: block.name, at: Date.now() });
      r.lastKind = 'tool_use';
      r.lastTool = block.name;
      r.stopReason = msg.stop_reason ?? r.stopReason;
    } else if (block.type === 'tool_result') {
      r.pending.delete(block.tool_use_id);
      r.lastKind = 'result';
      r.lastError = !!block.is_error;
      r.stopReason = msg.stop_reason ?? r.stopReason;
    }
  }
}

/** Classify purely from the transcript tail. */
function tailCandidate(r, now) {
  if (!r.lastAt) return null;
  const age = now - r.lastAt;
  if (age > STALE_MS) return null;           // whole transcript stale

  // A tool_use still awaiting its result is running; too long = blocked.
  if (r.lastKind === 'tool_use' && r.pending.size) {
    const oldest = Math.min(...[...r.pending.values()].map(p => p.at));
    if (now - oldest >= BLOCK_AFTER_MS) {
      return { state: 'blocked', detail: 'waiting for you', confident: true };
    }
    return { state: toolState(r.lastTool), detail: r.lastTool || 'tool', confident: true };
  }
  if (r.lastKind === 'result' && r.lastError) {
    return { state: 'tests-fail', detail: 'tool failed', confident: true };
  }
  if (r.lastKind === 'compacting') {
    return { state: 'compacting', detail: 'compacting context', confident: false };
  }
  if (r.lastKind === 'tool_use' && !r.pending.size) {
    return { state: toolState(r.lastTool), detail: r.lastTool || 'tool', confident: true };
  }

  // Model output. stop_reason set means the turn actually ended there.
  if (r.lastKind === 'thinking' && !r.stopReason) {
    return { state: 'long-think', detail: 'reasoning', confident: true };
  }
  if (r.lastKind === 'text' && !r.stopReason) {
    return { state: 'streaming', detail: 'answering', confident: true };
  }

  // Turn ended (or at least nothing new for a while): idle ladder.
  if (age < START_GRACE_MS && r.lastKind === 'result') {
    return { state: 'thinking', detail: 'starting', confident: false };
  }
  return waitState(age);
}

/**
 * Every recently-active transcript, newest first, for the nametag row.
 * Known-live readers are polled every tick; parked ones only on the tick
 * after a deep sweep (every FULL_SCAN_MS), so a transcript that comes back
 * to life is noticed within a minute without a per-tick stat sweep.
 */
function tailAgents(now) {
  const files = listTranscripts(now);
  const fullScan = now - dirCache.fullAt < POLL_MS;   // the tick right after a deep sweep
  const rows = [];
  for (const file of files) {
    let r = tailCache.get(file);
    if (!r) { r = makeReader(file); tailCache.set(file, r); }
    else if (!fullScan && r.lastAt && now - r.lastAt > ACTIVE_MS) continue;
    readAppends(r, now);
    if (r.lastAt && now - r.lastAt < ACTIVE_MS) {
      rows.push({ r, session: path.basename(file, '.jsonl') });
    }
  }
  rows.sort((a, b) => b.r.lastAt - a.r.lastAt);
  return rows.slice(0, 3);
}

const dirCache = { at: 0, fullAt: 0, files: [] };

function listTranscripts(now) {
  const full = now - dirCache.fullAt >= FULL_SCAN_MS;
  if (!full && now - dirCache.at < SCAN_MS) return dirCache.files;
  dirCache.at = now;
  if (full) dirCache.fullAt = now;
  const root = projectsRoot();
  const found = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { /* not installed */ }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of entries) {
      if (f.isFile() && f.name.endsWith('.jsonl')) found.push(path.join(dir, f.name));
    }
  }
  dirCache.files = found;

  // Drop only readers whose file vanished. Readers are tiny, and a pruned
  // cold reader would be re-created and re-read from scratch on the next
  // tick — exactly the per-tick cost this design exists to avoid.
  const keep = new Set(found);
  for (const file of [...tailCache.keys()]) {
    if (!keep.has(file)) tailCache.delete(file);
  }
  return found;
}

// ---------------------------------------------------------------- smoother
/**
 * A candidate must persist CONFIRM_MS before adoption, and once adopted a state
 * is held for MIN_HOLD_MS. Unconfident candidates can never replace a confident
 * one. This is what stops the two-state strobe. Same as the other two hooks.
 */
class Smoother {
  constructor() {
    this.current = null;
    this.adoptedAt = 0;
    this.pending = null;
    this.pendingSince = 0;
    this.pendingConfident = false;
  }

  push(cand, now) {
    if (!this.current) {
      this.adopt(cand, now);
      return this.current;
    }

    if (cand.state === this.current.state) {
      this.pending = null;
      return this.current;
    }

    if (this.pending !== cand.state) {
      this.pending = cand.state;
      this.pendingSince = now;
      this.pendingConfident = cand.confident;
    }

    const waited = now - this.pendingSince;
    const held = now - this.adoptedAt;

    // Never let a low-confidence guess push out a confident observation.
    if (!cand.confident && this.current.confident) return this.current;

    if (waited < CONFIRM_MS) return this.current;
    if (held < MIN_HOLD_MS) return this.current;

    // Both settled: the heavier state wins the tie-break.
    const cur = WEIGHT[this.current.state] ?? 1;
    const next = WEIGHT[cand.state] ?? 1;
    if (next < cur && held < MIN_HOLD_MS * 3) return this.current;

    this.adopt(cand, now);
    return this.current;
  }

  adopt(cand, now) {
    this.current = { state: cand.state, detail: cand.detail, confident: cand.confident };
    this.adoptedAt = now;
    this.pending = null;
  }
}

// ---------------------------------------------------------------- sample
const MAX_AGENTS = 3;

function sample(smoother) {
  const now = Date.now();

  // Sweep every known transcript once (cheap: offsets make it append-only).
  const agents = tailAgents(now);

  // The primary session: freshest hook event, else freshest transcript.
  let primary = null;          // { id, cwd, title, cand }
  for (const [id, rec] of events) {
    const cand = eventCandidate(rec, now);
    if (!cand) continue;
    if (!primary || rec.at > primary.at) {
      primary = { id, at: rec.at, cwd: rec.cwd, title: rec.title, cand, from: 'event' };
    }
  }
  if (agents.length) {
    const top = agents[0];
    if (!primary || top.r.lastAt > primary.at) {
      primary = {
        id: top.session, at: top.r.lastAt,
        cwd: top.r.cwd, title: top.r.title,
        cand: tailCandidate(top.r, now), from: 'tail',
      };
    }
  }

  if (!primary || !primary.cand) {
    return smoother.push({
      state: 'idle', detail: 'claude not found', confident: false,
    }, now);
  }

  const chosen = smoother.push(primary.cand, now);
  const running = WEIGHT[primary.cand.state] >= WEIGHT.streaming
    && primary.cand.confident;

  return {
    ...chosen,
    ts: now,
    thread: String(primary.id).slice(0, 8),
    directory: primary.cwd || null,
    mode: (() => {
      for (const [, rec] of events) {
        if (now - rec.at < EVENT_FRESH_MS && rec.mode) return rec.mode;
      }
      return null;
    })(),
    turn: running ? 'running' : 'idle',
    agents: agents.slice(0, MAX_AGENTS).map(({ r, session }) => {
      const ev = events.get(session);
      const evFresh = ev && now - ev.at < EVENT_FRESH_MS && ev.state;
      const cand = evFresh ? { state: ev.state, confident: true } : tailCandidate(r, now);
      return {
        id: String(session).slice(0, 8),
        title: (ev && ev.title) || r.title || 'claude',
        state: cand ? cand.state : 'idle',
        running: !!(cand && cand.confident
                    && WEIGHT[cand.state] >= WEIGHT.streaming),
        updatedAt: r.mtime,
      };
    }),
    source: 'claude',
    stale: false,
  };
}

const { runWatch } = require("./core/transport");

if (process.argv.includes('--watch')) {
  runWatch({
    tag: '[cl-hook]', port: PORT, file: OUT, pollMs: POLL_MS, sample, Smoother,
    onEvent: noteEvent,
    sig: (p) => p.state + '|' + (p.detail || '') + '|' + p.turn + '|'
      + (p.agents || []).map(a => a.id + ':' + a.state + ':' + (a.running ? 1 : 0)).join(','),
  });
} else {
  console.log(JSON.stringify(sample(new Smoother()), null, 2));
}
