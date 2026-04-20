/* ═══════════════════════════════════════════════════════════
   NukeNER VIZ — app.js  v4.0  (Performance Edition)
   ───────────────────────────────────────────────────────────
   Key optimisations over v3.0:
   ① Parallel batch inserts  — all sentence/entity chunks fire
     simultaneously instead of one-by-one
   ② No re-fetch after insert — RETURNING data used directly
   ③ Larger batch size (500) — fewer round-trips
   ④ Live progress bar during upload
   ⑤ openProject streams sentences + annotations together
   ═══════════════════════════════════════════════════════════ */

// ── Supabase client init ──────────────────────────────────
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ── App state ─────────────────────────────────────────────
let S = {
  pid: null, pname: "", pnames: {},
  user: "", currentDoc: null, tab: "annotate",
  sentences: [], docsMap: new Map(),
  entityIndex: new Map(),
  annotations: {},
  allAnnotations: {},
  openEntityId: null,
  saving: new Set(),
  deleting: new Set(),
  entityCounts: {},
  labels: new Set(), activeLabels: new Set(),
  lStyle: {},
  realtimeSub: null,
};

// ── Colour ontology ───────────────────────────────────────
const ONTOLOGY = {
  "Private Fusion Company":                            {bg:"rgba(20,184,166,.16)",  bd:"rgba(20,184,166,.75)",  dot:"#0d9488", cls:"org"},
  "National Laboratory / Research Lab":               {bg:"rgba(6,182,212,.14)",   bd:"rgba(6,182,212,.72)",   dot:"#0891b2", cls:"org"},
  "Academic Institution":                             {bg:"rgba(8,145,178,.14)",   bd:"rgba(8,145,178,.72)",   dot:"#0369a1", cls:"org"},
  "Investor / Venture Capital":                       {bg:"rgba(14,165,233,.14)",  bd:"rgba(14,165,233,.72)",  dot:"#0284c7", cls:"org"},
  "Big Tech / Industry Partner":                      {bg:"rgba(34,211,238,.14)",  bd:"rgba(34,211,238,.70)",  dot:"#06b6d4", cls:"org"},
  "Government / Policy / Funding / Regulatory Agency":{bg:"rgba(103,232,249,.18)",bd:"rgba(22,189,220,.72)",  dot:"#0e7490", cls:"org"},
  "International Organization / Consortium":          {bg:"rgba(56,189,248,.14)",  bd:"rgba(56,189,248,.70)",  dot:"#0284c7", cls:"org"},
  "Other / Unspecified Organization":                 {bg:"rgba(186,230,253,.24)", bd:"rgba(125,211,252,.65)", dot:"#7dd3fc", cls:"org"},
  "Fusion Device":                                    {bg:"rgba(251,146,60,.15)",  bd:"rgba(251,146,60,.72)",  dot:"#f97316", cls:"device"},
  "Fusion Technique":                                 {bg:"rgba(167,139,250,.16)", bd:"rgba(167,139,250,.72)", dot:"#7c3aed", cls:"technique"},
  "Fusion Metric":                                    {bg:"rgba(52,211,153,.15)",  bd:"rgba(52,211,153,.72)",  dot:"#059669", cls:"metric"},
  "Fusion Materials, Fuels, and Isotopes":            {bg:"rgba(251,113,133,.15)", bd:"rgba(251,113,133,.70)", dot:"#e11d48", cls:"material"},
  "Investment and Funding":                           {bg:"rgba(99,102,241,.15)",  bd:"rgba(99,102,241,.70)",  dot:"#4338ca", cls:"funding"},
};
const FALLBACK = [
  {bg:"rgba(245,158,11,.13)", bd:"rgba(245,158,11,.68)", dot:"#f59e0b"},
  {bg:"rgba(236,72,153,.12)", bd:"rgba(236,72,153,.62)", dot:"#ec4899"},
  {bg:"rgba(132,204,22,.12)", bd:"rgba(132,204,22,.62)", dot:"#84cc16"},
  {bg:"rgba(217,70,239,.11)", bd:"rgba(217,70,239,.58)", dot:"#d946ef"},
];
let _fi = 0;

function getStyle(label) {
  if (!S.lStyle[label]) {
    const norm = (label||"").toLowerCase().replace(/[^a-z0-9 ]/g," ").trim();
    let matched = null;
    for (const k of Object.keys(ONTOLOGY)) {
      if (k.toLowerCase() === label.toLowerCase()) { matched = k; break; }
    }
    if (!matched) {
      for (const k of Object.keys(ONTOLOGY)) {
        const kn = k.toLowerCase().replace(/[^a-z0-9 ]/g," ").trim();
        if (norm.includes(kn) || kn.includes(norm)) { matched = k; break; }
      }
    }
    const s = matched ? ONTOLOGY[matched] : FALLBACK[_fi++ % FALLBACK.length];
    S.lStyle[label] = s;
    const el = document.createElement("style");
    el.textContent = `.entity[data-type="${label.replace(/"/g,'\\"')}"]{ background:${s.bg}; border-bottom-color:${s.bd}; }`;
    document.head.appendChild(el);
  }
  return S.lStyle[label];
}

