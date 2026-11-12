const CELL=64;const SLOW=2.4;const HOVER_SLOW=1.7;const GAP=22;const TAG_H=20;const DRAG_THRESHOLD=4
;const FALLBACK="idle";const api=window.pet||{getManifest:async()=>({states:{}}),setIgnoreMouse(){},dragStart(){},
dragMove(){},dragEnd(){},stateChanged(){},onState(){},resize(){}};let manifest={states:{}};const images=new Map
;const agents=new Map;let incoming=null;let overrideUntil=0;let hovered=null;let lastW=0;let lastH=0
;function imageFor(state,file){const key=state+"/"+file;let im=images.get(key);if(!im){im=new Image
;im.src=`assets/frames/${state}/${file}`;images.set(key,im)}return im}function warm(state){
const s=manifest.states[state];if(!s)return;for(const f of s.frames)imageFor(state,f)}function ensureAgent(id,title){
let a=agents.get(id);if(a){if(title&&a.title!==title){a.title=title;a.tag.textContent=title;a.tag.title=title}return a}
const cell=document.createElement("div");cell.className="cell";const tag=document.createElement("div")
;tag.className="tag";tag.textContent=title||id;const doing=document.createElement("div");doing.className="doing";tag.title=tag.textContent;const canvas=document.createElement("canvas")
;canvas.width=CELL;canvas.height=CELL;const ctx=canvas.getContext("2d",{alpha:true,willReadFrequently:true})
;ctx.imageSmoothingEnabled=false;cell.append(tag,doing,canvas);document.getElementById("row").appendChild(cell);a={id:id,
title:title,cell:cell,tag:tag,doing:doing,canvas:canvas,ctx:ctx,state:null,startedAt:0,lastDrawn:-1};agents.set(id,a);return a}
function dropAgents(keep){for(const[id,a]of agents){if(!keep.has(id)){a.cell.remove();agents.delete(id)}}}
const PHRASE={idle:"waiting",thinking:"thinking","long-think":"thinking hard",plan:"planning",
"running-cmd":"running a command","read-file":"reading a file",reading:"reading",searching:"searching",
"writing-code":"writing code","propose-diff":"proposing an edit",streaming:"answering","tool-call":"using a tool",
compacting:"compacting context","waiting-prompt":"waiting on you",sleeping:"asleep","done-flop":"done",
"pop-idea":"got it","pop-flip":"hmm",success:"success",error:"hit an error",blocked:"needs permission",
interrupted:"stopped","run-failed":"command failed","tests-pass":"tests pass","tests-fail":"tests fail",
subagent:"delegating","subagent-return":"helper is back",boba:"on boba","eating-rice":"eating rice",
"too-full-rice":"too full","too-full-boba":"too full","chonk-idle":"full of rice",sulk:"sulking","sulk-loop":"still sulking",
"sulk-end":"forgiven","boba-run":"off for boba","boba-return":"back with boba","fish-spot":"spotted something",
"fish-chase":"chasing","fish-return":"lost it","agent-spot":"spotted another","agent-follow":"following",
"agent-return":"alone again","walk-away":"wandering","wake-up":"back","doze-off":"dozing",yawn:"yawning",
"look-around":"looking around","typing-along":"you're typing","typing-away":"you left"};
function label(n){const k=n.indexOf("chonk-")===0?n.slice(6):n;return PHRASE[n]||PHRASE[k]||k.replace(/-/g," ")}
const ALIAS={blocked:"waiting-prompt"};function setState(a,name){name=ALIAS[name]||name;if(!manifest.states[name]||a.state===name)return;a.state=name;a.startedAt=performance.now();if(a.doing)a.doing.textContent=label(name)
;a.lastDrawn=-1;warm(name);api.stateChanged(name)}let layoutQueued=false;function queueLayout(){if(layoutQueued)return
;layoutQueued=true;requestAnimationFrame(()=>{layoutQueued=false
;const r=document.getElementById("row").getBoundingClientRect();const w=Math.ceil(r.width);const h=Math.ceil(r.height)
;if(w===lastW&&h===lastH)return;lastW=w;lastH=h;api.resize(w,h)})}async function boot(){manifest=await api.getManifest()
;if(!manifest||!Object.keys(manifest.states).length){console.error("no manifest loaded");return}
console.log(`manifest: ${Object.keys(manifest.states).length} states`);api.onState(s=>{if(s)incoming=s})
;const a=ensureAgent("default","dafeiyu");setState(a,FALLBACK);queueLayout();requestAnimationFrame(tick)}
function tick(t){if(incoming)applyIncoming(incoming);for(const a of agents.values()){const s=manifest.states[a.state]
;if(!s)continue;const boost=hovered===a.id?HOVER_SLOW:1;const frameMs=1000/s.fps*SLOW*boost
;const raw=Math.floor((t-a.startedAt)/frameMs)
;const idx=s.loop==="loop"?raw%s.frames.length:Math.min(raw,s.frames.length-1);if(idx===a.lastDrawn)continue
;const im=imageFor(a.state,s.frames[idx]);if(!im.complete||!im.naturalWidth)continue;a.ctx.clearRect(0,0,CELL,CELL)
;a.ctx.drawImage(im,0,0);a.lastDrawn=idx}requestAnimationFrame(tick)}function applyIncoming(snap){
const list=snap.agents&&snap.agents.length?snap.agents:[{id:snap.thread||"default",title:"dafeiyu",state:snap.state,
running:snap.turn==="running"}];const keep=new Set;const before=agents.size;list.forEach((entry,i)=>{
const id=entry.id||"agent"+i;keep.add(id);const a=ensureAgent(id,entry.title)
;a.cell.classList.toggle("working",!!entry.running)
;if(performance.now()>=overrideUntil)setState(a,entry.state||FALLBACK)})
;if(agents.size!==before||agents.size!==keep.size){dropAgents(keep);queueLayout()}}function cellAt(x,y){
for(const a of agents.values()){const r=a.canvas.getBoundingClientRect()
;if(x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom)return a}return null}function alphaAt(a,x,y){
const r=a.canvas.getBoundingClientRect();const cx=Math.floor((x-r.left)*(CELL/r.width))
;const cy=Math.floor((y-r.top)*(CELL/r.height));if(cx<0||cy<0||cx>=CELL||cy>=CELL)return false;try{
return a.ctx.getImageData(cx,cy,1,1).data[3]>0}catch{return true}}let interactive=false;let pendingOver=null
;let pendingCount=0;window.addEventListener("mousemove",e=>{if(dragging)return;const a=cellAt(e.clientX,e.clientY)
;const over=!!(a&&alphaAt(a,e.clientX,e.clientY));hovered=over&&a?a.id:null;if(over===interactive){pendingCount=0;return
}if(over!==pendingOver){pendingOver=over;pendingCount=1;return}if(++pendingCount<2)return;interactive=over
;api.setIgnoreMouse(!interactive)});window.addEventListener("mouseleave",()=>{hovered=null;if(!interactive)return
;interactive=false;api.setIgnoreMouse(true)});let dragging=false;let downAt=null;let moved=false
;window.addEventListener("mousedown",e=>{if(!interactive)return;downAt={x:e.screenX,y:e.screenY};moved=false})
;window.addEventListener("mousemove",e=>{if(!downAt)return;const dx=e.screenX-downAt.x;const dy=e.screenY-downAt.y
;if(!dragging&&Math.hypot(dx,dy)>DRAG_THRESHOLD){dragging=true;document.body.classList.add("dragging");api.dragStart()}
if(dragging){moved=true;api.dragMove(dx,dy)}});window.addEventListener("mouseup",e=>{if(dragging){dragging=false
;document.body.classList.remove("dragging");api.dragEnd()}else if(downAt&&!moved){const a=cellAt(e.clientX,e.clientY)
;if(a){const name=manifest.states["eating-rice"]?"eating-rice":"boba";const s=manifest.states[name];if(s){
overrideUntil=performance.now()+s.frames.length/s.fps*1000*SLOW+250;warm(name);setState(a,name)}}}downAt=null})
;boot().catch(err=>console.error("boot failed",err));