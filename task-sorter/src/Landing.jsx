// task-sorter/src/Landing.jsx
//
// The public front door. Everything a visitor can learn about the app without an
// account lives here: what it does (hero), how it works (three steps), what was
// actually built (screenshot tour + capability grid + stack), and the login itself.
// Rendered by App whenever there is no valid token.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { fetchApi } from "./utils/api";
import { API } from "./apiBase";

const MONO = "'JetBrains Mono','Fira Code','Cascadia Code',monospace";
const SANS = "'Inter','Segoe UI',system-ui,-apple-system,sans-serif";

const REPO = "https://github.com/AlexMtzRmz0212/Daily-Checklist";

// ─────────────────────────────────────────────────────────────────────────────
//region Shared bits
// ─────────────────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span className="inline-block w-3 h-3 rounded-full border-2 animate-spin align-[-1px]"
      style={{ borderColor: "rgba(255,255,255,0.3)", borderTopColor: "#fff" }} />
  );
}

/** Section heading: a small kicker over a short title. Keeps prose out of the page. */
function SectionHead({ kicker, title, children }) {
  return (
    <div className="mb-8 md:mb-12">
      <p className="text-[10px] md:text-[11px] font-bold tracking-[0.3em] uppercase text-cyan-400/70 mb-2">
        {kicker}
      </p>
      <h2 className="text-2xl md:text-4xl font-black tracking-tight text-white leading-[1.1]">
        {title}
      </h2>
      {children && (
        <p className="mt-3 text-sm md:text-base text-slate-400 max-w-2xl" style={{ fontFamily: SANS }}>
          {children}
        </p>
      )}
    </div>
  );
}

function PrimaryButton({ children, onClick, className = "", ...rest }) {
  return (
    <motion.button
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className={`px-6 py-3 rounded-xl font-black text-xs md:text-sm tracking-[0.18em] uppercase text-white ${className}`}
      style={{
        background: "linear-gradient(135deg,#0891b2,#0e7490)",
        border: "1px solid rgba(34,211,238,0.45)",
        boxShadow: "0 8px 30px rgba(8,145,178,0.30)",
        fontFamily: MONO,
      }}
      {...rest}>
      {children}
    </motion.button>
  );
}

