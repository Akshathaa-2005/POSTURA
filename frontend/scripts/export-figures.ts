// Writes the reference keyframes to exercises/figure_poses.json for the pose-guide generator (backend).
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIGURE_POSES } from "../src/utils/figurePoses";

const out = resolve(__dirname, "../../exercises/figure_poses.json");
writeFileSync(out, JSON.stringify(FIGURE_POSES, null, 1) + "\n");
console.log(`Wrote ${Object.keys(FIGURE_POSES).length} exercises to ${out}`);
