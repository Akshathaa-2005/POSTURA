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

export interface SessionSummary {
  session_id: string;
  text: string;
  source: "llm" | "template";
}

/** The LLM's debrief of a finished session, grounded in its reps, score and coached faults. */
export async function fetchSessionSummary(sessionId: string): Promise<SessionSummary> {
  const res = await fetch(backendUrl(`/api/sessions/${sessionId}/summary`));
  if (!res.ok) throw new Error(`Summary unavailable (${res.status})`);
  return res.json();
}
