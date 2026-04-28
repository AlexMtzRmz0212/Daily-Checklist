"""
AI Task Sorter — FastAPI Backend
=================================
Run:  uvicorn backend.main:app --reload --port 8000
"""

import asyncio
import json
import os
import uuid
import httpx
import re
from pathlib import Path

from datetime                   import date, timedelta
from typing                     import Any, Dict, List, Optional, Literal
from fastapi                    import Body, FastAPI, HTTPException
from fastapi.middleware.cors    import CORSMiddleware
from pydantic                   import BaseModel, Field
from dotenv                     import load_dotenv

load_dotenv()

# ─────────────────────────────────────────────────────────────────────────────
#  App Setup
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="AI Task Sorter", version="1.2.0")

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

BACKEND_DIR = Path(__file__).parent
PROJECT_ROOT = BACKEND_DIR.parent

TASKS_FILE: str = str(BACKEND_DIR / "tasks.json")
MODEL_CONFIG_FILE: str = str(BACKEND_DIR / "model_config.json")
CONFIG_FILE: str = str(BACKEND_DIR / "app_config.json")

OPENROUTER_URL: str = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_API_KEY: str = os.getenv("OPENROUTER_API_KEY")
MODEL: str = os.getenv("MODEL")
SITE_URL: str = "http://localhost:5173"
SITE_NAME: str = "AI Task Sorter"

# Default scoring modes for each property
DEFAULT_PROPERTY_MODES: Dict[str, str] = {
    "Priority": "scale",
    "Hierarchy": "scale",
    "Time_Minutes": "scale",  # Always scale, but in minutes
    "Difficulty": "scale",
    "Relevance": "scale",
    "Urgency": "scale",
    "Importance": "scale",
}

# Time presets in minutes
TIME_PRESETS = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 480, 960, 1440]


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
    Time_Minutes: Optional[int] = Field(None, ge=1)
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

class PropertyModeConfig(BaseModel):
    property_modes: Dict[str, Literal["scale", "binary"]]

# ─────────────────────────────────────────────────────────────────────────────
#  File I/O
# ─────────────────────────────────────────────────────────────────────────────

def load_tasks() -> List[Dict]:
    if not os.path.exists(TASKS_FILE):
        print(f"Error: tasks file not found: {TASKS_FILE}")
        return []
    with open(TASKS_FILE, "r", encoding="utf-8") as fh:
        try:
            return json.load(fh)
        except json.JSONDecodeError:
            return []

def save_tasks(tasks: List[Dict]) -> None:
    with open(TASKS_FILE, "w", encoding="utf-8") as fh:
        json.dump(tasks, fh, indent=2, ensure_ascii=False)

def load_config() -> Dict:
    """Load app configuration (property modes, etc.)"""
    config_path = str(BACKEND_DIR / CONFIG_FILE)
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as fh:
                config = json.load(fh)
                if "property_modes" not in config:
                    config["property_modes"] = DEFAULT_PROPERTY_MODES.copy()
                else:
                    for prop, mode in DEFAULT_PROPERTY_MODES.items():
                        if prop not in config["property_modes"]:
                            config["property_modes"][prop] = mode
                return config
        except (json.JSONDecodeError, KeyError):
            pass
    return {"property_modes": DEFAULT_PROPERTY_MODES.copy()}

def save_config(config: Dict) -> None:
    """Save app configuration"""
    config_path = str(BACKEND_DIR / CONFIG_FILE)
    with open(config_path, "w", encoding="utf-8") as fh:
        json.dump(config, fh, indent=2, ensure_ascii=False)

# ─────────────────────────────────────────────────────────────────────────────
#  Utility Functions
# ─────────────────────────────────────────────────────────────────────────────

def _normalize_binary_to_scale(value: Any, default: int = 5) -> int:
    """Convert binary values (0/1 or True/False) to 1-10 scale"""
    try:
        v = int(value)
        if v <= 1:
            return 1 if v == 0 else 10  # 0→1, 1→10
        return max(1, min(10, v))
    except (TypeError, ValueError):
        return default

