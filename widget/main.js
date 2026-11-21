const{app:app,BrowserWindow:BrowserWindow,ipcMain:ipcMain,Tray:Tray,Menu:Menu,globalShortcut:globalShortcut,screen:screen,nativeImage:nativeImage,dialog:dialog,shell:shell}=require("electron")
;const path=require("path");const fs=require("fs");const os=require("os");const{spawn:spawn}=require("child_process")
;if(!app.requestSingleInstanceLock()){app.quit();process.exit(0)}const SCALE=2;const CELL=64;const SIZE=CELL*SCALE
;const DRAG_THRESHOLD=4;if(process.env.DFY_GPU!=="1")app.disableHardwareAcceleration()
;app.commandLine.appendSwitch("disable-renderer-backgrounding")
;app.commandLine.appendSwitch("disable-background-timer-throttling")
;app.commandLine.appendSwitch("disable-backgrounding-occluded-windows")
;app.commandLine.appendSwitch("disable-features","CalculateNativeWinOcclusion")
;const MANIFEST=JSON.parse(fs.readFileSync(path.join(__dirname,"assets","sprites.json"),"utf8"))
;const ANCHORS=(()=>{try{return JSON.parse(fs.readFileSync(path.join(__dirname,"assets","accessories","anchors.json"),"utf8"))}catch{return{}}})()
;const RUNTIME=(()=>{const d=app.isPackaged?path.join(app.getPath("userData"),"runtime"):path.join(__dirname,"runtime");try{fs.mkdirSync(d,{recursive:true})}catch{}process.env.DAFEIYU_RUNTIME=d;return d})()
;const MAIN_LOG=path.join(RUNTIME,"main.log");const LOG_MAX=2*1024*1024
// A broken stdout/stderr pipe must never become an uncaughtException: the
// handler below logs, and logging again would throw again, forever. Swallow the
// stream error, and make every console method non-throwing for the same reason.
;for(const s of [process.stdout,process.stderr])try{s.on("error",()=>{})}catch{}
;for(const m of ["log","warn","error","info","debug"]){const raw=console[m].bind(console);console[m]=(...a)=>{try{raw(...a)}catch{}}}
function trimLog(){try{const st=fs.statSync(MAIN_LOG);if(st.size>LOG_MAX)fs.truncateSync(MAIN_LOG,0)}catch{}}
;let mlogBusy=false;let mlogWrites=0
;function mlog(kind,detail){if(mlogBusy)return;mlogBusy=true
;try{const line=`[${new Date().toISOString()}] ${kind}${detail?" "+detail:""}\n`
;try{fs.appendFileSync(MAIN_LOG,line)}catch{}
;if(++mlogWrites%200===0)trimLog()
;try{console.log(`[main] ${kind}${detail?" "+detail:""}`)}catch{}
}finally{mlogBusy=false}}
;trimLog()
;process.on("uncaughtException",err=>{mlog("uncaughtException",String(err&&err.stack||err).split("\n").slice(0,6).join(" | "))})
;process.on("unhandledRejection",r=>{mlog("unhandledRejection",String(r&&r.stack||r))})
;process.on("exit",code=>{try{fs.appendFileSync(MAIN_LOG,`[${new Date().toISOString()}] exit code=${code}\n`)}catch{}})
;ipcMain.handle("get-manifest",()=>({...MANIFEST,anchors:ANCHORS,departMs:Number(process.env.DFY_DEPART_MS)||600000}));let win=null;let tray=null;let hiddenByUser=false;let ignoreMouse=true;let wantW=SIZE,wantH=SIZE
;let dragOrigin=null;const stateFile=()=>path.join(app.getPath("userData"),"position.json");function loadPosition(){try{
const p=JSON.parse(fs.readFileSync(stateFile(),"utf8"));if(typeof p.x==="number"&&typeof p.y==="number")return p}catch{}
const wa=screen.getPrimaryDisplay().workArea;return{x:wa.x+wa.width-SIZE-24,y:wa.y+wa.height-SIZE-24}}
function insideAnyDisplay(x,y){return screen.getAllDisplays().some(d=>{const b=d.workArea
;return x>=b.x-SIZE&&x<=b.x+b.width&&y>=b.y-SIZE&&y<=b.y+b.height})}function clampToWorkArea(x,y){
const d=screen.getDisplayNearestPoint({x:x+SIZE/2,y:y+SIZE/2});const b=d.workArea;return{
x:Math.round(Math.min(Math.max(x,b.x),b.x+b.width-SIZE)),y:Math.round(Math.min(Math.max(y,b.y),b.y+b.height-SIZE))}}
function savePosition(){if(!win)return;const[x,y]=win.getPosition();fs.writeFileSync(stateFile(),JSON.stringify({x:x,y:y
}))}function setClickThrough(next){ignoreMouse=next;if(win&&!win.isDestroyed()){win.setIgnoreMouseEvents(ignoreMouse,{
forward:true})}refreshTray()}function refreshTray(){if(!tray)return;tray.setContextMenu(Menu.buildFromTemplate([
{label:"dafeiyu",enabled:false},{type:"separator"},
{label:win&&!win.isDestroyed()&&win.isVisible()?"Hide":"Show",click:toggleVisible},
{label:"Click-through",type:"checkbox",checked:ignoreMouse,click:()=>setClickThrough(!ignoreMouse)},
{label:"Reset position",click:resetPosition},{type:"separator"},
{label:"Start with Windows",type:"checkbox",checked:autoStartEnabled(),click:()=>setAutoStart(!autoStartEnabled())},
{type:"separator"},
{label:"Setup check…",click:runDoctor},
{label:"Open logs folder",click:()=>{shell.openPath(RUNTIME)}},
{type:"separator"},
{label:"Quit",click:()=>{try{fs.writeFileSync(path.join(RUNTIME,"graceful-quit"),String(Date.now()))}catch{}app.isQuitting=true;app.quit()}}]))}
function toggleVisible(){if(!win||win.isDestroyed())return;if(win.isVisible()){hiddenByUser=true;win.hide();mlog("hidden","by tray")}
else{hiddenByUser=false;win.showInactive();win.setAlwaysOnTop(true,"screen-saver");mlog("shown","by tray")}refreshTray()}
function settingsFile(){return path.join(app.getPath("userData"),"settings.json")}
function readSettings(){try{return JSON.parse(fs.readFileSync(settingsFile(),"utf8"))||{}}catch{return {}}}
function autoStartEnabled(){const s=readSettings();if(typeof s.autoStart==="boolean")return s.autoStart
;try{return app.getLoginItemSettings().openAtLogin}catch{return false}}
function setAutoStart(next){const on=!!next;try{const s=readSettings();s.autoStart=on
;fs.mkdirSync(path.dirname(settingsFile()),{recursive:true});fs.writeFileSync(settingsFile(),JSON.stringify(s))
;app.setLoginItemSettings({openAtLogin:on,path:process.execPath,
args:app.isPackaged?["--autostart"]:[app.getAppPath(),"--autostart"]})}catch(err){console.error("[autostart]",err.message)}refreshTray()}
function syncAutoStart(){if(!app.isPackaged||!autoStartEnabled())return
;try{app.setLoginItemSettings({openAtLogin:true,path:process.execPath,args:["--autostart"]})}catch(err){console.error("[autostart]",err.message)}}
function firstRun(){const f=path.join(app.getPath("userData"),"installed.json");if(fs.existsSync(f))return false
;try{fs.writeFileSync(f,JSON.stringify({at:Date.now()}))}catch{}return true}
function noAgentBalloon(){if(lastPushed)return
;try{tray.displayBalloon({title:"dafeiyu is awake",content:"No coding agent detected yet. Open Freebuff, opencode or Claude Code and the whale will start reacting.",iconType:"info"})}catch{}}
function runDoctor(){const{execFile}=require("child_process")
;execFile(process.execPath,[path.join(__dirname,"doctor.js")],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1",DAFEIYU_RUNTIME:RUNTIME,DAFEIYU_PACKAGED:app.isPackaged?"1":"0"},windowsHide:true,timeout:20000},(err,stdout,stderr)=>{
const body=[stdout,stderr,err?err.message:""].filter(Boolean).join("\n").trim()||"no output"
;dialog.showMessageBox({type:"info",title:"dafeiyu",message:"Setup check",detail:body.slice(0,6000),buttons:["Close"]})})}function resetPosition(){const wa=screen.getPrimaryDisplay().workArea
;if(!win)return;win.setPosition(wa.x+wa.width-SIZE-24,wa.y+wa.height-SIZE-24);savePosition()}function resizeWin(w,h){
// Windows ignores setSize on a non-resizable window when shrinking. Without
// this, any transient wide state (menu open, second agent) sticks forever and
// the pet grows every time.
const was=win.isResizable();if(!was)win.setResizable(true);win.setSize(w,h,false)
;if(!was)win.setResizable(false)}function refit(){if(!win||win.isDestroyed())return;const b=win.getBounds()
;if(b.width===wantW&&b.height===wantH)return;resizeWin(wantW,wantH)
;const[wx,wy]=win.getPosition();const np=clampToWorkArea(wx,wy);if(np.x!==wx||np.y!==wy)win.setPosition(np.x,np.y)
;console.log(`[win] refit ${b.width}x${b.height} -> ${wantW}x${wantH}`)}function createWindow(){
let pos=loadPosition();const p=clampToWorkArea(pos.x,pos.y)
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
;win.webContents.on("render-process-gone",(_e,d)=>{mlog("render-gone",`${(d&&d.reason)||"?"} exitCode=${d&&d.exitCode}`);if(win&&!win.isDestroyed())win.reload()})
;app.on("child-process-gone",(_e,details)=>{mlog("child-gone",`${details.type} ${details.reason} exitCode=${details.exitCode}`);if(details.type==="GPU"&&win&&!win.isDestroyed()){
console.warn("[dafeiyu] GPU process gone — recreating window");const[x,y]=win.getPosition();win.destroy();win=null
;createWindow();if(win)win.setPosition(x,y)}});win.on("moved",()=>{savePosition();refit();setTimeout(refit,250)});win.on("close",e=>{if(!app.isQuitting){e.preventDefault();mlog("close","blocked while running")}else mlog("close","allowed")})}
;function watchdog(){if(!win||win.isDestroyed()){mlog("watchdog","window missing — recreating");createWindow();return}
;if(!win.isVisible()&&!hiddenByUser){win.showInactive();mlog("watchdog","re-shown invisible window")}
;const[x,y]=win.getPosition();const np=clampToWorkArea(x,y);if(np.x!==x||np.y!==y){win.setPosition(np.x,np.y);mlog("watchdog",`clamped off-screen (${x},${y}) -> (${np.x},${np.y})`)}}
const STATE_FILE=path.join(RUNTIME,"state.json")
;const OC_STATE_FILE=path.join(RUNTIME,"state-opencode.json");const CL_STATE_FILE=path.join(RUNTIME,"state-claude.json");let lastPushed=null;let lastSource=null
;const ACTIVE_STATES=new Set(["thinking","long-think","streaming","running-cmd","read-file","writing-code","searching","propose-diff","compacting","tool-call","tests-fail","blocked","error"])
;function readPayload(file){try{const s=JSON.parse(fs.readFileSync(file,"utf8"));if(!s||!s.state)return null
;if(typeof s.ts!=="number"){try{s.ts=fs.statSync(file).mtimeMs}catch{}}return s}catch{return null}}
function pickPayload(){const fb=readPayload(STATE_FILE);const oc=readPayload(OC_STATE_FILE);const cl=readPayload(CL_STATE_FILE);const fresh=p=>p&&typeof p.ts==="number"&&Date.now()-p.ts<15000;const available=p=>p&&!/not found/i.test(p.detail||"");const busy=p=>fresh(p)&&(p.turn==="running"||ACTIVE_STATES.has(p.state));if(busy(fb))return fb;const side=[oc,cl].filter(busy).sort((a,b)=>b.ts-a.ts)[0];if(side)return side;if(available(fb))return fb;const idleSide=[oc,cl].filter(available).sort((a,b)=>b.ts-a.ts)[0];if(idleSide)return idleSide;return fb||oc||cl}function watchStateFile(){const push=()=>{try{if(!win||win.isDestroyed())return;const s=pickPayload()
;if(!s)return
;const sig=[s.source,s.state,(s.model||""),(s.agents||[]).map(a=>a.id+":"+a.state+":"+(a.running?1:0)).join(",")].join("|")
;if(sig===lastPushed)return;lastPushed=sig;if(s.source!==lastSource){lastSource=s.source
;console.log(`[feed] source -> ${s.source}`)}if(win&&!win.isDestroyed())win.webContents.send("pet-state",s)}catch(err){mlog("feed-error",String(err&&err.message||err))}}
;for(const f of[STATE_FILE,OC_STATE_FILE,CL_STATE_FILE]){try{fs.watch(f,{persistent:false},push)}catch{}}setInterval(push,500)}
function createTray(){const iconPath=path.join(__dirname,"assets","frames","idle","idle-00.png")
;const img=nativeImage.createFromPath(iconPath).resize({width:16,height:16});tray=new Tray(img)
;tray.setToolTip("dafeiyu");refreshTray()}let hookProcs=[];const hookRestarts={};function spawnHook(hookPath){
const name=path.basename(hookPath);try{const lp=path.join(RUNTIME,name+".log");try{fs.mkdirSync(path.dirname(lp),{recursive:true})}catch{}const out=fs.openSync(lp,"a");const proc=spawn(process.execPath,[hookPath,"--watch"],{env:{...process.env,
DAFEIYU_PORT:String({"freebuff-hook.js":8791,"opencode-hook.js":8792,"claude-hook.js":8793}[name]||8791),ELECTRON_RUN_AS_NODE:"1"},stdio:["ignore",out,out],windowsHide:true});try{fs.closeSync(out)}catch{}proc.on("exit",code=>{
console.log(`[hook] ${name} exited (${code}) — restarting in 3s`);hookProcs=hookProcs.filter(p=>p!==proc);hookRestarts[name]=(hookRestarts[name]||0)+1
;setTimeout(()=>spawnHook(hookPath),Math.min(30000,3000*Math.pow(2,Math.min(hookRestarts[name]-1,4))))});hookProcs.push(proc);proc.on("spawn",()=>{hookRestarts[name]=0});console.log(`[hook] started ${name}`)}catch(err){
console.error(`[hook] ${name} failed to start:`,err.message)}}function opencodeDbExists(){
if(process.env.DAFEIYU_OPENCODE_HOOK==="1")return true
;const dataDir=process.env.XDG_DATA_HOME||path.join(os.homedir(),".local","share")
;return fs.existsSync(path.join(dataDir,"opencode","opencode.db"))}function claudeDirExists(){if(process.env.DAFEIYU_CLAUDE_HOOK==="1")return true;return fs.existsSync(path.join(os.homedir(),".claude"))}function startHook(){
const freebuffHook=path.join(__dirname,"freebuff-hook.js");if(fs.existsSync(freebuffHook))spawnHook(freebuffHook)
;const opencodeHook=path.join(__dirname,"opencode-hook.js")
;if(fs.existsSync(opencodeHook)&&opencodeDbExists())spawnHook(opencodeHook)
;const claudeHook=path.join(__dirname,"claude-hook.js");if(fs.existsSync(claudeHook)&&claudeDirExists())spawnHook(claudeHook)}app.on("second-instance",()=>{mlog("second-instance","another launch — re-showing + reset")
;if(win&&!win.isDestroyed()){hiddenByUser=false;win.showInactive();win.setAlwaysOnTop(true,"screen-saver");resetPosition()}})
;app.whenReady().then(()=>{mlog("started",`pid=${process.pid} ver=${app.getVersion()} packaged=${app.isPackaged}`);startHook();createWindow();createTray();watchStateFile();setInterval(watchdog,10000)
;screen.on("display-metrics-changed",()=>{if(win&&!win.isDestroyed()){const[x,y]=win.getPosition();const np=clampToWorkArea(x,y);if(np.x!==x||np.y!==y)win.setPosition(np.x,np.y)}refit();setTimeout(refit,400)})
;screen.on("display-removed",()=>{mlog("display-removed","clamping position");if(win&&!win.isDestroyed()){const[x,y]=win.getPosition();const np=clampToWorkArea(x,y);if(np.x!==x||np.y!==y)win.setPosition(np.x,np.y)}})
;if(firstRun()){setAutoStart(true);setTimeout(noAgentBalloon,6000)};syncAutoStart()
;app.on("activate",()=>{
if(BrowserWindow.getAllWindows().length===0)createWindow()})});app.on("before-quit",()=>{if(!app.isQuitting){app.isQuitting=true;mlog("quit","before-quit")}})
;app.on("window-all-closed",()=>{mlog("window-all-closed",`isQuitting=${!!app.isQuitting}`)
;if(!app.isQuitting){mlog("resurrect","window destroyed without quit — recreating");createWindow();return}
;app.quit()});app.on("will-quit",()=>{mlog("will-quit","hooks stopping");globalShortcut.unregisterAll();
;for(const p of hookProcs){p.removeAllListeners("exit");p.kill()}hookProcs=[]});app.on("quit",(_e,code)=>{mlog("quit","exit code="+code)});ipcMain.on("resize",(_e,w,h)=>{
if(!win||win.isDestroyed())return;const width=Math.max(96,Math.min(640,Math.round(w)))
;const height=Math.max(96,Math.min(320,Math.round(h)));wantW=width;wantH=height;const b=win.getBounds()
;if(b.width===width&&b.height===height)return;resizeWin(width,height)
;const[wx,wy]=win.getPosition();const np=clampToWorkArea(wx,wy);if(np.x!==wx||np.y!==wy)win.setPosition(np.x,np.y)
;console.log(`[win] ${width}x${height}`)})
;ipcMain.on("set-ignore-mouse",(_e,ignore)=>{if(ignore===ignoreMouse)return;setClickThrough(ignore)})
;ipcMain.on("drag-start",()=>{if(win)dragOrigin=win.getPosition()});ipcMain.on("drag-move",(_e,dx,dy)=>{
if(!win||!dragOrigin)return;const p=clampToWorkArea(dragOrigin[0]+dx,dragOrigin[1]+dy);win.setPosition(p.x,p.y)})
;ipcMain.on("drag-end",()=>{dragOrigin=null;savePosition()});let seenStates=new Set
;ipcMain.on("state-changed",(_e,name)=>{if(tray)tray.setToolTip(`dafeiyu — ${name}`);if(!seenStates.has(name)){
seenStates.add(name);console.log(`[dafeiyu] playing: ${name} (${seenStates.size} distinct)`)}});
ipcMain.handle("get-accessories",()=>{const s=readSettings();return s.accessories&&typeof s.accessories==="object"?s.accessories:{}})
;ipcMain.on("set-accessories",(_e,map)=>{const next=map&&typeof map==="object"&&!Array.isArray(map)?map:{}
;try{const s=readSettings();s.accessories=next;fs.mkdirSync(path.dirname(settingsFile()),{recursive:true})
;fs.writeFileSync(settingsFile(),JSON.stringify(s,null,1));mlog("accessories",JSON.stringify(next))}catch(err){
console.error("[accessories]",err.message)}})
;ipcMain.on("hide-pet",()=>{if(win&&!win.isDestroyed()&&win.isVisible()){hiddenByUser=true;win.hide();mlog("hidden","by menu");refreshTray()}});