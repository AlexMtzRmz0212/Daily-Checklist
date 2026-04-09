"""
AI Task Sorter — FastAPI Backend
=================================
Run:  uvicorn main:app --reload --port 8000
"""

import asyncio
import json
import os
import uuid
import httpx
import re

from datetime import date, timedelta
from typing import Any, Dict, List, Optional
from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

load_dotenv()

# ─────────────────────────────────────────────────────────────────────────────
#  App Setup
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="AI Task Sorter", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────────────────────────────────────
#  Config
# ─────────────────────────────────────────────────────────────────────────────

TASKS_FILE: str = "tasks.json"
OPENROUTER_URL: str = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_API_KEY: str = os.getenv("OPENROUTER_API_KEY")
MODEL: str = os.getenv("MODEL")
SITE_URL: str = "http://localhost:5173"
SITE_NAME: str = "AI Task Sorter"

# ─────────────────────────────────────────────────────────────────────────────
#  Pydantic Schemas
# ─────────────────────────────────────────────────────────────────────────────


class TaskCreate(BaseModel):
    Name: str
    Context: str = ""


class TaskBulkItem(BaseModel):
    Name: str
    Context: str = ""


class TaskBulkCreate(BaseModel):
    tasks: List[TaskBulkItem]


class TaskUpdate(BaseModel):
    Name: Optional[str] = None
    Context: Optional[str] = None
    Priority: Optional[int] = Field(None, ge=1, le=10)
    Hierarchy: Optional[int] = Field(None, ge=1, le=10)
    Time_Estimate: Optional[int] = Field(None, ge=1, le=10)
    Difficulty: Optional[int] = Field(None, ge=1, le=10)
    Relevance: Optional[int] = Field(None, ge=1, le=10)
    Urgency: Optional[int] = Field(None, ge=1, le=10)
    Importance: Optional[int] = Field(None, ge=1, le=10)
    Status: Optional[str] = None


class SortRequest(BaseModel):
    tasks: List[Dict[str, Any]]


class PostponeRequest(BaseModel):
    reason: str = ""


class SubtaskAdd(BaseModel):
    name: str


class SubtaskToggle(BaseModel):
    done: bool

class ModelConfig(BaseModel):
    model: str

# ─────────────────────────────────────────────────────────────────────────────
#  File I/O
# ─────────────────────────────────────────────────────────────────────────────


def load_tasks() -> List[Dict]:
    if not os.path.exists(TASKS_FILE):
        return []
    with open(TASKS_FILE, "r", encoding="utf-8") as fh:
        try:
            return json.load(fh)
        except json.JSONDecodeError:
            return []


def save_tasks(tasks: List[Dict]) -> None:
    with open(TASKS_FILE, "w", encoding="utf-8") as fh:
        json.dump(tasks, fh, indent=2, ensure_ascii=False)


# ─────────────────────────────────────────────────────────────────────────────
#  Postpone reactivation
#  Called on every GET /tasks — silently wakes tasks whose date has arrived.
# ─────────────────────────────────────────────────────────────────────────────


async def _reactivate_due_postponed(tasks: List[Dict]) -> List[Dict]:
    """
    For any Postponed task whose Postponed_Until <= today:
    1. Rebuild context with the postpone reason appended.
    2. Re-score via AI.
    3. Set Status back to Active.
    Returns the (possibly modified) full task list.
    """
    today = date.today().isoformat()
    due = [t for t in tasks if t.get("Status") == "Postponed" and t.get("Postponed_Until", "9999-99-99") <= today]

    if not due:
        return tasks

    async def wake(task: Dict) -> Dict:
        reason = task.get("Postpone_Reason", "")
        base_context = task.get("Context", "")
        new_context = base_context
        if reason:
            new_context = f"{base_context} [Postponed: {reason}]".strip()

        metrics = await _score_task(task["Name"], new_context)

        return {
            **task,
            **metrics,
            "Context": new_context,
            "Status": "Active",
            "Postponed_Until": None,
            "Postpone_Reason": None,
        }

    woken = await asyncio.gather(*[wake(t) for t in due])
    woken_map = {t["Task_ID"]: t for t in woken}

    updated = [woken_map.get(t["Task_ID"], t) for t in tasks]
    save_tasks(updated)
    return updated


# ─────────────────────────────────────────────────────────────────────────────
#  OpenRouter helpers
# ─────────────────────────────────────────────────────────────────────────────


