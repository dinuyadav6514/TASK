// ============================================================
// Task Terminal — core state, persistence, boot sequence
// ============================================================

const DB_FILENAME = "tasks_data.json";
const LS_FALLBACK_KEY = "task-terminal-fallback-v1";
const IDB_NAME = "TaskTerminalDB";
const IDB_STORE = "file_handles";
const IDB_KEY = "tasks_data_handle";

let state = {
  tasks: [],       // { id, name, category, status, createdAt, dueDate, notes, history: [{date, action, note}], progress }
  categories: ["general"],
  meta: { version: 2 },
};

let currentDir = "~"; // "~" for root, or category name e.g. "backend", or virtual status e.g. "done"
let fileHandle = null;      // Active File System Access API handle
let savedFileHandle = null; // Handle found in IndexedDB awaiting re-authorization
let usingFallback = false;  // true if using localStorage instead of a real file

const output = document.getElementById("terminal-output");
const screen = document.getElementById("terminal-screen");
const hiddenInput = document.getElementById("hidden-input");
const typedText = document.getElementById("typed-text");
const saveStatus = document.getElementById("save-status");
const inputLine = document.getElementById("input-line");
const promptPath = document.getElementById("prompt-path");

let commandHistory = [];
let historyIndex = -1;

function ensureCategories() {
  if (!Array.isArray(state.categories)) {
    state.categories = ["general"];
  }
  const cleanCategories = [];
  const seenLower = new Set();

  state.categories.forEach(c => {
    if (!c) return;
    const trimmed = c.trim().replace(/\/$/, "");
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (!seenLower.has(lower)) {
      seenLower.add(lower);
      cleanCategories.push(trimmed);
    }
  });

  if (!seenLower.has("general")) {
    cleanCategories.unshift("general");
    seenLower.add("general");
  }

  state.categories = cleanCategories;

  state.tasks.forEach(t => {
    if (!t.category) {
      t.category = "general";
      return;
    }
    const tLower = t.category.trim().replace(/\/$/, "").toLowerCase();
    const match = state.categories.find(c => c.toLowerCase() === tLower);
    if (match) {
      t.category = match;
    } else {
      const cleanCat = t.category.trim().replace(/\/$/, "");
      state.categories.push(cleanCat);
      seenLower.add(tLower);
    }
  });
}

function updatePrompt() {
  const p = document.getElementById("prompt-path");
  if (p) {
    p.textContent = currentDir === "~" ? "~" : `~/${currentDir}`;
  }
  const termTitle = document.getElementById("terminal-title");
  if (termTitle) {
    termTitle.textContent = `task-terminal — ${currentDir === "~" ? "~" : currentDir}`;
  }
}

// ------------------------------------------------------------
// Utilities
// ------------------------------------------------------------

function uid() {
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function daysBetween(a, b) {
  const ms = new Date(b) - new Date(a);
  return Math.round(ms / 86400000);
}

// ------------------------------------------------------------
// Output rendering helpers
// ------------------------------------------------------------

function printLine(text, cls) {
  const div = document.createElement("div");
  div.className = "line" + (cls ? " " + cls : "");
  div.innerHTML = text;
  output.appendChild(div);
  scrollToBottom();
  return div;
}

function printHTML(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  output.appendChild(div);
  scrollToBottom();
  return div;
}

function printSpacer() {
  const div = document.createElement("div");
  div.className = "line spacer";
  output.appendChild(div);
}

function printEcho(cmdText) {
  const div = document.createElement("div");
  div.className = "echo-line";
  div.innerHTML = `<span class="echo-prompt">guest@tasks:~$</span> ${escapeHtml(cmdText)}`;
  output.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    screen.scrollTop = screen.scrollHeight;
  });
}

async function typeLine(text, cls, speed) {
  return new Promise(resolve => {
    const div = document.createElement("div");
    div.className = "line" + (cls ? " " + cls : "");
    output.appendChild(div);
    let i = 0;
    const chars = text.length;
    const step = () => {
      div.textContent = text.slice(0, i);
      i++;
      scrollToBottom();
      if (i <= chars) {
        setTimeout(step, speed || 8);
      } else {
        resolve();
      }
    };
    step();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ------------------------------------------------------------
// IndexedDB handle storage for File System Access API
// ------------------------------------------------------------

function openIdb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("IndexedDB not supported"));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeFileHandle(handle) {
  try {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    return false;
  }
}

async function getStoredFileHandle() {
  try {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------
// Persistence — File System Access API + IndexedDB + Fallbacks
// ------------------------------------------------------------

function supportsFileSystemAccess() {
  return "showSaveFilePicker" in window && "showOpenFilePicker" in window;
}

function updateSaveStatus() {
  if (fileHandle) {
    saveStatus.textContent = `●  linked: ${DB_FILENAME}`;
    saveStatus.className = "tb-status linked";
    saveStatus.title = `Data is saved directly to ${DB_FILENAME} on disk. Click to change file.`;
  } else if (savedFileHandle) {
    saveStatus.textContent = `●  click to connect ${DB_FILENAME}`;
    saveStatus.className = "tb-status connect-prompt";
    saveStatus.title = `Found previously linked ${DB_FILENAME}. Click to authorize direct disk saving.`;
  } else if (usingFallback) {
    saveStatus.textContent = `●  browser storage (click to link ${DB_FILENAME})`;
    saveStatus.className = "tb-status unsaved";
    saveStatus.title = `Currently using browser storage. Click to link ${DB_FILENAME} on disk.`;
  } else {
    saveStatus.textContent = `●  link ${DB_FILENAME}`;
    saveStatus.className = "tb-status";
    saveStatus.title = `Click to link ${DB_FILENAME} on disk.`;
  }
}

// Click on titlebar status to authorize or link file
saveStatus.addEventListener("click", async () => {
  if (savedFileHandle && !fileHandle) {
    try {
      const perm = await savedFileHandle.requestPermission({ mode: "readwrite" });
      if (perm === "granted") {
        fileHandle = savedFileHandle;
        const file = await fileHandle.getFile();
        const text = await file.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          parsed = null;
        }
        if (parsed && Array.isArray(parsed.tasks)) {
          if (state.tasks.length > 0 && parsed.tasks.length === 0) {
            await persist();
          } else {
            state = parsed;
          }
        }
        usingFallback = false;
        updateSaveStatus();
        printLine(`[✓] Connected to ${DB_FILENAME}. Changes will now save directly to disk.`, "green");
        return;
      }
    } catch (e) {
      console.warn("Re-authorization prompt failed:", e);
    }
  }
  await cmdLinkFile();
});

saveStatus.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    saveStatus.click();
  }
});

async function persist() {
  if (typeof window.notifyDiskSaved === "function") {
    window.notifyDiskSaved();
  }
  const json = JSON.stringify(state, null, 2);

  // Always keep localStorage updated as secondary backup
  try {
    localStorage.setItem(LS_FALLBACK_KEY, json);
  } catch (err) {
    /* ignore storage quota errors */
  }

  if (fileHandle) {
    try {
      if (typeof window.notifyDiskSaved === "function") {
        window.notifyDiskSaved();
      }
      const writable = await fileHandle.createWritable();
      await writable.write(json);
      await writable.close();
      if (typeof window.notifyDiskSaved === "function") {
        window.notifyDiskSaved();
      }
      usingFallback = false;
      updateSaveStatus();
      return true;
    } catch (err) {
      printLine(`[warn] Could not write to ${DB_FILENAME} (${err.message}). Saved to browser backup.`, "amber");
      usingFallback = true;
      updateSaveStatus();
    }
  } else {
    usingFallback = true;
    updateSaveStatus();
  }
  return false;
}

async function tryAutoConnectFile() {
  if (!supportsFileSystemAccess()) return false;
  try {
    const handle = await getStoredFileHandle();
    if (!handle) return false;
    savedFileHandle = handle;

    const query = await handle.queryPermission({ mode: "readwrite" });
    if (query === "granted") {
      fileHandle = handle;
      const file = await handle.getFile();
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        parsed = null;
      }
      if (parsed && Array.isArray(parsed.tasks)) {
        state = parsed;
        ensureCategories();
        usingFallback = false;
        updateSaveStatus();
        return true;
      }
    }
  } catch (err) {
    console.warn("Auto-connect file handle failed:", err);
  }
  updateSaveStatus();
  return false;
}

async function loadFromHttpFile() {
  try {
    const res = await fetch("./" + DB_FILENAME + "?t=" + Date.now());
    if (res.ok) {
      const parsed = await res.json();
      if (parsed && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
        state = parsed;
        ensureCategories();
        return true;
      }
    }
  } catch (err) {
    /* ignore fetch error (offline or local file://) */
  }
  return false;
}

async function loadFromFallback() {
  try {
    const raw = localStorage.getItem(LS_FALLBACK_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.tasks)) {
        state = parsed;
        ensureCategories();
        usingFallback = true;
        return true;
      }
    }
  } catch (err) {
    /* ignore corrupted fallback */
  }
  return false;
}

async function linkExistingFile() {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "Task data (JSON)", accept: { "application/json": [".json"] } }],
      excludeAcceptAllOption: false,
    });
    const file = await handle.getFile();
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = { tasks: [], meta: { version: 1 } };
    }
    if (!parsed || !Array.isArray(parsed.tasks)) {
      parsed = { tasks: [], meta: { version: 1 } };
    }

    // Sync in-memory tasks to file if file was empty
    if (state.tasks.length > 0 && parsed.tasks.length === 0) {
      parsed.tasks = state.tasks;
    }

    fileHandle = handle;
    savedFileHandle = handle;
    state = parsed;
    ensureCategories();
    usingFallback = false;
    await storeFileHandle(handle);
    await persist();
    updateSaveStatus();
    return true;
  } catch (err) {
    if (err.name === "AbortError") return false;
    printLine(`[error] Could not link file: ${err.message}`, "red");
    return false;
  }
}

async function createNewFile() {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: DB_FILENAME,
      types: [{ description: "Task data (JSON)", accept: { "application/json": [".json"] } }],
    });
    fileHandle = handle;
    savedFileHandle = handle;
    usingFallback = false;
    await storeFileHandle(handle);
    await persist();
    updateSaveStatus();
    return true;
  } catch (err) {
    if (err.name === "AbortError") return false;
    printLine(`[error] Could not create file: ${err.message}`, "red");
    return false;
  }
}

function cmdExport() {
  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = DB_FILENAME;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  printLine(`[✓] Exported ${DB_FILENAME} (${state.tasks.length} tasks).`, "green");
}

function cmdImport() {
  const fileInput = document.getElementById("import-file-input");
  if (!fileInput) {
    printLine("[error] Import input element not found in DOM.", "red");
    return;
  }
  fileInput.value = "";
  fileInput.onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (pe) {
        printLine(`[error] Invalid JSON in ${escapeHtml(file.name)}: ${pe.message}`, "red");
        return;
      }
      if (!parsed || !Array.isArray(parsed.tasks)) {
        printLine("[error] Invalid task file: JSON must contain a 'tasks' array.", "red");
        return;
      }
      state = parsed;
      ensureCategories();
      await persist();
      updatePrompt();
      updateSaveStatus();
      printLine(`[✓] Successfully imported ${state.tasks.length} task(s) and ${state.categories.length} category folder(s) from ${escapeHtml(file.name)}.`, "green");
    } catch (err) {
      printLine(`[error] Failed to read ${escapeHtml(file.name)}: ${escapeHtml(err.message)}`, "red");
    }
  };
  fileInput.click();
  printLine("Opening file picker — select a JSON task backup file...", "dim");
}

async function cmdReset(force = false) {
  if (!force) {
    printLine(`[warn] This will reset your tasks to the default ${DB_FILENAME} template and overwrite browser storage.`, "amber");
    printLine(`To confirm, type: <span class="blue" style="display:inline">reset --confirm</span> or <span class="blue" style="display:inline">reload --confirm</span>`, "dim");
    return;
  }
  try {
    const res = await fetch("./" + DB_FILENAME + "?t=" + Date.now());
    if (res.ok) {
      const parsed = await res.json();
      if (parsed && Array.isArray(parsed.tasks)) {
        state = parsed;
        ensureCategories();
        await persist();
        updatePrompt();
        updateSaveStatus();
        printLine(`[✓] Successfully reset workspace to default ${DB_FILENAME} (${state.tasks.length} tasks).`, "green");
        return;
      }
    }
    printLine(`[error] Could not load default ${DB_FILENAME} from server.`, "red");
  } catch (err) {
    printLine(`[error] Reset failed: ${err.message}`, "red");
  }
}

