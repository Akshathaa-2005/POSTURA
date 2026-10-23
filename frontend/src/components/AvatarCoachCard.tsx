import { useState } from "react";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import type { Exercise } from "@/types";
import { getAvatarCommandForFault } from "@/utils/avatarCorrections";
import AvatarCoach3D from "./AvatarCoach3D";

interface Props {
  exercise: Exercise;
}

export default function AvatarCoachCard({ exercise }: Props) {
  const issue = useWorkoutState((s) => s.issue);
  const coachAvatarCmd = useWorkoutState((s) => s.coach.avatarCommand);
  const coachVoice = useWorkoutState((s) => s.coach.voice);
  const tracking = useWorkoutState((s) => s.status === "running" && s.inFrame);

  // Active command: prefer backend LLM command, fall back to canonical rule
  const activeCommand =
    coachAvatarCmd || (issue ? getAvatarCommandForFault(issue.id, issue.side, exercise.id) : null);

  return (
    <section className="card overflow-hidden p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="eyebrow">3D Avatar Coach</h2>
          <p className="mt-0.5 text-xs text-stone">
            {activeCommand
              ? `Correcting: ${issue?.label || activeCommand.primary_fault}`
              : tracking
                ? "Observing alignment"
                : "Interactive 3D reference"}
          </p>
        </div>
        {activeCommand && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-warn/15 px-2.5 py-0.5 text-[11px] font-medium text-warn">
            <span className="h-1.5 w-1.5 rounded-full bg-warn animate-pulse" />
            Active cue
          </span>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl">
        <AvatarCoach3D
          command={activeCommand}
          exerciseId={exercise.id}
          defaultView={exercise.view === "side" ? "side" : "perspective"}
          className="h-64 w-full"
        />
      </div>

      {activeCommand && (
        <div className="mt-3 rounded-xl bg-sand/40 p-3 text-xs">
          <p className="font-display italic text-slate">
            “{activeCommand.verbal_cue || coachVoice?.text || issue?.message}”
          </p>
          {activeCommand.highlight_joints.length > 0 && (
            <p className="mt-1 text-[11px] text-stone">
              Target joints: {activeCommand.highlight_joints.join(", ")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
