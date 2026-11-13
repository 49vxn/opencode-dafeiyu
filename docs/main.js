// dafeiyu — the page runs off one atlas and one manifest.
// No framework, no build step: draw a 64×64 cell, tick at the state's own fps.

const GROUPS = [
  ["At rest", ["idle", "idle-left", "idle-right", "look-around", "yawn", "sleeping", "waiting-prompt", "done-flop"]],
  ["Working", ["thinking", "long-think", "plan", "reading", "read-file", "searching", "writing-code", "streaming", "tool-call", "running-cmd", "propose-diff", "compacting", "subagent", "subagent-return"]],
  ["Outcomes", ["pop-idea", "pop-flip", "success", "tests-pass", "tests-fail", "error", "interrupted", "run-failed"]],
  ["Feelings", ["sulk", "sulk-loop", "sulk-end", "typing-along", "typing-away"]],
  ["Treats", ["boba", "eating-rice", "chonk-idle", "headband-on", "chonk-writing-code", "chonk-success", "slim-down", "too-full-boba", "too-full-rice"]],
  ["Drift", ["doze-off", "walk-away", "wake-up", "fish-spot", "fish-chase", "fish-return", "boba-run", "boba-return"]],
  ["Other agents", ["agent-spot", "agent-follow", "agent-return"]],
];

const WHY = {
  idle: "nothing is running",
  "idle-left": "you're off to its left",
  "idle-right": "you're off to its right",
  "look-around": "it's been quiet a while",
  yawn: "just woke up",
  sleeping: "no activity for minutes",
  "waiting-prompt": "the turn ended — your move",
  "done-flop": "the done card lands",

  thinking: "the request went out",
  "long-think": "the reasoning trace streams",
  plan: "it plans before it edits",
  reading: "skimming, no document",
  "read-file": "a file is open",
  searching: "grep, glob, or the web",
  "writing-code": "edits are being applied",
  streaming: "the answer is written out",
  "tool-call": "a tool boundary, under a second",
  "running-cmd": "a shell command is executing",
  "propose-diff": "a diff is staged",
  compacting: "context is being squeezed",
  subagent: "it delegated",
  "subagent-return": "the helper came back",

  "pop-idea": "the read resolved into an idea",
  "pop-flip": "a mid-read hmm",
  success: "the turn landed clean",
  "tests-pass": "the suite is green",
  "tests-fail": "the suite is red",
  error: "the turn died on an error",
  interrupted: "you stopped it",
  "run-failed": "a command exited non-zero",

  sulk: "it finished while you weren't looking",
  "sulk-loop": "still sulking",
  "sulk-end": "forgiven",
  "typing-along": "you're at the keyboard",
  "typing-away": "you walked off mid-turn",

  boba: "sipping between turns",
  "eating-rice": "you clicked it",
  "chonk-idle": "fed, and idle",
  "headband-on": "first work after a meal",
  "chonk-writing-code": "mashing keys, fat",
  "chonk-success": "a fat win",
  "slim-down": "the rice wears off",
  "too-full-boba": "it can't — it's full",
  "too-full-rice": "it can't — it's full",

  "doze-off": "you've been gone a while",
  "walk-away": "it gives up on you",
  "wake-up": "you're back",
  "fish-spot": "something moved",
  "fish-chase": "it's hunting",
  "fish-return": "caught nothing",
  "boba-run": "double-click, it runs",
  "boba-return": "back with a cup",

  "agent-spot": "another session appeared",
  "agent-follow": "you switched threads",
  "agent-return": "it's alone again",
};

const PHRASE = {
  idle: "waiting", thinking: "thinking", "long-think": "thinking hard", plan: "planning",
  "running-cmd": "running a command", "read-file": "reading a file", reading: "reading",
  searching: "searching", "writing-code": "writing code", "propose-diff": "proposing an edit",
  streaming: "answering", "tool-call": "using a tool", compacting: "compacting context",
  "waiting-prompt": "waiting on you", sleeping: "asleep", "done-flop": "done",
  "pop-idea": "got it", "pop-flip": "hmm", success: "success", error: "hit an error",
  interrupted: "stopped", "run-failed": "command failed", "tests-pass": "tests pass",
  "tests-fail": "tests fail", subagent: "delegating", "subagent-return": "helper is back",
  boba: "on boba", "eating-rice": "eating rice", "too-full-rice": "too full",
  "too-full-boba": "too full", "chonk-idle": "full of rice", sulk: "sulking",
  "sulk-loop": "still sulking", "sulk-end": "forgiven", "boba-run": "off for boba",
  "boba-return": "back with boba", "fish-spot": "spotted something", "fish-chase": "chasing",
  "fish-return": "lost it", "agent-spot": "spotted another", "agent-follow": "following",
  "agent-return": "alone again", "walk-away": "wandering", "wake-up": "back",
  "doze-off": "dozing", yawn: "yawning", "look-around": "looking around",
  "typing-along": "you're typing", "typing-away": "you left", "idle-left": "watching you",
  "idle-right": "watching you", "chonk-writing-code": "mashing keys", "chonk-success": "fat win",
  "slim-down": "slimming down", "headband-on": "headband on",
};

