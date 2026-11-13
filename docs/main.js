// dafeiyu — one atlas, one manifest, one loop.
// The hero is driven by a recorded session; the catalogue drives the stage.

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
  idle: "nothing is running", "idle-left": "you're off to its left", "idle-right": "you're off to its right",
  "look-around": "it's been quiet a while", yawn: "just woke up", sleeping: "no activity for minutes",
  "waiting-prompt": "the turn ended — your move", "done-flop": "the done card lands",
  thinking: "the request went out", "long-think": "the reasoning trace streams", plan: "it plans before it edits",
  reading: "skimming, no document", "read-file": "a file is open", searching: "grep, glob, or the web",
  "writing-code": "edits are being applied", streaming: "the answer is written out",
  "tool-call": "a tool boundary, under a second", "running-cmd": "a shell command is executing",
  "propose-diff": "a diff is staged", compacting: "context is being squeezed", subagent: "it delegated",
  "subagent-return": "the helper came back", "pop-idea": "the read resolved into an idea",
  "pop-flip": "a mid-read hmm", success: "the turn landed clean", "tests-pass": "the suite is green",
  "tests-fail": "the suite is red", error: "the turn died on an error", interrupted: "you stopped it",
  "run-failed": "a command exited non-zero", sulk: "it finished while you weren't looking",
  "sulk-loop": "still sulking", "sulk-end": "forgiven", "typing-along": "you're at the keyboard",
  "typing-away": "you walked off mid-turn", boba: "sipping between turns", "eating-rice": "you clicked it",
  "chonk-idle": "fed, and idle", "headband-on": "first work after a meal",
  "chonk-writing-code": "mashing keys, fat", "chonk-success": "a fat win", "slim-down": "the rice wears off",
  "too-full-boba": "it can't — it's full", "too-full-rice": "it can't — it's full",
  "doze-off": "you've been gone a while", "walk-away": "it gives up on you", "wake-up": "you're back",
  "fish-spot": "something moved", "fish-chase": "it's hunting", "fish-return": "caught nothing",
  "boba-run": "double-click, it runs", "boba-return": "back with a cup",
  "agent-spot": "another session appeared", "agent-follow": "you switched threads",
  "agent-return": "it's alone again",
};

/* A recorded session. The whale follows it line for line. */
const SESSION = [
  ["idle", "waiting for an order", 1600],
  ["thinking", "the request went out", 1400],
  ["long-think", "reasoning — 41 s and counting", 2600],
  ["plan", "it plans before it edits", 1700],
  ["read-file", "src/renderer.js", 1500],
  ["running-cmd", "$ npm test", 2000],
  ["tests-fail", "3 failing", 1600],
  ["writing-code", "applying a fix", 1900],
  ["running-cmd", "$ npm test", 1500],
  ["tests-pass", "the suite is green", 1900],
  ["waiting-prompt", "your move", 1800],
  ["eating-rice", "you fed it", 1300],
  ["chonk-idle", "full of rice", 1700],
  ["slim-down", "the rice wears off", 1500],
];

const heroCanvas = document.getElementById("hero");
const heroState = document.getElementById("hero-state");
const heroDoing = document.getElementById("hero-doing");
const heroClock = document.getElementById("hero-clock");
const stageCanvas = document.getElementById("stage-canvas");
const stageState = document.getElementById("stage-state");
const stageWhy = document.getElementById("stage-why");
const stageMeta = document.getElementById("stage-meta");
const list = document.getElementById("session-lines");
const catalog = document.getElementById("catalog");
const progress = document.getElementById("progress");

let meta = null, atlas = null;
let hero = { state: "idle", startedAt: performance.now() };
let stage = { state: "idle", startedAt: performance.now() };
let manual = null;
let step = -1, stepAt = 0, clock = 9 * 3600 + 41 * 60 + 2;

const rows = [];

const pad = (n) => String(n).padStart(2, "0");
const hhmmss = (s) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
const why = (s) => WHY[s] || (s.startsWith("chonk-") ? "the fed version of " + s.slice(6) : "");

function draw(canvas, state, t) {
  if (!meta || !atlas) return;
  const s = meta.states[state];
  if (!s) return;
  const fps = s.fps || 8;
  const origin = state === hero.state ? hero.startedAt : state === stage.state ? stage.startedAt : 0;
  const raw = Math.floor((t - origin) / (1000 / fps));
  const idx = s.loop === "loop" ? raw % s.frames : Math.min(Math.max(raw, 0), s.frames - 1);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 64, 64);
  ctx.drawImage(atlas, idx * 64, s.row * 64, 64, 64, 0, 0, 64, 64);
}

function setHero(state, detail) {
  hero = { state, startedAt: performance.now() };
  heroState.textContent = state;
  heroDoing.textContent = detail || why(state);
  draw(heroCanvas, state, performance.now());
}

