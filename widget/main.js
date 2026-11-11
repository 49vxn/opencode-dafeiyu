const{app:app,BrowserWindow:BrowserWindow,ipcMain:ipcMain,Tray:Tray,Menu:Menu,globalShortcut:globalShortcut,screen:screen,powerSaveBlocker:powerSaveBlocker,nativeImage:nativeImage}=require("electron")
;const path=require("path");const fs=require("fs");const os=require("os");const{spawn:spawn}=require("child_process")
;if(!app.requestSingleInstanceLock()){app.quit();process.exit(0)}const SCALE=2;const CELL=64;const SIZE=CELL*SCALE
;const DRAG_THRESHOLD=4;if(process.env.DFY_GPU!=="1")app.disableHardwareAcceleration()
;app.commandLine.appendSwitch("disable-renderer-backgrounding")
;app.commandLine.appendSwitch("disable-background-timer-throttling")
;app.commandLine.appendSwitch("disable-backgrounding-occluded-windows")
;app.commandLine.appendSwitch("disable-features","CalculateNativeWinOcclusion")
;const MANIFEST=JSON.parse(fs.readFileSync(path.join(__dirname,"assets","sprites.json"),"utf8"))
;ipcMain.handle("get-manifest",()=>MANIFEST);let win=null;let tray=null;let psb=null;let ignoreMouse=true
;let dragOrigin=null;const stateFile=()=>path.join(app.getPath("userData"),"position.json");function loadPosition(){try{
const p=JSON.parse(fs.readFileSync(stateFile(),"utf8"));if(typeof p.x==="number"&&typeof p.y==="number")return p}catch{}
const wa=screen.getPrimaryDisplay().workArea;return{x:wa.x+wa.width-SIZE-24,y:wa.y+wa.height-SIZE-24}}
function insideAnyDisplay(x,y){return screen.getAllDisplays().some(d=>{const b=d.workArea
;return x>=b.x-SIZE&&x<=b.x+b.width&&y>=b.y-SIZE&&y<=b.y+b.height})}function clampToWorkArea(x,y){
const d=screen.getDisplayNearestPoint({x:x+SIZE/2,y:y+SIZE/2});const b=d.workArea;return{
x:Math.round(Math.min(Math.max(x,b.x),b.x+b.width-SIZE)),y:Math.round(Math.min(Math.max(y,b.y),b.y+b.height-SIZE))}}
function savePosition(){if(!win)return;const[x,y]=win.getPosition();fs.writeFileSync(stateFile(),JSON.stringify({x:x,y:y
}))}function setClickThrough(next){ignoreMouse=next;if(win&&!win.isDestroyed()){win.setIgnoreMouseEvents(ignoreMouse,{
forward:true})}refreshTray()}function refreshTray(){if(!tray)return;tray.setContextMenu(Menu.buildFromTemplate([{
label:"dafeiyu",enabled:false},{type:"separator"},{label:"Click-through",type:"checkbox",checked:ignoreMouse,
click:()=>setClickThrough(!ignoreMouse)},{label:"Reset position",click:resetPosition},{type:"separator"},{label:"Quit",
click:()=>{app.isQuitting=true;app.quit()}}]))}function resetPosition(){const wa=screen.getPrimaryDisplay().workArea
;if(!win)return;win.setPosition(wa.x+wa.width-SIZE-24,wa.y+wa.height-SIZE-24);savePosition()}function createWindow(){
let pos=loadPosition();if(!insideAnyDisplay(pos.x,pos.y))pos=loadPosition();const p=clampToWorkArea(pos.x,pos.y)
;const opaque=process.env.DFY_OPAQUE==="1";win=new BrowserWindow({width:SIZE,height:SIZE,x:p.x,y:p.y,frame:false,
transparent:!opaque,backgroundColor:opaque?"#0f1226":"#00000000",hasShadow:false,roundedCorners:false,thickFrame:false,
resizable:false,maximizable:false,minimizable:false,fullscreenable:false,alwaysOnTop:true,skipTaskbar:true,
focusable:false,show:false,webPreferences:{preload:path.join(__dirname,"preload.js"),contextIsolation:true,
nodeIntegration:false,backgroundThrottling:false}});win.setAlwaysOnTop(true,"screen-saver")
;win.loadFile(path.join(__dirname,"index.html"));win.webContents.on("console-message",(...args)=>{
const msg=args[1]&&typeof args[1]==="object"?args[1].message:typeof args[2]==="string"?args[2]:String(args[1])
;console.log("[renderer]",msg)});win.webContents.on("preload-error",(_e,p,err)=>{
console.error("[preload-error]",p,err&&err.message)});win.once("ready-to-show",()=>{win.showInactive()
;setClickThrough(true)});win.webContents.on("did-finish-load",()=>{
if(win&&!win.isDestroyed())win.setIgnoreMouseEvents(ignoreMouse,{forward:true});lastPushed=null})
;win.webContents.on("render-process-gone",()=>{if(win&&!win.isDestroyed())win.reload()})
;app.on("child-process-gone",(_e,details)=>{if(details.type==="GPU"&&win&&!win.isDestroyed()){
console.warn("[dafeiyu] GPU process gone — recreating window");const[x,y]=win.getPosition();win.destroy();win=null
;createWindow();if(win)win.setPosition(x,y)}});win.on("moved",savePosition)}
const STATE_FILE=path.join(__dirname,"runtime","state.json")
;const OC_STATE_FILE=path.join(__dirname,"runtime","state-opencode.json");const CL_STATE_FILE=path.join(__dirname,"runtime","state-claude.json");let lastPushed=null;let lastSource=null
;const ACTIVE_STATES=new Set(["thinking","long-think","streaming","running-cmd","read-file","writing-code","searching","propose-diff","compacting","tool-call","tests-fail","blocked","error"])
;function readPayload(file){try{const s=JSON.parse(fs.readFileSync(file,"utf8"));if(!s||!s.state)return null
;if(typeof s.ts!=="number"){try{s.ts=fs.statSync(file).mtimeMs}catch{}}return s}catch{return null}}
function pickPayload(){const fb=readPayload(STATE_FILE);const oc=readPayload(OC_STATE_FILE);const cl=readPayload(CL_STATE_FILE);const fresh=p=>p&&typeof p.ts==="number"&&Date.now()-p.ts<15000;const available=p=>p&&!/not found/i.test(p.detail||"");const busy=p=>fresh(p)&&(p.turn==="running"||ACTIVE_STATES.has(p.state));if(busy(fb))return fb;const side=[oc,cl].filter(busy).sort((a,b)=>b.ts-a.ts)[0];if(side)return side;if(available(fb))return fb;const idleSide=[oc,cl].filter(available).sort((a,b)=>b.ts-a.ts)[0];if(idleSide)return idleSide;return fb||oc||cl}function watchStateFile(){const push=()=>{if(!win||win.isDestroyed())return;const s=pickPayload()
;if(!s)return
;const sig=[s.source,s.state,(s.agents||[]).map(a=>a.id+":"+a.state+":"+(a.running?1:0)).join(",")].join("|")
;if(sig===lastPushed)return;lastPushed=sig;if(s.source!==lastSource){lastSource=s.source
;console.log(`[feed] source -> ${s.source}`)}win.webContents.send("pet-state",s)}
;for(const f of[STATE_FILE,OC_STATE_FILE,CL_STATE_FILE]){try{fs.watch(f,{persistent:false},push)}catch{}}setInterval(push,500)}
function createTray(){const iconPath=path.join(__dirname,"assets","frames","idle","idle-00.png")
;const img=nativeImage.createFromPath(iconPath).resize({width:16,height:16});tray=new Tray(img)
;tray.setToolTip("dafeiyu");refreshTray()}let hookProcs=[];const hookRestarts={};function spawnHook(hookPath){
const name=path.basename(hookPath);try{const lp=path.join(__dirname,"runtime",name+".log");try{fs.mkdirSync(path.dirname(lp),{recursive:true})}catch{}const out=fs.openSync(lp,"a");const proc=spawn(process.execPath,[hookPath,"--watch"],{env:{...process.env,
ELECTRON_RUN_AS_NODE:"1"},stdio:["ignore",out,out],windowsHide:true});proc.on("exit",code=>{
console.log(`[hook] ${name} exited (${code}) — restarting in 3s`);hookProcs=hookProcs.filter(p=>p!==proc);hookRestarts[name]=(hookRestarts[name]||0)+1
;setTimeout(()=>spawnHook(hookPath),Math.min(30000,3000*Math.pow(2,Math.min(hookRestarts[name]-1,4))))});hookProcs.push(proc);proc.on("spawn",()=>{hookRestarts[name]=0});console.log(`[hook] started ${name}`)}catch(err){
console.error(`[hook] ${name} failed to start:`,err.message)}}function opencodeDbExists(){
if(process.env.DAFEIYU_OPENCODE_HOOK==="1")return true
;const dataDir=process.env.XDG_DATA_HOME||path.join(os.homedir(),".local","share")
;return fs.existsSync(path.join(dataDir,"opencode","opencode.db"))}function claudeDirExists(){if(process.env.DAFEIYU_CLAUDE_HOOK==="1")return true;return fs.existsSync(path.join(os.homedir(),".claude"))}function startHook(){
const freebuffHook=path.join(__dirname,"freebuff-hook.js");if(fs.existsSync(freebuffHook))spawnHook(freebuffHook)
;const opencodeHook=path.join(__dirname,"opencode-hook.js")
;if(fs.existsSync(opencodeHook)&&opencodeDbExists())spawnHook(opencodeHook)
;const claudeHook=path.join(__dirname,"claude-hook.js");if(fs.existsSync(claudeHook)&&claudeDirExists())spawnHook(claudeHook)}app.on("second-instance",()=>{
if(win&&!win.isDestroyed()){win.showInactive();win.setAlwaysOnTop(true,"screen-saver");resetPosition()}})
;app.whenReady().then(()=>{startHook();createWindow();createTray();watchStateFile()
;
;;app.on("activate",()=>{
if(BrowserWindow.getAllWindows().length===0)createWindow()})});app.on("window-all-closed",()=>{if(!app.isQuitting)return
;app.quit()});app.on("will-quit",()=>{globalShortcut.unregisterAll();
;for(const p of hookProcs){p.removeAllListeners("exit");p.kill()}hookProcs=[]});ipcMain.on("resize",(_e,w,h)=>{
if(!win||win.isDestroyed())return;const width=Math.max(96,Math.min(640,Math.round(w)))
;const height=Math.max(96,Math.min(320,Math.round(h)));const b=win.getBounds()
;if(b.width===width&&b.height===height)return;win.setSize(width,height,false);console.log(`[win] ${width}x${height}`)})
;ipcMain.on("set-ignore-mouse",(_e,ignore)=>{if(ignore===ignoreMouse)return;setClickThrough(ignore)})
;ipcMain.on("drag-start",()=>{if(win)dragOrigin=win.getPosition()});ipcMain.on("drag-move",(_e,dx,dy)=>{
if(!win||!dragOrigin)return;const p=clampToWorkArea(dragOrigin[0]+dx,dragOrigin[1]+dy);win.setPosition(p.x,p.y)})
;ipcMain.on("drag-end",()=>{dragOrigin=null;savePosition()});let seenStates=new Set
;ipcMain.on("state-changed",(_e,name)=>{if(tray)tray.setToolTip(`dafeiyu — ${name}`);if(!seenStates.has(name)){
seenStates.add(name);console.log(`[dafeiyu] playing: ${name} (${seenStates.size} distinct)`)}});
