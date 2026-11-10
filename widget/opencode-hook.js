#!/usr/bin/env node
const fs=require("fs");const os=require("os");const path=require("path");const http=require("http")
;const{DatabaseSync:DatabaseSync}=require("node:sqlite");const POLL_MS=200;const PARTS_EVERY_MS=400;const CONFIRM_MS=350
;const MIN_HOLD_MS=550;const STALE_MS=120000;const BLOCK_AFTER_MS=45000;const START_GRACE_MS=90000
;const PORT=Number(process.env.DAFEIYU_OPENCODE_PORT||8792)
;const OUT=path.join(__dirname,"runtime","state-opencode.json")
;const dataDir=()=>process.env.XDG_DATA_HOME||(process.platform==="win32"?path.join(os.homedir(),".local","share"):path.join(os.homedir(),".local","share"))
;const DB=()=>path.join(dataDir(),"opencode","opencode.db");const WEIGHT={error:9,blocked:8,"running-cmd":6,
"tests-fail":6,"tests-pass":6,"writing-code":5,"propose-diff":5,"read-file":4,searching:4,"tool-call":4,compacting:4,
streaming:3,"long-think":3,thinking:2,"waiting-prompt":1,idle:1,sleeping:0,"chonk-idle":0};const TOOL_STATE={
bash:"running-cmd",shell:"running-cmd",terminal:"running-cmd",read:"read-file",glob:"read-file",list:"read-file",
view:"read-file",grep:"searching",rg:"searching",webfetch:"searching",websearch:"searching",write:"writing-code",
edit:"writing-code",patch:"writing-code",multiedit:"writing-code",task:"tool-call"};function dbStamp(){const db=DB()
;let stamp=0;for(const f of[db+"-wal",db]){try{stamp=Math.max(stamp,fs.statSync(f).mtimeMs)}catch{}}return stamp||null}
const partsCache={id:null,at:0,content:[]};function shape(p){return{type:p.type,name:p.name??null,
status:p.state?p.state.status:null}}function readSession(db){
return db.prepare(`\n    select id, directory, title, agent, model, time_updated,\n           time_busy, time_idle, idle_outcome\n    from session_v2\n    order by time_updated desc\n    limit 1\n  `).get()
}const MAX_AGENTS=3;const AGENT_WINDOW_MS=45*60000;function readAgents(db,now){try{
return db.prepare(`\n      select id, title, time_updated, time_busy, time_idle\n      from session_v2\n      where time_updated > ?\n      order by time_updated desc\n      limit ?\n    `).all(now-AGENT_WINDOW_MS,MAX_AGENTS)
}catch{return[]}}function coarseState(session,now){if(!session)return"idle";const busy=session.time_busy||0
;const idle=session.time_idle||0;const anchor=Math.max(busy,session.time_updated||0)
;const since=anchor?now-anchor:Infinity;if(busy>idle&&since<STALE_MS)return"thinking"
;if(since<60000)return"waiting-prompt";if(since<10*60000)return"idle";if(since<30*60000)return"sleeping"
;return"chonk-idle"}function readLiveTurn(db,sessionId){const now=Date.now();let row=null;try{
row=db.prepare(`\n      select id, time_updated, json_extract(data, '$.finish') as finish, data\n      from session_message\n      where session_id = ? and type = 'assistant'\n      order by seq desc\n      limit 1\n    `).get(sessionId)
}catch{return null}if(!row)return null;const changed=partsCache.id!==row.id||now-partsCache.at>PARTS_EVERY_MS
;if(!changed)return{row:row,content:partsCache.content};let content=[];if(row.data){try{
const parsed=JSON.parse(row.data);content=parsed&&Array.isArray(parsed.content)?parsed.content:[]}catch{
content=partsCache.content}}if(!content.length)content=partsCache.content;partsCache.id=row.id;partsCache.at=now
;partsCache.content=content;return{row:row,content:content}}function classify(snap,now){
const{session:session,live:live,anchorAt:anchorAt}=snap;if(!session)return{state:"idle",detail:"no session",
confident:false};if(live&&live.row.finish==null){const heart=now-live.row.time_updated;if(heart>STALE_MS)return{
state:"idle",detail:"abandoned turn",confident:false};const usable=live.content.filter(p=>p&&typeof p==="object")
;const part=usable.length?shape(usable[usable.length-1]):null;if(!part){return{state:"thinking",detail:"starting",
confident:false}}switch(part.type){case"reasoning":return{state:"long-think",detail:"reasoning",confident:true}
;case"text":return{state:"streaming",detail:"answering",confident:true};case"tool":{if(part.status==="error"){return{
state:"tests-fail",detail:`${part.name||"tool"} failed`,confident:true}}
if(heart>=BLOCK_AFTER_MS&&(part.status==="running"||part.status==="pending")){return{state:"blocked",
detail:"waiting for you",confident:true}}const mapped=TOOL_STATE[part.name];return{
state:part.status==="running"||part.status==="pending"?mapped||"tool-call":"thinking",detail:part.name||"tool",
confident:part.status==="running"||part.status==="pending"}}default:return{state:"tool-call",detail:part.type||"part",
confident:true}}}const sinceAnchor=anchorAt?now-anchorAt:Infinity;if(sinceAnchor<START_GRACE_MS&&sinceAnchor<45*60000){
return{state:"thinking",detail:"starting",confident:true}}const sinceEnd=sinceAnchor;if(sinceEnd<60000)return{
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
function sample(smoother){const stamp=dbStamp();if(!stamp){return smoother.push({state:"idle",
detail:"opencode not found",confident:false},Date.now())}let db;try{db=new DatabaseSync(DB(),{readOnly:true})
;db.exec("PRAGMA busy_timeout = 400");const session=readSession(db);if(!session){return smoother.push({state:"idle",
detail:"no sessions",confident:false},Date.now())}const live=readLiveTurn(db,session.id)
;let anchorAt=session.time_updated||0;try{
const m=db.prepare(`\n        select time_updated from session_message\n        where session_id = ? order by seq desc limit 1\n      `).get(session.id)
;if(m&&m.time_updated)anchorAt=Math.max(anchorAt,m.time_updated)}catch{}const now=Date.now();const cand=classify({
session:session,live:live,anchorAt:anchorAt},now);const chosen=smoother.push(cand,now)
;const running=!!(live&&live.row.finish==null&&now-live.row.time_updated<STALE_MS);return{...chosen,ts:now,
thread:session.id.slice(0,8),directory:session.directory||null,mode:session.agent,turn:running?"running":"idle",
agents:readAgents(db,now).map(s=>({id:s.id.slice(0,8),title:s.title&&s.title.trim()||s.id.slice(0,6),
state:s.id===session.id?chosen.state:coarseState(s,now),
running:(s.time_busy||0)>(s.time_idle||0)&&now-s.time_updated<STALE_MS})),source:"opencode",stale:false}}catch(err){
const cur=smoother.current;return{state:cur?cur.state:"idle",detail:cur?cur.detail:"db error",confident:false,
thread:null,directory:null,mode:null,turn:null,agents:[],source:"opencode",stale:true,error:err.message,ts:Date.now()}
}finally{try{db&&db.close()}catch{}}}function writeAtomic(file,data){fs.mkdirSync(path.dirname(file),{recursive:true})
;const tmp=file+".tmp";fs.writeFileSync(tmp,JSON.stringify(data));fs.renameSync(tmp,file)}
if(process.argv.includes("--watch")){const smoother=new Smoother;const clients=new Set;let latest=null
;let lastLogged=null;const broadcast=payload=>{const frame=`event: state\ndata: ${JSON.stringify(payload)}\n\n`
;for(const res of clients){try{res.write(frame)}catch{clients.delete(res)}}};const publish=payload=>{latest=payload
;writeAtomic(OUT,payload);broadcast(payload);if(payload.state!==lastLogged){lastLogged=payload.state
;console.log(`[oc-hook] ${String(payload.state).padEnd(14)} ${payload.detail??""}`)}}
;const server=http.createServer((req,res)=>{const cors={"Access-Control-Allow-Origin":"*","Cache-Control":"no-store"}
;if(req.url==="/state"){res.writeHead(200,{...cors,"Content-Type":"application/json"});res.end(JSON.stringify(latest??{
state:"idle",ts:Date.now()}));return}if(req.url==="/events"){res.writeHead(200,{...cors,
"Content-Type":"text/event-stream",Connection:"keep-alive"});res.write("retry: 1000\n\n")
;if(latest)res.write(`event: state\ndata: ${JSON.stringify(latest)}\n\n`);clients.add(res)
;req.on("close",()=>clients.delete(res));return}res.writeHead(404,cors)
;res.end("dafeiyu opencode hook: try /state or /events\n")})
;server.on("error",err=>console.error(`[oc-hook] HTTP ${PORT}: ${err.message}`));server.listen(PORT,"127.0.0.1",()=>{
console.log(`[oc-hook] http://127.0.0.1:${PORT}/state`)});const tick=()=>{try{publish(sample(smoother))}catch(err){
console.error("[oc-hook] tick failed:",err.message)}};tick();setInterval(tick,POLL_MS)
;console.log(`[oc-hook] watching ${DB()}`)}else{console.log(JSON.stringify(sample(new Smoother),null,2))}