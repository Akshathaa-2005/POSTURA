export type Goal = "lose_fat" | "build_muscle" | "endurance" | "general_fitness" | "mobility";
export type Level = "beginner" | "intermediate" | "advanced";
export type Equipment = "none" | "dumbbells" | "bands" | "barbell" | "gym";

export interface PlanProfile {
  goal?: Goal;
  level?: Level;
  age?: number;
  sex?: "male" | "female" | "other";
  units?: "metric" | "imperial";
  height?: number;
  weight?: number;
  equipment?: Equipment[];
  days_per_week?: number;
  minutes_per_session?: number;
  diet?: "omnivore" | "vegetarian" | "vegan" | "pescatarian";
  allergies?: string[];
  dislikes?: string[];
  injuries?: string[];
  medical_conditions?: string[];
  pregnant?: boolean;
  notes?: string;
}

export interface ExerciseItem {
  exercise_id: string | null;
  name: string;
  sets: number;
  reps: number | null;
  duration_sec: number | null;
  rest_sec: number;
  notes: string;
}
export interface DayPlan { day: string; name: string; warmup: string[]; exercises: ExerciseItem[]; cooldown: string[] }
export interface WeekPlan { week: number; focus: string; days: DayPlan[] }
export interface Meal { name: string; description: string; approx_kcal: number }
export interface PlanBody {
  title: string;
  summary: string;
  disclaimer: string;
  safety_flags: string[];
  progression: string;
  weeks: WeekPlan[];
  nutrition: {
    calories: number; protein_g: number; carbs_g: number; fat_g: number; water_l: number;
    notes: string[]; meal_days: { name: string; meals: Meal[] }[];
  };
}
export interface StoredPlan { id: string; created_at: string; model: string; plan: PlanBody }
export interface PlanSummary { id: string; title: string; created_at: string; goal: string | null }
export interface Safety { blocked: boolean; reasons: string[]; flags: string[] }
export interface GenerateResponse {
  status: "ok" | "needs_clarification" | "blocked";
  plan: StoredPlan | null;
  questions: string[];
  profile: PlanProfile | null;
  safety: Safety;
}
