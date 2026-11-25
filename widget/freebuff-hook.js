#!/usr/bin/env node
const fs=require("fs");const os=require("os");const path=require("path");const http=require("http")
;const{DatabaseSync:DatabaseSync}=require("node:sqlite")
;const POLL_MS=200            // cheap: a stat per candidate, nothing more
;const PARTS_BUSY_MS=800      // blob re-read while a turn is streaming
;const PARTS_IDLE_MS=2500     // blob re-read when the WAL has not moved
;const SCAN_EVERY_MS=5000     // full readdir + stat sweep
;const SCAN_HEAD=6            // candidates whose stamps are refreshed each tick
;const BLOCK_AFTER_MS=Number(process.env.DAFEIYU_BLOCK_AFTER_MS)||45000
;const OUTCOME_HOLD_MS=20000   // error/stopped are edges, not permanent states
;const CONFIRM_MS=250;const MIN_HOLD_MS=380;const STALE_MS=120000;const MISSION_FRESH_MS=45000
;const PORT=Number(process.env.DAFEIYU_PORT||8791)
;const OUT=path.join(process.env.DAFEIYU_RUNTIME||path.join(__dirname,"runtime"),"state.json")
;const ROOT=[path.join(os.homedir(),".config","freebuff-desktop","projects"),path.join(os.homedir(),"Library","Application Support","freebuff-desktop","projects")].find(p=>fs.existsSync(p))||path.join(os.homedir(),".config","freebuff-desktop","projects")
;const WEIGHT={error:9,blocked:8,success:9,interrupted:7,"run-failed":6,"running-cmd":6,
"tests-fail":6,"tests-pass":6,"writing-code":5,"propose-diff":5,"read-file":4,searching:4,"tool-call":4,
compacting:4,streaming:3,"long-think":3,thinking:2,"waiting-prompt":1,idle:1,sleeping:0,"chonk-idle":0}
;const TOOL_STATE={run_terminal_command:"running-cmd",read_files:"read-file",list_directory:"read-file",
read_url:"read-file",write_file:"writing-code",str_replace:"writing-code",web_search:"searching",
code_search:"searching",register_preview:"tool-call",preview_open:"tool-call",preview_screenshot:"tool-call",
preview_snapshot:"tool-call",preview_click:"tool-call",preview_type:"tool-call",preview_navigate:"tool-call",
preview_evaluate:"tool-call",preview_scroll:"tool-call",preview_logs:"tool-call",exit_plan:"tool-call"}

// ── the directory, swept rarely and refreshed cheaply ──────────────────────
// The old version re-read the whole projects tree and stat'ed every database
// five times a second. The answer changes about never; cache it for five
// seconds and re-stat only the head of the list each tick.

let scan={at:0,list:[]}
function stampOf(db){let s=0;for(const f of[db+"-wal",db]){try{s=Math.max(s,fs.statSync(f).mtimeMs)}catch{}}return s}
function sweep(){const out=[];let entries;try{entries=fs.readdirSync(ROOT,{withFileTypes:true})}catch{return out}
;for(const e of entries){if(!e.isDirectory())continue;const db=path.join(ROOT,e.name,"desktop-v2.db")
;if(!fs.existsSync(db))continue;out.push({db:db,project:e.name,stamp:stampOf(db)})}
out.sort((a,b)=>b.stamp-a.stamp);return out}
function activeDbs(n=3,now=Date.now()){
if(now-scan.at>SCAN_EVERY_MS){scan={at:now,list:sweep()}}
if(!scan.list.length)return[]
const head=scan.list.slice(0,Math.max(n,SCAN_HEAD)).map(c=>({db:c.db,project:c.project,stamp:stampOf(c.db)}))
head.sort((a,b)=>b.stamp-a.stamp)
return head.slice(0,n)}

// ── one handle per project, reused until it goes stale ─────────────────────

