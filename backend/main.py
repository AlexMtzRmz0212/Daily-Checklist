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
from fastapi.responses          import StreamingResponse
from fastapi.security           import OAuth2PasswordRequestForm
from pydantic                   import BaseModel, Field
from dotenv                     import load_dotenv
from sqlalchemy.orm             import Session

from . import models, database, auth, notion
from .database import engine, get_db

load_dotenv()

# Create tables, then patch in any columns added to existing databases.
models.Base.metadata.create_all(bind=engine)
database.ensure_columns()

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
# Cap concurrent OpenRouter requests so bulk (re)evaluation doesn't trip rate limits.
OPENROUTER_MAX_CONCURRENCY: int = int(os.getenv("OPENROUTER_MAX_CONCURRENCY", "5"))
_openrouter_semaphore = asyncio.Semaphore(OPENROUTER_MAX_CONCURRENCY)

# Priority & Hierarchy are managed in the Matrix tab: always scale, 1 = highest.
# They are intentionally kept out of DEFAULT_PROPERTY_ORDER (the reorderable display list).
MATRIX_PROPS: set = {"Priority", "Hierarchy"}

DEFAULT_PROPERTY_MODES: Dict[str, str] = {
    "Priority":    "scale",
    "Hierarchy":   "scale",
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
    "Time_Minutes",
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
    Priority: Optional[int] = Field(None, ge=1)          # matrix row (priority level); grows unbounded
    Hierarchy: Optional[int] = Field(None, ge=1, le=10)  # matrix column; fixed to reach 10
    Time_Minutes: Optional[int] = Field(None, ge=1)
    Difficulty: Optional[int] = Field(None, ge=1, le=10)
    Relevance: Optional[int] = Field(None, ge=1, le=10)
    Urgency: Optional[int] = Field(None, ge=1, le=10)
    Importance: Optional[int] = Field(None, ge=1, le=10)
    Status: Optional[str] = None
    Subtasks: Optional[List[Dict[str, Any]]] = None
    Parent_ID: Optional[str] = None

class SortRequest(BaseModel):
    tasks: List[Dict[str, Any]]

class ReevaluateRequest(BaseModel):
    task_ids: List[str]

class ParentUpdate(BaseModel):
    parent_id: Optional[str] = None                      # None ⇒ detach (becomes a root)

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

class NotionConfig(BaseModel):
    token: Optional[str] = None                          # omit/blank to keep existing token
    database_id: str = ""
    property_map: Optional[Dict[str, str]] = None        # override Notion column names

class NotionImportRequest(BaseModel):
    score_new: bool = False                              # AI-score newly imported tasks (off by default; no OpenRouter usage)

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
    # Matrix props are always scale — coerce any legacy 'binary' setting.
    for prop in MATRIX_PROPS:
        config["property_modes"][prop] = "scale"

    if "property_order" not in config:
        config["property_order"] = DEFAULT_PROPERTY_ORDER.copy()
    else:
        # Drop matrix props from a legacy stored order, then append any new display props.
        config["property_order"] = [p for p in config["property_order"] if p not in MATRIX_PROPS]
        existing = set(config["property_order"])
        for prop in DEFAULT_PROPERTY_ORDER:
            if prop not in existing:
                config["property_order"].append(prop)
    
    if "model" not in config:
        config["model"] = MODEL

    return config

# Optional global Notion fallback (mirrors GLOBAL_OPENROUTER_API_KEY).
GLOBAL_NOTION_TOKEN: str = os.getenv("NOTION_TOKEN", "")
NOTION_VERSION: str = os.getenv("NOTION_VERSION", notion.DEFAULT_VERSION)

def get_notion_config(user: models.User) -> Dict[str, Any]:
    """
    Read the user's stored Notion settings and return a resolved config.
    The decrypted token is never sent to the client — only `connected` is exposed.
    """
    raw = (user.settings or {}).get("notion", {}) if user.settings else {}
    token = auth.decrypt_api_key(raw.get("encrypted_token")) or GLOBAL_NOTION_TOKEN
    return {
        "token": token,
        "database_id": raw.get("database_id", ""),
        "property_map": {**notion.DEFAULT_PROP_MAP, **(raw.get("property_map") or {})},
        "version": raw.get("version", NOTION_VERSION),
        # Titles of the special archive root parents (case-insensitive match).
        "done_titles": raw.get("done_titles") or ["done"],
        "forget_titles": raw.get("forget_titles") or ["forget", "forgotten"],
        "connected": bool(token and raw.get("database_id")),
    }

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
    # Priority/Hierarchy are scale-only (1=highest); the rest may be binary yes/no.
    BINARY_FIELDS = {"Difficulty", "Relevance", "Urgency", "Importance"}
    SCALE_FIELDS  = {"Priority", "Hierarchy"}
    ALL_FIELDS    = BINARY_FIELDS | SCALE_FIELDS | {"Time_Minutes"}
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
    for field in SCALE_FIELDS:
        reconstructed.setdefault(field, 5)
    reconstructed.setdefault("Time_Minutes", 30)
    return json.dumps(reconstructed)

async def _call_openrouter(prompt: str, user: models.User, max_tokens: int = 1000, temperature: float = 0.2, max_retries: int = 3) -> str:
    api_key = _get_api_key_for_user(user)
    user_settings = get_user_settings(user)
    payload = {
        "model": user_settings.get("model", MODEL),
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    last_error = ""
    for attempt in range(max_retries):
        async with _openrouter_semaphore:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(OPENROUTER_URL, headers=_or_headers(api_key), json=payload)

        # OpenRouter sometimes returns transient errors (rate limits, upstream
        # provider hiccups) either as a non-200 status or as HTTP 200 with an
        # {"error": ...} body and no "choices". Retry both with backoff.
        try:
            data = response.json()
        except ValueError:
            data = None

        if response.status_code == 200 and isinstance(data, dict) and data.get("choices"):
            return data["choices"][0]["message"]["content"]

        # Pull the most useful error message we can find.
        if isinstance(data, dict) and data.get("error"):
            err = data["error"]
            last_error = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        else:
            last_error = response.text

        retryable = response.status_code in (429, 500, 502, 503, 504) or (
            response.status_code == 200 and isinstance(data, dict) and bool(data.get("error"))
        )
        if retryable and attempt < max_retries - 1:
            await asyncio.sleep(0.5 * (2 ** attempt))
            continue
        break

    raise HTTPException(status_code=502, detail=f"OpenRouter request failed: {last_error}")

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
• Priority:    1=highest priority (do first), 10=lowest priority
• Hierarchy:   1=highest (top-level goal / blocks the most work), 10=lowest (leaf / depends on others)
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
        "Priority": 5, "Hierarchy": 5, "Difficulty": 10,
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

    # A real transport / credit / model failure (the HTTPException raised by
    # _call_openrouter) must propagate so the caller can surface it — never fall
    # through to defaults, which would masquerade as a successful evaluation.
    raw = await _call_openrouter(_build_score_prompt(name, context, property_modes), user, max_tokens=300, temperature=0.15)

    # Parse problems, by contrast, are recoverable: try to repair, else use defaults.
    metrics = _DEFAULTS.copy()
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

async def _score_tasks_bulk(tasks: List[Any], user: models.User) -> List[Dict[str, Any]]:
    return await asyncio.gather(
        *[_score_task(t.Name, t.Context, user) for t in tasks]
    )

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
        "Subtasks": task.Subtasks or [],
        "Parent_ID": task.Parent_ID,
        "Notion_Page_ID": task.Notion_Page_ID,
        "Node_Type": task.Node_Type or "task",
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

    access_token = auth.create_access_token(
        data={"sub": new_user.username},
        expires_delta=timedelta(minutes=auth.ACCESS_TOKEN_EXPIRE_MINUTES),
    )
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
    access_token = auth.create_access_token(
        data={"sub": user.username},
        expires_delta=timedelta(minutes=auth.ACCESS_TOKEN_EXPIRE_MINUTES),
    )
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
        if prop in MATRIX_PROPS and mode != "scale":
            raise HTTPException(status_code=400, detail=f"{prop} is managed in the Matrix tab and must be scale mode")
    
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
    valid_props = set(DEFAULT_PROPERTY_MODES.keys()) - MATRIX_PROPS
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

@app.get("/config/notion")
def get_notion_settings(current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    cfg = get_notion_config(current_user)
    return {
        "connected": cfg["connected"],
        "database_id": cfg["database_id"],
        "property_map": cfg["property_map"],
        "default_property_map": notion.DEFAULT_PROP_MAP,
    }

@app.post("/config/notion")
def set_notion_settings(config: NotionConfig, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    settings = dict(current_user.settings or {})
    existing = dict(settings.get("notion", {}))

    # Only replace the stored token when a new non-blank one is provided.
    if config.token and config.token.strip():
        existing["encrypted_token"] = auth.encrypt_api_key(config.token.strip())
    existing["database_id"] = config.database_id.strip()
    if config.property_map is not None:
        existing["property_map"] = config.property_map

    settings["notion"] = existing
    current_user.settings = settings
    db.commit()

    cfg = get_notion_config(current_user)
    return {"message": "Notion settings saved", "connected": cfg["connected"]}

#endregion

# ─────────────────────────────────────────────────────────────────────────────
#region Notion Sync Routes

def _clamp_1_10(value: Any) -> Optional[int]:
    """Coerce a Notion number into the app's 1–10 integer scale (None stays None)."""
    if value is None:
        return None
    try:
        return max(1, min(10, int(round(float(value)))))
    except (TypeError, ValueError):
        return None

def _notion_status_to_app(status: str) -> str:
    """Fallback status mapping from the Notion '1. Status' select value."""
    s = status.strip().lower()
    if s in ("done", "complete", "completed"):
        return "Completed"
    if s in ("forget", "forgotten", "ignore", "drop"):
        return "Forgotten"
    return "Active"

def _derive_status(archive: Optional[str], notion_status: str) -> str:
    """Root-ancestor archive wins ('Done'/'Forget' roots); else fall back to '1. Status'."""
    if archive == "done":
        return "Completed"
    if archive == "forget":
        return "Forgotten"
    return _notion_status_to_app(notion_status)

def _upsert_subtask(parent_task: models.Task, notion_id: str, name: str, done: bool) -> None:
    """Fold a Notion leaf into the parent task's Subtasks, matching by notion_id."""
    subs = list(parent_task.Subtasks or [])
    for s in subs:
        if s.get("notion_id") == notion_id:
            s["name"] = name
            s["done"] = done
            parent_task.Subtasks = subs   # reassign so SQLAlchemy detects the JSON change
            return
    subs.append({"id": str(uuid.uuid4()), "name": name, "done": done, "notion_id": notion_id})
    parent_task.Subtasks = subs

def _prune_notion_subtasks(task: models.Task, present_notion_ids: set) -> None:
    """Drop Notion-sourced subtasks that no longer exist in Notion; keep local ones."""
    subs = task.Subtasks or []
    kept = [s for s in subs if not s.get("notion_id") or s.get("notion_id") in present_notion_ids]
    if len(kept) != len(subs):
        task.Subtasks = kept

# Titles Notion couldn't resolve arrive as one of these (Notion's "Untitled" for an
# inaccessible page mention, or our own empty-title fallback).
_UNRESOLVED_TITLES = {"", "untitled", "(untitled)"}


def _is_unresolved_title(text: Optional[str]) -> bool:
    return (text or "").strip().lower() in _UNRESOLVED_TITLES


async def _resolve_mention_titles(parsed: List[Dict[str, Any]], cfg: Dict[str, Any]) -> None:
    """Clean up @mention titles that Notion returned as "Untitled".

    A Notion title that @mentions another page comes back with plain_text "Untitled"
    unless the integration can read that page. We first try to recover the real title —
    from the other pages fetched in this import (mentions within the same database resolve
    for free), then a best-effort direct fetch of pages referenced from outside it.
    Anything still unresolved has its "Untitled" placeholder stripped, so a mention the
    integration can't read never surfaces as a task name."""
    title_by_id = {pg["notion_id"]: pg["title"] for pg in parsed}

    # Mentioned pages we couldn't resolve locally: best-effort direct fetch (needs access).
    external_ids = {
        seg["page_id"]
        for pg in parsed
        for seg in (pg.get("title_segments") or [])
        if seg.get("is_mention") and seg.get("page_id")
        and _is_unresolved_title(seg.get("text"))
        and seg["page_id"] not in title_by_id
    }
    for pid in external_ids:
        title = await notion.fetch_page_title(cfg["token"], cfg["version"], pid)
        if title and not _is_unresolved_title(title):
            title_by_id[pid] = title

    for pg in parsed:
        segments = pg.get("title_segments") or []
        if not any(seg.get("is_mention") for seg in segments):
            continue
        parts = []
        for seg in segments:
            text = seg.get("text") or ""
            if seg.get("is_mention"):
                pid = seg.get("page_id")
                resolved = title_by_id.get(pid) if pid else None
                if resolved and not _is_unresolved_title(resolved):
                    text = resolved            # recovered the mentioned page's real title
                elif _is_unresolved_title(text):
                    text = ""                  # unreadable mention: drop the "Untitled"
            parts.append(text)
        # Collapse whitespace left by dropped mentions; keep the placeholder if nothing remains.
        pg["title"] = " ".join("".join(parts).split()) or "(Untitled)"


@app.post("/notion/import")
async def notion_import(request: NotionImportRequest, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    cfg = get_notion_config(current_user)
    if not cfg["connected"]:
        raise HTTPException(status_code=400, detail="Notion is not configured. Add a token and database ID in Settings.")

    try:
        pages = await notion.fetch_all_pages(cfg["token"], cfg["version"], cfg["database_id"])
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"Notion API error: {exc.response.status_code} {exc.response.text}")
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach Notion: {exc}")

    parsed = [notion.parse_page(p, cfg["property_map"]) for p in pages]
    # Replace "Untitled" @page-mention titles with the mentioned page's real title.
    await _resolve_mention_titles(parsed, cfg)
    by_notion = {pg["notion_id"]: pg for pg in parsed}

    # Classify every page as category / task / subtask and detect Done/Forget roots.
    classes = notion.classify_tree(parsed, cfg["done_titles"], cfg["forget_titles"])

    # Existing tasks for this user keyed by their Notion page id.
    existing_by_notion = {
        t.Notion_Page_ID: t
        for t in db.query(models.Task).filter(models.Task.user_id == current_user.id).all()
        if t.Notion_Page_ID
    }

    new_tasks: List[models.Task] = []
    notion_to_local: Dict[str, models.Task] = {}   # task & category rows only (leaves fold in)

    # ── Pass 1: upsert task/category rows (leaves are folded in during Pass 3). ──
    for pg in parsed:
        nid = pg["notion_id"]
        role = classes[nid]["role"]
        if role == "subtask":
            continue
        node_type = "category" if role == "category" else "task"
        status = _derive_status(classes[nid]["archive"], pg["status"])
        h = _clamp_1_10(pg["hierarchy"])
        p = _clamp_1_10(pg["priority"])
        task = existing_by_notion.get(nid)
        if task:
            task.Name = pg["title"]
            task.Context = pg["description"] or task.Context or ""
            task.Status = status
            task.Node_Type = node_type
            if h is not None:
                task.Hierarchy = h
            if p is not None:
                task.Priority = p
        else:
            task = models.Task(
                Task_ID=str(uuid.uuid4()),
                user_id=current_user.id,
                Name=pg["title"],
                Context=pg["description"] or "",
                Status=status,
                Node_Type=node_type,
                Subtasks=[],
                Notion_Page_ID=nid,
                Hierarchy=h if h is not None else 5,
                Priority=p if p is not None else 5,
            )
            db.add(task)
            new_tasks.append(task)
        notion_to_local[nid] = task

    # ── Pass 2: parent links among task/category rows (first mapped parent wins). ──
    for nid, task in notion_to_local.items():
        task.Parent_ID = None
        for pid in by_notion[nid]["parent_ids"]:
            parent_task = notion_to_local.get(pid)
            if parent_task is not None and parent_task is not task:
                task.Parent_ID = parent_task.Task_ID
                break

    # ── Pass 3: fold subtask leaves into their parent task's Subtasks. ──
    for pg in parsed:
        nid = pg["notion_id"]
        if classes[nid]["role"] != "subtask":
            continue
        parent_task = next(
            (notion_to_local[pid] for pid in pg["parent_ids"] if pid in notion_to_local),
            None,
        )
        if parent_task is None:
            continue  # defensive: a subtask always has a non-leaf parent
        done = _derive_status(classes[nid]["archive"], pg["status"]) != "Active"
        _upsert_subtask(parent_task, nid, pg["title"], done)

    # Prune Notion-sourced subtasks that vanished from Notion (keep local-only ones).
    present_ids = set(by_notion)
    for task in notion_to_local.values():
        _prune_notion_subtasks(task, present_ids)

    # Remove legacy rows that a previous import created for pages now classified as
    # subtasks (older versions made a Task row for every leaf).
    for nid, ex in existing_by_notion.items():
        if classes.get(nid, {}).get("role") == "subtask":
            db.delete(ex)

    # ── Pass 4: AI-score only brand-new, Active task rows (skip categories/archived). ──
    if request.score_new:
        to_score = [t for t in new_tasks if t.Node_Type == "task" and t.Status == "Active"]
        notion_hp = {
            pg["notion_id"]: (_clamp_1_10(pg["hierarchy"]), _clamp_1_10(pg["priority"]))
            for pg in parsed
        }
        chunk_size = 15
        for i in range(0, len(to_score), chunk_size):
            chunk = to_score[i:i + chunk_size]
            items = [TaskBulkItem(Name=t.Name, Context=t.Context or "") for t in chunk]
            metrics_list = await _score_tasks_bulk(items, current_user)
            for t, metrics in zip(chunk, metrics_list):
                for k, v in metrics.items():
                    setattr(t, k, v)
                nh, np_ = notion_hp.get(t.Notion_Page_ID, (None, None))
                if nh is not None:
                    t.Hierarchy = nh
                if np_ is not None:
                    t.Priority = np_

    db.commit()
    imported = list(notion_to_local.values())
    for t in imported:
        db.refresh(t)

    return {
        "imported": [_task_to_dict(t) for t in imported],
        "created": len(new_tasks),
        "updated": len(imported) - len(new_tasks),
    }

@app.post("/notion/export")
async def notion_export(db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    cfg = get_notion_config(current_user)
    if not cfg["connected"]:
        raise HTTPException(status_code=400, detail="Notion is not configured. Add a token and database ID in Settings.")

    # Push scores only for real tasks — don't overwrite category pages' numbers.
    linked = db.query(models.Task).filter(
        models.Task.user_id == current_user.id,
        models.Task.Notion_Page_ID.isnot(None),
        models.Task.Node_Type == "task",
    ).all()

    pushed, failures = 0, []
    for t in linked:
        try:
            await notion.update_page_properties(
                cfg["token"], cfg["version"], t.Notion_Page_ID,
                cfg["property_map"], t.Hierarchy, t.Priority,
            )
            pushed += 1
        except Exception as exc:
            failures.append({"Task_ID": t.Task_ID, "error": str(exc)})

    return {"pushed": pushed, "failed": len(failures), "failures": failures}

#endregion

# ─────────────────────────────────────────────────────────────────────────────
#region Tasks Routes

@app.get("/tasks/all")
def get_all_tasks(db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> List[Dict]:
    """Every task for the user regardless of status — used by the Tree view so parent
    tasks stay visible even when Completed or Postponed."""
    tasks = db.query(models.Task).filter(models.Task.user_id == current_user.id).all()
    return [_task_to_dict(t) for t in tasks]

@app.get("/tasks")
async def get_tasks(db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> List[Dict]:
    tasks = db.query(models.Task).filter(models.Task.user_id == current_user.id).all()
    updated_tasks = await _reactivate_due_postponed(tasks, current_user, db)
    # Only real tasks (leaves/last-parents), never category/structural nodes.
    return [t for t in updated_tasks if t.get("Status") == "Active" and (t.get("Node_Type") or "task") == "task"]

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
    metrics_list = await _score_tasks_bulk(payload.tasks, current_user)
    
    new_tasks = []
    for item, metrics in zip(payload.tasks, metrics_list):
        task = models.Task(
            Task_ID=str(uuid.uuid4()),
            user_id=current_user.id,
            Name=item.Name,
            Context=item.Context or "",
            Status="Active",
            Subtasks=[],
            **metrics
        )
        new_tasks.append(task)
        db.add(task)
        
    db.commit()
    for task in new_tasks:
        db.refresh(task)
    
    return [_task_to_dict(t) for t in new_tasks]

@app.post("/tasks/reevaluate-all")
async def reevaluate_all(db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> List[Dict]:
    active_tasks = db.query(models.Task).filter(
        models.Task.user_id == current_user.id,
        models.Task.Status == "Active",
        models.Task.Node_Type == "task",
    ).all()
    if not active_tasks:
        return []
    
    chunk_size = 15
    for i in range(0, len(active_tasks), chunk_size):
        chunk = active_tasks[i:i + chunk_size]
        items = [TaskBulkItem(Name=t.Name, Context=t.Context or "") for t in chunk]
        metrics_list = await _score_tasks_bulk(items, current_user)
        for task, metrics in zip(chunk, metrics_list):
            for k, v in metrics.items():
                setattr(task, k, v)
                
    db.commit()
    return [_task_to_dict(t) for t in active_tasks]

@app.post("/tasks/reevaluate-selected")
async def reevaluate_selected(request: ReevaluateRequest, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> List[Dict]:
    if not request.task_ids:
        return []
        
    tasks_to_eval = db.query(models.Task).filter(
        models.Task.user_id == current_user.id,
        models.Task.Task_ID.in_(request.task_ids),
        models.Task.Node_Type == "task",
    ).all()
    if not tasks_to_eval:
        return []
        
    chunk_size = 15
    for i in range(0, len(tasks_to_eval), chunk_size):
        chunk = tasks_to_eval[i:i + chunk_size]
        items = [TaskBulkItem(Name=t.Name, Context=t.Context or "") for t in chunk]
        metrics_list = await _score_tasks_bulk(items, current_user)
        for task, metrics in zip(chunk, metrics_list):
            for k, v in metrics.items():
                setattr(task, k, v)
                
    db.commit()
    return [_task_to_dict(t) for t in tasks_to_eval]

@app.post("/tasks/reevaluate-stream")
async def reevaluate_stream(
    payload: Optional[ReevaluateRequest] = Body(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Re-score tasks, streaming one NDJSON event per task as it finishes so the UI can
    show live per-task progress (and per-task failures) instead of a blind spinner.

    Events: {"type":"start","total":N} · {"type":"task","task_id","name","ok",...} ·
    {"type":"done","ok":X,"failed":Y}."""
    query = db.query(models.Task).filter(
        models.Task.user_id == current_user.id,
        models.Task.Status == "Active",
        models.Task.Node_Type == "task",
    )
    if payload and payload.task_ids:
        query = query.filter(models.Task.Task_ID.in_(payload.task_ids))
    tasks = query.all()

    async def gen():
        yield json.dumps({"type": "start", "total": len(tasks)}) + "\n"
        if not tasks:
            yield json.dumps({"type": "done", "ok": 0, "failed": 0}) + "\n"
            return

        async def score(task: models.Task):
            # _call_openrouter already gates on _openrouter_semaphore, so launching all
            # coroutines at once still respects OPENROUTER_MAX_CONCURRENCY.
            try:
                metrics = await _score_task(task.Name, task.Context or "", current_user)
                return task, metrics, None
            except HTTPException as exc:
                return task, None, str(exc.detail)
            except Exception as exc:  # network/other transport failure
                return task, None, f"{type(exc).__name__}: {exc}"

        ok = failed = 0
        for coro in asyncio.as_completed([score(t) for t in tasks]):
            task, metrics, error = await coro
            if error is None:
                for k, v in metrics.items():
                    setattr(task, k, v)
                ok += 1
                event = {"type": "task", "task_id": task.Task_ID, "name": task.Name,
                         "ok": True, **metrics}
            else:
                failed += 1
                event = {"type": "task", "task_id": task.Task_ID, "name": task.Name,
                         "ok": False, "error": error}
            yield json.dumps(event) + "\n"

        db.commit()
        yield json.dumps({"type": "done", "ok": ok, "failed": failed}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")

@app.post("/tasks/sort")
async def sort_tasks(request: SortRequest) -> Dict:
    if not request.tasks:
        return {"sorted_ids": [], "method": "mathematical"}

    def sort_key(t: Dict) -> tuple:
        time_normalized = _normalize_time_for_sorting(t.get("Time_Minutes", 30))
        return (
            -(t.get("Urgency", 1) * t.get("Importance", 1)),
            t.get("Hierarchy", 10),   # 1 = highest, so ascending
            t.get("Priority", 10),    # 1 = highest, so ascending
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
        tasks_summary.append(
            f'{i}. ID:"{task["Task_ID"]}" | {task["Name"]}'
            f" | Urgent:{u_label} Important:{i_label}"
            f" | Hierarchy:{task.get('Hierarchy',10)} Priority:{task.get('Priority',10)}"
            f" (1=highest) | Time:{task.get('Time_Minutes',30)}min"
        )

    prompt = f"""Output ONLY a JSON object — no explanation, no markdown fences.

Build an optimized step-by-step sequence for the tasks below. DO NOT use specific clock times — assign an estimated DURATION to each activity instead. Group activities into logical phases for maximum efficiency (e.g. room/home chores together, out-of-house errands together, prep/repair together). Keep it brief, direct, and scannable.

If the total estimated duration exceeds 8 hours (480 minutes), move the lower-priority tasks into the future array and leave them out of the plan.

Tasks:
{chr(10).join(tasks_summary)}

Write "plan_text" using EXACTLY this layout (plain text, use \\n for new lines):
Phase 1: <Group Name> (~<total range> mins)
<Activity>: <duration> mins (<short optional tip>).
<Activity>: <duration> mins.

Phase 2: <Group Name> (~<total range> mins)
<Activity>: <duration> mins (<short optional tip>).

Rules for plan_text:
- Number phases sequentially and give each a short logical group name.
- Show an estimated total duration range in each phase header.
- One activity per line, each ending with its duration in mins.
- Tips in parentheses are optional and must be very short (efficiency or sequencing hints only).
- For errands that involve travel, you may add "+ travel" to that phase header.
- No clock times anywhere. No markdown symbols like # or *.

Respond with exactly this JSON and nothing else:
{{
  "sorted_task_ids": ["<array of IDs scheduled for today, in execution order>"],
  "future_task_ids": ["<array of IDs deferred to a future day>"],
  "plan_text": "<phase-grouped, duration-based plan formatted exactly as described above>",
  "reasoning": "<1 short sentence explaining the grouping logic and what was deferred, if anything>"
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
                t.get("Hierarchy", 10),   # 1 = highest, so ascending
                t.get("Priority", 10),    # 1 = highest, so ascending
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

@app.patch("/tasks/{task_id}/parent")
async def reparent_task(task_id: str, body: ParentUpdate, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)) -> Dict:
    """Move a task under a new parent (or detach it). Persists locally and, when the task
    and its new parent are both Notion-linked, syncs the parent relation back to Notion."""
    task = db.query(models.Task).filter(models.Task.Task_ID == task_id, models.Task.user_id == current_user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id!r} not found")

    new_parent_id = body.parent_id
    parent_task = None
    if new_parent_id:
        if new_parent_id == task_id:
            raise HTTPException(status_code=400, detail="A task cannot be its own parent.")
        parent_task = db.query(models.Task).filter(
            models.Task.Task_ID == new_parent_id, models.Task.user_id == current_user.id
        ).first()
        if not parent_task:
            raise HTTPException(status_code=404, detail=f"Parent {new_parent_id!r} not found")

        # Reject cycles: the new parent must not be a descendant of this task.
        all_tasks = db.query(models.Task).filter(models.Task.user_id == current_user.id).all()
        children_of: Dict[str, List[str]] = {}
        for t in all_tasks:
            if t.Parent_ID:
                children_of.setdefault(t.Parent_ID, []).append(t.Task_ID)
        stack, descendants = list(children_of.get(task_id, [])), set()
        while stack:
            cur = stack.pop()
            if cur in descendants:
                continue
            descendants.add(cur)
            stack.extend(children_of.get(cur, []))
        if new_parent_id in descendants:
            raise HTTPException(status_code=400, detail="Cannot move a task under one of its own descendants.")

    task.Parent_ID = new_parent_id
    db.commit()
    db.refresh(task)

    notion_synced = None
    cfg = get_notion_config(current_user)
    if cfg["connected"] and task.Notion_Page_ID and (new_parent_id is None or (parent_task and parent_task.Notion_Page_ID)):
        try:
            await notion.update_page_parent(
                cfg["token"], cfg["version"], task.Notion_Page_ID,
                cfg["property_map"], parent_task.Notion_Page_ID if parent_task else None,
            )
            notion_synced = True
        except Exception as exc:
            notion_synced = False
            print(f"Notion re-parent sync failed for {task_id}: {exc}")

    return {**_task_to_dict(task), "notion_synced": notion_synced}

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

# ─────────────────────────────────────────────────────────────────────────────
# Middleware to gracefully strip the /api prefix from Vercel routing
class VercelAPIMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            path = scope.get("path", "")
            if path.startswith("/api/") or path == "/api":
                scope["path"] = path[4:] or "/"
        await self.app(scope, receive, send)

app = VercelAPIMiddleware(app)
