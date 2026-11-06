// Manual automation: preview suggested paths and explicitly execute safe local actions.
// No schedules, provider requests, generation, rendering, or publishing.
const root = document.getElementById("automation-recipes");
if (root) {
  const select = root.querySelector("#automation-recipe");
  const preview = root.querySelector("#automation-preview");
  const status = root.querySelector("#automation-status");
  const recipes = {
    plan: {name: "Plan only", stages: [1], description: "Write and download an outline without creating pages."},
    artwork: {name: "Artwork collection", stages: [2, 3, 4], description: "Attach or create artwork, review originals, and export selected pictures."},
    book: {name: "Printable book", stages: [1, 2, 3, 4], description: "Plan optional pages, add artwork, check the printed interior, then export."},
    video: {name: "Faceless video", stages: [0, 2, 3, 4], description: "Prepare narration and scenes, review required media, then choose rendering."},
  };
  const stageNames = ["Setup", "Plan", "Create", "Review", "Export"];
  const projectKinds = {
    "Faceless video": "video",
    "Art collection": "art",
    "Coloring book": "coloring",
    "Storybook": "storybook",
  };
  let chosen = "";
  let executing = false;
  // A guided run is a session-only navigation aid, not a durable job or proof
  // of completion. The existing editor remains responsible for all changes.
  let guided = null;
  // Browser-local automation checkpoint, not a server-side background queue.
  // Store ONLY bounded workflow metadata. No titles, prompts, images or tokens.
  const ledgerKey = "wec-automation-ledger-v1";
  const ledgerStates = new Set(["running","interrupted","completed","needs-review"]);
  function readLedger() {
    try {
      const raw = localStorage.getItem(ledgerKey);
      if (!raw) return [];
      if (raw.length > 24000) throw Error("oversized");
      const value = JSON.parse(raw);
      if (!Array.isArray(value)) throw Error("malformed");
      return value.filter(x => x && x.schema_version === 1 &&
        typeof x.projectId === "string" && /^[0-9a-f-]{20,80}$/i.test(x.projectId) &&
        ["art","video","coloring","storybook"].includes(x.kind) &&
        ["plan","artwork","book","video"].includes(x.recipe) &&
        ["backup","artwork","print","video"].includes(x.target) &&
        ledgerStates.has(x.state) &&
        ["save","inventory","done"].includes(x.step) &&
        Number.isFinite(x.updated) && x.updated > 0).slice(0,20);
    } catch {
      return [];
    }
  }
  function writeLedger(records) {
    try {
      localStorage.setItem(ledgerKey, JSON.stringify(records.slice(0,20)));
      return true;
    } catch {
      return false;
    }
  }
  function updateLedger(projectId, fields) {
    const records=readLedger().filter(x=>x.projectId!==projectId);
    const previous=readLedger().find(x=>x.projectId===projectId);
    const record={schema_version:1,projectId,
      kind:fields.kind??previous?.kind,
      recipe:fields.recipe??previous?.recipe,
      target:fields.target??previous?.target,
      state:fields.state??previous?.state,
      step:fields.step??previous?.step,
      updated:Date.now()};
    if (!ledgerStates.has(record.state)) return false;
    const ok=writeLedger([record,...records]);
    if(ok) renderLedger();
    return ok;
  }
  function renderLedger() {
    const panel=root.querySelector("#automation-durable");
    if(!panel) return;
    const id=currentProject();
    const record=readLedger().find(x=>x.projectId===id);
    panel.replaceChildren();
    const title=document.createElement("h4");
    title.textContent="Last local automation run";
    const info=document.createElement("p");
    info.id="automation-durable-status";
    info.setAttribute("role","status");
    if (!record || document.getElementById("editor").hidden) {
      info.textContent="No saved run record for this project on this browser.";
    } else if (record.state==="interrupted") {
      info.textContent="Interrupted at "+record.step+". Review project Save and Export before starting a new confirmed run. Nothing resumed automatically.";
    } else {
      info.textContent=record.state+" · "+record.step+" · "+record.recipe+
        " recipe. This is local metadata, not output approval or cloud job state.";
    }
    panel.append(title,info);
  }
  function recoverLedger() {
    const id=currentProject();
    if (!id || document.getElementById("editor").hidden) return;
    const record=readLedger().find(x=>x.projectId===id);
    if(record?.state==="running")
      updateLedger(id,{state:"interrupted"});
    else renderLedger();
  }
  const durablePanel=document.createElement("section");
  durablePanel.id="automation-durable";
  durablePanel.setAttribute("aria-label","Local automation recovery");
  root.append(durablePanel);
  // Persistent owner-authenticated job plans are a separate server feature:
  // no executor is wired to these routes. Creating one never runs AI or render.
  const serverPlans=document.createElement("section");
  serverPlans.id="automation-server-plans";
  serverPlans.setAttribute("aria-label","Server automation plans");
  const serverTitle=document.createElement("h4");
  serverTitle.textContent="Server automation plans (approval required)";
  const serverHint=document.createElement("p");
  serverHint.className="muted";
  serverHint.textContent="Plans never execute automatically. For a new plan, save an online snapshot in Library, then choose a verified source snapshot to lock its saved revision and checked bytes together. The older device-fingerprint lock remains available for legacy use; it is not execution-ready.";
  const serverStatus=document.createElement("p");
  serverStatus.id="automation-server-status";
  serverStatus.setAttribute("role","status");
  const serverList=document.createElement("ol");
  serverList.id="automation-server-list";
  const serverControls=document.createElement("div");
  serverControls.className="toolbar";
  const serverRefresh=document.createElement("button");
  serverRefresh.type="button";
  serverRefresh.className="secondary";
  serverRefresh.textContent="Load server plans";
  const serverCreate=document.createElement("button");
  serverCreate.type="button";
  serverCreate.className="secondary";
  serverCreate.textContent="Record a plan (no execution)";
  serverControls.append(serverRefresh,serverCreate);
  serverPlans.append(serverTitle,serverHint,serverControls,serverStatus,serverList);
  root.append(serverPlans);
  let serverBusy=false;
  async function serverApi(url,body,retry=true) {
    const accessToken=(sessionStorage.getItem("wec_token")||"").trim();
    const headers={"X-WEC-Token":accessToken};
    if(body!==undefined) headers["Content-Type"]="application/json";
    const response=await fetch(url,{method:body===undefined?"GET":"POST",
      headers,body:body===undefined?undefined:JSON.stringify(body)});
    if(response.status===401 && retry && window.WECOwnerLogin) {
      if((sessionStorage.getItem("wec_token")||"").trim()===accessToken)
        sessionStorage.removeItem("wec_token");
      await window.WECOwnerLogin.require();
      return serverApi(url,body,false);
    }
    const data=await response.json();
    if(!response.ok) throw Error(data.error || "Server rejected the plan request.");
    return data;
  }
  // Source fingerprints are computed from the actual *saved* IndexedDB
  // record, including original binary bytes. Only revision and SHA-256 leave
  // this device; no titles, pages, prompts or artwork are uploaded.
  const hex = bytes => [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");
  const digest = async bytes => hex(await crypto.subtle.digest("SHA-256",bytes));
  async function normalizedSource(value) {
    if (value instanceof Blob) return {type:"blob",size:value.size,
      mime:value.type,sha256:await digest(await value.arrayBuffer())};
    if (value instanceof ArrayBuffer) return {type:"arraybuffer",size:value.byteLength,
      sha256:await digest(value)};
    if (ArrayBuffer.isView(value)) return {type:"typedbytes",name:value.constructor.name,
      sha256:await digest(value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength))};
    if (Array.isArray(value)) {
      const result=[];
      for(const item of value) result.push(await normalizedSource(item));
      return result;
    }
    if (value && typeof value==="object") {
      const result={};
      for(const key of Object.keys(value).sort()) {
        if(key==="__proto__"||key==="constructor") throw Error("Unsupported saved project field.");
        result[key]=await normalizedSource(value[key]);
      }
      return result;
    }
    if (value===null || ["string","boolean","number"].includes(typeof value)) {
      if(typeof value==="number" && !Number.isFinite(value)) throw Error("Invalid saved project number.");
      return value;
    }
    throw Error("Unsupported saved project data. No source was locked.");
  }
  async function savedFingerprint(expectedId,expectedKind) {
    const {get}=await import("/studio/store.js");
    const first=await get(expectedId);
    if(!first || first.id!==expectedId || first.kind!==expectedKind ||
       !Number.isSafeInteger(first.revision) || first.revision<1)
      throw Error("Save this matching project before locking its source.");
    const normalized=await normalizedSource(first);
    const sha256=await digest(new TextEncoder().encode(JSON.stringify(normalized)));
    // Revision recheck catches another tab's normal saved-project edits while
    // hashing large original images. A hash never proves server possession.
    const second=await get(expectedId);
    if(!second || second.revision!==first.revision || second.kind!==expectedKind)
      throw Error("Saved project changed during fingerprinting. Review and retry.");
    return {source_revision:first.revision,source_sha256:sha256};
  }
  async function loadServerPlans() {
    if(serverBusy)return;
    serverBusy=true;
    serverRefresh.disabled=serverCreate.disabled=true;
    serverStatus.textContent="Loading server plans…";
    try {
      const result=await serverApi("/api/automation/jobs");
      const id=currentProject();
      serverList.replaceChildren();
      const matching=result.jobs.filter(job=>job.project_id===id);
      for(const job of matching) {
        const row=document.createElement("li");
        row.textContent=job.recipe+" · "+job.status+" · "+job.id.slice(0,8)+" ";
        // Preferred pathway for NEW plans: source revision + payload digest
        // are derived together from a validated immutable online snapshot.
        if(job.status==="awaiting_approval" &&
           job.source_format==="recovery_payload_v1" && job.snapshot_id) {
          const safeSteps=document.createElement("div");
          safeSteps.className="toolbar";
          const summary=document.createElement("span");
          summary.textContent="Source inspection only · No generation or exports";
          safeSteps.append(summary);
          const show=document.createElement("button");
          show.type="button";show.className="secondary";
          show.textContent="View step receipts";
          show.addEventListener("click",async()=>{
            if(serverBusy)return;
            try{
              const result=await serverApi("/api/automation/jobs/"+job.id+"/steps");
              const receipt=result.steps.map(s=>s.step+": "+s.state+
                " (attempts "+s.attempts+")").join("; ");
              serverStatus.textContent=receipt||"No inspection steps recorded for this plan.";
            }catch(error){serverStatus.textContent=error.message||"Step receipts unavailable.";}
          });
          safeSteps.append(show);
          for(const [step,label] of [["verify_source","Verify archived source"],
                                      ["inspect_inventory","Inspect inventory"]]) {
            const action=document.createElement("button");
            action.type="button";action.className="secondary";
            action.textContent=label;
            action.addEventListener("click",async()=>{
              if(serverBusy)return;
              if(!window.confirm("Run the read-only "+label.toLowerCase()+
                " step now? This checks stored recovery bytes and writes a receipt only; no AI, video or publishing."))return;
              serverBusy=true;action.disabled=true;
              serverRefresh.disabled=serverCreate.disabled=true;
              try {
                const url="/api/automation/jobs/"+job.id+"/steps";
                const history=await serverApi(url);
                const previous=history.steps.find(s=>s.step===step);
                const retry=previous && ["failed","interrupted"].includes(previous.state);
                if(retry && !window.confirm("This step previously "+previous.state+
                   ". Explicitly retry the read-only check?"))return;
                const result=await serverApi(url,{confirm:job.id,step,...(retry?{retry:true}:{})});
                serverStatus.textContent=result.step+" · "+result.state+
                  " · receipt saved. No creative work or export was performed.";
              }catch(error){
                serverStatus.textContent=error.message||"Read-only verification failed.";
              }finally{
                serverBusy=false;action.disabled=false;
                serverRefresh.disabled=serverCreate.disabled=false;
              }
            });
            safeSteps.append(action);
          }
          row.append(safeSteps);
          const approvals=await serverApi("/api/automation/jobs/"+job.id+"/approvals");
          const consent=approvals.approvals.find(a=>a.operation==="inventory_report");
          const approvalControls=document.createElement("div");
          approvalControls.className="toolbar";
          const badge=document.createElement("span");
          badge.textContent="Inventory report: "+(consent?.state||"not approved");
          approvalControls.append(badge);
          if(!consent) {
            const grant=document.createElement("button");
            grant.type="button";grant.className="secondary";
            grant.textContent="Approve free inventory report";
            grant.addEventListener("click",async()=>{
              if(serverBusy)return;
              if(!window.confirm("Authorize one source-bound inventory report for this plan? It uses existing verified data, costs $0 in AI/provider charges, and does NOT approve AI, rendering, Cozy handoff or publishing."))return;
              serverBusy=true;grant.disabled=true;
              try{
                await serverApi("/api/automation/jobs/"+job.id+"/approvals",{
                  confirm:job.id,operation:"inventory_report",source_sha256:job.source_sha256
                });
              }catch(error){serverStatus.textContent=error.message||"Approval not recorded.";}
              finally{serverBusy=false;}
              await loadServerPlans();
            });
            approvalControls.append(grant);
          }
          if(consent?.state==="approved") {
            const prepare=document.createElement("button");
            prepare.type="button";prepare.className="secondary";
            prepare.textContent="Prepare inventory report";
            prepare.addEventListener("click",async()=>{
              if(serverBusy)return;
              if(!window.confirm("Verify the source and prepare this read-only inventory report? No provider calls, rendering or publishing."))return;
              serverBusy=true;prepare.disabled=true;
              try{
                const url="/api/automation/jobs/"+job.id+"/steps";
                const history=await serverApi(url);
                const previous=history.steps.find(s=>s.step==="inventory_report");
                const retry=previous&&["failed","interrupted"].includes(previous.state);
                if(retry&&!window.confirm("Retry this previously "+previous.state+" report verification?"))return;
                const receipt=await serverApi(url,{confirm:job.id,step:"inventory_report",
                  ...(retry?{retry:true}:{})});
                if(receipt.state!=="succeeded"||!receipt.result)
                  throw Error("The server did not confirm a completed report.");
                const output={schema_version:1,report_type:"wec-inventory",
                  project_id:job.project_id,job_id:job.id,
                  ...receipt.result};
                const file=new Blob([JSON.stringify(output,null,2)+"\n"],
                  {type:"application/json"});
                const href=URL.createObjectURL(file);
                const link=document.createElement("a");
                link.href=href;link.download="wec-inventory-"+job.id.slice(0,8)+".json";
                document.body.append(link);link.click();link.remove();
                setTimeout(()=>URL.revokeObjectURL(href),3000);
                serverStatus.textContent="Inventory report prepared; download requested. Verify it in your files.";
              }catch(error){serverStatus.textContent=error.message||"Inventory report unavailable.";}
              finally{serverBusy=false;prepare.disabled=false;}
            });
            approvalControls.append(prepare);
            const revoke=document.createElement("button");
            revoke.type="button";revoke.className="secondary";
            revoke.textContent="Revoke report approval";
            revoke.addEventListener("click",async()=>{
              if(serverBusy||!window.confirm("Permanently revoke this report approval? Existing receipts remain, but new report requests are blocked."))return;
              serverBusy=true;revoke.disabled=true;
              try{
                await serverApi("/api/automation/jobs/"+job.id+"/approvals/revoke",
                  {confirm:job.id,operation:"inventory_report"});
              }catch(error){serverStatus.textContent=error.message||"Revocation not confirmed.";}
              finally{serverBusy=false;}
              await loadServerPlans();
            });
            approvalControls.append(revoke);
          }
          row.append(approvalControls);
          if(job.kind==="art" && job.recipe==="artwork") {
            const artworkApproval=approvals.approvals.find(a=>a.operation==="artwork_export");
            const controls=document.createElement("div");
            controls.className="toolbar";
            const status=document.createElement("span");
            status.textContent="Original artwork ZIP: "+(artworkApproval?.state||"not approved");
            controls.append(status);
            if(!artworkApproval) {
              const grant=document.createElement("button");
              grant.type="button";grant.className="secondary";
              grant.textContent="Approve original artwork ZIP";
              grant.addEventListener("click",async()=>{
                if(serverBusy||!window.confirm("Allow exporting the approved original images from this exact archived project? No AI generation, video, publishing or provider charge. All artwork pages must already be approved."))return;
                serverBusy=true;grant.disabled=true;
                try{
                  await serverApi("/api/automation/jobs/"+job.id+"/approvals",{
                    confirm:job.id,operation:"artwork_export",source_sha256:job.source_sha256});
                }catch(error){serverStatus.textContent=error.message||"Artwork approval failed.";}
                finally{serverBusy=false;}
                await loadServerPlans();
              });
              controls.append(grant);
            }
            if(artworkApproval?.state==="approved") {
              const exportUrl="/api/automation/jobs/"+job.id+"/artwork-export";
              const create=document.createElement("button");
              create.type="button";create.className="secondary";
              create.textContent="Prepare approved artwork ZIP";
              create.addEventListener("click",async()=>{
                if(serverBusy||!window.confirm("Check all saved artwork approvals and create a checksum-verified ZIP of originals? This writes one recoverable server export, without generation or publishing."))return;
                serverBusy=true;create.disabled=true;
                try{
                  const old=(await serverApi(exportUrl)).export;
                  const retry=old&&["failed","interrupted"].includes(old.state);
                  if(retry&&!window.confirm("Explicitly retry the "+old.state+" ZIP export?"))return;
                  const receipt=await serverApi(exportUrl,{confirm:job.id,...(retry?{retry:true}:{})});
                  if(receipt.state!=="succeeded"||!receipt.archive_sha256)
                    throw Error("No verified ZIP receipt was returned.");
                  serverStatus.textContent="Original artwork ZIP verified: "+receipt.image_count+
                    " pages. Use Download ZIP to save your file.";
                }catch(error){serverStatus.textContent=error.message||"Artwork archive failed.";}
                finally{serverBusy=false;create.disabled=false;}
              });
              controls.append(create);
              const download=document.createElement("button");
              download.type="button";download.className="secondary";
              download.textContent="Download verified artwork ZIP";
              download.addEventListener("click",async()=>{
                if(serverBusy)return;
                serverBusy=true;download.disabled=true;
                try{
                  const receipt=(await serverApi(exportUrl)).export;
                  if(!receipt||receipt.state!=="succeeded")
                    throw Error("Prepare the artwork ZIP first.");
                  const headers={"X-WEC-Token":(sessionStorage.getItem("wec_token")||"").trim()};
                  const response=await fetch(exportUrl+"/file",{headers});
                  if(!response.ok){
                    const data=await response.json().catch(()=>({}));
                    throw Error(data.error||"ZIP download was rejected.");
                  }
                  const blob=await response.blob();
                  const hash=await digest(await blob.arrayBuffer());
                  if(hash!==receipt.archive_sha256||blob.size!==receipt.archive_bytes)
                    throw Error("ZIP checksum does not match the stored receipt. File was not downloaded.");
                  const href=URL.createObjectURL(blob);
                  const link=document.createElement("a");
                  link.href=href;link.download="wec-artwork-"+job.id.slice(0,8)+".zip";
                  document.body.append(link);link.click();link.remove();
                  setTimeout(()=>URL.revokeObjectURL(href),30000);
                  serverStatus.textContent="Verified ZIP download requested. Confirm the file is saved and opens correctly.";
                }catch(error){serverStatus.textContent=error.message||"ZIP download failed.";}
                finally{serverBusy=false;download.disabled=false;}
              });
              controls.append(download);
              const revoke=document.createElement("button");
              revoke.type="button";revoke.className="secondary";
              revoke.textContent="Revoke artwork export approval";
              revoke.addEventListener("click",async()=>{
                if(serverBusy||!window.confirm("Permanently revoke artwork export permission? Existing server ZIP and receipts are preserved, but future downloads will be blocked."))return;
                serverBusy=true;revoke.disabled=true;
                try{
                  await serverApi("/api/automation/jobs/"+job.id+"/approvals/revoke",{
                    confirm:job.id,operation:"artwork_export"});
                }catch(error){serverStatus.textContent=error.message||"Revocation failed.";}
                finally{serverBusy=false;}
                await loadServerPlans();
              });
              controls.append(revoke);
            }
            row.append(controls);
          }
        }
        if(job.status==="awaiting_approval" && !job.source_sha256 && !job.snapshot_id) {
          const verify=document.createElement("button");
          verify.type="button";verify.className="secondary";
          verify.textContent="Choose verified source snapshot";
          verify.addEventListener("click",async()=>{
            if(serverBusy)return;
            serverBusy=true;verify.disabled=true;
            serverRefresh.disabled=serverCreate.disabled=true;
            try{
              const result=await serverApi("/api/creative/snapshots");
              if(!result.enabled)throw Error("Online snapshots are disabled. Save a recovery package or enable online storage.");
              const eligible=(result.snapshots||[]).filter(item=>
                item.project_id===job.project_id && item.kind===job.kind &&
                Number.isSafeInteger(item.source_revision) && item.source_revision>0);
              if(!eligible.length)throw Error("No revision-bearing online snapshot for this project. Save a new online snapshot in Library.");
              const picker=document.createElement("select");
              picker.setAttribute("aria-label","Verified source for plan "+job.id.slice(0,8));
              for(const item of eligible) {
                const option=document.createElement("option");
                option.value=item.id;
                option.textContent="Revision "+item.source_revision+" · "+new Date(item.created_at).toLocaleString();
                picker.append(option);
              }
              const bind=document.createElement("button");
              bind.type="button";bind.className="secondary";bind.textContent="Verify & lock source";
              bind.addEventListener("click",async()=>{
                if(serverBusy)return;
                const selected=picker.value;
                if(!window.confirm("Lock this immutable online recovery package as the source for this plan? Its contents will be verified, but no automation will run."))return;
                serverBusy=true;picker.disabled=bind.disabled=true;
                serverRefresh.disabled=serverCreate.disabled=true;
                try{
                  await serverApi("/api/automation/jobs/"+job.id+"/verified-source",{snapshot_id:selected});
                  serverStatus.textContent="Verified snapshot source locked. No automation was run.";
                }catch(error){
                  serverStatus.textContent=error.message||"Source was not verified. Refresh before retrying.";
                }finally{
                  serverBusy=false;serverRefresh.disabled=serverCreate.disabled=false;
                }
                await loadServerPlans();
              });
              row.append(picker,bind);
              serverStatus.textContent="Choose a saved revision, then verify and lock it. No execution occurs.";
            }catch(error){
              serverStatus.textContent=error.message||"Verified source snapshots are unavailable.";
            }finally{serverBusy=false;serverRefresh.disabled=serverCreate.disabled=false;}
          });
          row.append(verify);
        }
        if(job.status==="awaiting_approval" && job.source_sha256 && !job.snapshot_id) {
          const find=document.createElement("button");
          find.type="button";find.className="secondary";
          find.textContent="Find online snapshot";
          find.addEventListener("click",async()=>{
            if(serverBusy)return;
            serverBusy=true;find.disabled=true;serverRefresh.disabled=serverCreate.disabled=true;
            try {
              const result=await serverApi("/api/creative/snapshots");
              if(!result.enabled)throw Error("Online snapshots are disabled. Existing plans remain unchanged.");
              const choices=(result.snapshots||[]).filter(item=>
                item.project_id===job.project_id && item.kind===job.kind);
              if(!choices.length)throw Error("No matching online snapshot. Save an explicit online snapshot in Library first.");
              const picker=document.createElement("select");
              picker.setAttribute("aria-label","Online snapshot for plan "+job.id.slice(0,8));
              for(const item of choices) {
                const option=document.createElement("option");
                option.value=item.id;
                option.textContent=new Date(item.created_at).toLocaleString()+" · "+item.id.slice(0,8);
                picker.append(option);
              }
              const attach=document.createElement("button");
              attach.type="button";attach.className="secondary";
              attach.textContent="Verify & attach snapshot";
              attach.addEventListener("click",async()=>{
                if(serverBusy)return;
                const selected=picker.value;
                if(!window.confirm("Verify and link this stored snapshot to the plan? No creative work will run. The saved-source revision and snapshot bytes are not yet independently reconciled."))return;
                serverBusy=true;attach.disabled=true;picker.disabled=true;
                serverRefresh.disabled=serverCreate.disabled=true;
                try{
                  await serverApi("/api/automation/jobs/"+job.id+"/snapshot",{snapshot_id:selected});
                  await loadAfterSnapshot();
                }catch(error){
                  serverStatus.textContent=error.message||"Snapshot association failed; plan unchanged.";
                }finally{
                  serverBusy=false;serverRefresh.disabled=serverCreate.disabled=false;
                }
              });
              row.append(picker,attach);
              serverStatus.textContent="Select a matching saved snapshot, then verify and attach. No execution is available.";
            }catch(error){
              serverStatus.textContent=error.message||"Could not list online snapshots.";
            }finally{serverBusy=false;serverRefresh.disabled=serverCreate.disabled=false;}
          });
          row.append(find);
        }
        if(job.status==="awaiting_approval" && job.source_sha256===null) {
          const bind=document.createElement("button");
          bind.type="button";bind.className="secondary";
          bind.textContent="Lock saved source";
          bind.addEventListener("click",async()=>{
            if(serverBusy)return;
            if(!window.confirm("Lock the saved device-project revision to this server plan? This sends only a checksum and revision, not artwork or an approval to run."))return;
            serverBusy=true;
            bind.disabled=true;serverRefresh.disabled=serverCreate.disabled=true;
            serverStatus.textContent="Checking the saved project and its original files…";
            try{
              const expectedId=currentProject();
              if(expectedId!==job.project_id || document.getElementById("editor").hidden)
                throw Error("Open the matching project before locking its source.");
              const fingerprint=await savedFingerprint(expectedId,job.kind);
              if(currentProject()!==expectedId)throw Error("Project changed. No source lock submitted.");
              await serverApi("/api/automation/jobs/"+job.id+"/source",fingerprint);
              serverStatus.textContent="Saved-source fingerprint locked. No server execution or project upload occurred.";
            }catch(error){
              serverStatus.textContent=error.message || "Source lock not confirmed. Refresh before retrying.";
            }finally{
              serverBusy=false;serverRefresh.disabled=serverCreate.disabled=false;
            }
            await loadServerPlans();
          });
          row.append(bind);
        }
        if(job.status==="awaiting_approval"||job.status==="interrupted") {
          const cancel=document.createElement("button");
          cancel.type="button";cancel.className="secondary";
          cancel.textContent="Cancel plan";
          cancel.addEventListener("click",async()=>{
            if(serverBusy||!window.confirm("Cancel server plan "+job.id.slice(0,8)+"? No creative assets will be changed."))return;
            serverBusy=true;
            cancel.disabled=true;
            try{
              await serverApi("/api/automation/jobs/"+job.id+"/cancel",{confirm:job.id});
              serverStatus.textContent="Plan cancelled on server. No creative work was run.";
            }catch{serverStatus.textContent="Cancellation was not confirmed. Refresh to check server state.";}
            finally{serverBusy=false;serverRefresh.disabled=serverCreate.disabled=false;}
            await loadServerPlans();
          });
          row.append(cancel);
        }
        serverList.append(row);
      }
      serverStatus.textContent=matching.length+" server plan(s) for this project. Execution is unavailable; no actions started.";
    }catch{
      serverStatus.textContent="Server plan list is unavailable or owner login is missing. Local projects remain unchanged.";
    }finally{
      serverBusy=false;
      serverRefresh.disabled=serverCreate.disabled=false;
    }
  }
  async function loadAfterSnapshot() {
    // Called after an acknowledged server write, while the attaching handler
    // owns the busy flag. Refresh after it releases that flag.
    serverBusy=false;
    await loadServerPlans();
  }
  serverRefresh.addEventListener("click",loadServerPlans);
  serverCreate.addEventListener("click",async()=>{
    if(serverBusy || document.getElementById("editor").hidden)return;
    const kind=projectKinds[currentKind()];
    const recipe=select.value;
    const id=currentProject();
    if(!id || !kind || !recipes[recipe] || !collectInputs(recipe,currentKind()).compatible){
      serverStatus.textContent="Open a matching saved project and choose its recipe.";
      return;
    }
    if(!window.confirm("Record a durable server plan for "+recipe+"? This stores intent only and does NOT start generation, rendering, downloads or publishing."))return;
    serverBusy=true;
    serverCreate.disabled=serverRefresh.disabled=true;
    try{
      const result=await serverApi("/api/automation/jobs",{
        project_id:id,kind,recipe,idempotency_key:crypto.randomUUID()
      });
      serverStatus.textContent="Plan recorded: "+result.id.slice(0,8)+". Waiting for owner approval; no execution is available.";
    }catch{
      serverStatus.textContent="Server plan was not confirmed. Refresh before retrying to avoid duplicates.";
    }finally{
      serverBusy=false;
      serverRefresh.disabled=serverCreate.disabled=false;
    }
    await loadServerPlans();
  });
  const currentProject = () => document.getElementById("review-mode")?.dataset.projectId || "";
  const currentTitle = () => document.getElementById("editor-heading").textContent.trim();
  const currentKind = () => document.getElementById("kind-label").textContent.trim();
  function sameProject(run) {
    return Boolean(run && !document.getElementById("editor").hidden &&
      run.projectId && run.projectId === currentProject() &&
      run.title === currentTitle() && run.kind === currentKind());
  }
  function stopGuided(reason) {
    guided = null;
    renderGuided();
    if (reason) status.textContent = reason;
  }
  function startGuided(recipeKey) {
    const recipe = recipes[recipeKey];
    if (!recipe || !currentProject() || document.getElementById("editor").hidden) {
      status.textContent = "Open a project before starting a guided run.";
      return;
    }
    if (!collectInputs(recipeKey, currentKind()).compatible) {
      status.textContent = "Choose a recipe that matches the project format before starting.";
      return;
    }
    if (executing) {
      status.textContent = "Finish the current action before starting a guided run.";
      return;
    }
    // Replacing the current run is a deliberate action; never inherit
    // old completion claims or silently discard its session progress.
    if (guided && !window.confirm("Replace the active guided run? Its session-only progress will be cleared. Project content will remain unchanged.")) {
      status.textContent = "Existing guided run kept. No new run started.";
      return;
    }
    guided = {
      projectId:currentProject(), title:currentTitle(), kind:currentKind(),
      recipeKey, index:0, paused:false, states:recipe.stages.map(() => "pending")
    };
    renderGuided();
    status.textContent = "Guided run started. Open the current workspace or review this step. No action has run.";
  }
  function renderGuided() {
    const panel = root.querySelector("#automation-guided");
    if (!panel) return;
    panel.replaceChildren();
    if (!guided) {
      panel.textContent = "No guided run active. Preview a recipe and choose Start guided run.";
      return;
    }
    if (!sameProject(guided)) {
      guided = null;
      panel.textContent = "The project changed. Start a new guided run for this project.";
      return;
    }
    const recipe = recipes[guided.recipeKey];
    const done = guided.states.filter(state => state === "reviewed").length;
    const heading = document.createElement("h4");
    heading.textContent = "Guided run · " + recipe.name;
    const progress = document.createElement("p");
    progress.id = "automation-guided-progress";
    progress.setAttribute("role", "status");
    progress.textContent = done + " of " + recipe.stages.length +
      " steps reviewed · " + (guided.paused ? "Paused" : "Active") +
      " · Step " + (guided.index + 1) + ": " + stageNames[recipe.stages[guided.index]];
    panel.append(heading, progress);
    const list = document.createElement("ol");
    list.id = "automation-guided-steps";
    recipe.stages.forEach((stage, index) => {
      const row = document.createElement("li");
      row.textContent = stageNames[stage] + " — " + (guided.states[index] === "reviewed"
        ? "reviewed by user (not output approved)" : index === guided.index ? "current" : "pending");
      if (index === guided.index) row.setAttribute("aria-current", "step");
      list.append(row);
    });
    panel.append(list);
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Reviewing a step records only that you inspected its guidance; it does not approve content or run a task. Use Review and Export validators separately.";
    panel.append(note);
    const controls = document.createElement("div");
    controls.className = "toolbar";
    const control = (text, fn, disabled = false) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = text;
      button.disabled = disabled;
      button.addEventListener("click", fn);
      controls.append(button);
      return button;
    };
    control("Open current workspace", () => {
      if (!sameProject(guided) || guided.paused || executing) return;
      openStage(recipe.stages[guided.index]);
      status.textContent = "Opened " + stageNames[recipe.stages[guided.index]] +
        ". Return to Plan to continue the guided run.";
    }, guided.paused || executing);
    control("Mark step reviewed", () => {
      if (!sameProject(guided) || guided.paused || executing) return;
      guided.states[guided.index] = "reviewed";
      renderGuided();
      status.textContent = "Guidance marked reviewed. Content has not been approved or exported.";
    }, guided.paused || executing);
    control("Previous guided step", () => moveGuided(-1),
      guided.paused || executing || guided.index === 0);
    control("Next guided step", () => moveGuided(1),
      guided.paused || executing || guided.index === recipe.stages.length - 1);
    control(guided.paused ? "Resume guided run" : "Pause guided run", () => {
      if (!sameProject(guided) || executing) return;
      guided.paused = !guided.paused;
      renderGuided();
      status.textContent = guided.paused ? "Guided run paused. No actions will run." :
        "Guided run resumed. Verify current inputs before taking action.";
    }, executing);
    // Every actionable handoff is user initiated and goes through execute(),
    // which checks the project, inputs, consent and the original editor result.
    if (recipe.stages[guided.index] === 1 &&
        (guided.recipeKey === "plan" || guided.recipeKey === "book")) {
      control("Convert draft at this step (confirm)", () =>
        execute("convert", guided.title, guided.kind), guided.paused || executing);
    }
    control("Save project at this step (confirm)", () =>
      execute("save", guided.title, guided.kind), guided.paused || executing);
    control("Check inputs for current step", () => {
      if (!sameProject(guided) || guided.paused || executing) return;
      const {compatible, rows} = collectInputs(guided.recipeKey, guided.kind);
      if (!compatible) {
        guided.paused = true;
        status.textContent = "Project format mismatch. Guided run paused.";
      } else {
        status.textContent = "Current inputs: " + rows.join(" ") +
          " These checks are guidance, not output approval.";
      }
      renderGuided();
    }, guided.paused || executing);
    control("End guided run", () => {
      if (executing) return;
      stopGuided("Guided run ended. Project data and existing work are unchanged.");
    }, executing);
    panel.append(controls);
  }
  function moveGuided(delta) {
    if (!guided || !sameProject(guided) || guided.paused || executing) return;
    const next = guided.index + delta;
    if (next < 0 || next >= recipes[guided.recipeKey].stages.length) return;
    guided.index = next;
    renderGuided();
    status.textContent = "Now at " + stageNames[recipes[guided.recipeKey].stages[next]] +
      ". Steps are never automatically executed or approved.";
  }
  // Ephemeral, per-open-project receipts. Never persist claims of completion
  // or infer that a project is publication-ready from an action result.
  // Always located in the Plan workspace; no fixed overlay or new stage.
  const guidedPanel = document.createElement("section");
  guidedPanel.id = "automation-guided";
  guidedPanel.setAttribute("aria-label", "Guided recipe progress");
  root.append(guidedPanel);
  const history = document.createElement("section");
  history.id = "automation-history";
  history.setAttribute("aria-label", "Recent recipe actions");
  history.setAttribute("role", "region");
  const historyTitle = document.createElement("h4");
  historyTitle.textContent = "Recent recipe actions (this session)";
  const historyList = document.createElement("ol");
  historyList.id = "automation-history-list";
  const historyHint = document.createElement("p");
  historyHint.className = "muted";
  historyHint.textContent = "Only actions started through this panel appear here. For needs review, inspect your project and check recipe inputs before deciding whether to retry. No automatic retries. History resets when you change projects and is not a durable audit trail.";
  history.append(historyTitle, historyHint, historyList);
  root.append(history);
  function addReceipt(label, outcome, detail) {
    const item = document.createElement("li");
    // No source content is retained in this history, only a short outcome.
    item.textContent = label + " — " + outcome + (detail ? ": " + detail : "");
    historyList.prepend(item);
    while (historyList.children.length > 10) historyList.lastElementChild.remove();
  }
  function resetHistory() {
    historyList.replaceChildren();
  }
  const actions = {
    save: {
      label: "Save current project",
      button: "save",
      description: "Save the current project on this device using the existing Save control.",
      success: /Project saved on this device/,
    },
    convert: {
      label: "Convert planning draft to pages",
      button: "plan-pages",
      description: "Append pages from your planning text. Existing pages remain; the draft clears only after a successful save.",
      success: /Pages created/,
    },
  };
  // Observe the app's existing status rather than claiming success from a click.
  // The original handlers remain responsible for saving and validation.
  function waitForResult(button, success) {
    const message = document.getElementById("status");
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timeout);
        resolve(value);
      };
      const observer = new MutationObserver(() => {
        const text = message.textContent.trim();
        if (success.test(text)) finish({ok: true, message: text});
        else if (text) finish({ok: false, message: text});
      });
      observer.observe(message, {childList:true, characterData:true, subtree:true});
      const timeout = setTimeout(() => finish({ok:false, message:"The action's result was not confirmed. Check the project and Save status before retrying."}), 12000);
      button.click();
    });
  }
  async function execute(key, expectedTitle, expectedKind) {
    const action = actions[key];
    if (!action || executing ||
        (!chosen && !(guided && sameProject(guided)))) return;
    const editor = document.getElementById("editor");
    const title = () => document.getElementById("editor-heading").textContent.trim();
    const kind = () => document.getElementById("kind-label").textContent.trim();
    if (editor.hidden || title() !== expectedTitle || kind() !== expectedKind) {
      status.textContent = "Project changed. Preview this recipe again before taking action.";
      return;
    }
    const original = document.getElementById(action.button);
    if (!original || original.disabled) {
      status.textContent = "This action is not available while another operation is running.";
      return;
    }
    if (key === "convert") {
      if (expectedKind === "Faceless video") {
        status.textContent = "Use the existing Split narration control for video projects.";
        return;
      }
      if (!document.getElementById("outline").value.trim()) {
        status.textContent = "Add planning text before converting it into pages.";
        return;
      }
    }
    // Only a direct user click can approve a mutation. No auto-chaining.
    if (!window.confirm(action.description + "\n\nContinue for “" + expectedTitle + "”?")) {
      status.textContent = "Cancelled. No automation action was started.";
      addReceipt(action.label, "cancelled", "No action started");
      return;
    }
    if (editor.hidden || title() !== expectedTitle || kind() !== expectedKind || original.disabled) {
      status.textContent = "Project changed or busy. No action was started.";
      return;
    }
    executing = true;
    renderGuided();
    addReceipt(action.label, "running", "Waiting for the existing editor handler");
    const currentReceipt = historyList.firstElementChild;
    status.textContent = action.label + " requested. Checking result…";
    try {
      const result = await waitForResult(original, action.success);
      if (currentReceipt) currentReceipt.textContent = action.label + (result.ok ? " — completed" : " — needs review") + ": " + result.message;
      if (!result.ok && guided && sameProject(guided)) {
        guided.paused = true;
      }
      status.textContent = result.ok ? action.label + " completed. " + result.message :
        action.label + " needs review. Guided run paused if active. Check the saved project before deciding whether to retry: " + result.message;
      if (result.ok && key === "convert") {
        // A completed conversion changes the outline; refresh the preview
        // before another manual conversion, without abandoning the guided run.
        chosen = "";
        preview.replaceChildren();
      }
    } finally {
      executing = false;
      renderGuided();
    }
  }
  // Real execution of a bounded, local-only two-step recipe. The existing
  // editor owns persistence and the production workbench owns inventory checks.
  // No AI calls, renders, downloads, publication, or implicit approvals.
  async function runLocalPreparation(recipeKey, expectedTitle, expectedKind, expectedId) {
    if (executing || chosen !== recipeKey || !recipes[recipeKey]) return;
    const editor = document.getElementById("editor");
    const {compatible} = collectInputs(recipeKey, expectedKind);
    if (!compatible || editor.hidden || currentProject() !== expectedId ||
        currentTitle() !== expectedTitle || currentKind() !== expectedKind) {
      status.textContent = "Project or recipe changed. Preview the matching recipe again.";
      return;
    }
    const targets = {
      "Faceless video":"video", "Art collection":"artwork",
      "Coloring book":"print", "Storybook":"print"
    };
    // Plan-only still gets a safe backup inventory; other recipes get a
    // format-specific output assessment, never the actual export itself.
    const target = recipeKey === "plan" ? "backup" : targets[expectedKind];
    const save = document.getElementById("save");
    const prepare = document.getElementById("production-prepare");
    const selection = document.getElementById("production-target");
    const preparationStatus = document.getElementById("production-status");
    if (!target || !save || save.disabled || !prepare || !selection || !preparationStatus) {
      status.textContent = "Save or production preparation is unavailable. No run started.";
      return;
    }
    if (!window.confirm("Run two local steps for “" + expectedTitle +
        "”?\n1. Save the current project on this device.\n2. Inspect its " +
        target + " output inventory and warnings.\n\nNo AI generation, downloads, rendering, publishing or paid services.")) {
      addReceipt("Local preparation", "cancelled", "No action started");
      status.textContent = "Local preparation cancelled. No action started.";
      return;
    }
    if (editor.hidden || currentProject() !== expectedId ||
        currentTitle() !== expectedTitle || currentKind() !== expectedKind || save.disabled) {
      status.textContent = "Project changed or save became unavailable. No run started.";
      return;
    }
    // Persist the running marker BEFORE touching the project's Save handler.
    // A tab crash/reload turns this into "interrupted", never "completed".
    if (!updateLedger(expectedId,{kind:projectKinds[expectedKind],recipe:recipeKey,
      target,state:"running",step:"save"})) {
      status.textContent="Browser storage is unavailable. Local automation was not started. Save manually and download a recovery backup.";
      return;
    }
    executing = true;
    renderGuided();
    addReceipt("Local preparation", "running", "Step 1: saving");
    const receipt = historyList.firstElementChild;
    const finish = (outcome, message) => {
      const state=outcome==="completed"?"completed":outcome==="stopped"?"interrupted":"needs-review";
      if(!updateLedger(expectedId,{state,step:state==="completed"?"done":undefined}))
        status.textContent="Unable to save run outcome to browser storage. Check this project's Save and Export status.";
      if (receipt) receipt.textContent = "Local preparation — " + outcome + ": " + message;
      status.textContent = "Local preparation " + outcome + ". " + message;
    };
    try {
      status.textContent = "Local preparation: saving project…";
      const saved = await waitForResult(save, /Project saved on this device/);
      const saveStatus = document.getElementById("save-status")?.textContent || "";
      if (!saved.ok || !saveStatus.startsWith("Saved ")) {
        finish("needs review", "Save was not verified; output preparation was NOT run. " + saved.message);
        if (guided && sameProject(guided)) guided.paused = true;
        return;
      }
      if (editor.hidden || currentProject() !== expectedId ||
          currentTitle() !== expectedTitle || currentKind() !== expectedKind) {
        finish("stopped", "Project changed after save; no output check was started.");
        return;
      }
      if (!updateLedger(expectedId,{state:"running",step:"inventory"})) {
        finish("needs review", "Save completed, but run checkpoint storage failed. No inventory check started.");
        return;
      }
      // The workbench is read-only. Switch to the recipe's intended output,
      // then run its original inspection handler synchronously.
      selection.value = target;
      selection.dispatchEvent(new Event("change", {bubbles:true}));
      prepare.click();
      const message = preparationStatus.textContent.trim();
      if (!message.startsWith("Production inventory prepared.")) {
        finish("needs review", "Project was saved, but production preparation did not confirm success.");
        return;
      }
      const warnings = document.querySelectorAll("#production-issues li").length;
      const summary = document.getElementById("production-summary")?.textContent.trim() || "";
      finish("completed", "Project save verified and " + target +
        " inventory prepared. " + warnings + " guidance warning(s). " + summary +
        " Review the inventory in Export; outputs are NOT approved or generated.");
    } catch (error) {
      finish("needs review", "Unexpected preparation error. Check Save and Export before retrying.");
      if (guided && sameProject(guided)) guided.paused = true;
    } finally {
      executing = false;
      renderGuided();
    }
  }
  // Read-only preflight: descriptive checks, not an export/print certification.
  // Never infer approval from an uploaded image or bypass the existing validators.
  // One source for both on-screen input guidance and the downloaded run sheet.
  function collectInputs(recipeKey, kind) {
    const compatible = recipeKey === "video" ? kind === "Faceless video"
      : recipeKey === "artwork" ? kind === "Art collection"
      : recipeKey === "book" ? kind === "Coloring book" || kind === "Storybook"
      : true;
    const draft = document.getElementById("outline")?.value.trim() || "";
    const pages = document.querySelectorAll("#pages .page").length;
    const narration = document.getElementById("narration")?.value.trim() || "";
    const rows = [];
    if (!compatible) rows.push("Choose a matching project format for this recipe. Existing project content is unchanged.");
    else {
      if (recipeKey === "plan") rows.push(draft ? "Planning text is present and can be downloaded." : "Planning text is empty. Add an outline in Plan to use this recipe.");
      if (recipeKey === "book") {
        rows.push(draft ? "Planning text is available (optional)." : "No planning text; you can still create pages independently.");
        rows.push(pages ? pages + " page slot(s) available for artwork and review." : "No pages yet. Create pages in Create or convert a Plan draft.");
      }
      if (recipeKey === "artwork") rows.push(pages ? pages + " artwork slot(s) in this project." : "No artwork slots. Add artwork in Create.");
      if (recipeKey === "video") rows.push(narration ? "Narration text is present." : "Narration is missing. Add it in Setup.");
      if (recipeKey !== "plan") rows.push("Use the existing Review and Export checks for actual asset, print, or render readiness.");
    }
    return {compatible, rows};
  }
  function preflight(recipeKey, expectedTitle, expectedKind, output) {
    const editor = document.getElementById("editor");
    const title = document.getElementById("editor-heading").textContent.trim();
    const kind = document.getElementById("kind-label").textContent.trim();
    output.replaceChildren();
    if (editor.hidden || title !== expectedTitle || kind !== expectedKind) {
      status.textContent = "Project changed. Preview the recipe again to check readiness.";
      return;
    }
    const {compatible, rows} = collectInputs(recipeKey, kind);
    const list = document.createElement("ul");
    for (const message of rows) {
      const row = document.createElement("li");
      row.textContent = message;
      list.append(row);
    }
    output.append(list);
    status.textContent = compatible ? "Recipe inputs checked. This is guidance, not an approval or export validation."
      : "This recipe does not match this project's format. Choose another recipe or project.";
  }
  // A portable, read-only checklist. It does not assert that any stage ran.
  // Recalculate warnings when clicked so edits after preview are reflected.
  function downloadRunSheet(recipeKey, expectedTitle, expectedKind) {
    const editor = document.getElementById("editor");
    const title = document.getElementById("editor-heading").textContent.trim();
    const kind = document.getElementById("kind-label").textContent.trim();
    if (!recipes[recipeKey] || editor.hidden || title !== expectedTitle || kind !== expectedKind) {
      status.textContent = "Project changed. Preview the recipe again before downloading its checklist.";
      return;
    }
    const recipe = recipes[recipeKey];
    const {compatible, rows} = collectInputs(recipeKey, kind);
    const lines = [
      "WEC Creative Automation — Recipe Run Sheet",
      "Project: " + title,
      "Format: " + kind,
      "Recipe: " + recipe.name,
      "",
      "Manual steps (mark complete yourself; no steps are automatically run):",
      ...recipe.stages.map((step, index) => "[ ] " + (index + 1) + ". " + stageNames[step]),
      "",
      "Current input snapshot (guidance only):",
      ...rows.map(row => "- " + row),
      "",
      compatible ? "Matching format: Yes" : "Matching format: No — choose another recipe or format.",
      "Before exports, use the existing Review and Export validators.",
      "Any AI generation, rendering, publishing or sharing requires a separate deliberate action.",
      "This sheet is not a record of successful execution, approval or print readiness.",
      ""
    ];
    const blob = new Blob([lines.join("\n")], {type:"text/plain;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "wec-recipe-run-sheet.txt";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = "Recipe run sheet downloaded. No project action was started.";
  }
  function clear() {
    chosen = "";
    preview.replaceChildren();
    status.textContent = "Choose a recipe and select Preview. No action runs automatically.";
  }
  function openStage(stage) {
    const tab = document.querySelectorAll("#editor .workflow-tab")[stage];
    if (tab && !document.getElementById("editor").hidden) tab.click();
  }
  root.querySelector("#automation-preview-button").addEventListener("click", () => {
    const recipe = recipes[select.value];
    if (!recipe) return clear();
    const kind = projectKinds[document.getElementById("kind-label").textContent.trim()];
    if (!kind) {
      clear();
      status.textContent = "Open or create a project before previewing a recipe.";
      return;
    }
    chosen = select.value;
    preview.replaceChildren();
    const intro = document.createElement("p");
    intro.textContent = recipe.description;
    preview.append(intro);
    const list = document.createElement("ol");
    for (const step of recipe.stages) {
      const item = document.createElement("li");
      const title = document.createElement("span");
      title.textContent = stageNames[step] + " — ";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = "Open " + stageNames[step];
      button.addEventListener("click", () => openStage(step));
      item.append(title, button);
      list.append(item);
    }
    preview.append(list);
    const start = document.createElement("button");
    start.type = "button";
    start.className = "secondary";
    start.textContent = "Start guided run";
    start.addEventListener("click", () => startGuided(select.value));
    preview.append(start);
    const actionList = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = "Optional actions (one at a time)";
    actionList.append(title);
    const expectedTitle = document.getElementById("editor-heading").textContent.trim();
    const expectedKind = document.getElementById("kind-label").textContent.trim();
    const available = select.value === "plan" || select.value === "book" ? ["save", "convert"] : ["save"];
    for (const key of available) {
      const action = actions[key];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = action.label;
      button.addEventListener("click", () => execute(key, expectedTitle, expectedKind));
      actionList.append(button);
    }
    preview.append(actionList);
    const bounded = document.createElement("div");
    const boundedTitle = document.createElement("h4");
    boundedTitle.textContent = "Run safe local preparation";
    const boundedInfo = document.createElement("p");
    boundedInfo.className = "muted";
    boundedInfo.textContent = "One confirmed run saves the current project, then inspects output inventory and warnings. It does not generate, render, download or publish anything.";
    const boundedButton = document.createElement("button");
    boundedButton.type = "button";
    boundedButton.className = "secondary";
    boundedButton.id = "automation-run-local";
    boundedButton.textContent = "Save + prepare output";
    const expectedId = currentProject();
    const recipeKey = select.value;
    boundedButton.addEventListener("click", () =>
      runLocalPreparation(recipeKey, expectedTitle, expectedKind, expectedId));
    bounded.append(boundedTitle, boundedInfo, boundedButton);
    preview.append(bounded);
    const readiness = document.createElement("div");
    const check = document.createElement("button");
    check.type = "button";
    check.className = "secondary";
    check.textContent = "Check recipe inputs";
    const report = document.createElement("div");
    report.setAttribute("role", "status");
    report.setAttribute("aria-label", "Recipe input check");
    check.addEventListener("click", () => preflight(chosen, expectedTitle, expectedKind, report));
    readiness.append(check, report);
    preview.append(readiness);
    const sheet = document.createElement("button");
    sheet.type = "button";
    sheet.className = "secondary";
    sheet.textContent = "Download recipe run sheet";
    sheet.addEventListener("click", () => downloadRunSheet(chosen, expectedTitle, expectedKind));
    preview.append(sheet);
    status.textContent = recipe.name + " preview ready. Each action remains your choice; no steps have run.";
  });
  root.querySelector("#automation-clear-button").addEventListener("click", clear);
  select.addEventListener("change", () => {
    clear();
    // A change of preview does not silently abandon an active guided run.
    if (guided) status.textContent = "Preview changed. The existing guided run stays active until ended or replaced.";
  });
  // Project changes reset stale previews, so a recipe never implies that
  // its tasks were performed on a different project.
  function projectChanged() {
    clear();
    resetHistory();
    stopGuided();
    // Editor replacement is async; update the display after the existing
    // project-open handler changes its ID. Do not restore session claims.
    queueMicrotask(recoverLedger);
  }
  document.querySelectorAll("[data-kind]").forEach(button => button.addEventListener("click", projectChanged));
  document.getElementById("library")?.addEventListener("click", event => {
    if (event.target.closest("button")) projectChanged();
  });
  document.getElementById("restore")?.addEventListener("change", projectChanged);
  document.getElementById("import-zip")?.addEventListener("change", projectChanged);
  clear();
  renderGuided();
  renderLedger();
  // Rehydrate on a successful create/open/restore; status is only a hint.
  // The exact current project ID is always checked before showing a record.
  const editor=document.getElementById("editor");
  new MutationObserver(recoverLedger).observe(editor,{attributes:true,attributeFilter:["hidden"]});
  const projectIdNode=document.getElementById("review-mode");
  if(projectIdNode) new MutationObserver(recoverLedger)
    .observe(projectIdNode,{attributes:true,attributeFilter:["data-project-id"]});
  const sharedStatus=document.getElementById("status");
  if(sharedStatus) new MutationObserver(() => {
    if(/^(Created |Opened |Backup restored|Recovery package restored)/.test(sharedStatus.textContent.trim()))
      recoverLedger();
  }).observe(sharedStatus,{childList:true,subtree:true});
}