// ------------------------------------------------------------
// Task data model
// ------------------------------------------------------------

const STATUSES = ["pending", "progress", "done", "overdue"];

function findTask(name) {
  if (!name) return null;
  let lower = name.trim().toLowerCase();
  if (lower.startsWith("#")) lower = lower.slice(1).trim();
  return state.tasks.find(t => t.name.toLowerCase() === lower || (t.id && t.id.toLowerCase() === lower));
}

function findTaskFuzzy(name) {
  if (!name) return null;
  const exact = findTask(name);
  if (exact) return exact;
  let lower = name.trim().toLowerCase();
  if (lower.startsWith("#")) lower = lower.slice(1).trim();
  return state.tasks.find(t => t.name.toLowerCase().includes(lower) || (t.id && t.id.toLowerCase().includes(lower)));
}

function addTask(name, opts = {}) {
  let category = opts.category;
  if (!category) {
    if (currentDir !== "~" && !STATUSES.includes(currentDir.toLowerCase())) {
      category = currentDir;
    } else {
      category = "general";
    }
  }

  const cleanCat = (category || "general").trim().replace(/\/+$/, "") || "general";
  const catMatch = state.categories.find(c => c.toLowerCase() === cleanCat.toLowerCase());
  if (catMatch) {
    category = catMatch;
  } else {
    // Ensure all intermediate categories exist
    const segments = cleanCat.split("/").filter(Boolean);
    let currentAccum = "";
    segments.forEach(seg => {
      currentAccum = currentAccum ? currentAccum + "/" + seg : seg;
      const match = state.categories.find(c => c.toLowerCase() === currentAccum.toLowerCase());
      if (!match) {
        state.categories.push(currentAccum);
      }
    });
    category = cleanCat;
  }

  const initialStatus = opts.status || (currentDir.toLowerCase() === "done" ? "done" : currentDir.toLowerCase() === "progress" ? "progress" : "pending");
  const initialProgress = opts.progress !== undefined ? opts.progress : (initialStatus === "done" ? 100 : 0);
  const customId = (opts.id || "").trim() || uid();

  const task = {
    id: customId,
    name: name.trim(),
    category: category,
    status: initialStatus,
    createdAt: nowISO(),
    dueDate: opts.dueDate || null,
    notes: opts.notes || "",
    progress: initialProgress,
    history: [{ date: nowISO(), action: "created", note: `Task created in [${category}/]${opts.id ? ` with id [#${customId}]` : ""}` }],
  };
  state.tasks.push(task);
  return task;
}

function removeTask(name) {
  const task = findTaskFuzzy(name);
  if (!task) return null;
  state.tasks = state.tasks.filter(t => t.id !== task.id);
  return task;
}

function setStatus(task, status, note) {
  task.status = status;
  task.history.push({ date: nowISO(), action: "status_change", note: note || `Status set to ${status}` });
  if (status === "done") task.progress = 100;
}

function setProgress(task, pct) {
  task.progress = Math.max(0, Math.min(100, pct));
  task.history.push({ date: nowISO(), action: "progress", note: `Progress set to ${task.progress}%` });
  if (task.progress === 100) task.status = "done";
  else if (task.progress > 0 && task.status === "pending") task.status = "progress";
}

function logActivity(task, note) {
  task.history.push({ date: nowISO(), action: "log", note: note || "Activity logged" });
}

function computeDerivedStatus(task) {
  if (task.status === "done") return "done";
  if (task.dueDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (task.dueDate < today) return "overdue";
  }
  return task.status;
}

function statusLabel(status) {
  const map = { pending: "Pending", progress: "In Progress", done: "Done", overdue: "Overdue" };
  return map[status] || status;
}

// ------------------------------------------------------------
// Charts — progress trend (canvas line/area chart)
// ------------------------------------------------------------

function buildProgressTrendCanvas(task) {
  const canvas = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = 560, cssHeight = 140;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = cssWidth + "px";
  canvas.style.height = cssHeight + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  // Build a progress-over-time series from history
  const points = [];
  let runningProgress = 0;
  task.history.forEach(h => {
    if (h.action === "progress") {
      const match = /Progress set to (\d+)%/.exec(h.note || "");
      if (match) runningProgress = parseInt(match[1], 10);
    }
    if (h.action === "status_change" && /done/i.test(h.note || "")) {
      runningProgress = 100;
    }
    points.push({ date: h.date, value: runningProgress });
  });
  if (points.length === 0 || points[points.length - 1].value !== task.progress) {
    points.push({ date: nowISO(), value: task.progress });
  }

  const padL = 34, padR = 12, padT = 14, padB = 22;
  const plotW = cssWidth - padL - padR;
  const plotH = cssHeight - padT - padB;

  // Grid lines
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.font = "9.5px 'SF Mono', monospace";
  ctx.fillStyle = "#6b8f74";
  [0, 25, 50, 75, 100].forEach(v => {
    const y = padT + plotH - (v / 100) * plotH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillText(v + "%", 2, y + 3);
  });

  if (points.length >= 1) {
    const n = points.length;
    const xFor = i => padL + (n === 1 ? plotW : (i / (n - 1)) * plotW);
    const yFor = v => padT + plotH - (v / 100) * plotH;

    // Area fill
    ctx.beginPath();
    ctx.moveTo(xFor(0), yFor(points[0].value));
    points.forEach((p, i) => ctx.lineTo(xFor(i), yFor(p.value)));
    ctx.lineTo(xFor(n - 1), padT + plotH);
    ctx.lineTo(xFor(0), padT + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, "rgba(74,222,128,0.35)");
    grad.addColorStop(1, "rgba(74,222,128,0.02)");
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xFor(i), y = yFor(p.value);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(74,222,128,0.6)";
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Dots
    points.forEach((p, i) => {
      const x = xFor(i), y = yFor(p.value);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "#4ade80";
      ctx.fill();
    });
  }

  return canvas;
}

// ------------------------------------------------------------
// Charts — activity heatmap (GitHub-style, last ~10 weeks)
// ------------------------------------------------------------

function buildHeatmap(task) {
  const wrap = document.createElement("div");

  const counts = {}; // date -> activity count
  task.history.forEach(h => {
    const d = h.date.slice(0, 10);
    counts[d] = (counts[d] || 0) + 1;
  });

  const weeks = 10;
  const days = weeks * 7;
  const today = new Date();
  const grid = document.createElement("div");
  grid.className = "heatmap-grid";

  // Align so grid ends today, arranged column-major (7 rows = days of week)
  const cellsByDate = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    cellsByDate.push(d.toISOString().slice(0, 10));
  }

  const maxCount = Math.max(1, ...Object.values(counts));

  cellsByDate.forEach(dateStr => {
    const cell = document.createElement("div");
    const count = counts[dateStr] || 0;
    let level = "";
    if (count > 0) {
      const ratio = count / maxCount;
      level = ratio > 0.75 ? "l4" : ratio > 0.5 ? "l3" : ratio > 0.25 ? "l2" : "l1";
    }
    cell.className = "heat-cell" + (level ? " " + level : "");
    cell.title = `${dateStr}: ${count} event${count === 1 ? "" : "s"}`;
    grid.appendChild(cell);
  });

  wrap.appendChild(grid);

  const legend = document.createElement("div");
  legend.className = "heatmap-legend";
  legend.innerHTML = `Less
    <span class="heat-cell" style="display:inline-block"></span>
    <span class="heat-cell l1" style="display:inline-block"></span>
    <span class="heat-cell l2" style="display:inline-block"></span>
    <span class="heat-cell l3" style="display:inline-block"></span>
    <span class="heat-cell l4" style="display:inline-block"></span>
    More · last ${weeks} weeks`;
  wrap.appendChild(legend);

  return wrap;
}

// ------------------------------------------------------------
// Charts — overview bar chart (tasks by status, for open_tasks)
// ------------------------------------------------------------

function buildStatusBarCanvas() {
  const counts = { pending: 0, progress: 0, done: 0, overdue: 0 };
  state.tasks.forEach(t => {
    counts[computeDerivedStatus(t)] = (counts[computeDerivedStatus(t)] || 0) + 1;
  });

  const canvas = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = 420, cssHeight = 110;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = cssWidth + "px";
  canvas.style.height = cssHeight + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const colors = { pending: "#f5c451", progress: "#62b8f5", done: "#4ade80", overdue: "#f56565" };
  const labels = { pending: "Pending", progress: "Active", done: "Done", overdue: "Overdue" };
  const keys = Object.keys(counts);
  const maxVal = Math.max(1, ...Object.values(counts));

  const padL = 8, padB = 22, padT = 10;
  const barW = 60, gap = 30;
  const plotH = cssHeight - padT - padB;

  ctx.font = "10px 'SF Mono', monospace";

  keys.forEach((key, i) => {
    const x = padL + i * (barW + gap);
    const val = counts[key];
    const h = (val / maxVal) * plotH;
    const y = padT + plotH - h;

    ctx.fillStyle = colors[key];
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, barW, h, 4);
    } else {
      ctx.rect(x, y, barW, h);
    }
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = "#d7ffe0";
    ctx.textAlign = "center";
    ctx.fillText(String(val), x + barW / 2, y - 4);

    ctx.fillStyle = "#6b8f74";
    ctx.fillText(labels[key], x + barW / 2, cssHeight - 6);
  });

  return canvas;
}

// ------------------------------------------------------------
// Command handlers
// ------------------------------------------------------------

function cmdHelp() {
  printSpacer();
  printLine("TASK TERMINAL — LINUX SHELL COMMANDS", "bold green");
  const sections = [
    {
      title: "TASKS & FILES",
      rows: [
        ["tasks [--tree|--table]", "Directory-grouped task overview (flowchart tree or table)"],
        ["ls [-l] [dir]", "List category folders & tasks (use -l for detailed table)"],
        ["tree (or flowchart)", "Display flowchart tree of directories & tasks"],
        ["touch &lt;name&gt; [#id &lt;id&gt;]", "Create task / assign custom short ID (e.g. #id t1)"],
        ["cat &lt;task|file&gt;", "View full detail view, trend chart, heatmap & history"],
        ["rm [-r] &lt;task|dir&gt;", "Delete a task or category folder (-r for recursive)"],
        ["cp &lt;src&gt; &lt;dest&gt;", "Duplicate a task to a new name"],
        ["mv &lt;src&gt; &lt;dest&gt;", "Move task to folder (e.g. mv task backend/) or rename"],
        ["echo &lt;text&gt; &gt;&gt; &lt;task&gt;", "Append note/activity log to a task"],
      ]
    },
    {
      title: "FOLDERS & NAVIGATION",
      rows: [
        ["mkdir &lt;folder&gt;", "Create a new task category/folder (saved to tasks_data.json)"],
        ["rmdir &lt;folder&gt;", "Remove an empty category folder (or rm -r to remove all)"],
        ["cd &lt;dir|..|~&gt;", "Navigate into a folder or status view (done, pending, etc.)"],
        ["pwd", "Print current working directory path"],
      ]
    },
    {
      title: "TASK MANAGEMENT",
      rows: [
        ["id task &lt;name&gt; as &lt;id&gt;", "Assign/update short ID for quick access (or 'id' to list)"],
        ["progress &lt;task&gt; &lt;0-100&gt;", "Update task completion percentage"],
        ["status &lt;task&gt; &lt;status&gt;", "Set status directly (pending, progress, done, overdue)"],
        ["due &lt;task&gt; &lt;YYYY-MM-DD|none&gt;", "Set, update, or clear a task due date"],
        ["note &lt;task&gt; &lt;text&gt;", "Log an activity note onto a task"],
        ["stats (or dashboard)", "Display overall dashboard with status chart"],
      ]
    },
    {
      title: "SYSTEM UTILITIES",
      rows: [
        ["grep &lt;pattern&gt;", "Search across tasks, notes, categories & history"],
        ["ps (or top)", "Process status table of active / in-progress tasks"],
        ["df [-h]", "Show filesystem storage & tasks_data.json status"],
        ["cal / date", "Display ASCII month calendar and current date/time"],
        ["whoami", "Print current user (guest)"],
        ["uname -a", "Print system kernel and OS architecture"],
        ["wc [-l]", "Print task, folder, and word counts"],
        ["whereis &lt;cmd&gt;", "Locate binary executable path"],
        ["sort", "Sort tasks by name, progress, or due date"],
        ["clear (or cls)", "Clear terminal output"],
        ["man &lt;cmd&gt;", "Display manual page for any command"],
      ]
    },
    {
      title: "DATA & PERSISTENCE",
      rows: [
        ["link (or link_file)", "Link tasks_data.json on disk to save directly"],
        ["new_file", "Create a brand-new tasks_data.json file on disk"],
        ["export (or download)", "Download current tasks as tasks_data.json file"],
        ["import (or upload)", "Upload and restore tasks from a JSON backup file"],
        ["reset (or reload)", "Reset workspace to server template (use --confirm)"],
      ]
    }
  ];

  sections.forEach(sec => {
    printLine(sec.title, "bold dim");
    const table = document.createElement("table");
    table.className = "task-table";
    table.style.margin = "4px 0 10px";
    table.innerHTML = "<tbody>" + sec.rows.map(r =>
      `<tr><td style="color:#62b8f5;white-space:nowrap;width:240px">${r[0]}</td><td class="dim">${r[1]}</td></tr>`
    ).join("") + "</tbody>";
    output.appendChild(table);
  });

  printLine("Tip: Standard shell quotes like <span class=\"blue\" style=\"display:inline\">touch \"Deploy API\"</span> or <span class=\"blue\" style=\"display:inline\">cat \"Deploy API\"</span> are supported.", "dim");
  scrollToBottom();
}

