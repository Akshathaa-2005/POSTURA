import type { JointStatus } from "@/types";

export const STATUS_COLORS: Record<JointStatus, string> = {
  good: "#5F829A",
  warn: "#B98B4E",
  bad: "#B35A4B",
};

export const STATUS_LABEL: Record<JointStatus, string> = {
  good: "Aligned",
  warn: "Minor correction",
  bad: "Needs attention",
};

export function scoreStatus(score: number | null): JointStatus {
  if (score === null || score >= 85) return "good";
  return score >= 65 ? "warn" : "bad";
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