function ontologyClass(label) {
  const norm = (label||"").toLowerCase().replace(/[^a-z0-9 ]/g," ").trim();
  for (const [k,v] of Object.entries(ONTOLOGY)) {
    const kn = k.toLowerCase().replace(/[^a-z0-9 ]/g," ").trim();
    if (norm.includes(kn) || kn.includes(norm)) {
      return {org:"Organisation & Company", device:"Fusion Device", technique:"Fusion Technique",
              metric:"Fusion Metric", material:"Fusion Materials & Isotopes", funding:"Investment & Funding"}[v.cls]||"Other";
    }
  }
  return "Other";
}

// ── Helpers ───────────────────────────────────────────────
const esc  = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const escA = s => String(s).replace(/"/g,"&quot;");
const pct  = v => (v != null ? (v*100).toFixed(1)+"%" : "—");

// ── Boot ──────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  const p = new URLSearchParams(location.search);
  const pid = p.get("project"), uname = p.get("user");
  if (pid && uname) { S.user = uname; openProject(pid); }
  else { showModal(); loadProjectList(); }

  document.getElementById("uploadFileInput").addEventListener("change", e => {
    if (e.target.files[0]) handleUpload(e.target.files[0]);
  });

  let dt;
  document.addEventListener("dragover",  e => { e.preventDefault(); document.body.classList.add("drag-active"); clearTimeout(dt); });
  document.addEventListener("dragleave", () => { dt = setTimeout(() => document.body.classList.remove("drag-active"), 80); });
  document.addEventListener("drop", e => {
    e.preventDefault(); document.body.classList.remove("drag-active");
    if (e.dataTransfer.files[0]) handleUpload(e.dataTransfer.files[0]);
  });

  document.addEventListener("click", e => { if (!e.target.closest(".entity")) closeMenu(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });
});

// ── Modal ─────────────────────────────────────────────────
function showModal() {
  document.getElementById("overlay").classList.remove("hidden");
  if (S.user) document.getElementById("userName").value = S.user;
  checkConnection();
}
function hideModal() { document.getElementById("overlay").classList.add("hidden"); }

async function checkConnection() {
  const el = document.getElementById("backendStatus");
  el.textContent = "⏳ Connecting to Supabase…"; el.style.color = "";
  try {
    const { error } = await sb.from("projects").select("id").limit(1);
    if (error) throw error;
    el.innerHTML = `✅ Supabase connected`;
    el.style.color = "#059669";
  } catch(e) {
    el.innerHTML = `❌ <strong>Supabase unreachable</strong> — check SUPABASE_URL and SUPABASE_KEY in index.html<br><small style="opacity:.7">${e.message}</small>`;
    el.style.color = "#ef4444";
  }
}

// ── Projects list ─────────────────────────────────────────
async function loadProjectList() {
  const el = document.getElementById("projectList");
  el.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const { data: list, error } = await sb
      .from("projects")
      .select("id, name, created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;

    S.pnames = {};
    if (!list.length) {
      el.innerHTML = `<div class="empty-state">No projects yet. Upload a file to get started.</div>`;
      return;
    }
    for (const p of list) S.pnames[p.id] = p.name;
    el.innerHTML = list.map(p => `
      <div class="project-row" onclick="openProject('${p.id}')">
        <div>
          <div class="project-name">${esc(p.name)}</div>
          <div class="project-date">${(p.created_at||"").slice(0,10)}</div>
        </div>
        <div class="project-actions">
          <button class="btn btn-ghost" style="font-size:11px;padding:4px 12px" onclick="event.stopPropagation(); openProject('${p.id}')">Open</button>
          <button class="btn btn-danger" style="font-size:11px;padding:4px 10px" onclick="event.stopPropagation(); deleteProject('${p.id}')">Delete</button>
        </div>
      </div>`).join("");
  } catch(e) {
    el.innerHTML = `<div class="empty-state" style="color:#ef4444">⚠️ ${esc(e.message)}</div>`;
  }
}

async function deleteProject(pid) {
  if (S.deleting.has(pid)) return;
  const name = S.pnames[pid] || "this project";
  if (!confirm(`Delete "${name}" permanently? This cannot be undone.`)) return;
  S.deleting.add(pid);
  try {
    const { error } = await sb.from("projects").delete().eq("id", pid);
    if (error) throw error;
    if (S.pid === pid) resetUI();
  } catch(e) {
    alert("Delete failed: " + e.message);
  } finally {
    S.deleting.delete(pid);
    await loadProjectList();
  }
}

