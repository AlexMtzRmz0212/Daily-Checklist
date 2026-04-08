@echo off

:: Terminal 1: Backend
start "Backend" cmd /k ".venv\Scripts\activate && uvicorn main:app --reload --port 8000"

:: Terminal 2: Frontend
start "Frontend" cmd /k ".venv\Scripts\activate && cd task-sorter && npm run dev"

:: Wait 5 seconds for servers to initialize
timeout /t 2 /nobreak > NUL

:: Open Chrome to the frontend URL (adjust port if npm run dev uses a different one)
start chrome "http://localhost:5173"