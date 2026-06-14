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
from fastapi                    import Body, Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors    import CORSMiddleware
from fastapi.security           import OAuth2PasswordRequestForm
from pydantic                   import BaseModel, Field
from dotenv                     import load_dotenv
from sqlalchemy.orm             import Session

from . import models, database, auth
from .database import engine, get_db

load_dotenv()

# Create tables
models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="AI Task Sorter", version="1.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────────────────────────────────────
#region Constants

BACKEND_DIR = Path(__file__).parent
PROJECT_ROOT = BACKEND_DIR.parent

MODEL_CONFIG_FILE: str = str(BACKEND_DIR / "model_config.json")
CONFIG_FILE: str = str(BACKEND_DIR / "app_config.json")

OPENROUTER_URL: str = "https://openrouter.ai/api/v1/chat/completions"
GLOBAL_OPENROUTER_API_KEY: str = os.getenv("OPENROUTER_API_KEY") # Optional fallback
MODEL: str = os.getenv("MODEL", "anthropic/claude-3.5-sonnet")
SITE_URL: str = "http://localhost:5173"
SITE_NAME: str = "AI Task Sorter"

DEFAULT_PROPERTY_MODES: Dict[str, str] = {
    "Priority":    "binary",
    "Hierarchy":   "binary",
    "Time_Minutes": "scale",
    "Difficulty":  "binary",
    "Relevance":   "binary",
    "Urgency":     "binary",
    "Importance":  "binary",
}

DEFAULT_PROPERTY_ORDER: List[str] = [ 
    "Urgency", 
    "Importance", 
    "Relevance",
    "Difficulty", 
    "Priority", 
    "Hierarchy", 
    "Time_Minutes"
]

TIME_PRESETS = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 480, 960, 1440]

#endregion

# ─────────────────────────────────────────────────────────────────────────────
#region Pydantic Schemas

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
    Subtasks: Optional[List[Dict[str, Any]]] = None

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

class PropertyOrderConfig(BaseModel):
    property_order: List[str]

class UserCreate(BaseModel):
    username: str
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str

class ApiKeyUpdate(BaseModel):
    api_key: str

#endregion

# ─────────────────────────────────────────────────────────────────────────────
#region User Settings Helpers

def get_user_settings(user: models.User) -> Dict:
    settings = user.settings or {}
    config = settings.copy()
    if "property_modes" not in config:
        config["property_modes"] = DEFAULT_PROPERTY_MODES.copy()
    else:
        for prop, mode in DEFAULT_PROPERTY_MODES.items():
            if prop not in config["property_modes"]:
                config["property_modes"][prop] = mode
    
    if "property_order" not in config:
        config["property_order"] = DEFAULT_PROPERTY_ORDER.copy()
    else:
        existing = set(config["property_order"])
        for prop in DEFAULT_PROPERTY_ORDER:
            if prop not in existing:
                config["property_order"].append(prop)
    
    if "model" not in config:
        config["model"] = MODEL
        
    return config

#endregion

# ─────────────────────────────────────────────────────────────────────────────
#region OpenRouter helpers

def _get_api_key_for_user(user: models.User) -> str:
    if user and user.encrypted_openrouter_key:
        decrypted = auth.decrypt_api_key(user.encrypted_openrouter_key)
        if decrypted:
            return decrypted
    if GLOBAL_OPENROUTER_API_KEY:
        return GLOBAL_OPENROUTER_API_KEY
    raise HTTPException(status_code=400, detail="No OpenRouter API key found. Please set one in Settings.")

