#!/usr/bin/env node
const fs=require("fs");const os=require("os");const path=require("path");const http=require("http")
;const{DatabaseSync:DatabaseSync}=require("node:sqlite");const POLL_MS=200;const PARTS_EVERY_MS=300;const CONFIRM_MS=250
;const MIN_HOLD_MS=380;const STALE_MS=120000;const PORT=Number(process.env.DAFEIYU_PORT||8791)
;const OUT=path.join(process.env.DAFEIYU_RUNTIME||path.join(__dirname,"runtime"),"state.json")
;const ROOT=path.join(os.homedir(),".config","freebuff-desktop","projects");const WEIGHT={error:9,blocked:8,
"running-cmd":6,"tests-fail":6,"tests-pass":6,"writing-code":5,"propose-diff":5,"read-file":4,searching:4,"tool-call":4,
compacting:4,streaming:3,"long-think":3,thinking:2,"waiting-prompt":1,idle:1,sleeping:0,"chonk-idle":0}
;const TOOL_STATE={run_terminal_command:"running-cmd",read_files:"read-file",list_directory:"read-file",
read_url:"read-file",write_file:"writing-code",str_replace:"writing-code",web_search:"searching",
code_search:"searching",register_preview:"tool-call",preview_open:"tool-call",preview_screenshot:"tool-call",
preview_snapshot:"tool-call",preview_click:"tool-call",preview_type:"tool-call",preview_navigate:"tool-call",
preview_evaluate:"tool-call",preview_scroll:"tool-call",preview_logs:"tool-call",exit_plan:"tool-call"}
;function activeDbs(n=3){let entries;try{entries=fs.readdirSync(ROOT,{withFileTypes:true})}catch{return[]}const out=[]
;for(const e of entries){if(!e.isDirectory())continue;const db=path.join(ROOT,e.name,"desktop-v2.db")
;if(!fs.existsSync(db))continue;let stamp=0;for(const f of[db+"-wal",db]){try{
stamp=Math.max(stamp,fs.statSync(f).mtimeMs)}catch{}}out.push({db:db,project:e.name,stamp:stamp})}
out.sort((a,b)=>b.stamp-a.stamp);return out.slice(0,n)}const partsCache={at:0,threadId:null,parts:[]};function shape(p){
return{kind:p.kind,toolName:p.toolName??null,status:p.status??null,exitCode:p.exitCode??null}}function readThread(db){
return db.prepare(`\n    select id, title, turn_state, agent_mode, attention_reason, last_turn_outcome,\n           turn_alive_at, last_turn_finished_at\n    from threads\n    order by updated_at desc\n    limit 1\n  `).get()
}const MAX_AGENTS=3;const AGENT_WINDOW_MS=45*60000;function readAgents(db,now){let rows=[];try{
rows=db.prepare(`\n      select id, title, turn_state, agent_mode, last_turn_outcome,\n             turn_alive_at, last_turn_finished_at\n      from threads\n      where updated_at > ?\n      order by turn_state = 'running' desc, updated_at desc\n      limit ?\n    `).all(now-AGENT_WINDOW_MS,MAX_AGENTS)
}catch{}if(!rows.length){try{
const t=db.prepare(`\n        select id, title, turn_state, agent_mode, last_turn_outcome,\n               turn_alive_at, last_turn_finished_at\n        from threads order by updated_at desc limit 1\n      `).get()
;if(t)rows=[t]}catch{}}return rows}function coarseState(thread,now){if(!thread)return"idle"
;if(thread.turn_state==="running")return"thinking";if(thread.last_turn_outcome==="failed")return"error"
;const since=thread.last_turn_finished_at?now-thread.last_turn_finished_at:Infinity
;if(since<60000)return"waiting-prompt";if(since<10*60000)return"idle";if(since<30*60000)return"sleeping"
;return"chonk-idle"}function readLiveParts(db,threadId){const now=Date.now();const same=partsCache.threadId===threadId
;if(same&&now-partsCache.at<PARTS_EVERY_MS)return partsCache.parts;let raw=null;try{
const row=db.prepare(`\n      select json_extract(harness_state, '$.runtimeMove.parts') as parts,\n             json_extract(harness_state, '$.runtimeMove.output.type') as outType\n      from threads where id = ?\n    `).get(threadId)
;raw=row?{parts:row.parts,outType:row.outType}:null}catch{}let parts=partsCache.parts;let outType=null;if(raw){try{
parts=raw.parts?JSON.parse(raw.parts):[]}catch{parts=partsCache.parts}outType=raw.outType??null}partsCache.at=now
;partsCache.threadId=threadId;partsCache.parts=parts;partsCache.outType=outType;return parts}
function readStoredPart(db,threadId){try{
const msg=db.prepare(`\n      select parts_json from messages where thread_id = ? order by seq desc limit 1\n    `).get(threadId)
;if(!msg)return null;const parts=JSON.parse(msg.parts_json).filter(p=>p&&typeof p==="object"&&p.kind!=="ad")
;return parts.length?shape(parts[parts.length-1]):null}catch{return null}}function classify(snap,now){
const{thread:thread,part:part,outType:outType,queueRunning:queueRunning,toolLive:toolLive}=snap;if(!thread)return{
state:"idle",detail:"no session",confident:false};const alive=thread.turn_alive_at?now-thread.turn_alive_at:Infinity
;if(thread.turn_state==="running"){if(alive>STALE_MS&&!toolLive){return{state:"idle",detail:"abandoned turn",
confident:false}}if(outType==="error")return{state:"error",detail:"turn failed",confident:true};if(!part){return{
state:"thinking",detail:"starting",confident:false}}switch(part.kind){case"reasoning":return{state:"long-think",
detail:"reasoning",confident:true};case"text":return{state:"streaming",detail:"answering",confident:true};case"changes":
return{state:"propose-diff",detail:"editing files",confident:true};case"compaction":return{state:"compacting",
detail:"compacting context",confident:true};case"agent":return{state:"tool-call",detail:"subagent",confident:true}
;case"tool":{if(part.status==="failure"||typeof part.exitCode==="number"&&part.exitCode!==0){return{state:"tests-fail",
detail:`${part.toolName||"tool"} failed`,confident:true}}const mapped=TOOL_STATE[part.toolName];return{
state:mapped||"tool-call",detail:part.toolName||"tool",confident:true}}default:return{state:"tool-call",
detail:part.kind||"tool",confident:true}}}if(thread.last_turn_outcome==="failed"){return{state:"error",
detail:"turn failed",confident:true}}if(queueRunning){return{state:"running-cmd",detail:"queue running",confident:true}}
const sinceEnd=thread.last_turn_finished_at?now-thread.last_turn_finished_at:Infinity;if(sinceEnd<60000)return{
state:"waiting-prompt",detail:"finished",confident:true};if(sinceEnd<10*60000)return{state:"idle",detail:"resting",
confident:true};if(sinceEnd<30*60000)return{state:"sleeping",detail:"asleep",confident:true};return{state:"chonk-idle",
detail:"long idle",confident:true}}class Smoother{constructor(){this.current=null;this.adoptedAt=0;this.pending=null
;this.pendingSince=0;this.pendingConfident=false}push(cand,now){if(!this.current){this.adopt(cand,now)
;return this.current}if(cand.state===this.current.state){this.pending=null;return this.current}
if(this.pending!==cand.state){this.pending=cand.state;this.pendingSince=now;this.pendingConfident=cand.confident}
const waited=now-this.pendingSince;const held=now-this.adoptedAt
;if(!cand.confident&&this.current.confident)return this.current;if(waited<CONFIRM_MS)return this.current
;if(held<MIN_HOLD_MS)return this.current;const cur=WEIGHT[this.current.state]??1;const next=WEIGHT[cand.state]??1
;if(next<cur&&held<MIN_HOLD_MS*3)return this.current;this.adopt(cand,now);return this.current}adopt(cand,now){
this.current={state:cand.state,detail:cand.detail,confident:cand.confident};this.adoptedAt=now;this.pending=null}}
function sample(smoother){const candidates=activeDbs(3);if(!candidates.length){return smoother.push({state:"idle",
detail:"freebuff not found",confident:false},Date.now())}let db=null;let thread=null;let bestScore=-1;const pool=[]
;const now0=Date.now();for(const c of candidates){let handle=null;try{handle=new DatabaseSync(c.db,{readOnly:true})
;handle.exec("PRAGMA busy_timeout = 400");const t=readThread(handle);if(!t){handle.close();continue}let toolLive=false
;if(t.turn_state==="running"){const live=readLiveParts(handle,t.id).filter(p=>p&&typeof p==="object"&&p.kind!=="ad")
;const last=live.length?shape(live[live.length-1]):null
;toolLive=!!(last&&last.kind==="tool"&&(last.status==="running"||last.status==="pending"||last.status==null))}
const aliveAge=t.turn_alive_at?now0-t.turn_alive_at:Infinity
;const fresh=t.turn_state==="running"&&(aliveAge<STALE_MS||toolLive);const score=(fresh?1e15:0)+(t.updated_at||0)
;pool.push({t:t,fresh:fresh,score:score});if(score>bestScore){if(db){try{db.close()}catch{}}db=handle;thread=t
;bestScore=score}else{handle.close()}}catch{try{handle&&handle.close()}catch{}}}if(!db||!thread){return smoother.push({
state:"idle",detail:"no threads",confident:false},Date.now())}try{let part=null;let outType=null;let toolLive=false
;if(thread.turn_state==="running"){const live=readLiveParts(db,thread.id);outType=partsCache.outType??null
;const usable=live.filter(p=>p&&typeof p==="object"&&p.kind!=="ad");if(usable.length){
part=shape(usable[usable.length-1])
;toolLive=part.kind==="tool"&&(part.status==="running"||part.status==="pending"||part.status==null)}}else{
partsCache.at=0;partsCache.threadId=null;partsCache.parts=[];part=readStoredPart(db,thread.id)}let queueRunning=false
;try{
const q=db.prepare(`\n        select count(*) c from queue_items where thread_id = ? and state = 'running'\n      `).get(thread.id)
;queueRunning=!!(q&&q.c)}catch{}const now=Date.now();const cand=classify({thread:thread,part:part,outType:outType,
queueRunning:queueRunning,toolLive:toolLive},now);const chosen=smoother.push(cand,now);return{...chosen,
thread:thread.id.slice(0,8),mode:thread.agent_mode,turn:thread.turn_state,ts:now,
agents:(pool.length?pool.sort((a,b)=>b.score-a.score).slice(0,MAX_AGENTS):[{t:thread,
fresh:thread.turn_state==="running",score:0}]).map(({t:t,fresh:fresh})=>({id:t.id.slice(0,8),
title:t.title&&t.title.trim()||t.id.slice(0,6),state:t.id===thread.id?chosen.state:coarseState(t,now),running:!!fresh
})),source:"sqlite",stale:false}}catch(err){const cur=smoother.current;return{state:cur?cur.state:"idle",
detail:cur?cur.detail:"db error",confident:false,thread:null,mode:null,turn:null,agents:[],source:"sqlite",stale:true,
ts:Date.now(),error:err.message}}finally{try{db&&db.close()}catch{}}}function writeAtomic(file,data){
fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+".tmp";fs.writeFileSync(tmp,JSON.stringify(data))
;try{fs.renameSync(tmp,file)}catch(err){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);fs.renameSync(tmp,file)}}if(process.argv.includes("--watch")){const smoother=new Smoother;const clients=new Set
;let latest=null;let lastLogged=null;const broadcast=payload=>{
const frame=`event: state\ndata: ${JSON.stringify(payload)}\n\n`;for(const res of clients){try{res.write(frame)}catch{
clients.delete(res)}}};let lastWriteWarn=0;let lastSig=null,lastWrite=0;const publish=payload=>{latest=payload;broadcast(payload)
;const sig=payload.state+"|"+(payload.detail||"")+"|"+(payload.turn||"")+"|"+(payload.mode||"")+"|"+(payload.agents||[]).map(a=>a.id+":"+a.state+":"+(a.running?1:0)).join(",");const n=Date.now()
;if(sig!==lastSig||n-lastWrite>3000){lastSig=sig;lastWrite=n
;try{writeAtomic(OUT,payload)}catch(err){if(n-lastWriteWarn>30000){lastWriteWarn=n
;console.error(`[hook] state file busy (${err.message})`)}}}
;if(payload.state!==lastLogged){lastLogged=payload.state
;console.log(`[hook] ${String(payload.state).padEnd(14)} ${payload.detail??""}`)}}
;function corsFor(req){const o=req.headers.origin;const ok=typeof o==="string"&&/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);const h={"Cache-Control":"no-store"};if(ok){h["Access-Control-Allow-Origin"]=o;h.Vary="Origin"}return h};const server=http.createServer((req,res)=>{const cors=corsFor(req)
;if(req.url==="/state"){res.writeHead(200,{...cors,"Content-Type":"application/json"});res.end(JSON.stringify(latest??{
state:"idle",ts:Date.now()}));return}if(req.url==="/events"){res.writeHead(200,{...cors,
"Content-Type":"text/event-stream",Connection:"keep-alive"});res.write("retry: 1000\n\n")
;if(latest)res.write(`event: state\ndata: ${JSON.stringify(latest)}\n\n`);clients.add(res)
;req.on("close",()=>clients.delete(res));return}res.writeHead(404,cors);res.end("dafeiyu hook: try /state or /events\n")
});server.on("error",err=>console.error(`[hook] HTTP ${PORT}: ${err.message}`));server.listen(PORT,"127.0.0.1",()=>{
console.log(`[hook] http://127.0.0.1:${PORT}/state`)});const tick=()=>{try{publish(sample(smoother))}catch(err){
console.error("[hook] tick failed:",err.message)}};tick();setInterval(tick,POLL_MS)
;console.log(`[hook] watching ${ROOT}`)}else{console.log(JSON.stringify(sample(new Smoother),null,2))}