function setStage(state) {
  stage = { state, startedAt: performance.now() };
  const s = meta.states[state];
  stageState.textContent = state;
  stageWhy.textContent = why(state);
  stageMeta.textContent = s ? `${s.frames} frames · ${s.fps} fps · ${s.loop}` : "";
  draw(stageCanvas, state, performance.now());
}

/* ── session player ─────────────────────────────────────── */

function pushLine(state, detail) {
  const li = document.createElement("li");
  li.innerHTML =
    `<span class="t">${hhmmss(clock)}</span>` +
    `<span class="t-state">${state}</span>` +
    `<span class="t-detail">${detail}</span>`;
  list.append(li);
  [...list.children].forEach((el) => el.classList.remove("now", "caret"));
  li.classList.add("now", "caret");
  while (list.children.length > 5) list.firstElementChild.remove();
}

function advance(t) {
  if (manual) { stepAt = t; return; }
  if (!stepAt) stepAt = t;
  if (t - stepAt < SESSION[step < 0 ? 0 : step][2]) return;
  step += 1;
  stepAt = t;
  if (step >= SESSION.length) {
    step = -1;
    list.innerHTML = "";
    clock = 9 * 3600 + 41 * 60 + 2;
    return;
  }
  const [state, detail] = SESSION[step];
  clock += 3 + (step % 4);
  heroClock.textContent = hhmmss(clock);
  setHero(state, detail);
  pushLine(state, detail);
}

/* ── catalogue ──────────────────────────────────────────── */

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
  const whyEl = document.createElement("span");
  whyEl.className = "row-why";
  whyEl.textContent = why(state);
  const m = document.createElement("span");
  m.className = "row-meta";
  const ms = meta.states[state];
  m.textContent = ms ? `${ms.frames}fr · ${ms.fps}fps` : "";

  row.append(c, name, whyEl, m);

  const rec = { el: row, canvas: c, state, visible: false };
  rows.push(rec);

  const enter = () => {
    manual = state;
    setHero(state);
    setStage(state);
  };
  const leave = () => { manual = null; };
  row.addEventListener("pointerenter", enter);
  row.addEventListener("focus", enter);
  row.addEventListener("pointerleave", leave);
  row.addEventListener("blur", leave);
  return row;
}

function buildCatalog() {
  const order = meta.order;
  const listed = new Set(GROUPS.flatMap(([, s]) => s));
  const groups = [...GROUPS];

  for (const [title, states] of groups) {
    const present = states.filter((s) => order.includes(s));
    if (!present.length) continue;
    const g = document.createElement("div");
    g.className = "group reveal";
    const h = document.createElement("div");
    h.className = "group-title";
    h.innerHTML = `<span>${title}</span><em>${present.length}</em>`;
    const box = document.createElement("div");
    box.className = "rows";
    present.forEach((s) => box.append(buildRow(s)));
    g.append(h, box);
    catalog.append(g);
  }

  const twins = order.filter((s) => s.startsWith("chonk-") && !listed.has(s));
  if (twins.length) {
    const g = document.createElement("div");
    g.className = "group reveal";
    const h = document.createElement("div");
    h.className = "group-title";
    h.innerHTML = `<span>Chonk variants — resolved automatically</span><em>${twins.length}</em>`;
    const box = document.createElement("div");
    box.className = "rows";
    twins.forEach((s) => box.append(buildRow(s)));
    g.append(h, box);
    catalog.append(g);
  }
}

/* ── loop ───────────────────────────────────────────────── */

function frame(t) {
  advance(t);
  draw(heroCanvas, hero.state, t);
  if (stageCanvas) draw(stageCanvas, stage.state, t);
  for (const r of rows) if (r.visible) draw(r.canvas, r.state, t);
  requestAnimationFrame(frame);
}

function reveal() {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
}

function observeRows() {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const rec = rows.find((r) => r.el === e.target);
      if (rec) rec.visible = e.isIntersecting;
    }
  }, { rootMargin: "120px 0px" });
  rows.forEach((r) => io.observe(r.el));
}

function trackProgress() {
  const onScroll = () => {
    const h = document.documentElement.scrollHeight - innerHeight;
    progress.style.width = h > 0 ? (scrollY / h) * 100 + "%" : "0%";
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

async function boot() {
  const [m, img] = await Promise.all([
    fetch("atlas.json").then((r) => r.json()),
    new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = "atlas.png"; }),
  ]);
  meta = m; atlas = img;

  buildCatalog();
  observeRows();
  reveal();
  trackProgress();

  setHero("idle", "waiting for an order");
  setStage("idle");

  requestAnimationFrame(() => {
    document.documentElement.classList.add("ready");
    requestAnimationFrame(frame);
  });
}

boot().catch((err) => {
  console.error("atlas failed to load", err);
  heroDoing.textContent = "atlas failed to load";
});