def _or_headers(api_key: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
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
    opener, closer = None, None
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if opener is None:
            if ch == '{':
                opener, closer = '{', '}'
            elif ch == '[':
                opener, closer = '[', ']'
            else:
                continue
            start = i
            depth = 1
        else:
            if ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    return text[start:i + 1]
    return text

def _attempt_fix_truncated_json(text: str) -> Optional[str]:
    text = text.strip()
    text += '}' * max(0, text.count('{') - text.count('}'))
    text += ']' * max(0, text.count('[') - text.count(']'))
    text = re.sub(r',\s*\}', '}', text)
    text = re.sub(r',\s*\]', ']', text)
    try:
        json.loads(text)
        return text
    except json.JSONDecodeError:
        pass
    BINARY_FIELDS = {"Priority", "Hierarchy", "Difficulty", "Relevance", "Urgency", "Importance"}
    ALL_FIELDS    = BINARY_FIELDS | {"Time_Minutes"}
    reconstructed: Dict[str, int] = {}
    for key, value in re.findall(r'"([^"]+)"\s*:\s*([0-9]+(?:\.[0-9]*)?)', text):
        if key in ALL_FIELDS:
            reconstructed[key] = int(float(value))
    for key, value in re.findall(r'"([^"]+)"\s*:\s*(true|false)\b', text, re.IGNORECASE):
        if key in BINARY_FIELDS and key not in reconstructed:
            reconstructed[key] = 1 if value.lower() == "true" else 0
    for key, value in re.findall(r'"([^"]+)"\s*:\s*"(yes|no|high|low|true|false)"', text, re.IGNORECASE):
        if key in BINARY_FIELDS and key not in reconstructed:
            reconstructed[key] = 1 if value.lower() in ("yes", "high", "true") else 0
    if not reconstructed:
        return None
    for field in BINARY_FIELDS:
        reconstructed.setdefault(field, 0)
    reconstructed.setdefault("Time_Minutes", 30)
    return json.dumps(reconstructed)

async def _call_openrouter(prompt: str, user: models.User, max_tokens: int = 1000, temperature: float = 0.2) -> str:
    api_key = _get_api_key_for_user(user)
    user_settings = get_user_settings(user)
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            OPENROUTER_URL,
            headers=_or_headers(api_key),
            json={
                "model": user_settings.get("model", MODEL),
                "messages": [{"role": "user", "content": prompt}],
                "temperature": temperature,
                "max_tokens": max_tokens,
            },
        )
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail=f"OpenRouter returned {response.status_code}: {response.text}")
    return response.json()["choices"][0]["message"]["content"]

def _build_score_prompt(name: str, context: str, property_modes: Dict[str, str]) -> str:
    score_fields = []
    for prop in ["Priority", "Hierarchy", "Difficulty", "Relevance", "Urgency", "Importance"]:
        if property_modes.get(prop) == "binary":
            score_fields.append(f'  "{prop}": <0 or 1>  // 0=No, 1=Yes')
        else:
            score_fields.append(f'  "{prop}": <1-10>')
    score_fields.append('  "Time_Minutes": <estimated minutes as integer>')

    return f"""You are a ruthlessly precise task management AI.
Evaluate the task below and output ONLY a valid JSON object — no explanation, no markdown fences.

IMPORTANT: Return COMPLETE, valid JSON. Do not truncate.

Task Name    : {name}
Task Context : {context or "No context provided"}

Return exactly this structure (no extra text before or after):
{{
{chr(10).join(score_fields)}
}}

Scoring rubric:
{'• Priority:    0=not a priority, 1=is a priority' if property_modes.get('Priority') == 'binary' else '• Priority:    1=trivial, 10=mission-critical'}
{'• Hierarchy:   0=no dependencies, 1=blocks other work' if property_modes.get('Hierarchy') == 'binary' else '• Hierarchy:   1=standalone, 10=many tasks depend on this'}
• Time_Minutes: Estimate real time in minutes. Use one of: 5,10,15,30,45,60,90,120,180,240,480,960,1440
{'• Difficulty:  0=easy/straightforward, 1=challenging/complex' if property_modes.get('Difficulty') == 'binary' else '• Difficulty:  1=trivial, 10=requires deep expertise'}
{'• Relevance:   0=not relevant to goals, 1=directly relevant' if property_modes.get('Relevance') == 'binary' else '• Relevance:   1=tangential, 10=core to primary goals'}
{'• Urgency:     0=no time pressure, 1=urgent/time-sensitive' if property_modes.get('Urgency') == 'binary' else '• Urgency:     1=do whenever, 10=due within hours'}
{'• Importance:  0=low importance, 1=high importance' if property_modes.get('Importance') == 'binary' else '• Importance:  1=nice-to-have, 10=critical long-term outcome'}

Return ONLY the JSON object. Start with {{ and end with }}. No trailing commas."""

