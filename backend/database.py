import os
from sqlalchemy import create_engine
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