const handles=new Map()
function handleFor(dbPath){
let h=handles.get(dbPath)
if(h){handles.delete(dbPath);handles.set(dbPath,h);return h}
const db=new DatabaseSync(dbPath,{readOnly:true});db.exec("PRAGMA busy_timeout = 400");try{db.exec("PRAGMA cache_size = -2000")}catch{}
h={db:db,stamp:-1,at:0,threadId:null,parts:null,outType:null}
handles.set(dbPath,h)
if(handles.size>4){const oldest=handles.keys().next().value;const o=handles.get(oldest)
;try{o.db.close()}catch{}handles.delete(oldest)}
return h}
function dropHandle(dbPath){const h=handles.get(dbPath);if(!h)return;try{h.db.close()}catch{}handles.delete(dbPath)}

function readThread(db,now){
return db.prepare(`
    select id, title, updated_at, turn_state, auto_run, auto_run_started_at, auto_run_stopped_at, agent_mode, attention_reason, last_turn_outcome, model,
           turn_alive_at, last_turn_finished_at, last_prompt_at
    from threads
    order by (turn_state = 'running' and turn_alive_at is not null and turn_alive_at > ?) desc, updated_at desc
    limit 1
  `).get(now?now-STALE_MS:0)}
function readThreadCached(h,stamp,now){
if(h.thread&&h.threadStamp===stamp&&now-h.threadAt<1200)return h.thread
const t=readThread(h.db,now)
h.thread=t;h.threadStamp=stamp;h.threadAt=now
return t}
const MAX_AGENTS=3;const AGENT_WINDOW_MS=45*60000
function readAgents(db,now){let rows=[];try{
rows=db.prepare(`
      select id, title, updated_at, turn_state, auto_run, agent_mode, last_turn_outcome, model,
             turn_alive_at, last_turn_finished_at
      from threads
      where updated_at > ?
      order by turn_state = 'running' desc, updated_at desc
      limit ?
    `).all(now-AGENT_WINDOW_MS,MAX_AGENTS)
}catch{}if(!rows.length){try{
const t=db.prepare(`
        select id, title, updated_at, turn_state, auto_run, agent_mode, last_turn_outcome,
               turn_alive_at, last_turn_finished_at
        from threads order by updated_at desc limit 1
      `).get()
;if(t)rows=[t]}catch{}}return rows}

function coarseState(thread,now){if(!thread)return"idle"
;if(thread.turn_state==="running")return"thinking";if(thread.auto_run===1)return"thinking"
;const since=thread.last_turn_finished_at?now-thread.last_turn_finished_at:Infinity
;if(thread.last_turn_outcome==="error"&&since<OUTCOME_HOLD_MS)return"error"
;if(thread.last_turn_outcome==="stopped"&&since<OUTCOME_HOLD_MS)return"interrupted"
;if(since<60000)return"waiting-prompt";if(since<10*60000)return"idle";return"sleeping"}

// ── the live part list: one json_extract, and only when the WAL moved ─────

function readLiveParts(h,threadId,stamp,busy){
const now=Date.now()
const ttl=busy?PARTS_BUSY_MS:PARTS_IDLE_MS
const same=h.threadId===threadId&&h.parts
const moved=h.stamp!==stamp
// A stale stamp must not pin the parts cache forever: re-read on a bounded
// age even when the mtime has not moved (observed: a running turn stuck on the
// previous turn's finished state for minutes).
if(same&&now-h.at<(moved?ttl:ttl*4))return h.parts
let rm=null
try{
  const row=h.db.prepare("select json_extract(harness_state, '$.runtimeMove') as rm from threads where id = ?").get(threadId)
  rm=row?row.rm:null
}catch{}
let parts=[];let outType=null
if(rm){try{
  const o=typeof rm==="string"?JSON.parse(rm):rm
  parts=Array.isArray(o.parts)?o.parts:(typeof o.parts==="string"?JSON.parse(o.parts):[])
  outType=(o.output&&o.output.type)||o.outType||null
}catch{}}
h.parts=parts;h.outType=outType;h.at=now;h.threadId=threadId;h.stamp=stamp
return parts}

