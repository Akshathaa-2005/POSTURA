import { backendUrl, getUserId } from "@/utils/api";
import type { GenerateResponse, PlanProfile, PlanSummary, StoredPlan } from "./types";

export class PlanApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(backendUrl(path), { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    throw new PlanApiError("Can't reach the Postura server. Is the backend running?", 0, "network");
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = body.detail;
    const msg = typeof d === "string" ? d : Array.isArray(d) ? d.map((x: { msg: string }) => x.msg).join("; ") : "Something went wrong";
    throw new PlanApiError(msg, res.status, body.code);
  }
  return body as T;
}

const base = () => `/api/users/${getUserId()}/plans`;

export const generatePlan = (req: { profile?: PlanProfile; free_text?: string; adjustment?: string }) =>
  call<GenerateResponse>(`${base()}/generate`, { method: "POST", body: JSON.stringify(req) });
export const listPlans = () => call<PlanSummary[]>(base());
export const getPlan = (id: string) => call<StoredPlan>(`${base()}/${id}`);
export const deletePlan = (id: string) => call<void>(`${base()}/${id}`, { method: "DELETE" });
export const exportUrl = (id: string, fmt: "json" | "md") => backendUrl(`${base()}/${id}/export?fmt=${fmt}`);