def _normalize_time_for_sorting(time_minutes: int) -> float:
    """Convert minutes to a normalized value for sorting (lower time = higher priority in tiebreaker)"""
    if time_minutes <= 0:
        return 0.1
    # Normalize: 5 min → 10 (highest priority), 1440+ min → 1 (lowest priority)
    return max(1, 10 - (time_minutes / 160))

def _get_property_modes() -> Dict[str, str]:
    """Get current property modes from config"""
    config = load_config()
    return config.get("property_modes", DEFAULT_PROPERTY_MODES.copy())

def _attempt_fix_truncated_json(text: str) -> Optional[str]:
    """Attempt to fix truncated JSON by adding missing closing braces/brackets"""
    text = text.strip()
    
    # Count opening and closing braces
    open_braces = text.count('{')
    close_braces = text.count('}')
    open_brackets = text.count('[')
    close_brackets = text.count(']')
    
    # Add missing closing braces/brackets
    if open_braces > close_braces:
        text += '}' * (open_braces - close_braces)
    if open_brackets > close_brackets:
        text += ']' * (open_brackets - close_brackets)
    
    # Remove trailing commas before closing braces (common in truncated JSON)
    import re
    text = re.sub(r',\s*\}', '}', text)
    text = re.sub(r',\s*\]', ']', text)
    
    # Try to parse the fixed JSON
    try:
        json.loads(text)
        return text
    except json.JSONDecodeError:
        # If still invalid, try to extract complete key-value pairs
        # Look for pattern: "Property": value,
        pairs = re.findall(r'"([^"]+)"\s*:\s*([0-9]+(?:\.?[0-9]*)?)', text)
        if pairs:
            # Reconstruct from extracted pairs
            reconstructed = {}
            for key, value in pairs:
                if key in ["Priority", "Hierarchy", "Difficulty", "Relevance", "Urgency", "Importance", "Time_Minutes"]:
                    reconstructed[key] = int(float(value))
            if reconstructed:
                # Ensure all required fields exist
                for field in ["Priority", "Hierarchy", "Difficulty", "Relevance", "Urgency", "Importance"]:
                    if field not in reconstructed:
                        reconstructed[field] = 5
                if "Time_Minutes" not in reconstructed:
                    reconstructed["Time_Minutes"] = 30
                return json.dumps(reconstructed)
    
    return None

# ─────────────────────────────────────────────────────────────────────────────
#  Migration: Convert old Time_Estimate to Time_Minutes
# ─────────────────────────────────────────────────────────────────────────────

def _migrate_time_estimate_to_minutes(tasks: List[Dict]) -> List[Dict]:
    """Migrate any tasks still using Time_Estimate (1-10) to Time_Minutes"""
    migration_map = {
        1: 5,     # ~5 min
        2: 15,    # ~15 min
        3: 30,    # ~30 min
        4: 60,    # ~1 hour
        5: 120,   # ~2 hours
        6: 240,   # ~4 hours
        7: 480,   # ~8 hours (1 day)
        8: 960,   # ~16 hours (2 days)
        9: 1440,  # ~24 hours (3-4 days)
        10: 2880, # ~48 hours (1 week)
    }
    
    migrated = False
    for task in tasks:
        if "Time_Estimate" in task and "Time_Minutes" not in task:
            old_value = task.get("Time_Estimate")
            task["Time_Minutes"] = migration_map.get(old_value, 60)
            # Keep Time_Estimate temporarily for backward compat
            migrated = True
    
    if migrated:
        # Remove Time_Estimate after successful migration
        for task in tasks:
            if "Time_Estimate" in task:
                del task["Time_Estimate"]
        save_tasks(tasks)
    
    return tasks

# ─────────────────────────────────────────────────────────────────────────────
#  Postpone reactivation
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
                "model": load_model_config(),
                "messages": [{"role": "user", "content": prompt}],
                "temperature": temperature,
                "max_tokens": max_tokens,
            },
        )
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail=f"OpenRouter returned {response.status_code}: {response.text}")
    return response.json()["choices"][0]["message"]["content"]

