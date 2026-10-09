import Link from "next/link";
import type { Exercise } from "@/types";
import PoseFigure from "./PoseFigure";

// Tile tones cycle through the palette; figure colour chosen for contrast.
const TONES = [
  { bg: "bg-mist", figure: "#4A4F5C" },
  { bg: "bg-sand", figure: "#4A4F5C" },
  { bg: "bg-slate", figure: "#E0E4E8" },
  { bg: "bg-dusty", figure: "#3B3F49" },
  { bg: "bg-taupe", figure: "#FBFAF8" },
  { bg: "bg-[#E9E4DA]", figure: "#4A4F5C" },
];

export default function ExerciseSelector({ exercises }: { exercises: Exercise[] }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
      {exercises.map((ex, i) => {
        const tone = TONES[i % TONES.length];
        const dark = tone.bg === "bg-slate" || tone.bg === "bg-taupe";
        return (
          <div key={ex.id} className="animate-fade-up" style={{ animationDelay: `${200 + i * 70}ms` }}>
            <Link href={`/workout/${ex.id}`} className="card group block overflow-hidden transition duration-300 hover:-translate-y-1">
              <div className={`relative aspect-[4/3] ${tone.bg}`}>
                <span className={`eyebrow absolute left-5 top-5 ${dark ? "text-linen/80" : ""}`}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className={`eyebrow absolute right-5 top-5 ${dark ? "text-linen/80" : ""}`}>{ex.difficulty}</span>
                <PoseFigure
                  exerciseId={ex.id}
                  color={tone.figure}
                  delay={i * 0.3}
                  className="absolute inset-x-0 bottom-3 mx-auto h-[78%] transition duration-500 group-hover:scale-105"
                />
              </div>
              <div className="p-6">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-display text-[1.7rem] font-medium leading-tight">{ex.name}</h3>
                  <span className="text-stone transition group-hover:translate-x-1 group-hover:text-ink">→</span>
                </div>
                <p className="mt-2 text-sm font-light leading-relaxed text-stone">{ex.description}</p>
                <div className="mt-5 flex items-center gap-3 whitespace-nowrap border-t border-slate/10 pt-4">
                  <span className="eyebrow text-ink">{ex.rep_target} reps</span>
                  <span className="h-1 w-1 rounded-full bg-taupe" />
                  <span className="eyebrow">{ex.category}</span>
                  <span className="h-1 w-1 rounded-full bg-taupe" />
                  <span className="eyebrow">{/sideways/i.test(ex.camera_setup) ? "Side view" : "Front view"}</span>
                </div>
              </div>
            </Link>
          </div>
        );
      })}
    </div>
  );
}
