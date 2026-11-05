// WEC page navigation. All existing editor/library/render DOM nodes are moved,
// never recreated, so project persistence and original event handlers remain intact.
// Hash URLs permit direct links, reload, back and forward without new server routes.
const main = document.querySelector("main");
if (main && document.getElementById("library-panel") && document.getElementById("editor")) {
  const names = {home:"Create",library:"Library",studio:"Studio",renders:"Renders"};
  const nav = document.createElement("nav");
  nav.id = "wec-page-navigation";
  nav.setAttribute("aria-label", "Main pages");
  const pages = {};
  const links = {};
  for (const [key,name] of Object.entries(names)) {
    const link = document.createElement("a");
    link.href = "#/" + key;
    link.textContent = name;
    link.dataset.pageLink = key;
    nav.append(link);
    links[key] = link;
    const section = document.createElement("section");
    section.id = "wec-page-" + key;
    section.className = "wec-route-page";
    section.setAttribute("aria-label", name + " page");
    section.hidden = true;
    pages[key] = section;
  }
  const oldNav = main.querySelector(".studio-quicknav");
  oldNav?.replaceWith(nav);
  const sharedStatusBar=document.getElementById("status");
  if(sharedStatusBar) nav.after(sharedStatusBar);
  const hero = main.querySelector(".hero");
  hero?.before(...Object.values(pages));
  const homeItems = [
    hero,document.getElementById("formats"),
    document.getElementById("existing-projects"),
    main.querySelector(".notice"),
    main.querySelector('[aria-labelledby="ai-heading"]')
  ];
  for(const item of homeItems) if(item) pages.home.append(item);
  const library = document.getElementById("library-panel");
  const editor = document.getElementById("editor");
  const empty = document.getElementById("empty");
  pages.library.append(library);
  pages.studio.append(editor);
  if(empty) pages.studio.append(empty);
  const renders = document.getElementById("renders");
  if(renders) pages.renders.append(renders);
  main.querySelector(".workspace")?.remove();
  const brand = document.querySelector("header a.brand");
  if(brand) brand.href="#/home";
  const priorProjects = document.querySelector('header a[href="#existing-projects"]');
  if(priorProjects) {
    priorProjects.href="#/library";
    priorProjects.textContent="My projects";
  }
  function route() {
    const name = location.hash.match(/^#\/(home|library|studio|renders)$/)?.[1] || "home";
    for(const [key,page] of Object.entries(pages)) page.hidden = key !== name;
    for(const [key,link] of Object.entries(links)) {
      if(key===name) link.setAttribute("aria-current","page");
      else link.removeAttribute("aria-current");
    }
    document.title=names[name] + " | WEC Creative Studio";
    document.body.dataset.wecPage=name;
    if(name==="studio" && editor.hidden) {
      const message=document.getElementById("wec-empty-help");
      if(!message && empty) {
        const info=document.createElement("p");
        info.id="wec-empty-help";
        info.className="muted";
        const toLibrary=document.createElement("a");
        toLibrary.href="#/library";
        toLibrary.textContent="Open a saved project";
        const toCreate=document.createElement("a");
        toCreate.href="#/home";
        toCreate.textContent="Create a new project";
        info.append(toLibrary," or ",toCreate," to begin.");
        empty.append(info);
      }
    }
    // Scroll only during an actual page change, not a redraw or edit.
    window.scrollTo({top:0,behavior:"instant"});
  }
  if(!/^#\/(home|library|studio|renders)$/.test(location.hash)) {
    history.replaceState(null,"",location.pathname+location.search+"#/home");
  }
  window.addEventListener("hashchange",route);
  route();
  // Only navigate on a successful project open/create/restore. Save failures
  // and cancelled library actions must not move the user away.
  let previouslyHidden = editor.hidden;
  new MutationObserver(() => {
    const nowHidden = editor.hidden;
    if(previouslyHidden && !nowHidden &&
       (location.hash==="#/home" || location.hash==="#/library"))
      location.hash="#/studio";
    previouslyHidden=nowHidden;
  }).observe(editor,{attributes:true,attributeFilter:["hidden"]});
  // Reopening another project can leave the editor element already unhidden;
  // navigate only once the original editor announces a successful result.
  const sharedStatus=document.getElementById("status");
  if(sharedStatus) new MutationObserver(() => {
    const message=sharedStatus.textContent.trim();
    if(!editor.hidden && /^(Created |Opened |Backup restored|Recovery package restored|Coloring ZIP imported)/.test(message) &&
        location.hash!=="#/studio") location.hash="#/studio";
  }).observe(sharedStatus,{childList:true,characterData:true,subtree:true});
}