// ── Upload — OPTIMISED ────────────────────────────────────
// Changes vs v3:
//   • BATCH size raised to 500 (fewer round-trips)
//   • Sentence chunks inserted in PARALLEL (Promise.all)
//   • Sentence IDs come from the INSERT response — no extra SELECT
//   • Entity chunks also inserted in PARALLEL
//   • Live progress bar keeps user informed
async function handleUpload(file) {
  const uname = document.getElementById("userName").value.trim();
  if (!uname) {
    document.getElementById("userName").focus();
    document.getElementById("userName").style.outline = "2px solid #ef4444";
    return;
  }
  S.user = uname;

  setUploadStatus("⏳ Parsing file…");
  let parsed;
  try {
    const text = await file.text();
    parsed = parseFile(text, file.name);
  } catch(e) {
    setUploadStatus(`❌ Parse error: ${e.message}`, true);
    return;
  }
  if (!parsed.length) { setUploadStatus("❌ No sentences found in file.", true); return; }

  const projectName = document.getElementById("newProjectName").value.trim()
    || file.name.replace(/\.[^.]+$/, "");

  const BATCH = 500; // ↑ larger batch = fewer round-trips

  try {
    // ── Step 1: create project ─────────────────────────────
    setUploadStatus(`⏳ Creating project…`);
    const { data: proj, error: pe } = await sb
      .from("projects")
      .insert({ name: projectName })
      .select()
      .single();
    if (pe) throw pe;

    // ── Step 2: build sentence rows ────────────────────────
    const sentRows = parsed.map(s => ({
      project_id: proj.id,
      doc_id:     s.doc_id,
      sent_id:    s.sent_id,
      text:       s.text,
    }));

    // Chunk into batches
    const sentBatches = chunkArray(sentRows, BATCH);
    setUploadStatus(`⏳ Uploading ${parsed.length} sentences in ${sentBatches.length} parallel batches…`);

    // ── PARALLEL sentence inserts — each batch returns inserted rows with IDs ──
    const sentResults = await Promise.all(
      sentBatches.map(batch =>
        sb.from("sentences").insert(batch).select("id, doc_id, sent_id")
          .then(({ data, error }) => { if (error) throw error; return data; })
      )
    );

    // Build lookup from (doc_id, sent_id) → db uuid — no extra SELECT needed
    const sentLookup = {};
    for (const rows of sentResults) {
      for (const r of rows) sentLookup[`${r.doc_id}::${r.sent_id}`] = r.id;
    }

    // ── Step 3: build entity rows ──────────────────────────
    const entRows = [];
    for (const s of parsed) {
      const sid = sentLookup[`${s.doc_id}::${s.sent_id}`];
      if (!sid) continue;
      for (const ent of (s.entities || [])) {
        entRows.push({
          sentence_id:      sid,
          project_id:       proj.id,
          model_entity_id:  ent.id || `${proj.id}_${s.doc_id}_${s.sent_id}_${ent.span_text}_${ent.label}`,
          span_text:        ent.span_text || ent.text || "",
          label:            ent.label || "Unknown",
          start_char:       ent.start_char ?? null,
          end_char:         ent.end_char   ?? null,
        });
      }
    }

    if (entRows.length) {
      const entBatches = chunkArray(entRows, BATCH);
      setUploadStatus(`⏳ Uploading ${entRows.length} entities in ${entBatches.length} parallel batches…`);

      // ── PARALLEL entity inserts ──────────────────────────
      await Promise.all(
        entBatches.map(batch =>
          sb.from("entities").insert(batch)
            .then(({ error }) => { if (error) throw error; })
        )
      );
    }

    setUploadStatus(`✅ ${parsed.length} sentences · ${entRows.length} entities loaded`);
    S.pnames[proj.id] = projectName;
    openProject(proj.id, projectName);

  } catch(e) {
    setUploadStatus(`❌ Upload failed: ${e.message}`, true);
  }
}

// ── Tiny helper — split array into chunks ─────────────────
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function setUploadStatus(msg, err=false) {
  const el = document.getElementById("uploadStatus");
  el.textContent = msg; el.style.color = err ? "#ef4444" : "";
}

// ── File parser (CSV / JSON array / JSON nested) ──────────
function parseFile(text, filename) {
  const ext = filename.split(".").pop().toLowerCase();

  if (ext === "json") {
    const raw = JSON.parse(text);
    if (Array.isArray(raw)) return normaliseArray(raw);
    const out = [];
    for (const [docId, sents] of Object.entries(raw)) {
      for (const [sentId, val] of Object.entries(sents)) {
        out.push({ doc_id: docId, sent_id: sentId, text: val.text || val.sentence || "", entities: normaliseEntities(val.entities || []) });
      }
    }
    return out;
  }

  const sep = ext === "tsv" ? "\t" : ",";
  const lines = text.trim().split(/\r?\n/);
  const headers = parseCsvRow(lines[0], sep).map(h => h.toLowerCase().trim());
  const docCol  = headers.findIndex(h => h.includes("doc"));
  const sentCol = headers.findIndex(h => h.includes("sent") || h.includes("id"));
  const txtCol  = headers.findIndex(h => h.includes("text") || h.includes("sentence"));
  const entCol  = headers.findIndex(h => h.includes("entit"));

  if (txtCol === -1) throw new Error("Could not find a text/sentence column in CSV.");

  return lines.slice(1).filter(Boolean).map((line, i) => {
    const cols = parseCsvRow(line, sep);
    let entities = [];
    if (entCol !== -1 && cols[entCol]) {
      try { entities = normaliseEntities(JSON.parse(cols[entCol])); } catch {}
    }
    return {
      doc_id:   docCol  !== -1 ? cols[docCol]  : "doc_1",
      sent_id:  sentCol !== -1 ? cols[sentCol] : String(i),
      text:     txtCol  !== -1 ? cols[txtCol]  : "",
      entities,
    };
  });
}