const TEST_CMD=/(?:^|[\s;&|()])(?:npm|pnpm|yarn|bun|npx|deno)\s+(?:run\s+)?(?:test|t)(?::[\w-]+)?\b|\b(?:pytest|jest|vitest|mocha|rspec|phpunit|ctest|tox|nox|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|node\s+--test|python3?\s+-m\s+(?:pytest|unittest))\b/i
function shape(p){return{kind:p.kind,toolName:p.toolName??null,status:p.status??null,exitCode:p.exitCode??null,cmd:(p.input&&(p.input.command||p.input.cmd))||null}}
const LONG_THINK_MS=Number(process.env.DAFEIYU_LONG_THINK_MS)||15000
const reasonTrack={threadId:null,since:0}
function reasonDwell(threadId,parts,now){const last=parts&&parts.length?parts[parts.length-1]:null
;if(last&&last.kind==="reasoning"){if(reasonTrack.threadId!==threadId||!reasonTrack.since){reasonTrack.threadId=threadId;reasonTrack.since=now}return now-reasonTrack.since}
reasonTrack.since=0;return 0}

// A tool part that has not changed for BLOCK_AFTER_MS, with the WAL quiet,
// is waiting on a human. This is the state that was missing entirely.
const partTrack={threadId:null,sig:"",since:0}
function partDwell(threadId,part,now){
const sig=part?part.kind+":"+(part.toolName||"")+":"+(part.status||""):""
if(partTrack.threadId!==threadId||partTrack.sig!==sig){partTrack.threadId=threadId;partTrack.sig=sig;partTrack.since=now;return 0}
return now-partTrack.since}

const missionSeen=new Map()
function missionCheck(db,thread,now){if(!thread)return false;let seen=0
;if(thread.auto_run===1)seen=now
;else if(thread.auto_run_started_at&&!thread.auto_run_stopped_at&&now-thread.auto_run_started_at<MISSION_FRESH_MS)seen=thread.auto_run_started_at
;try{const r=db.prepare("select max(updated_at) m, max(case when status='deciding' then updated_at else 0 end) d from auto_run_decision_receipts where thread_id = ?").get(thread.id)
;if(r){if(r.d)seen=Math.max(seen,r.d);if(r.m)seen=Math.max(seen,r.m)}}catch{}
if(seen>0)missionSeen.set(thread.id,seen)
;if(missionSeen.size>8){const drop=[...missionSeen.entries()].sort((a,b)=>a[1]-b[1]).slice(0,missionSeen.size-8);for(const[k]of drop)missionSeen.delete(k)}
const last=missionSeen.get(thread.id)||0;return last>0&&now-last<MISSION_FRESH_MS}

// One success per finished turn: the edge, not a held state.
const finishedSeen=new Map()
function takeSuccess(thread){
const at=thread.last_turn_finished_at||0
if(!at)return false
if((finishedSeen.get(thread.id)||0)>=at)return false
finishedSeen.set(thread.id,at)
if(finishedSeen.size>16){const first=finishedSeen.keys().next().value;finishedSeen.delete(first)}
return thread.last_turn_outcome==="completed"}

