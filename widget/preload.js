const{contextBridge:contextBridge,ipcRenderer:ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("pet",{
getManifest:()=>ipcRenderer.invoke("get-manifest"),setIgnoreMouse:ignore=>ipcRenderer.send("set-ignore-mouse",ignore),
dragStart:()=>ipcRenderer.send("drag-start"),dragMove:(dx,dy)=>ipcRenderer.send("drag-move",dx,dy),
dragEnd:()=>ipcRenderer.send("drag-end"),stateChanged:name=>ipcRenderer.send("state-changed",name),
resize:(w,h)=>ipcRenderer.send("resize",w,h),onState:cb=>ipcRenderer.on("pet-state",(_e,s)=>cb(s))});