const CYCLE = ["idle", "long-think", "running-cmd", "streaming", "tests-pass", "eating-rice", "chonk-idle", "sleeping"];

const heroCanvas = document.getElementById("hero");
const heroState = document.getElementById("hero-state");
const heroDoing = document.getElementById("hero-doing");
const heroTag = document.getElementById("hero-tag");
const catalog = document.getElementById("catalog");

let meta = null, atlas = null;
let playing = null;          // { state, startedAt }
let manual = null;           // state forced by hover
let cycleIndex = 0;
let lastCycle = 0;

const phrase = (s) => PHRASE[s] || s.replace(/^chonk-/, "").replace(/-/g, " ");

function draw(canvas, state, t) {
  if (!meta || !atlas) return;
  const s = meta.states[state];
  if (!s) return;
  const ctx = canvas.getContext("2d");
  const fps = s.fps || 8;
  const raw = Math.floor((t - (playing && playing.state === state ? playing.startedAt : 0)) / (1000 / fps));
  const idx = s.loop === "loop" ? raw % s.frames : Math.min(raw, s.frames - 1);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 64, 64);
  ctx.drawImage(atlas, idx * 64, s.row * 64, 64, 64, 0, 0, 64, 64);
}

function play(state, { manual: isManual = false } = {}) {
  if (!meta || !meta.states[state]) return;
  playing = { state, startedAt: performance.now() };
  heroState.textContent = state;
  heroDoing.textContent = phrase(state);
  if (isManual) { manual = state; }
  draw(heroCanvas, state, performance.now());
}

function tick(t) {
  if (!manual) {
    if (t - lastCycle > 2600) {
      lastCycle = t;
      cycleIndex = (cycleIndex + 1) % CYCLE.length;
      play(CYCLE[cycleIndex]);
    }
  }
  draw(heroCanvas, playing ? playing.state : "idle", t);
  requestAnimationFrame(tick);
}

function buildRow(state) {
  const row = document.createElement("div");
  row.className = "row";
  row.tabIndex = 0;
  row.dataset.state = state;

  const c = document.createElement("canvas");
  c.width = 64; c.height = 64;

  const name = document.createElement("span");
  name.className = "row-name";
  name.textContent = state;

  const why = document.createElement("span");
  why.className = "row-why";
  why.textContent = WHY[state] || (state.startsWith("chonk-") ? "the fed version of " + state.slice(6) : "");

  row.append(c, name, why);

  const loop = (t) => {
    if (!row.isConnected) return;
    draw(c, state, t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const enter = () => play(state, { manual: true });
  const leave = () => { manual = null; };
  row.addEventListener("pointerenter", enter);
  row.addEventListener("focus", enter);
  row.addEventListener("pointerleave", leave);
  row.addEventListener("blur", leave);

  return row;
}

function buildCatalog() {
  const order = meta.order;
  for (const [title, states] of GROUPS) {
    const present = states.filter((s) => order.includes(s));
    if (!present.length) continue;
    const group = document.createElement("div");
    group.className = "group reveal";
    const h = document.createElement("div");
    h.className = "group-title";
    h.textContent = title;
    const rows = document.createElement("div");
    rows.className = "rows";
    present.forEach((s) => rows.append(buildRow(s)));
    group.append(h, rows);
    catalog.append(group);
  }

  const listed = new Set(GROUPS.flatMap(([, states]) => states));
  const twins = order.filter((s) => s.startsWith("chonk-") && !listed.has(s));
  if (twins.length) {
    const group = document.createElement("div");
    group.className = "group reveal";
    const h = document.createElement("div");
    h.className = "group-title";
    h.textContent = "Chonk variants — " + twins.length + " states, resolved automatically";
    const rows = document.createElement("div");
    rows.className = "rows";
    twins.forEach((s) => rows.append(buildRow(s)));
    group.append(h, rows);
    catalog.append(group);
  }
}

function reveal() {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
  }, { rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
}

async function boot() {
  const [m, img] = await Promise.all([
    fetch("atlas.json").then((r) => r.json()),
    new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = "atlas.png"; }),
  ]);
  meta = m; atlas = img;
  buildCatalog();
  reveal();
  play("idle");
  requestAnimationFrame(tick);
}

boot().catch((err) => {
  console.error("atlas failed to load", err);
  heroDoing.textContent = "atlas failed to load";
});
