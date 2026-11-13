// dafeiyu — one atlas, one manifest, one loop.
// Hero: a recorded session drives it. Plates: hover drives the stage.
// Night: its own six loops. Click the whale and it eats.

const GROUPS = [
  ["At rest", ["idle", "idle-left", "idle-right", "look-around", "yawn", "sleeping", "waiting-prompt", "done-flop"]],
  ["Working", ["thinking", "long-think", "plan", "reading", "read-file", "searching", "writing-code", "streaming", "tool-call", "running-cmd", "propose-diff", "compacting", "subagent", "subagent-return"]],
  ["Outcomes", ["pop-idea", "pop-flip", "success", "tests-pass", "tests-fail", "error", "interrupted", "run-failed"]],
  ["Feelings", ["sulk", "sulk-loop", "sulk-end", "typing-along", "typing-away"]],
  ["Treats", ["boba", "eating-rice", "chonk-idle", "headband-on", "chonk-writing-code", "chonk-success", "slim-down", "too-full-boba", "too-full-rice"]],
  ["Drift", ["doze-off", "walk-away", "wake-up", "fish-spot", "fish-chase", "fish-return", "boba-run", "boba-return"]],
  ["Other agents", ["agent-spot", "agent-follow", "agent-return"]],
];

const NIGHT = [["doze-off"], ["sleeping"], ["walk-away", 4], ["wake-up"], ["fish-spot"], ["fish-chase", 3]];

const WHY = {
  idle: "nothing is running",
  "idle-left": "cursor is to its left",
  "idle-right": "cursor is to its right",
  "look-around": "quiet for a while",
  yawn: "waking up",
  sleeping: "no activity for minutes",
  "waiting-prompt": "the turn ended",
  "done-flop": "the done card lands",

  thinking: "the request went out",
  "long-think": "reasoning is streaming",
  plan: "it plans before editing",
  reading: "skimming, no document",
  "read-file": "a file is open",
  searching: "grep, glob, or the web",
  "writing-code": "edits are being applied",
  streaming: "the answer is being written",
  "tool-call": "a tool ran quickly",
  "running-cmd": "a shell command is executing",
  "propose-diff": "a diff is staged",
  compacting: "context is being compacted",
  subagent: "it delegated",
  "subagent-return": "the helper came back",

  "pop-idea": "an idea from the read",
  "pop-flip": "a mid-read pause",
  success: "the turn landed clean",
  "tests-pass": "the suite is green",
  "tests-fail": "the suite is red",
  error: "the turn died on an error",
  interrupted: "you stopped it",
  "run-failed": "a command exited non-zero",

  sulk: "you missed it finishing",
  "sulk-loop": "still sulking",
  "sulk-end": "forgiven",
  "typing-along": "you're at the keyboard",
  "typing-away": "you walked off",

  boba: "sipping between turns",
  "eating-rice": "you clicked it",
  "chonk-idle": "fed, idle",
  "headband-on": "first work after a meal",
  "chonk-writing-code": "mashing keys, fed",
  "chonk-success": "a fed win",
  "slim-down": "the rice wears off",
  "too-full-boba": "already full",
  "too-full-rice": "already full",

  "doze-off": "gone a long while",
  "walk-away": "it gives up on you",
  "wake-up": "you're back",
  "fish-spot": "something moved",
  "fish-chase": "it's hunting",
  "fish-return": "caught nothing",
  "boba-run": "double-click",
  "boba-return": "back with a cup",

  "agent-spot": "another session appeared",
  "agent-follow": "you switched threads",
  "agent-return": "it's alone again",
};

