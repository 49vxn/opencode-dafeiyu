#!/usr/bin/env node
const fs=require("fs");const os=require("os");const path=require("path");const http=require("http")
;const{DatabaseSync:DatabaseSync}=require("node:sqlite");const POLL_MS=200;const PARTS_EVERY_MS=400;const CONFIRM_MS=350
;const MIN_HOLD_MS=550;const STALE_MS=120000;const BLOCK_AFTER_MS=45000;const START_GRACE_MS=90000
;const PORT=Number(process.env.DAFEIYU_OPENCODE_PORT||8792);const OUTCOME_HOLD_MS=20000
;const OUT=path.join(process.env.DAFEIYU_RUNTIME||path.join(__dirname,"runtime"),"state-opencode.json")
;const dataDir=()=>process.env.XDG_DATA_HOME||(process.platform==="win32"?path.join(os.homedir(),".local","share"):path.join(os.homedir(),".local","share"))
;const DB=()=>path.join(dataDir(),"opencode","opencode.db");const WEIGHT={error:9,success:9,blocked:8,interrupted:7,"run-failed":6,"running-cmd":6,
"tests-fail":6,"tests-pass":6,"writing-code":5,"propose-diff":5,"read-file":4,searching:4,"tool-call":4,compacting:4,
streaming:3,"long-think":3,thinking:2,"waiting-prompt":1,idle:1,sleeping:0,"chonk-idle":0};const TOOL_STATE={
bash:"running-cmd",shell:"running-cmd",terminal:"running-cmd",read:"read-file",glob:"read-file",list:"read-file",
view:"read-file",grep:"searching",rg:"searching",webfetch:"searching",websearch:"searching",write:"writing-code",
edit:"writing-code",patch:"writing-code",multiedit:"writing-code",task:"tool-call"};function dbStamp(){const db=DB()
;let stamp=0;for(const f of[db+"-wal",db]){try{stamp=Math.max(stamp,fs.statSync(f).mtimeMs)}catch{}}return stamp||null}
// session_v2.model is a JSON string like {"id":"deepseek-v4.1-flash-free",
// "providerID":"opencode","variant":"max"} - emit a clean provider/id label for
// the renderer (accessory auto-trigger matches on it). Anything unparseable
// passes through raw so a regex can still match.
function modelLabel(m){if(!m)return null
;try{const o=JSON.parse(m);if(o&&o.id)return(o.providerID?o.providerID+"/":"")+o.id}catch{}return String(m)}
const partsCache={id:null,at:0,content:[]};function shape(p){return{type:p.type,name:p.name??null,
status:p.state?p.state.status:null,cmd:(p.state&&p.state.input&&p.state.input.command)||null}}
const TEST_CMD=/(?:^|[\s;&|()])(?:npm|pnpm|yarn|bun|npx|deno)\s+(?:run\s+)?(?:test|t)(?::[\w-]+)?\b|\b(?:pytest|jest|vitest|mocha|rspec|phpunit|ctest|tox|nox|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|node\s+--test|python3?\s+-m\s+(?:pytest|unittest))\b/i
function readSession(db){
return db.prepare(`\n    select id, directory, title, agent, model, time_updated,\n           time_busy, time_idle, idle_outcome\n    from session_v2\n    order by time_updated desc\n    limit 1\n  `).get()
}const MAX_AGENTS=3;const AGENT_WINDOW_MS=45*60000;function readAgents(db,now){try{
return db.prepare(`\n      select id, title, time_updated, time_busy, time_idle\n      from session_v2\n      where time_updated > ?\n      order by time_updated desc\n      limit ?\n    `).all(now-AGENT_WINDOW_MS,MAX_AGENTS)
}catch{return[]}}function coarseState(session,now){if(!session)return"idle";const busy=session.time_busy||0
;const idle=session.time_idle||0;const anchor=Math.max(busy,session.time_updated||0)
;const since=anchor?now-anchor:Infinity;if(busy>idle&&since<STALE_MS)return"thinking"
;if(since<60000)return"waiting-prompt";if(since<10*60000)return"idle";if(since<30*60000)return"sleeping"
;return"sleeping"}function readLiveTurn(db,sessionId){const now=Date.now();let row=null;try{
row=db.prepare(`\n      select id, time_updated, json_extract(data, '$.finish') as finish, data\n      from session_message\n      where session_id = ? and type = 'assistant'\n      order by seq desc\n      limit 1\n    `).get(sessionId)
}catch{return null}if(!row)return null;const changed=partsCache.id!==row.id||now-partsCache.at>PARTS_EVERY_MS
;if(!changed)return{row:row,content:partsCache.content};let content=[];if(row.data){try{
const parsed=JSON.parse(row.data);content=parsed&&Array.isArray(parsed.content)?parsed.content:[]}catch{
content=partsCache.content}}if(!content.length)content=partsCache.content;partsCache.id=row.id;partsCache.at=now
;partsCache.content=content;return{row:row,content:content}}
// Turn-end edges. time_idle is only stamped when a session goes fully idle
// (opencode writes an "idle" marker row); back-to-back turns never update it, so
// gating on it made success/error/interrupted unreachable on active sessions.
// success fires when the last assistant message is watched flipping to
// finish="stop" (never replayed after a hook restart); error/interrupted fire on
// an idle_outcome change observed right after a turn was seen in flight.
const finishSeen=new Map()
function takeFinish(session,row,now,lastType){
if(!row||!row.id)return null
;const fin=row.finish;const key=row.id+":"+fin;const prev=finishSeen.get(session.id)
;finishSeen.set(session.id,key)
;if(finishSeen.size>16){const first=finishSeen.keys().next().value;finishSeen.delete(first)}
;if(!prev)return null
;if(prev!==row.id+":null"&&prev!==row.id+":tool-calls")return null
;const fresh=now-(row.time_updated||0)<OUTCOME_HOLD_MS
;if(fin==="stop"){if(!fresh||lastType==="user")return null
;return{state:"success",detail:"turn completed",confident:true}}
;if(fin==="abort"||fin==="aborted"||fin==="cancelled"){if(!fresh)return null
;return{state:"interrupted",detail:"you stopped it",confident:true}}
return null}
const flightSeen=new Map()
// Single-poll edges die in the smoother: CONFIRM_MS (350) rejects a one-poll
// candidate because the very next poll returns waiting-prompt and resets the
// pending buffer. An outcome hold keeps presenting the success/error/
// interrupted candidate for HOLD_MS so the smoother confirms and adopts it -
// the same trick the tests-pass latch uses.
const HOLD_MS=2000;let hold={state:null,detail:"",until:0}
function setHold(c,now,sessionId){hold={state:c.state,detail:c.detail,
until:Math.max(now+HOLD_MS,(testPassUntil.get(sessionId)||0)+100)}}
// The finish flip null->"stop" is only observable while the row is still the
// newest one; opencode writes the next assistant segment within one poll of the
// previous row completing, so the flip usually happens between polls. Instead,
// when the newest row CHANGES, read the finish of the row that just left the
// slot: if it was seen in flight and ended "stop", that turn completed.
const newestSeen=new Map();const rowFlight=new Map()
function detectSupersededFinish(db,session,live,now){
const prevNewest=newestSeen.get(session.id);const curNewest=live&&live.row?live.row.id:null
;if(live&&live.row&&(live.row.finish==null||live.row.finish==="tool-calls")){rowFlight.set(live.row.id,true)
;if(rowFlight.size>32){const first=rowFlight.keys().next().value;rowFlight.delete(first)}}
;newestSeen.set(session.id,curNewest)
;if(!prevNewest||!curNewest||prevNewest===curNewest||!rowFlight.get(prevNewest))return
;let old=null;try{
old=db.prepare("select json_extract(data, '$.finish') as f, time_updated from session_message where id=?").get(prevNewest)}catch{return}
;if(old&&old.f==="stop"&&now-(old.time_updated||0)<OUTCOME_HOLD_MS){
setHold({state:"success",detail:"turn completed"},now,session.id)
;console.error("[oc-hook] edge(success) superseded row="+prevNewest.slice(-6))}}
function takeOutcome(session,row){
const id=session.id
;if(row&&(row.finish==null||row.finish==="tool-calls")){flightSeen.set(id,true)
;if(flightSeen.size>16){const first=flightSeen.keys().next().value;flightSeen.delete(first)}
;return null}
;if(!flightSeen.get(id))return null
;flightSeen.set(id,false)
;const o=session.idle_outcome
;if(o==="failed")return{state:"error",detail:"turn failed",confident:true}
;if(o==="interrupted")return{state:"interrupted",detail:"you stopped it",confident:true}
return null}
// tests-pass needs a history scan: opencode writes each assistant segment as its
// own message row, so a completed test part is superseded by the next row within
// one poll - the newest-only read never sampled it (failures linger, passes
// race). Scan the last 6 assistant rows instead: unseen rows are primed without
// latching (a hook restart never replays old passes); the newest row is
// re-parsed at 400ms to catch its running -> completed flip.
const testSeen=new Map();const testPassUntil=new Map();const testRowCache=new Map()
;const BOOT=Date.now();let lastScanErr=""
;function scanWarn(m){if(m!==lastScanErr){lastScanErr=m;console.error("[oc-hook] scan: "+m)}}
function isCompletedTest(p){return !!p&&p.type==="tool"&&p.state&&p.state.status==="completed"&&TEST_CMD.test((p.state.input&&p.state.input.command)||"")}
function markRow(sessionId,rowId,content,now,created){
let set=testSeen.get(rowId)
;if(!set){set=new Set();content.forEach((p,i)=>{if(!isCompletedTest(p))return;set.add(rowId+":"+i)
;if(created&&created>BOOT){testPassUntil.set(sessionId,now+3000);console.error("[oc-hook] latch(prime) tests-pass row="+rowId.slice(-6)+" idx="+i)
;if(testPassUntil.size>16){const first=testPassUntil.keys().next().value;testPassUntil.delete(first)}}})
;testSeen.set(rowId,set)
;if(testSeen.size>16){const first=testSeen.keys().next().value;testSeen.delete(first)}
;return}
;for(let i=0;i<content.length;i++){const p=content[i];if(!isCompletedTest(p))continue
;const key=rowId+":"+i;if(set.has(key))continue;set.add(key)
;testPassUntil.set(sessionId,now+3000);console.error("[oc-hook] latch(tests) tests-pass row="+rowId.slice(-6)+" idx="+i)
;if(testPassUntil.size>16){const first=testPassUntil.keys().next().value;testPassUntil.delete(first)}}}
function scanRecentRows(db,session,now){
let rows=[]
;try{rows=db.prepare("select id, time_created from session_message where session_id=? and type='assistant' order by seq desc limit 6").all(session.id)}catch(e){scanWarn("ids: "+e.message);return}
;if(!rows.length)return
;const FRESH_MS=400
;for(let k=0;k<rows.length;k++){const id=rows[k].id;const created=rows[k].time_created
;let entry=testRowCache.get(id)
;let justSuperseded=false
;if(entry&&entry.wasNewest&&k>0){justSuperseded=true;entry.wasNewest=false}
;if(!entry||justSuperseded||(k===0&&now-entry.at>FRESH_MS)){let data=null;try{data=db.prepare("select data from session_message where id=?").get(id)}catch(e){scanWarn("row: "+e.message);return}
;if(!data||!data.data)continue
;let content=[];try{const parsed=JSON.parse(data.data);content=parsed&&Array.isArray(parsed.content)?parsed.content:[]}catch{continue}
;entry={content:content,at:now,wasNewest:k===0,created:created};testRowCache.set(id,entry)
;if(testRowCache.size>12){const first=testRowCache.keys().next().value;testRowCache.delete(first)}}
else if(k===0){entry.wasNewest=true}
;if(entry)markRow(session.id,id,entry.content,now,entry.created)}}
function classify(snap,now){
const{session:session,live:live,anchorAt:anchorAt,lastType}=snap;if(!session)return{state:"idle",detail:"no session",
confident:false}
;const tpUntil=testPassUntil.get(session.id)||0;if(now<tpUntil)return{state:"tests-pass",detail:"suite passed",confident:true}
;if(live&&live.row.finish==null){const heart=now-live.row.time_updated;if(heart>STALE_MS)return{
state:"idle",detail:"abandoned turn",confident:false};const usable=live.content.filter(p=>p&&typeof p==="object")
;const part=usable.length?shape(usable[usable.length-1]):null;if(!part){return{state:"thinking",detail:"starting",
confident:false}}switch(part.type){case"reasoning":return{state:"long-think",detail:"reasoning",confident:true}
;case"text":return{state:"streaming",detail:"answering",confident:true};case"tool":{if(part.status==="error"){return{
state:TEST_CMD.test(part.cmd||"")?"tests-fail":"run-failed",detail:`${part.name||"tool"} failed`,confident:true}}
if(part.status==="completed"&&TEST_CMD.test(part.cmd||""))return{state:"tests-pass",detail:"suite passed",confident:true}
if(heart>=BLOCK_AFTER_MS&&part.status==="pending"){return{state:"blocked",
detail:"waiting for you",confident:true}}const mapped=TOOL_STATE[part.name];return{
state:part.status==="running"||part.status==="pending"?mapped||"tool-call":"thinking",detail:part.name||"tool",
confident:part.status==="running"||part.status==="pending"}}default:return{state:"tool-call",detail:part.type||"part",
confident:true}}}const finCand=takeFinish(session,live&&live.row,now,lastType);if(finCand){setHold(finCand,now,session.id);return finCand}
;const outCand=takeOutcome(session,live&&live.row);if(outCand){setHold(outCand,now,session.id);return outCand}
;const sinceAnchor=anchorAt?now-anchorAt:Infinity;const busy=session.time_busy||0,idleAt=session.time_idle||0
;const hadTerminal=!!(live&&live.row&&live.row.finish!=null&&live.row.finish!=="tool-calls")
;const beginning=lastType==="user"||!hadTerminal&&busy>idleAt&&now-(session.time_updated||0)<STALE_MS;if(beginning&&sinceAnchor<START_GRACE_MS&&sinceAnchor<45*60000){
return{state:"thinking",detail:"starting",confident:true}}const sinceEnd=sinceAnchor;if(sinceEnd<60000)return{
state:"waiting-prompt",detail:"finished",confident:true};if(sinceEnd<10*60000)return{state:"idle",detail:"resting",
confident:true};if(sinceEnd<30*60000)return{state:"sleeping",detail:"asleep",confident:true};return{state:"sleeping",
detail:"long idle",confident:true}}class Smoother{constructor(){this.current=null;this.adoptedAt=0;this.pending=null
;this.pendingSince=0;this.pendingConfident=false}push(cand,now){if(!this.current){this.adopt(cand,now)
;return this.current}if(cand.state===this.current.state){this.pending=null;return this.current}
if(this.pending!==cand.state){this.pending=cand.state;this.pendingSince=now;this.pendingConfident=cand.confident}
const waited=now-this.pendingSince;const held=now-this.adoptedAt
;if(!cand.confident&&this.current.confident)return this.current;if(waited<CONFIRM_MS)return this.current
;if(held<MIN_HOLD_MS)return this.current;const cur=WEIGHT[this.current.state]??1;const next=WEIGHT[cand.state]??1
;if(next<cur&&held<MIN_HOLD_MS*3)return this.current;this.adopt(cand,now);return this.current}adopt(cand,now){
this.current={state:cand.state,detail:cand.detail,confident:cand.confident};this.adoptedAt=now;this.pending=null}}
function sample(smoother){const stamp=dbStamp();if(!stamp){return smoother.push({state:"idle",
detail:"opencode not found",confident:false},Date.now())}let db;try{db=new DatabaseSync(DB(),{readOnly:true})
;db.exec("PRAGMA busy_timeout = 400");const session=readSession(db);if(!session){return smoother.push({state:"idle",
detail:"no sessions",confident:false},Date.now())}const live=readLiveTurn(db,session.id)
;let anchorAt=session.time_updated||0;let lastType=null;try{
const m=db.prepare(`\n        select time_updated, type from session_message\n        where session_id = ? order by seq desc limit 1\n      `).get(session.id)
;if(m){if(m.time_updated)anchorAt=Math.max(anchorAt,m.time_updated);lastType=m.type}}catch{}const now=Date.now()
;detectSupersededFinish(db,session,live,now);scanRecentRows(db,session,now);let cand=classify({
session:session,live:live,anchorAt:anchorAt,lastType},now)
;const tpUntil=testPassUntil.get(session.id)||0
;if(hold.state&&now<hold.until&&now>=tpUntil)cand={state:hold.state,detail:hold.detail,confident:true}
;const chosen=smoother.push(cand,now)
;const running=!!(live&&live.row.finish==null&&now-live.row.time_updated<STALE_MS);return{...chosen,ts:now,
thread:session.id.slice(0,8),directory:session.directory||null,mode:session.agent,model:modelLabel(session.model),turn:running?"running":"idle",
agents:readAgents(db,now).map(s=>({id:s.id.slice(0,8),title:s.title&&s.title.trim()||s.id.slice(0,6),
state:s.id===session.id?chosen.state:coarseState(s,now),
running:(s.time_busy||0)>(s.time_idle||0)&&now-s.time_updated<STALE_MS,updatedAt:s.time_updated})),source:"opencode",stale:false}}catch(err){
const cur=smoother.current;return{state:cur?cur.state:"idle",detail:cur?cur.detail:"db error",confident:false,
thread:null,directory:null,mode:null,model:null,turn:null,agents:[],source:"opencode",stale:true,error:err.message,ts:Date.now()}
}finally{try{db&&db.close()}catch{}}}

const { runWatch } = require("./core/transport");

if (process.argv.includes("--watch")) runWatch({
  tag: "[oc-hook]", port: PORT, file: OUT, pollMs: POLL_MS, sample, Smoother,
  sig: (p) => p.state + "|" + (p.detail || "") + "|"
    + (p.agents || []).map((a) => a.id + ":" + a.state).join(","),
});