async def _score_task(name: str, context: str, user: models.User) -> Dict[str, Any]:
    config = get_user_settings(user)
    property_modes = config.get("property_modes", DEFAULT_PROPERTY_MODES.copy())

    _DEFAULTS: Dict[str, Any] = {
        "Priority": 10, "Hierarchy": 10, "Difficulty": 10,
        "Relevance": 10, "Urgency": 10, "Importance": 10,
        "Time_Minutes": 60,
    }

    def clamp(v: Any, default: int = 5) -> int:
        try:
            return max(1, min(10, int(v)))
        except (TypeError, ValueError):
            return default

    def clamp_minutes(v: Any) -> int:
        try:
            minutes = int(v)
            if minutes <= 0:
                return 30
            return min(TIME_PRESETS, key=lambda x: abs(x - minutes))
        except (TypeError, ValueError):
            return 30

    metrics = _DEFAULTS.copy()
    try:
        raw = await _call_openrouter(_build_score_prompt(name, context, property_modes), user, max_tokens=300, temperature=0.15)
        cleaned = _clean_json_fence(raw)
        try:
            metrics = json.loads(cleaned)
        except json.JSONDecodeError:
            fixed_json = _attempt_fix_truncated_json(cleaned)
            if fixed_json:
                try:
                    metrics = json.loads(fixed_json)
                except json.JSONDecodeError:
                    metrics = _DEFAULTS.copy()
            else:
                metrics = _DEFAULTS.copy()
    except Exception as exc:
        print(f"AI scoring failed for '{name}' ({type(exc).__name__}: {exc}) — using defaults.")

    result = {}
    for prop in ["Priority", "Hierarchy", "Difficulty", "Relevance", "Urgency", "Importance"]:
        mode = property_modes.get(prop, "binary")
        if mode == "binary":
            value = metrics.get(prop, 0)
            result[prop] = 10 if int(value) >= 1 else 1
        else:
            result[prop] = clamp(metrics.get(prop))

    result["Time_Minutes"] = clamp_minutes(metrics.get("Time_Minutes"))
    return result

def _normalize_time_for_sorting(time_minutes: int) -> float:
    if time_minutes <= 0:
        return 0.1
    return max(1, 10 - (time_minutes / 160))

def _task_to_dict(task: models.Task) -> Dict:
    return {
        "Task_ID": task.Task_ID,
        "Name": task.Name,
        "Context": task.Context,
        "Status": task.Status,
        "Priority": task.Priority,
        "Hierarchy": task.Hierarchy,
        "Time_Minutes": task.Time_Minutes,
        "Difficulty": task.Difficulty,
        "Relevance": task.Relevance,
        "Urgency": task.Urgency,
        "Importance": task.Importance,
        "Postponed_Until": task.Postponed_Until,
        "Postpone_Reason": task.Postpone_Reason,
        "Subtasks": task.Subtasks or []
    }

async def _reactivate_due_postponed(tasks: List[models.Task], user: models.User, db: Session) -> List[Dict]:
    today = date.today().isoformat()
    due = [t for t in tasks if t.Status == "Postponed" and (t.Postponed_Until or "9999-99-99") <= today]
    if not due:
        return [_task_to_dict(t) for t in tasks]

    async def wake(task: models.Task):
        reason = task.Postpone_Reason or ""
        base_context = task.Context or ""
        new_context = base_context
        if reason:
            new_context = f"{base_context} [Postponed: {reason}]".strip()
        metrics = await _score_task(task.Name, new_context, user)
        task.Context = new_context
        task.Status = "Active"
        task.Postponed_Until = None
        task.Postpone_Reason = None
        for key, value in metrics.items():
            setattr(task, key, value)
        return task

    await asyncio.gather(*[wake(t) for t in due])
    db.commit()
    return [_task_to_dict(t) for t in tasks]

