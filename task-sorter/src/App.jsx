// task-sorter/src/App.jsx

import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";
import { motion, AnimatePresence, LayoutGroup, useReducedMotion } from "framer-motion";
import { fetchApi } from "./utils/api";

// Self-contained BitToByte family cross-link footer (plain inline styles — no
// dependency on the Tailwind-4 ui library, which this Tailwind-3 app can't ingest).
function BrandFooter() {
  const links = [
    { label: "BitToByte", href: "https://bittobyte.qzz.io" },
    { label: "Portfolio", href: "https://alex.bittobyte.qzz.io" },
    { label: "Express Entry", href: "https://EE.bittobyte.qzz.io" },
    { label: "AI Checklist", href: "https://checklist.bittobyte.qzz.io" },
  ];
  return (
    <footer
      style={{
        borderTop: "1px solid rgba(255,255,255,0.06)",
        background: "#030712",
        padding: "24px 16px",
        textAlign: "center",
        fontSize: 13,
        color: "#9ca3af",
      }}
    >
      <div style={{ marginBottom: 8 }}>
        © {new Date().getFullYear()} BitToByte
      </div>
      <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
        {links.map((l) => (
          <a
            key={l.href}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#9ca3af", textDecoration: "none" }}
          >
            {l.label}
          </a>
        ))}
      </div>
    </footer>
  );
}

const API = import.meta.env.DEV ? "http://localhost:8000" : "/api";

const PROPERTIES = [
  { key: "Priority",      label: "PRIORITY",   hex: "#f87171", bar: "#ef4444" },
  { key: "Urgency",       label: "URGENCY",    hex: "#fb923c", bar: "#f97316" },
  { key: "Importance",    label: "IMPORTANCE", hex: "#facc15", bar: "#eab308" },
  { key: "Relevance",     label: "RELEVANCE",  hex: "#34d399", bar: "#10b981" },
  { key: "Difficulty",    label: "DIFFICULTY", hex: "#c084fc", bar: "#a855f7" },
  { key: "Hierarchy",     label: "HIERARCHY",  hex: "#f472b6", bar: "#ec4899" },
  { key: "Time_Minutes",  label: "TIME (min)", hex: "#60a5fa", bar: "#3b82f6" },
];

// Priority & Hierarchy are managed in the Matrix tab; keep them out of the other views.
const MATRIX_PROP_KEYS = ["Priority", "Hierarchy"];
const SCORING_PROPS = PROPERTIES.filter((p) => !MATRIX_PROP_KEYS.includes(p.key));
const SCORING_PROP_KEYS = SCORING_PROPS.map((p) => p.key);

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("token");
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  
  try {
    return await fetchApi(`${API}${path}`, {
      headers: { ...headers, ...(options.headers || {}) },
      ...options,
    });
  } catch (error) {
    if (error.message.includes("API Error (401)")) {
      localStorage.removeItem("token");
      window.location.reload();
    }
    
    // Attempt to extract detail from the error message if it's JSON
    try {
      const match = error.message.match(/API Error \(\d+\): (.*)/);
      if (match) {
        const parsed = JSON.parse(match[1]);
        if (parsed.detail) {
          throw new Error(parsed.detail);
        }
      }
    } catch(e) {
      if (e !== error) throw e;
    }
    
    throw error;
  }
}

function parseBulkText(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [Name = "", Context = ""] = line.split("|").map((p) => p.trim());
      return { Name, Context };
    })
    .filter((t) => t.Name);
}

// ─────────────────────────────────────────────────────────────────────────────
//region Root App
// ─────────────────────────────────────────────────────────────────────────────