const SESSION = [
  ["idle", "waiting for an order", 1600],
  ["thinking", "the request went out", 1400],
  ["long-think", "reasoning, 41 s and counting", 2600],
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

const $ = (id) => document.getElementById(id);
const heroCanvas = $("hero");
const heroState = $("hero-state");
const heroDoing = $("hero-doing");
const heroClock = $("hero-clock");
const stageCanvas = $("stage-canvas");
const stageState = $("stage-state");
const stageWhy = $("stage-why");
const stageMeta = $("stage-meta");
const list = $("session-lines");
const catalog = $("catalog");
const nightGrid = $("night-grid");
const termSprite = $("term-sprite");
const progress = $("progress");

let meta = null, atlas = null;
let hero = { state: "idle", since: 0, detail: "waiting for an order" };
let stage = { state: "idle", since: 0 };
let hovered = null;
let resumeTimer = null;      // state under the cursor
let feeding = null;      // { state, until }
let chonk = false;       // preview every state on the fed body
let step = -1, stepAt = 0, clock = 9 * 3600 + 41 * 60 + 2;

const rows = [];
const nights = [];

const pad = (n) => String(n).padStart(2, "0");
const hhmmss = (s) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
const why = (s) => WHY[s] || (s.startsWith("chonk-") ? WHY[s.slice(6)] || "" : "");
const num = (i) => String(i + 1).padStart(3, "0");

const frameCache = new Map();
function framesOf(state) {
  if (frameCache.has(state)) return frameCache.get(state);
  const s = meta && meta.states[state];
  if (!s) return null;
  const blanks = (meta.empty && meta.empty[state]) || [];
  const vis = [];
  for (let i = 0; i < s.frames; i++) if (!blanks.includes(i)) vis.push(i);
  const rec = { s, vis: vis.length ? vis : [0] };
  frameCache.set(state, rec);
  return rec;
}

const view = (s) => (chonk && !s.startsWith("chonk-") && meta && meta.states["chonk-" + s] ? "chonk-" + s : s);

function draw(canvas, state, t, since, cap) {
  if (!meta || !atlas) return;
  state = view(state);
  const f = framesOf(state);
  if (!f) return;
  const { s } = f;
  const vis = cap ? f.vis.slice(0, cap) : f.vis;
  const fps = s.fps || 8;
  const raw = Math.floor((t - since) / (1000 / fps));
  const k = s.loop === "loop" ? Math.max(raw, 0) % vis.length : Math.min(Math.max(raw, 0), vis.length - 1);
  const idx = vis[k];
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 64, 64);
  ctx.drawImage(atlas, idx * 64, s.row * 64, 64, 64, 0, 0, 64, 64);
}

function setHero(state, detail, since = performance.now()) {
  hero = { state, detail: detail || why(state), since };
  heroState.textContent = view(state);
  heroDoing.textContent = hero.detail;
}

function setStage(state) {
  stage = { state, since: performance.now() };
  const s = meta.states[state];
  stageState.textContent = view(state);
  stageWhy.textContent = why(state);
  stageMeta.textContent = s ? `${s.frames} frames · ${s.fps} fps · ${s.loop}` : "";
}

/* ── session ──────────────────────────────────────────────── */