#endregion

# ─────────────────────────────────────────────────────────────────────────────
#region Auth Routes

@app.post("/register", response_model=Token)
def register(user: UserCreate, db: Session = Depends(get_db)):
    db_user = db.query(models.User).filter(models.User.username == user.username).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Username already registered")
    
    hashed_password = auth.get_password_hash(user.password)
    new_user = models.User(
        id=str(uuid.uuid4()),
        username=user.username,
        hashed_password=hashed_password
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    access_token = auth.create_access_token(data={"sub": new_user.username})
    return {"access_token": access_token, "token_type": "bearer"}

@app.post("/login", response_model=Token)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.username == form_data.username).first()
    if not user or not auth.verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token = auth.create_access_token(data={"sub": user.username})
    return {"access_token": access_token, "token_type": "bearer"}

@app.get("/users/me")
def read_users_me(current_user: models.User = Depends(auth.get_current_user)):
    return {
        "username": current_user.username,
        "has_api_key": bool(current_user.encrypted_openrouter_key)
    }

@app.post("/users/me/api-key")
def update_api_key(key_data: ApiKeyUpdate, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    encrypted_key = auth.encrypt_api_key(key_data.api_key)
    current_user.encrypted_openrouter_key = encrypted_key
    db.commit()
    return {"message": "API key updated successfully"}

#endregion

# ─────────────────────────────────────────────────────────────────────────────
#region Config Routes

@app.get("/config/properties")
def get_property_modes(current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    config = get_user_settings(current_user)
    return {
        "property_modes": config.get("property_modes", DEFAULT_PROPERTY_MODES),
        "available_modes": ["binary", "scale"],
        "time_presets": TIME_PRESETS,
    }

@app.post("/config/properties")
def set_property_modes(config: PropertyModeConfig, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    valid_props = set(DEFAULT_PROPERTY_MODES.keys())
    for prop, mode in config.property_modes.items():
        if prop not in valid_props:
            raise HTTPException(status_code=400, detail=f"Invalid property: {prop}")
        if mode not in ["scale", "binary"]:
            raise HTTPException(status_code=400, detail=f"Invalid mode for {prop}: {mode}")
        if prop == "Time_Minutes" and mode != "scale":
            raise HTTPException(status_code=400, detail="Time_Minutes must always be scale mode")
    
    app_config = get_user_settings(current_user)
    app_config["property_modes"] = config.property_modes
    current_user.settings = app_config
    db.commit()
    return {"message": "Property modes updated", "property_modes": app_config["property_modes"]}

@app.get("/config/property-order")
def get_property_order(current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    config = get_user_settings(current_user)
    return {"property_order": config.get("property_order", DEFAULT_PROPERTY_ORDER)}

@app.post("/config/property-order")
def set_property_order(config: PropertyOrderConfig, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    valid_props = set(DEFAULT_PROPERTY_MODES.keys())
    ordered = config.property_order
    if set(ordered) != valid_props:
        raise HTTPException(
            status_code=400, 
            detail=f"Property order must contain exactly: {sorted(valid_props)}"
        )
    
    app_config = get_user_settings(current_user)
    app_config["property_order"] = ordered
    current_user.settings = app_config
    db.commit()
    return {"message": "Property order updated", "property_order": ordered}

@app.get("/config/model")
def get_model(current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    config = get_user_settings(current_user)
    return {"model": config.get("model", MODEL)}

@app.post("/config/model")
def set_model(config: ModelConfig, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    app_config = get_user_settings(current_user)
    app_config["model"] = config.model
    current_user.settings = app_config
    db.commit()
    return {"message": "Model updated", "model": config.model}

#endregion

# ─────────────────────────────────────────────────────────────────────────────
#region Tasks Routes

@app.get("/tasks")
async def get_tasks(db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> List[Dict]:
    tasks = db.query(models.Task).filter(models.Task.user_id == current_user.id).all()
    updated_tasks = await _reactivate_due_postponed(tasks, current_user, db)
    return [t for t in updated_tasks if t.get("Status") == "Active"]

@app.post("/tasks/evaluate")
async def evaluate_task(task: TaskCreate, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    metrics = await _score_task(task.Name, task.Context, current_user)
    new_task = models.Task(
        Task_ID=str(uuid.uuid4()),
        user_id=current_user.id,
        Name=task.Name,
        Context=task.Context or "",
        Status="Active",
        Subtasks=[],
        **metrics
    )
    db.add(new_task)
    db.commit()
    db.refresh(new_task)
    return _task_to_dict(new_task)

@app.post("/tasks/evaluate-bulk")
async def evaluate_bulk(payload: TaskBulkCreate, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> List[Dict]:
    async def score_one(item: TaskBulkItem) -> models.Task:
        metrics = await _score_task(item.Name, item.Context, current_user)
        return models.Task(
            Task_ID=str(uuid.uuid4()),
            user_id=current_user.id,
            Name=item.Name,
            Context=item.Context or "",
            Status="Active",
            Subtasks=[],
            **metrics
        )
    
    new_tasks = list(await asyncio.gather(*[score_one(item) for item in payload.tasks]))
    for task in new_tasks:
        db.add(task)
    db.commit()
    
    for task in new_tasks:
        db.refresh(task)
    
    return [_task_to_dict(t) for t in new_tasks]

@app.post("/tasks/reevaluate-all")
async def reevaluate_all(db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> List[Dict]:
    active_tasks = db.query(models.Task).filter(models.Task.user_id == current_user.id, models.Task.Status == "Active").all()
    if not active_tasks:
        return []
    
    async def rescore(task: models.Task):
        metrics = await _score_task(task.Name, task.Context or "", current_user)
        for k, v in metrics.items():
            setattr(task, k, v)
        return task

    await asyncio.gather(*[rescore(t) for t in active_tasks])
    db.commit()
    
    return [_task_to_dict(t) for t in active_tasks]

@app.post("/tasks/sort")
async def sort_tasks(request: SortRequest) -> Dict:
    if not request.tasks:
        return {"sorted_ids": [], "method": "mathematical"}

    def sort_key(t: Dict) -> tuple:
        time_normalized = _normalize_time_for_sorting(t.get("Time_Minutes", 30))
        return (
            -(t.get("Urgency", 1) * t.get("Importance", 1)),
            -t.get("Hierarchy", 1),
            -t.get("Priority", 1),
            time_normalized,
            -t.get("Relevance", 1),
        )

    sorted_tasks = sorted(request.tasks, key=sort_key)
    return {"sorted_ids": [t["Task_ID"] for t in sorted_tasks], "method": "mathematical"}

@app.post("/tasks/ai-plan")
async def ai_action_plan(request: SortRequest, current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    if not request.tasks:
        return {"sorted_ids": [], "plan_text": "No tasks to plan.", "reasoning": "", "method": "ai"}

    full_ids = [t["Task_ID"] for t in request.tasks]
    tasks_summary = []
    for i, task in enumerate(request.tasks, 1):
        u_label = "YES" if task.get("Urgency", 1)    == 10 else "NO"
        i_label = "YES" if task.get("Importance", 1) == 10 else "NO"
        h_label = "YES" if task.get("Hierarchy", 1)  == 10 else "NO"
        tasks_summary.append(
            f'{i}. ID:"{task["Task_ID"]}" | {task["Name"]}'
            f" | Urgent:{u_label} Important:{i_label} Blocking:{h_label}"
            f" | Priority:{task.get('Priority',1)} Time:{task.get('Time_Minutes',30)}min"
        )

    prompt = f"""Output ONLY a JSON object — no explanation, no markdown.

Organize the tasks below into a strict chronological sequence with specific time blocks for today. If the total duration exceeds 8 hours (480 minutes), automatically move the lower-priority tasks into a future schedule array.

Tasks:
{chr(10).join(tasks_summary)}

Respond with exactly this JSON and nothing else:
{{
  "sorted_task_ids": ["<array of IDs scheduled for today>"],
  "future_task_ids": ["<array of IDs pushed to tomorrow>"],
  "plan_text": "<Detailed chronological schedule string with time blocks for today's tasks>",
  "reasoning": "<1 sentence explaining why tasks were sequenced this way and what was deferred>"
}}
"""

    raw = ""
    try:
        raw = await _call_openrouter(prompt, current_user, max_tokens=1200, temperature=0.1)
        cleaned = _clean_json_fence(raw)
        plan = json.loads(cleaned)

        if not isinstance(plan, dict) or "sorted_task_ids" not in plan:
            raise ValueError("Missing sorted_task_ids")

        task_ids   = set(full_ids)
        sorted_ids = [tid for tid in plan["sorted_task_ids"] if tid in task_ids]
        
        future_ids = plan.get("future_task_ids", [])
        if not isinstance(future_ids, list):
            future_ids = []
            
        future_task_ids = [tid for tid in future_ids if tid in task_ids and tid not in sorted_ids]
        
        seen = set(sorted_ids) | set(future_task_ids)
        sorted_ids.extend(tid for tid in full_ids if tid not in seen)

        return {
            "sorted_ids": sorted_ids,
            "future_task_ids": future_task_ids,
            "plan_text":  plan.get("plan_text", ""),
            "reasoning":  plan.get("reasoning", ""),
            "method":     "ai",
        }

    except (json.JSONDecodeError, ValueError):
        print(f"AI plan parse failed — falling back to math sort. Raw: {raw!r}")
        def sort_key(t: Dict) -> tuple:
            return (
                -(t.get("Urgency", 1) * t.get("Importance", 1)),
                -t.get("Hierarchy", 1),
                -t.get("Priority", 1),
                _normalize_time_for_sorting(t.get("Time_Minutes", 30)),
                -t.get("Relevance", 1),
            )
        sorted_tasks = sorted(request.tasks, key=sort_key)
        return {
            "sorted_ids": [t["Task_ID"] for t in sorted_tasks],
            "future_task_ids": [],
            "plan_text":  "Sorted automatically by urgency, importance, and priority.",
            "reasoning":  "AI plan could not be parsed; mathematical sort applied.",
            "method":     "math_fallback",
        }

@app.put("/tasks/{task_id}")
def update_task(task_id: str, update: TaskUpdate, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    task = db.query(models.Task).filter(models.Task.Task_ID == task_id, models.Task.user_id == current_user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")
    
    update_data = update.model_dump(exclude_none=True)
    for k, v in update_data.items():
        setattr(task, k, v)
    db.commit()
    db.refresh(task)
    return _task_to_dict(task)

@app.patch("/tasks/{task_id}/complete")
def complete_task(task_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    task = db.query(models.Task).filter(models.Task.Task_ID == task_id, models.Task.user_id == current_user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")
    
    task.Status = "Completed"
    db.commit()
    return {"message": "Task completed", "Task_ID": task_id}

@app.patch("/tasks/{task_id}/postpone")
def postpone_task(task_id: str, body: PostponeRequest, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    task = db.query(models.Task).filter(models.Task.Task_ID == task_id, models.Task.user_id == current_user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")
    
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    task.Status = "Postponed"
    task.Postponed_Until = tomorrow
    task.Postpone_Reason = body.reason.strip()
    db.commit()
    return {"message": "Task postponed", "Task_ID": task_id, "until": tomorrow}

@app.post("/tasks/bulk-update")
def bulk_update(updated_tasks: List[Dict[str, Any]] = Body(...), db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    updated_count = 0
    for updated in updated_tasks:
        tid = updated.get("Task_ID")
        if tid:
            task = db.query(models.Task).filter(models.Task.Task_ID == tid, models.Task.user_id == current_user.id).first()
            if task:
                for k, v in updated.items():
                    if hasattr(task, k) and k != "Task_ID" and k != "user_id":
                        setattr(task, k, v)
                updated_count += 1
    db.commit()
    return {"message": f"Bulk-updated {updated_count} task(s)"}

@app.delete("/tasks/{task_id}")
def delete_task(task_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    task = db.query(models.Task).filter(models.Task.Task_ID == task_id, models.Task.user_id == current_user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")
    
    db.delete(task)
    db.commit()
    return {"message": "Task deleted", "Task_ID": task_id}

#endregion

# ─────────────────────────────────────────────────────────────────────────────
#region Subtasks Routes

@app.post("/tasks/{task_id}/subtasks/suggest")
async def suggest_subtasks(task_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    task = db.query(models.Task).filter(models.Task.Task_ID == task_id, models.Task.user_id == current_user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")

    existing = [s["name"] for s in (task.Subtasks or [])]
    existing_str = "\n".join(f"- {s}" for s in existing) if existing else "None yet."

    prompt = f"""You are a precise project planning AI.
Given the task below, suggest 3 to 6 concrete, actionable subtasks.
Output ONLY a valid JSON array of strings — no explanation, no markdown fences.

Task Name    : {task.Name}
Task Context : {task.Context or "No context provided"}
Estimated Time: {task.Time_Minutes} minutes
Existing subtasks:
{existing_str}

Return exactly this structure:
["subtask one", "subtask two", "subtask three"]

Rules:
- Each subtask must be a short, specific action (under 10 words)
- Do not repeat existing subtasks
- Order logically from first to last step"""

    raw = await _call_openrouter(prompt, current_user, max_tokens=400, temperature=0.3)
    try:
        suggestions = json.loads(_clean_json_fence(raw))
        if not isinstance(suggestions, list):
            raise ValueError("Not a list")
        suggestions = [str(s).strip() for s in suggestions if str(s).strip()]
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"AI returned unparseable suggestions: {raw!r}") from exc
    return {"suggestions": suggestions}

@app.post("/tasks/{task_id}/subtasks")
def add_subtask(task_id: str, body: SubtaskAdd, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    task = db.query(models.Task).filter(models.Task.Task_ID == task_id, models.Task.user_id == current_user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")
    
    subtask = {"id": str(uuid.uuid4()), "name": body.name.strip(), "done": False}
    subs = list(task.Subtasks or [])
    subs.append(subtask)
    # Reassign to trigger JSON update
    task.Subtasks = subs
    db.commit()
    return subtask

@app.patch("/tasks/{task_id}/subtasks/{subtask_id}")
def toggle_subtask(task_id: str, subtask_id: str, body: SubtaskToggle, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    task = db.query(models.Task).filter(models.Task.Task_ID == task_id, models.Task.user_id == current_user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")
    
    subs = list(task.Subtasks or [])
    updated = None
    for i, s in enumerate(subs):
        if s["id"] == subtask_id:
            subs[i]["done"] = body.done
            updated = subs[i]
            break
    if not updated:
        raise HTTPException(status_code=404, detail=f"Subtask {subtask_id!r} not found")
        
    task.Subtasks = subs
    db.commit()
    return updated

@app.delete("/tasks/{task_id}/subtasks/{subtask_id}")
def delete_subtask(task_id: str, subtask_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    task = db.query(models.Task).filter(models.Task.Task_ID == task_id, models.Task.user_id == current_user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")
    
    subs = list(task.Subtasks or [])
    before = len(subs)
    subs = [s for s in subs if s["id"] != subtask_id]
    if len(subs) == before:
        raise HTTPException(status_code=404, detail=f"Subtask {subtask_id!r} not found")
        
    task.Subtasks = subs
    db.commit()
    return {"message": "Subtask deleted"}

#endregion

@app.get("/health")
def health() -> Dict:
    return {
        "status": "ok",
        "model": MODEL,
    }