function MainApp() {
  const [tasks, setTasks]           = useState([]);
  const [localEdits, setLocalEdits] = useState({});
  const [sortPhase, setSortPhase]   = useState("idle");
  const [showInterruptModal, setShowInterruptModal] = useState(false);
  const [preSortSnapshot, setPreSortSnapshot]       = useState([]);
  const [exitingIds, setExitingIds] = useState(new Set());

  const [viewMode, setViewMode]         = useState("stats");
  const [sortColumn, setSortColumn]     = useState(null);
  const [sortDirection, setSortDirection] = useState("asc");

  const [showConfigModal, setShowConfigModal] = useState(false);
  const [currentModel, setCurrentModel]       = useState("");
  const [newModel, setNewModel]               = useState("");
  const [modelSavePhase, setModelSavePhase]   = useState("idle");
  const [modelError, setModelError]           = useState("");
  const [newApiKey, setNewApiKey]             = useState("");
  const [apiKeySavePhase, setApiKeySavePhase] = useState("idle");
  const [apiKeyError, setApiKeyError]         = useState("");

  const [propertyModes, setPropertyModes]   = useState({});
  const [modeSavePhase, setModeSavePhase]   = useState("idle");

  const [aiPlanResult, setAIPlanResult]       = useState(null);
  const [aiPlanPhase, setAiPlanPhase]         = useState("idle");
  const [aiPlanError, setAiPlanError]         = useState("");

  const [propertyOrder, setPropertyOrder] = useState(SCORING_PROP_KEYS);

  // Notion sync
  const [notionToken, setNotionToken]         = useState("");
  const [notionDbId, setNotionDbId]           = useState("");
  const [notionConnected, setNotionConnected] = useState(false);
  const [notionPhase, setNotionPhase]         = useState("idle"); // idle | saving | importing | exporting
  const [notionError, setNotionError]         = useState("");
  const [notionMsg, setNotionMsg]             = useState("");
  const [treeRefresh, setTreeRefresh]         = useState(0);       // bump to re-fetch the tree

  useEffect(() => {
    apiFetch("/config/notion").then(data => {
      setNotionConnected(data.connected);
      setNotionDbId(data.database_id || "");
    }).catch(console.error);
  }, []);

  useEffect(() => {
    apiFetch("/config/properties").then(data => {
      setPropertyModes(data.property_modes);
    }).catch(console.error);
  }, []);

  useEffect(() => {
    apiFetch("/config/property-order").then(data => {
      if (data.property_order?.length === SCORING_PROP_KEYS.length) {
        setPropertyOrder(data.property_order);
      }
    }).catch(console.error);
  }, []);

  const handleSaveModes = async () => {
    setModeSavePhase("loading");
    try {
      await apiFetch("/config/properties", {
        method: "POST",
        body: JSON.stringify({ property_modes: propertyModes }),
      });
      setModeSavePhase("idle");
    } catch (e) {
      setModeSavePhase("error");
    }
  };

  const [form, setForm]         = useState({ name: "", context: "" });
  const [addPhase, setAddPhase] = useState("idle");
  const [addError, setAddError] = useState("");

  const [inputMode, setInputMode]   = useState("single");
  const [addPanelOpen, setAddPanelOpen] = useState(false);
  const addPanelRef = useRef(null);
  const [bulkText, setBulkText]     = useState("");
  const [bulkPhase, setBulkPhase]   = useState("idle");
  const [bulkError, setBulkError]   = useState("");

  const [revalPhase, setRevalPhase] = useState("idle");
  const [revalError, setRevalError] = useState("");

  const [postponeTarget, setPostponeTarget] = useState(null);
  const [postponeReason, setPostponeReason] = useState("");
  const [postponePhase, setPostponePhase]   = useState("idle");

  const [sortError, setSortError] = useState("");

  const abortCtrl      = useRef(null);
  const revalAbortCtrl = useRef(null);
  const prefersReduced = useReducedMotion();

  useEffect(() => {
    apiFetch("/config/model").then(data => {
      setCurrentModel(data.model);
      setNewModel(data.model);
    }).catch(console.error);
    apiFetch("/tasks").then(setTasks).catch(console.error);
  }, []);

  // Collapse the add-task panel when clicking outside of it.
  useEffect(() => {
    if (!addPanelOpen) return;
    const onDown = (e) => {
      if (addPanelRef.current && !addPanelRef.current.contains(e.target)) {
        setAddPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [addPanelOpen]);

  const getVal = useCallback(
    (task, key) => localEdits[task.Task_ID]?.[key] ?? task[key],
    [localEdits]
  );

  const merged = useCallback(
    (task) => ({ ...task, ...(localEdits[task.Task_ID] ?? {}) }),
    [localEdits]
  );

  const orderedProperties = useCallback(() => {
    return propertyOrder
      .map(key => PROPERTIES.find(p => p.key === key))
      .filter(Boolean);
  }, [propertyOrder]);

  const hasUnsavedEdits = Object.keys(localEdits).length > 0;

  const adjustProp = useCallback((taskId, key, delta, presetValue = null) => {
    setLocalEdits((prev) => {
      const existing = prev[taskId] ?? {};
      const base = tasks.find((t) => t.Task_ID === taskId)?.[key] ?? 5;
      const cur  = existing[key] !== undefined ? existing[key] : base;

      let newValue;
      if (presetValue !== null) {
        // Direct set — used by binary toggles
        newValue = Math.min(10, Math.max(1, presetValue));
      } else if (key === "Time_Minutes") {
        const TIME_PRESETS = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 480, 960, 1440];
        const currentIndex = TIME_PRESETS.indexOf(cur);
        if (delta === -1 && currentIndex > 0)                      newValue = TIME_PRESETS[currentIndex - 1];
        else if (delta === 1 && currentIndex < TIME_PRESETS.length - 1) newValue = TIME_PRESETS[currentIndex + 1];
        else                                                         newValue = cur;
      } else {
        newValue = Math.min(10, Math.max(1, cur + delta));
      }

      return { ...prev, [taskId]: { ...existing, [key]: newValue } };
    });
  }, [tasks]);

  const getSortedTasks = useCallback(() => {
    if (!sortColumn) return tasks;
    const sorted = [...tasks];
    sorted.sort((a, b) => {
      let aVal = getVal(a, sortColumn);
      let bVal = getVal(b, sortColumn);
      if (sortColumn === "Name" || sortColumn === "Context") {
        aVal = (aVal || "").toLowerCase();
        bVal = (bVal || "").toLowerCase();
      }
      if (aVal < bVal) return sortDirection === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDirection === "asc" ? 1  : -1;
      return 0;
    });
    return sorted;
  }, [tasks, sortColumn, sortDirection, getVal]);

  const handleSortColumn = (column) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(column);
      setSortDirection("desc");
    }
  };

  const handleSaveModel = async () => {
    if (!newModel.trim()) return;
    setModelSavePhase("loading");
    setModelError("");
    try {
      await apiFetch("/config/model", {
        method: "POST",
        body: JSON.stringify({ model: newModel.trim() }),
      });
      setCurrentModel(newModel.trim());
      setShowConfigModal(false);
      setModelSavePhase("idle");
    } catch (e) {
      setModelError(e.message);
      setModelSavePhase("error");
    }
  };

  const handleSaveApiKey = async () => {
    if (!newApiKey.trim()) return;
    setApiKeySavePhase("loading");
    setApiKeyError("");
    try {
      await apiFetch("/users/me/api-key", {
        method: "POST",
        body: JSON.stringify({ api_key: newApiKey.trim() }),
      });
      setNewApiKey(""); // Clear it since we don't want to show it back
      setApiKeySavePhase("success");
      setTimeout(() => setApiKeySavePhase("idle"), 2000);
    } catch (e) {
      setApiKeyError(e.message);
      setApiKeySavePhase("error");
    }
  };

  const handleSaveNotion = async () => {
    if (!notionDbId.trim()) { setNotionError("Database ID is required."); return; }
    setNotionPhase("saving"); setNotionError(""); setNotionMsg("");
    try {
      const res = await apiFetch("/config/notion", {
        method: "POST",
        body: JSON.stringify({ token: notionToken.trim(), database_id: notionDbId.trim() }),
      });
      setNotionConnected(res.connected);
      setNotionToken(""); // never keep the token in the field
      setNotionMsg(res.connected ? "Notion connected." : "Saved — add a token to connect.");
      setNotionPhase("idle");
    } catch (e) { setNotionError(e.message); setNotionPhase("idle"); }
  };

  const handleNotionImport = async () => {
    setNotionPhase("importing"); setNotionError(""); setNotionMsg("");
    try {
      const res = await apiFetch("/notion/import", {
        method: "POST",
        body: JSON.stringify({ score_new: true }),
      });
      const fresh = await apiFetch("/tasks");
      setTasks(fresh);
      setTreeRefresh((n) => n + 1);
      setNotionMsg(`Imported ${res.created} new, updated ${res.updated}.`);
      setNotionPhase("idle");
    } catch (e) { setNotionError(e.message); setNotionPhase("idle"); }
  };

  const handleNotionExport = async () => {
    setNotionPhase("exporting"); setNotionError(""); setNotionMsg("");
    try {
      const res = await apiFetch("/notion/export", { method: "POST" });
      setNotionMsg(`Pushed scores for ${res.pushed} task(s)` + (res.failed ? `, ${res.failed} failed.` : "."));
      setNotionPhase("idle");
    } catch (e) { setNotionError(e.message); setNotionPhase("idle"); }
  };

  const handleMatrixPersist = async (changed) => {
    // Optimistically update local state, then persist the new coordinates.
    setTasks((prev) => prev.map((t) => {
      const u = changed.find((c) => c.Task_ID === t.Task_ID);
      return u ? { ...t, Hierarchy: u.Hierarchy, Priority: u.Priority } : t;
    }));
    try {
      await apiFetch("/tasks/bulk-update", {
        method: "POST",
        body: JSON.stringify(changed),
      });
    } catch (e) {
      console.error("Matrix save failed:", e);
    }
  };

  const handleAdd = async () => {
    if (!form.name.trim()) return;
    setAddPhase("loading"); setAddError("");
    try {
      const t = await apiFetch("/tasks/evaluate", {
        method: "POST",
        body: JSON.stringify({ Name: form.name.trim(), Context: form.context.trim() }),
      });
      setTasks((p) => [...p, t]);
      setForm({ name: "", context: "" });
      setAddPhase("idle");
    } catch (e) { setAddError(e.message); setAddPhase("error"); }
  };

  const handleBulkAdd = async () => {
    const items = parseBulkText(bulkText);
    if (!items.length) return;
    setBulkPhase("loading"); setBulkError("");
    try {
      const newTasks = await apiFetch("/tasks/evaluate-bulk", {
        method: "POST",
        body: JSON.stringify({ tasks: items }),
      });
      setTasks((p) => [...p, ...newTasks]);
      setBulkText(""); setBulkPhase("idle");
    } catch (e) { setBulkError(e.message); setBulkPhase("error"); }
  };

  const [evalMode, setEvalMode] = useState(false);
  const [selectedTasks, setSelectedTasks] = useState(new Set());

  const toggleEvalMode = () => {
    if (evalMode) {
      setEvalMode(false);
      setSelectedTasks(new Set());
    } else {
      setEvalMode(true);
      setSelectedTasks(new Set());
    }
  };

  const handleReeval = async () => {
    if (!tasks.length) return;
    setRevalPhase("loading"); setRevalError("");
    revalAbortCtrl.current = new AbortController();
    const { signal } = revalAbortCtrl.current;
    try {
      let updated;
      if (selectedTasks.size > 0) {
        updated = await apiFetch("/tasks/reevaluate-selected", {
          method: "POST",
          body: JSON.stringify({ task_ids: Array.from(selectedTasks) }),
          signal,
        });
      } else {
        updated = await apiFetch("/tasks/reevaluate-all", { method: "POST", signal });
      }
      if (signal.aborted) return;
      setTasks((p) => {
        const pMap = new Map(p.map(t => [t.Task_ID, t]));
        updated.forEach(t => pMap.set(t.Task_ID, t));
        return Array.from(pMap.values());
      });
      setLocalEdits({}); setRevalPhase("idle");
      setEvalMode(false);
      setSelectedTasks(new Set());
    } catch (e) {
      if (e.name === "AbortError" || signal?.aborted) { setRevalPhase("idle"); return; }
      setRevalError(e.message); setRevalPhase("error");
    }
  };

  const handleCancelReeval = () => { revalAbortCtrl.current?.abort(); setRevalPhase("idle"); };

  const toggleTaskSelection = useCallback((taskId) => {
    setSelectedTasks(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const handleSort = async () => {
    const mergedTasks = tasks.map(merged);
    setPreSortSnapshot([...tasks]);
    setSortPhase("sorting"); setSortError("");
    abortCtrl.current = new AbortController();
    const { signal } = abortCtrl.current;
    try {
      await apiFetch("/tasks/bulk-update", { method: "POST", body: JSON.stringify(mergedTasks), signal });
      if (signal.aborted) return;
      const { sorted_ids } = await apiFetch("/tasks/sort", { method: "POST", body: JSON.stringify({ tasks: mergedTasks }), signal });
      if (signal.aborted) return;
      const byId = Object.fromEntries(mergedTasks.map((t) => [t.Task_ID, t]));
      setTasks(sorted_ids.map((id) => byId[id]).filter(Boolean));
      setLocalEdits({}); setSortPhase("idle");
    } catch (e) {
      if (e.name === "AbortError" || signal?.aborted) return;
      setSortError(e.message); setSortPhase("idle");
    }
  };

  const handleAIPlan = async () => {
    const mergedTasks = tasks.map(merged);
    setAiPlanPhase("loading");
    setAiPlanError("");
    try {
      const result = await apiFetch("/tasks/ai-plan", {
        method: "POST",
        body: JSON.stringify({ tasks: mergedTasks }),
      });
      // Apply the AI ordering to the task list
      const byId = Object.fromEntries(mergedTasks.map((t) => [t.Task_ID, t]));
      setTasks(result.sorted_ids.map((id) => byId[id]).filter(Boolean));
      setLocalEdits({});
      setAIPlanResult(result);
      setViewMode("ai-plan");
    } catch (e) {
      setAiPlanError(e.message);
    } finally {
      setAiPlanPhase("idle");
    }
  };

  const handleInterrupt = () => { abortCtrl.current?.abort(); setSortPhase("interrupted"); setShowInterruptModal(true); };
  const resolveInterrupt = (keep) => {
    setShowInterruptModal(false); setSortPhase("idle");
    if (!keep) { setTasks(preSortSnapshot); setLocalEdits({}); }
  };

  const animateOut = useCallback((taskId, apiCall) => {
    setExitingIds((s) => new Set([...s, taskId]));
    apiCall().catch(console.error);
    setTimeout(() => {
      setTasks((p) => p.filter((t) => t.Task_ID !== taskId));
      setExitingIds((s) => { const n = new Set(s); n.delete(taskId); return n; });
    }, 600);
  }, []);

  const handleComplete = useCallback(
    (id) => animateOut(id, () => apiFetch(`/tasks/${id}/complete`, { method: "PATCH" })),
    [animateOut]
  );
  const handleDelete = useCallback(
    (id) => animateOut(id, () => apiFetch(`/tasks/${id}`, { method: "DELETE" })),
    [animateOut]
  );

  const openPostpone = (task) => { setPostponeTarget(task); setPostponeReason(""); setPostponePhase("idle"); };

  const confirmPostpone = async () => {
    if (!postponeTarget) return;
    setPostponePhase("loading");
    try {
      await apiFetch(`/tasks/${postponeTarget.Task_ID}/postpone`, {
        method: "PATCH",
        body: JSON.stringify({ reason: postponeReason }),
      });
      setTasks((p) => p.filter((t) => t.Task_ID !== postponeTarget.Task_ID));
      setPostponeTarget(null);
    } catch (e) { setPostponePhase("error"); }
  };

  const handleSubtaskAdded = useCallback((taskId, subtask) => {
    setTasks((p) => p.map((t) => t.Task_ID === taskId
      ? { ...t, Subtasks: [...(t.Subtasks || []), subtask] } : t));
  }, []);

  const handleSubtaskToggled = useCallback((taskId, subtaskId, done) => {
    setTasks((p) => p.map((t) => t.Task_ID === taskId
      ? { ...t, Subtasks: t.Subtasks.map((s) => s.id === subtaskId ? { ...s, done } : s) } : t));
  }, []);

  const handleSubtaskDeleted = useCallback((taskId, subtaskId) => {
    setTasks((p) => p.map((t) => t.Task_ID === taskId
      ? { ...t, Subtasks: t.Subtasks.filter((s) => s.id !== subtaskId) } : t));
  }, []);

  const sortedTasks  = getSortedTasks();
  const isSorting    = sortPhase === "sorting";
  const isRevaluating = revalPhase === "loading";
  const bulkItems    = parseBulkText(bulkText);

  return (
    <div className="relative min-h-screen bg-gray-950 text-white overflow-hidden"
      style={{ fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace" }}>

      {/* Grid BG */}
      <div className="pointer-events-none fixed inset-0" style={{
        backgroundImage:
          "linear-gradient(rgba(6,182,212,0.03) 1px,transparent 1px)," +
          "linear-gradient(90deg,rgba(6,182,212,0.03) 1px,transparent 1px)",
        backgroundSize: "40px 40px",
      }} />

      {/* Top Right Controls */}
      <div className="fixed top-4 right-4 z-40 flex items-center gap-2">
        {tasks.length > 1 && (
          <motion.button
            initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
            onClick={handleSort} disabled={isSorting}
            className="px-6 h-10 rounded-xl flex items-center justify-center font-black text-sm tracking-[0.2em] uppercase disabled:opacity-40"
            style={{ background: "linear-gradient(135deg,#7c3aed,#0891b2)", border: "1px solid rgba(124,58,237,0.4)", boxShadow: "0 0 24px rgba(124,58,237,0.25)", backdropFilter: "blur(8px)", fontFamily: "inherit" }}
            whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            {isSorting ? <span className="flex items-center gap-2"><Spinner /> SORTING…</span> : "⚡SORT/💾SAVE"}
          </motion.button>
        )}
        <motion.button
          initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
          onClick={() => setShowConfigModal(true)}
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: "rgba(15,23,42,0.8)", border: "1px solid rgba(6,182,212,0.3)", backdropFilter: "blur(8px)" }}
          whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
          <span className="text-lg">⚙️</span>
        </motion.button>
        <motion.button
          initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
          onClick={() => { localStorage.removeItem("token"); window.location.reload(); }}
          title="Log out"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-sm opacity-50 hover:opacity-100 transition-opacity"
          style={{ background: "rgba(15,23,42,0.6)", border: "1px solid rgba(255,255,255,0.08)", color: "#64748b", backdropFilter: "blur(8px)" }}
          whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
          ⎋
        </motion.button>
      </div>

      {/* ── Config Modal ── */}
      <AnimatePresence>
        {showConfigModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] flex items-center justify-center"
            style={{ background: "rgba(2,6,23,0.95)", backdropFilter: "blur(8px)" }}
            onClick={() => setShowConfigModal(false)}>
            <motion.div
              initial={{ scale: 0.85, opacity: 0, y: 24 }} animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.85, opacity: 0, y: 24 }} transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="w-full max-w-md mx-4 rounded-2xl p-6 max-h-[90vh] overflow-y-auto"
              style={{ background: "#0f172a", border: "1px solid rgba(6,182,212,0.3)" }}
              onClick={(e) => e.stopPropagation()}>

              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-black" style={{
                  background: "linear-gradient(135deg,#22d3ee 0%,#a78bfa 100%)",
                  WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                }}>⚙️ Configuration</h2>
                <button onClick={() => setShowConfigModal(false)} className="text-gray-600 hover:text-gray-400 text-xl">✕</button>
              </div>

              {/* Model input */}
              <div className="mb-6">
                <label className="block text-[10px] font-black tracking-widest text-gray-600 uppercase mb-2">
                  OpenRouter Model
                </label>
                <input
                  value={newModel} onChange={(e) => setNewModel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveModel()}
                  placeholder="e.g., anthropic/claude-3.5-sonnet"
                  className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 outline-none transition-all mb-2"
                  style={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.07)", fontFamily: "inherit" }}
                  onFocus={(e) => (e.target.style.borderColor = "rgba(6,182,212,0.5)")}
                  onBlur={(e)  => (e.target.style.borderColor = "rgba(255,255,255,0.07)")} />
                <p className="text-[10px] text-gray-600">
                  Current model: <span className="text-cyan-400">{currentModel || "Not set"}</span>
                </p>
                <p className="text-[10px] text-gray-700 mt-2">
                  Find models at{" "}
                  <a href="https://openrouter.ai/models" target="_blank" rel="noopener noreferrer" className="text-cyan-500 hover:underline">
                    openrouter.ai/models
                  </a>
                </p>
              </div>

              {/* API Key Input */}
              <div className="mb-6">
                <label className="block text-[10px] font-black tracking-widest text-gray-600 uppercase mb-2">
                  Personal OpenRouter API Key
                </label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={newApiKey} onChange={(e) => setNewApiKey(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveApiKey()}
                    placeholder="sk-or-v1-..."
                    className="flex-1 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 outline-none transition-all"
                    style={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.07)", fontFamily: "inherit" }}
                    onFocus={(e) => (e.target.style.borderColor = "rgba(6,182,212,0.5)")}
                    onBlur={(e)  => (e.target.style.borderColor = "rgba(255,255,255,0.07)")} />
                  <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                    onClick={handleSaveApiKey} disabled={apiKeySavePhase === "loading" || !newApiKey.trim()}
                    className="px-4 rounded-xl font-black text-xs disabled:opacity-40"
                    style={{ background: "rgba(168,85,247,0.15)", border: "1px solid rgba(168,85,247,0.3)", color: "#c084fc" }}>
                    {apiKeySavePhase === "loading" ? "..." : apiKeySavePhase === "success" ? "✔" : "SAVE"}
                  </motion.button>
                </div>
                {apiKeyError && <p className="text-red-400 text-xs mt-2">⚠ {apiKeyError}</p>}
                <p className="text-[10px] text-gray-600 mt-2">
                  Your key is securely encrypted. Get one at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:underline">openrouter.ai/keys</a>
                </p>
              </div>

              <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <label className="text-[10px] font-black tracking-widest text-gray-600 uppercase">
                    Scoring Modes & Order
                  </label>
                  <span className="text-[9px] px-2 py-0.5 rounded-full font-black"
                    style={{ background: "rgba(167,139,250,0.15)", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.3)" }}>
                    Binary = default · Drag to reorder
                  </span>
                </div>
                <p className="text-[10px] text-gray-600 mb-3">
                  Hierarchy &amp; Priority live in the <span className="text-amber-400">🎯 Matrix</span> tab now — always scale, 1 = highest.
                </p>
                <DndProvider>
                  <ReorderablePropertyList
                    propertyOrder={propertyOrder}
                    propertyModes={propertyModes}
                    onReorder={setPropertyOrder}
                    onModeChange={(prop, mode) => setPropertyModes(prev => ({ ...prev, [prop]: mode }))}
                  />
                </DndProvider>
                <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                  onClick={async () => {
                    // Save both property modes and order
                    setModeSavePhase("loading");
                    try {
                      await apiFetch("/config/properties", {
                        method: "POST",
                        body: JSON.stringify({ property_modes: propertyModes }),
                      });
                      await apiFetch("/config/property-order", {
                        method: "POST",
                        body: JSON.stringify({ property_order: propertyOrder }),
                      });
                      setModeSavePhase("idle");
                    } catch (e) {
                      setModeSavePhase("error");
                    }
                  }}
                  disabled={modeSavePhase === "loading"}
                  className="w-full mt-4 py-2 rounded-xl font-black text-xs tracking-widest disabled:opacity-40"
                  style={{ background: "rgba(168,85,247,0.15)", border: "1px solid rgba(168,85,247,0.3)", color: "#c084fc" }}>
                  {modeSavePhase === "loading" ? "SAVING…" : "💾 SAVE MODES"}
                </motion.button>
              </div>

              {/* Notion Sync */}
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <label className="text-[10px] font-black tracking-widest text-gray-600 uppercase">
                    Notion Sync
                  </label>
                  <span className="text-[9px] px-2 py-0.5 rounded-full font-black"
                    style={{ background: notionConnected ? "rgba(52,211,153,0.15)" : "rgba(148,163,184,0.15)",
                             color: notionConnected ? "#34d399" : "#94a3b8",
                             border: `1px solid ${notionConnected ? "rgba(52,211,153,0.3)" : "rgba(148,163,184,0.3)"}` }}>
                    {notionConnected ? "● Connected" : "○ Not connected"}
                  </span>
                </div>

                <input
                  type="password"
                  value={notionToken} onChange={(e) => setNotionToken(e.target.value)}
                  placeholder={notionConnected ? "Integration token (leave blank to keep current)" : "secret_..."}
                  className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 outline-none transition-all mb-2"
                  style={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.07)", fontFamily: "inherit" }}
                  onFocus={(e) => (e.target.style.borderColor = "rgba(6,182,212,0.5)")}
                  onBlur={(e)  => (e.target.style.borderColor = "rgba(255,255,255,0.07)")} />
                <div className="flex gap-2">
                  <input
                    value={notionDbId} onChange={(e) => setNotionDbId(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveNotion()}
                    placeholder="Database ID"
                    className="flex-1 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 outline-none transition-all"
                    style={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.07)", fontFamily: "inherit" }}
                    onFocus={(e) => (e.target.style.borderColor = "rgba(6,182,212,0.5)")}
                    onBlur={(e)  => (e.target.style.borderColor = "rgba(255,255,255,0.07)")} />
                  <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                    onClick={handleSaveNotion} disabled={notionPhase !== "idle" || !notionDbId.trim()}
                    className="px-4 rounded-xl font-black text-xs disabled:opacity-40"
                    style={{ background: "rgba(6,182,212,0.15)", border: "1px solid rgba(6,182,212,0.3)", color: "#22d3ee" }}>
                    {notionPhase === "saving" ? "..." : "SAVE"}
                  </motion.button>
                </div>

                <div className="flex gap-2 mt-3">
                  <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.96 }}
                    onClick={handleNotionImport} disabled={notionPhase !== "idle" || !notionConnected}
                    className="flex-1 py-2 rounded-xl font-black text-xs tracking-widest disabled:opacity-40"
                    style={{ background: "rgba(52,211,153,0.12)", border: "1px solid rgba(52,211,153,0.3)", color: "#34d399" }}>
                    {notionPhase === "importing" ? <span className="flex items-center justify-center gap-2"><Spinner /> IMPORTING…</span> : "⬇ IMPORT"}
                  </motion.button>
                  <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.96 }}
                    onClick={handleNotionExport} disabled={notionPhase !== "idle" || !notionConnected}
                    className="flex-1 py-2 rounded-xl font-black text-xs tracking-widest disabled:opacity-40"
                    style={{ background: "rgba(168,85,247,0.12)", border: "1px solid rgba(168,85,247,0.3)", color: "#c084fc" }}>
                    {notionPhase === "exporting" ? <span className="flex items-center justify-center gap-2"><Spinner /> PUSHING…</span> : "⬆ PUSH SCORES"}
                  </motion.button>
                </div>

                {notionError && <p className="text-red-400 text-xs mt-2">⚠ {notionError}</p>}
                {notionMsg   && <p className="text-emerald-400 text-xs mt-2">{notionMsg}</p>}
                <p className="text-[10px] text-gray-600 mt-2">
                  Your token is encrypted. Import pulls tasks + parent tree; Push writes Hierarchy/Priority back.
                </p>
              </div>

              {modelError && <p className="text-red-400 text-xs mb-4">⚠ {modelError}</p>}

              <div className="flex gap-3">
                <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                  onClick={handleSaveModel} disabled={modelSavePhase === "loading" || !newModel.trim()}
                  className="flex-1 py-3 rounded-xl font-black text-sm tracking-widest disabled:opacity-40"
                  style={{ background: "linear-gradient(135deg,#0891b2,#0e7490)", border: "1px solid rgba(6,182,212,0.3)", fontFamily: "inherit" }}>
                  {modelSavePhase === "loading" ? <span className="flex items-center justify-center gap-2"><Spinner /> SAVING…</span> : "💾 SAVE"}
                </motion.button>
                <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                  onClick={() => setShowConfigModal(false)}
                  className="px-6 py-3 rounded-xl font-black text-sm tracking-widest"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "#94a3b8" }}>
                  CANCEL
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sorting overlay */}
      <AnimatePresence>
        {isSorting && (
          <motion.div key="sort-ov" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8"
            style={{ background: "rgba(2,6,23,0.82)", backdropFilter: "blur(8px)" }}>
            <SpinRing color="cyan" />
            <div className="text-center">
              <p className="text-cyan-300 text-sm tracking-[0.4em] uppercase font-black mb-1">Sorting Tasks</p>
              <p className="text-gray-600 text-xs tracking-widest">evaluating urgency × importance matrix…</p>
            </div>
            <motion.button initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
              whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.92 }} onClick={handleInterrupt}
              className="px-8 py-3 rounded-xl font-black text-sm tracking-[0.25em] uppercase border"
              style={{ background: "rgba(220,38,38,0.15)", borderColor: "rgba(220,38,38,0.5)", color: "#fca5a5" }}>
              ⏸ INTERRUPT
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Re-evaluate overlay */}
      <AnimatePresence>
        {isRevaluating && (
          <motion.div key="reval-ov" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8"
            style={{ background: "rgba(2,6,23,0.82)", backdropFilter: "blur(8px)" }}>
            <SpinRing color="purple" />
            <div className="text-center">
              <p className="text-purple-300 text-sm tracking-[0.4em] uppercase font-black mb-1">Re-evaluating</p>
              <p className="text-gray-600 text-xs tracking-widest">rescoring {tasks.length} tasks in parallel…</p>
            </div>
            <motion.button initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
              whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.92 }} onClick={handleCancelReeval}
              className="px-8 py-3 rounded-xl font-black text-sm tracking-[0.25em] uppercase border"
              style={{ background: "rgba(220,38,38,0.15)", borderColor: "rgba(220,38,38,0.5)", color: "#fca5a5" }}>
              ✕ CANCEL
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Interrupt modal */}
      <AnimatePresence>
        {showInterruptModal && (
          <motion.div key="int-bd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center"
            style={{ background: "rgba(2,6,23,0.9)" }}>
            <motion.div initial={{ scale: 0.85, opacity: 0, y: 24 }} animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.85, opacity: 0, y: 24 }} transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="w-full max-w-sm mx-4 rounded-2xl p-8"
              style={{ background: "#0f172a", border: "1px solid rgba(234,179,8,0.3)" }}>
              <p className="text-yellow-400 text-xs tracking-[0.3em] uppercase mb-1">⚠ INTERRUPT TRIGGERED</p>
              <h2 className="text-white text-lg font-black mb-3">Sorting Halted</h2>
              <p className="text-gray-400 text-sm leading-relaxed mb-7">
                The AI sort was cancelled. Choose how to handle the current task state:
              </p>
              <div className="flex flex-col gap-3">
                <ModalBtn onClick={() => resolveInterrupt(true)} accent="cyan">✓ KEEP CURRENT STATE</ModalBtn>
                <ModalBtn onClick={() => resolveInterrupt(false)} accent="gray">↩ REVERT TO ORIGINAL</ModalBtn>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Postpone modal */}
      <AnimatePresence>
        {postponeTarget && (
          <motion.div key="post-bd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center"
            style={{ background: "rgba(2,6,23,0.9)" }}>
            <motion.div initial={{ scale: 0.85, opacity: 0, y: 24 }} animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.85, opacity: 0, y: 24 }} transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="w-full max-w-sm mx-4 rounded-2xl p-8"
              style={{ background: "#0f172a", border: "1px solid rgba(251,146,60,0.3)" }}>
              <p className="text-orange-400 text-xs tracking-[0.3em] uppercase mb-1">⏰ POSTPONE</p>
              <h2 className="text-white text-lg font-black mb-1">See you tomorrow</h2>
              <p className="text-gray-500 text-xs mb-5 truncate">"{postponeTarget.Name}"</p>
              <p className="text-gray-400 text-sm mb-2">Why are you postponing? <span className="text-gray-600">(optional)</span></p>
              <textarea
                value={postponeReason} onChange={(e) => setPostponeReason(e.target.value)}
                placeholder="Blocked by something else, waiting for info, etc…"
                rows={3}
                className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 outline-none resize-none mb-5"
                style={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.07)", fontFamily: "inherit" }}
                onFocus={(e) => (e.target.style.borderColor = "rgba(251,146,60,0.5)")}
                onBlur={(e)  => (e.target.style.borderColor = "rgba(255,255,255,0.07)")} />
              <p className="text-gray-600 text-[10px] mb-5">
                This reason will be added to the task's context when it reappears tomorrow.
              </p>
              <div className="flex flex-col gap-3">
                <ModalBtn onClick={confirmPostpone} accent="orange" disabled={postponePhase === "loading"}>
                  {postponePhase === "loading"
                    ? <span className="flex items-center justify-center gap-2"><Spinner /> POSTPONING…</span>
                    : "⏰ POSTPONE UNTIL TOMORROW"}
                </ModalBtn>
                <ModalBtn onClick={() => setPostponeTarget(null)} accent="gray">CANCEL</ModalBtn>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main */}
      <div className={`relative max-w-full lg:max-w-[90rem] xl:max-w-[100rem] 2xl:max-w-[120rem] mx-auto px-4 py-10 transition-opacity duration-300 ${isSorting || isRevaluating ? "pointer-events-none opacity-40" : ""}`}>
        <header className="mb-4 text-center">
          <h1 className="text-2xl font-black tracking-tight" style={{
            background: "linear-gradient(135deg,#22d3ee 0%,#a78bfa 50%,#f472b6 100%)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          }}>DAILY CHECKLIST SORTER</h1>
        </header>

        {/* Add panel */}
        <section ref={addPanelRef} className="mb-6 rounded-2xl" style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.06)" }}>
          <button onClick={() => setAddPanelOpen((o) => !o)}
            className="w-full flex items-center justify-between px-5 py-3 text-left">
            <span className="text-[11px] font-black tracking-widest uppercase text-cyan-400">＋ Add tasks</span>
            <motion.span animate={{ rotate: addPanelOpen ? 90 : 0 }} transition={{ duration: 0.2 }}
              className="text-gray-500 text-sm inline-block">▸</motion.span>
          </button>
          <AnimatePresence initial={false}>
          {addPanelOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }}
            style={{ overflow: "hidden" }}>
          <div className="px-5 pb-5">
          <div className="flex items-center gap-1 mb-4">
            {["single", "bulk"].map((mode) => (
              <button key={mode} onClick={() => setInputMode(mode)}
                className="px-3 py-1 rounded-lg text-[10px] font-black tracking-widest uppercase transition-all"
                style={{
                  background: inputMode === mode ? "rgba(6,182,212,0.15)" : "transparent",
                  color: inputMode === mode ? "#22d3ee" : "#475569",
                  border: inputMode === mode ? "1px solid rgba(6,182,212,0.3)" : "1px solid transparent",
                }}>
                {mode === "single" ? "＋ Single" : "≡ Bulk"}
              </button>
            ))}
          </div>

          {inputMode === "single" && (
            <div className="flex flex-col gap-3">
              <div className="flex gap-3">
                <DarkInput value={form.name} onChange={(v) => setForm((p) => ({ ...p, name: v }))}
                  onEnter={handleAdd} placeholder="Task name…" disabled={addPhase === "loading"} className="flex-1" />
              </div>
              <div className="flex gap-3">
                <DarkInput value={form.context} onChange={(v) => setForm((p) => ({ ...p, context: v }))}
                  onEnter={handleAdd} placeholder="Context / description…" disabled={addPhase === "loading"} className="flex-1" />
                <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.95 }} onClick={handleAdd}
                  disabled={addPhase === "loading" || !form.name.trim()}
                  className="px-6 py-2.5 rounded-xl font-black text-sm tracking-widest whitespace-nowrap disabled:opacity-40"
                  style={{ background: "linear-gradient(135deg,#0891b2,#0e7490)", border: "1px solid rgba(6,182,212,0.3)", fontFamily: "inherit" }}>
                  {addPhase === "loading" ? <span className="flex items-center gap-2"><Spinner /> SCORING…</span> : "＋ ADD"}
                </motion.button>
              </div>
              {addPhase === "error" && <p className="text-red-400 text-xs">⚠ {addError}</p>}
            </div>
          )}

          {inputMode === "bulk" && (
            <div className="flex flex-col gap-3">
              <p className="text-[10px] text-gray-600">
                One task per line · Format: <span className="text-gray-400">Task name</span> | <span className="text-gray-500">context</span>
              </p>
              <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)}
                disabled={bulkPhase === "loading"} rows={6}
                placeholder={"Fix login bug | auth service is down\nWrite Q3 report\nReview pull requests | 3 PRs waiting"}
                className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 outline-none resize-y"
                style={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.07)", fontFamily: "inherit", lineHeight: "1.6" }}
                onFocus={(e) => (e.target.style.borderColor = "rgba(6,182,212,0.5)")}
                onBlur={(e)  => (e.target.style.borderColor = "rgba(255,255,255,0.07)")} />
              <div className="flex items-center justify-between gap-3">
                <p className="text-[10px] text-gray-600">
                  {bulkItems.length > 0 ? `${bulkItems.length} task${bulkItems.length !== 1 ? "s" : ""} detected` : "No tasks yet"}
                </p>
                <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.95 }} onClick={handleBulkAdd}
                  disabled={bulkPhase === "loading" || !bulkItems.length}
                  className="px-6 py-2.5 rounded-xl font-black text-sm tracking-widest whitespace-nowrap disabled:opacity-40"
                  style={{ background: "linear-gradient(135deg,#0891b2,#0e7490)", border: "1px solid rgba(6,182,212,0.3)", fontFamily: "inherit" }}>
                  {bulkPhase === "loading" ? <span className="flex items-center gap-2"><Spinner /> EVALUATING…</span> : `⚡ EVALUATE ${bulkItems.length || ""}`}
                </motion.button>
              </div>
              {bulkPhase === "error" && <p className="text-red-400 text-xs">⚠ {bulkError}</p>}
            </div>
          )}
          </div>
          </motion.div>
          )}
          </AnimatePresence>
        </section>

        {/* Controls bar */}
        {tasks.length > 0 && (
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <p className="text-[10px] text-gray-600 uppercase tracking-widest">
                {tasks.length} active{hasUnsavedEdits ? " · ● unsaved edits" : ""}
              </p>
              <div className="flex gap-1 rounded-lg p-0.5" style={{ background: "#1e293b" }}>
                {[["table", "📊 Table"], ["subtasks", "✅ Subtasks"], ["tree", "🌲 Tree"], ["matrix", "🎯 Matrix"], ["stats", "📈 Stats"], ["ai-plan", "🤖 AI Plan"]].map(([mode, label]) => {
                  const accentText = mode === "ai-plan" ? "text-purple-400" : mode === "tree" ? "text-emerald-400" : mode === "matrix" ? "text-amber-400" : mode === "stats" ? "text-pink-400" : "text-cyan-400";
                  const accentBg = mode === "ai-plan" ? "rgba(139,92,246,0.15)" : mode === "tree" ? "rgba(16,185,129,0.15)" : mode === "matrix" ? "rgba(245,158,11,0.15)" : mode === "stats" ? "rgba(244,114,182,0.15)" : "rgba(6,182,212,0.15)";
                  return (
                  <button key={mode} onClick={() => setViewMode(mode)}
                    className={`px-3 py-1.5 rounded-md text-[10px] font-black tracking-wider uppercase transition-all ${
                      viewMode === mode ? accentText : "text-gray-600 hover:text-gray-400"
                    }`}
                    style={{ background: viewMode === mode ? accentBg : "transparent" }}>
                    {label}
                  </button>
                  );
                })}
              </div>
            </div>

            {viewMode === "table" && <div className="flex items-center gap-2 flex-wrap">
              {/* #tag Re-evaluate Button */}
              {evalMode ? (
                <div className="flex items-center gap-2">
                  <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.94 }} onClick={toggleEvalMode}
                    className="px-4 py-2.5 rounded-xl font-black text-sm tracking-wider uppercase text-gray-400 hover:text-white"
                    style={{ background: "rgba(255,255,255,0.05)" }}>
                    Cancel
                  </motion.button>
                  <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.94 }} onClick={handleReeval}
                    disabled={isRevaluating}
                    className="px-5 py-2.5 rounded-xl font-black text-sm tracking-[0.15em] uppercase disabled:opacity-40"
                    style={{ background: "rgba(168,85,247,0.15)", border: "1px solid rgba(168,85,247,0.35)", color: "#c084fc", fontFamily: "inherit" }}>
                    {isRevaluating ? <span className="flex items-center gap-2"><Spinner /> EVALUATING…</span> : (selectedTasks.size > 0 ? `↺ EVALUATE (${selectedTasks.size})` : "↺ EVALUATE ALL")}
                  </motion.button>
                </div>
              ) : (
                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.94 }} onClick={toggleEvalMode}
                  className="px-5 py-2.5 rounded-xl font-black text-sm tracking-[0.15em] uppercase"
                  style={{ background: "rgba(168,85,247,0.15)", border: "1px solid rgba(168,85,247,0.35)", color: "#c084fc", fontFamily: "inherit" }}>
                  ↺ EVALUATE
                </motion.button>
              )}
            </div>}
          </div>
        )}

        {revalPhase === "error" && <p className="text-red-400 text-xs mb-3">⚠ Re-evaluate failed: {revalError}</p>}
        {sortError && <p className="text-red-400 text-xs mb-3">⚠ Sort failed: {sortError}</p>}

        {/* Task display */}
        {viewMode === "ai-plan" ? (
          <AIPlanTab
            aiPlanResult={aiPlanResult}
            aiPlanPhase={aiPlanPhase}
            aiPlanError={aiPlanError}
            onGenerate={handleAIPlan}
            hasTasks={tasks.length > 0}
          />
        ) : viewMode === "tree" ? (
          <TreeView refreshSignal={treeRefresh} />
        ) : viewMode === "matrix" ? (
          <MatrixView tasks={tasks} onPersist={handleMatrixPersist} />
        ) : viewMode === "subtasks" ? (
          <LayoutGroup>
            <AnimatePresence mode="popLayout">
              {sortedTasks.map((task, index) => (
                <TaskCard
                  key={task.Task_ID}
                  task={task}
                  rank={index + 1}
                  isExiting={exitingIds.has(task.Task_ID)}
                  getVal={getVal}
                  onComplete={handleComplete}
                  onDelete={handleDelete}
                  onPostpone={openPostpone}
                  onSubtaskAdded={handleSubtaskAdded}
                  onSubtaskToggled={handleSubtaskToggled}
                  onSubtaskDeleted={handleSubtaskDeleted}
                  prefersReduced={prefersReduced}
                />
              ))}
            </AnimatePresence>
          </LayoutGroup>
        ) : viewMode === "stats" ? (
          <StatsView
            tasks={sortedTasks}
            getVal={getVal}
          />
        ) : (
          <TaskTable
            tasks={sortedTasks}
            getVal={getVal}
            adjustProp={adjustProp}
            propertyModes={propertyModes}
            propertyOrder={propertyOrder}
            sortColumn={sortColumn}
            sortDirection={sortDirection}
            onSort={handleSortColumn}
            onComplete={handleComplete}
            onDelete={handleDelete}
            onPostpone={openPostpone}
            onSubtaskAdded={handleSubtaskAdded}
            onSubtaskToggled={handleSubtaskToggled}
            onSubtaskDeleted={handleSubtaskDeleted}
            evalMode={evalMode}
            selectedTasks={selectedTasks}
            toggleSelection={toggleTaskSelection}
          />
        )}

        {tasks.length === 0 && (viewMode === "subtasks" || viewMode === "stats" || viewMode === "table") && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center py-24">
            <p className="text-6xl mb-5">📋</p>
            <p className="text-gray-500 font-black tracking-widest text-sm uppercase">No active tasks</p>
            <p className="text-gray-700 text-xs mt-2">Add a task above — the AI will score it automatically.</p>
          </motion.div>
        )}
      </div>
    </div>
  );
}

