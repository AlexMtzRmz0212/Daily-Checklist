import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence, LayoutGroup, useReducedMotion } from "framer-motion";

const API = "http://localhost:8000";

const PROPERTIES = [
  { key: "Priority",      label: "PRIORITY",   hex: "#f87171", bar: "#ef4444" },
  { key: "Urgency",       label: "URGENCY",    hex: "#fb923c", bar: "#f97316" },
  { key: "Importance",    label: "IMPORTANCE", hex: "#facc15", bar: "#eab308" },
  { key: "Relevance",     label: "RELEVANCE",  hex: "#34d399", bar: "#10b981" },
  { key: "Difficulty",    label: "DIFFICULTY", hex: "#c084fc", bar: "#a855f7" },
  { key: "Time_Minutes",  label: "TIME (min)", hex: "#60a5fa", bar: "#3b82f6" },
  { key: "Hierarchy",     label: "HIERARCHY",  hex: "#f472b6", bar: "#ec4899" },
];

const PREVIEW_PROPS = ["Urgency", "Importance", "Priority"];

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "API error");
  }
  return res.json();
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
//  Root App
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [tasks, setTasks]           = useState([]);
  const [localEdits, setLocalEdits] = useState({});
  const [sortPhase, setSortPhase]   = useState("idle");
  const [showInterruptModal, setShowInterruptModal] = useState(false);
  const [preSortSnapshot, setPreSortSnapshot]       = useState([]);
  const [exitingIds, setExitingIds] = useState(new Set());

  const [viewMode, setViewMode]         = useState("card");
  const [sortColumn, setSortColumn]     = useState(null);
  const [sortDirection, setSortDirection] = useState("asc");

  const [showConfigModal, setShowConfigModal] = useState(false);
  const [currentModel, setCurrentModel]       = useState("");
  const [newModel, setNewModel]               = useState("");
  const [modelSavePhase, setModelSavePhase]   = useState("idle");
  const [modelError, setModelError]           = useState("");

  const [propertyModes, setPropertyModes]   = useState({});
  const [modeSavePhase, setModeSavePhase]   = useState("idle");

  const [showAIPlanModal, setShowAIPlanModal] = useState(false);
  const [aiPlanResult, setAIPlanResult]       = useState(null);
  const [aiPlanPhase, setAiPlanPhase]         = useState("idle");
  // FIX 3: error state for AI Plan
  const [aiPlanError, setAiPlanError]         = useState("");

  useEffect(() => {
    apiFetch("/config/properties").then(data => {
      setPropertyModes(data.property_modes);
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
  const prefersReduced = useReducedMotion();

  useEffect(() => {
    apiFetch("/config/model").then(data => {
      setCurrentModel(data.model);
      setNewModel(data.model);
    }).catch(console.error);
    apiFetch("/tasks").then(setTasks).catch(console.error);
  }, []);

  const getVal = useCallback(
    (task, key) => localEdits[task.Task_ID]?.[key] ?? task[key],
    [localEdits]
  );

  const merged = useCallback(
    (task) => ({ ...task, ...(localEdits[task.Task_ID] ?? {}) }),
    [localEdits]
  );

  const hasUnsavedEdits = Object.keys(localEdits).length > 0;

  // FIX 2: adjustProp now honours a presetValue for binary toggles
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
      setSortDirection("asc");
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

  const handleReeval = async () => {
    if (!tasks.length) return;
    setRevalPhase("loading"); setRevalError("");
    try {
      const updated = await apiFetch("/tasks/reevaluate-all", { method: "POST" });
      setTasks(updated); setLocalEdits({}); setRevalPhase("idle");
    } catch (e) { setRevalError(e.message); setRevalPhase("error"); }
  };

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

  // FIX 3: proper error handling + visible error state
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
      setShowAIPlanModal(true);
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

      {/* Config Button */}
      <motion.button
        initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
        onClick={() => setShowConfigModal(true)}
        className="fixed top-4 right-4 z-40 w-10 h-10 rounded-xl flex items-center justify-center"
        style={{ background: "rgba(15,23,42,0.8)", border: "1px solid rgba(6,182,212,0.3)", backdropFilter: "blur(8px)" }}
        whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
        <span className="text-lg">⚙️</span>
      </motion.button>

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
              className="w-full max-w-md mx-4 rounded-2xl p-6"
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

              {/* FIX 2: Scoring modes — binary listed first and styled as the default */}
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <label className="text-[10px] font-black tracking-widest text-gray-600 uppercase">
                    Scoring Modes
                  </label>
                  <span className="text-[9px] px-2 py-0.5 rounded-full font-black"
                    style={{ background: "rgba(167,139,250,0.15)", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.3)" }}>
                    Binary = default
                  </span>
                </div>
                <div className="space-y-2">
                  {Object.keys(propertyModes).map(prop => {
                    if (prop === "Time_Minutes") return null;
                    return (
                      <div key={prop} className="flex items-center justify-between py-2 border-b border-white/5">
                        <span className="text-xs text-gray-300">{prop}</span>
                        <div className="flex gap-2">
                          {/* Binary first — it's the default */}
                          <button
                            onClick={() => setPropertyModes(prev => ({ ...prev, [prop]: "binary" }))}
                            className={`px-3 py-1 rounded-lg text-[10px] font-black transition-all ${
                              propertyModes[prop] === "binary"
                                ? "bg-purple-500/20 text-purple-400 border border-purple-500/40"
                                : "text-gray-600 hover:text-gray-400 border border-transparent"
                            }`}>
                            Binary ✓/✗
                          </button>
                          <button
                            onClick={() => setPropertyModes(prev => ({ ...prev, [prop]: "scale" }))}
                            className={`px-3 py-1 rounded-lg text-[10px] font-black transition-all ${
                              propertyModes[prop] === "scale"
                                ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                                : "text-gray-600 hover:text-gray-400 border border-transparent"
                            }`}>
                            Scale 1-10
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                  onClick={handleSaveModes} disabled={modeSavePhase === "loading"}
                  className="w-full mt-4 py-2 rounded-xl font-black text-xs tracking-widest disabled:opacity-40"
                  style={{ background: "rgba(168,85,247,0.15)", border: "1px solid rgba(168,85,247,0.3)", color: "#c084fc" }}>
                  {modeSavePhase === "loading" ? "SAVING…" : "💾 SAVE MODES"}
                </motion.button>
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

      {/* AI Plan modal */}
      <AnimatePresence>
        {showAIPlanModal && aiPlanResult && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] flex items-center justify-center"
            style={{ background: "rgba(2,6,23,0.95)", backdropFilter: "blur(8px)" }}
            onClick={() => setShowAIPlanModal(false)}>
            <motion.div
              initial={{ scale: 0.85, opacity: 0, y: 24 }} animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.85, opacity: 0, y: 24 }} transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="w-full max-w-2xl mx-4 rounded-2xl p-6"
              style={{ background: "#0f172a", border: "1px solid rgba(6,182,212,0.3)" }}
              onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-black" style={{
                  background: "linear-gradient(135deg,#22d3ee 0%,#a78bfa 100%)",
                  WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                }}>🤖 AI Action Plan</h2>
                <button onClick={() => setShowAIPlanModal(false)} className="text-gray-600 hover:text-gray-400">✕</button>
              </div>
              <div className="max-h-96 overflow-y-auto space-y-4">
                <div>
                  <h3 className="text-cyan-400 text-sm font-black mb-2">📋 Action Plan</h3>
                  <p className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap">{aiPlanResult.plan_text}</p>
                </div>
                <div>
                  <h3 className="text-purple-400 text-sm font-black mb-2">🧠 Reasoning</h3>
                  <p className="text-gray-400 text-sm leading-relaxed">{aiPlanResult.reasoning}</p>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main */}
      <div className={`relative max-w-full lg:max-w-[90rem] xl:max-w-[100rem] 2xl:max-w-[120rem] mx-auto px-4 py-10 transition-opacity duration-300 ${isSorting || isRevaluating ? "pointer-events-none opacity-40" : ""}`}>
        <header className="mb-10 text-center">
          <h1 className="text-5xl font-black tracking-tight mb-1" style={{
            background: "linear-gradient(135deg,#22d3ee 0%,#a78bfa 50%,#f472b6 100%)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          }}>DAILY CHECKLIST SORTER</h1>
        </header>

        {/* Add panel */}
        <section className="mb-6 rounded-2xl p-5" style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.06)" }}>
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
        </section>

        {/* Controls bar */}
        {tasks.length > 0 && (
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <p className="text-[10px] text-gray-600 uppercase tracking-widest">
                {tasks.length} active{hasUnsavedEdits ? " · ● unsaved edits" : ""}
              </p>
              <div className="flex gap-1 rounded-lg p-0.5" style={{ background: "#1e293b" }}>
                {["card", "table"].map(mode => (
                  <button key={mode} onClick={() => setViewMode(mode)}
                    className={`px-3 py-1.5 rounded-md text-[10px] font-black tracking-wider uppercase transition-all ${
                      viewMode === mode ? "text-cyan-400" : "text-gray-600 hover:text-gray-400"
                    }`}
                    style={{ background: viewMode === mode ? "rgba(6,182,212,0.15)" : "transparent" }}>
                    {mode === "card" ? "📋 Cards" : "📊 Table"}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {/* FIX 3: show AI plan error inline */}
              {aiPlanError && (
                <p className="text-red-400 text-xs">⚠ {aiPlanError}</p>
              )}
              <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.94 }}
                onClick={handleAIPlan} disabled={aiPlanPhase === "loading"}
                className="px-5 py-2.5 rounded-xl font-black text-sm tracking-[0.15em] uppercase disabled:opacity-40"
                style={{ background: "rgba(139,92,246,0.15)", border: "1px solid rgba(139,92,246,0.35)", color: "#a78bfa", fontFamily: "inherit" }}>
                {aiPlanPhase === "loading" ? <span className="flex items-center gap-2"><Spinner /> PLANNING…</span> : "🤖 AI PLAN"}
              </motion.button>
              <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.94 }} onClick={handleReeval}
                disabled={isRevaluating}
                className="px-5 py-2.5 rounded-xl font-black text-sm tracking-[0.15em] uppercase disabled:opacity-40"
                style={{ background: "rgba(168,85,247,0.15)", border: "1px solid rgba(168,85,247,0.35)", color: "#c084fc", fontFamily: "inherit" }}>
                {isRevaluating ? <span className="flex items-center gap-2"><Spinner /> EVALUATING…</span> : "↺ RE-EVALUATE"}
              </motion.button>
              {tasks.length > 1 && (
                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.94 }} onClick={handleSort}
                  className="px-8 py-2.5 rounded-xl font-black text-sm tracking-[0.2em] uppercase"
                  style={{ background: "linear-gradient(135deg,#7c3aed,#0891b2)", border: "1px solid rgba(124,58,237,0.4)", boxShadow: "0 0 24px rgba(124,58,237,0.25)", fontFamily: "inherit" }}>
                  ⚡SORT
                </motion.button>
              )}
            </div>
          </div>
        )}

        {revalPhase === "error" && <p className="text-red-400 text-xs mb-3">⚠ Re-evaluate failed: {revalError}</p>}
        {sortError && <p className="text-red-400 text-xs mb-3">⚠ Sort failed: {sortError}</p>}

        {/* Task display */}
        {viewMode === "card" ? (
          <LayoutGroup>
            <AnimatePresence mode="popLayout">
              {sortedTasks.map((task, index) => (
                <TaskCard
                  key={task.Task_ID}
                  task={task}
                  rank={index + 1}
                  isExiting={exitingIds.has(task.Task_ID)}
                  getVal={getVal}
                  adjustProp={adjustProp}
                  propertyModes={propertyModes}
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
        ) : (
          <TaskTable
            tasks={sortedTasks}
            getVal={getVal}
            adjustProp={adjustProp}
            propertyModes={propertyModes}
            sortColumn={sortColumn}
            sortDirection={sortDirection}
            onSort={handleSortColumn}
            onComplete={handleComplete}
            onDelete={handleDelete}
            onPostpone={openPostpone}
            onSubtaskAdded={handleSubtaskAdded}
            onSubtaskToggled={handleSubtaskToggled}
            onSubtaskDeleted={handleSubtaskDeleted}
          />
        )}

        {tasks.length === 0 && (
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

function formatMinutes(minutes) {
  if (minutes < 60)   return `${minutes}min`;
  if (minutes === 60) return "1h";
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60 > 0 ? (minutes % 60) + "m" : ""}`.trim();
  return `${Math.floor(minutes / 1440)}d`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TaskTable
// ─────────────────────────────────────────────────────────────────────────────

function TaskTable({ tasks, getVal, adjustProp, propertyModes, sortColumn, sortDirection, onSort, onComplete, onDelete, onPostpone, onSubtaskAdded, onSubtaskToggled, onSubtaskDeleted }) {
  const [expandedTask, setExpandedTask] = useState(null);

  const SortIcon = ({ column }) => {
    if (sortColumn !== column) return <span className="ml-1 opacity-30">↕</span>;
    return <span className="ml-1">{sortDirection === "asc" ? "↑" : "↓"}</span>;
  };

  const TableHeader = ({ column, label }) => (
    <th onClick={() => onSort(column)} className="px-4 py-3 text-left text-[10px] font-black tracking-wider uppercase cursor-pointer hover:text-cyan-400 transition-colors"
      style={{ color: sortColumn === column ? "#22d3ee" : "#64748b", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      {label} <SortIcon column={column} />
    </th>
  );

  return (
    <div className="rounded-2xl overflow-x-auto" style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.06)" }}>
      <table className="w-full min-w-[1000px]">
        <thead>
          <tr>
            <th className="w-10 px-4 py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}></th>
            <TableHeader column="Name" label="Task" />
            <TableHeader column="Priority"    label="Prio" />
            <TableHeader column="Urgency"     label="Urg" />
            <TableHeader column="Importance"  label="Imp" />
            <TableHeader column="Relevance"   label="Rel" />
            <TableHeader column="Difficulty"  label="Diff" />
            <TableHeader column="Time_Minutes" label="Time" />
            <TableHeader column="Hierarchy"   label="Hier" />
            <th className="px-4 py-3 w-24" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}></th>
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
              isExpanded={expandedTask === task.Task_ID}
              onToggleExpand={() => setExpandedTask(expandedTask === task.Task_ID ? null : task.Task_ID)}
              onComplete={onComplete}
              onDelete={onDelete}
              onPostpone={onPostpone}
              onSubtaskAdded={onSubtaskAdded}
              onSubtaskToggled={onSubtaskToggled}
              onSubtaskDeleted={onSubtaskDeleted}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  TaskTableRow
// ─────────────────────────────────────────────────────────────────────────────

function TaskTableRow({ task, index, getVal, adjustProp, propertyModes, isExpanded, onToggleExpand, onComplete, onDelete, onPostpone, onSubtaskAdded, onSubtaskToggled, onSubtaskDeleted }) {

  // FIX 2: binary toggle uses -9/+9 deltas to go 1↔10
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
      const isYes = value === 10;
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

  return (
    <>
      {/*
        FIX 1: onClick is NOT on the <tr> anymore.
        Only the rank cell (#) and name cell trigger expand.
        Property cells have e.stopPropagation() so they never bubble up.
      */}
      <tr className="border-t border-white/5 hover:bg-white/[0.03] transition-colors">
        {/* Rank — clickable to expand */}
        <td className="px-4 py-3 text-center text-xs text-gray-600 cursor-pointer select-none" onClick={onToggleExpand}>
          {index + 1}
        </td>
        {/* Name — clickable to expand */}
        <td className="px-4 py-3 cursor-pointer" onClick={onToggleExpand}>
          <div>
            <div className="font-bold text-sm flex items-center gap-2">
              {task.Name}
              <motion.span
                animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: 0.2 }}
                className="text-[10px]" style={{ color: isExpanded ? "#22d3ee" : "#475569" }}>▼</motion.span>
            </div>
            {task.Context && (
              <div className="text-xs text-gray-600 mt-0.5 truncate max-w-xs">{task.Context}</div>
            )}
          </div>
        </td>

        {/* Property cells — all stop propagation internally */}
        <PropertyCell propKey="Priority"    />
        <PropertyCell propKey="Urgency"     />
        <PropertyCell propKey="Importance"  />
        <PropertyCell propKey="Relevance"   />
        <PropertyCell propKey="Difficulty"  />
        <PropertyCell propKey="Time_Minutes" />
        <PropertyCell propKey="Hierarchy"   />

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

      {/* Expanded subtask row */}
      {isExpanded && (
        <tr>
          <td colSpan={10} className="px-4 py-4" style={{ background: "rgba(0,0,0,0.2)", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
            <div className="pl-8">
              <p className="text-[10px] font-black tracking-widest text-gray-600 uppercase mb-3">
                Subtasks {task.Subtasks?.length ? `(${task.Subtasks.filter(s => s.done).length}/${task.Subtasks.length})` : ""}
              </p>
              {task.Subtasks && task.Subtasks.length > 0 && (
                <div className="mb-3 space-y-1.5">
                  {task.Subtasks.map(st => (
                    <div key={st.id} className="flex items-center gap-2 text-sm">
                      <button onClick={() => onSubtaskToggled(task.Task_ID, st.id, !st.done)}
                        className="w-4 h-4 rounded border flex items-center justify-center transition-all"
                        style={{ borderColor: st.done ? "#22d3ee" : "#334155", background: st.done ? "rgba(34,211,238,0.15)" : "transparent" }}>
                        {st.done && <span className="text-[8px] text-cyan-400">✓</span>}
                      </button>
                      <span className={`flex-1 ${st.done ? "line-through text-gray-600" : "text-gray-300"}`}>{st.name}</span>
                      <button onClick={() => onSubtaskDeleted(task.Task_ID, st.id)}
                        className="text-xs text-gray-700 hover:text-red-400 transition-colors">✕</button>
                    </div>
                  ))}
                </div>
              )}
              <SubtaskAddInline taskId={task.Task_ID} onAdded={onSubtaskAdded} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function SubtaskAddInline({ taskId, onAdded }) {
  const [newName, setNewName] = useState("");
  const [adding, setAdding]   = useState(false);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      const st = await apiFetch(`/tasks/${taskId}/subtasks`, {
        method: "POST",
        body: JSON.stringify({ name: newName.trim() }),
      });
      onAdded(taskId, st);
      setNewName("");
    } catch (err) {
      console.error("Failed to add subtask:", err);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input value={newName} onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        placeholder="Add a subtask…"
        className="flex-1 bg-transparent text-sm text-white placeholder-gray-700 outline-none px-2 py-1 rounded"
        style={{ fontFamily: "inherit" }} />
      <button onClick={handleAdd} disabled={!newName.trim() || adding}
        className="text-[10px] font-black tracking-widest px-3 py-1 rounded-lg transition-all disabled:opacity-30"
        style={{ color: "#22d3ee", background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.2)" }}>
        {adding ? "…" : "＋ ADD"}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  TaskCard
// ─────────────────────────────────────────────────────────────────────────────

function TaskCard({ task, rank, isExiting, getVal, adjustProp, propertyModes, onComplete, onDelete, onPostpone, onSubtaskAdded, onSubtaskToggled, onSubtaskDeleted, prefersReduced }) {
  const [expanded, setExpanded] = useState(false);
  const spring = { type: "spring", stiffness: 380, damping: 38 };

  const heat      = Math.round((getVal(task, "Urgency") * getVal(task, "Importance")) / 10);
  const heatColor = heat >= 8 ? "#ef4444" : heat >= 5 ? "#f97316" : heat >= 3 ? "#eab308" : "#22d3ee";
  const subtasks  = task.Subtasks || [];
  const donePct   = subtasks.length ? Math.round((subtasks.filter((s) => s.done).length / subtasks.length) * 100) : null;

  return (
    <motion.div layout={!prefersReduced} layoutId={task.Task_ID}
      initial={{ opacity: 0, x: -20, scale: 0.98 }}
      animate={isExiting ? { opacity: 0, x: 120, scale: 0.92 } : { opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 120, scale: 0.9 }}
      transition={prefersReduced ? { duration: 0 } : { ...spring, layout: spring }}
      className="mb-3 rounded-2xl overflow-hidden"
      style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.05)", borderLeft: `3px solid ${heatColor}` }}>

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
          {donePct !== null && (
            <div className="flex items-center gap-2 mt-1">
              <div className="flex-1 h-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
                <motion.div animate={{ width: `${donePct}%` }} transition={{ type: "spring", stiffness: 300, damping: 28 }}
                  style={{ height: "100%", background: "#22d3ee", borderRadius: 9999 }} />
              </div>
              <span className="text-[9px] text-gray-600">{donePct}%</span>
            </div>
          )}
        </div>
        <div className="flex items-end gap-1 h-7 flex-shrink-0">
          {PREVIEW_PROPS.map((key) => {
            const prop = PROPERTIES.find((p) => p.key === key);
            const val  = getVal(task, key);
            return (
              <motion.div key={key} title={`${key}: ${val}`}
                animate={{ height: `${val * 10}%` }} transition={{ type: "spring", stiffness: 300, damping: 28 }}
                style={{ width: 4, background: prop.bar, borderRadius: 9999, minHeight: 2, alignSelf: "flex-end" }} />
            );
          })}
        </div>
        <span className="text-[10px] font-black px-2 py-0.5 rounded-lg flex-shrink-0"
          style={{ background: `${heatColor}22`, color: heatColor }}>{heat * 10}%</span>
        <button onClick={() => onPostpone(task)} title="Postpone until tomorrow"
          className="flex-shrink-0 text-sm transition-colors" style={{ color: "#334155" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#fb923c")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#334155")}>⏰</button>
        <motion.button onClick={() => setExpanded((v) => !v)}
          animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }}
          className="flex-shrink-0 text-xs transition-colors"
          style={{ color: expanded ? "#22d3ee" : "#475569" }}>▼</motion.button>
        <button onClick={() => onDelete(task.Task_ID)} title="Delete"
          className="flex-shrink-0 text-xs transition-colors ml-1" style={{ color: "#334155" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#f87171")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#334155")}>✕</button>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div key="exp" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: "easeInOut" }}
            className="overflow-hidden" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
            <div className="p-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              {PROPERTIES.map(({ key, label, hex, bar }) => (
                <PropertyControl
                  key={key}
                  label={label}
                  value={getVal(task, key)}
                  hex={hex}
                  bar={bar}
                  propKey={key}
                  mode={propertyModes[key]}
                  onDec={() => adjustProp(task.Task_ID, key, -1)}
                  onInc={() => adjustProp(task.Task_ID, key, 1)}
                  // FIX 2: onSet for direct binary toggling
                  onSet={(v) => adjustProp(task.Task_ID, key, 0, v)}
                />
              ))}
            </div>
            {task.Context && (
              <div className="mx-4 mb-4 px-3 py-2 rounded-lg text-xs text-gray-500"
                style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
                📝 {task.Context}
              </div>
            )}
            <SubtaskSection task={task}
              onAdded={(st)      => onSubtaskAdded(task.Task_ID, st)}
              onToggled={(id, d) => onSubtaskToggled(task.Task_ID, id, d)}
              onDeleted={(id)    => onSubtaskDeleted(task.Task_ID, id)} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SubtaskSection (unchanged)
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

// ─────────────────────────────────────────────────────────────────────────────
//  PropertyControl — FIX 2: binary uses onSet for proper 1↔10 toggling
// ─────────────────────────────────────────────────────────────────────────────

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
        {/* FIX 2: use onSet to jump directly to 1 or 10 */}
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
//  Utility components (unchanged)
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