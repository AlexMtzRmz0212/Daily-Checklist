"""
AI Task Sorter — FastAPI Backend
=================================
Run:  uvicorn main:app --reload --port 8000
Env:  OPENROUTER_API_KEY=sk-or-v1-...
"""

import json
import os
import uuid
from typing import Any, Dict, List, Optional

import httpx
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
    """Payload the frontend sends when adding a new task."""
    Name: str
    Context: str = ""
    Deadline: Optional[str] = None          # ISO date string e.g. "2025-12-31"


class TaskUpdate(BaseModel):
    """Partial update — all fields optional."""
    Name: Optional[str] = None
    Context: Optional[str] = None
    Priority: Optional[int] = Field(None, ge=1, le=10)
    Hierarchy: Optional[int] = Field(None, ge=1, le=10)
    Time_Estimate: Optional[int] = Field(None, ge=1, le=10)
    Difficulty: Optional[int] = Field(None, ge=1, le=10)
    Relevance: Optional[int] = Field(None, ge=1, le=10)
    Urgency: Optional[int] = Field(None, ge=1, le=10)
    Importance: Optional[int] = Field(None, ge=1, le=10)
    Deadline: Optional[str] = None
    Status: Optional[str] = None


class SortRequest(BaseModel):
    tasks: List[Dict[str, Any]]


# ─────────────────────────────────────────────────────────────────────────────
#  File I/O Helpers
# ─────────────────────────────────────────────────────────────────────────────


def load_tasks() -> List[Dict]:
    """Read tasks from the local JSON file; return [] if absent or corrupt."""
    if not os.path.exists(TASKS_FILE):
        return []
    with open(TASKS_FILE, "r", encoding="utf-8") as fh:
        try:
            return json.load(fh)
        except json.JSONDecodeError:
            return []


def save_tasks(tasks: List[Dict]) -> None:
    """Atomically write task list to the local JSON file."""
    with open(TASKS_FILE, "w", encoding="utf-8") as fh:
        json.dump(tasks, fh, indent=2, ensure_ascii=False)


# ─────────────────────────────────────────────────────────────────────────────
#  OpenRouter Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _or_headers() -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": SITE_URL,
        "X-Title": SITE_NAME,
    }