//endregion

// ─────────────────────────────────────────────────────────────────────────────
//  AIPlanTab
// ─────────────────────────────────────────────────────────────────────────────

function AIPlanTab({ aiPlanResult, aiPlanPhase, aiPlanError, onGenerate, hasTasks }) {
  const isLoading = aiPlanPhase === "loading";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
      className="rounded-2xl p-6"
      style={{ background: "#0f172a", border: "1px solid rgba(139,92,246,0.25)" }}>

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-black" style={{
          background: "linear-gradient(135deg,#a78bfa 0%,#22d3ee 100%)",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
        }}>🤖 AI Action Plan</h2>
        <motion.button
          whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.94 }}
          onClick={onGenerate}
          disabled={isLoading || !hasTasks}
          className="px-5 py-2 rounded-xl font-black text-sm tracking-[0.15em] uppercase disabled:opacity-40"
          style={{ background: "rgba(139,92,246,0.15)", border: "1px solid rgba(139,92,246,0.35)", color: "#a78bfa", fontFamily: "inherit" }}>
          {isLoading
            ? <span className="flex items-center gap-2"><Spinner /> PLANNING…</span>
            : aiPlanResult ? "↺ REGENERATE" : "⚡ GENERATE PLAN"}
        </motion.button>
      </div>

      {aiPlanError && (
        <p className="text-red-400 text-xs mb-4">⚠ {aiPlanError}</p>
      )}

      {isLoading && (
        <div className="flex flex-col items-center justify-center py-16 gap-6">
          <SpinRing color="purple" />
          <div className="text-center">
            <p className="text-purple-300 text-sm tracking-[0.4em] uppercase font-black mb-1">Building Plan</p>
            <p className="text-gray-600 text-xs tracking-widest">analyzing task relationships…</p>
          </div>
        </div>
      )}

      {!isLoading && !aiPlanResult && (
        <div className="text-center py-20">
          <p className="text-5xl mb-4">🤖</p>
          <p className="text-gray-500 font-black tracking-widest text-sm uppercase">No plan yet</p>
          <p className="text-gray-700 text-xs mt-2">
            {hasTasks ? "Click Generate Plan to have AI create an action plan for your tasks." : "Add tasks first, then generate a plan."}
          </p>
        </div>
      )}

      {!isLoading && aiPlanResult && (
        <div className="space-y-6">
          <div>
            <h3 className="text-cyan-400 text-xs font-black tracking-widest uppercase mb-3">📋 Action Plan</h3>
            <div className="rounded-xl p-4 text-sm leading-relaxed space-y-1"
              style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
              {(aiPlanResult.plan_text || "").split("\n").map((line, i) => {
                const trimmed = line.trim();
                if (!trimmed) return <div key={i} className="h-2" />;
                const isPhase = /^phase\b/i.test(trimmed);
                return isPhase ? (
                  <p key={i} className="text-cyan-300 font-black mt-4 first:mt-0">{trimmed}</p>
                ) : (
                  <p key={i} className="text-gray-300 pl-3">{trimmed}</p>
                );
              })}
            </div>
          </div>

          {aiPlanResult.reasoning && (
            <div>
              <h3 className="text-purple-400 text-xs font-black tracking-widest uppercase mb-3">🧠 Reasoning</h3>
              <div className="rounded-xl p-4"
                style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                <p className="text-gray-400 text-sm leading-relaxed">{aiPlanResult.reasoning}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

function formatMinutes(minutes) {
  if (minutes < 60)   return `${minutes}min`;
  if (minutes === 60) return "1h";
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60 > 0 ? (minutes % 60) + "m" : ""}`.trim();
  return `${Math.floor(minutes / 1440)}d`;
}

// ─────────────────────────────────────────────────────────────────────────────
//region TreeView

// Colour per level (1 = highest → hottest). Used for matrix priority rows.
const LEVEL_COLORS = {
  1: "#ef4444", 2: "#f87171", 3: "#fb923c", 4: "#f59e0b", 5: "#eab308",
  6: "#94a3b8", 7: "#38bdf8", 8: "#3b82f6", 9: "#6366f1", 10: "#8b5cf6",
};
const hierColor = (h) => LEVEL_COLORS[h] || "#f472b6";

// Mirror of the backend build_tree / get_leaves logic, in JS.
function buildTree(tasks) {
  const nodeMap = new Map(tasks.map((t) => [t.Task_ID, { ...t, children: [] }]));
  const roots = [];
  for (const node of nodeMap.values()) {
    const pid = node.Parent_ID;
    if (pid && nodeMap.has(pid) && pid !== node.Task_ID) {
      nodeMap.get(pid).children.push(node.Task_ID);
    } else {
      roots.push(node.Task_ID);
    }
  }
  return { nodeMap, roots };
}

function StatusPill({ status }) {
  const color =
    status === "Completed" ? "#34d399" :
    status === "Postponed" ? "#fbbf24" :
    status === "Forgotten" ? "#94a3b8" :
    "#22d3ee";
  return (
    <span className="text-[9px] px-2 py-0.5 rounded-full font-black uppercase tracking-wider"
      style={{ background: `${color}1f`, color, border: `1px solid ${color}55` }}>
      {status}
    </span>
  );
}

// A folded-in Notion leaf: rendered from the parent task's Subtasks JSON, not a row.
function SubtaskLeaf({ subtask }) {
  return (
    <div className="flex items-center gap-2 py-1 px-2 rounded-lg hover:bg-white/5 transition-colors" style={{ marginLeft: 16 }}>
      <span className={`text-xs w-4 text-center ${subtask.done ? "text-emerald-400" : "text-gray-600"}`}>
        {subtask.done ? "✔" : "◻"}
      </span>
      <span className={`text-sm ${subtask.done ? "text-gray-500 line-through" : "text-gray-300"}`}>
        {subtask.name}
      </span>
    </div>
  );
}

function TreeNode({ id, nodeMap, depth }) {
  const [open, setOpen] = useState(depth === 0);
  const task = nodeMap.get(id);
  if (!task) return null;

  // "category" = structural node (major category / label). "task" = a real task
  // whose Notion leaves are folded into its Subtasks. Fall back to task.
  const isCategory = task.Node_Type === "category";
  const subtasks   = task.Subtasks || [];
  const childRows  = task.children;                    // nested task/category rows
  const childCount = childRows.length + subtasks.length;
  const hasChildren = childCount > 0;

  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 16 }}>
      <div className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-white/5 transition-colors">
        {hasChildren ? (
          <button onClick={() => setOpen((o) => !o)} className="text-gray-500 hover:text-white text-xs w-4 text-center">
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="text-gray-600 text-xs w-4 text-center">◾</span>
        )}
        <span className={`text-sm ${isCategory ? "text-white font-bold" : "text-gray-200"}`}>
          {isCategory ? "📁 " : "📋 "}{task.Name}
        </span>
        <StatusPill status={task.Status} />
        {hasChildren && <span className="text-[10px] text-gray-600">{childCount}</span>}
      </div>
      {hasChildren && open && (
        <div className="border-l border-white/5 ml-2">
          {childRows.map((cid) => (
            <TreeNode key={cid} id={cid} nodeMap={nodeMap} depth={depth + 1} />
          ))}
          {subtasks.map((s) => (
            <SubtaskLeaf key={s.id} subtask={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function TreeView({ refreshSignal }) {
  const [tasks, setTasks]   = useState([]);
  const [phase, setPhase]   = useState("loading"); // loading | ready | error
  const [error, setError]   = useState("");

  const load = useCallback(() => {
    setPhase("loading"); setError("");
    apiFetch("/tasks/all")
      .then((data) => { setTasks(data); setPhase("ready"); })
      .catch((e) => { setError(e.message); setPhase("error"); });
  }, []);

  useEffect(() => { load(); }, [load, refreshSignal]);

  if (phase === "loading") {
    return <div className="text-center py-24 text-gray-500 text-sm flex items-center justify-center gap-3"><Spinner /> Loading tree…</div>;
  }
  if (phase === "error") {
    return <div className="text-center py-24 text-red-400 text-sm">⚠ {error}</div>;
  }
  if (!tasks.length) {
    return (
      <div className="text-center py-24">
        <p className="text-6xl mb-5">🌲</p>
        <p className="text-gray-500 font-black tracking-widest text-sm uppercase">No tasks yet</p>
        <p className="text-gray-700 text-xs mt-2">Import from Notion (⚙️ Settings) or add tasks to grow the tree.</p>
      </div>
    );
  }

  const { nodeMap, roots } = buildTree(tasks);
  const categoryCount = tasks.filter((t) => t.Node_Type === "category").length;
  const taskCount     = tasks.length - categoryCount;
  const subtaskCount  = tasks.reduce((n, t) => n + (t.Subtasks?.length || 0), 0);

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-8">
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-gray-600 uppercase tracking-widest">{taskCount} tasks · {categoryCount} categories · {subtaskCount} subtasks</p>
        <button onClick={load} className="text-[10px] font-black tracking-widest text-emerald-400 hover:text-emerald-300 uppercase">↻ Refresh</button>
      </div>

      {/* Full tree */}
      <section>
        <h3 className="text-emerald-400 text-xs font-black tracking-widest uppercase mb-3">🌲 Full Tree</h3>
        <div className="rounded-xl p-2" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
          {roots.map((rid) => (
            <TreeNode key={rid} id={rid} nodeMap={nodeMap} depth={0} />
          ))}
        </div>
      </section>
    </motion.div>
  );
}

//endregion

// ─────────────────────────────────────────────────────────────────────────────
//region MatrixView (Priority × Hierarchy)

// The matrix is one ordered list wrapped into a fixed 10-wide grid: reading
// left→right, top→bottom is the flattened priority order. Row = Priority, Column =
// Hierarchy (fixed 1..10). When a row fills, the list wraps to the next priority row.
// 1 = highest for both → top-left is the best cell.

const MATRIX_COLS = 10; // Hierarchy is fixed to reach 10.
const cellKey = (r, c) => `${r},${c}`;
const clamp1 = (v) => Math.max(1, Math.round(Number(v) || 1));

// Next cell in flattened (row-major) order — wraps to the next row after column 10.
const nextCell = (r, c) => (c < MATRIX_COLS ? { r, c: c + 1 } : { r: r + 1, c: 1 });

// Deterministic, collision-free layout from each task's stored Priority/Hierarchy.
// Ties/collisions cascade forward through the flattened list (wrapping at column 10).
function resolvePlacements(tasks) {
  const ordered = [...tasks].sort((a, b) => {
    const pa = clamp1(a.Priority), pb = clamp1(b.Priority);
    if (pa !== pb) return pa - pb;
    const ha = clamp1(a.Hierarchy), hb = clamp1(b.Hierarchy);
    if (ha !== hb) return ha - hb;
    return (a.Name || "").localeCompare(b.Name || "");
  });

  const occupied = new Set();
  const placements = {}; // Task_ID -> { row, col } = { Priority, Hierarchy }
  for (const t of ordered) {
    let row = clamp1(t.Priority);
    let col = Math.min(MATRIX_COLS, clamp1(t.Hierarchy));
    while (occupied.has(cellKey(row, col))) ({ r: row, c: col } = nextCell(row, col));
    occupied.add(cellKey(row, col));
    placements[t.Task_ID] = { row, col };
  }
  return placements;
}

// Insert `taskId` at (r,c), cascading any occupant forward through the list. Mutates `pos`.
function placeWithCascade(pos, taskId, r, c) {
  const occupant = Object.keys(pos).find(
    (id) => id !== taskId && pos[id].row === r && pos[id].col === c
  );
  if (occupant) {
    const n = nextCell(r, c);
    placeWithCascade(pos, occupant, n.r, n.c);
  }
  pos[taskId] = { row: r, col: c };
}

function MatrixChip({ task, accent, onDragStart, dragging }) {
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, task.Task_ID)}
      title={task.Name}
      className="rounded-lg px-2 py-1.5 cursor-grab active:cursor-grabbing select-none transition-opacity"
      style={{
        background: `${accent}1f`,
        border: `1px solid ${accent}66`,
        opacity: dragging ? 0.35 : 1,
      }}
    >
      <p className="text-[11px] leading-tight text-gray-100 font-semibold line-clamp-2">{task.Name}</p>
    </div>
  );
}

function MatrixView({ tasks, onPersist }) {
  const [draggingId, setDraggingId] = useState(null);
  const [hoverCell, setHoverCell]   = useState(null);

  const placements = resolvePlacements(tasks);
  const byId = new Map(tasks.map((t) => [t.Task_ID, t]));

  let maxRow = 1;
  for (const id in placements) maxRow = Math.max(maxRow, placements[id].row);
  // Hierarchy is fixed at 10 columns; one spare priority row so a task can always be
  // dropped into a brand-new priority level (rows grow, columns do not).
  const rows = maxRow + 1;
  const cols = MATRIX_COLS;

  const taskAt = (r, c) =>
    Object.keys(placements).find((id) => placements[id].row === r && placements[id].col === c);

  // row = Priority, col = Hierarchy → build the persisted payload accordingly.
  const diffChanged = (pos) => {
    const changed = [];
    for (const t of tasks) {
      const p = pos[t.Task_ID];
      if (p && (p.row !== t.Priority || p.col !== t.Hierarchy)) {
        changed.push({ Task_ID: t.Task_ID, Priority: p.row, Hierarchy: p.col });
      }
    }
    return changed;
  };

  const onDragStart = (e, id) => {
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(id);
  };

  const onDrop = (e, r, c) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain") || draggingId;
    setDraggingId(null);
    setHoverCell(null);
    if (!id) return;

    const pos = {};
    for (const k in placements) pos[k] = { ...placements[k] };
    delete pos[id];
    placeWithCascade(pos, id, r, c);

    const changed = diffChanged(pos);
    if (changed.length) onPersist(changed);
  };

  // Pack the flattened list with no gaps: read the current layout in row-major order,
  // then reassign consecutive positions (row = Priority group of 10, col = Hierarchy 1..10).
  const handleCompact = () => {
    const orderedIds = Object.keys(placements).sort((a, b) => {
      const pa = placements[a], pb = placements[b];
      return pa.row - pb.row || pa.col - pb.col;
    });
    const pos = {};
    orderedIds.forEach((id, i) => {
      pos[id] = { row: Math.floor(i / MATRIX_COLS) + 1, col: (i % MATRIX_COLS) + 1 };
    });
    const changed = diffChanged(pos);
    if (changed.length) onPersist(changed);
  };

  if (!tasks.length) {
    return (
      <div className="text-center py-24">
        <p className="text-6xl mb-5">🎯</p>
        <p className="text-gray-500 font-black tracking-widest text-sm uppercase">No active tasks</p>
        <p className="text-gray-700 text-xs mt-2">Add tasks — the AI seeds their Priority &amp; Hierarchy, then drag to arrange.</p>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <p className="text-[10px] text-gray-600 uppercase tracking-widest">
          One list, wrapped at 10 · reads left→right, top→bottom · drag to reposition
        </p>
        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
          onClick={handleCompact}
          className="px-4 py-2 rounded-xl font-black text-xs tracking-widest uppercase"
          style={{ background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.35)", color: "#fbbf24", fontFamily: "inherit" }}>
          ⇲ Compact
        </motion.button>
      </div>

      <div className="overflow-auto rounded-xl" style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
        <table className="border-collapse" style={{ minWidth: cols * 168 }}>
          <thead>
            <tr>
              <th className="sticky left-0 z-10 p-2" style={{ background: "#0b1220" }}></th>
              {Array.from({ length: cols }, (_, i) => i + 1).map((c) => (
                <th key={c} className="p-2 text-[10px] font-black tracking-widest uppercase text-gray-500 text-center"
                  style={{ minWidth: 160 }}>
                  Hierarchy {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => i + 1).map((r) => {
              const accent = hierColor(Math.min(10, r));
              return (
                <tr key={r}>
                  <th className="sticky left-0 z-10 p-2 text-[10px] font-black tracking-widest uppercase text-center"
                    style={{ background: "#0b1220", color: accent, minWidth: 88 }}>
                    Prio {r}
                  </th>
                  {Array.from({ length: cols }, (_, i) => i + 1).map((c) => {
                    const id = taskAt(r, c);
                    const task = id ? byId.get(id) : null;
                    const isHover = hoverCell === cellKey(r, c);
                    return (
                      <td key={c}
                        onDragOver={(e) => { e.preventDefault(); setHoverCell(cellKey(r, c)); }}
                        onDragLeave={() => setHoverCell((h) => (h === cellKey(r, c) ? null : h))}
                        onDrop={(e) => onDrop(e, r, c)}
                        className="align-top p-1.5 transition-colors"
                        style={{
                          border: "1px solid rgba(255,255,255,0.04)",
                          background: isHover ? "rgba(34,211,238,0.10)" : "transparent",
                          minWidth: 160, height: 60,
                        }}>
                        {task && (
                          <MatrixChip
                            task={task}
                            accent={accent}
                            dragging={draggingId === id}
                            onDragStart={onDragStart}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}

//endregion

// ─────────────────────────────────────────────────────────────────────────────
//region TaskTable

function TaskTable({ tasks, getVal, adjustProp, propertyModes, propertyOrder, sortColumn, sortDirection, onSort, onComplete, onDelete, onPostpone, onSubtaskAdded, onSubtaskToggled, onSubtaskDeleted, evalMode, selectedTasks, toggleSelection }) {
  const [expandedTask, setExpandedTask] = useState(null);

  const SortIcon = ({ column }) => {
    if (sortColumn !== column) return <span className="ml-1 opacity-30">↕</span>;
    return <span className="ml-1">{sortDirection === "asc" ? "↑" : "↓"}</span>;
  };

  const TableHeader = ({ column, label }) => (
    <th onClick={() => onSort(column)} className="sticky top-0 z-10 px-4 py-3 text-left text-[10px] font-black tracking-wider uppercase cursor-pointer hover:text-cyan-400 transition-colors"
      style={{ color: sortColumn === column ? "#22d3ee" : "#64748b", background: "#0f172a", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      {label} <SortIcon column={column} />
    </th>
  );

  return (
    <div className="rounded-2xl overflow-auto max-h-[70vh]" style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.06)" }}>
      <table className="w-full min-w-[1000px]">
        <thead>
          <tr>
            <th className="sticky top-0 z-10 w-10 px-4 py-3" style={{ background: "#0f172a", borderBottom: "1px solid rgba(255,255,255,0.08)" }}></th>
            <TableHeader column="Name" label="Task" />
            {(propertyOrder || SCORING_PROP_KEYS).map(key => {
              const prop = PROPERTIES.find(p => p.key === key);
              if (!prop) return null;
              // Shorten labels for table
              const shortLabels = {
                "Priority": "Prio", 
                "Urgency": "Urg", 
                "Importance": "Imp",
                "Relevance": "Rel", 
                "Difficulty": "Diff", 
                "Hierarchy": "Hie",
                "Time_Minutes": "Time"
              };
              return <TableHeader key={key} column={key} label={shortLabels[key] || prop.label} />;
            })}
            <th className="sticky top-0 z-10 px-4 py-3 w-24" style={{ background: "#0f172a", borderBottom: "1px solid rgba(255,255,255,0.08)" }}></th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task, idx) => (
            <TaskTableRow
              key={task.Task_ID}
              task={task}
              index={idx}
              getVal={getVal}
              adjustProp={adjustProp}
              propertyModes={propertyModes}
              propertyOrder={propertyOrder}
              isExpanded={expandedTask === task.Task_ID}
              onToggleExpand={() => setExpandedTask(expandedTask === task.Task_ID ? null : task.Task_ID)}
              onComplete={onComplete}
              onDelete={onDelete}
              onPostpone={onPostpone}
              onSubtaskAdded={onSubtaskAdded}
              onSubtaskToggled={onSubtaskToggled}
              onSubtaskDeleted={onSubtaskDeleted}
              evalMode={evalMode}
              isSelected={selectedTasks?.has(task.Task_ID)}
              toggleSelection={toggleSelection}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

//endregion
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  TaskTableRow
// ─────────────────────────────────────────────────────────────────────────────

function TaskTableRow({ task, index, getVal, adjustProp, propertyModes, propertyOrder, isExpanded, onToggleExpand, onComplete, onDelete, onPostpone, onSubtaskAdded, onSubtaskToggled, onSubtaskDeleted, evalMode, isSelected, toggleSelection }) {

  const PropertyCell = ({ propKey }) => {
    const value = getVal(task, propKey);
    const prop  = PROPERTIES.find(p => p.key === propKey);
    const mode  = propertyModes[propKey] || "binary";

    if (propKey === "Time_Minutes") {
      return (
        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5">
            <button onClick={() => adjustProp(task.Task_ID, propKey, -1)}
              className="w-5 h-5 flex items-center justify-center rounded text-xs hover:bg-white/10 transition-colors" style={{ color: "#94a3b8" }}>−</button>
            <span className="font-mono text-sm font-bold w-14 text-center" style={{ color: prop?.hex }}>
              {formatMinutes(value)}
            </span>
            <button onClick={() => adjustProp(task.Task_ID, propKey, 1)}
              className="w-5 h-5 flex items-center justify-center rounded text-xs hover:bg-white/10 transition-colors" style={{ color: "#94a3b8" }}>＋</button>
          </div>
        </td>
      );
    }

    if (mode === "binary") {
      const isYes = value >= 5;
      return (
        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => adjustProp(task.Task_ID, propKey, 0, isYes ? 1 : 10)}
            className="px-3 py-1 rounded-lg text-xs font-black transition-all"
            style={{
              background: isYes ? "rgba(74,222,128,0.2)" : "rgba(255,255,255,0.06)",
              color: isYes ? "#4ade80" : "#475569",
              border: `1px solid ${isYes ? "rgba(74,222,128,0.4)" : "rgba(255,255,255,0.08)"}`,
            }}>
            {isYes ? "✓ YES" : "✗ NO"}
          </button>
        </td>
      );
    }

    // Scale mode
    return (
      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1.5">
          <button onClick={() => adjustProp(task.Task_ID, propKey, -1)}
            className="w-5 h-5 flex items-center justify-center rounded text-xs hover:bg-white/10 transition-colors" style={{ color: "#94a3b8" }}>−</button>
          <span className="font-mono text-sm font-bold w-6 text-center" style={{ color: prop?.hex }}>{value}</span>
          <button onClick={() => adjustProp(task.Task_ID, propKey, 1)}
            className="w-5 h-5 flex items-center justify-center rounded text-xs hover:bg-white/10 transition-colors" style={{ color: "#94a3b8" }}>＋</button>
        </div>
      </td>
    );
  };

  const subtasks   = task.Subtasks || [];
  const hasSubtasks = subtasks.length > 0;
  const doneCount  = subtasks.filter((s) => s.done).length;
  // Only rows with subtasks are expandable — the Table tab no longer adds them.
  const rowClickable = evalMode || hasSubtasks;

  return (
    <>
      <tr className={`border-t border-white/5 transition-colors ${rowClickable ? "cursor-pointer" : ""} ${evalMode && isSelected ? "bg-indigo-950/40" : "hover:bg-white/[0.03]"}`} onClick={() => { if (evalMode) toggleSelection(task.Task_ID); else if (hasSubtasks) onToggleExpand(); }}>
        {/* Rank / Checkbox */}
        <td className="px-4 py-3 text-center text-xs text-gray-600 select-none">
          {evalMode ? (
            <div className={`w-5 h-5 inline-flex items-center justify-center rounded border ${isSelected ? 'border-purple-500 bg-purple-500 text-white' : 'border-gray-600 text-transparent'}`}>
              ✓
            </div>
          ) : (
            index + 1
          )}
        </td>
        {/* Name */}
        <td className="px-4 py-3">
          <div>
            <div className="font-bold text-sm flex items-center gap-2">
              {task.Name}
              {hasSubtasks && (
                <span className="inline-flex items-center gap-1 text-[9px] font-black tracking-wider px-1.5 py-0.5 rounded-md"
                  style={{ background: doneCount === subtasks.length ? "rgba(74,222,128,0.15)" : "rgba(34,211,238,0.12)",
                           color: doneCount === subtasks.length ? "#4ade80" : "#22d3ee",
                           border: `1px solid ${doneCount === subtasks.length ? "rgba(74,222,128,0.3)" : "rgba(34,211,238,0.25)"}` }}>
                  ☑ {doneCount}/{subtasks.length}
                  <motion.span
                    animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: 0.2 }}
                    className="text-[8px]">▼</motion.span>
                </span>
              )}
            </div>
            {task.Context && (
              <div className="text-xs text-gray-600 mt-0.5 truncate max-w-xs">{task.Context}</div>
            )}
          </div>
        </td>

        {/* Property cells — all stop propagation internally */}
        {(propertyOrder || SCORING_PROP_KEYS)
        .map(key => PROPERTIES.find(p => p.key === key))
        .filter(Boolean)
        .map(({ key }) => (
          <PropertyCell key={key} propKey={key} />
        ))}

        {/* Action buttons */}
        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
          <div className="flex gap-1.5">
            <motion.button whileTap={{ scale: 0.7 }}
              onClick={() => onComplete(task.Task_ID)}
              className="w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all"
              style={{ borderColor: "#334155", background: "transparent" }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#4ade80"; e.currentTarget.style.background = "rgba(74,222,128,0.1)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#334155"; e.currentTarget.style.background = "transparent"; }}
              title="Complete">
              <span className="text-xs text-green-400">✓</span>
            </motion.button>
            <button onClick={() => onPostpone(task)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-sm hover:bg-orange-500/20 transition-colors"
              style={{ color: "#fb923c" }} title="Postpone">⏰</button>
            <button onClick={() => onDelete(task.Task_ID)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-sm hover:bg-red-500/20 transition-colors"
              style={{ color: "#f87171" }} title="Delete">✕</button>
          </div>
        </td>
      </tr>

      {/* Expanded subtask row — read-only view distributed across columns.
          Adding subtasks lives in the ✅ Subtasks tab, not here. */}
      {isExpanded && hasSubtasks && (
        <tr>
          <td colSpan={10} className="px-4 py-4" style={{ background: "rgba(0,0,0,0.2)", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
            <div className="pl-8">
              <div className="flex items-center gap-2 mb-3">
                <p className="text-[10px] font-black tracking-widest text-gray-600 uppercase">Subtasks</p>
                <div className="flex-1 max-w-[160px] h-1 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
                  <div style={{ width: `${Math.round((doneCount / subtasks.length) * 100)}%`, height: "100%",
                                background: doneCount === subtasks.length ? "#4ade80" : "#22d3ee", borderRadius: 9999 }} />
                </div>
                <span className="text-[10px] font-black tabular-nums" style={{ color: doneCount === subtasks.length ? "#4ade80" : "#64748b" }}>
                  {doneCount}/{subtasks.length}
                </span>
              </div>
              <div className="grid gap-x-6 gap-y-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
                {subtasks.map(st => (
                  <div key={st.id} className="flex items-center gap-2 text-sm group">
                    <button onClick={(e) => { e.stopPropagation(); onSubtaskToggled(task.Task_ID, st.id, !st.done); }}
                      className="w-4 h-4 flex-shrink-0 rounded border flex items-center justify-center transition-all"
                      style={{ borderColor: st.done ? "#22d3ee" : "#334155", background: st.done ? "rgba(34,211,238,0.15)" : "transparent" }}>
                      {st.done && <span className="text-[8px] text-cyan-400">✓</span>}
                    </button>
                    <span className={`flex-1 truncate ${st.done ? "line-through text-gray-600" : "text-gray-300"}`}>{st.name}</span>
                    <button onClick={(e) => { e.stopPropagation(); onSubtaskDeleted(task.Task_ID, st.id); }}
                      className="text-xs text-gray-800 group-hover:text-gray-600 hover:!text-red-400 transition-colors flex-shrink-0">✕</button>
                  </div>
                ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  TaskCard
// ─────────────────────────────────────────────────────────────────────────────

function TaskCard({ task, rank, isExiting, getVal, onComplete, onDelete, onPostpone, onSubtaskAdded, onSubtaskToggled, onSubtaskDeleted, prefersReduced }) {
  const spring = { type: "spring", stiffness: 380, damping: 38 };

  const subtasks = task.Subtasks || [];
  const doneCount = subtasks.filter((s) => s.done).length;
  const donePct   = subtasks.length ? Math.round((doneCount / subtasks.length) * 100) : null;
  const allDone   = subtasks.length > 0 && doneCount === subtasks.length;

  return (
    <motion.div layout={!prefersReduced} layoutId={task.Task_ID}
      initial={{ opacity: 0, x: -20, scale: 0.98 }}
      animate={isExiting ? { opacity: 0, x: 120, scale: 0.92 } : { opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 120, scale: 0.9 }}
      transition={prefersReduced ? { duration: 0 } : { ...spring, layout: spring }}
      className="mb-3 rounded-2xl overflow-hidden transition-colors"
      style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.05)", borderLeft: `3px solid ${allDone ? "#4ade80" : "#22d3ee"}` }}>

      {/* Header — no longer a toggle; subtasks are always visible below */}
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span className="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-lg text-xs font-black"
          style={{ background: "rgba(255,255,255,0.04)", color: "#64748b" }}>{rank}</span>

        <motion.button whileTap={{ scale: 0.7 }} onClick={() => onComplete(task.Task_ID)} title="Mark complete"
          className="w-5 h-5 flex-shrink-0 rounded-full border-2 transition-colors"
          style={{ borderColor: "#334155" }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#4ade80")}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#334155")} />

        <div className="flex-1 min-w-0">
          <p className="text-white text-sm font-bold leading-snug truncate">{task.Name}</p>
          {task.Context && <p className="text-gray-600 text-xs mt-0.5 truncate">{task.Context}</p>}
        </div>

        {/* Progress ring-style badge */}
        {donePct !== null ? (
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-24 h-1.5 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
              <motion.div animate={{ width: `${donePct}%` }} transition={{ type: "spring", stiffness: 300, damping: 28 }}
                style={{ height: "100%", background: allDone ? "#4ade80" : "#22d3ee", borderRadius: 9999 }} />
            </div>
            <span className="text-[10px] font-black tabular-nums w-14 text-right"
              style={{ color: allDone ? "#4ade80" : "#64748b" }}>{doneCount}/{subtasks.length}</span>
          </div>
        ) : (
          <span className="text-[9px] font-black tracking-widest uppercase text-gray-700 flex-shrink-0">No subtasks yet</span>
        )}

        <button onClick={() => onPostpone(task)} title="Postpone until tomorrow"
          className="flex-shrink-0 text-sm transition-colors" style={{ color: "#334155" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#fb923c")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#334155")}>⏰</button>

        <button onClick={() => onDelete(task.Task_ID)} title="Delete"
          className="flex-shrink-0 text-xs transition-colors ml-1" style={{ color: "#334155" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#f87171")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#334155")}>✕</button>
      </div>

      {/* Subtasks always visible — this is the whole point of the tab */}
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
        <SubtaskSection task={task}
          onAdded={(st)      => onSubtaskAdded(task.Task_ID, st)}
          onToggled={(id, d) => onSubtaskToggled(task.Task_ID, id, d)}
          onDeleted={(id)    => onSubtaskDeleted(task.Task_ID, id)} />
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  StatsView — read-only aggregate dashboard (no per-task list)
// ─────────────────────────────────────────────────────────────────────────────

const heatOf      = (u, i) => Math.round((u * i) / 10);
const heatColorOf = (h) => (h >= 8 ? "#ef4444" : h >= 5 ? "#f97316" : h >= 3 ? "#eab308" : "#22d3ee");

function StatsView({ tasks, getVal }) {
  // ── Aggregate metrics across all active tasks ──
  const count = tasks.length;
  const totalTime = tasks.reduce((sum, t) => sum + (getVal(t, "Time_Minutes") || 0), 0);
  const totalHours = totalTime / 60;
  const avgTime = count ? Math.round(totalTime / count) : 0;
  const heats = tasks.map((t) => heatOf(getVal(t, "Urgency"), getVal(t, "Importance")));
  const avgHeat = count ? Math.round((heats.reduce((a, b) => a + b, 0) / count) * 10) : 0;

  // Average of each scoring property (1–10 scale).
  const avgOf = (key) => count ? (tasks.reduce((s, t) => s + (getVal(t, key) || 0), 0) / count) : 0;
  const fmtAvg = (v) => (Math.round(v * 10) / 10).toFixed(1);

  const criticalCount = heats.filter((h) => h >= 8).length;
  const quickWins = tasks.filter((t) => (getVal(t, "Time_Minutes") || 0) > 0 && (getVal(t, "Time_Minutes") || 0) <= 30).length;
  const timeVals = tasks.map((t) => getVal(t, "Time_Minutes") || 0).filter((v) => v > 0);
  const longest = timeVals.length ? Math.max(...timeVals) : 0;

  const bands = [
    { label: "Critical", color: "#ef4444", n: heats.filter((h) => h >= 8).length },
    { label: "High",     color: "#f97316", n: heats.filter((h) => h >= 5 && h < 8).length },
    { label: "Medium",   color: "#eab308", n: heats.filter((h) => h >= 3 && h < 5).length },
    { label: "Low",      color: "#22d3ee", n: heats.filter((h) => h < 3).length },
  ];

  // ── Chart data ──
  const scoreProps = PROPERTIES.filter((p) => ["Urgency", "Importance", "Relevance", "Difficulty"].includes(p.key));
  const topByTime = [...tasks]
    .filter((t) => (getVal(t, "Time_Minutes") || 0) > 0)
    .sort((a, b) => (getVal(b, "Time_Minutes") || 0) - (getVal(a, "Time_Minutes") || 0))
    .slice(0, 6);
  const maxTime = topByTime.length ? (getVal(topByTime[0], "Time_Minutes") || 0) : 0;

  const StatTile = ({ label, value, sub, color }) => (
    <div className="rounded-2xl px-4 py-3 flex flex-col gap-0.5"
      style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.06)" }}>
      <p className="text-[9px] font-black tracking-widest uppercase text-gray-600">{label}</p>
      <p className="text-2xl font-black leading-tight" style={{ color: color || "#e2e8f0" }}>{value}</p>
      {sub && <p className="text-[10px] text-gray-600">{sub}</p>}
    </div>
  );

  return (
    <div>
      {/* ── Dashboard: headline metrics ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatTile label="Active Tasks" value={count} sub="in the queue" />
        <StatTile label="Total Est. Time" value={formatMinutes(totalTime)}
          sub={`≈ ${(Math.round(totalHours * 10) / 10).toFixed(1)} hours`} color="#60a5fa" />
        <StatTile label="Avg Focus Score" value={`${avgHeat}%`} sub="urgency × importance" color={heatColorOf(Math.round(avgHeat / 10))} />
        <div className="rounded-2xl px-4 py-3 flex flex-col gap-1.5"
          style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.06)" }}>
          <p className="text-[9px] font-black tracking-widest uppercase text-gray-600">Priority Mix</p>
          <div className="flex h-2.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
            {bands.map((b) => b.n > 0 && (
              <div key={b.label} title={`${b.label}: ${b.n}`}
                style={{ width: `${(b.n / count) * 100}%`, background: b.color }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            {bands.map((b) => (
              <span key={b.label} className="flex items-center gap-1 text-[9px] text-gray-500">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: b.color }} />{b.label} {b.n}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ── Dashboard: workload breakdown ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatTile label="Avg Time / Task" value={formatMinutes(avgTime)} sub="mean effort per task" color="#60a5fa" />
        <StatTile label="Critical Tasks" value={criticalCount}
          sub={count ? `${Math.round((criticalCount / count) * 100)}% of queue` : "focus ≥ 80%"} color="#ef4444" />
        <StatTile label="Quick Wins" value={quickWins} sub="≤ 30 min each" color="#22d3ee" />
        <StatTile label="Longest Task" value={longest ? formatMinutes(longest) : "—"} sub="biggest single effort" color="#a855f7" />
      </div>

      {/* ── Dashboard: average scores ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatTile label="Avg Urgency" value={fmtAvg(avgOf("Urgency"))} sub="out of 10" color="#fb923c" />
        <StatTile label="Avg Importance" value={fmtAvg(avgOf("Importance"))} sub="out of 10" color="#facc15" />
        <StatTile label="Avg Relevance" value={fmtAvg(avgOf("Relevance"))} sub="out of 10" color="#34d399" />
        <StatTile label="Avg Difficulty" value={fmtAvg(avgOf("Difficulty"))} sub="out of 10" color="#c084fc" />
      </div>

      {/* ── Charts ── */}
      {count > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* Average score by property */}
          <div className="rounded-2xl px-5 py-4" style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.06)" }}>
            <p className="text-[9px] font-black tracking-widest uppercase text-gray-600 mb-4">Average Score by Property</p>
            <div className="flex flex-col gap-3">
              {scoreProps.map((p) => {
                const v = avgOf(p.key);
                return (
                  <div key={p.key} className="flex items-center gap-3">
                    <span className="text-[10px] font-black tracking-wider uppercase w-24 shrink-0" style={{ color: p.hex }}>{p.label}</span>
                    <div className="flex-1 h-2.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
                      <motion.div initial={{ width: 0 }} animate={{ width: `${(v / 10) * 100}%` }}
                        transition={{ type: "spring", stiffness: 120, damping: 20 }}
                        style={{ height: "100%", background: p.bar, borderRadius: 9999 }} />
                    </div>
                    <span className="text-xs font-mono font-bold w-8 text-right" style={{ color: p.hex }}>{fmtAvg(v)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Priority mix donut */}
          <div className="rounded-2xl px-5 py-4 flex items-center gap-5" style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="shrink-0">
              <svg width="120" height="120" viewBox="0 0 120 120">
                <g transform="rotate(-90 60 60)">
                  {(() => {
                    const r = 46, C = 2 * Math.PI * r;
                    let offset = 0;
                    return bands.filter((b) => b.n > 0).map((b) => {
                      const frac = b.n / count;
                      const seg = (
                        <motion.circle key={b.label} cx="60" cy="60" r={r} fill="none"
                          stroke={b.color} strokeWidth="16"
                          initial={{ strokeDasharray: `0 ${C}` }}
                          animate={{ strokeDasharray: `${frac * C} ${C}` }}
                          transition={{ duration: 0.5 }}
                          strokeDashoffset={-offset} />
                      );
                      offset += frac * C;
                      return seg;
                    });
                  })()}
                </g>
                <text x="60" y="58" textAnchor="middle" fill="#f8fafc" style={{ fontSize: 22, fontWeight: 900 }}>{count}</text>
                <text x="60" y="74" textAnchor="middle" fill="#64748b" style={{ fontSize: 8, letterSpacing: 1 }}>TASKS</text>
              </svg>
            </div>
            <div className="flex-1">
              <p className="text-[9px] font-black tracking-widest uppercase text-gray-600 mb-3">Priority Mix</p>
              <div className="flex flex-col gap-1.5">
                {bands.map((b) => (
                  <div key={b.label} className="flex items-center gap-2 text-[11px]">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: b.color }} />
                    <span className="text-gray-400 flex-1">{b.label}</span>
                    <span className="font-mono font-bold" style={{ color: b.color }}>{b.n}</span>
                    <span className="text-gray-600 w-9 text-right">{count ? Math.round((b.n / count) * 100) : 0}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Time distribution — longest tasks */}
          <div className="rounded-2xl px-5 py-4 lg:col-span-2" style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.06)" }}>
            <p className="text-[9px] font-black tracking-widest uppercase text-gray-600 mb-4">Longest Tasks by Time</p>
            {topByTime.length === 0 ? (
              <p className="text-xs text-gray-600">No timed tasks yet.</p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {topByTime.map((t) => {
                  const mins = getVal(t, "Time_Minutes") || 0;
                  const w = maxTime ? (mins / maxTime) * 100 : 0;
                  return (
                    <div key={t.Task_ID} className="flex items-center gap-3">
                      <span className="text-[11px] text-gray-300 w-40 shrink-0 truncate">{t.Name}</span>
                      <div className="flex-1 h-2.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
                        <motion.div initial={{ width: 0 }} animate={{ width: `${w}%` }}
                          transition={{ type: "spring", stiffness: 120, damping: 20 }}
                          style={{ height: "100%", background: "#3b82f6", borderRadius: 9999 }} />
                      </div>
                      <span className="text-xs font-mono font-bold text-blue-400 w-14 text-right">{formatMinutes(mins)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SubtaskSection
// ─────────────────────────────────────────────────────────────────────────────

function SubtaskSection({ task, onAdded, onToggled, onDeleted }) {
  const [newName, setNewName]           = useState("");
  const [addingPhase, setAddingPhase]   = useState("idle");
  const [suggestPhase, setSuggestPhase] = useState("idle");
  const [suggestions, setSuggestions]   = useState([]);
  const subtasks = task.Subtasks || [];

  const handleAddManual = async () => {
    if (!newName.trim()) return;
    setAddingPhase("loading");
    try {
      const st = await apiFetch(`/tasks/${task.Task_ID}/subtasks`, {
        method: "POST",
        body: JSON.stringify({ name: newName.trim() }),
      });
      onAdded(st); setNewName(""); setAddingPhase("idle");
    } catch { setAddingPhase("idle"); }
  };

  const handleSuggest = async () => {
    setSuggestPhase("loading");
    try {
      const { suggestions: s } = await apiFetch(`/tasks/${task.Task_ID}/subtasks/suggest`, { method: "POST" });
      setSuggestions(s); setSuggestPhase("showing");
    } catch { setSuggestPhase("idle"); }
  };

  const acceptSuggestion = async (name) => {
    try {
      const st = await apiFetch(`/tasks/${task.Task_ID}/subtasks`, {
        method: "POST", body: JSON.stringify({ name }),
      });
      onAdded(st);
      setSuggestions((p) => p.filter((s) => s !== name));
      if (suggestions.length === 1) setSuggestPhase("idle");
    } catch {}
  };

  const dismissSuggestion = (name) => {
    setSuggestions((p) => p.filter((s) => s !== name));
    if (suggestions.length === 1) setSuggestPhase("idle");
  };

  return (
    <div className="mx-4 mb-4 rounded-xl overflow-hidden"
      style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
      <div className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: subtasks.length || suggestPhase !== "idle" ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
        <p className="text-[9px] font-black tracking-widest text-gray-600 uppercase">
          Subtasks {subtasks.length > 0 && `(${subtasks.filter((s) => s.done).length}/${subtasks.length})`}
        </p>
        <button onClick={handleSuggest} disabled={suggestPhase === "loading"}
          className="text-[9px] font-black tracking-widest uppercase px-2 py-1 rounded-lg transition-all disabled:opacity-40"
          style={{ color: "#a78bfa", background: "rgba(167,139,250,0.08)", border: "1px solid rgba(167,139,250,0.2)" }}>
          {suggestPhase === "loading" ? "✦ THINKING…" : "✦ AI SUGGEST"}
        </button>
      </div>
      <AnimatePresence>
        {suggestPhase === "showing" && suggestions.length > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}
            className="px-3 py-2" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
            <p className="text-[9px] text-purple-400 tracking-widest uppercase mb-2">AI Suggestions</p>
            <div className="flex flex-col gap-1.5">
              {suggestions.map((s) => (
                <motion.div key={s} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }} layout className="flex items-center gap-2 text-xs text-gray-300">
                  <span className="flex-1 truncate">{s}</span>
                  <button onClick={() => acceptSuggestion(s)}
                    className="text-[9px] font-black px-2 py-0.5 rounded-md transition-all"
                    style={{ color: "#4ade80", background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.2)" }}>
                    ✓ ADD
                  </button>
                  <button onClick={() => dismissSuggestion(s)}
                    className="text-[9px] font-black px-2 py-0.5 rounded-md"
                    style={{ color: "#64748b", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    ✕
                  </button>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {subtasks.length > 0 && (
        <div className="px-3 py-2 flex flex-col gap-1.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
          <AnimatePresence>
            {subtasks.map((st) => (
              <motion.div key={st.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="flex items-center gap-2">
                <button onClick={() => onToggled(st.id, !st.done)}
                  className="w-4 h-4 flex-shrink-0 rounded border transition-all flex items-center justify-center"
                  style={{ borderColor: st.done ? "#22d3ee" : "#334155", background: st.done ? "rgba(34,211,238,0.15)" : "transparent" }}>
                  {st.done && <span className="text-[8px] text-cyan-400">✓</span>}
                </button>
                <span className="flex-1 text-xs truncate transition-all"
                  style={{ color: st.done ? "#475569" : "#cbd5e1", textDecoration: st.done ? "line-through" : "none" }}>
                  {st.name}
                </span>
                <button onClick={() => onDeleted(st.id)} className="text-[9px] transition-colors flex-shrink-0"
                  style={{ color: "#1e293b" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#f87171")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#1e293b")}>✕</button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        <input value={newName} onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAddManual()}
          placeholder="Add a subtask…"
          className="flex-1 bg-transparent text-xs text-white placeholder-gray-700 outline-none"
          style={{ fontFamily: "inherit" }} />
        <button onClick={handleAddManual} disabled={!newName.trim() || addingPhase === "loading"}
          className="text-[9px] font-black tracking-widest px-2 py-1 rounded-lg transition-all disabled:opacity-30"
          style={{ color: "#22d3ee", background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.2)" }}>
          ＋ ADD
        </button>
      </div>
    </div>
  );
}

function PropertyControl({ label, value, hex, bar, propKey, onDec, onInc, onSet, mode = "binary" }) {
  if (propKey === "Time_Minutes") {
    // Time always renders as scale with ±
    return (
      <div className="rounded-xl p-2.5 flex flex-col gap-2"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
        <p className="text-[9px] font-black tracking-widest" style={{ color: hex }}>{label}</p>
        <div className="flex items-center gap-1.5">
          <button onClick={onDec} className="w-6 h-6 flex items-center justify-center rounded-lg text-xs font-black"
            style={{ background: "rgba(255,255,255,0.06)", color: "#94a3b8" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.1)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}>−</button>
          <span className="flex-1 text-center font-black text-xs text-white">{formatMinutes(value)}</span>
          <button onClick={onInc} className="w-6 h-6 flex items-center justify-center rounded-lg text-xs font-black"
            style={{ background: "rgba(255,255,255,0.06)", color: "#94a3b8" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.1)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}>＋</button>
        </div>
      </div>
    );
  }

  if (mode === "binary") {
    const isYes = value === 10;
    return (
      <div className="rounded-xl p-2.5"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
        <p className="text-[9px] font-black tracking-widest mb-2" style={{ color: hex }}>{label}</p>
        <button
          onClick={() => onSet(isYes ? 1 : 10)}
          className="w-full py-2 rounded-lg text-xs font-black transition-all"
          style={{
            background: isYes ? "rgba(74,222,128,0.2)" : "rgba(255,255,255,0.06)",
            border: `1px solid ${isYes ? "rgba(74,222,128,0.4)" : "rgba(255,255,255,0.1)"}`,
            color: isYes ? "#4ade80" : "#94a3b8",
          }}>
          {isYes ? "✓ YES" : "✗ NO"}
        </button>
      </div>
    );
  }

  // Scale mode
  return (
    <div className="rounded-xl p-2.5 flex flex-col gap-2"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
      <p className="text-[9px] font-black tracking-widest" style={{ color: hex }}>{label}</p>
      <div className="flex items-center gap-1.5">
        <button onClick={onDec} disabled={value <= 1}
          className="w-6 h-6 flex items-center justify-center rounded-lg text-xs font-black disabled:opacity-25"
          style={{ background: "rgba(255,255,255,0.06)", color: "#94a3b8" }}
          onMouseEnter={(e) => !e.currentTarget.disabled && (e.currentTarget.style.background = "rgba(255,255,255,0.1)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}>−</button>
        <span className="flex-1 text-center font-black text-sm text-white">{value}</span>
        <button onClick={onInc} disabled={value >= 10}
          className="w-6 h-6 flex items-center justify-center rounded-lg text-xs font-black disabled:opacity-25"
          style={{ background: "rgba(255,255,255,0.06)", color: "#94a3b8" }}
          onMouseEnter={(e) => !e.currentTarget.disabled && (e.currentTarget.style.background = "rgba(255,255,255,0.1)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}>＋</button>
      </div>
      <div className="h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
        <motion.div animate={{ width: `${value * 10}%` }} transition={{ type: "spring", stiffness: 300, damping: 28 }}
          style={{ height: "100%", background: bar, borderRadius: 9999 }} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Drag and Drop for Property Reordering
// ─────────────────────────────────────────────────────────────────────────────

const DndContext = createContext(null);

function DndProvider({ children }) {
  const [dragState, setDragState] = useState(null);

  const value = { dragState, setDragState };
  return <DndContext.Provider value={value}>{children}</DndContext.Provider>;
}

function useDnd() {
  const ctx = useContext(DndContext);
  if (!ctx) throw new Error('useDnd must be used within DndProvider');
  return ctx;
}

function ReorderablePropertyList({ propertyOrder, propertyModes, onReorder, onModeChange }) {
  const { dragState, setDragState } = useDnd();
  const listRef = useRef(null);
  const dragIndex = useRef(null);

  const handlePointerDown = (index, e) => {
    // Only start drag from the handle
    if (!e.target.closest('[data-drag-handle]')) return;
    e.preventDefault();
    dragIndex.current = index;
    setDragState({ fromIndex: index, active: true });
  };

  useEffect(() => {
    if (!dragState?.active) return;

    const handlePointerMove = (e) => {
      // Highlight the drop zone under the cursor
      const elements = listRef.current?.querySelectorAll('[data-drop-zone]');
      if (!elements) return;
      elements.forEach(el => {
        const rect = el.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          el.style.outline = e.clientY < midY 
            ? '2px solid rgba(6,182,212,0.5)' 
            : '2px solid rgba(168,85,247,0.5)';
          el.style.outlineOffset = '-2px';
        } else {
          el.style.outline = '';
          el.style.outlineOffset = '';
        }
      });
    };

    const handlePointerUp = (e) => {
      if (dragIndex.current === null) return;

      // Find which drop zone we're over
      const elements = listRef.current?.querySelectorAll('[data-drop-zone]');
      if (!elements) return;

      let targetIndex = dragIndex.current; // default: no move

      // Determine target index based on cursor position
      const dropZones = Array.from(elements).map((el, idx) => ({
        el,
        idx,
        rect: el.getBoundingClientRect(),
      }));

      // Find the closest drop zone to the cursor
      for (const { el, idx, rect } of dropZones) {
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const midY = rect.top + rect.height / 2;
          // If dropping on the bottom half, target the next position
          targetIndex = e.clientY < midY ? idx : idx + 1;
          break;
        }
      }

      // Clean up highlights
      elements.forEach(el => {
        el.style.outline = '';
        el.style.outlineOffset = '';
      });

      // Perform the reorder
      if (targetIndex !== dragIndex.current) {
        const fromIndex = dragIndex.current;
        const newOrder = [...propertyOrder];

        // Remove from original position
        const [moved] = newOrder.splice(fromIndex, 1);
        
        // Adjust target if we removed before it
        const adjustedTarget = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
        newOrder.splice(adjustedTarget, 0, moved);
        
        onReorder(newOrder);
      }

      dragIndex.current = null;
      setDragState(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragState, propertyOrder, onReorder]);

  const orderedKeys = propertyOrder.filter(k => k !== "Time_Minutes");

  return (
    <div ref={listRef} className="space-y-1">
      {orderedKeys.map((propKey, index) => {
        const prop = PROPERTIES.find(p => p.key === propKey);
        const mode = propertyModes[propKey] || "binary";
        const isDragging = dragState?.fromIndex === index;

        return (
          <div
            key={propKey}
            data-drop-zone
            className="flex items-center gap-3 py-2.5 px-3 rounded-lg transition-all"
            style={{
              background: isDragging ? "rgba(6,182,212,0.08)" : "rgba(255,255,255,0.02)",
              border: `1px solid ${isDragging ? "rgba(6,182,212,0.3)" : "rgba(255,255,255,0.06)"}`,
              userSelect: 'none',
              touchAction: 'none',
              opacity: isDragging ? 0.6 : 1,
              transform: isDragging ? 'scale(1.02)' : 'scale(1)',
            }}
            onPointerDown={(e) => handlePointerDown(index, e)}
          >
            {/* Drag handle */}
            <span
              data-drag-handle
              className="text-gray-600 hover:text-gray-400 text-sm cursor-grab active:cursor-grabbing px-1 select-none"
              title="Drag to reorder"
              style={{ touchAction: 'none' }}
            >
              ⠿
            </span>

            {/* Color indicator */}
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ background: prop?.hex || '#666' }}
            />

            {/* Property name */}
            <span className="text-xs text-gray-300 flex-1 font-medium">{prop?.label || propKey}</span>

            {/* Mode buttons */}
            <div className="flex gap-1.5 flex-shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onModeChange(propKey, "binary");
                }}
                className={`px-2.5 py-1 rounded-md text-[9px] font-black transition-all ${
                  mode === "binary"
                    ? "bg-purple-500/20 text-purple-400 border border-purple-500/40"
                    : "text-gray-600 hover:text-gray-400 border border-transparent"
                }`}>
                ✓/✗
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onModeChange(propKey, "scale");
                }}
                className={`px-2.5 py-1 rounded-md text-[9px] font-black transition-all ${
                  mode === "scale"
                    ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                    : "text-gray-600 hover:text-gray-400 border border-transparent"
                }`}>
                1-10
              </button>
            </div>
          </div>
        );
      })}

      {/* Time_Minutes always at bottom */}
      <div
        className="flex items-center gap-3 py-2.5 px-3 rounded-lg opacity-60"
        style={{
          background: "rgba(255,255,255,0.02)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <span className="text-gray-700 text-sm px-1">⠿</span>
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ background: "#60a5fa" }}
        />
        <span className="text-xs text-gray-500 flex-1 font-medium">TIME (min)</span>
        <span className="text-[9px] text-gray-600 px-2">always scale</span>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
//  Utility components
// ─────────────────────────────────────────────────────────────────────────────

function DarkInput({ value, onChange, onEnter, placeholder, disabled, className = "" }) {
  return (
    <input value={value} onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
      placeholder={placeholder} disabled={disabled}
      className={`rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-700 outline-none transition-all ${className}`}
      style={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.07)", fontFamily: "inherit" }}
      onFocus={(e) => (e.target.style.borderColor = "rgba(6,182,212,0.5)")}
      onBlur={(e)  => (e.target.style.borderColor = "rgba(255,255,255,0.07)")} />
  );
}

function ModalBtn({ onClick, accent = "gray", disabled = false, children }) {
  const colors = {
    cyan:   { bg: "rgba(6,182,212,0.15)",   border: "rgba(6,182,212,0.4)",   color: "#67e8f9" },
    orange: { bg: "rgba(251,146,60,0.15)",  border: "rgba(251,146,60,0.4)",  color: "#fdba74" },
    gray:   { bg: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.1)", color: "#94a3b8" },
  };
  const c = colors[accent] ?? colors.gray;
  return (
    <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
      onClick={onClick} disabled={disabled}
      className="w-full py-3 rounded-xl font-black text-sm tracking-widest disabled:opacity-40"
      style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.color }}>
      {children}
    </motion.button>
  );
}

function SpinRing({ color = "cyan" }) {
  const c = color === "cyan"
    ? ["border-cyan-500/20 border-t-cyan-400", "border-purple-500/20 border-b-purple-400", "text-cyan-400"]
    : ["border-purple-500/20 border-t-purple-400", "border-pink-500/20 border-b-pink-400", "text-purple-400"];
  return (
    <div className="relative">
      <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
        className={`w-20 h-20 rounded-full border-2 ${c[0]}`} />
      <motion.div animate={{ rotate: -360 }} transition={{ repeat: Infinity, duration: 3, ease: "linear" }}
        className={`absolute inset-2 rounded-full border-2 ${c[1]}`} />
      <div className="absolute inset-0 flex items-center justify-center">
        <span className={`${c[2]} text-xs font-black tracking-widest`}>AI</span>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span className="inline-block w-3 h-3 rounded-full border-2 animate-spin"
      style={{ borderColor: "rgba(255,255,255,0.3)", borderTopColor: "#fff" }} />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//region Auth & Wrapper
// ─────────────────────────────────────────────────────────────────────────────

function AuthApp() {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (isLogin) {
        const formData = new URLSearchParams();
        formData.append("username", username);
        formData.append("password", password);
        let data;
        try {
          data = await fetchApi(`${API}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formData
          });
        } catch (err) {
          throw new Error("Invalid credentials");
        }
        localStorage.setItem("token", data.access_token);
        window.location.reload();
      } else {
        try {
          await fetchApi(`${API}/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
          });
        } catch (err) {
          let msg = "Registration failed";
          const match = err.message.match(/API Error \(\d+\): (.*)/);
          if (match) {
            try {
              const parsed = JSON.parse(match[1]);
              if (parsed.detail) msg = parsed.detail;
            } catch(e) {}
          }
          throw new Error(msg);
        }
        setIsLogin(true);
        setError("Registration successful! Please log in.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-4 text-gray-200 font-sans">
      <div className="mb-8 text-center">
        <h1 className="text-4xl font-black bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent mb-2">AI Task Sorter</h1>
        <p className="text-gray-400">Prioritize and sort your tasks with AI</p>
      </div>
      <div className="max-w-md w-full bg-gray-900 border border-gray-800 rounded-xl p-8 shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 left-1/4 right-1/4 h-px bg-gradient-to-r from-transparent via-cyan-500 to-transparent" />
        
        <h2 className="text-2xl font-bold mb-6 text-center text-white">{isLogin ? "Welcome Back" : "Create Account"}</h2>
        {error && <div className="mb-4 p-3 bg-red-900/30 border border-red-800 text-red-200 rounded-lg text-sm">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-400 mb-1 tracking-wider">USERNAME</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} required className="w-full bg-gray-950 border border-gray-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-400 mb-1 tracking-wider">PASSWORD</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required className="w-full bg-gray-950 border border-gray-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all" />
          </div>
          <button type="submit" disabled={loading} className="w-full bg-gradient-to-r from-cyan-500 to-purple-500 hover:from-cyan-400 hover:to-purple-400 text-white font-bold py-3 px-4 rounded-lg transition-all shadow-lg shadow-cyan-500/20 active:scale-[0.98]">
            {loading ? <Spinner /> : (isLogin ? "Login" : "Register")}
          </button>
        </form>
        <div className="mt-6 text-center text-sm text-gray-400">
          {isLogin ? "Don't have an account? " : "Already have an account? "}
          <button type="button" onClick={() => { setIsLogin(!isLogin); setError(""); }} className="text-cyan-400 hover:text-cyan-300 font-semibold transition-colors">
            {isLogin ? "Register" : "Login"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) {
      apiFetch("/users/me")
        .then(() => setIsAuthenticated(true))
        .catch(() => {
          localStorage.removeItem("token");
          setIsAuthenticated(false);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <SpinRing color="cyan" />
      </div>
    );
  }

  return (
    <>
      {isAuthenticated ? <MainApp /> : <AuthApp />}
      <BrandFooter />
    </>
  );
}