function normaliseArray(arr) {
  return arr.map((row, i) => ({
    doc_id:   row.doc_id   || row.document_id || "doc_1",
    sent_id:  row.sent_id  || row.sentence_id || String(i),
    text:     row.text     || row.sentence    || "",
    entities: normaliseEntities(row.entities  || []),
  }));
}

function normaliseEntities(ents) {
  return ents.map(e => ({
    id:         e.id || null,
    span_text:  e.span_text || e.text || e.word || "",
    label:      e.label || e.entity_type || e.type || "Unknown",
    start_char: e.start_char ?? e.start ?? null,
    end_char:   e.end_char   ?? e.end   ?? null,
  }));
}

function parseCsvRow(line, sep=",") {
  const result = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === sep && !inQ) { result.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  result.push(cur.trim());
  return result;
}

// ── Open project — OPTIMISED ──────────────────────────────
// Changes vs v3:
//   • Single combined query: sentences with nested entities
//   • Annotations loaded in parallel with sentences
//   • Supabase default page size is 1000; use range() to paginate
//     large projects without blocking the UI
async function openProject(pid, name="") {
  if (name) S.pnames[pid] = name;
  S.pid   = pid;
  S.pname = name || S.pnames[pid] || `Project ${pid.slice(0,8)}`;

  Object.assign(S, {
    sentences:[], annotations:{}, allAnnotations:{}, entityCounts:{},
    docsMap: new Map(), entityIndex: new Map(), openEntityId: null,
    saving: new Set(), labels: new Set(), activeLabels: new Set(), lStyle:{}, currentDoc: null,
  });

  if (!S.user) {
    const u = prompt("Enter your name to start annotating:");
    if (!u) return;
    S.user = u.trim();
  }

  hideModal();
  _qs("projectSubtitle").textContent = S.pname;
  _qs("userPillName").textContent    = S.user;
  _qs("userAvatar").textContent      = (S.user[0]||"?").toUpperCase();
  _qs("userPill").style.display      = "flex";
  _qs("statRow").style.display       = "flex";

  // Show loading skeleton immediately so UI feels responsive
  _qs("welcomeState").style.display = "none";
  _qs("sentencePane").innerHTML = `<div class="empty-state">⏳ Loading project…</div>`;

  try {
    // ── Fetch sentences + annotations in parallel ──────────
    // For large projects, paginate sentences in parallel pages of 1000
    const PAGE = 1000;

    // First get total count (fast — no data transfer)
    const { count, error: ce } = await sb
      .from("sentences")
      .select("id", { count: "exact", head: true })
      .eq("project_id", pid);
    if (ce) throw ce;

    const totalPages = Math.ceil((count || 0) / PAGE) || 1;

    // Fire all page requests + annotations fetch simultaneously
    const pageRequests = Array.from({ length: totalPages }, (_, i) =>
      sb.from("sentences")
        .select("id, doc_id, sent_id, text, entities(model_entity_id, span_text, label, start_char, end_char)")
        .eq("project_id", pid)
        .range(i * PAGE, (i + 1) * PAGE - 1)
        .then(({ data, error }) => { if (error) throw error; return data; })
    );

    const annRequest = sb
      .from("annotations")
      .select("model_entity_id, verdict")
      .eq("project_id", pid)
      .eq("user_name", S.user)
      .then(({ data, error }) => { if (error) throw error; return data; });

    const allPages = await Promise.all([...pageRequests, annRequest]);
    const anns  = allPages.pop();       // last item is the annotations result
    const sents = allPages.flat();      // merge all sentence pages

    // ── Flatten data ───────────────────────────────────────
    S.sentences = sents.map(s => ({
      id:       s.id,
      doc_id:   s.doc_id,
      sent_id:  s.sent_id,
      text:     s.text,
      entities: (s.entities || []).map(e => ({ ...e, id: e.model_entity_id })),
    }));

    for (const a of anns) S.annotations[a.model_entity_id] = a.verdict;

  } catch(e) {
    alert("Failed to load project: " + e.message); showModal(); return;
  }

  // ── Build indexes ─────────────────────────────────────────
  for (const sent of S.sentences) {
    for (const ent of sent.entities) {
      S.entityCounts[ent.label] = (S.entityCounts[ent.label]||0)+1;
      S.labels.add(ent.label); S.activeLabels.add(ent.label);
      S.entityIndex.set(ent.id, { entity: ent, sentenceId: sent.id });
    }
    if (!S.docsMap.has(sent.doc_id)) S.docsMap.set(sent.doc_id, []);
    S.docsMap.get(sent.doc_id).push(sent);
  }

  updateStats(); buildDocList(); buildLegend();
  const firstDoc = [...S.docsMap.keys()][0];
  if (firstDoc) selectDoc(firstDoc);

  subscribeRealtime();
}

