export const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000").replace(/\/$/, "");
export const WS_URL = (process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000/ws").replace(/\/$/, "");

export function backendUrl(path: string): string {
  return `${BACKEND_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Anonymous per-browser id until authentication arrives in Phase 4. */
export function getUserId(): string {
  const KEY = "aicoach.userId";
  try {
    let id = window.localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID().replace(/-/g, "");
      window.localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "anonymous";
  }
}