def _build_score_prompt(name: str, context: str, property_modes: Dict[str, str]) -> str:
    """Build scoring prompt based on current property modes"""
    
    # Build dynamic scoring instructions based on modes
    score_fields = []
    
    for prop in ["Priority", "Hierarchy", "Difficulty", "Relevance", "Urgency", "Importance"]:
        if property_modes.get(prop) == "binary":
            score_fields.append(f'  "{prop}": <0 or 1>  // 0=No, 1=Yes')
        else:
            score_fields.append(f'  "{prop}": <1-10>')
    
    # Time_Minutes is always in minutes
    score_fields.append('  "Time_Minutes": <estimated minutes>')
    
    return f"""You are a ruthlessly precise task management AI.
Evaluate the task below and output ONLY a valid JSON object — no explanation, no markdown fences.

IMPORTANT: You MUST return COMPLETE, valid JSON. Do not truncate or cut off the response.

Task Name    : {name}
Task Context : {context or "No context provided"}

Return exactly this structure (no extra text before or after):
{{
{chr(10).join(score_fields)}
}}

Scoring rubric:
{'• Priority:      0=not a priority, 1=is a priority' if property_modes.get('Priority') == 'binary' else '• Priority:      1=trivial, 10=mission-critical'}
{'• Hierarchy:     0=no dependencies, 1=has dependencies/blocking other work' if property_modes.get('Hierarchy') == 'binary' else '• Hierarchy:     1=standalone leaf, 10=many tasks depend on this unblocking'}
• Time_Minutes:   Estimate real time in minutes (5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 480, 960, 1440)
{'• Difficulty:    0=easy/straightforward, 1=challenging/complex' if property_modes.get('Difficulty') == 'binary' else '• Difficulty:    1=trivial, 10=requires deep expertise / research'}
{'• Relevance:     0=not relevant to goals, 1=relevant to goals' if property_modes.get('Relevance') == 'binary' else '• Relevance:     1=tangential side-task, 10=core to primary goals'}
{'• Urgency:       0=no time pressure, 1=urgent/time-sensitive' if property_modes.get('Urgency') == 'binary' else '• Urgency:       1=do whenever, 10=due within hours or immediately'}
{'• Importance:    0=low importance, 1=high importance' if property_modes.get('Importance') == 'binary' else '• Importance:    1=nice-to-have, 10=critical long-term outcome'}

Remember: Return ONLY the JSON object. Start with {{ and end with }}. No trailing commas."""


async def _score_task(name: str, context: str) -> Dict[str, Any]:
    property_modes = _get_property_modes()
    raw = await _call_openrouter(_build_score_prompt(name, context, property_modes), max_tokens=800, temperature=0.15)

    def clamp(v: Any, default: int = 5) -> int:
        try:
            return max(1, min(10, int(v)))
        except (TypeError, ValueError):
            return default

    def clamp_minutes(v: Any) -> int:
        try:
            minutes = int(v)
            if minutes <= 0:
                return 30  # default 30 minutes
            # Round to nearest preset
            return min(TIME_PRESETS, key=lambda x: abs(x - minutes))
        except (TypeError, ValueError):
            return 30  # default 30 minutes

    # Clean the JSON response
    cleaned = _clean_json_fence(raw)
    
    # Try to parse, if fails, attempt to extract partial data
    try:
        metrics = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        # Attempt to fix truncated JSON
        fixed_json = _attempt_fix_truncated_json(cleaned)
        if fixed_json:
            try:
                metrics = json.loads(fixed_json)
                print(f"Successfully recovered truncated JSON for task: {name}")
            except json.JSONDecodeError:
                raise HTTPException(status_code=502, detail=f"AI returned unparseable JSON: {raw!r}") from exc
        else:
            # Fallback to default values
            print(f"Using default values for task: {name} (AI returned invalid JSON)")
            metrics = {
                "Priority": 5,
                "Hierarchy": 5,
                "Difficulty": 5,
                "Relevance": 5,
                "Urgency": 5,
                "Importance": 5,
                "Time_Minutes": 30
            }

    result = {}
    
    # Process each property based on its mode
    for prop in ["Priority", "Hierarchy", "Difficulty", "Relevance", "Urgency", "Importance"]:
        mode = property_modes.get(prop, "scale")
        if mode == "binary":
            # Convert 0/1 to 1/10 for internal consistency
            value = metrics.get(prop, 0)
            result[prop] = 10 if value == 1 or value == True else 1
        else:
            result[prop] = clamp(metrics.get(prop))
    
    # Time is always in minutes
    result["Time_Minutes"] = clamp_minutes(metrics.get("Time_Minutes"))
    
    return result

