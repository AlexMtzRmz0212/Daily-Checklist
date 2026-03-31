/**
 * AI Task Sorter — App.jsx
 * ========================
 * Drop this file into src/App.jsx of a Vite + React project.
 * Install deps: npm i framer-motion
 * Tailwind CSS must be configured (npx tailwindcss init -p).
 *
 * Aesthetic: Dark terminal / cyber-ops — monospace, glowing accents,
 *            scanline-grid background, everything measured in intent.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  motion,
  AnimatePresence,
  LayoutGroup,
  useReducedMotion,
} from "framer-motion";

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

const API = "http://localhost:8000";

/** All seven adjustable properties, with their display metadata. */
const PROPERTIES = [
  { key: "Priority",      label: "PRIORITY",   hex: "#f87171", bar: "#ef4444" },
  { key: "Urgency",       label: "URGENCY",    hex: "#fb923c", bar: "#f97316" },
  { key: "Importance",    label: "IMPORTANCE", hex: "#facc15", bar: "#eab308" },
  { key: "Relevance",     label: "RELEVANCE",  hex: "#34d399", bar: "#10b981" },
  { key: "Difficulty",    label: "DIFFICULTY", hex: "#c084fc", bar: "#a855f7" },
  { key: "Time_Estimate", label: "TIME",       hex: "#60a5fa", bar: "#3b82f6" },
  { key: "Hierarchy",     label: "HIERARCHY",  hex: "#f472b6", bar: "#ec4899" },
];

/** Shown as mini bar-chart on collapsed task cards. */
const PREVIEW_PROPS = ["Urgency", "Importance", "Priority"];