// ------------------------------------------------------------
// Linux Shell Command Implementations
// ------------------------------------------------------------

function cmdPwd() {
  if (currentDir === "~" || !currentDir) {
    printLine("/home/guest/tasks");
  } else {
    printLine(`/home/guest/tasks/${currentDir}`);
  }
}

let previousDir = "~";

function resolveCategoryPath(baseDir, targetPath) {
  const raw = (targetPath || "").trim();
  if (!raw || raw === "~" || raw === "/" || raw === "home") {
    return "~";
  }

  let segments = [];
  if (raw.startsWith("~/")) {
    segments = [];
    raw.slice(2).split("/").forEach(p => segments.push(p));
  } else if (raw.startsWith("/")) {
    segments = [];
    raw.slice(1).split("/").forEach(p => segments.push(p));
  } else {
    if (baseDir && baseDir !== "~" && baseDir !== "/" && !STATUSES.includes(baseDir.toLowerCase())) {
      baseDir.split("/").filter(Boolean).forEach(p => segments.push(p));
    }
    raw.split("/").forEach(p => segments.push(p));
  }

  const resolved = [];
  for (const part of segments) {
    const cleanPart = part.trim();
    if (!cleanPart || cleanPart === ".") continue;
    if (cleanPart === "..") {
      if (resolved.length > 0) resolved.pop();
    } else {
      resolved.push(cleanPart);
    }
  }

  if (resolved.length === 0) return "~";
  return resolved.join("/");
}

function cmdCd(target) {
  const cleanRaw = (target || "").trim();
  if (cleanRaw === "-") {
    const temp = currentDir;
    currentDir = previousDir || "~";
    previousDir = temp;
    updatePrompt();
    printLine(currentDir === "~" ? "/home/guest/tasks" : `/home/guest/tasks/${currentDir}`);
    return;
  }

  const clean = cleanRaw.replace(/\/+$/, "");

  if (!clean || clean === "~" || clean === "/" || clean === "home") {
    previousDir = currentDir;
    currentDir = "~";
    updatePrompt();
    return;
  }

  if (clean === ".") {
    return;
  }

  // Check virtual status directories first (e.g. 'cd done', 'cd progress')
  const statusLower = clean.toLowerCase();
  const statusMatch = STATUSES.find(s => s === statusLower || (statusLower === "active" && s === "progress") || (statusLower === "in-progress" && s === "progress"));
  if (statusMatch) {
    previousDir = currentDir;
    currentDir = statusMatch;
    updatePrompt();
    return;
  }

  // Resolve path relative to currentDir
  const resolved = resolveCategoryPath(currentDir, clean);
  if (resolved === "~") {
    previousDir = currentDir;
    currentDir = "~";
    updatePrompt();
    return;
  }

  // 1. Try matching resolved relative/absolute path in categories
  const resolvedLower = resolved.toLowerCase();
  const catMatch = state.categories.find(c => c.toLowerCase() === resolvedLower);
  if (catMatch) {
    previousDir = currentDir;
    currentDir = catMatch;
    updatePrompt();
    return;
  }

  // 2. Direct match against any category name in state.categories
  const directMatch = state.categories.find(c => c.toLowerCase() === clean.toLowerCase());
  if (directMatch) {
    previousDir = currentDir;
    currentDir = directMatch;
    updatePrompt();
    return;
  }

  printLine(`cd: no such file or directory: ${escapeHtml(cleanRaw)}`, "red");
}

function cmdMkdir(dirName) {
  if (!dirName) {
    printLine("mkdir: missing operand", "amber");
    return;
  }
  const cleanRaw = dirName.trim().replace(/\/+$/, "");
  if (!cleanRaw) {
    printLine("mkdir: invalid directory name", "amber");
    return;
  }

  // Disallow creating directories inside virtual status view
  if (STATUSES.includes(currentDir.toLowerCase())) {
    printLine(`mkdir: cannot create directory inside status view '${escapeHtml(currentDir)}'. Switch to a category or root first.`, "amber");
    return;
  }

  // Resolve target directory relative to currentDir
  const targetPath = resolveCategoryPath(currentDir, cleanRaw);
  if (targetPath === "~") {
    printLine("mkdir: invalid directory name", "amber");
    return;
  }

  const targetLower = targetPath.toLowerCase();
  const segments = targetPath.split("/");

  // Check reserved names
  for (const seg of segments) {
    const sLower = seg.toLowerCase();
    if (STATUSES.includes(sLower) || sLower === "tasks" || sLower === "root" || sLower === "home") {
      printLine(`mkdir: cannot create directory '${escapeHtml(cleanRaw)}': Reserved system name`, "amber");
      return;
    }
  }

  // Check if directory already exists
  if (state.categories.some(c => c.toLowerCase() === targetLower)) {
    printLine(`mkdir: cannot create directory '${escapeHtml(cleanRaw)}': Directory exists`, "amber");
    return;
  }

  // Ensure intermediate parent categories exist
  let currentAccum = "";
  segments.forEach(seg => {
    currentAccum = currentAccum ? currentAccum + "/" + seg : seg;
    const match = state.categories.find(c => c.toLowerCase() === currentAccum.toLowerCase());
    if (!match) {
      state.categories.push(currentAccum);
    }
  });

  persist();
  printLine(`[✓] Created directory <span class="dir-item" style="display:inline">${escapeHtml(targetPath)}/</span>`, "green");
}

function cmdRmdir(dirName, force = false) {
  if (!dirName) {
    printLine("rmdir: missing operand", "amber");
    return;
  }
  const cleanRaw = dirName.trim().replace(/\/+$/, "");
  const targetPath = resolveCategoryPath(currentDir, cleanRaw);
  const targetLower = targetPath.toLowerCase();

  let catIdx = state.categories.findIndex(c => c.toLowerCase() === targetLower);
  if (catIdx === -1) {
    catIdx = state.categories.findIndex(c => c.toLowerCase() === cleanRaw.toLowerCase());
  }

  if (catIdx === -1) {
    printLine(`rmdir: failed to remove '${escapeHtml(cleanRaw)}': No such directory`, "red");
    return;
  }

  const catName = state.categories[catIdx];
  const catLower = catName.toLowerCase();
  if (catLower === "general") {
    printLine(`rmdir: cannot remove default 'general' directory`, "amber");
    return;
  }

  const childDirs = state.categories.filter(c => c.toLowerCase() !== catLower && c.toLowerCase().startsWith(catLower + "/"));
  const tasksInDir = state.tasks.filter(t => (t.category || "general").toLowerCase() === catLower || (t.category || "").toLowerCase().startsWith(catLower + "/"));

  if ((childDirs.length > 0 || tasksInDir.length > 0) && !force) {
    printLine(`rmdir: failed to remove '${escapeHtml(cleanRaw)}': Directory not empty (${childDirs.length} subfolder(s), ${tasksInDir.length} task(s)). Use 'rm -r ${escapeHtml(cleanRaw)}' to remove folder and contents.`, "amber");
    return;
  }

  if (force) {
    state.tasks = state.tasks.filter(t => {
      const tCat = (t.category || "general").toLowerCase();
      return tCat !== catLower && !tCat.startsWith(catLower + "/");
    });
  }

  state.categories = state.categories.filter(c => {
    const cLower = c.toLowerCase();
    return cLower !== catLower && !cLower.startsWith(catLower + "/");
  });

  if (currentDir.toLowerCase() === catLower || currentDir.toLowerCase().startsWith(catLower + "/")) {
    currentDir = resolveCategoryPath(catName, "..");
    updatePrompt();
  }

  persist();
  printLine(`[✓] Removed directory: ${escapeHtml(catName)}/`, "green");
}