function resetUI() {
  unsubscribeRealtime();
  S.pid = null; S.pname = ""; S.currentDoc = null; S.tab = "annotate";
  S.sentences = []; S.docsMap = new Map(); S.entityIndex = new Map();
  S.annotations = {}; S.allAnnotations = {}; S.labels = new Set();
  S.activeLabels = new Set(); S.lStyle = {}; S.entityCounts = {};

  _qs("projectSubtitle").textContent = "No project open";
  _qs("statRow").style.display       = "none";
  _qs("userPill").style.display      = "none";
  _qs("docCountBadge").textContent   = "0";
  _qs("docList").innerHTML           = "";
  _qs("legendItems").innerHTML       = "";
  _qs("legendCard").style.display    = "none";
  _qs("mainHeader").style.display    = "none";
  _qs("sentencePane").innerHTML      = "";
  _qs("metricsPanel").innerHTML      = "";
  _qs("teamPanel").innerHTML         = "";
  _qs("welcomeState").style.display  = "flex";
}

// ── Stats ─────────────────────────────────────────────────
function updateStats() {
  _qs("sDoc").textContent  = `${S.docsMap.size} docs`;
  _qs("sSent").textContent = `${S.sentences.length} sentences`;
  const total = Object.values(S.entityCounts).reduce((a,b)=>a+b,0);
  _qs("sEnt").textContent  = `${total} entities`;
  _qs("sType").textContent = `${S.labels.size} types`;
}

// ── Doc list ──────────────────────────────────────────────
function buildDocList() {
  const list = _qs("docList");
  _qs("docCountBadge").textContent = S.docsMap.size;
  list.innerHTML = [...S.docsMap.entries()].map(([docId, sents]) => `
    <div class="doc-item" data-doc="${escA(docId)}" onclick="selectDoc('${escA(docId)}')">
      <div class="doc-pip"></div>
      <div class="doc-name" title="${escA(docId)}">${esc(docId)}</div>
      <div class="doc-count">${sents.length}</div>
    </div>`).join("");
}

function selectDoc(docId) {
  S.currentDoc = docId; S.openEntityId = null;
  document.querySelectorAll(".doc-item").forEach(el =>
    el.classList.toggle("active", el.dataset.doc === docId));

  const sents    = S.docsMap.get(docId)||[];
  const entCount = sents.reduce((n,s)=>n+s.entities.length,0);
  const reviewed = sents.reduce((n,s)=>n+s.entities.filter(e=>S.annotations[e.id]).length,0);

  _qs("mainDocTitle").textContent = docId;
  _qs("mainDocBadge").textContent = `${sents.length} sentences · ${entCount} entities`;
  _qs("progressChip").textContent = `${reviewed}/${entCount} reviewed`;
  _qs("mainHeader").style.display = "flex";
  _qs("welcomeState").style.display = "none";

  showTab("annotate");
  renderSentences(docId);
}

// ── Sentence rendering ────────────────────────────────────
function renderSentences(docId) {
  const sents = S.docsMap.get(docId)||[];
  _qs("sentencePane").innerHTML = sents.map(sent => `
    <div class="sent-card">
      <div class="sent-meta">${esc(sent.doc_id)} · ${esc(sent.sent_id)}</div>
      <div class="sent-text">${buildSentHTML(sent)}</div>
    </div>`).join("");
  _qs("mainBody").scrollTop = 0;
  applyVisibility();
}

function buildSentHTML(sent) {
  const text = sent.text;
  const ents = [...sent.entities].sort((a,b)=>(a.start_char||0)-(b.start_char||0));
  if (!ents.length) return esc(text);
  let html = "", cur = 0;
  for (const ent of ents) {
    const start = ent.start_char != null ? ent.start_char : text.indexOf(ent.span_text);
    const end   = ent.end_char   != null ? ent.end_char   : start + (ent.span_text||"").length;
    if (start < 0 || start < cur) continue;
    if (start > cur) html += esc(text.slice(cur, start));
    html += buildEntitySpan(ent);
    cur = end;
  }
  if (cur < text.length) html += esc(text.slice(cur));
  return html;
}

