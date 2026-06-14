# AI Task Sorter
**FastAPI · React · Framer Motion · OpenRouter · tasks.json**

A full-stack task management app where an AI evaluates, scores, and physically re-orders your task list in real time.

---

## Quick Start

### 1 — Get an OpenRouter API key
Sign up at https://openrouter.ai and copy your key.

### 2 — Clone & Setup

```bash
git clone https://github.com/AlexMtzRmz0212/Daily-Checklist.git
cd Daily-Checklist

# Copy environment template
cp .env.example .env    # Mac/Linux
copy .env.example .env  # Windows
```

Edit `.env` with your API key and preferred model.

### 3 — Backend

```bash
# Create virtual environment
python -m venv .venv
.venv\Scripts\activate    # Windows
source .venv/bin/activate # Mac/Linux

# Install & run
pip install fastapi "uvicorn[standard]" httpx pydantic
uvicorn backend.main:app --reload --port 8000
```

### 4 — Frontend (new terminal)

```bash
cd task-sorter

npm install
npm run dev
```

Open http://localhost:5173

### 5 — One-Click Launch (after setup)

Double-click `Sorter.bat` to start both servers and open Chrome automatically.

---

## File Structure

```
Daily-Checklist/
├── .env                 ← Your keys (gitignored)
├── .env.example         ← Template
├── requirements.txt     ← Python deps
├── Sorter.bat           ← Launcher
├── backend/             ← FastAPI Backend
│   ├── main.py
│   ├── models.py
│   └── database.py
├── task-sorter/         ← Complete React app
│   ├── src/
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   └── index.css
│   └── package.json
└── tasks.json           ← Auto-created (gitignored)
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tasks` | List active tasks |
| GET | `/tasks/all` | List all tasks |
| POST | `/tasks/evaluate` | AI-score new task |
| POST | `/tasks/sort` | AI-sort task list |
| POST | `/tasks/bulk-update` | Batch save edits |
| PUT | `/tasks/{id}` | Update task |
| PATCH | `/tasks/{id}/complete` | Mark complete |
| DELETE | `/tasks/{id}` | Delete task |

---

## Task Schema

```json
{
  "Task_ID": "uuid",
  "Name": "string",
  "Context": "string",
  "Priority": 1-10,
  "Hierarchy": 1-10,
  "Time_Estimate": 1-10,
  "Difficulty": 1-10,
  "Relevance": 1-10,
  "Urgency": 1-10,
  "Importance": 1-10,
  "Deadline": "YYYY-MM-DD | null",
  "Status": "Active | Completed"
}
```

---

## Workflow

**Add Task** → Type name → AI scores it → Card appears

**Batch Edit** → Expand card → Adjust scores → Unsaved indicator shows

**Submit & Sort** → AI applies Eisenhower Matrix → Cards animate to new positions

**Interrupt** → Red button aborts sort → Choose keep or revert

**Complete** → Click checkbox → Card slides out

---

## Customisation

| What | Where |
|------|-------|
| AI model | `MODEL` in `.env` |
| Task properties | `PROPERTIES` in `frontend/src/App.jsx` |
| Sort logic | Prompt in `/tasks/sort` (`main.py`) |
| Backend port | `--port` flag or `Sorter.bat` |

---

## Troubleshooting

**CORS errors** — Backend must run on port 8000

**API key not found** — Copy `.env.example` to `.env` and add your key

**Sorter.bat fails** — Run manual setup once first

**Chrome doesn't open** — Edit last line of `Sorter.bat` to use Firefox or default browser

---

## License

MIT

---


## Contact

Questions, comments, or suggestions? Send an email to [alejandro.martinez.rmz97@gmail.com](mailto:alejandro.martinez.rmz97@gmail.com) with the subject line: **AI Task Sorter — [Your Topic]**

We'd love to hear your feedback!