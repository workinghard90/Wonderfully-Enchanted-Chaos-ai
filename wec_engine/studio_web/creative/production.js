// Phase 7: on-device production preparation and deliberate export handoffs.
// This module never generates content, renders, publishes, uploads, or grants approval.
const productionRoot = document.getElementById("production-workbench");
if (productionRoot) {
  const $ = id => document.getElementById(id);
  const status = $("production-status");
  const inventory = $("production-inventory");
  const issues = $("production-issues");
  const summary = $("production-summary");
  const output = $("production-output");
  const selection = $("production-target");
  const label = {
    backup:"Editable project backup",
    artwork:"Original artwork ZIP",
    print:"Printable interior PDF",
    cozy:"Private Cozy proposal ZIP",
    video:"Video render",
  };
  const allowed = {
    "Faceless video":["backup","video"],
    "Art collection":["backup","artwork","print","cozy"],
    "Coloring book":["backup","artwork","print","cozy"],
    "Storybook":["backup","artwork","print","cozy"],
  };
  const destination = {backup:"backup",artwork:"zip",print:"pdf",cozy:"cozy-export",video:"video"};
  let prepared = null;
  function project() {
    const editor = $("editor");
    if (!editor || editor.hidden) return null;
    const id = $("review-mode")?.dataset.projectId;
    const title = $("editor-heading")?.textContent.trim();
    const kind = $("kind-label")?.textContent.trim();
    return id && title && allowed[kind] ? {id,title,kind} : null;
  }
  function collect() {
    const p = project();
    if (!p) return null;
    const pages = [...document.querySelectorAll("#pages .page")].map((row,index) => {
      const img = row.querySelector("img");
      const approval = row.querySelector('select[aria-label="Artwork review"]')?.value || "unreviewed";
      const meta = [...row.querySelectorAll("p")].map(el => el.textContent).join(" ");
      const ppi = meta.match(/(\d+)\s*PPI at planned size/);
      const widthHeight = meta.match(/(\d+)\s*×\s*(\d+)/);
      return {
        number:index+1, imageAttached:Boolean(img), imageName:img?.alt || null,
        approval:img ? approval : "missing",
        width:widthHeight?Number(widthHeight[1]):null,
        height:widthHeight?Number(widthHeight[2]):null,
        approximatePpi:ppi?Number(ppi[1]):null,
      };
    });
    return {project:p, pages};
  }
  function assess(target, data) {
    const findings=[];
    if (!allowed[data.project.kind].includes(target)) {
      findings.push("This output is not supported for the current project format.");
      return findings;
    }
    if (target !== "backup" && data.pages.length === 0) findings.push("Create at least one page or scene.");
    if (target !== "backup" && data.pages.some(p=>!p.imageAttached)) findings.push("Attach images to all pages or scenes before preparing this output.");
    if (target === "print" || target === "cozy") {
      if (data.pages.some(p=>p.imageAttached && p.approval !== "approved"))
        findings.push("Review and approve attached artwork. Unreviewed images are not automatically approved.");
    }
    if (target === "print" && data.pages.some(p=>p.approximatePpi !== null && p.approximatePpi < 300))
      findings.push("At least one image is below the 300 PPI target; inspect print quality.");
    if (target === "cozy") {
      if (data.pages.length>40) findings.push("The private Cozy importer supports up to 40 preview pages.");
      if (!$("author")?.value.trim()) findings.push("Add the creator/author name before private Cozy export.");
    }
    if (target === "video" && !$("narration")?.value.trim())
      findings.push("Add narration and review the scene split before rendering.");
    if (target === "print")
      findings.push("Run the existing Check book validator in Review; this overview does not check text, margins, duplicate file bytes or PDF requirements.");
    if (target === "video")
      findings.push("Rendering still requires the existing render consent and server checks.");
    if (target === "cozy")
      findings.push("Private Cozy handoff still requires the existing metadata prompt, user confirmation, and importer validation. It never publishes.");
    return findings;
  }
  function render(data, findings, target) {
    inventory.replaceChildren();
    issues.replaceChildren();
    summary.textContent = data.pages.length + " ordered page/scene slot(s) · " +
      data.pages.filter(x=>x.imageAttached).length + " image(s) attached · " +
      data.pages.filter(x=>x.approval==="approved").length + " approved image(s).";
    for(const page of data.pages) {
      const item=document.createElement("li");
      const name=document.createElement("span");
      name.textContent=(data.project.kind==="Faceless video"?"Scene ":"Page ")+page.number+
        ": "+(page.imageAttached?(page.imageName+" · "+page.approval):"image missing")+
        (page.approximatePpi===null?"":" · approximately "+page.approximatePpi+" PPI");
      const button=document.createElement("button");
      button.className="secondary";
      button.type="button";
      button.textContent="Edit slot "+page.number;
      button.addEventListener("click",()=>{
        if(!samePrepared()) return invalidate();
        $("editor").querySelectorAll(".workflow-tab")[2]?.click();
        const row=$("pages").children[page.number-1];
        row?.scrollIntoView({block:"center",behavior:"instant"});
        if(row){row.tabIndex=-1;row.focus({preventScroll:true});}
      });
      item.append(name," ",button);
      inventory.append(item);
    }
    for(const text of findings) {
      const li=document.createElement("li");
      li.textContent=text;
      issues.append(li);
    }
    output.textContent="Selected output: "+label[target]+
      ". Preparation only; no files, images or published products were generated.";
  }
  function samePrepared(){
    const p=project();
    return Boolean(prepared && p && prepared.project.id===p.id &&
      prepared.project.title===p.title && prepared.project.kind===p.kind &&
      selection.value===prepared.target);
  }
  function invalidate(){
    prepared=null;
    inventory.replaceChildren();
    issues.replaceChildren();
    summary.textContent="";
    output.textContent="";
    status.textContent="Project or target changed. Prepare again before continuing.";
  }
  function prepare() {
    const data=collect();
    if (!data) return invalidate();
    const target=selection.value;
    const findings=assess(target,data);
    prepared={...data,target,findings};
    render(data,findings,target);
    status.textContent="Production inventory prepared. Review warnings and use the existing export validators before releasing files.";
  }
  function download() {
    if (!samePrepared()) return invalidate();
    // Recalculate from current editor data: the preparation cannot authorize
    // a stale image/review state, and it never includes original image bytes.
    const data=collect();
    const target=selection.value;
    const report={
      schema_version:1, document_type:"wec-production-preparation",
      title:data.project.title, project_format:data.project.kind,
      selected_output:target, selected_output_name:label[target],
      inventory:data.pages, guidance:assess(target,data),
      notes:[
        "Preparation inventory only; not a verified export or publication approval.",
        "Check Review and Export before generating a final file.",
        "No original artwork or draft text is embedded in this report.",
        "Actual output must be generated by the existing WEC export controls."
      ]
    };
    const blob=new Blob([JSON.stringify(report,null,2)+"\n"],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const link=document.createElement("a");
    link.href=url;
    link.download="wec-production-preparation.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    status.textContent="Preparation report downloaded. No production output was generated.";
  }
  function handoff() {
    if(!samePrepared()) return invalidate();
    const target=selection.value;
    const p=project();
    if(!p) return invalidate();
    // Explicit user gesture moves focus to the existing delivery action.
    // The original handler retains its checks, prompts and confirmations.
    const button=$(destination[target]);
    if(!button || button.hidden || !allowed[p.kind].includes(target)){
      status.textContent="That export is unavailable for this project format.";
      return;
    }
    $("editor").querySelectorAll(".workflow-tab")[4]?.click();
    button.scrollIntoView({block:"center",behavior:"instant"});
    button.focus({preventScroll:true});
    status.textContent="Opened "+label[target]+". Choose the focused existing export button to proceed; no export started.";
  }
  function review() {
    if(!samePrepared()) return invalidate();
    $("editor").querySelectorAll(".workflow-tab")[3]?.click();
    if(selection.value==="print" && $("check-book") && !$("book-review").hidden){
      $("check-book").focus({preventScroll:true});
      status.textContent="Review is open. Select Check book for validation; no check or export was started automatically.";
    }else{
      $("readiness").focus({preventScroll:true});
      status.textContent="Review is open. Inspect each image and approval before exporting.";
    }
  }
  $("production-prepare").addEventListener("click",prepare);
  $("production-download").addEventListener("click",download);
  $("production-handoff").addEventListener("click",handoff);
  $("production-review").addEventListener("click",review);
  selection.addEventListener("change",invalidate);
  document.querySelectorAll("[data-kind]").forEach(b=>b.addEventListener("click",invalidate));
  $("library")?.addEventListener("click",e=>{if(e.target.closest("button"))invalidate();});
  for(const id of ["restore","import-zip"]) $(id)?.addEventListener("change",invalidate);
  status.textContent="Prepare an inventory to inspect artwork order, approvals and output requirements.";
}