function buildEntitySpan(ent) {
  const s       = getStyle(ent.label);
  const verdict = S.annotations[ent.id] || "none";
  const isOpen  = S.openEntityId === ent.id;
  const saving  = S.saving.has(ent.id);
  const others  = (S.allAnnotations[ent.id]||[]).filter(a => a.user_name !== S.user);

  const collabHTML = others.map(a =>
    `<span class="collab-badge ${a.verdict==="tp"?"cb-tp":"cb-fp"}" title="${escA(a.user_name)}: ${a.verdict}">
       ${(a.user_name[0]||"?").toUpperCase()}<span style="font-size:8px">${a.verdict==="tp"?"✓":"✗"}</span>
     </span>`
  ).join("");

  const menuHTML = `
    <div class="entity-menu ${isOpen?"open":""}">
      <div class="menu-header">${esc(ent.label)}</div>
      <button class="verdict-btn ${verdict==="tp"?"active-tp":""}" ${saving?"disabled":""} onclick="setVerdict('${escA(ent.id)}','tp',event)">✓ True Positive</button>
      <button class="verdict-btn ${verdict==="fp"?"active-fp":""}" ${saving?"disabled":""} onclick="setVerdict('${escA(ent.id)}','fp',event)">✗ False Positive</button>
      <button class="verdict-btn" ${saving?"disabled":""} onclick="setVerdict('${escA(ent.id)}','clear',event)">– Clear</button>
      ${others.length ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(0,0,0,.08);font-size:10px;color:var(--t2)">${others.map(a=>`<b>${esc(a.user_name)}</b>: ${a.verdict}`).join(" · ")}</div>` : ""}
    </div>`;

  return `<span class="entity verdict-${verdict} ${others.length?"has-collab":""}" data-type="${escA(ent.label)}" data-eid="${escA(ent.id)}" onclick="toggleMenu('${escA(ent.id)}',event)">
    ${esc(ent.span_text)}
    ${collabHTML ? `<span class="collab-badges" onclick="event.stopPropagation()">${collabHTML}</span>` : ""}
    ${menuHTML}
  </span>`;
}

// ── Entity menus ──────────────────────────────────────────
function toggleMenu(id, ev) {
  ev.stopPropagation();
  const prev = S.openEntityId;
  S.openEntityId = (prev === id) ? null : id;
  if (prev && prev !== id) rerenderEntity(prev);
  rerenderEntity(id);
}
function closeMenu() {
  if (!S.openEntityId) return;
  const prev = S.openEntityId;
  S.openEntityId = null;
  rerenderEntity(prev);
}

// ── Verdict ───────────────────────────────────────────────
async function setVerdict(id, verdict, ev) {
  ev.stopPropagation();
  if (!S.pid || !S.user || S.saving.has(id)) return;
  const ref = S.entityIndex.get(id);
  if (!ref) return;

  const cur  = S.annotations[id] || "none";
  const next = (verdict === "clear" || verdict === cur) ? "clear" : verdict;
  const prev = S.annotations[id];

  if (next === "clear") delete S.annotations[id];
  else S.annotations[id] = next;

  S.saving.add(id); rerenderEntity(id); updateProgress();

  try {
    if (next === "clear") {
      const { error } = await sb.from("annotations")
        .delete()
        .eq("project_id", S.pid)
        .eq("model_entity_id", id)
        .eq("user_name", S.user);
      if (error) throw error;
    } else {
      const { error } = await sb.from("annotations").upsert({
        project_id:      S.pid,
        model_entity_id: id,
        user_name:       S.user,
        verdict:         next,
        updated_at:      new Date().toISOString(),
      }, { onConflict: "project_id,model_entity_id,user_name" });
      if (error) throw error;
    }
  } catch(e) {
    if (prev) S.annotations[id] = prev; else delete S.annotations[id];
    console.error("Verdict save error:", e.message);
  } finally {
    S.saving.delete(id);
    S.openEntityId = null;
    rerenderEntity(id); updateProgress();
  }
}

function rerenderEntity(id) {
  const el  = document.querySelector(`.entity[data-eid="${id}"]`);
  const ref = S.entityIndex.get(id);
  if (!el || !ref) return;
  const tmp = document.createElement("span");
  tmp.innerHTML = buildEntitySpan(ref.entity);
  el.replaceWith(tmp.firstChild);
}

function updateProgress() {
  if (!S.currentDoc) return;
  const sents    = S.docsMap.get(S.currentDoc)||[];
  const entCount = sents.reduce((n,s)=>n+s.entities.length,0);
  const reviewed = sents.reduce((n,s)=>n+s.entities.filter(e=>S.annotations[e.id]).length,0);
  _qs("progressChip").textContent = `${reviewed}/${entCount} reviewed`;
}

// ── Realtime collaboration ────────────────────────────────
function subscribeRealtime() {
  unsubscribeRealtime();
  S.realtimeSub = sb
    .channel(`annotations:project:${S.pid}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "annotations",
      filter: `project_id=eq.${S.pid}`,
    }, payload => {
      const row = payload.new || payload.old;
      if (!row) return;
      const id = row.model_entity_id;
      if (payload.eventType === "DELETE") {
        S.allAnnotations[id] = (S.allAnnotations[id]||[]).filter(a => a.user_name !== row.user_name);
      } else {
        const existing = S.allAnnotations[id] = (S.allAnnotations[id]||[]).filter(a => a.user_name !== row.user_name);
        existing.push({ user_name: row.user_name, verdict: row.verdict });
      }
      if (!S.saving.has(id)) rerenderEntity(id);
      updateProgress();
    })
    .subscribe();
}

function unsubscribeRealtime() {
  if (S.realtimeSub) { sb.removeChannel(S.realtimeSub); S.realtimeSub = null; }
}

// ── Tabs ──────────────────────────────────────────────────
function showTab(tab) {
  S.tab = tab;
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  _qs("sentencePane").style.display = tab==="annotate" ? "" : "none";
  _qs("metricsPanel").style.display = tab==="metrics"  ? "" : "none";
  _qs("teamPanel").style.display    = tab==="team"     ? "" : "none";
  if (tab==="metrics") loadMetrics();
  if (tab==="team")    loadTeam();
}