# ─────────────────────────────────────────────────────────────────────────────
#  Model Configuration Helpers
# ─────────────────────────────────────────────────────────────────────────────

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

# ─────────────────────────────────────────────────────────────────────────────
#  Routes — Config
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/config/properties")
def get_property_modes() -> Dict:
    """Get current property scoring modes"""
    config = load_config()
    return {
        "property_modes": config.get("property_modes", DEFAULT_PROPERTY_MODES),
        "available_modes": ["scale", "binary"],
        "time_presets": TIME_PRESETS
    }

@app.post("/config/properties")
def set_property_modes(config: PropertyModeConfig) -> Dict:
    """Set property scoring modes (scale or binary)"""
    valid_props = set(DEFAULT_PROPERTY_MODES.keys())
    
    for prop, mode in config.property_modes.items():
        if prop not in valid_props:
            raise HTTPException(status_code=400, detail=f"Invalid property: {prop}")
        if mode not in ["scale", "binary"]:
            raise HTTPException(status_code=400, detail=f"Invalid mode for {prop}: {mode}")
        if prop == "Time_Minutes":
            raise HTTPException(status_code=400, detail="Time_Minutes must always be scale mode")
    
    app_config = load_config()
    app_config["property_modes"] = config.property_modes
    save_config(app_config)
    
    return {"message": "Property modes updated", "property_modes": app_config["property_modes"]}

@app.get("/config/model")
def get_model() -> Dict:
    """Get the current model being used"""
    return {"model": load_model_config()}

@app.post("/config/model")
def set_model(config: ModelConfig) -> Dict:
    """Set the model to use for AI scoring"""
    save_model_config(config.model)
    return {"message": "Model updated", "model": config.model}

# ─────────────────────────────────────────────────────────────────────────────
#  Routes — tasks
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/tasks")
async def get_tasks() -> List[Dict]:
    """Return active tasks, waking any postponed tasks due today first."""
    tasks = load_tasks()
    tasks = _migrate_time_estimate_to_minutes(tasks)
    tasks = await _reactivate_due_postponed(tasks)
    save_tasks(tasks)
    return [t for t in tasks if t.get("Status") == "Active"]

@app.get("/tasks/all")
def get_all_tasks() -> List[Dict]:
    tasks = load_tasks()
    return _migrate_time_estimate_to_minutes(tasks)

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
    tasks = _migrate_time_estimate_to_minutes(tasks)
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
    all_tasks = _migrate_time_estimate_to_minutes(all_tasks)
    all_tasks.extend(new_tasks)
    save_tasks(all_tasks)
    return new_tasks

@app.post("/tasks/reevaluate-all")
async def reevaluate_all() -> List[Dict]:
    all_tasks = load_tasks()
    all_tasks = _migrate_time_estimate_to_minutes(all_tasks)
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
    """Mathematical sorting using weighted formula"""
    if not request.tasks:
        return {"sorted_ids": [], "method": "mathematical"}

    def sort_key(t: Dict) -> tuple:
        time_normalized = _normalize_time_for_sorting(t.get("Time_Minutes", 30))
        return (
            -(t.get("Urgency", 5) * t.get("Importance", 5)),
            -t.get("Hierarchy", 5),
            -t.get("Priority", 5),
            time_normalized,  # Lower time = higher priority in tiebreaker
            -t.get("Relevance", 5),
        )

    sorted_tasks = sorted(request.tasks, key=sort_key)
    return {
        "sorted_ids": [t["Task_ID"] for t in sorted_tasks],
        "method": "mathematical"
    }