// ─────────────────────────────────────────────────────────────────────────────
//  API Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
//  Root App
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  // ── State ──────────────────────────────────────────────────────────────────

  const [tasks, setTasks] = useState([]);
  /** Per-task property deltas not yet saved to backend. { [Task_ID]: { Priority: N, … } } */
  const [localEdits, setLocalEdits] = useState({});
  /** "idle" | "sorting" | "interrupted" */
  const [sortPhase, setSortPhase] = useState("idle");
  const [showInterruptModal, setShowInterruptModal] = useState(false);
  const [preSortSnapshot, setPreSortSnapshot] = useState([]);

  /** Set of Task_IDs currently animating out. */
  const [exitingIds, setExitingIds] = useState(new Set());

  const [form, setForm] = useState({ name: "", context: "", deadline: "" });
  /** "idle" | "loading" | "error" */
  const [addPhase, setAddPhase] = useState("idle");
  const [addError, setAddError] = useState("");
  const [sortError, setSortError] = useState("");

  const abortCtrl = useRef(null);
  const prefersReduced = useReducedMotion();

  // ── Boot: fetch tasks ──────────────────────────────────────────────────────

  useEffect(() => {
    apiFetch("/tasks").then(setTasks).catch(console.error);
  }, []);

  // ── Derived helpers ────────────────────────────────────────────────────────

  /** Read a property value, preferring local edits over persisted value. */
  const getVal = useCallback(
    (task, key) =>
      localEdits[task.Task_ID]?.[key] !== undefined
        ? localEdits[task.Task_ID][key]
        : task[key],
    [localEdits]
  );

  /** Merge local edits into a task for API submission. */
  const merged = useCallback(
    (task) => ({ ...task, ...(localEdits[task.Task_ID] ?? {}) }),
    [localEdits]
  );

  const hasUnsavedEdits = Object.keys(localEdits).length > 0;

  // ── Property adjustment ────────────────────────────────────────────────────

  const adjustProp = useCallback(
    (taskId, key, delta) => {
      setLocalEdits((prev) => {
        const existing = prev[taskId] ?? {};
        const base = tasks.find((t) => t.Task_ID === taskId)?.[key] ?? 5;
        const cur = existing[key] !== undefined ? existing[key] : base;
        return {
          ...prev,
          [taskId]: { ...existing, [key]: Math.min(10, Math.max(1, cur + delta)) },
        };
      });
    },
    [tasks]
  );

  // ── Add task ───────────────────────────────────────────────────────────────

  const handleAdd = async () => {
    if (!form.name.trim()) return;
    setAddPhase("loading");
    setAddError("");
    try {
      const newTask = await apiFetch("/tasks/evaluate", {
        method: "POST",
        body: JSON.stringify({
          Name: form.name.trim(),
          Context: form.context.trim(),
          Deadline: form.deadline || null,
        }),
      });
      setTasks((prev) => [...prev, newTask]);
      setForm({ name: "", context: "", deadline: "" });
      setAddPhase("idle");
    } catch (e) {
      setAddError(e.message);
      setAddPhase("error");
    }
  };

  // ── Sort ───────────────────────────────────────────────────────────────────

  const handleSort = async () => {
    const mergedTasks = tasks.map(merged);
    setPreSortSnapshot([...tasks]);
    setSortPhase("sorting");
    setSortError("");

    abortCtrl.current = new AbortController();
    const { signal } = abortCtrl.current;

    try {
      // 1. Flush all local edits to disk
      await apiFetch("/tasks/bulk-update", {
        method: "POST",
        body: JSON.stringify(mergedTasks),
        signal,
      });

      if (signal.aborted) return;

      // 2. Ask AI for sorted order
      const { sorted_ids } = await apiFetch("/tasks/sort", {
        method: "POST",
        body: JSON.stringify({ tasks: mergedTasks }),
        signal,
      });

      if (signal.aborted) return;

      // 3. Reorder local state — Framer Motion will animate the swap
      const byId = Object.fromEntries(mergedTasks.map((t) => [t.Task_ID, t]));
      setTasks(sorted_ids.map((id) => byId[id]).filter(Boolean));
      setLocalEdits({});
      setSortPhase("idle");
    } catch (e) {
      if (e.name === "AbortError" || signal.aborted) return; // user interrupted
      setSortError(e.message);
      setSortPhase("idle");
    }
  };

  // ── Interrupt ──────────────────────────────────────────────────────────────

  const handleInterrupt = () => {
    abortCtrl.current?.abort();
    setSortPhase("interrupted");
    setShowInterruptModal(true);
  };

  const resolveInterrupt = (keepCurrent) => {
    setShowInterruptModal(false);
    setSortPhase("idle");
    if (!keepCurrent) {
      setTasks(preSortSnapshot);
      setLocalEdits({});
    }
  };

  // ── Complete / delete ──────────────────────────────────────────────────────

  const animateOut = useCallback((taskId, apiCall) => {
    setExitingIds((s) => new Set([...s, taskId]));
    apiCall().catch(console.error);
    setTimeout(() => {
      setTasks((prev) => prev.filter((t) => t.Task_ID !== taskId));
      setExitingIds((s) => { const n = new Set(s); n.delete(taskId); return n; });
    }, 600);
  }, []);

  const handleComplete = useCallback(
    (taskId) =>
      animateOut(taskId, () =>
        apiFetch(`/tasks/${taskId}/complete`, { method: "PATCH" })
      ),
    [animateOut]
  );

  const handleDelete = useCallback(
    (taskId) =>
      animateOut(taskId, () =>
        apiFetch(`/tasks/${taskId}`, { method: "DELETE" })
      ),
    [animateOut]
  );

  // ─────────────────────────────────────────────────────────────────────────
  //  Render
  // ─────────────────────────────────────────────────────────────────────────

  const isSorting = sortPhase === "sorting";

  return (
    <div className="relative min-h-screen bg-gray-950 text-white overflow-hidden"
         style={{ fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace" }}>

      {/* ── Grid background ──────────────────────────────────────────────── */}
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(6,182,212,0.03) 1px, transparent 1px)," +
            "linear-gradient(90deg, rgba(6,182,212,0.03) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      {/* ── Sorting overlay ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {isSorting && (
          <motion.div
            key="sort-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8"
            style={{ background: "rgba(2,6,23,0.82)", backdropFilter: "blur(8px)" }}
          >
            {/* Animated ring */}
            <div className="relative">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                className="w-20 h-20 rounded-full border-2 border-cyan-500/20 border-t-cyan-400"
              />
              <motion.div
                animate={{ rotate: -360 }}
                transition={{ repeat: Infinity, duration: 3, ease: "linear" }}
                className="absolute inset-2 rounded-full border-2 border-purple-500/20 border-b-purple-400"
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-cyan-400 text-xs font-black tracking-widest">AI</span>
              </div>
            </div>

            <div className="text-center">
              <p className="text-cyan-300 text-sm tracking-[0.4em] uppercase font-black mb-1">
                Sorting Tasks
              </p>
              <p className="text-gray-600 text-xs tracking-widest">
                evaluating urgency × importance matrix…
              </p>
            </div>

            {/* Interrupt button */}
            <motion.button
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
              whileHover={{ scale: 1.06 }}
              whileTap={{ scale: 0.92 }}
              onClick={handleInterrupt}
              className="px-8 py-3 rounded-xl font-black text-sm tracking-[0.25em] uppercase border"
              style={{
                background: "rgba(220,38,38,0.15)",
                borderColor: "rgba(220,38,38,0.5)",
                color: "#fca5a5",
                boxShadow: "0 0 20px rgba(220,38,38,0.2)",
              }}
            >
              ⏸ INTERRUPT
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Interrupt modal ───────────────────────────────────────────────── */}
      <AnimatePresence>
        {showInterruptModal && (
          <motion.div
            key="interrupt-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center"
            style={{ background: "rgba(2,6,23,0.9)" }}
          >
            <motion.div
              key="interrupt-card"
              initial={{ scale: 0.85, opacity: 0, y: 24 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.85, opacity: 0, y: 24 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="w-full max-w-sm mx-4 rounded-2xl p-8"
              style={{
                background: "#0f172a",
                border: "1px solid rgba(234,179,8,0.3)",
                boxShadow: "0 0 40px rgba(234,179,8,0.08)",
              }}
            >
              <p className="text-yellow-400 text-xs tracking-[0.3em] uppercase mb-1">
                ⚠ INTERRUPT TRIGGERED
              </p>
              <h2 className="text-white text-lg font-black mb-3">Sorting Halted</h2>
              <p className="text-gray-400 text-sm leading-relaxed mb-7">
                The AI sort was cancelled mid-flight. Choose how to handle the
                current task state:
              </p>

              <div className="flex flex-col gap-3">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => resolveInterrupt(true)}
                  className="w-full py-3 rounded-xl font-black text-sm tracking-widest"
                  style={{
                    background: "rgba(6,182,212,0.15)",
                    border: "1px solid rgba(6,182,212,0.4)",
                    color: "#67e8f9",
                  }}
                >
                  ✓ KEEP CURRENT STATE
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => resolveInterrupt(false)}
                  className="w-full py-3 rounded-xl font-black text-sm tracking-widest"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    color: "#94a3b8",
                  }}
                >
                  ↩ REVERT TO ORIGINAL
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Main layout ───────────────────────────────────────────────────── */}
      <div
        className={`relative max-w-4xl mx-auto px-4 py-10 transition-opacity duration-300 ${
          isSorting ? "pointer-events-none opacity-40" : "opacity-100"
        }`}
      >
        {/* Header */}
        <header className="mb-10 text-center">
          <h1
            className="text-5xl font-black tracking-tight mb-1"
            style={{
              background: "linear-gradient(135deg, #22d3ee 0%, #a78bfa 50%, #f472b6 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            AI TASK SORTER
          </h1>
          <p className="text-gray-600 text-[10px] tracking-[0.5em] uppercase">
            OpenRouter · FastAPI · Framer Motion · tasks.json
          </p>
        </header>

        {/* ── Add task panel ─────────────────────────────────────────────── */}
        <section
          className="mb-6 rounded-2xl p-5"
          style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.06)" }}
        >
          <p className="text-[10px] text-gray-600 uppercase tracking-[0.4em] mb-4">
            ＋ New Task
          </p>

          <div className="flex flex-col gap-3">
            {/* Row 1: name + deadline */}
            <div className="flex gap-3">
              <input
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                placeholder="Task name…"
                disabled={addPhase === "loading"}
                className="flex-1 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-700 outline-none transition-all"
                style={{
                  background: "#1e293b",
                  border: "1px solid rgba(255,255,255,0.07)",
                  fontFamily: "inherit",
                }}
                onFocus={(e) => (e.target.style.borderColor = "rgba(6,182,212,0.5)")}
                onBlur={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.07)")}
              />
              <input
                type="date"
                value={form.deadline}
                onChange={(e) => setForm((p) => ({ ...p, deadline: e.target.value }))}
                disabled={addPhase === "loading"}
                className="rounded-xl px-4 py-2.5 text-sm text-gray-400 outline-none"
                style={{
                  background: "#1e293b",
                  border: "1px solid rgba(255,255,255,0.07)",
                  fontFamily: "inherit",
                }}
              />
            </div>

            {/* Row 2: context + submit */}
            <div className="flex gap-3">
              <input
                value={form.context}
                onChange={(e) => setForm((p) => ({ ...p, context: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                placeholder="Context / description — helps the AI score accurately…"
                disabled={addPhase === "loading"}
                className="flex-1 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-700 outline-none transition-all"
                style={{
                  background: "#1e293b",
                  border: "1px solid rgba(255,255,255,0.07)",
                  fontFamily: "inherit",
                }}
                onFocus={(e) => (e.target.style.borderColor = "rgba(6,182,212,0.5)")}
                onBlur={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.07)")}
              />

              <motion.button
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleAdd}
                disabled={addPhase === "loading" || !form.name.trim()}
                className="px-6 py-2.5 rounded-xl font-black text-sm tracking-widest whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  background: "linear-gradient(135deg, #0891b2, #0e7490)",
                  border: "1px solid rgba(6,182,212,0.3)",
                  fontFamily: "inherit",
                }}
              >
                {addPhase === "loading" ? (
                  <span className="flex items-center gap-2">
                    <Spinner /> SCORING…
                  </span>
                ) : (
                  "＋ ADD"
                )}
              </motion.button>
            </div>

            {addPhase === "error" && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-red-400 text-xs"
              >
                ⚠ {addError}
              </motion.p>
            )}
          </div>
        </section>

        {/* ── Sort controls ──────────────────────────────────────────────── */}
        {tasks.length > 1 && (
          <div className="flex items-center justify-between mb-4">
            <p className="text-[10px] text-gray-600 uppercase tracking-widest">
              {tasks.length} active
              {hasUnsavedEdits ? " · ● unsaved edits" : ""}
            </p>

            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.94 }}
              onClick={handleSort}
              className="px-8 py-2.5 rounded-xl font-black text-sm tracking-[0.2em] uppercase"
              style={{
                background: "linear-gradient(135deg, #7c3aed, #0891b2)",
                border: "1px solid rgba(124,58,237,0.4)",
                boxShadow: "0 0 24px rgba(124,58,237,0.25)",
                fontFamily: "inherit",
              }}
            >
              ⚡ SUBMIT &amp; SORT
            </motion.button>
          </div>
        )}

        {sortError && (
          <p className="text-red-400 text-xs mb-3">⚠ Sort failed: {sortError}</p>
        )}

        {/* ── Task list ──────────────────────────────────────────────────── */}
        <LayoutGroup>
          <AnimatePresence mode="popLayout">
            {tasks.map((task, index) => (
              <TaskCard
                key={task.Task_ID}
                task={task}
                rank={index + 1}
                isExiting={exitingIds.has(task.Task_ID)}
                getVal={getVal}
                adjustProp={adjustProp}
                onComplete={handleComplete}
                onDelete={handleDelete}
                prefersReduced={prefersReduced}
              />
            ))}
          </AnimatePresence>
        </LayoutGroup>

        {/* Empty state */}
        {tasks.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center py-24"
          >
            <p className="text-6xl mb-5">📋</p>
            <p className="text-gray-500 font-black tracking-widest text-sm uppercase">
              No active tasks
            </p>
            <p className="text-gray-700 text-xs mt-2">
              Add a task above — the AI will evaluate and score it automatically.
            </p>
          </motion.div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  TaskCard
// ─────────────────────────────────────────────────────────────────────────────

function TaskCard({ task, rank, isExiting, getVal, adjustProp, onComplete, onDelete, prefersReduced }) {
  const [expanded, setExpanded] = useState(false);
  const spring = { type: "spring", stiffness: 380, damping: 38 };

  // Compute an urgency×importance "heat" score for the left accent bar
  const heat = Math.round((getVal(task, "Urgency") * getVal(task, "Importance")) / 10);
  const heatColor =
    heat >= 8 ? "#ef4444" : heat >= 5 ? "#f97316" : heat >= 3 ? "#eab308" : "#22d3ee";

  return (
    <motion.div
      layout={!prefersReduced}
      layoutId={task.Task_ID}
      initial={{ opacity: 0, x: -20, scale: 0.98 }}
      animate={
        isExiting
          ? { opacity: 0, x: 120, scale: 0.92 }
          : { opacity: 1, x: 0, scale: 1 }
      }
      exit={{ opacity: 0, x: 120, scale: 0.9 }}
      transition={prefersReduced ? { duration: 0 } : { ...spring, layout: spring }}
      className="mb-3 rounded-2xl overflow-hidden"
      style={{
        background: "#0f172a",
        border: "1px solid rgba(255,255,255,0.05)",
        borderLeft: `3px solid ${heatColor}`,
      }}
    >
      {/* ── Collapsed row ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-3.5">
        {/* Rank badge */}
        <span
          className="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-lg text-xs font-black"
          style={{ background: "rgba(255,255,255,0.04)", color: "#64748b" }}
        >
          {rank}
        </span>

        {/* Completion checkbox */}
        <motion.button
          whileTap={{ scale: 0.7 }}
          onClick={() => onComplete(task.Task_ID)}
          title="Mark complete"
          className="w-5 h-5 flex-shrink-0 rounded-full border-2 transition-colors"
          style={{ borderColor: "#334155" }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#4ade80")}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#334155")}
        />

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <p className="text-white text-sm font-bold leading-snug truncate">{task.Name}</p>
          {task.Context && (
            <p className="text-gray-600 text-xs mt-0.5 truncate">{task.Context}</p>
          )}
          {task.Deadline && (
            <p className="text-yellow-600 text-[10px] mt-0.5">📅 {task.Deadline}</p>
          )}
        </div>

        {/* Mini heat bar cluster */}
        <div className="flex items-end gap-1 h-7 flex-shrink-0">
          {PREVIEW_PROPS.map((key) => {
            const prop = PROPERTIES.find((p) => p.key === key);
            const val = getVal(task, key);
            return (
              <motion.div
                key={key}
                title={`${key}: ${val}`}
                animate={{ height: `${val * 10}%` }}
                transition={{ type: "spring", stiffness: 300, damping: 28 }}
                style={{
                  width: 4,
                  background: prop.bar,
                  borderRadius: 9999,
                  minHeight: 2,
                  alignSelf: "flex-end",
                }}
              />
            );
          })}
        </div>

        {/* Heat score chip */}
        <span
          className="text-[10px] font-black px-2 py-0.5 rounded-lg flex-shrink-0"
          style={{ background: `${heatColor}22`, color: heatColor }}
        >
          {heat * 10}%
        </span>

        {/* Expand toggle */}
        <motion.button
          onClick={() => setExpanded((v) => !v)}
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="flex-shrink-0 text-xs transition-colors"
          style={{ color: expanded ? "#22d3ee" : "#475569" }}
        >
          ▼
        </motion.button>

        {/* Delete */}
        <button
          onClick={() => onDelete(task.Task_ID)}
          title="Delete task"
          className="flex-shrink-0 text-xs transition-colors ml-1"
          style={{ color: "#334155" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#f87171")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#334155")}
        >
          ✕
        </button>
      </div>

      {/* ── Expanded properties grid ────────────────────────────────────── */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            key="props"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
            className="overflow-hidden"
            style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
          >
            <div className="p-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              {PROPERTIES.map(({ key, label, hex, bar }) => (
                <PropertyControl
                  key={key}
                  label={label}
                  value={getVal(task, key)}
                  hex={hex}
                  bar={bar}
                  onDec={() => adjustProp(task.Task_ID, key, -1)}
                  onInc={() => adjustProp(task.Task_ID, key, 1)}
                />
              ))}
            </div>

            {/* Context / deadline detail */}
            {(task.Context || task.Deadline) && (
              <div
                className="mx-4 mb-4 px-3 py-2 rounded-lg text-xs text-gray-500"
                style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}
              >
                {task.Context && <p className="mb-0.5">📝 {task.Context}</p>}
                {task.Deadline && <p>📅 Due: {task.Deadline}</p>}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  PropertyControl
// ─────────────────────────────────────────────────────────────────────────────

function PropertyControl({ label, value, hex, bar, onDec, onInc }) {
  return (
    <div
      className="rounded-xl p-2.5 flex flex-col gap-2"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* Label */}
      <p className="text-[9px] font-black tracking-widest" style={{ color: hex }}>
        {label}
      </p>

      {/* − value + */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={onDec}
          disabled={value <= 1}
          className="w-6 h-6 flex items-center justify-center rounded-lg text-xs font-black transition-colors disabled:opacity-25"
          style={{ background: "rgba(255,255,255,0.06)", color: "#94a3b8" }}
          onMouseEnter={(e) => !e.currentTarget.disabled && (e.currentTarget.style.background = "rgba(255,255,255,0.1)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
        >
          −
        </button>
        <span className="flex-1 text-center font-black text-sm text-white">{value}</span>
        <button
          onClick={onInc}
          disabled={value >= 10}
          className="w-6 h-6 flex items-center justify-center rounded-lg text-xs font-black transition-colors disabled:opacity-25"
          style={{ background: "rgba(255,255,255,0.06)", color: "#94a3b8" }}
          onMouseEnter={(e) => !e.currentTarget.disabled && (e.currentTarget.style.background = "rgba(255,255,255,0.1)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
        >
          ＋
        </button>
      </div>

      {/* Animated progress bar */}
      <div className="h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
        <motion.div
          animate={{ width: `${value * 10}%` }}
          transition={{ type: "spring", stiffness: 300, damping: 28 }}
          style={{ height: "100%", background: bar, borderRadius: 9999 }}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Spinner
// ─────────────────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span
      className="inline-block w-3 h-3 rounded-full border-2 animate-spin"
      style={{ borderColor: "rgba(255,255,255,0.3)", borderTopColor: "#fff" }}
    />
  );
}
