import { useWorkoutState } from "@/hooks/useWorkoutState";
import type { Exercise } from "@/types";
import { formatDuration, formatPercent } from "@/utils/formatters";
import AICoachOverlay from "./AICoachOverlay";
import AvatarCoachCard from "./AvatarCoachCard";
import CurrentIssueCard from "./CurrentIssueCard";
import FormModelCard from "./FormModelCard";
import FormScoreMeter from "./FormScoreMeter";
import RecordPanel from "./RecordPanel";
import RepCounter from "./RepCounter";

export default function DashboardPanel({
  exercise,
  mirrored,
  record = false,
  showAvatar = true,
  layoutMode = "stack",
}: {
  exercise: Exercise;
  mirrored: boolean;
  record?: boolean;
  showAvatar?: boolean;
  layoutMode?: "stack" | "grid";
}) {
  const activeMs = useWorkoutState((s) => s.activeMs);
  const averageScore = useWorkoutState((s) => s.averageScore);
  const fps = useWorkoutState((s) => s.fps);

  if (layoutMode === "grid") {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 items-start">
        {/* Column 1: Performance & Rep Counts */}
        <div className="flex flex-col gap-4">
          <RepCounter exercise={exercise} />
          <FormScoreMeter />
          <section className="grid grid-cols-3 divide-x divide-slate/10 overflow-hidden rounded-[22px] bg-sand/60">
            <Metric label="Time" value={formatDuration(activeMs / 1000)} />
            <Metric label="Avg form" value={formatPercent(averageScore)} />
            <Metric label="FPS" value={fps ? Math.round(fps).toString() : "—"} />
          </section>
        </div>

        {/* Column 2: Live Guidance & Verbal Coaching */}
        <div className="flex flex-col gap-4">
          <CurrentIssueCard exercise={exercise} mirrored={mirrored} />
          <AICoachOverlay />
          <FormModelCard exercise={exercise} />
        </div>

        {/* Column 3: Coaching Points & Recording */}
        <div className="flex flex-col gap-4">
          {record && <RecordPanel exercise={exercise} />}
          <section className="card p-6">
            <h2 className="eyebrow">Form criteria</h2>
            <ol className="mt-4 space-y-3">
              {exercise.correction_tips.map((tip, i) => (
                <li key={tip} className="flex gap-4 text-sm font-light leading-relaxed text-ink">
                  <span className="font-display text-lg leading-5 text-taupe">{String(i + 1).padStart(2, "0")}</span>
                  {tip}
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    );
  }

  return (
    <aside className="flex flex-col gap-4 lg:sticky lg:top-6">
      {record && <RecordPanel exercise={exercise} />}
      <FormScoreMeter />
      <RepCounter exercise={exercise} />
      <CurrentIssueCard exercise={exercise} mirrored={mirrored} />
      {showAvatar && <AvatarCoachCard exercise={exercise} />}
      <FormModelCard exercise={exercise} />
      <AICoachOverlay />

      <section className="grid grid-cols-3 divide-x divide-slate/10 overflow-hidden rounded-[22px] bg-sand/60">
        <Metric label="Time" value={formatDuration(activeMs / 1000)} />
        <Metric label="Avg form" value={formatPercent(averageScore)} />
        <Metric label="FPS" value={fps ? Math.round(fps).toString() : "—"} />
      </section>

      <section className="card p-6">
        <h2 className="eyebrow">Coaching notes</h2>
        <ol className="mt-4 space-y-3">
          {exercise.correction_tips.map((tip, i) => (
            <li key={tip} className="flex gap-4 text-sm font-light leading-relaxed text-ink">
              <span className="font-display text-lg leading-5 text-taupe">{String(i + 1).padStart(2, "0")}</span>
              {tip}
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-4 text-center">
      <p className="font-display text-3xl font-medium tabular-nums text-slate">{value}</p>
      <p className="eyebrow mt-1 !text-[10px]">{label}</p>
    </div>
  );
}
