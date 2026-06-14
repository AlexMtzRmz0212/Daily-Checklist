/**
 * A generic fetch wrapper that handles HTTP errors and safely parses JSON.
 * Use this across the React frontend instead of the native `fetch`.
 */
export async function fetchApi(url, options = {}) {
  const response = await fetch(url, options);

  // 1. Implement the check of the response BEFORE parsing JSON
  if (!response.ok) {
    // Safely grab the error text (avoids the unexpected token 'T' JSON parsing error)
    const errorText = await response.text();
    throw new Error(`API Error (${response.status}): ${errorText}`);
  }

  // 2. Handle empty responses (like 204 No Content) safely
  if (response.status === 204) {
    return null;
  }

  // 3. It is now safe to parse JSON
  return await response.json();
}