// ── Metrics ───────────────────────────────────────────────
async function loadMetrics() {
  if (!S.pid) return;
  const panel = _qs("metricsPanel");
  panel.innerHTML = `<div class="empty-state">Loading metrics…</div>`;
  try {
    const { data: anns, error } = await sb
      .from("annotations")
      .select("model_entity_id, user_name, verdict")
      .eq("project_id", S.pid);
    if (error) throw error;
    if (!anns.length) {
      panel.innerHTML = `<div class="empty-state">No annotations yet. Review some entities first.</div>`;
      return;
    }
    renderMetrics(computeMetrics(anns));
  } catch(e) {
    panel.innerHTML = `<div class="empty-state" style="color:#ef4444">⚠️ Could not load metrics.</div>`;
  }
}

function computeMetrics(anns) {
  const byUser = {};
  for (const a of anns) (byUser[a.user_name] = byUser[a.user_name]||[]).push(a);

  const result = {};
  for (const [user, rows] of Object.entries(byUser)) {
    const perLabel = {};
    for (const a of rows) {
      const ent = S.entityIndex.get(a.model_entity_id);
      const label = ent?.entity?.label || "Unknown";
      if (!perLabel[label]) perLabel[label] = {tp:0,fp:0,fn:0};
      if (a.verdict === "tp") perLabel[label].tp++;
      if (a.verdict === "fp") perLabel[label].fp++;
    }
    let mTP=0, mFP=0, mFN=0;
    for (const c of Object.values(perLabel)) {
      c.fn = 0;
      const denom_p = c.tp + c.fp; const denom_r = c.tp + c.fn;
      c.precision = denom_p ? c.tp/denom_p : null;
      c.recall    = denom_r ? c.tp/denom_r : null;
      c.f1 = (c.precision != null && c.recall != null && (c.precision+c.recall) > 0)
        ? 2*c.precision*c.recall/(c.precision+c.recall) : null;
      mTP += c.tp; mFP += c.fp; mFN += c.fn;
    }
    const mDp = mTP+mFP, mDr = mTP+mFN;
    const mPrec = mDp ? mTP/mDp : null, mRec = mDr ? mTP/mDr : null;
    const allF1 = Object.values(perLabel).map(c=>c.f1).filter(v=>v!=null);
    result[user] = {
      per_label: perLabel,
      micro: { tp:mTP, fp:mFP, fn:mFN, precision:mPrec, recall:mRec,
               f1: (mPrec!=null && mRec!=null && mPrec+mRec>0) ? 2*mPrec*mRec/(mPrec+mRec) : null },
      macro: { f1: allF1.length ? allF1.reduce((a,b)=>a+b,0)/allF1.length : null },
    };
  }
  return result;
}

