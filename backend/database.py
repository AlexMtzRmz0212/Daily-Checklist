import os
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker
from dotenv import load_dotenv

load_dotenv()

# On Vercel the project filesystem is read-only; only /tmp is writable.
# Locally (or on a VPS) we keep the file next to the backend package.
# For production with real persistence, DATABASE_URL is set to the Neon PostgreSQL URL.
_on_vercel = bool(os.getenv("VERCEL"))
_default_db = (
    "sqlite:////tmp/tasks.db"           # Vercel: writable temp dir
    if _on_vercel
    else "sqlite:///./backend/tasks.db"  # Local dev: project folder
)

SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", _default_db)

# If the URL starts with "postgres://", SQLAlchemy 1.4+ requires "postgresql://"
if SQLALCHEMY_DATABASE_URL.startswith("postgres://"):
    SQLALCHEMY_DATABASE_URL = SQLALCHEMY_DATABASE_URL.replace(
        "postgres://", "postgresql://", 1
    )

# SQLite needs connect_args={"check_same_thread": False}, PostgreSQL doesn't
connect_args = {}
if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args=connect_args
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_columns() -> None:
    """
    Lightweight, dependency-free migration.

    `Base.metadata.create_all` creates missing tables but never adds columns to an
    existing table. When the schema gains a column (e.g. Parent_ID, Notion_Page_ID),
    older databases won't have it. This inspects the live `tasks` table and issues a
    plain `ALTER TABLE ... ADD COLUMN` for anything missing. `ADD COLUMN` is supported
    by both SQLite and PostgreSQL, which is all this app targets.
    """
    expected = {
        "Parent_ID": "VARCHAR",
        "Notion_Page_ID": "VARCHAR",
        "Node_Type": "VARCHAR",
        "Focus": "INTEGER",
    }
    inspector = inspect(engine)
    if "tasks" not in inspector.get_table_names():
        return  # create_all will build it fresh with all columns

    existing = {col["name"] for col in inspector.get_columns("tasks")}
    missing = {name: ddl for name, ddl in expected.items() if name not in existing}
    if not missing:
        return

    with engine.begin() as conn:
        for name, ddl in missing.items():
            conn.execute(text(f'ALTER TABLE tasks ADD COLUMN "{name}" {ddl}'))
        # Backfill Node_Type so existing rows keep appearing in task views
        # (the added column is NULL for pre-existing rows).
        if "Node_Type" in missing:
            conn.execute(text('UPDATE tasks SET "Node_Type" = \'task\' WHERE "Node_Type" IS NULL'))
        # Backfill Focus to the low edge (1 = No) for pre-existing rows.
        if "Focus" in missing:
            conn.execute(text('UPDATE tasks SET "Focus" = 1 WHERE "Focus" IS NULL'))
