# AI Task Sorter
**FastAPI · React · Framer Motion · OpenRouter · tasks.json**

A full-stack task management app where an AI evaluates, scores, and physically
re-orders your task list in real time — with smooth layout animations, batch
editing, and an interrupt protocol.

---

## Quick Start

### 1 — Get an OpenRouter API key
Sign up at https://openrouter.ai and copy your key.

---

### 2 — Backend (Python / FastAPI)

```bash
# Create & activate a virtual environment
python -m venv .venv
source .venv/bin/activate       
# Windows: .venv\Scripts\activate

# Install dependencies
pip install fastapi "uvicorn[standard]" httpx pydantic

# Set your key 
export OPENROUTER_API_KEY="sk-or-v1-YOUR_KEY_HERE"

# fish shell: set -x ...; 

# PowerShell: 
$env:OPENROUTER_API="sk-or..."
# to verify key:
echo $env:OPENROUTER_API


# Run (from the folder containing main.py)
uvicorn main:app --reload --port 8000
```

Verify: open http://localhost:8000/docs in your browser.

---

### 3 — Frontend (React / Vite) [In a new terminal]

```bash
# Activate venv
# Scaffold a new Vite project (skip if you already have one)
npm create vite@latest task-sorter -- --template react
cd task-sorter

# Install runtime dependencies
npm install framer-motion

# Install & init Tailwind CSS
npm install -D tailwindcss postcss autoprefixer autoprefixer 
npx tailwindcss init -p
# If it fails: 
npm install -D tailwindcss@3 postcss 
npx tailwindcss init -p
```

Open **tailwind.config.js** and paste the following:
```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: { extend: {} },
  plugins: [],
};
```

Open **src/index.css** and replace all content with the following:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

Open **src/main.jsx** and replace with this:
```jsx
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

**Drop `App.jsx` into `src/`** (replace the scaffolded file).

```bash
npm run dev          # → http://localhost:5173
```

---

## File Structure

```
project/
├── main.py           ← FastAPI backend (this repo)
├── tasks.json        ← auto-created on first task add
│
└── task-sorter/      ← Vite React frontend
    └── src/
        ├── App.jsx   ← (this repo)
        ├── main.jsx
        └── index.css
```

---

## API Reference

| Method | Endpoint                     | Description                                    |
|--------|------------------------------|------------------------------------------------|
| GET    | `/tasks`                     | List all Active tasks                          |
| GET    | `/tasks/all`                 | List all tasks (including Completed)           |
| POST   | `/tasks/evaluate`            | AI-score a new task, append to tasks.json      |
| POST   | `/tasks/sort`                | AI-sort a task list, return sorted_ids         |
| POST   | `/tasks/bulk-update`         | Batch-save local edits before sort             |
| PUT    | `/tasks/{id}`                | Update a single task's properties              |
| PATCH  | `/tasks/{id}/complete`       | Set Status = "Completed"                       |
| DELETE | `/tasks/{id}`                | Hard-delete a task                             |
| GET    | `/health`                    | Health check                                   |

---

## Task Schema

```json
{
  "Task_ID"      : "uuid",
  "Name"         : "string",
  "Context"      : "string",
  "Priority"     : 1-10,
  "Hierarchy"    : 1-10,
  "Time_Estimate": 1-10,
  "Difficulty"   : 1-10,
  "Relevance"    : 1-10,
  "Urgency"      : 1-10,
  "Importance"   : 1-10,
  "Deadline"     : "YYYY-MM-DD | null",
  "Status"       : "Active | Completed"
}
```

---

## Workflow Explained

### A · Add a Task
1. Type a name + optional context / deadline → **＋ ADD**
2. The frontend POSTs to `/tasks/evaluate`
3. FastAPI sends a structured prompt to OpenRouter (`gpt-4o-mini`)
4. The AI returns seven integer scores; the task is written to `tasks.json`
5. The card appears immediately in the list with animated entry

### B · Batch Editing
- Click **▼** on any card to expand the property grid
- Use **−** / **＋** to adjust any score locally (no backend call)
- Mini coloured bars update in real time
- The "● unsaved edits" indicator appears in the toolbar

### C · Submit & Sort
1. Click **⚡ SUBMIT & SORT**
2. Overlay appears — blurs & dims the app, shows a spinning ring
3. All local edits are flushed to disk via `/tasks/bulk-update`
4. The merged task list is sent to `/tasks/sort`
5. The AI applies Eisenhower Matrix (Urgency × Importance) + tiebreakers
6. The frontend receives `sorted_ids` and reorders React state
7. Framer Motion's `layout` prop animates each card to its new position

### D · Interrupt Protocol
1. During sorting, a red **⏸ INTERRUPT** button is visible
2. Clicking it aborts the in-flight fetch via `AbortController`
3. A modal appears:
   - **Keep Current State** — leave tasks where they are
   - **Revert to Original** — restore the pre-sort snapshot

### E · Complete a Task
- Click the circle checkbox on any card
- The card slides out to the right (Framer Motion `exit` animation)
- The backend is updated (`Status = "Completed"`)
- The card is removed from the active list

---

## Customisation

| What                  | Where                                   |
|-----------------------|-----------------------------------------|
| Change the AI model   | `MODEL` constant in `main.py`           |
| Add more properties   | `PROPERTIES` array in `App.jsx`         |
| Adjust sort algorithm | The prompt inside `/tasks/sort`         |
| Persist to DB instead | Replace `load_tasks()`/`save_tasks()`   |
| Change port           | `--port` flag in `uvicorn` command      |

---

## Troubleshooting

**CORS errors** — make sure the backend is running on port 8000 and the
`allow_origins=["*"]` middleware is active (it is by default).

**AI returns invalid JSON** — bump `max_tokens` in `_call_openrouter()` or
switch to a model with better instruction-following (e.g. `anthropic/claude-3-haiku`).

**Tasks not persisting** — check that the working directory where you run
`uvicorn` is writable; `tasks.json` is created there automatically.