function cmdTouch(rawArgs) {
  let name = Array.isArray(rawArgs) ? rawArgs.join(" ").trim() : (rawArgs || "").trim();
  if (!name) {
    printLine("touch: missing file operand", "amber");
    return;
  }

  // Extract #id <customId> if present, e.g.:
  // touch new_task_one #id t1
  // touch "new task one" #id t1
  // touch new_task_one #t1
  // touch company/new_task_one #id t1
  let customId = null;
  const idPattern = /\s+#id(?:\s*[:=]?\s*|\s+)(["']?)([a-zA-Z0-9_\-\.]+)\1\s*$/i;
  const idMatch = name.match(idPattern);
  if (idMatch) {
    customId = idMatch[2];
    name = name.slice(0, idMatch.index).trim();
  } else {
    // Also support #<id> at the end if not #id
    const hashPattern = /\s+#([a-zA-Z0-9_\-\.]+)\s*$/;
    const hashMatch = name.match(hashPattern);
    if (hashMatch && hashMatch[1].toLowerCase() !== "id") {
      customId = hashMatch[1];
      name = name.slice(0, hashMatch.index).trim();
    }
  }

  // Strip wrapping quotes from task name if present
  name = name.replace(/^["']|["']$/g, "").trim();

  // Support path syntax: e.g. "backend/API Task" or "in <category>"
  let targetCategory = null;

  // Check for "in <category>" syntax, e.g. "touch task1 in GATE/MATH"
  const inPattern = /\s+in\s+([a-zA-Z0-9_\-\.\/]+)\s*$/i;
  const inMatch = name.match(inPattern);
  if (inMatch) {
    targetCategory = resolveCategoryPath(currentDir, inMatch[1].trim());
    name = name.slice(0, inMatch.index).trim().replace(/^["']|["']$/g, "");
  }

  // Support path prefix syntax: e.g. "GATE/MATH/API Task" or "MATH/API Task"
  const slashIdx = name.lastIndexOf("/");
  if (slashIdx !== -1) {
    const folderPrefix = name.slice(0, slashIdx).trim();
    const taskNamePart = name.slice(slashIdx + 1).trim();
    if (folderPrefix && taskNamePart) {
      targetCategory = resolveCategoryPath(currentDir, folderPrefix);
      name = taskNamePart.replace(/^["']|["']$/g, "").trim();
    }
  }

  if (!name) {
    printLine("touch: missing file operand", "amber");
    return;
  }

  // Validate customId if provided
  if (customId) {
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(customId)) {
      printLine(`[!] Invalid ID '${escapeHtml(customId)}'. IDs can only contain letters, numbers, hyphens, and underscores.`, "amber");
      return;
    }
    const duplicate = state.tasks.find(t => t.id.toLowerCase() === customId.toLowerCase());
    if (duplicate && duplicate.name.toLowerCase() !== name.toLowerCase()) {
      printLine(`[!] Task ID '${escapeHtml(customId)}' is already taken by '${escapeHtml(duplicate.name)}'. Please choose a unique ID.`, "red");
      return;
    }
  }

  const existing = findTask(name);
  if (existing) {
    if (customId && existing.id.toLowerCase() !== customId.toLowerCase()) {
      const oldId = existing.id;
      existing.id = customId;
      logActivity(existing, `ID updated from [${oldId}] to [${customId}] via touch`);
      persist();
      printLine(`[✓] ${escapeHtml(existing.name)} timestamp and ID updated to <span class="task-id-tag">#${escapeHtml(existing.id)}</span>.`, "green");
      return;
    }
    logActivity(existing, "File touched (timestamp updated)");
    persist();
    printLine(`[✓] ${escapeHtml(existing.name)} timestamp updated.`, "dim");
    return;
  }

  const task = addTask(name, { category: targetCategory, id: customId });
  persist();
  printLine(`[✓] Created task: <span class="line green bold" style="display:inline">${escapeHtml(task.name)}</span> <span class="task-id-tag">#${escapeHtml(task.id)}</span> <span class="category-pill">${escapeHtml(task.category)}/</span>`, "green");
  printLine(`    id: ${task.id} · status: ${task.status} · created: ${task.createdAt.slice(0,10)}`, "dim");
  printLine(`    tip: access directly via <span class="blue">cat ${escapeHtml(task.id)}</span> or <span class="blue">progress ${escapeHtml(task.id)} &lt;%&gt;</span>`, "dim");
}

function buildCategoryTree(categories, tasks, baseRoot = "general") {
  const isAllRoot = (baseRoot === "~" || baseRoot === "/" || baseRoot === "home" || baseRoot.toLowerCase() === "general" || !baseRoot);
  const rootDisplay = isAllRoot ? "general" : baseRoot;

  const root = {
    name: rootDisplay,
    fullPath: isAllRoot ? "general" : baseRoot,
    subdirs: new Map(),
    tasks: []
  };

  function getOrCreateNode(pathStr) {
    if (!pathStr) return root;
    const clean = pathStr.trim().replace(/\/+$/, "");
    if (!clean) return root;

    const lower = clean.toLowerCase();
    const baseLower = baseRoot.toLowerCase();

    // If scoped to a specific directory (not root/general)
    if (!isAllRoot) {
      if (lower === baseLower) return root;
      if (!lower.startsWith(baseLower + "/")) {
        return null; // Outside scope of this subtree
      }
      const relPath = clean.slice(baseRoot.length + 1);
      const parts = relPath.split("/").filter(Boolean);
      let current = root;
      let currentPath = baseRoot;
      for (const part of parts) {
        currentPath = currentPath + "/" + part;
        const pLower = part.toLowerCase();
        if (!current.subdirs.has(pLower)) {
          current.subdirs.set(pLower, {
            name: part,
            fullPath: currentPath,
            subdirs: new Map(),
            tasks: []
          });
        }
        current = current.subdirs.get(pLower);
      }
      return current;
    }

    // Root / general view
    if (lower === "general") return root;
    const parts = clean.split("/").filter(Boolean);
    if (parts.length > 0 && parts[0].toLowerCase() === "general") {
      parts.shift();
    }
    if (parts.length === 0) return root;

    let current = root;
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? currentPath + "/" + part : part;
      const pLower = part.toLowerCase();
      if (!current.subdirs.has(pLower)) {
        current.subdirs.set(pLower, {
          name: part,
          fullPath: currentPath,
          subdirs: new Map(),
          tasks: []
        });
      }
      current = current.subdirs.get(pLower);
    }
    return current;
  }

  categories.forEach(cat => getOrCreateNode(cat));
  tasks.forEach(task => {
    const node = getOrCreateNode(task.category || "general");
    if (node) node.tasks.push(task);
  });

  return root;
}

function renderTreeIndent(level) {
  if (level <= 0) return "";
  const spaces = "   ".repeat(level);
  return `<span class="tree-indent" style="width:${level * 3}ch;min-width:${level * 3}ch;display:inline-block;flex-shrink:0;white-space:pre">${spaces}</span>`;
}

function cmdLs(args = []) {
  const flags = args.filter(a => a.startsWith("-"));
  const nonFlags = args.filter(a => !a.startsWith("-"));

  const wantsTable = flags.some(f => f.includes("l")) ||
                     args.some(a => a.toLowerCase() === "--table" || a.toLowerCase() === "table" || a.toLowerCase() === "tabular");

  const dirKeywords = ["table", "tabular", "tree", "flowchart"];
  const cleanNonFlags = nonFlags.filter(a => !dirKeywords.includes(a.toLowerCase()));

  let targetDir = currentDir;
  if (cleanNonFlags.length > 0) {
    const resolved = resolveCategoryPath(currentDir, cleanNonFlags[0]);
    targetDir = resolved === "~" ? "~" : resolved;
  }

  const isRoot = (targetDir === "~" || targetDir === "/" || targetDir === "home" || !targetDir);
  const isStatusView = STATUSES.includes(targetDir.toLowerCase());

  function renderSubTree(container, node, indentLevel, isDirectRoot) {
    if (isDirectRoot) {
      // Direct tasks of root
      node.tasks.forEach(t => {
        const taskLine = document.createElement("div");
        taskLine.className = "tree-line";
        const status = computeDerivedStatus(t);
        const dueStr = t.dueDate ? ` <span class="dim" style="font-size:11px">(due: ${escapeHtml(t.dueDate)})</span>` : "";
        taskLine.innerHTML = `${renderTreeIndent(1)}<span class="tree-branch-symbol">\\-</span><span class="tree-task-entry"><span class="task-id-tag">#${escapeHtml(t.id)}</span> <span class="status-pill ${status}" style="font-size:9px;padding:1px 5px">${t.progress}%</span> <span class="tree-task-title">${escapeHtml(t.name)}</span>${dueStr}</span>`;
        taskLine.querySelector(".tree-task-entry").addEventListener("click", () => cmdCat(t.id));
        container.appendChild(taskLine);
      });

      // Subdirectories under root
      for (const [_, sub] of node.subdirs) {
        renderSubTree(container, sub, 0, false);
      }

      if (node.tasks.length === 0 && node.subdirs.size === 0) {
        const emptyLine = document.createElement("div");
        emptyLine.className = "tree-line";
        emptyLine.innerHTML = `${renderTreeIndent(1)}<span class="tree-branch-symbol">\\-</span><span class="tree-empty-label">(empty)</span>`;
        container.appendChild(emptyLine);
      }
      return;
    }

    // Directory line: e.g. "\- company" (level 0) or "   \- MATH" (level 1)
    const dirLine = document.createElement("div");
    dirLine.className = "tree-line";
    const dirIndentHtml = renderTreeIndent(indentLevel);
    dirLine.innerHTML = `${dirIndentHtml}<span class="tree-branch-symbol">\\-</span><span class="tree-folder-title" title="cd ${escapeHtml(node.fullPath)}">${escapeHtml(node.name)}</span>`;
    dirLine.querySelector(".tree-folder-title").addEventListener("click", () => {
      cmdCd(node.fullPath);
      cmdLs();
    });
    container.appendChild(dirLine);

    const childLevel = indentLevel + 1;
    const childIndentHtml = renderTreeIndent(childLevel);

    if (node.tasks.length === 0 && node.subdirs.size === 0) {
      const emptyLine = document.createElement("div");
      emptyLine.className = "tree-line";
      emptyLine.innerHTML = `${childIndentHtml}<span class="tree-branch-symbol">\\-</span><span class="tree-empty-label">(empty)</span>`;
      container.appendChild(emptyLine);
    } else {
      // Print tasks in this directory
      node.tasks.forEach(t => {
        const taskLine = document.createElement("div");
        taskLine.className = "tree-line";
        const status = computeDerivedStatus(t);
        const dueStr = t.dueDate ? ` <span class="dim" style="font-size:11px">(due: ${escapeHtml(t.dueDate)})</span>` : "";
        taskLine.innerHTML = `${childIndentHtml}<span class="tree-branch-symbol">\\-</span><span class="tree-task-entry"><span class="task-id-tag">#${escapeHtml(t.id)}</span> <span class="status-pill ${status}" style="font-size:9px;padding:1px 5px">${t.progress}%</span> <span class="tree-task-title">${escapeHtml(t.name)}</span>${dueStr}</span>`;
        taskLine.querySelector(".tree-task-entry").addEventListener("click", () => cmdCat(t.id));
        container.appendChild(taskLine);
      });

      // Nested subdirectories
      for (const [_, sub] of node.subdirs) {
        renderSubTree(container, sub, childLevel, false);
      }
    }
  }

  // 1. Root View: Simple Text Tree
  if (isRoot) {
    printSpacer();

    if (wantsTable) {
      // Tabular View if explicitly requested with 'tasks --table' or 'tasks -l'
      state.categories.forEach(cat => {
        const catTasks = state.tasks.filter(t => (t.category || "general").toLowerCase() === cat.toLowerCase());
        const countBadge = `<span class="dim">(${catTasks.length} task${catTasks.length === 1 ? '' : 's'})</span>`;
        printLine(`📁 DIRECTORY: <span class="blue bold" style="display:inline">${escapeHtml(cat)}/</span> ${countBadge}`, "green");

        if (catTasks.length === 0) {
          printLine(`  <span class="dim" style="font-style:italic;padding-left:14px">(empty folder)</span>`);
          printSpacer();
          return;
        }

        const table = document.createElement("table");
        table.className = "task-table";
        const rows = catTasks.map(t => {
          const status = computeDerivedStatus(t);
          const due = t.dueDate ? t.dueDate : "—";
          const perm = status === "done" ? "-rwxr-xr-x" : "-rw-r--r--";
          return `<tr>
            <td class="dim" style="font-family:monospace;font-size:11px">${perm}</td>
            <td><span class="task-id-tag">#${escapeHtml(t.id)}</span></td>
            <td style="color:#d7ffe0;cursor:pointer">${escapeHtml(t.name)}</td>
            <td><span class="status-pill ${status}">${statusLabel(status)}</span></td>
            <td class="dim">${t.progress}%</td>
            <td class="dim">${due}</td>
            <td class="dim">${t.createdAt.slice(0,10)}</td>
          </tr>`;
        }).join("");

        table.innerHTML = `<thead><tr>
            <th>Mode</th><th>ID</th><th>Task Name</th><th>Status</th><th>Progress</th><th>Due</th><th>Created</th>
          </tr></thead><tbody>${rows}</tbody>`;

        table.querySelectorAll("tbody tr").forEach((tr, i) => {
          const t = catTasks[i];
          if (t) {
            tr.style.cursor = "pointer";
            tr.title = `Click to view details (cat ${t.id})`;
            tr.addEventListener("click", () => cmdCat(t.id));
          }
        });

        output.appendChild(table);
      });

      printLine(`Total: ${state.categories.length} folders, ${state.tasks.length} tasks. Type 'tasks' for text tree view.`, "dim");
      scrollToBottom();
      return;
    }

    // Default Simple Text Tree
    const treeRoot = buildCategoryTree(state.categories, state.tasks, "general");
    const container = document.createElement("div");
    container.className = "tree-wrap";

    // Print Root Line: "general"
    const rootLine = document.createElement("div");
    rootLine.className = "tree-line";
    rootLine.innerHTML = `<span style="color:#4ade80;font-weight:700">${escapeHtml(treeRoot.name)}</span>`;
    container.appendChild(rootLine);

    renderSubTree(container, treeRoot, 0, true);
    output.appendChild(container);

    printLine(`Total: ${state.categories.length} folders, ${state.tasks.length} tasks. Type 'tasks --table' for tabular view.`, "dim");
    scrollToBottom();
    return;
  }

  // 2. Subdirectory View (e.g. after 'cd company' or 'cd GATE' or 'cd GATE/MATH')
  if (!isStatusView) {
    printSpacer();

    if (wantsTable) {
      const catTasks = state.tasks.filter(t => (t.category || "general").toLowerCase() === targetDir.toLowerCase());
      printLine(`📁 DIRECTORY: <span class="blue bold" style="display:inline">${escapeHtml(targetDir)}/</span> <span class="dim">(${catTasks.length} task${catTasks.length === 1 ? '' : 's'})</span>`, "bold green");

      if (catTasks.length === 0) {
        printLine(`Directory '${escapeHtml(targetDir)}' has no direct tasks.`, "dim");
      } else {
        const table = document.createElement("table");
        table.className = "task-table";
        const rows = catTasks.map(t => {
          const status = computeDerivedStatus(t);
          const due = t.dueDate ? t.dueDate : "—";
          const perm = status === "done" ? "-rwxr-xr-x" : "-rw-r--r--";
          return `<tr>
            <td class="dim" style="font-family:monospace;font-size:11px">${perm}</td>
            <td><span class="task-id-tag">#${escapeHtml(t.id)}</span></td>
            <td style="color:#d7ffe0">${escapeHtml(t.name)}</td>
            <td><span class="category-pill">${escapeHtml(t.category || "general")}</span></td>
            <td><span class="status-pill ${status}">${statusLabel(status)}</span></td>
            <td class="dim">${t.progress}%</td>
            <td class="dim">${due}</td>
            <td class="dim">${t.createdAt.slice(0,10)}</td>
          </tr>`;
        }).join("");

        table.innerHTML = `<thead><tr>
            <th>Mode</th><th>ID</th><th>Name</th><th>Category</th><th>Status</th><th>Progress</th><th>Due</th><th>Created</th>
          </tr></thead><tbody>${rows}</tbody>`;

        table.querySelectorAll("tbody tr").forEach((tr, i) => {
          const t = catTasks[i];
          if (t) {
            tr.style.cursor = "pointer";
            tr.title = `Click to view details (cat ${t.id})`;
            tr.addEventListener("click", () => cmdCat(t.id));
          }
        });

        output.appendChild(table);
      }
      scrollToBottom();
      return;
    }

    // Default Scoped Text Tree
    const treeRoot = buildCategoryTree(state.categories, state.tasks, targetDir);
    const container = document.createElement("div");
    container.className = "tree-wrap";

    const rootLine = document.createElement("div");
    rootLine.className = "tree-line";
    rootLine.innerHTML = `<span style="color:#4ade80;font-weight:700">📁 ${escapeHtml(treeRoot.name)}/</span>`;
    container.appendChild(rootLine);

    renderSubTree(container, treeRoot, 0, true);
    output.appendChild(container);

    const directTasks = state.tasks.filter(t => (t.category || "general").toLowerCase() === targetDir.toLowerCase());
    printLine(`${directTasks.length} task(s) directly in [${escapeHtml(targetDir)}/]. Type 'cd ..' to go up.`, "dim");
    scrollToBottom();
    return;
  }

  // 3. Status View (e.g. 'cd done', 'cd progress', 'cd pending')
  const visibleTasks = state.tasks.filter(t => computeDerivedStatus(t) === targetDir.toLowerCase());
  printSpacer();
  const subContainer = document.createElement("div");
  subContainer.className = "tree-wrap";

  const dirHeader = document.createElement("div");
  dirHeader.className = "tree-line";
  dirHeader.innerHTML = `<span style="color:#4ade80;font-weight:700">⚙ ${escapeHtml(targetDir)}</span> <span class="dim" style="font-size:11px">(${visibleTasks.length} task${visibleTasks.length === 1 ? '' : 's'})</span>`;
  subContainer.appendChild(dirHeader);

  if (visibleTasks.length === 0) {
    const emptyLine = document.createElement("div");
    emptyLine.className = "tree-line";
    emptyLine.innerHTML = `${renderTreeIndent(1)}<span class="tree-branch-symbol">\\-</span><span class="tree-empty-label">(empty)</span>`;
    subContainer.appendChild(emptyLine);
  } else {
    visibleTasks.forEach(t => {
      const tLine = document.createElement("div");
      tLine.className = "tree-line";
      const status = computeDerivedStatus(t);
      const catBadge = `<span class="category-pill">${escapeHtml(t.category || "general")}</span>`;
      const dueStr = t.dueDate ? ` <span class="dim" style="font-size:11px">(due: ${escapeHtml(t.dueDate)})</span>` : "";
      tLine.innerHTML = `${renderTreeIndent(1)}<span class="tree-branch-symbol">\\-</span><span class="tree-task-entry"><span class="task-id-tag">#${escapeHtml(t.id)}</span> ${catBadge}<span class="status-pill ${status}" style="font-size:9px;padding:1px 5px">${t.progress}%</span> <span class="tree-task-title">${escapeHtml(t.name)}</span>${dueStr}</span>`;
      tLine.querySelector(".tree-task-entry").addEventListener("click", () => cmdCat(t.id));
      subContainer.appendChild(tLine);
    });
  }

  output.appendChild(subContainer);
  printLine(`${visibleTasks.length} task(s) in status [${escapeHtml(targetDir)}]. Type 'cd ~' to return to root.`, "dim");
  scrollToBottom();
}

function cmdCat(target) {
  if (!target) {
    printLine("cat: missing operand", "amber");
    return;
  }
  const clean = target.trim();
  if (clean === "tasks_data.json" || clean === "tasks-data.json" || clean === "./tasks_data.json") {
    printSpacer();
    printLine(`// ${DB_FILENAME} (raw state on disk)`, "dim");
    const jsonStr = JSON.stringify(state, null, 2);
    const pre = document.createElement("pre");
    pre.style.color = "#a7f3d0";
    pre.style.fontSize = "11.5px";
    pre.style.lineHeight = "1.4";
    pre.style.margin = "6px 0";
    pre.style.overflowX = "auto";
    pre.textContent = jsonStr;
    output.appendChild(pre);
    scrollToBottom();
    return;
  }

  const task = findTaskFuzzy(clean);
  if (!task) {
    printLine(`cat: ${escapeHtml(clean)}: No such file or task. Try 'ls'`, "red");
    return;
  }
  cmdTaskDetail(task.name);
}

function cmdRm(args) {
  const flags = args.filter(a => a.startsWith("-"));
  const nonFlags = args.filter(a => !a.startsWith("-"));
  const isRecursive = flags.some(f => f.includes("r"));

  if (nonFlags.length === 0) {
    printLine("rm: missing operand", "amber");
    return;
  }
  const target = nonFlags.join(" ").trim();

  // Check if target is a category folder
  const cat = state.categories.find(c => c.toLowerCase() === target.toLowerCase().replace(/\/$/, ""));
  if (cat) {
    if (!isRecursive) {
      printLine(`rm: cannot remove '${escapeHtml(target)}': Is a directory (use 'rm -r ${escapeHtml(target)}')`, "amber");
      return;
    }
    cmdRmdir(cat, true);
    return;
  }

  const task = removeTask(target);
  if (!task) {
    printLine(`rm: cannot remove '${escapeHtml(target)}': No such file or directory`, "red");
    return;
  }
  printLine(`[✓] Removed task: ${escapeHtml(task.name)}`, "green");
  persist();
}

function cmdMv(src, dest) {
  if (!src || !dest) {
    printLine("mv: missing source or destination operand (Usage: mv <task> <folder|new_name|status>)", "amber");
    return;
  }
  const task = findTaskFuzzy(src);
  if (!task) {
    printLine(`mv: cannot stat '${escapeHtml(src)}': No such task`, "red");
    return;
  }
  const cleanDest = dest.trim().replace(/\/$/, "");

  // 1. Move to a category folder
  const catMatch = state.categories.find(c => c.toLowerCase() === cleanDest.toLowerCase());
  if (catMatch || cleanDest === "~" || cleanDest === "root" || cleanDest === ".." || cleanDest === "../") {
    const newCat = catMatch || "general";
    task.category = newCat;
    logActivity(task, `Moved to folder [${newCat}/]`);
    persist();
    printLine(`[✓] Moved '${escapeHtml(task.name)}' → [${escapeHtml(newCat)}/]`, "green");
    return;
  }

  // 2. Move to a status
  if (STATUSES.includes(cleanDest.toLowerCase())) {
    setStatus(task, cleanDest.toLowerCase(), `Moved status to ${cleanDest}`);
    persist();
    printLine(`[✓] Moved '${escapeHtml(task.name)}' status → ${statusLabel(cleanDest)}`, "green");
    return;
  }

  // 3. Rename task
  const oldName = task.name;
  task.name = cleanDest;
  logActivity(task, `Renamed from '${oldName}'`);
  persist();
  printLine(`[✓] Renamed '${escapeHtml(oldName)}' → '${escapeHtml(task.name)}'`, "green");
}

function cmdCp(src, dest) {
  if (!src || !dest) {
    printLine("cp: missing file operand (Usage: cp <source_task> <new_task_name>)", "amber");
    return;
  }
  const task = findTaskFuzzy(src);
  if (!task) {
    printLine(`cp: cannot stat '${escapeHtml(src)}': No such task`, "red");
    return;
  }
  const newTask = addTask(dest, {
    category: task.category,
    dueDate: task.dueDate,
    notes: task.notes ? `[Copied from ${task.name}] ` + task.notes : ""
  });
  persist();
  printLine(`[✓] Copied '${escapeHtml(task.name)}' → '${escapeHtml(newTask.name)}'`, "green");
}

function cmdEcho(args, appendTarget = null) {
  if (appendTarget) {
    const task = findTaskFuzzy(appendTarget);
    if (!task) {
      printLine(`echo: target task '${escapeHtml(appendTarget)}' not found`, "red");
      return;
    }
    const noteText = Array.isArray(args) ? args.join(" ") : args;
    logActivity(task, noteText);
    persist();
    printLine(`[✓] Appended note to '${escapeHtml(task.name)}'`, "green");
    return;
  }
  const text = Array.isArray(args) ? args.join(" ") : args;
  printLine(escapeHtml(text));
}

function cmdGrep(pattern) {
  if (!pattern) {
    printLine("grep: missing search pattern", "amber");
    return;
  }
  let lower = pattern.toLowerCase();
  if (lower.startsWith("#")) lower = lower.slice(1).trim();
  const matches = state.tasks.filter(t =>
    (t.id || "").toLowerCase().includes(lower) ||
    t.name.toLowerCase().includes(lower) ||
    (t.category || "").toLowerCase().includes(lower) ||
    (t.notes || "").toLowerCase().includes(lower) ||
    t.history.some(h => (h.note || "").toLowerCase().includes(lower))
  );
  if (matches.length === 0) {
    printLine(`grep: no tasks found matching pattern "${escapeHtml(pattern)}"`, "dim");
    return;
  }
  printLine(`Found ${matches.length} matching task(s):`, "green bold");
  matches.forEach(t => {
    const status = computeDerivedStatus(t);
    printLine(`  <span class="task-id-tag">#${escapeHtml(t.id)}</span> <span class="dir-item">[${escapeHtml(t.category)}/]</span> <span class="status-pill ${status}">${statusLabel(status)}</span> <span class="bold" style="display:inline">${escapeHtml(t.name)}</span> (${t.progress}%)`);
  });
}

function cmdPs() {
  printSpacer();
  printLine("PID    TTY      TIME     STAT  TASK", "bold green");
  const active = state.tasks.filter(t => t.status !== "done");
  if (active.length === 0) {
    printLine("No active processes (all tasks done). Try 'ls' to see all tasks.", "dim");
    return;
  }
  active.forEach((t, i) => {
    const pid = 100 + i;
    const stat = t.status === "progress" ? "R" : "S";
    const min = String(Math.floor(i * 3 + 1)).padStart(2, "0");
    const sec = String(Math.floor((i * 17) % 60)).padStart(2, "0");
    const time = `00:${min}:${sec}`;
    const desc = `[#${escapeHtml(t.id)}] ${escapeHtml(t.name)} [${t.progress}% in ${escapeHtml(t.category)}/]`;
    printLine(`${pid.toString().padEnd(6)} pts/0    ${time} ${stat.padEnd(5)} ${desc}`);
  });
}

function cmdDf() {
  printSpacer();
  printLine("Filesystem          Size  Used  Avail Use% Mounted on", "bold green");
  const taskBytes = JSON.stringify(state).length;
  const usedKb = (taskBytes / 1024).toFixed(1) + "K";
  const source = fileHandle ? DB_FILENAME : "localStorage";
  printLine(`${source.padEnd(19)} 5.0M  ${usedKb.padEnd(5)} 5.0M   1% /home/guest/tasks`);
  printLine(`Storage driver: ${fileHandle ? "File System Access (Linked)" : "Browser LocalStorage"} · Tasks: ${state.tasks.length} · Folders: ${state.categories.length}`, "dim");
}

function cmdCal() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = now.getDate();
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  printSpacer();
  printLine(`    ${monthNames[month]} ${year}`, "bold green");
  printLine("Su Mo Tu We Th Fr Sa", "bold dim");

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let line = "".padStart(firstDay * 3, " ");
  for (let day = 1; day <= daysInMonth; day++) {
    const dStr = String(day).padStart(2, " ");
    if (day === today) {
      line += `<span class="bold green">[${dStr.trim()}]</span>`.padEnd(14, " ");
    } else {
      line += dStr + " ";
    }
    if ((firstDay + day) % 7 === 0 || day === daysInMonth) {
      printLine(line);
      line = "";
    }
  }
}

function cmdDate() {
  printLine(new Date().toString());
}

function cmdWc() {
  const total = state.tasks.length;
  const done = state.tasks.filter(t => t.status === "done").length;
  const words = state.tasks.reduce((sum, t) => sum + t.name.split(/\s+/).length, 0);
  printLine(`  ${total} tasks   ${state.categories.length} folders   ${words} words   (${done} completed)`);
}

function cmdWhoami() {
  printLine("guest");
}

function cmdUname(args = []) {
  if (args.includes("-a") || args.length === 0) {
    printLine("Linux task-terminal 6.8.0-generic x86_64 WebKernel/1.0 GNU/Linux");
  } else {
    printLine("Linux");
  }
}

function cmdWhereis(cmdName) {
  if (!cmdName) {
    printLine("whereis: missing command", "amber");
    return;
  }
  printLine(`${escapeHtml(cmdName)}: /usr/bin/${escapeHtml(cmdName)} /bin/${escapeHtml(cmdName)}`);
}

function cmdSort(args = []) {
  const flags = args.filter(a => a.startsWith("-"));
  let sorted = [...state.tasks];
  if (flags.includes("-n") || flags.includes("-p")) {
    sorted.sort((a, b) => b.progress - a.progress);
  } else if (flags.includes("-d")) {
    sorted.sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
  } else {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  }

  printSpacer();
  printLine(`SORTED TASKS (${sorted.length})`, "bold green");
  sorted.forEach(t => {
    const status = computeDerivedStatus(t);
    printLine(`  <span class="task-id-tag">#${escapeHtml(t.id)}</span> <span class="status-pill ${status}">${t.progress}%</span> <span class="dir-item">[${escapeHtml(t.category)}/]</span> ${escapeHtml(t.name)}`);
  });
}

function cmdMan(cmdName) {
  if (!cmdName || cmdName === "help") {
    cmdHelp();
    return;
  }
  const clean = cmdName.trim().toLowerCase();
  const manPages = {
    ls: {
      synopsis: "ls [-l] [-a] [directory]",
      desc: "List tasks and category folders. When executed in root, displays folders and tasks. Use -l for detailed permissions and progress table.",
      examples: "ls\nls -l\nls backend\nls done"
    },
    touch: {
      synopsis: "touch <task_name> [#id <id>]",
      desc: "Create a new task. When inside a category folder (via cd), task is automatically filed in that folder. Assign custom short IDs with '#id <id>' (e.g. #id t1) for easy referencing. If file exists, updates timestamp or updates ID.",
      examples: 'touch "Deploy Production API" #id api1\ntouch new_task_one #id t1\ntouch backend/"Setup Auth Service" #id auth'
    },
    id: {
      synopsis: "id task <task_name|id> as <new_id>\nid [list]",
      desc: "Assign, update, or list short task IDs. Allows easily referencing tasks in all other commands (cat, progress, status, due, rm, mv, etc.) without typing long names.",
      examples: 'id task "LV cable Sizing" as t1\nid task new_task_one as t1\nid\nid list'
    },
    mkdir: {
      synopsis: "mkdir <folder_name>",
      desc: "Create a new task category folder. Folders are persisted in tasks_data.json.",
      examples: "mkdir backend\nmkdir personal\nmkdir frontend"
    },
    rmdir: {
      synopsis: "rmdir <folder_name>",
      desc: "Remove an empty category folder. Use 'rm -r <folder>' to remove folder and all its tasks.",
      examples: "rmdir personal\nrm -r personal"
    },
    cd: {
      synopsis: "cd [directory|..|~]",
      desc: "Change working directory to a category folder or virtual status filter (done, pending, progress, overdue). Updates prompt path.",
      examples: "cd backend\ncd done\ncd .."
    },
    pwd: {
      synopsis: "pwd",
      desc: "Print current working directory path.",
      examples: "pwd"
    },
    cat: {
      synopsis: "cat <task_name|tasks_data.json>",
      desc: "View full detail view for a task (animated progress, trend chart, activity heatmap, notes), or print raw tasks_data.json content.",
      examples: 'cat "Deploy Production API"\ncat tasks_data.json'
    },
    rm: {
      synopsis: "rm [-r|-f] <task_name|folder>",
      desc: "Delete a task or category folder. Use -r to remove a folder and all its tasks.",
      examples: 'rm "Deploy Production API"\nrm -r backend'
    },
    mv: {
      synopsis: "mv <task> <folder|status|new_name>",
      desc: "Move a task into a category folder, move status (done, pending, progress), or rename the task.",
      examples: 'mv "Setup Auth" backend/\nmv "Setup Auth" done\nmv "Setup Auth" "Setup OAuth2"'
    },
    cp: {
      synopsis: "cp <source_task> <new_task_name>",
      desc: "Duplicate a task with a new name.",
      examples: 'cp "Design Database" "Design Database v2"'
    },
    echo: {
      synopsis: 'echo <text> >> <task>',
      desc: "Append a dated note or log entry to a task's history log.",
      examples: 'echo "Finished authentication refactor" >> "Setup Auth"'
    },
    grep: {
      synopsis: "grep <pattern>",
      desc: "Search tasks, categories, notes, and activity history for matching keywords.",
      examples: "grep api\ngrep database"
    },
    ps: {
      synopsis: "ps",
      desc: "Display active and in-progress tasks formatted like a Linux process status table.",
      examples: "ps"
    },
    df: {
      synopsis: "df [-h]",
      desc: "Show filesystem storage usage and backend linking state.",
      examples: "df -h"
    },
    export: {
      synopsis: "export\ndownload",
      desc: "Download all current tasks, categories, and history logs as a tasks_data.json backup file to your machine.",
      examples: "export\ndownload"
    },
    import: {
      synopsis: "import\nupload",
      desc: "Open a file dialog to select and restore tasks from a previously exported JSON backup file into your workspace.",
      examples: "import\nupload"
    },
    reset: {
      synopsis: "reset [--confirm|-f]\nreload [--confirm|-f]",
      desc: "Reset your local tasks workspace back to the server's default tasks_data.json template. Requires --confirm flag.",
      examples: "reset --confirm\nreload -f"
    }
  };

  const page = manPages[clean];
  if (!page) {
    printLine(`No manual entry for ${escapeHtml(clean)}. Type 'help' for available commands.`, "amber");
    return;
  }

  printSpacer();
  const div = document.createElement("div");
  div.className = "man-page";
  div.innerHTML = `
    <div class="man-head">${escapeHtml(clean).toUpperCase()}(1) — Task Shell Manual</div>
    <div class="man-section">
      <div class="man-sec-title">SYNOPSIS</div>
      <div class="man-sec-body"><code style="color:#62b8f5">${escapeHtml(page.synopsis)}</code></div>
    </div>
    <div class="man-section">
      <div class="man-sec-title">DESCRIPTION</div>
      <div class="man-sec-body">${escapeHtml(page.desc)}</div>
    </div>
    <div class="man-section">
      <div class="man-sec-title">EXAMPLES</div>
      <div class="man-sec-body"><pre style="margin:2px 0;color:#a7f3d0;font-size:11.5px">${escapeHtml(page.examples)}</pre></div>
    </div>
  `;
  output.appendChild(div);
  scrollToBottom();
}

// ------------------------------------------------------------
// Backward-Compatible Legacy Commands
// ------------------------------------------------------------

function cmdAddTask(name) {
  cmdTouch(name);
}

function cmdRemoveTask(name) {
  cmdRm([name]);
}

function cmdOpenTasks() {
  cmdLs(["-l"]);
}

function cmdStats() {
  printSpacer();
  printLine("DASHBOARD OVERVIEW", "bold green");

  const total = state.tasks.length;
  const done = state.tasks.filter(t => t.status === "done").length;
  const overdue = state.tasks.filter(t => computeDerivedStatus(t) === "overdue").length;
  const avgProgress = total ? Math.round(state.tasks.reduce((s, t) => s + t.progress, 0) / total) : 0;

  printLine(`Total tasks: ${total}   ·   Completed: ${done}   ·   Overdue: ${overdue}   ·   Avg progress: ${avgProgress}%`, "dim");

  if (total > 0) {
    const block = document.createElement("div");
    block.className = "chart-block";
    block.innerHTML = `<div class="chart-title">Tasks by status</div>`;
    block.appendChild(buildStatusBarCanvas());
    output.appendChild(block);
    scrollToBottom();
  }
}

function cmdTaskDetail(name) {
  if (!name) {
    printLine("Usage: cat &lt;task name&gt;", "amber");
    return;
  }
  const task = findTaskFuzzy(name);
  if (!task) {
    printLine(`[!] No task found matching "${escapeHtml(name)}". Try: ls`, "red");
    return;
  }

  const status = computeDerivedStatus(task);
  const cat = task.category || "general";
  printSpacer();
  printLine(`TASK: ${escapeHtml(task.name)} <span class="task-id-tag">#${escapeHtml(task.id)}</span>`, "bold green");
  printLine(`id: <span class="amber bold" style="display:inline">#${escapeHtml(task.id)}</span> · category: <span class="category-pill" style="display:inline-block">${escapeHtml(cat)}/</span> · status: <span class="status-pill ${status}" style="display:inline-block">${statusLabel(status)}</span>`, "dim");
  printHTML(`<div class="line dim">created: ${task.createdAt.slice(0,10)} &nbsp;·&nbsp; due: ${task.dueDate || "not set"}</div>`);

  const progRow = document.createElement("div");
  progRow.className = "progress-row";
  progRow.innerHTML = `
    <div class="progress-track"><div class="progress-fill" style="width:0%"></div></div>
    <div class="progress-label">${task.progress}%</div>
  `;
  output.appendChild(progRow);
  requestAnimationFrame(() => {
    setTimeout(() => {
      progRow.querySelector(".progress-fill").style.width = task.progress + "%";
    }, 50);
  });

  if (task.notes) {
    printLine(`notes: ${escapeHtml(task.notes)}`, "dim");
  }

  const trendBlock = document.createElement("div");
  trendBlock.className = "chart-block";
  trendBlock.innerHTML = `<div class="chart-title">Progress over time</div>`;
  trendBlock.appendChild(buildProgressTrendCanvas(task));
  output.appendChild(trendBlock);

  const heatBlock = document.createElement("div");
  heatBlock.className = "chart-block";
  heatBlock.innerHTML = `<div class="chart-title">Activity heatmap</div>`;
  heatBlock.appendChild(buildHeatmap(task));
  output.appendChild(heatBlock);

  printLine("RECENT ACTIVITY", "bold dim");
  const recent = task.history.slice(-8).reverse();
  const histLines = recent.map(h =>
    `<div class="line dim">  ${h.date.slice(0,16).replace("T"," ")}  —  ${escapeHtml(h.note || h.action)}</div>`
  ).join("");
  printHTML(histLines);

  scrollToBottom();
}

function cmdProgress(name, pctStr) {
  const task = findTaskFuzzy(name);
  if (!task) { printLine(`[!] No task found matching "${escapeHtml(name)}".`, "red"); return; }
  const pct = parseInt(pctStr, 10);
  if (isNaN(pct)) { printLine("Usage: progress &lt;name&gt; &lt;0-100&gt;", "amber"); return; }
  setProgress(task, pct);
  printLine(`[✓] ${escapeHtml(task.name)} progress → ${task.progress}%`, "green");
  persist();
}

function cmdStatus(name, statusStr) {
  const task = findTaskFuzzy(name);
  if (!task) { printLine(`[!] No task found matching "${escapeHtml(name)}".`, "red"); return; }
  let s = (statusStr || "").trim().toLowerCase();
  if (s === "in progress" || s === "in-progress" || s === "active") s = "progress";
  if (s === "complete" || s === "completed") s = "done";
  if (!STATUSES.includes(s)) {
    printLine(`Usage: status &lt;name&gt; &lt;${STATUSES.join("|")}&gt;`, "amber");
    return;
  }
  setStatus(task, s);
  printLine(`[✓] ${escapeHtml(task.name)} status → ${statusLabel(s)}`, "green");
  persist();
}

function cmdDue(name, dateStr) {
  const task = findTaskFuzzy(name);
  if (!task) { printLine(`[!] No task found matching "${escapeHtml(name)}".`, "red"); return; }
  const d = (dateStr || "").trim().toLowerCase();
  if (d === "none" || d === "clear" || d === "remove") {
    task.dueDate = null;
    task.history.push({ date: nowISO(), action: "due_date", note: "Due date cleared" });
    printLine(`[✓] ${escapeHtml(task.name)} due date cleared`, "green");
    persist();
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    printLine("Usage: due &lt;name&gt; &lt;YYYY-MM-DD|none&gt;", "amber");
    return;
  }
  task.dueDate = d;
  task.history.push({ date: nowISO(), action: "due_date", note: `Due date set to ${d}` });
  printLine(`[✓] ${escapeHtml(task.name)} due date → ${d}`, "green");
  persist();
}

function cmdNote(name, noteText) {
  const task = findTaskFuzzy(name);
  if (!task) { printLine(`[!] No task found matching "${escapeHtml(name)}".`, "red"); return; }
  if (!noteText) { printLine("Usage: note &lt;name&gt; &lt;text&gt;", "amber"); return; }
  logActivity(task, noteText.trim());
  printLine(`[✓] Note logged on ${escapeHtml(task.name)}.`, "green");
  persist();
}

function cmdId(args = [], rawInput = "") {
  if (args.length === 0 || (args.length === 1 && (args[0] === "list" || args[0] === "-l"))) {
    printSpacer();
    printLine("TASK IDENTIFIERS", "bold green");
    if (state.tasks.length === 0) {
      printLine("No tasks created yet. Use 'touch <name> #id <id>' to create one.", "dim");
      return;
    }
    state.tasks.forEach(t => {
      const status = computeDerivedStatus(t);
      printLine(`  <span class="task-id-tag">#${escapeHtml(t.id)}</span> <span class="status-pill ${status}" style="font-size:9px;padding:1px 5px">${t.progress}%</span> <span class="dir-item">[${escapeHtml(t.category || "general")}/]</span> <span style="color:#d7ffe0">${escapeHtml(t.name)}</span>`);
    });
    printLine(`Tip: assign or update an ID using <span class="blue" style="display:inline">id task &lt;task&gt; as &lt;id&gt;</span>`, "dim");
    scrollToBottom();
    return;
  }

  let tokens = [...args];

  // Remove leading "task" keyword if present (e.g. "id task new_task_one as t1")
  if (tokens.length >= 2 && tokens[0].toLowerCase() === "task") {
    tokens.shift();
  }

  if (tokens.length === 0) {
    printLine("Usage: id task &lt;name&gt; as &lt;new_id&gt; (e.g. id task new_task_one as t1)", "amber");
    return;
  }

  let taskQuery = "";
  let newIdRaw = "";

  const asIdx = tokens.findIndex(t => t.toLowerCase() === "as");
  if (asIdx !== -1) {
    taskQuery = tokens.slice(0, asIdx).join(" ").trim();
    newIdRaw = tokens.slice(asIdx + 1).join(" ").trim();
  } else if (tokens.length >= 2) {
    newIdRaw = tokens[tokens.length - 1].trim();
    taskQuery = tokens.slice(0, -1).join(" ").trim();
  } else {
    printLine("Usage: id task &lt;name&gt; as &lt;new_id&gt; (e.g. id task new_task_one as t1)", "amber");
    return;
  }

  taskQuery = taskQuery.replace(/^["']|["']$/g, "").trim();
  let cleanId = newIdRaw.replace(/^#id[:=\s]*/i, "").replace(/^#/, "").replace(/^["']|["']$/g, "").trim();

  if (!taskQuery || !cleanId) {
    printLine("Usage: id task &lt;name&gt; as &lt;new_id&gt; (e.g. id task new_task_one as t1)", "amber");
    return;
  }

  if (!/^[a-zA-Z0-9_\-\.]+$/.test(cleanId)) {
    printLine(`[!] Invalid ID '${escapeHtml(cleanId)}'. IDs can only contain letters, numbers, hyphens, and underscores.`, "amber");
    return;
  }

  const task = findTaskFuzzy(taskQuery);
  if (!task) {
    printLine(`id: no task found matching '${escapeHtml(taskQuery)}'. Try 'ls' or 'id list'`, "red");
    return;
  }

  const duplicate = state.tasks.find(t => t.id.toLowerCase() === cleanId.toLowerCase());
  if (duplicate && duplicate.id !== task.id) {
    printLine(`[!] Task ID '${escapeHtml(cleanId)}' is already taken by '${escapeHtml(duplicate.name)}'. Please choose a unique ID.`, "red");
    return;
  }

  const oldId = task.id;
  task.id = cleanId;
  task.history.push({
    date: nowISO(),
    action: "id_change",
    note: `ID changed from [${oldId}] to [${cleanId}]`
  });

  persist();
  printLine(`[✓] Updated task '${escapeHtml(task.name)}' ID: <span class="task-id-tag">#${escapeHtml(task.id)}</span> (was: ${escapeHtml(oldId)})`, "green");
  printLine(`    Access directly via: <span class="blue">cat ${escapeHtml(task.id)}</span>, <span class="blue">progress ${escapeHtml(task.id)} &lt;%&gt;</span>, <span class="blue">status ${escapeHtml(task.id)} &lt;status&gt;</span>`, "dim");
}

async function cmdLinkFile() {
  if (!supportsFileSystemAccess()) {
    printLine(`[!] Your browser doesn't support direct file linking. Use 'export' to download ${DB_FILENAME}.`, "amber");
    return;
  }
  printLine(`Opening file picker — select your ${DB_FILENAME}...`, "dim");
  const ok = await linkExistingFile();
  if (ok) {
    printLine(`[✓] Linked to ${DB_FILENAME}. All changes now save directly to your file on disk.`, "green");
  }
}

async function cmdNewFile() {
  if (!supportsFileSystemAccess()) {
    printLine(`[!] Your browser doesn't support direct file creation. Use 'export' to download ${DB_FILENAME}.`, "amber");
    return;
  }
  printLine(`Choose where to save your new ${DB_FILENAME}...`, "dim");
  const ok = await createNewFile();
  if (ok) {
    printLine(`[✓] New file created and linked. All changes now save directly to disk.`, "green");
  }
}

function cmdClear() {
  output.innerHTML = "";
}

// ------------------------------------------------------------
// Command Tokenizer & Parsing
// ------------------------------------------------------------

function tokenizeInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return { cmd: "", args: [], raw: "" };

  // 1. Check legacy colon syntax (e.g. "add_task : Task", "progress : Task : 50")
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx !== -1) {
    const beforeColon = trimmed.slice(0, colonIdx).trim();
    if (beforeColon && !beforeColon.includes(" ")) {
      const cmd = beforeColon.toLowerCase();
      const rest = trimmed.slice(colonIdx + 1);
      const colonArgs = rest.split(":").map(s => s.trim()).filter(s => s.length > 0);
      return { cmd, args: colonArgs, isColon: true, raw: trimmed };
    }
  }

  // 2. Check echo ... >> target redirection
  if (trimmed.startsWith("echo ") && trimmed.includes(">>")) {
    const parts = trimmed.split(">>");
    const echoPart = parts[0].replace(/^echo\s+/, "").trim();
    const targetPart = parts.slice(1).join(">>").trim();
    const cleanEcho = echoPart.replace(/^["']|["']$/g, "");
    const cleanTarget = targetPart.replace(/^["']|["']$/g, "");
    return { cmd: "echo_append", args: [cleanEcho, cleanTarget], isColon: false, raw: trimmed };
  }

  // 3. POSIX quotes and spaces tokenizer
  const tokens = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inQuotes) {
      if (ch === quoteChar) {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuotes = true;
      quoteChar = ch;
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  const cmd = (tokens[0] || "").toLowerCase();
  const args = tokens.slice(1);
  return { cmd, args, isColon: false, raw: trimmed };
}

async function handleCommand(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return;

  printEcho(trimmed);
  commandHistory.push(trimmed);
  historyIndex = commandHistory.length;

  const parsed = tokenizeInput(trimmed);
  const cmd = parsed.cmd;
  const args = parsed.args;

  switch (cmd) {
    // Help & Manuals
    case "man":
      cmdMan(args[0]);
      break;
    case "help":
    case "?":
      cmdHelp();
      break;

    // Directory & Category commands
    case "mkdir":
      cmdMkdir(args[0]);
      break;
    case "rmdir":
      cmdRmdir(args[0], false);
      break;
    case "cd":
      cmdCd(args[0]);
      break;
    case "cd..":
    case "cd../":
      cmdCd("..");
      break;
    case "pwd":
      cmdPwd();
      break;

    // File & Task listings
    case "ls":
    case "dir":
    case "list":
    case "list_tasks":
    case "open_tasks":
    case "tasks":
    case "tree":
    case "flowchart":
      cmdLs(args);
      break;

    // File / Task manipulation
    case "touch":
    case "add_task":
    case "add":
      cmdTouch(args.length > 0 ? args : parsed.raw.slice(cmd.length).trim());
      break;
    case "cat":
    case "task":
      cmdCat(args.join(" "));
      break;
    case "rm":
    case "del":
    case "delete":
    case "remove_task":
    case "delete_task":
      cmdRm(args);
      break;
    case "cp":
      cmdCp(args[0], args[1]);
      break;
    case "mv":
      cmdMv(args[0], args[1]);
      break;
    case "echo":
      cmdEcho(args);
      break;
    case "echo_append":
      cmdEcho(args[0], args[1]);
      break;
    case "grep":
      cmdGrep(args[0] || "");
      break;

    // Task attributes & IDs
    case "id":
    case "set_id":
    case "assign_id":
      cmdId(args, parsed.raw);
      break;
    case "progress":
      if (args.length >= 2) {
        const lastArg = args[args.length - 1];
        if (!isNaN(parseInt(lastArg, 10))) {
          const taskName = args.slice(0, -1).join(" ");
          cmdProgress(taskName, lastArg);
          break;
        }
      }
      cmdProgress(args[0], args[1]);
      break;
    case "status":
      if (args.length >= 2) {
        const lastArg = args[args.length - 1].toLowerCase();
        if (STATUSES.includes(lastArg) || ["in-progress", "active", "completed"].includes(lastArg)) {
          const taskName = args.slice(0, -1).join(" ");
          cmdStatus(taskName, lastArg);
          break;
        }
      }
      cmdStatus(args[0], args[1]);
      break;
    case "due":
      if (args.length >= 2) {
        const lastArg = args[args.length - 1];
        if (lastArg === "none" || lastArg === "clear" || /^\d{4}-\d{2}-\d{2}$/.test(lastArg)) {
          const taskName = args.slice(0, -1).join(" ");
          cmdDue(taskName, lastArg);
          break;
        }
      }
      cmdDue(args[0], args[1]);
      break;
    case "note":
      if (args.length >= 2) {
        cmdNote(args[0], args.slice(1).join(" "));
      } else {
        cmdNote(args[0], "");
      }
      break;

    // System Utilities
    case "ps":
    case "top":
      cmdPs();
      break;
    case "df":
      cmdDf();
      break;
    case "cal":
      cmdCal();
      break;
    case "date":
      cmdDate();
      break;
    case "whoami":
      cmdWhoami();
      break;
    case "uname":
      cmdUname(args);
      break;
    case "wc":
      cmdWc();
      break;
    case "whereis":
      cmdWhereis(args[0]);
      break;
    case "sort":
      cmdSort(args);
      break;
    case "stats":
    case "dashboard":
      cmdStats();
      break;

    // Persistence & Linking
    case "link":
    case "link_file":
    case "connect":
      await cmdLinkFile();
      break;
    case "new_file":
      await cmdNewFile();
      break;
    case "export":
    case "download":
      cmdExport();
      break;
    case "import":
    case "upload":
      cmdImport();
      break;
    case "reset":
    case "reload":
      await cmdReset(args.includes("--confirm") || args.includes("-f") || args.includes("--force"));
      break;

    // Terminal Screen
    case "clear":
    case "cls":
      cmdClear();
      break;

    default:
      printLine(`bash: ${escapeHtml(cmd)}: command not found. Type <span class="blue" style="display:inline">help</span> or <span class="blue" style="display:inline">man</span> for available commands.`, "red");
  }
}

// ------------------------------------------------------------
// Input handling
// ------------------------------------------------------------

window.addEventListener("scroll", () => {
  if (window.scrollY !== 0 || window.scrollX !== 0) {
    window.scrollTo(0, 0);
  }
});

function focusInput() {
  try {
    hiddenInput.focus({ preventScroll: true });
  } catch (err) {
    hiddenInput.focus();
  }
}

screen.addEventListener("click", focusInput);
const terminalShell = document.getElementById("terminal-shell");
if (terminalShell) {
  terminalShell.addEventListener("click", (e) => {
    // Avoid re-triggering if clicking on a clickable status or link
    if (!e.target.closest("#save-status") && !e.target.closest("a") && !e.target.closest("button")) {
      focusInput();
    }
  });
}

let lastTabPrefix = null;
let tabMatchIndex = 0;

function resetTabState() {
  lastTabPrefix = null;
  tabMatchIndex = 0;
}

hiddenInput.addEventListener("input", () => {
  resetTabState();
  typedText.textContent = hiddenInput.value;
});

hiddenInput.addEventListener("keydown", async e => {
  if (e.key !== "Tab") {
    resetTabState();
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const val = hiddenInput.value;
    hiddenInput.value = "";
    typedText.textContent = "";
    await handleCommand(val);
  } else if (e.key === "ArrowUp" && !e.shiftKey) {
    e.preventDefault();
    if (historyIndex > 0) {
      historyIndex--;
      hiddenInput.value = commandHistory[historyIndex] || "";
      typedText.textContent = hiddenInput.value;
    }
  } else if (e.key === "ArrowDown" && !e.shiftKey) {
    e.preventDefault();
    if (historyIndex < commandHistory.length - 1) {
      historyIndex++;
      hiddenInput.value = commandHistory[historyIndex] || "";
    } else {
      historyIndex = commandHistory.length;
      hiddenInput.value = "";
    }
    typedText.textContent = hiddenInput.value;
  } else if (e.key === "PageUp" || (e.key === "ArrowUp" && e.shiftKey)) {
    e.preventDefault();
    screen.scrollTop = Math.max(0, screen.scrollTop - (screen.clientHeight * 0.75));
  } else if (e.key === "PageDown" || (e.key === "ArrowDown" && e.shiftKey)) {
    e.preventDefault();
    screen.scrollTop = Math.min(screen.scrollHeight, screen.scrollTop + (screen.clientHeight * 0.75));
  } else if (e.key === "Tab") {
    e.preventDefault();
    autocomplete();
  }
});

function autocomplete() {
  const commandsWithArgs = [
    "touch", "cat", "rm", "mkdir", "rmdir", "cd", "cp", "mv",
    "grep", "man", "progress", "status", "due", "note", "whereis", "id", "tasks"
  ];
  const commandsWithoutArgs = [
    "ls", "pwd", "whoami", "uname", "ps", "top", "df", "cal", "date",
    "wc", "clear", "cls", "stats", "dashboard", "export", "download",
    "import", "upload", "reset", "reload",
    "link", "help", "?", "tree", "flowchart"
  ];

  let raw = hiddenInput.value.trim().toLowerCase();
  if (raw.endsWith(":")) raw = raw.slice(0, -1).trim();

  // 1. Argument completion for task-targeting commands
  const spaceIdx = raw.indexOf(" ");
  if (spaceIdx !== -1) {
    const cmdPart = raw.slice(0, spaceIdx).trim();
    let argPart = raw.slice(spaceIdx + 1).trim();
    const taskCommands = ["cat", "rm", "progress", "status", "due", "note", "mv", "cp", "id"];
    
    if (taskCommands.includes(cmdPart)) {
      let prefix = cmdPart;
      // Handle "id task <arg>"
      if (cmdPart === "id" && argPart.toLowerCase().startsWith("task ")) {
        prefix = "id task";
        argPart = argPart.slice(5).trim();
      }

      const taskCandidates = [];
      state.tasks.forEach(t => {
        if (t.id) {
          taskCandidates.push(t.id);
          taskCandidates.push("#" + t.id);
        }
        if (t.name) taskCandidates.push(t.name);
      });

      const matches = taskCandidates.filter(c => c.toLowerCase().startsWith(argPart));
      if (matches.length > 0) {
        if (!lastTabPrefix || lastTabPrefix !== argPart) {
          lastTabPrefix = argPart;
          tabMatchIndex = 0;
        } else {
          tabMatchIndex = (tabMatchIndex + 1) % matches.length;
        }
        const picked = matches[tabMatchIndex];
        const formatted = picked.includes(" ") ? `"${picked}"` : picked;
        hiddenInput.value = `${prefix} ${formatted}`;
        typedText.textContent = hiddenInput.value;
        return;
      }
    }

    const dirCommands = ["cd", "rmdir", "mkdir", "ls", "tasks"];
    if (dirCommands.includes(cmdPart)) {
      const dirCandidates = [];
      state.categories.forEach(c => {
        dirCandidates.push(c);
        dirCandidates.push(c + "/");
        if (currentDir !== "~" && c.toLowerCase().startsWith(currentDir.toLowerCase() + "/")) {
          const rel = c.slice(currentDir.length + 1);
          dirCandidates.push(rel);
          dirCandidates.push(rel + "/");
        }
      });
      if (cmdPart === "cd") {
        dirCandidates.push("..");
        dirCandidates.push("../");
        dirCandidates.push("~");
        STATUSES.forEach(s => dirCandidates.push(s));
      }

      const matches = Array.from(new Set(dirCandidates)).filter(c => c.toLowerCase().startsWith(argPart));
      if (matches.length > 0) {
        if (!lastTabPrefix || lastTabPrefix !== argPart) {
          lastTabPrefix = argPart;
          tabMatchIndex = 0;
        } else {
          tabMatchIndex = (tabMatchIndex + 1) % matches.length;
        }
        const picked = matches[tabMatchIndex];
        const formatted = picked.includes(" ") ? `"${picked}"` : picked;
        hiddenInput.value = `${cmdPart} ${formatted}`;
        typedText.textContent = hiddenInput.value;
        return;
      }
    }
  }

  // 2. First token / Command completion
  const folderCandidates = state.categories.map(c => c + "/");
  const statusCandidates = STATUSES.map(s => s + "/");
  const taskIdCandidates = [];
  state.tasks.forEach(t => {
    if (t.id) {
      taskIdCandidates.push(t.id);
      taskIdCandidates.push("#" + t.id);
    }
  });

  const allCommands = [
    ...commandsWithoutArgs,
    ...commandsWithArgs,
    ...folderCandidates,
    ...statusCandidates,
    ...taskIdCandidates
  ].sort();

  let matches = [];
  if (lastTabPrefix) {
    const prevMatches = allCommands.filter(c => c.startsWith(lastTabPrefix));
    if (raw === lastTabPrefix || prevMatches.includes(raw)) {
      matches = prevMatches;
      tabMatchIndex = (tabMatchIndex + 1) % matches.length;
    }
  }

  if (matches.length === 0) {
    lastTabPrefix = raw;
    tabMatchIndex = 0;
    if (!raw) return;
    matches = allCommands.filter(c => c.startsWith(raw));
    if (matches.length === 0) return;
  }

  const match = matches[tabMatchIndex];
  if (commandsWithArgs.includes(match)) {
    hiddenInput.value = match + " ";
  } else {
    hiddenInput.value = match;
  }
  typedText.textContent = hiddenInput.value;
}

// ------------------------------------------------------------
// Boot sequence
// ------------------------------------------------------------

async function runBootSequence() {
  inputLine.style.display = "none";

  const bootLines = [
    { text: "Linux task-terminal 6.8.0-generic x86_64 WebKernel/1.0", delay: 90 },
    { text: "Mounting virtual VFS [/] ... [ OK ]", delay: 80 },
    { text: "Initializing task command interpreter [ OK ]", delay: 70 },
    { text: `Checking for ${DB_FILENAME}...`, delay: 90 },
  ];

  for (const line of bootLines) {
    printLine(line.text, "boot-line");
    await sleep(line.delay);
  }

  // 1. Try to auto-reconnect previously linked file handle from IndexedDB
  const autoConnected = await tryAutoConnectFile();

  if (autoConnected) {
    printLine(`Mounted ${DB_FILENAME} [ OK ]`, "boot-line");
    printLine(`Loaded ${state.tasks.length} task(s) in ${state.categories.length} category folder(s).`, "boot-line");
  } else {
    // 2. Check browser storage first (preserves user tasks across reloads on Vercel/web)
    const restored = await loadFromFallback();
    if (restored && state.tasks.length > 0) {
      printLine(`Restored ${state.tasks.length} task(s) from browser storage [ OK ]`, "boot-line");
    } else {
      // 3. First-time visit: seed from tasks_data.json via HTTP fetch
      const httpLoaded = await loadFromHttpFile();
      if (httpLoaded && state.tasks.length > 0) {
        try {
          localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(state, null, 2));
        } catch (e) {}
        usingFallback = true;
        printLine(`Pre-loaded ${state.tasks.length} task(s) from ${DB_FILENAME} [ OK ]`, "boot-line");
      } else {
        usingFallback = true;
        printLine(`Ready with fresh task workspace.`, "boot-line");
      }
    }
  }

  await sleep(150);
  printSpacer();

  await typeLine("╔══════════════════════════════════════════════════════════╗", "green", 2);
  await typeLine("║          L I N U X   T A S K   S H E L L   v2.0           ║", "green bold", 3);
  await typeLine("╚══════════════════════════════════════════════════════════╝", "green", 2);
  printSpacer();

  await typeLine("Unix-style task tracker — organized with folders & touch.", "dim", 8);
  await sleep(70);
  await typeLine("Type 'help' or 'man' to see commands, or 'ls' to list your tasks.", "dim", 8);
  await sleep(70);

  if (fileHandle) {
    printLine(`[✓] Disk linked: Changes save directly to ${DB_FILENAME} on disk.`, "green");
  } else if (savedFileHandle) {
    printLine(`Tip: Click [● click to connect ${DB_FILENAME}] in the title bar or type 'link' to authorize disk saving.`, "amber");
  } else if (supportsFileSystemAccess()) {
    printLine(`Tip: Click [● link ${DB_FILENAME}] in the title bar or type 'link' to save directly to disk.`, "dim");
  } else {
    printLine(`[!] Direct file linking is not supported by this browser. Use 'export' to download ${DB_FILENAME}.`, "amber");
  }

  printSpacer();
  updateSaveStatus();
  updatePrompt();

  inputLine.style.display = "flex";
  focusInput();
}

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------

runBootSequence();
