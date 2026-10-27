"""Calorie, macro and water targets computed in code so the numbers are never LLM guesses."""

from .schemas import Profile

CAL_FLOOR = {"male": 1500, "female": 1200, "other": 1350}


def _activity(days: int) -> float:
    return 1.2 if days <= 1 else 1.375 if days <= 3 else 1.55 if days <= 5 else 1.725


def targets(p: Profile) -> dict:
    """Mifflin-St Jeor BMR x activity, nudged by goal. Requires the required profile fields."""
    assert p.weight and p.height and p.age and p.sex and p.days_per_week and p.goal
    sex_term = {"male": 5, "female": -161, "other": -78}[p.sex]
    bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + sex_term
    tdee = bmr * _activity(p.days_per_week)
    factor = {"lose_fat": 0.85, "build_muscle": 1.10}.get(p.goal, 1.0)
    calories = max(round(tdee * factor / 10) * 10, CAL_FLOOR[p.sex])
    protein = round(p.weight * {"lose_fat": 2.0, "build_muscle": 1.8}.get(p.goal, 1.4))
    fat = round(calories * 0.25 / 9)
    carbs = max(round((calories - protein * 4 - fat * 9) / 4), 0)
    notes = []
    if calories == CAL_FLOOR[p.sex] and factor < 1:
        notes.append("Calories are held at a safe minimum; don't eat below this.")
    return {
        "calories": calories,
        "protein_g": protein,
        "carbs_g": carbs,
        "fat_g": fat,
        "water_l": round(0.035 * p.weight + 0.5, 1),
        "notes": notes,
    }