def _or_headers() -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": SITE_URL,
        "X-Title": SITE_NAME,
    }


def _clean_json_fence(text: str) -> str:
    text = (text or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    match = re.search(r'[\{\[][\s\S]*[\}\]]', text)
    if match:
        return match.group(0)
    return text


async def _call_openrouter(prompt: str, max_tokens: int = 1000, temperature: float = 0.2) -> str:
    async with httpx.AsyncClient(timeout=45.0) as client:
        response = await client.post(
            OPENROUTER_URL,
            headers=_or_headers(),
            json={
                "model": MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": temperature,
                "max_tokens": max_tokens,
            },
        )
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail=f"OpenRouter returned {response.status_code}: {response.text}")
    return response.json()["choices"][0]["message"]["content"]


def _build_score_prompt(name: str, context: str) -> str:
    return f"""You are a ruthlessly precise task management AI.
Evaluate the task below and output ONLY a valid JSON object — no explanation, no markdown fences.

Task Name    : {name}
Task Context : {context or "No context provided"}

Return exactly this structure with integer values 1–10:
{{
  "Priority"     : <1-10>,
  "Hierarchy"    : <1-10>,
  "Time_Estimate": <1-10>,
  "Difficulty"   : <1-10>,
  "Relevance"    : <1-10>,
  "Urgency"      : <1-10>,
  "Importance"   : <1-10>
}}

Scoring rubric:
- Priority      1=trivial, 10=mission-critical
- Hierarchy     1=standalone leaf, 10=many tasks depend on this unblocking
- Time_Estimate 1=<30 min, 5=half a day, 10=>1 week
- Difficulty    1=trivial, 10=requires deep expertise / research
- Relevance     1=tangential side-task, 10=core to primary goals
- Urgency       1=do whenever, 10=due within hours or immediately
- Importance    1=nice-to-have, 10=critical long-term outcome"""