function GhostButton({ children, className = "", ...rest }) {
  return (
    <motion.a
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      className={`inline-block px-6 py-3 rounded-xl font-black text-xs md:text-sm tracking-[0.18em] uppercase text-slate-300 hover:text-white transition-colors ${className}`}
      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.10)", fontFamily: MONO }}
      {...rest}>
      {children}
    </motion.a>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//region Hero animation — the product's one-sentence promise, shown instead of told
// ─────────────────────────────────────────────────────────────────────────────

// Two orderings of the same five tasks: as typed, and as the sorter leaves them.
// Framer's `layout` prop does the rest — the cards physically travel between states,
// which is exactly what the real Sort button does.
const DEMO_TASKS = [
  { id: "a", name: "Reply to the design thread", u: 4, i: 3, t: "10m", tone: "#38bdf8" },
  { id: "b", name: "Fix billing webhook retries", u: 10, i: 9, t: "1h 30m", tone: "#f87171" },
  { id: "c", name: "Read the systems book", u: 1, i: 4, t: "7h", tone: "#818cf8" },
  { id: "d", name: "Ship onboarding redesign", u: 9, i: 10, t: "3h", tone: "#fb923c" },
  { id: "e", name: "Book the dentist", u: 7, i: 5, t: "10m", tone: "#34d399" },
];

const TYPED_ORDER = ["a", "b", "c", "d", "e"];
const SORTED_ORDER = ["b", "d", "e", "a", "c"];

function HeroSort() {
  const reduced = useReducedMotion();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (reduced) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 3400);
    return () => clearInterval(id);
  }, [reduced]);

  // Reduced motion gets the answer straight away instead of the back-and-forth.
  const sorted = reduced ? true : tick % 2 === 1;
  const byId = useMemo(() => Object.fromEntries(DEMO_TASKS.map((t) => [t.id, t])), []);
  const order = sorted ? SORTED_ORDER : TYPED_ORDER;

  return (
    <div
      className="w-full rounded-2xl p-4 md:p-5"
      style={{ background: "#0b1220", border: "1px solid rgba(255,255,255,0.07)", boxShadow: "0 24px 70px rgba(0,0,0,0.5)" }}
      aria-hidden="true">
      <div className="flex items-center justify-between mb-4 px-1">
        <span className="text-[9px] md:text-[10px] font-black tracking-[0.25em] uppercase text-slate-500">
          {sorted ? "Sorted" : "As typed"}
        </span>
        <motion.span
          key={String(sorted)}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-[9px] md:text-[10px] font-black tracking-[0.25em] uppercase"
          style={{ color: sorted ? "#22d3ee" : "#475569" }}>
          {sorted ? "⚡ urgency × importance" : "5 tasks"}
        </motion.span>
      </div>

      <div className="flex flex-col gap-2">
        {order.map((id, index) => {
          const task = byId[id];
          return (
            <motion.div
              key={id}
              layout
              transition={{ type: "spring", stiffness: 320, damping: 34 }}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5"
              style={{
                background: "#111c31",
                border: `1px solid ${sorted && index < 2 ? "rgba(34,211,238,0.35)" : "rgba(255,255,255,0.05)"}`,
              }}>
              <span
                className="w-5 shrink-0 text-center text-[10px] font-black tabular-nums"
                style={{ color: sorted && index < 2 ? "#22d3ee" : "#475569" }}>
                {index + 1}
              </span>
              <span className="flex-1 min-w-0 truncate text-[11px] md:text-xs text-slate-200">
                {task.name}
              </span>
              <span className="hidden sm:flex items-center gap-1" title="urgency and importance">
                <ScoreBar value={task.u} tone={task.tone} />
                <ScoreBar value={task.i} tone={task.tone} />
              </span>
              <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-slate-500">
                {task.t}
              </span>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function ScoreBar({ value, tone }) {
  return (
    <span className="block w-10 h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.07)" }}>
      <motion.span
        className="block h-full rounded-full"
        style={{ background: tone }}
        initial={false}
        animate={{ width: `${value * 10}%` }}
        transition={{ duration: 0.5 }}
      />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//region Screenshot tour
// ─────────────────────────────────────────────────────────────────────────────

const VIEWS = [
  {
    id: "stats", label: "📈 Stats", accent: "#f472b6",
    title: "The queue at a glance",
    blurb: "Totals, averages and the priority mix, recomputed as you edit.",
    src: "/shots/stats.webp", w: 1760, h: 923,
    alt: "Stats view: cards showing 15 active tasks, 34 hours of estimated work, average scores per property, and a priority mix donut chart.",
  },
  {
    id: "table", label: "📊 Table", accent: "#22d3ee",
    title: "Every score, editable in place",
    blurb: "Eight properties per task. Toggle each one between yes/no and 1–10.",
    src: "/shots/table.webp", w: 1760, h: 946,
    alt: "Table view: ten task rows with focus, urgency, importance, relevance, difficulty and time columns, some as yes/no chips and some as numeric steppers.",
  },
  {
    id: "tree", label: "🌲 Tree", accent: "#34d399",
    title: "Categories, tasks, subtasks",
    blurb: "The whole hierarchy as text you can fold, select and paste anywhere.",
    src: "/shots/tree.webp", w: 1760, h: 1002,
    alt: "Tree view: an indented text outline of four categories with their tasks and checkbox subtasks.",
  },
  {
    id: "matrix", label: "🎯 Matrix", accent: "#fbbf24",
    title: "Drag a card, the scores follow",
    blurb: "Priority down the side, hierarchy across the top. Dropping a card saves it.",
    src: "/shots/matrix.webp", w: 1760, h: 846,
    alt: "Matrix view: a grid with priority rows and hierarchy columns, tasks placed as draggable cards colour-coded by priority.",
  },
  {
    id: "aiplan", label: "🤖 AI Plan", accent: "#c084fc",
    title: "Pick a few, get a plan",
    blurb: "Choose how many tasks to take on. The model groups them into phases.",
    src: "/shots/aiplan.webp", w: 1760, h: 660,
    alt: "AI Plan view: a generated two-phase action plan with durations and a one-line reason for each chosen task.",
  },
  {
    id: "archive", label: "🗄️ Archive", accent: "#cbd5e1",
    title: "Done and dropped, kept apart",
    blurb: "Completed and forgotten tasks leave the queue but stay restorable.",
    src: "/shots/archive.webp", w: 1760, h: 595,
    alt: "Archive view: completed tasks grouped under Done and abandoned ones under Forgotten, each with restore and delete buttons.",
  },
];

function ScreenshotTour() {
  const [active, setActive] = useState("stats");
  const tabRefs = useRef({});
  const current = VIEWS.find((v) => v.id === active) ?? VIEWS[0];

  // Roving focus, so the tab strip behaves like a real tablist for keyboard users.
  const onKeyDown = useCallback((event) => {
    const index = VIEWS.findIndex((v) => v.id === active);
    let next = null;
    if (event.key === "ArrowRight") next = VIEWS[(index + 1) % VIEWS.length];
    if (event.key === "ArrowLeft") next = VIEWS[(index - 1 + VIEWS.length) % VIEWS.length];
    if (event.key === "Home") next = VIEWS[0];
    if (event.key === "End") next = VIEWS[VIEWS.length - 1];
    if (!next) return;
    event.preventDefault();
    setActive(next.id);
    tabRefs.current[next.id]?.focus();
  }, [active]);

  return (
    <div>
      <div
        role="tablist"
        aria-label="Application views"
        onKeyDown={onKeyDown}
        className="flex gap-1 p-1 rounded-xl overflow-x-auto mb-5"
        style={{ background: "#1e293b" }}>
        {VIEWS.map((view) => {
          const selected = view.id === active;
          return (
            <button
              key={view.id}
              ref={(el) => { tabRefs.current[view.id] = el; }}
              role="tab"
              id={`tour-tab-${view.id}`}
              aria-selected={selected}
              aria-controls={`tour-panel-${view.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(view.id)}
              className="px-3 md:px-4 py-2 rounded-lg text-[10px] md:text-[11px] font-black tracking-wider uppercase whitespace-nowrap transition-colors"
              style={{
                background: selected ? `${view.accent}26` : "transparent",
                color: selected ? view.accent : "#94a3b8",
                fontFamily: MONO,
              }}>
              {view.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`tour-panel-${current.id}`}
        aria-labelledby={`tour-tab-${current.id}`}
        tabIndex={0}
        className="rounded-2xl overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60"
        style={{ border: "1px solid rgba(255,255,255,0.08)", background: "#0b1220" }}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 md:px-6 py-4"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <h3 className="text-sm md:text-base font-black text-white">{current.title}</h3>
          <p className="text-xs md:text-sm text-slate-400" style={{ fontFamily: SANS }}>{current.blurb}</p>
        </div>
        {/* These are 1600px-wide app screens. Below roughly 900px they stop being
            readable, so the panel pans sideways instead of shrinking them further. */}
        <div className="overflow-x-auto">
          <AnimatePresence mode="wait">
            <motion.img
              key={current.id}
              src={current.src}
              alt={current.alt}
              loading="lazy"
              decoding="async"
              width={current.w}
              height={current.h}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="block w-full min-w-[900px] h-auto"
            />
          </AnimatePresence>
        </div>
      </div>
      <PanHint />
    </div>
  );
}

/** Only worth saying on the narrow screens where the panels actually pan. */
function PanHint() {
  return (
    <p className="lg:hidden mt-3 text-[10px] tracking-[0.2em] uppercase text-slate-500">
      ← swipe the panel to pan →
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//region Static content
// ─────────────────────────────────────────────────────────────────────────────

const STEPS = [
  { n: "01", icon: "＋", tone: "#22d3ee", title: "Add", body: "Type one. Or paste twenty lines at once." },
  { n: "02", icon: "◈", tone: "#c084fc", title: "Score", body: "Urgency, importance, effort and five more." },
  { n: "03", icon: "⚡", tone: "#fbbf24", title: "Sort", body: "The cards animate into their new order." },
];

const CAPABILITIES = [
  { icon: "⇄", title: "Two-way Notion sync", body: "Import a database, push status and structure back." },
  { icon: "≡", title: "Bulk paste import", body: "One task per line, a pipe for context." },
  { icon: "☑", title: "Subtasks", body: "Nested checklists, AI-suggested or hand written." },
  { icon: "⏰", title: "Postpone", body: "Push to tomorrow with a reason that comes back with it." },
  { icon: "✕", title: "Interruptible sort", body: "Abort mid-run, then keep or revert the result." },
  { icon: "🔑", title: "Your own model key", body: "Encrypted at rest, per user, swappable any time." },
  { icon: "⇱", title: "Drag to re-parent", body: "Move a node in the graph, the hierarchy follows." },
  { icon: "🛡", title: "Isolated accounts", body: "JWT sessions; every query scoped to one owner." },
];

const STACK = [
  { label: "Frontend", tone: "#22d3ee", items: ["React 19", "Framer Motion", "React Flow", "Tailwind"] },
  { label: "Backend", tone: "#c084fc", items: ["FastAPI", "SQLAlchemy", "JWT + bcrypt", "Fernet"] },
  { label: "Data & AI", tone: "#34d399", items: ["Neon Postgres", "OpenRouter", "Notion API", "Vercel"] },
];

// ─────────────────────────────────────────────────────────────────────────────
//region Auth
// ─────────────────────────────────────────────────────────────────────────────

function AuthPanel({ onClose, idPrefix = "auth" }) {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState(null);   // { kind: "error" | "ok", text }
  const [loading, setLoading] = useState(false);
  const firstField = useRef(null);

  useEffect(() => { firstField.current?.focus(); }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setNotice(null);
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
            body: formData,
          });
        } catch {
          throw new Error("Invalid credentials");
        }
        localStorage.setItem("token", data.access_token);
        window.location.reload();
      } else {
        try {
          await fetchApi(`${API}/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
          });
        } catch (err) {
          let msg = "Registration failed";
          const match = err.message.match(/API Error \(\d+\): (.*)/);
          if (match) {
            try {
              const parsed = JSON.parse(match[1]);
              if (parsed.detail) msg = parsed.detail;
            } catch { /* keep the generic message */ }
          }
          throw new Error(msg);
        }
        setIsLogin(true);
        setNotice({ kind: "ok", text: "Account created. Log in to continue." });
      }
    } catch (err) {
      setNotice({ kind: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const field = "w-full rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/50 transition-all";
  const fieldStyle = { background: "#020817", border: "1px solid rgba(255,255,255,0.10)", fontFamily: MONO };

  return (
    <div className="w-full">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 id={`${idPrefix}-title`} className="text-xl font-black text-white">
            {isLogin ? "Welcome back" : "Create an account"}
          </h2>
          <p className="text-xs text-slate-400 mt-1" style={{ fontFamily: SANS }}>
            {isLogin ? "Your tasks are scoped to your account." : "You can add your own model key later."}
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sign in"
            className="text-slate-500 hover:text-white transition-colors text-lg leading-none px-2 -mt-1">
            ✕
          </button>
        )}
      </div>

      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className="mb-4 p-3 rounded-lg text-xs"
          style={notice.kind === "error"
            ? { background: "rgba(127,29,29,0.3)", border: "1px solid rgba(153,27,27,0.6)", color: "#fecaca" }
            : { background: "rgba(6,78,59,0.3)", border: "1px solid rgba(6,95,70,0.6)", color: "#a7f3d0" }}>
          {notice.text}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor={`${idPrefix}-username`} className="block text-[10px] font-bold text-slate-400 mb-1.5 tracking-[0.2em] uppercase">
            Username
          </label>
          <input
            ref={firstField}
            id={`${idPrefix}-username`} name="username" autoComplete="username" type="text"
            value={username} onChange={(e) => setUsername(e.target.value)} required
            className={field} style={fieldStyle} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-password`} className="block text-[10px] font-bold text-slate-400 mb-1.5 tracking-[0.2em] uppercase">
            Password
          </label>
          <input
            id={`${idPrefix}-password`} name="password" type="password"
            autoComplete={isLogin ? "current-password" : "new-password"}
            value={password} onChange={(e) => setPassword(e.target.value)} required
            className={field} style={fieldStyle} />
        </div>
        <PrimaryButton type="submit" disabled={loading} className="w-full disabled:opacity-50">
          {loading ? <Spinner /> : (isLogin ? "Log in" : "Register")}
        </PrimaryButton>
      </form>

      <p className="mt-5 text-center text-xs text-slate-400" style={{ fontFamily: SANS }}>
        {isLogin ? "No account yet? " : "Already registered? "}
        <button
          type="button"
          onClick={() => { setIsLogin(!isLogin); setNotice(null); }}
          className="text-cyan-400 hover:text-cyan-300 font-semibold transition-colors underline underline-offset-2">
          {isLogin ? "Create one" : "Log in"}
        </button>
      </p>
    </div>
  );
}

function AuthDialog({ open, onClose }) {
  const panelRef = useRef(null);
  const restoreTo = useRef(null);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      restoreTo.current?.focus?.();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="auth-backdrop"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 overflow-y-auto"
          style={{ background: "rgba(2,6,23,0.88)", backdropFilter: "blur(3px)" }}>
          <motion.div
            ref={panelRef}
            role="dialog" aria-modal="true" aria-labelledby="dialog-auth-title"
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-2xl p-7 my-auto relative overflow-hidden"
            style={{ background: "#0b1220", border: "1px solid rgba(255,255,255,0.10)", boxShadow: "0 30px 90px rgba(0,0,0,0.7)" }}>
            <div className="absolute top-0 left-1/4 right-1/4 h-px"
              style={{ background: "linear-gradient(90deg,transparent,#06b6d4,transparent)" }} />
            <AuthPanel onClose={onClose} idPrefix="dialog-auth" />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//region Page
// ─────────────────────────────────────────────────────────────────────────────

export default function Landing() {
  const [authOpen, setAuthOpen] = useState(false);
  const openAuth = useCallback(() => setAuthOpen(true), []);
  const closeAuth = useCallback(() => setAuthOpen(false), []);

  return (
    <div className="relative min-h-screen bg-gray-950 text-white overflow-x-hidden" style={{ fontFamily: MONO }}>
      {/* Same grid backdrop the app uses, so the two pages read as one product. */}
      <div className="pointer-events-none fixed inset-0" style={{
        backgroundImage:
          "linear-gradient(rgba(6,182,212,0.03) 1px,transparent 1px)," +
          "linear-gradient(90deg,rgba(6,182,212,0.03) 1px,transparent 1px)",
        backgroundSize: "40px 40px",
      }} />
      <div className="pointer-events-none fixed inset-0" style={{
        background: "radial-gradient(900px 480px at 18% -8%, rgba(8,145,178,0.16), transparent 70%)",
      }} />

      <a href="#tour"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-[90] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-cyan-600 focus:text-white text-xs">
        Skip to the tour
      </a>

      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <header className="relative z-30 sticky top-0"
        style={{ background: "rgba(3,7,18,0.82)", backdropFilter: "blur(10px)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="max-w-6xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-black tracking-tight leading-none" style={{ color: "#22d3ee" }}>
              AI TASK SORTER
            </p>
            <a href="https://bittobyte.qzz.io" target="_blank" rel="noopener noreferrer"
              className="text-[9px] font-semibold tracking-[0.2em] uppercase text-slate-500 hover:text-cyan-400 transition-colors">
              By BitToByte
            </a>
          </div>
          <div className="flex items-center gap-2 md:gap-3">
            <a href={REPO} target="_blank" rel="noopener noreferrer"
              className="hidden sm:inline text-[10px] font-black tracking-[0.18em] uppercase text-slate-400 hover:text-white transition-colors px-2">
              Source
            </a>
            <motion.button
              whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
              onClick={openAuth}
              className="px-4 md:px-5 py-2 rounded-lg text-[10px] md:text-[11px] font-black tracking-[0.18em] uppercase text-white"
              style={{ background: "linear-gradient(135deg,#0891b2,#0e7490)", border: "1px solid rgba(34,211,238,0.4)" }}>
              Sign in
            </motion.button>
          </div>
        </div>
      </header>

      <main className="relative z-10">
        {/* ── Hero ──────────────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-4 md:px-6 pt-14 pb-16 md:pt-24 md:pb-24">
          <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center">
            <div>
              <h1 className="text-4xl sm:text-5xl md:text-6xl font-black tracking-tight leading-[1.02]">
                Your list,
                <br />
                <span style={{ color: "#22d3ee" }}>in the right order.</span>
              </h1>
              <p className="mt-5 text-base md:text-lg text-slate-300 max-w-md leading-relaxed" style={{ fontFamily: SANS }}>
                Type a task. It gets scored on eight properties, then the list
                re-orders itself around what actually matters today.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <PrimaryButton onClick={openAuth}>Sign in</PrimaryButton>
                <GhostButton href="#tour">See it working</GhostButton>
              </div>
            </div>
            <HeroSort />
          </div>
        </section>

        {/* ── Three steps ───────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-4 md:px-6 pb-16 md:pb-24">
          <div className="grid sm:grid-cols-3 gap-4">
            {STEPS.map((step) => (
              <div key={step.n} className="rounded-2xl p-6"
                style={{ background: "#0b1220", border: "1px solid rgba(255,255,255,0.07)" }}>
                <div className="flex items-center justify-between mb-4">
                  <span className="grid place-items-center w-10 h-10 rounded-xl text-lg"
                    style={{ background: `${step.tone}1f`, border: `1px solid ${step.tone}55`, color: step.tone }}
                    aria-hidden="true">
                    {step.icon}
                  </span>
                  <span className="text-[10px] font-black tracking-[0.25em] text-slate-700">{step.n}</span>
                </div>
                <h3 className="text-base font-black text-white mb-1.5">{step.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed" style={{ fontFamily: SANS }}>{step.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Screenshot tour ───────────────────────────────────────────── */}
        <section id="tour" className="max-w-6xl mx-auto px-4 md:px-6 pb-16 md:pb-24 scroll-mt-16">
          <SectionHead kicker="The app" title="Six ways to read one list">
            Real screens, real data. Pick a tab.
          </SectionHead>
          <ScreenshotTour />
        </section>

        {/* ── Flow strip ────────────────────────────────────────────────── */}
        {/* Wider than the rest on purpose: the node labels stop being legible below
            roughly 1100px, and this is the one image that has to be read up close. */}
        <section className="max-w-[84rem] mx-auto px-4 md:px-6 pb-16 md:pb-24">
          <SectionHead kicker="Structure" title="Or as a graph you can rearrange">
            Drag a node onto another to re-parent it. Linked tasks push the change to Notion.
          </SectionHead>
          <div className="rounded-2xl overflow-x-auto"
            style={{ background: "#0b1220", border: "1px solid rgba(255,255,255,0.08)" }}>
            <img
              src="/shots/flow.webp"
              alt="Flow view: two category branches drawn as a top-down node graph, each fanning out into its tasks and subtasks."
              loading="lazy" decoding="async" width={1754} height={506}
              className="block w-full min-w-[900px] h-auto"
            />
          </div>
          <PanHint />
        </section>

        {/* ── Capabilities ──────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-4 md:px-6 pb-16 md:pb-24">
          <SectionHead kicker="Built in" title="What else is in there" />
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {CAPABILITIES.map((cap) => (
              <div key={cap.title} className="rounded-xl p-5"
                style={{ background: "#0b1220", border: "1px solid rgba(255,255,255,0.06)" }}>
                <span className="block text-lg mb-3 text-cyan-400/90" aria-hidden="true">{cap.icon}</span>
                <h3 className="text-[13px] font-black text-white mb-1.5">{cap.title}</h3>
                <p className="text-xs text-slate-400 leading-relaxed" style={{ fontFamily: SANS }}>{cap.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Adding tasks ──────────────────────────────────────────────── */}
        {/* Full width on purpose: the panel this shows sits in the middle of a
            1600px screen, so a half-width column would crop it out of frame. */}
        <section className="max-w-6xl mx-auto px-4 md:px-6 pb-16 md:pb-24">
          <figure className="rounded-2xl overflow-hidden m-0"
            style={{ background: "#0b1220", border: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="overflow-x-auto">
              <img src="/shots/add.webp" loading="lazy" decoding="async" width={1760} height={541}
                alt="The add-task panel pulled down over the task table, with fields for a task name and its context."
                className="block w-full min-w-[900px] h-auto" />
            </div>
            <figcaption className="px-5 md:px-6 py-4 text-xs md:text-sm text-slate-400" style={{ fontFamily: SANS }}>
              <span className="text-white font-semibold">Adding stays out of the way.</span>{" "}
              The input hangs off the top edge like a bookmark until you pull it down.
            </figcaption>
          </figure>
          <PanHint />
        </section>

        {/* ── Configuration ─────────────────────────────────────────────── */}
        {/* The settings panel is only ~490 CSS px wide in the app, so it is shown at
            its own size next to the copy rather than stretched to fill a column. */}
        <section className="max-w-6xl mx-auto px-4 md:px-6 pb-16 md:pb-24">
          <div className="grid lg:grid-cols-2 gap-8 lg:gap-14 items-center">
            <div className="order-2 lg:order-1">
              <SectionHead kicker="Configuration" title="You own the config">
                Nothing is hard-coded to one account or one model.
              </SectionHead>
              <ul className="space-y-3">
                {[
                  ["Any OpenRouter model", "Paste a model id; swap it whenever you like."],
                  ["Your key, encrypted", "Stored per user with Fernet, never sent to the browser again."],
                  ["Scoring modes per property", "Yes/no or 1 to 10, in the column order you choose."],
                  ["Your Notion database", "Point it at a database id and sync both ways."],
                ].map(([title, body]) => (
                  <li key={title} className="flex gap-3">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#22d3ee" }} aria-hidden="true" />
                    <span>
                      <span className="block text-[13px] font-black text-white">{title}</span>
                      <span className="block text-xs text-slate-400 leading-relaxed" style={{ fontFamily: SANS }}>{body}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="order-1 lg:order-2 rounded-2xl p-5 md:p-6"
              style={{ background: "#0b1220", border: "1px solid rgba(255,255,255,0.08)" }}>
              <img src="/shots/settings.webp" loading="lazy" decoding="async" width={976} height={1880}
                alt="The configuration panel: OpenRouter model field, encrypted personal API key, per-property scoring modes, and Notion sync credentials."
                className="block w-full max-w-[488px] mx-auto h-auto rounded-xl" />
            </div>
          </div>
        </section>

        {/* ── Stack ─────────────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-4 md:px-6 pb-16 md:pb-24">
          <SectionHead kicker="Under it" title="How it is put together" />
          <div className="grid sm:grid-cols-3 gap-3">
            {STACK.map((column) => (
              <div key={column.label} className="rounded-2xl p-5"
                style={{ background: "#0b1220", border: "1px solid rgba(255,255,255,0.07)" }}>
                <p className="text-[10px] font-black tracking-[0.25em] uppercase mb-4" style={{ color: column.tone }}>
                  {column.label}
                </p>
                <ul className="space-y-2">
                  {column.items.map((item) => (
                    <li key={item} className="flex items-center gap-2.5 text-[13px] text-slate-300">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: column.tone }} aria-hidden="true" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* ── Sign in ───────────────────────────────────────────────────── */}
        <section id="login" className="max-w-6xl mx-auto px-4 md:px-6 pb-20 md:pb-28 scroll-mt-16">
          <div className="grid lg:grid-cols-2 gap-8 lg:gap-14 items-center rounded-3xl p-6 md:p-12"
            style={{ background: "linear-gradient(160deg,#0b1220,#080f1c)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <div>
              <h2 className="text-2xl md:text-4xl font-black tracking-tight leading-[1.1] text-white">
                Bring your own list.
              </h2>
              <p className="mt-4 text-sm md:text-base text-slate-400 leading-relaxed max-w-md" style={{ fontFamily: SANS }}>
                Accounts are free and isolated. Add an OpenRouter key in settings to
                turn the AI scoring on, or use it as a plain sortable list without one.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <GhostButton href={REPO} target="_blank" rel="noopener noreferrer">Read the code</GhostButton>
              </div>
            </div>
            <div className="rounded-2xl p-6 md:p-7"
              style={{ background: "#020817", border: "1px solid rgba(255,255,255,0.08)" }}>
              <AuthPanel idPrefix="page-auth" />
            </div>
          </div>
        </section>
      </main>

      <AuthDialog open={authOpen} onClose={closeAuth} />
    </div>
  );
}