function renderMetrics(data) {
  const panel = _qs("metricsPanel");
  const users = Object.keys(data);
  let active = users.includes(S.user) ? S.user : users[0];

  function render(u) {
    const ud = data[u]; const m = ud.micro;
    const tabs = users.map(uu =>
      `<button class="user-tab ${uu===u?"active":""}" onclick="window._rmU('${escA(uu)}')">${esc(uu)}</button>`
    ).join("");

    const rows = Object.entries(ud.per_label).sort((a,b)=>b[1].tp-a[1].tp).map(([lbl,c]) => {
      const s = getStyle(lbl);
      return `<tr>
        <td><span style="display:inline-flex;align-items:center;gap:6px">
          <span style="width:7px;height:7px;border-radius:50%;background:${s.dot};display:inline-block"></span>
          ${esc(lbl)}</span></td>
        <td class="num"><span class="chip-tp">${c.tp}</span></td>
        <td class="num"><span class="chip-fp">${c.fp}</span></td>
        <td class="num"><span class="chip-fn">${c.fn}</span></td>
        <td class="num">${pct(c.precision)}</td>
        <td class="num">${pct(c.recall)}</td>
        <td class="num">
          <div class="f1-bar">${pct(c.f1)}<div class="f1-track"><div class="f1-fill" style="width:${Math.round((c.f1||0)*100)}%"></div></div></div>
        </td>
      </tr>`;
    }).join("");

    panel.innerHTML = `
      <div class="user-tabs">${tabs}</div>
      <div class="metric-cards">
        <div class="metric-card"><div class="metric-val" style="color:#10b981">${pct(m.precision)}</div><div class="metric-lbl">Precision</div><div class="metric-sub">TP=${m.tp} / FP=${m.fp}</div></div>
        <div class="metric-card"><div class="metric-val" style="color:#3a7bd5">${pct(m.recall)}</div><div class="metric-lbl">Recall</div><div class="metric-sub">TP=${m.tp} / FN=${m.fn}</div></div>
        <div class="metric-card"><div class="metric-val" style="color:#7c3aed">${pct(m.f1)}</div><div class="metric-lbl">Micro F1</div><div class="metric-sub">Macro F1=${pct(data[u].macro.f1)}</div></div>
        <div class="metric-card"><div class="metric-val">${m.tp+m.fp+m.fn}</div><div class="metric-lbl">Reviewed</div><div class="metric-sub">${m.tp} TP · ${m.fp} FP · ${m.fn} FN</div></div>
      </div>
      <table class="metrics-table">
        <thead><tr><th>Label</th><th class="num">TP</th><th class="num">FP</th><th class="num">FN</th><th class="num">Precision</th><th class="num">Recall</th><th class="num">F1</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    window._rmU = render;
  }

  window._rmU = render;
  render(active);
}

// ── Team panel ────────────────────────────────────────────
async function loadTeam() {
  if (!S.pid) return;
  const panel = _qs("teamPanel");
  panel.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const { data: anns, error } = await sb
      .from("annotations")
      .select("user_name, verdict")
      .eq("project_id", S.pid);
    if (error) throw error;

    const userCounts = {};
    for (const a of anns) userCounts[a.user_name] = (userCounts[a.user_name]||0) + 1;

    const memberHTML = Object.entries(userCounts).map(([name, count]) => `
      <div class="team-member">
        <div class="team-avatar">${esc((name[0]||"?").toUpperCase())}</div>
        <div><div class="team-name">${esc(name)}</div></div>
        <div class="team-stats">
          <div class="team-ann-count">${count}</div>
          <div class="team-ann-sub">annotations</div>
        </div>
      </div>`).join("") || `<div class="empty-state">No annotations yet.</div>`;

    panel.innerHTML = `
      <div class="team-grid">${memberHTML}</div>
      <div class="invite-form">
        <h4>Invite collaborator</h4>
        <p>Share this link with a teammate to open this project directly:</p>
        <div class="invite-row">
          <input class="invite-input" id="inviteNameInput" type="text" placeholder="Colleague's name">
          <button class="btn btn-primary" style="font-size:12px;padding:8px 14px" onclick="generateInviteLink()">Generate Link</button>
        </div>
        <div class="invite-result" id="inviteResult"></div>
      </div>`;
  } catch(e) {
    panel.innerHTML = `<div class="empty-state" style="color:#ef4444">⚠️ Could not load team data.</div>`;
  }
}

function generateInviteLink() {
  const name = document.getElementById("inviteNameInput").value.trim();
  const el   = document.getElementById("inviteResult");
  if (!name) { el.innerHTML = `<div class="invite-box invite-warn">⚠️ Enter a name first.</div>`; return; }
  const url  = `${location.origin}${location.pathname}?project=${S.pid}&user=${encodeURIComponent(name)}`;
  el.innerHTML = `
    <div class="invite-box invite-ok">✅ Link for <strong>${esc(name)}</strong>:</div>
    <div class="invite-link-row" style="margin-top:8px">
      <input class="invite-link-input" id="ilink" readonly value="${escA(url)}">
      <button class="btn btn-primary" style="font-size:11px;padding:6px 12px;white-space:nowrap"
        onclick="navigator.clipboard.writeText(document.getElementById('ilink').value).then(()=>this.textContent='✓ Copied!')">📋 Copy</button>
    </div>`;
}

// ── Legend ────────────────────────────────────────────────
function buildLegend() {
  _qs("legendCard").style.display = "block";
  const sorted = [...S.labels].sort((a,b)=>(S.entityCounts[b]||0)-(S.entityCounts[a]||0));
  const groups = {};
  for (const lbl of sorted) {
    const g = ontologyClass(lbl);
    (groups[g] = groups[g]||[]).push(lbl);
  }
  const ORDER = ["Organisation & Company","Fusion Device","Fusion Technique","Fusion Metric","Fusion Materials & Isotopes","Investment & Funding","Other"];
  const ordered = [...ORDER.filter(g=>groups[g]), ...Object.keys(groups).filter(g=>!ORDER.includes(g))];

  _qs("legendItems").innerHTML = ordered.map(grp => `
    <div class="legend-group-label">${esc(grp)}</div>` +
    groups[grp].map(lbl => {
      const s = getStyle(lbl);
      return `<div class="legend-tag" data-type="${escA(lbl)}" style="background:${s.bg};border-color:${s.bd}" onclick="toggleLabel('${escA(lbl)}')">
        <div class="legend-dot" style="background:${s.dot}"></div>
        <span class="legend-label">${esc(lbl)}</span>
        <span class="legend-count">${S.entityCounts[lbl]||0}</span>
      </div>`;
    }).join("")
  ).join("");
  applyVisibility();
}

function toggleLabel(t) {
  if (S.activeLabels.has(t)) S.activeLabels.delete(t); else S.activeLabels.add(t);
  applyVisibility();
}
function selectAllLabels()   { S.activeLabels = new Set(S.labels); applyVisibility(); }
function deselectAllLabels() { S.activeLabels.clear(); applyVisibility(); }

function applyVisibility() {
  document.querySelectorAll(".entity").forEach(el => {
    el.style.display = S.activeLabels.has(el.dataset.type) ? "" : "none";
  });
  document.querySelectorAll(".legend-tag").forEach(el => {
    const on = S.activeLabels.has(el.dataset.type);
    el.classList.toggle("inactive", !on);
  });
}

// ── Utility ───────────────────────────────────────────────
function _qs(id) { return document.getElementById(id); }
