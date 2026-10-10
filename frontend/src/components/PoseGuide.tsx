import { useEffect, useState } from "react";
import PoseFigure from "./PoseFigure";

/** Pre-generated guide photos (backend/scripts/generate_pose_guides.py → public/guides). */
type Frame = "start" | "peak" | "hold";
interface GuideImage {
  src: string;
  width: number;
  height: number;
}
type Manifest = Record<string, Partial<Record<Frame, GuideImage>>>;

const LABEL: Record<Frame, string> = { start: "Start", peak: "Finish", hold: "Hold" };
const ORDER: Frame[] = ["start", "peak", "hold"];

let manifestPromise: Promise<Manifest> | null = null;
const loadManifest = () =>
  (manifestPromise ??= fetch("/guides/manifest.json")
    .then((r): Promise<Manifest> | Manifest => (r.ok ? r.json() : {}))
    .catch((): Manifest => ({})));

function useGuide(exerciseId: string) {
  const [guide, setGuide] = useState<Manifest[string] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadManifest().then((m) => live && setGuide(m[exerciseId] ?? null));
    return () => {
      live = false;
    };
  }, [exerciseId]);
  return guide; // undefined while loading, null when there is no guide
}

function Photo({ img, label, className }: { img: GuideImage; label: string; className?: string }) {
  return (
    <figure className={className}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={img.src}
        width={img.width}
        height={img.height}
        alt={`${label} position, with the body's joints marked`}
        loading="lazy"
        decoding="async"
        className="h-full w-full rounded-[12px] bg-cream object-cover"
      />
      <figcaption className="eyebrow mt-1.5 text-center !text-[10px]">{label}</figcaption>
    </figure>
  );
}

/** Every keyframe of the movement side by side (start → finish, or the hold). */
export function PoseGuideFrames({ exerciseId, className }: { exerciseId: string; className?: string }) {
  const guide = useGuide(exerciseId);
  const frames = guide ? ORDER.filter((f) => guide[f]) : [];
  if (guide === undefined) return <div className={className} />;
  if (!frames.length) {
    return (
      <div className={`aspect-[3/4] rounded-[14px] bg-mist ${className ?? ""}`}>
        <PoseFigure exerciseId={exerciseId} className="h-full w-full p-4" />
      </div>
    );
  }
  return (
    <div className={`grid gap-2 ${frames.length > 1 ? "grid-cols-2" : "grid-cols-1"} ${className ?? ""}`}>
      {frames.map((f) => (
        <Photo key={f} img={guide![f]!} label={LABEL[f]} />
      ))}
    </div>
  );
}

/** The position to aim for (the end of the movement, or the hold), for comparing against your own pose. */
export function PoseGuideTarget({ exerciseId, className }: { exerciseId: string; className?: string }) {
  const guide = useGuide(exerciseId);
  const img = guide?.peak ?? guide?.hold;
  if (!img) return <PoseFigure exerciseId={exerciseId} color="#5F829A" className={className} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={img.src} alt="Correct form, with the body's joints marked" className={`rounded-[10px] object-cover ${className ?? ""}`} />
  );
}
