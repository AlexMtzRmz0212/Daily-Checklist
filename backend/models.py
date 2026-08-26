from sqlalchemy import Boolean, Column, ForeignKey, Integer, String, Float, DateTime, JSON
from sqlalchemy.orm import relationship
from .database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    encrypted_openrouter_key = Column(String, nullable=True)
    settings = Column(JSON, default=dict)

    tasks = relationship("Task", back_populates="owner")

class Task(Base):
    __tablename__ = "tasks"

    Task_ID = Column(String, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("users.id"))
    Name = Column(String, index=True)
    Context = Column(String, default="")
    Status = Column(String, default="Active")
    Notion_Status = Column(String, nullable=True)  # Raw Notion "Status" property value, before collapsing into Status
    Priority = Column(Integer, default=5)
    Hierarchy = Column(Integer, default=5)
    Time_Minutes = Column(Integer, default=30)
    Difficulty = Column(Integer, default=5)
    Relevance = Column(Integer, default=5)
    Urgency = Column(Integer, default=5)
    Importance = Column(Integer, default=5)
    Focus = Column(Integer, default=1)  # binary: 1 = No (low edge), 10 = Yes
    Postponed_Until = Column(String, nullable=True)
    Postpone_Reason = Column(String, nullable=True)
    Subtasks = Column(JSON, default=list) # Store subtasks as JSON; each: {id, name, done, notion_id?}
    Parent_ID = Column(String, nullable=True, index=True)       # Local parent task (self-reference by Task_ID)
    Notion_Page_ID = Column(String, nullable=True, index=True)  # Maps this task to a Notion page for two-way sync
    Node_Type = Column(String, default="task")                  # "task" (last parent / leaf task) | "category"

    owner = relationship("User", back_populates="tasks")