async def _score_task(name: str, context: str) -> Dict[str, int]:
    raw = await _call_openrouter(_build_score_prompt(name, context), max_tokens=500, temperature=0.15)

    def clamp(v: Any, default: int = 5) -> int:
        try:
            return max(1, min(10, int(v)))
        except (TypeError, ValueError):
            return default

    try:
        metrics = json.loads(_clean_json_fence(raw))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail=f"AI returned unparseable JSON: {raw!r}") from exc

    return {
        "Priority"     : clamp(metrics.get("Priority")),
        "Hierarchy"    : clamp(metrics.get("Hierarchy")),
        "Time_Estimate": clamp(metrics.get("Time_Estimate")),
        "Difficulty"   : clamp(metrics.get("Difficulty")),
        "Relevance"    : clamp(metrics.get("Relevance")),
        "Urgency"      : clamp(metrics.get("Urgency")),
        "Importance"   : clamp(metrics.get("Importance")),
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Routes — tasks
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/tasks")
async def get_tasks() -> List[Dict]:
    """Return active tasks, waking any postponed tasks due today first."""
    tasks = load_tasks()
    tasks = await _reactivate_due_postponed(tasks)
    return [t for t in tasks if t.get("Status") == "Active"]


@app.get("/tasks/all")
def get_all_tasks() -> List[Dict]:
    return load_tasks()


@app.post("/tasks/evaluate")
async def evaluate_task(task: TaskCreate) -> Dict:
    metrics = await _score_task(task.Name, task.Context)
    new_task: Dict[str, Any] = {
        "Task_ID"       : str(uuid.uuid4()),
        "Name"          : task.Name,
        "Context"       : task.Context or "",
        "Status"        : "Active",
        "Subtasks"      : [],
        "Postponed_Until": None,
        "Postpone_Reason": None,
        **metrics,
    }
    tasks = load_tasks()
    tasks.append(new_task)
    save_tasks(tasks)
    return new_task


@app.post("/tasks/evaluate-bulk")
async def evaluate_bulk(payload: TaskBulkCreate) -> List[Dict]:
    async def score_one(item: TaskBulkItem) -> Dict[str, Any]:
        metrics = await _score_task(item.Name, item.Context)
        return {
            "Task_ID"        : str(uuid.uuid4()),
            "Name"           : item.Name,
            "Context"        : item.Context or "",
            "Status"         : "Active",
            "Subtasks"       : [],
            "Postponed_Until": None,
            "Postpone_Reason": None,
            **metrics,
        }

    new_tasks = list(await asyncio.gather(*[score_one(item) for item in payload.tasks]))
    all_tasks = load_tasks()
    all_tasks.extend(new_tasks)
    save_tasks(all_tasks)
    return new_tasks


@app.post("/tasks/reevaluate-all")
async def reevaluate_all() -> List[Dict]:
    all_tasks = load_tasks()
    active = [t for t in all_tasks if t.get("Status") == "Active"]
    if not active:
        return []

    async def rescore(task: Dict) -> Dict:
        metrics = await _score_task(task["Name"], task.get("Context", ""))
        return {**task, **metrics}

    rescored = await asyncio.gather(*[rescore(t) for t in active])
    rescored_map = {t["Task_ID"]: t for t in rescored}
    updated_all = [rescored_map.get(t["Task_ID"], t) for t in all_tasks]
    save_tasks(updated_all)
    return [t for t in updated_all if t.get("Status") == "Active"]


@app.post("/tasks/sort")
async def sort_tasks(request: SortRequest) -> Dict:
    if not request.tasks:
        return {"sorted_ids": []}

    def sort_key(t: Dict) -> tuple:
        return (
            -(t.get("Urgency", 5) * t.get("Importance", 5)),
            -t.get("Hierarchy", 5),
            -t.get("Priority", 5),
             t.get("Time_Estimate", 5),
            -t.get("Relevance", 5),
        )

    return {"sorted_ids": [t["Task_ID"] for t in sorted(request.tasks, key=sort_key)]}


@app.put("/tasks/{task_id}")
def update_task(task_id: str, update: TaskUpdate) -> Dict:
    tasks = load_tasks()
    for i, t in enumerate(tasks):
        if t["Task_ID"] == task_id:
            tasks[i].update(update.model_dump(exclude_none=True))
            save_tasks(tasks)
            return tasks[i]
    raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")


@app.patch("/tasks/{task_id}/complete")
def complete_task(task_id: str) -> Dict:
    tasks = load_tasks()
    for i, t in enumerate(tasks):
        if t["Task_ID"] == task_id:
            tasks[i]["Status"] = "Completed"
            save_tasks(tasks)
            return {"message": "Task completed", "Task_ID": task_id}
    raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")


@app.patch("/tasks/{task_id}/postpone")
def postpone_task(task_id: str, body: PostponeRequest) -> Dict:
    """
    Mark a task as Postponed until tomorrow.
    The reason is stored and will be appended to Context when the task wakes.
    """
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    tasks = load_tasks()
    for i, t in enumerate(tasks):
        if t["Task_ID"] == task_id:
            tasks[i]["Status"] = "Postponed"
            tasks[i]["Postponed_Until"] = tomorrow
            tasks[i]["Postpone_Reason"] = body.reason.strip()
            save_tasks(tasks)
            return {"message": "Task postponed", "Task_ID": task_id, "until": tomorrow}
    raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")


@app.post("/tasks/bulk-update")
def bulk_update(updated_tasks: List[Dict[str, Any]] = Body(...)) -> Dict:
    all_tasks = load_tasks()
    task_map = {t["Task_ID"]: t for t in all_tasks}
    updated_count = 0
    for updated in updated_tasks:
        tid = updated.get("Task_ID")
        if tid and tid in task_map:
            task_map[tid].update(updated)
            updated_count += 1
    save_tasks(list(task_map.values()))
    return {"message": f"Bulk-updated {updated_count} task(s)"}


@app.delete("/tasks/{task_id}")
def delete_task(task_id: str) -> Dict:
    tasks = load_tasks()
    filtered = [t for t in tasks if t["Task_ID"] != task_id]
    if len(filtered) == len(tasks):
        raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")
    save_tasks(filtered)
    return {"message": "Task deleted", "Task_ID": task_id}


# ─────────────────────────────────────────────────────────────────────────────
#  Routes — subtasks
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/tasks/{task_id}/subtasks/suggest")
async def suggest_subtasks(task_id: str) -> Dict:
    """
    Ask the AI to suggest 3-6 concrete subtasks for this task.
    Returns { "suggestions": ["...", "..."] }
    """
    tasks = load_tasks()
    task = next((t for t in tasks if t["Task_ID"] == task_id), None)
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")

    existing = [s["name"] for s in task.get("Subtasks", [])]
    existing_str = "\n".join(f"- {s}" for s in existing) if existing else "None yet."

    prompt = f"""You are a precise project planning AI.
Given the task below, suggest 3 to 6 concrete, actionable subtasks that would help complete it.
Output ONLY a valid JSON array of strings — no explanation, no markdown fences.

Task Name    : {task["Name"]}
Task Context : {task.get("Context") or "No context provided"}
Already defined subtasks:
{existing_str}

Return exactly this structure:
["subtask one", "subtask two", "subtask three"]

Rules:
- Each subtask must be a short, specific action (under 10 words)
- Do not repeat existing subtasks
- Order from first to last step logically"""

    raw = await _call_openrouter(prompt, max_tokens=400, temperature=0.3)

    try:
        suggestions = json.loads(_clean_json_fence(raw))
        if not isinstance(suggestions, list):
            raise ValueError("Not a list")
        suggestions = [str(s).strip() for s in suggestions if str(s).strip()]
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"AI returned unparseable suggestions: {raw!r}") from exc

    return {"suggestions": suggestions}


