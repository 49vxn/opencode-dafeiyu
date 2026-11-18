const CELL=64;const SLOW=2.4;const HOVER_SLOW=1.7;const GAP=22;const TAG_H=20;const DRAG_THRESHOLD=4
;const FALLBACK="idle";const api=window.pet||{getManifest:async()=>({states:{}}),setIgnoreMouse(){},dragStart(){},
dragMove(){},dragEnd(){},stateChanged(){},onState(){},resize(){}};let manifest={states:{}};const images=new Map
;const agents=new Map;let incoming=null;;const lastActive=new Map;const departed=new Set;const leaving=new Map;let DEPART_MS=600000
;const IDLE_STATES=new Set(["idle","idle-left","idle-right","waiting-prompt","sleeping","doze-off","boba","chonk-idle","look-around","yawn","sulk","sulk-loop","fish-spot","fish-chase","fish-return","boba-run","boba-return","walk-away","chonk-walk-away"])
;function holdOnce(a){const s=manifest.states[a.state];return !!s&&s.loop!=="loop"&&!a.finished}
;function resolve(a,name){if(!a.fed||name.indexOf("chonk-")===0)return name;const twin="chonk-"+name;return manifest.states[twin]?twin:name}
;function onClipDone(a){if(a.state==="eating-rice"){a.fed=true;a.fedAt=Date.now();setState(a,"chonk-idle")}
else if(a.state==="too-full-rice"||a.state==="too-full-boba"){setState(a,"chonk-idle")}
else if(a.state==="slim-down"){a.fed=false;setState(a,"idle")}}
;function clipMs(name){const s=manifest.states[name];return s?Math.round(s.frames.length/s.fps*1000*SLOW):1200}let overrideUntil=0;let hovered=null;let lastW=0;let lastH=0;let viewW=0;let viewH=0
;function imageFor(state,file){const key=state+"/"+file;let im=images.get(key);if(!im){im=new Image
;im.src=`assets/frames/${state}/${file}`;images.set(key,im)}return im}function warm(state){
const s=manifest.states[state];if(!s)return;for(const f of s.frames)imageFor(state,f)}function ensureAgent(id,title){
let a=agents.get(id);if(a){if(title&&a.title!==title){a.title=title;a.tag.textContent=title;a.tag.title=title}return a}
const cell=document.createElement("div");cell.className="cell";const tag=document.createElement("div")
;tag.className="tag";tag.textContent=title||id;const doing=document.createElement("div");doing.className="doing";tag.title=tag.textContent;const canvas=document.createElement("canvas")
;canvas.width=CELL;canvas.height=CELL;const ctx=canvas.getContext("2d",{alpha:true,willReadFrequently:true})
;ctx.imageSmoothingEnabled=false;cell.append(tag,doing,canvas);document.getElementById("row").appendChild(cell);a={id:id,
title:title,cell:cell,tag:tag,doing:doing,canvas:canvas,ctx:ctx,state:null,startedAt:0,lastDrawn:-1,fed:false,fedAt:0,finished:false};agents.set(id,a);return a}
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
const ALIAS={blocked:"waiting-prompt"};function setState(a,name){name=ALIAS[name]||name;name=resolve(a,name);a.finished=false;if(!manifest.states[name]||a.state===name)return;a.state=name;a.startedAt=performance.now();if(a.doing)a.doing.textContent=label(name)
;a.lastDrawn=-1;if(a.cell)a.cell.dataset.state=name;warm(name);api.stateChanged(name)}let layoutQueued=false;function queueLayout(){if(layoutQueued)return
;layoutQueued=true;requestAnimationFrame(()=>{layoutQueued=false
;const r=document.getElementById("row").getBoundingClientRect();const w=Math.ceil(r.width);const h=Math.ceil(r.height)
;if(menuOpen||w===lastW&&h===lastH)return;lastW=w;lastH=h;sendSize(w,h)})}async function boot(){manifest=await api.getManifest()
;if(!manifest||!Object.keys(manifest.states).length){console.error("no manifest loaded");return}
console.log(`manifest: ${Object.keys(manifest.states).length} states`);DEPART_MS=manifest.departMs||600000;api.onState(s=>{if(s)incoming=s})
;buildMenu();api.getAccessories().then(m=>{if(m&&typeof m==="object"){Object.assign(manualAcc,m);computeWorn()}}).catch(()=>{})
;const a=ensureAgent("default","dafeiyu");setState(a,FALLBACK);queueLayout();requestAnimationFrame(tick)}
function tick(t){if(incoming)applyIncoming(incoming);
const now=performance.now();const wall=Date.now()
;for(const[id,a]of agents){
if(leaving.has(id)){if(now>=leaving.get(id)){a.cell.remove();agents.delete(id);departed.add(id);leaving.delete(id);queueLayout()}continue}
const last=lastActive.get(id)||0
;if(wall-last>DEPART_MS){setState(a,"walk-away");leaving.set(id,now+clipMs("walk-away"));continue}}
for(const a of agents.values()){const s=manifest.states[a.state]
;if(!s)continue;const boost=hovered===a.id?HOVER_SLOW:1;const frameMs=1000/s.fps*SLOW*boost
;const raw=Math.floor((t-a.startedAt)/frameMs)
;const idx=s.loop==="loop"?raw%s.frames.length:Math.min(raw,s.frames.length-1)
;if(s.loop!=="loop"&&raw>=s.frames.length&&!a.finished){a.finished=true;onClipDone(a);continue}
;if(a.fed&&a.fedAt&&wall-a.fedAt>300000){a.fed=false;a.fedAt=0;setState(a,"slim-down");continue}if(idx===a.lastDrawn)continue
;const im=imageFor(a.state,s.frames[idx]);if(!im.complete||!im.naturalWidth)continue;a.ctx.clearRect(0,0,CELL,CELL)
;a.ctx.drawImage(im,0,0);if(wornAcc&&wornAgents.has(a.id)){const am=accImg(wornAcc)
;if(am.complete&&am.naturalWidth)a.ctx.drawImage(am,0,0)}a.lastDrawn=idx}requestAnimationFrame(tick)}function applyIncoming(snap){
const list=snap.agents&&snap.agents.length?snap.agents:[{id:snap.thread||"default",title:"dafeiyu",state:snap.state,
running:snap.turn==="running"}];const keep=new Set;const before=agents.size;list.forEach((entry,i)=>{
const id=entry.id||"agent"+i;const st=entry.state||FALLBACK
;const active=!!entry.running||!IDLE_STATES.has(st);const now=performance.now();const wall=Date.now();let wake=false
;if(active){lastActive.set(id,wall);if(departed.has(id)){departed.delete(id);wake=true}}else if(departed.has(id))return
;keep.add(id);const a=ensureAgent(id,entry.title)
;const seen=entry.updatedAt&&entry.updatedAt>0?Math.min(entry.updatedAt,wall):wall
;if(!lastActive.has(id))lastActive.set(id,seen)
;a.cell.classList.toggle("working",!!entry.running)
;if(now>=overrideUntil&&!holdOnce(a))setState(a,wake?"wake-up":(entry.state||FALLBACK))});syncAuto(snap)
;if(agents.size!==before||agents.size!==keep.size){dropAgents(keep);queueLayout()}}function cellAt(x,y){
for(const a of agents.values()){const r=a.canvas.getBoundingClientRect()
;if(x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom)return a}return null}function alphaAt(a,x,y){
const r=a.canvas.getBoundingClientRect();const cx=Math.floor((x-r.left)*(CELL/r.width))
;const cy=Math.floor((y-r.top)*(CELL/r.height));if(cx<0||cy<0||cx>=CELL||cy>=CELL)return false;try{
return a.ctx.getImageData(cx,cy,1,1).data[3]>0}catch{return true}}let interactive=false;let pendingOver=null
;let pendingCount=0;window.addEventListener("mousemove",e=>{if(dragging||menuOpen)return;const a=cellAt(e.clientX,e.clientY)
;const over=!!(a&&alphaAt(a,e.clientX,e.clientY));hovered=over&&a?a.id:null;if(over===interactive){pendingCount=0;return
}if(over!==pendingOver){pendingOver=over;pendingCount=1;return}if(++pendingCount<2)return;interactive=over
;api.setIgnoreMouse(!interactive)});window.addEventListener("mouseleave",()=>{hovered=null;if(!interactive)return
;interactive=false;api.setIgnoreMouse(true)});let dragging=false;let downAt=null;let moved=false
;window.addEventListener("mousedown",e=>{if(menuOpen){if(!menu.contains(e.target))closeMenu();return}
;if(!interactive||e.button!==0)return;downAt={x:e.screenX,y:e.screenY};moved=false})
;window.addEventListener("mousemove",e=>{if(!downAt)return;const dx=e.screenX-downAt.x;const dy=e.screenY-downAt.y
;if(!dragging&&Math.hypot(dx,dy)>DRAG_THRESHOLD){dragging=true;document.body.classList.add("dragging");api.dragStart()}
if(dragging){moved=true;api.dragMove(dx,dy)}});window.addEventListener("mouseup",e=>{if(dragging){dragging=false
;document.body.classList.remove("dragging");api.dragEnd()}else if(e.button===0&&downAt&&!moved){const a=cellAt(e.clientX,e.clientY);feedAgent(a)}downAt=null})
// ---------- accessories (64x64 overlay PNGs composited over state frames) ----------
// manualAcc[id]: "on"/"off" = explicit user choice (persisted, overrides auto);
// absent = automatic. Automatic fires when accessory.auto regex matches the
// winning session's model (payload.model). One accessory worn at a time.
const manualAcc={};const autoAcc=new Set;const wornAgents=new Set;let wornAcc=null;const accImgs=new Map
;function accImg(acc){let im=accImgs.get(acc.id);if(!im){im=new Image;im.src=acc.src;accImgs.set(acc.id,im)}return im}
function computeWorn(){let next=null
;for(const acc of manifest.accessories||[]){const on=manualAcc[acc.id]!==undefined?manualAcc[acc.id]==="on":autoAcc.has(acc.id)
;if(on){next=acc;break}}
if(!next!==!wornAcc||next&&wornAcc&&next.id!==wornAcc.id){wornAcc=next;if(wornAcc)accImg(wornAcc)}else wornAcc=next}
function syncAuto(snap){autoAcc.clear()
;for(const acc of manifest.accessories||[]){if(!acc.auto)continue
;try{if(new RegExp(acc.auto,"i").test(snap.model||""))autoAcc.add(acc.id)}catch{}}
;wornAgents.clear();const t=snap.thread||"default";let have=false
;for(const id of agents.keys())if(id===t)have=true
;if(have)wornAgents.add(t);else for(const id of agents.keys())wornAgents.add(id)
;computeWorn()}
// ---------- right-click menu (ocean gradient, styled in index.html) ----------
function feedAgent(a){if(!a)return;const name=a.fed?(manifest.states["too-full-rice"]?"too-full-rice":"boba"):(manifest.states["eating-rice"]?"eating-rice":"boba");const s=manifest.states[name];if(!s)return
;overrideUntil=performance.now()+s.frames.length/s.fps*1000*SLOW+250;warm(name);setState(a,name)}
let menu=null;let menuOpen=false;let menuSub=false;let menuX=0;let menuY=0;let menuAgent=null;let goAwayTimer=null
;function sendSize(w,h){viewW=w;viewH=h;api.resize(w,h)}
function buildMenu(){menu=document.createElement("div");menu.id="menu";menu.hidden=true;document.body.appendChild(menu)}
function mi(label,fn,extra){const el=document.createElement("div");el.className="mi"+(extra?" "+extra:"")
;el.textContent=label;el.onclick=ev=>{ev.stopPropagation();fn&&fn()};return el}
function renderMenu(){if(!menu)return;menu.textContent=""
;menu.append(mi("Go away",goAway),mi("Feed",menuFeed),mi("Accessories ▸",toggleSub))
;if(!menuSub)return;const sep=document.createElement("div");sep.className="mi-sep";menu.append(sep)
;for(const acc of manifest.accessories||[]){const mode=manualAcc[acc.id]!==undefined?manualAcc[acc.id]:"auto"
;const worn=manualAcc[acc.id]!==undefined?manualAcc[acc.id]==="on":autoAcc.has(acc.id)
;menu.append(mi(acc.name+" "+(worn?"✓":"·")+" "+mode,()=>cycleAcc(acc)))}
;if(manifest.accessories&&manifest.accessories.length)menu.append(mi("automatic",clearManual,"sub"))}
function cycleAcc(acc){const cur=manualAcc[acc.id]
;if(cur===undefined)manualAcc[acc.id]="on";else if(cur==="on")manualAcc[acc.id]="off";else delete manualAcc[acc.id]
;api.setAccessories({...manualAcc});computeWorn();if(wornAcc)accImg(wornAcc);renderMenu();fitMenu()}
function clearManual(){for(const k of Object.keys(manualAcc))delete manualAcc[k]
;api.setAccessories({});computeWorn();renderMenu();fitMenu()}
function fitMenu(){const mw=menu.offsetWidth,mh=menu.offsetHeight
;if(mw+12>viewW||mh+12>viewH)sendSize(Math.max(viewW,mw+12),Math.max(viewH,mh+12))
;menuX=Math.max(4,Math.min(menuX,viewW-mw-6));menuY=Math.max(4,Math.min(menuY,viewH-mh-6))
;menu.style.left=menuX+"px";menu.style.top=menuY+"px"}
function toggleSub(){menuSub=!menuSub;renderMenu();fitMenu()}
function menuFeed(){const a=menuAgent||agents.values().next().value;closeMenu();feedAgent(a)}
function goAway(){closeMenu();const a=menuAgent||agents.values().next().value
;if(!a||!manifest.states["walk-away"]){api.hidePet();return}
;overrideUntil=performance.now()+clipMs("walk-away");warm("walk-away");setState(a,"walk-away")
;goAwayTimer=setTimeout(()=>{goAwayTimer=null;api.hidePet()},clipMs("walk-away"))}
function openMenu(x,y){if(!manifest.accessories||!manifest.accessories.length)return
;menuAgent=cellAt(x,y);menuX=x;menuY=y;menuSub=false;renderMenu();menu.hidden=false;menuOpen=true
;fitMenu();api.setIgnoreMouse(false)}
function closeMenu(){if(!menuOpen)return;menuOpen=false;menuSub=false;menu.hidden=true
;if(goAwayTimer){clearTimeout(goAwayTimer);goAwayTimer=null}
;sendSize(lastW,lastH);api.setIgnoreMouse(!interactive)}
window.addEventListener("contextmenu",e=>{e.preventDefault();if(!interactive)return
;if(menuOpen){closeMenu();return}openMenu(e.clientX,e.clientY)})
window.addEventListener("keydown",e=>{if(e.key==="Escape")closeMenu()})
;boot().catch(err=>console.error("boot failed",err));