@app.post("/tasks/ai-plan")
async def ai_action_plan(request: SortRequest) -> Dict:
    """
    Use AI to create an optimal action plan.
    Returns both sorted_ids and a human-readable plan.
    """
    if not request.tasks:
        return {"sorted_ids": [], "plan_text": "", "method": "ai"}

    # Build task summary for the AI
    tasks_summary = []
    for i, task in enumerate(request.tasks, 1):
        tasks_summary.append(
            f"{i}. [{task['Task_ID']}] {task['Name']}\n"
            f"   Context: {task.get('Context', 'None')}\n"
            f"   Priority: {task.get('Priority', 5)}/10 | "
            f"Hierarchy: {task.get('Hierarchy', 5)}/10 | "
            f"Time: {task.get('Time_Minutes', 30)}min | "
            f"Difficulty: {task.get('Difficulty', 5)}/10\n"
            f"   Relevance: {task.get('Relevance', 5)}/10 | "
            f"Urgency: {task.get('Urgency', 5)}/10 | "
            f"Importance: {task.get('Importance', 5)}/10"
        )

    prompt = f"""You are an expert task management and productivity AI. 
Given the following list of tasks with their properties, create an optimal action plan.

Consider:
- High urgency × importance tasks should come first
- Dependencies (high hierarchy tasks might block others)
- Time estimates (do quick wins first if they unblock bigger tasks)
- Difficulty (sometimes doing a hard task first when fresh is better)
- Batch similar tasks together if it makes sense

TASKS:
{chr(10).join(tasks_summary)}

Return ONLY a valid JSON object — no explanation, no markdown fences:
{{
  "sorted_task_ids": ["task_id_1", "task_id_2", ...],
  "plan_text": "Your detailed action plan explanation here...",
  "reasoning": "Brief explanation of your sorting strategy"
}}

The sorted_task_ids must be in the exact order you recommend.
The plan_text should be 2-4 paragraphs explaining the optimal approach.
Be specific - mention task names and why you ordered them that way."""

    try:
        raw = await _call_openrouter(prompt, max_tokens=1000, temperature=0.3)
        plan = json.loads(_clean_json_fence(raw))
        
        if not isinstance(plan, dict) or "sorted_task_ids" not in plan:
            raise ValueError("Invalid plan structure")
        
        # Validate all task IDs are present
        task_ids = {t["Task_ID"] for t in request.tasks}
        sorted_ids = [tid for tid in plan["sorted_task_ids"] if tid in task_ids]
        
        # Add any missing IDs at the end
        missing = task_ids - set(sorted_ids)
        sorted_ids.extend(missing)
        
        return {
            "sorted_ids": sorted_ids,
            "plan_text": plan.get("plan_text", ""),
            "reasoning": plan.get("reasoning", ""),
            "method": "ai"
        }
        
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(
            status_code=502, 
            detail=f"AI returned unparseable plan: {raw!r}"
        ) from exc

@app.put("/tasks/{task_id}")
def update_task(task_id: str, update: TaskUpdate) -> Dict:
    tasks = load_tasks()
    tasks = _migrate_time_estimate_to_minutes(tasks)
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
    all_tasks = _migrate_time_estimate_to_minutes(all_tasks)
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
Estimated Time: {task.get("Time_Minutes", "Unknown")} minutes
Already defined subtasks:
{existing_str}

Return exactly this structure:
["subtask one", "subtask two", "subtask three"]

Rules:
- Each subtask must be a short, specific action (under 10 words)
- Do not repeat existing subtasks
- Order from first to last step logically
- Consider the time estimate when suggesting number and scope of subtasks"""

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
    return {
        "status": "ok",
        "tasks_file": TASKS_FILE,
        "model": load_model_config(),
        "property_modes": load_config().get("property_modes", DEFAULT_PROPERTY_MODES)
    }

@app.get("/debug/file")
def debug_file():
    """Debug file loading"""
    import os
    tasks_file = TASKS_FILE
    exists = os.path.exists(tasks_file)
    content = None
    if exists:
        with open(tasks_file, 'r', encoding='utf-8') as f:
            content = f.read()
    return {
        "tasks_file_path": tasks_file,
        "file_exists": exists,
        "file_content_preview": content[:500] if content else None,
        "current_working_directory": os.getcwd()
    }