def _clean_json_fence(text: str) -> str:
    """
    Strip markdown code fences that some LLMs wrap around JSON, e.g.
        ```json
        { ... }
        ```
    """
    text = (text or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        # Drop the opening fence line (``` or ```json)
        lines = lines[1:]
        # Drop the closing fence line if present
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text


async def _call_openrouter(prompt: str, max_tokens: int = 300, temperature: float = 0.2) -> str:
    """
    Post a single-turn prompt to OpenRouter and return the raw text content.
    Raises HTTPException on non-200 status codes.
    """
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
        raise HTTPException(
            status_code=502,
            detail=f"OpenRouter returned {response.status_code}: {response.text}",
        )
    print(f"OpenRouter response: {response.text}")
    return response.json()["choices"][0]["message"]["content"]


# ─────────────────────────────────────────────────────────────────────────────
#  Routes
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/tasks", summary="List all active tasks")
def get_tasks() -> List[Dict]:
    """Return every task whose Status == 'Active'."""
    return [t for t in load_tasks() if t.get("Status") == "Active"]


@app.get("/tasks/all", summary="List ALL tasks including completed ones")
def get_all_tasks() -> List[Dict]:
    return load_tasks()


@app.post("/tasks/evaluate", summary="AI-score a new task and persist it")
async def evaluate_task(task: TaskCreate) -> Dict:
    """
    Workflow
    --------
    1. Build a scoring prompt from the task's Name, Context, and Deadline.
    2. Send to OpenRouter; parse the JSON metrics response.
    3. Assemble a full Task record and append it to tasks.json.
    4. Return the new task (frontend renders it immediately).
    """
    prompt = f"""You are a ruthlessly precise task management AI.
Evaluate the task below and output ONLY a valid JSON object — no explanation, no markdown fences.

Task Name    : {task.Name}
Task Context : {task.Context or "No context provided"}
Deadline     : {task.Deadline or "No deadline specified"}

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

    raw = await _call_openrouter(prompt, max_tokens=2000, temperature=0.15)

    try:
        metrics = json.loads(_clean_json_fence(raw))
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"AI returned unparseable JSON: {raw!r}",
        ) from exc

    def clamp(v: Any, default: int = 5) -> int:
        try:
            return max(1, min(10, int(v)))
        except (TypeError, ValueError):
            return default

    new_task: Dict[str, Any] = {
        "Task_ID"      : str(uuid.uuid4()),
        "Name"         : task.Name,
        "Context"      : task.Context or "",
        "Priority"     : clamp(metrics.get("Priority")),
        "Hierarchy"    : clamp(metrics.get("Hierarchy")),
        "Time_Estimate": clamp(metrics.get("Time_Estimate")),
        "Difficulty"   : clamp(metrics.get("Difficulty")),
        "Relevance"    : clamp(metrics.get("Relevance")),
        "Urgency"      : clamp(metrics.get("Urgency")),
        "Importance"   : clamp(metrics.get("Importance")),
        "Deadline"     : task.Deadline,
        "Status"       : "Active",
    }

    tasks = load_tasks()
    tasks.append(new_task)
    save_tasks(tasks)

    return new_task


@app.post("/tasks/sort", summary="AI-sort submitted tasks by priority")
async def sort_tasks(request: SortRequest) -> Dict:
    """
    Workflow
    --------
    1. Format the task list into a prompt showing all numerical properties.
    2. Ask the LLM to return a sorted list of Task_IDs (highest priority first).
    3. Return { "sorted_ids": [...] } — the frontend reorders rows with Framer Motion.
    """
    if not request.tasks:
        return {"sorted_ids": []}

    task_lines = "\n".join(
        f"  ID={t['Task_ID']} | name={t['Name']!r} | "
        f"priority={t['Priority']} urgency={t['Urgency']} importance={t['Importance']} "
        f"hierarchy={t['Hierarchy']} difficulty={t['Difficulty']} "
        f"time={t['Time_Estimate']} relevance={t['Relevance']} "
        f"deadline={t.get('Deadline') or 'none'}"
        for t in request.tasks
    )

    id_list = ", ".join(f'"{t["Task_ID"]}"' for t in request.tasks)

    prompt = f"""You are a hyper-rational task prioritisation AI.
Sort the tasks below from MOST to LEAST urgent/important and output ONLY a valid JSON object — no explanation, no markdown fences.

Sorting algorithm (apply in order):
1. Eisenhower score = Urgency × Importance  (highest first)
2. Hierarchy tiebreak: tasks that unblock others go first
3. Priority score tiebreak
4. Lower Time_Estimate tiebreak (quick wins first if scores are equal)
5. Higher Relevance tiebreak

Tasks:
{task_lines}

Valid IDs to include: [{id_list}]

Return exactly this structure containing ALL IDs in sorted order:
{{"sorted_ids": ["<id1>", "<id2>", ...]}}"""

    raw = await _call_openrouter(prompt, max_tokens=asdf, temperature=0.05)

    try:
        result = json.loads(_clean_json_fence(raw))
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"AI returned unparseable JSON: {raw!r}",
        ) from exc

    # Safety: ensure all original IDs are present; append any missing at the end
    original_ids = [t["Task_ID"] for t in request.tasks]
    returned_ids: List[str] = result.get("sorted_ids", [])
    returned_set = set(returned_ids)
    for oid in original_ids:
        if oid not in returned_set:
            returned_ids.append(oid)

    return {"sorted_ids": returned_ids}


@app.put("/tasks/{task_id}", summary="Update a single task's properties")
def update_task(task_id: str, update: TaskUpdate) -> Dict:
    tasks = load_tasks()
    for i, t in enumerate(tasks):
        if t["Task_ID"] == task_id:
            update_data = update.model_dump(exclude_none=True)
            tasks[i].update(update_data)
            save_tasks(tasks)
            return tasks[i]
    raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")


@app.patch("/tasks/{task_id}/complete", summary="Mark a task as Completed")
def complete_task(task_id: str) -> Dict:
    tasks = load_tasks()
    for i, t in enumerate(tasks):
        if t["Task_ID"] == task_id:
            tasks[i]["Status"] = "Completed"
            save_tasks(tasks)
            return {"message": "Task completed", "Task_ID": task_id}
    raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")


@app.post("/tasks/bulk-update", summary="Batch-save locally-edited tasks before a sort")
def bulk_update(updated_tasks: List[Dict[str, Any]] = Body(...)) -> Dict:
    """
    The frontend calls this just before the AI sort to flush all
    in-memory property edits to disk in a single write.
    """
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


@app.delete("/tasks/{task_id}", summary="Hard-delete a task")
def delete_task(task_id: str) -> Dict:
    tasks = load_tasks()
    filtered = [t for t in tasks if t["Task_ID"] != task_id]
    if len(filtered) == len(tasks):
        raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")
    save_tasks(filtered)
    return {"message": "Task deleted", "Task_ID": task_id}


@app.get("/health", summary="Health check")
def health() -> Dict:
    return {"status": "ok", "tasks_file": TASKS_FILE, "model": MODEL}
