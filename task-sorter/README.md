# AI Task Sorter - Frontend

This is the React frontend for the AI Task Sorter application, bootstrapped with Vite.

## Architecture

- **Framework**: React + Vite
- **Styling**: Tailwind CSS
- **Animations**: Framer Motion
- **Icons**: Lucide React

## Conventions

### API Communication

All API calls from the frontend should utilize the `fetchApi` wrapper located in `src/utils/api.js`. 

This wrapper standardizes API communication across the app by:
- Automatically attaching the JWT Authorization token (`Bearer`) from local storage.
- Intercepting HTTP errors (status >= 400).
- Safely handling empty API responses (e.g., HTTP 204 No Content).
- Automatically handling unauthorized errors (HTTP 401) by clearing the local session and reloading the app.
- Safely parsing the JSON response only when it's guaranteed to be valid, avoiding generic "Unexpected token 'T' in JSON at position X" errors.

**Example Usage**:

```javascript
import { fetchApi } from "./utils/api";

// GET request
const tasks = await fetchApi("/tasks");

// POST request with body
const result = await fetchApi("/tasks/evaluate", {
  method: "POST",
  body: JSON.stringify({ name: "New task" })
});
```

## Running Locally

To run the frontend development server:

```bash
npm install
npm run dev
```

The app will be available at [http://localhost:5173](http://localhost:5173).