function classify(snap,now){
const{thread:thread,part:part,outType:outType,queueRunning:queueRunning,toolLive:toolLive,dbFresh:dbFresh,reasonMs:reasonMs,dwell:dwell,missionActive:missionActive}=snap
if(!thread)return{state:"idle",detail:"no session",confident:false}
const alive=thread.turn_alive_at?now-thread.turn_alive_at:Infinity
if(thread.turn_state==="running"){
  if(alive>STALE_MS&&!toolLive&&!dbFresh)return{state:"idle",detail:"abandoned turn",confident:false}
  if(outType==="error")return{state:"error",detail:"turn failed",confident:true}
  if(!part)return{state:"thinking",detail:"starting",confident:false}
  // stalled on a human
  if(part.kind==="tool"&&part.status==="pending"&&(dwell||0)>=BLOCK_AFTER_MS&&!dbFresh){
    return{state:"blocked",detail:"waiting for you",confident:true}}
  switch(part.kind){
    case"reasoning":return{state:(reasonMs||0)>=LONG_THINK_MS?"long-think":"thinking",detail:"reasoning",confident:true}
    case"text":return{state:"streaming",detail:"answering",confident:true}
    case"changes":return{state:"propose-diff",detail:"editing files",confident:true}
    case"compaction":return{state:"compacting",detail:"compacting context",confident:true}
    case"agent":return{state:"tool-call",detail:"subagent",confident:true}
    case"tool":{
      if(part.status==="failure"||typeof part.exitCode==="number"&&part.exitCode!==0){
        return{state:TEST_CMD.test(part.cmd||"")?"tests-fail":"run-failed",detail:`${part.toolName||"tool"} failed`,confident:true}}
      if(part.status==="success"&&TEST_CMD.test(part.cmd||""))return{state:"tests-pass",detail:"suite passed",confident:true}
      const mapped=TOOL_STATE[part.toolName]
      return{state:mapped||"tool-call",detail:part.toolName||"tool",confident:true}}
    default:return{state:"tool-call",detail:part.kind||"tool",confident:true}}}
// idle: the outcome is news for a moment, then it settles
const sinceEnd=thread.last_turn_finished_at?now-thread.last_turn_finished_at:Infinity
if(thread.last_turn_outcome==="error"&&sinceEnd<OUTCOME_HOLD_MS)return{state:"error",detail:"turn failed",confident:true}
if(thread.last_turn_outcome==="stopped"&&sinceEnd<OUTCOME_HOLD_MS)return{state:"interrupted",detail:"you stopped it",confident:true}
if(thread.last_turn_outcome==="completed"&&sinceEnd<OUTCOME_HOLD_MS&&takeSuccess(thread))return{state:"success",detail:"turn completed",confident:true}
if(missionActive)return{state:"thinking",detail:"mission step",confident:true}
if(queueRunning)return{state:"running-cmd",detail:"queue running",confident:true}
if(sinceEnd<60000)return{state:"waiting-prompt",detail:"finished",confident:true}
if(sinceEnd<10*60000)return{state:"idle",detail:"resting",confident:true}
return{state:"sleeping",detail:sinceEnd<30*60000?"asleep":"long idle",confident:true}}

const OUTCOME_STATES=new Set(["interrupted","error","success","run-failed","tests-fail","tests-pass"])
class Smoother{constructor(){this.current=null;this.adoptedAt=0;this.pending=null
;this.pendingSince=0;this.pendingConfident=false;this.turnKey=null}push(cand,now,turnKey){if(!this.current){this.adopt(cand,now,turnKey)
;return this.current}
// A new turn owns the cell: the previous turn's outcome is not news anymore.
if(turnKey!==this.turnKey){this.adopt(cand,now,turnKey);return this.current}
if(cand.state===this.current.state){this.pending=null;return this.current}
if(this.pending!==cand.state){this.pending=cand.state;this.pendingSince=now;this.pendingConfident=cand.confident}
const waited=now-this.pendingSince;const held=now-this.adoptedAt
// An outcome state is news for OUTCOME_HOLD_MS; after that it must never block
// a low-confidence candidate (a running turn whose parts are not readable yet).
const spentOutcome=OUTCOME_STATES.has(this.current.state)&&held>OUTCOME_HOLD_MS
;if(!cand.confident&&this.current.confident&&!spentOutcome)return this.current;if(waited<CONFIRM_MS)return this.current
;if(held<MIN_HOLD_MS)return this.current;const cur=WEIGHT[this.current.state]??1;const next=WEIGHT[cand.state]??1
;if(next<cur&&held<MIN_HOLD_MS*3)return this.current;this.adopt(cand,now,turnKey);return this.current}adopt(cand,now,turnKey){
this.current={state:cand.state,detail:cand.detail,confident:cand.confident};this.turnKey=turnKey;this.adoptedAt=now;this.pending=null}}

// side queries (queue + mission) only when the WAL actually moved
const sideCache=new Map()
function sideInfo(db,thread,walFresh,now){
const hit=sideCache.get(thread.id)
if(hit&&(!walFresh||now-hit.at<800))return hit
let queueRunning=false
try{
  const q=db.prepare(`select count(*) c from queue_items where thread_id = ? and state = 'running' and updated_at > ?`).get(thread.id,now-60000)
  queueRunning=!!(q&&q.c)
}catch{}
const missionActive=missionCheck(db,thread,now)
const info={queueRunning:queueRunning,missionActive:missionActive,at:now}
sideCache.set(thread.id,info)
if(sideCache.size>16){const first=sideCache.keys().next().value;sideCache.delete(first)}
return info}

