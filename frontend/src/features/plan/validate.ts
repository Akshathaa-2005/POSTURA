import type { PlanProfile } from "./types";

const RANGES = {
  metric: { height: [90, 250], weight: [25, 350] },
  imperial: { height: [35, 98], weight: [55, 770] },
} as const;

/** Client-side form checks (the server re-validates). Returns field → message. */
export function validateProfile(p: PlanProfile): Record<string, string> {
  const e: Record<string, string> = {};
  const units = p.units ?? "metric";
  for (const f of ["goal", "level", "sex"] as const) if (!p[f]) e[f] = "Required";
  if (p.age == null || !Number.isInteger(p.age) || p.age < 5 || p.age > 110) e.age = "Enter your age in years";
  else if (p.age < 18) e.age = "Plans are only available for adults (18+)";
  for (const f of ["height", "weight"] as const) {
    const [lo, hi] = RANGES[units][f];
    if (p[f] == null || Number.isNaN(p[f])) e[f] = "Required";
    else if (p[f]! < lo || p[f]! > hi) e[f] = `Expected ${lo}-${hi} ${f === "height" ? (units === "metric" ? "cm" : "in") : units === "metric" ? "kg" : "lb"}`;
  }
  if (!p.days_per_week || p.days_per_week < 1 || p.days_per_week > 7) e.days_per_week = "Choose 1-7 days";
  if (p.pregnant) e.pregnant = "Please get advice from your doctor or midwife instead";
  return e;
}

export function splitList(s: string): string[] {
  return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}