function pushLine(state, detail) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="t">${hhmmss(clock)}</span><span class="t-state">${state}</span><span class="t-detail">${detail}</span>`;
  list.append(li);
  [...list.children].forEach((el) => el.classList.remove("now", "caret"));
  li.classList.add("now", "caret");
  while (list.children.length > 5) list.firstElementChild.remove();
}

function advance(t) {
  if (hovered || feeding) { stepAt = t; return; }
  if (!stepAt) stepAt = t;
  if (t - stepAt < SESSION[step < 0 ? 0 : step][2]) return;
  step += 1;
  stepAt = t;
  if (step >= SESSION.length) {
    // Roll the log rather than clearing it: the clock keeps running and the
    // oldest line drops off, which is what a terminal actually does.
    step = 0;
    clock += 4;
    heroClock.textContent = hhmmss(clock);
    const [s0, d0] = SESSION[0];
    setHero(s0, d0);
    pushLine(s0, d0);
    return;
  }
  const [state, detail] = SESSION[step];
  clock += 3 + (step % 4);
  heroClock.textContent = hhmmss(clock);
  setHero(state, detail);
  pushLine(state, detail);
}

/* ── feeding ──────────────────────────────────────────────── */

function feed() {
  const now = performance.now();
  if (feeding && feeding.state === "chonk-idle") {
    setHero("too-full-rice", "it's full", now);
    feeding = { state: "too-full-rice", until: now + 2200 };
    setTimeout(() => {
      if (!feeding) return;
      if (hovered) { feeding = null; return; }
      setHero("chonk-idle", "fed, and idle");
      feeding = { state: "chonk-idle", until: performance.now() + 1e9 };
    }, 2100);
    return;
  }
  setHero("eating-rice", "you clicked it", now);
  feeding = { state: "eating-rice", until: now + 2600 };
  setTimeout(() => {
    if (hovered) { feeding = null; return; }
    setHero("chonk-idle", "full of rice");
    feeding = { state: "chonk-idle", until: performance.now() + 1e9 };
    setTimeout(() => { feeding = null; stepAt = performance.now(); }, 5200);
  }, 2500);
}

/* ── catalogue ────────────────────────────────────────────── */

function buildRow(state, index) {
  const row = document.createElement("div");
  row.className = "row";
  row.tabIndex = 0;
  row.dataset.state = state;

  const c = document.createElement("canvas");
  c.width = 64; c.height = 64;
  const name = document.createElement("span");
  name.className = "row-name";
  name.innerHTML = `<span class="row-num">${num(index)}</span>${state}`;
  const w = document.createElement("span");
  w.className = "row-why";
  w.textContent = why(state);
  const m = document.createElement("span");
  m.className = "row-meta";
  const ms = meta.states[state];
  m.textContent = ms ? `${ms.frames}fr · ${ms.fps}fps` : "";
  row.append(c, name, w, m);

  row.classList.add("reveal");
  const rec = { el: row, canvas: c, state, visible: false };
  rows.push(rec);

  // Hover follows you across rows: entering a new row cancels the pending
  // resume, so sweeping down the catalogue never flickers back to the session.
  const enter = () => {
    clearTimeout(resumeTimer);
    hovered = state;
    document.body.classList.add("hovering");
    setHero(state);
    setStage(state);
  };
  const leave = () => {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      hovered = null;
      document.body.classList.remove("hovering");
      const cur = SESSION[step] || SESSION[0];
      if (cur) setHero(cur[0], cur[1]);
      stepAt = performance.now();
    }, 90);
  };
  row.addEventListener("pointerenter", enter);
  row.addEventListener("focus", enter);
  row.addEventListener("pointerleave", leave);
  row.addEventListener("blur", leave);
  return row;
}

function buildCatalog() {
  const order = meta.order;
  let n = 0;
  for (const [title, states] of GROUPS) {
    const present = states.filter((s) => order.includes(s));
    if (!present.length) continue;
    const g = document.createElement("div");
    g.className = "group reveal";
    const h = document.createElement("div");
    h.className = "group-title";
    h.innerHTML = `<span>${title}</span><em>${present.length}</em>`;
    const box = document.createElement("div");
    box.className = "rows";
    present.forEach((s) => box.append(buildRow(s, n++)));
    g.append(h, box);
    catalog.append(g);
  }
}

function buildNight() {
  const c = $("night-canvas");
  if (!c) return;
  nights.push({ canvas: c, state: "sleeping", since: performance.now() });
}

/* ── loop ─────────────────────────────────────────────────── */

function frame(t) {
  advance(t);
  draw(heroCanvas, hero.state, t, hero.since);
  if (termSprite) draw(termSprite, hero.state, t, hero.since);
  draw(stageCanvas, stage.state, t, stage.since);
  for (const r of rows) if (r.visible) draw(r.canvas, r.state, t, 0);
  for (const n of nights) draw(n.canvas, n.state, t, n.since, n.cap);
  requestAnimationFrame(frame);
}

function observe() {
  const revealIO = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); revealIO.unobserve(e.target); }
  }, { rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach((el) => revealIO.observe(el));

  const rowIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const rec = rows.find((r) => r.el === e.target);
      if (rec) {
        rec.visible = e.isIntersecting;
        if (e.isIntersecting) e.target.classList.add("in");
      }
    }
  }, { rootMargin: "150px 0px" });
  rows.forEach((r) => rowIO.observe(r.el));
}

function trackProgress() {
  const onScroll = () => {
    const h = document.documentElement.scrollHeight - innerHeight;
    progress.style.width = h > 0 ? (scrollY / h) * 100 + "%" : "0%";
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

if ("scrollRestoration" in history) history.scrollRestoration = "manual";

async function boot() {
  const [m, img] = await Promise.all([
    fetch("atlas.json").then((r) => r.json()),
    new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = "atlas.png"; }),
  ]);
  meta = m; atlas = img;

  scrollTo(0, 0);
  buildCatalog();
  buildNight();
  observe();
  trackProgress();

  setHero("idle", "waiting for an order");
  setStage("idle");
  // Seed the transcript so the terminal is never empty on first paint.
  pushLine(SESSION[0][0], SESSION[0][1]);
  step = 0;
  stepAt = performance.now();
  heroClock.textContent = hhmmss(clock);
  heroCanvas.addEventListener("click", feed);

  const chonkBtn = $("chonk-toggle");
  if (chonkBtn) {
    chonkBtn.addEventListener("click", () => {
      chonk = !chonk;
      chonkBtn.setAttribute("aria-pressed", String(chonk));
      chonkBtn.textContent = chonk ? "chonk on" : "chonk off";
      setHero(hero.state.replace(/^chonk-/, ""), hero.detail);
      setStage(stage.state.replace(/^chonk-/, ""));
    });
  }

  document.documentElement.classList.add("ready");

  // Paint one frame synchronously: a page opened in a background tab has rAF
  // paused, and an empty canvas is worse than a still one.
  const now = performance.now();
  draw(heroCanvas, hero.state, now, hero.since);
  draw(stageCanvas, stage.state, now, stage.since);
  for (const n of nights) draw(n.canvas, n.state, now, n.since, n.cap);

  requestAnimationFrame(frame);
  addEventListener("visibilitychange", () => {
    if (!document.hidden) requestAnimationFrame(frame);
  });
}

boot().catch((err) => {
  console.error("atlas failed to load", err);
  heroDoing.textContent = "atlas failed to load";
});