@app.post("/tasks/{task_id}/subtasks")
def add_subtask(task_id: str, body: SubtaskAdd) -> Dict:
    """Add a single subtask (manual or accepted AI suggestion)."""
    tasks = load_tasks()
    for i, t in enumerate(tasks):
        if t["Task_ID"] == task_id:
            subtask = {"id": str(uuid.uuid4()), "name": body.name.strip(), "done": False}
            if "Subtasks" not in tasks[i]:
                tasks[i]["Subtasks"] = []
            tasks[i]["Subtasks"].append(subtask)
            save_tasks(tasks)
            return subtask
    raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")


@app.patch("/tasks/{task_id}/subtasks/{subtask_id}")
def toggle_subtask(task_id: str, subtask_id: str, body: SubtaskToggle) -> Dict:
    tasks = load_tasks()
    for i, t in enumerate(tasks):
        if t["Task_ID"] == task_id:
            for j, s in enumerate(t.get("Subtasks", [])):
                if s["id"] == subtask_id:
                    tasks[i]["Subtasks"][j]["done"] = body.done
                    save_tasks(tasks)
                    return tasks[i]["Subtasks"][j]
            raise HTTPException(status_code=404, detail=f"Subtask {subtask_id!r} not found")
    raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")


@app.delete("/tasks/{task_id}/subtasks/{subtask_id}")
def delete_subtask(task_id: str, subtask_id: str) -> Dict:
    tasks = load_tasks()
    for i, t in enumerate(tasks):
        if t["Task_ID"] == task_id:
            before = len(t.get("Subtasks", []))
            tasks[i]["Subtasks"] = [s for s in t.get("Subtasks", []) if s["id"] != subtask_id]
            if len(tasks[i]["Subtasks"]) == before:
                raise HTTPException(status_code=404, detail=f"Subtask {subtask_id!r} not found")
            save_tasks(tasks)
            return {"message": "Subtask deleted"}
    raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")


@app.get("/health")
def health() -> Dict:
    return {"status": "ok", "tasks_file": TASKS_FILE, "model": MODEL}


# ─────────────────────────────────────────────────────────────────────────────
#  Model Configuration Routes
# ─────────────────────────────────────────────────────────────────────────────

MODEL_CONFIG_FILE: str = "model_config.json"

def load_model_config() -> str:
    """Load the saved model from config file, fallback to env var or default"""
    if os.path.exists(MODEL_CONFIG_FILE):
        try:
            with open(MODEL_CONFIG_FILE, "r", encoding="utf-8") as fh:
                config = json.load(fh)
                return config.get("model", MODEL)
        except (json.JSONDecodeError, KeyError):
            pass
    return MODEL  # fallback to env var

def save_model_config(model: str) -> None:
    """Save the model to config file"""
    with open(MODEL_CONFIG_FILE, "w", encoding="utf-8") as fh:
        json.dump({"model": model}, fh, indent=2)

@app.get("/config/model")
def get_model() -> Dict:
    """Get the current model being used"""
    return {"model": load_model_config()}

@app.post("/config/model")
def set_model(config: ModelConfig) -> Dict:
    """Set the model to use for AI scoring"""
    global MODEL
    MODEL = config.model
    save_model_config(config.model)
    return {"message": "Model updated", "model": MODEL}