// Single source of truth for the API origin, shared by App.jsx and the public landing
// page. Kept in its own module so Landing doesn't have to import from App (which imports
// Landing back).
export const API = import.meta.env.DEV ? "http://localhost:8000" : "/api";