function sample(smoother){
const now0=Date.now()
const candidates=activeDbs(3,now0)
if(!candidates.length)return smoother.push({state:"idle",detail:"freebuff not found",confident:false},now0)
let best=null;const pool=[]
for(const c of candidates){
  try{
    const h=handleFor(c.db)
    const t=readThreadCached(h,c.stamp,now0)
    if(!t){dropHandle(c.db);continue}
    const aliveAge=t.turn_alive_at?now0-t.turn_alive_at:Infinity
    const walFresh=(now0-c.stamp)<10000
    // metadata only: no blob in the selection loop
    const fresh=t.turn_state==="running"&&(aliveAge<STALE_MS||walFresh)
    const score=(fresh?1e15:0)+(t.updated_at||0)
    pool.push({t:t,fresh:fresh,score:score})
    if(!best||score>best.score)best={db:c.db,t:t,fresh:fresh,score:score,walFresh:walFresh}
  }catch{dropHandle(c.db)}
}
if(!best)return smoother.push({state:"idle",detail:"no threads",confident:false},now0)
try{
  const h=handleFor(best.db)
  const thread=best.t
  let part=null,outType=null,toolLive=false,partLive=false,reasonMs=0,dwell=0
  if(thread.turn_state==="running"){
    const live=readLiveParts(h,thread.id,best.stamp,true)
    outType=h.outType??null
    const usable=live.filter(p=>p&&typeof p==="object"&&p.kind!=="ad")
    if(usable.length){
      part=shape(usable[usable.length-1]);partLive=true
      reasonMs=reasonDwell(thread.id,usable,Date.now())
      toolLive=part.kind==="tool"&&(part.status==="running"||part.status==="pending"||part.status==null)
      dwell=partDwell(thread.id,part,Date.now())
    }
  } else { reasonTrack.since=0 }
  const now=Date.now()
  const side=sideInfo(h.db,thread,best.walFresh,now)
  const cand=classify({thread:thread,part:part,outType:outType,queueRunning:side.queueRunning,
    toolLive:toolLive,partLive:partLive,dbFresh:best.walFresh,reasonMs:reasonMs,dwell:dwell,
    missionActive:side.missionActive},now)
  const chosen=smoother.push(cand,now,thread.id+":"+(thread.last_prompt_at||0))
  return{...chosen,thread:thread.id.slice(0,8),mode:thread.agent_mode,model:thread.model||null,turn:thread.turn_state,ts:now,
    agents:(pool.length?pool.sort((a,b)=>b.score-a.score).slice(0,MAX_AGENTS):[{t:thread,fresh:thread.turn_state==="running",score:0}]).map(({t:t,fresh:fresh})=>({id:t.id.slice(0,8),
      title:t.title&&t.title.trim()||t.id.slice(0,6),state:t.id===thread.id?chosen.state:coarseState(t,now),running:!!fresh,updatedAt:t.updated_at
    })),source:"sqlite",stale:false}
}catch(err){
  dropHandle(best.db)
  const cur=smoother.current
  return{state:cur?cur.state:"idle",detail:cur?cur.detail:"db error",confident:false,thread:null,
    mode:null,turn:null,agents:[],source:"sqlite",stale:true,ts:Date.now(),error:err.message}
}}

const { runWatch } = require("./core/transport");

if (process.argv.includes("--watch")) runWatch({
  tag: "[hook]", port: PORT, file: OUT, pollMs: POLL_MS, sample, Smoother,
  sig: (p) => p.state + "|" + (p.detail || "") + "|" + (p.turn || "") + "|" + (p.mode || "")
    + "|" + (p.agents || []).map((a) => a.id + ":" + a.state + ":" + (a.running ? 1 : 0)).join(","),
});

// Tools only: the smoother is pure, so the turn-boundary rules can be tested
// without a database. See tools/test-freebuff-smoother.js.
module.exports = { Smoother, classify };
