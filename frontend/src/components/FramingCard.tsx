import { useMemo } from "react";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import type { Exercise } from "@/types";
import { missingParts, PART_LABEL, requiredParts } from "@/utils/framing";

/** Shown over the video until the camera sees everything the exercise needs. Says what is missing and why. */
export default function FramingCard({ exercise }: { exercise: Exercise }) {
  const personVisible = useWorkoutState((s) => s.personVisible);
  const inFrame = useWorkoutState((s) => s.inFrame);
  const visibility = useWorkoutState((s) => s.visibility);
  const parts = useMemo(() => requiredParts(exercise), [exercise]);
  const missing = useMemo(() => missingParts(visibility, parts), [visibility, parts]);

  if (personVisible && inFrame && missing.length === 0) return null;

  let title = "Get into frame";
  let message = "Step into the camera view so we can see you.";
  if (personVisible && missing.length > 0) {
    title = "Almost there";
    message = `We can't see your ${missing.map((p) => PART_LABEL[p].toLowerCase()).join(" or ")} yet. Step back or adjust the camera.`;
  } else if (personVisible) {
    title = "Get into position";
    message = `${exercise.camera_setup}.`;
  }

  return (
    <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-0 top-4 flex justify-center px-4">
      <div className="max-w-md rounded-2xl bg-linen/95 px-5 py-3 text-ink shadow-soft backdrop-blur">
        <p className="eyebrow !text-[10px]">{title}</p>
        <p className="mt-1 text-sm">{message}</p>
        {parts.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Body parts in view">
            {parts.map((p) => {
              const seen = !missing.includes(p);
              return (
                <li
                  key={p}
                  className={`rounded-full px-2.5 py-0.5 text-xs ${seen ? "bg-done/15 text-done" : "bg-warn/15 text-warn"}`}
                >
                  {seen ? "✓" : "✕"} {PART_LABEL[p]}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
