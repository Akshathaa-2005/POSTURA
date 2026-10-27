"""Plan orchestration: extract profile → safety screen → targets (code) → workout (LLM) → meals (LLM) → assemble."""

import copy
import json
import re
from typing import Any

from pydantic import BaseModel

from services.exercises import load_exercises

from . import llm_service, prompts
from .nutrition import targets
from .safety import excluded_exercises, screen_profile, unsafe_output
from .schemas import (
    DISCLAIMER,
    LLMMeals,
    LLMWorkout,
    Nutrition,
    PlanBody,
    Profile,
    SafetyReport,
    WeekPlan,
)

NEEDS_WEIGHTS = {"bicep_curl", "shoulder_press", "lateral_raise", "front_raise", "overhead_tricep_extension", "bent_over_row"}
DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
SCHEDULES = {  # spread sessions so rest days fall between them
    1: [0], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 4, 5], 6: [0, 1, 2, 3, 4, 5], 7: list(range(7)),
}


# ---- profile extraction ------------------------------------------------------------------------------------


def _parse_profile(data: Any) -> Profile:
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object")
    clean = {k: v for k, v in data.items() if v not in (None, "", [])}
    return Profile.model_validate(clean)


async def extract_profile(text: str) -> Profile:
    return await llm_service.generate(
        prompts.EXTRACT_SYSTEM,
        prompts.EXTRACT_USER.format(text=text.strip()[:3000]),
        _parse_profile,
        max_tokens=500,
    )


# ---- catalogue ---------------------------------------------------------------------------------------------


def allowed_exercises(p: Profile) -> dict[str, dict]:
    gear = set(p.equipment)
    has_weights = bool(gear & {"dumbbells", "barbell", "gym"})
    banned = excluded_exercises(p.injuries)
    out = {}
    for eid, ex in load_exercises().items():
        if eid in banned or (eid in NEEDS_WEIGHTS and not has_weights):
            continue
        if p.level == "beginner" and ex.get("difficulty") != "beginner":
            continue
        out[eid] = ex
    return out


def _profile_line(p: Profile) -> str:
    bits = [f"{p.age}y {p.sex}", f"{p.height} cm", f"{p.weight} kg", f"goal {p.goal}", f"level {p.level}",
            f"equipment {', '.join(p.equipment)}"]
    if p.injuries:
        bits.append("injuries: " + ", ".join(p.injuries))
    return "; ".join(bits)


# ---- workout -----------------------------------------------------------------------------------------------


def _make_workout_parser(p: Profile, allowed: dict[str, dict]):
    catalogue = load_exercises()
    banned = excluded_exercises(p.injuries)
    by_name = {ex["name"].lower(): eid for eid, ex in catalogue.items()}
    # Movement words of excluded exercises ("squat", "lunge", "jumping"…) also catch custom exercise names.
    risky = {w for eid in banned for w in re.findall(r"[a-z]{5,}", catalogue[eid]["name"].lower())} - {
        "bodyweight", "forward", "reverse", "overhead", "lying", "lateral", "front", "plank"}

    def parse(data: Any) -> LLMWorkout:
        w = LLMWorkout.model_validate(data)
        if len(w.days) != p.days_per_week:
            raise ValueError(f"you wrote {len(w.days)} days but exactly {p.days_per_week} are required")
        if bad := unsafe_output(json.dumps(data)):
            raise ValueError(f"contains unsafe content ({bad!r})")
        for i, day in enumerate(w.days):
            day.day = DAY_NAMES[SCHEDULES[p.days_per_week][i]]
            kept = []
            for ex in day.exercises:
                if ex.exercise_id not in catalogue and ex.name.lower() in by_name:
                    ex.exercise_id = by_name[ex.name.lower()]  # right exercise, missing/invented id
                known = catalogue.get(ex.exercise_id or "")
                if ex.exercise_id and known is None:
                    ex.exercise_id = None  # invented id → treat as a custom exercise
                if known is None and any(w in ex.name.lower() for w in risky):
                    continue  # custom exercise that resembles one excluded for the injury
                if known is not None:
                    if ex.exercise_id in banned or ex.exercise_id not in allowed:
                        continue  # unsafe for this person's injuries/equipment/level
                    ex.name = known["name"]
                    hold = known.get("mode") == "hold"
                    if hold and ex.duration_sec is None:
                        ex.reps, ex.duration_sec = None, known.get("hold_target_sec") or 30
                    elif not hold and ex.reps is None:
                        ex.reps, ex.duration_sec = known.get("rep_target") or 10, None
                kept.append(ex)
            if not kept:
                raise ValueError(f"day {i + 1} has no usable exercises; use exercises from the catalogue")
            day.exercises = kept
        return w

    return parse


def _progress(day_list, *, reps: int = 0, secs: int = 0, sets: int = 0):
    days = copy.deepcopy(day_list)
    for day in days:
        for ex in day.exercises:
            ex.sets = max(1, min(6, ex.sets + sets))
            if ex.reps is not None:
                ex.reps = min(60, ex.reps + reps)
            else:
                ex.duration_sec = min(600, ex.duration_sec + secs)
    return days


PROGRESSION = (
    "Week 1: learn the movements with clean form. Week 2: add 1 rep (or 5 seconds) to every set. "
    "Week 3: add 1 set to every exercise. Week 4: deload (one fewer set than week 1) and focus on technique. "
    "Repeat from week 1 with a little more reps or weight if every session felt manageable."
)


def expand_weeks(w: LLMWorkout) -> list[WeekPlan]:
    w2 = _progress(w.days, reps=1, secs=5)
    w3 = _progress(w2, sets=1)
    w4 = _progress(w.days, sets=-1)
    return [WeekPlan(week=i + 1, focus=w.week_focus[i], days=d) for i, d in enumerate([w.days, w2, w3, w4])]


# ---- meals -------------------------------------------------------------------------------------------------

MEAT = r"chicken|beef|pork|lamb|bacon|ham|turkey|sausage|steak|mince|meat|duck|salami"
FISH = r"fish|salmon|tuna|cod|shrimp|prawn|sardine|anchov|tilapia|mackerel|crab|lobster"
DAIRY_EGG = r"egg|milk|cheese|yogh?urt|butter|whey|paneer|ghee|cream|honey|curd|casein"
ALLERGEN_WORDS = {
    "nut": r"nut|almond|cashew|walnut|pecan|pistachio|hazelnut|macadamia",
    "peanut": r"peanut|groundnut|mixed nuts|trail mix",
    "dairy": r"milk|cheese|yogh?urt|butter|whey|paneer|ghee|cream|curd|casein",
    "lactose": r"milk|cheese|yogh?urt|butter|whey|paneer|cream|curd",
    "gluten": r"wheat|bread|pasta|barley|rye|flour|couscous|roti|chapati|seitan|noodle",
    "wheat": r"wheat|bread|pasta|flour|couscous|roti|chapati|noodle",
    "egg": r"egg|mayo",
    "soy": r"soy|tofu|tempeh|edamame|miso",
    "shellfish": r"shrimp|prawn|crab|lobster|clam|mussel|oyster",
    "fish": FISH,
    "sesame": r"sesame|tahini",
}
DIET_BANS = {
    "vegetarian": f"{MEAT}|{FISH}",
    "vegan": f"{MEAT}|{FISH}|{DAIRY_EGG}",
    "pescatarian": MEAT,
}


NEGATION = re.compile(r"\b\w+-free\b|\bfree (?:of|from) \w+|\b(?:no|without|avoid\w*|skip|omit) (?:\w+ ?){1,2}", re.I)


def _word_hit(pattern: str, text: str) -> str | None:
    # "peanut-free" or "no dairy" is the model respecting the restriction, not breaking it.
    text = NEGATION.sub(" ", text)
    m = re.search(rf"\b(?:{pattern})", text, re.I)
    return m.group(0) if m else None


def _make_meals_parser(p: Profile, cal: int):
    avoid: list[tuple[str, str]] = []  # (user's term, regex)
    for term in p.allergies:
        t = term.lower()
        pats = [re.escape(t)] + [rx for key, rx in ALLERGEN_WORDS.items() if re.search(rf"\b{key}s?\b", t)]
        avoid.append((term, "|".join(pats)))
    avoid += [(d, re.escape(d.lower())) for d in p.dislikes]

    def parse(data: Any) -> LLMMeals:
        m = LLMMeals.model_validate(data)
        text = json.dumps(data)
        # Tips often restate the restriction ("since you're allergic to peanuts…"); that isn't a violation.
        tips = " ".join(n for n in m.notes if not re.search(r"allerg|intoleran|restrict", n, re.I))
        text = json.dumps([[(x.name, x.description) for x in d.meals] for d in m.meal_days]) + " " + tips
        if bad := unsafe_output(text):
            raise ValueError(f"contains unsafe content ({bad!r})")
        if (ban := DIET_BANS.get(p.diet)) and (hit := _word_hit(ban, text)):
            raise ValueError(f"'{hit}' is not allowed on a {p.diet} diet")
        for term, rx in avoid:
            if hit := _word_hit(rx, text):
                raise ValueError(f"'{hit}' conflicts with the person's allergy/dislike '{term}'")
        for day in m.meal_days:  # scale each day to the calorie target; models are bad at arithmetic
            total = sum(x.approx_kcal for x in day.meals)
            if total <= 0:
                raise ValueError(f"{day.name} has no calories listed")
            for x in day.meals:
                x.approx_kcal = round(x.approx_kcal * cal / total / 5) * 5
        return m

    return parse


# ---- top level ---------------------------------------------------------------------------------------------


class Outcome(BaseModel):
    status: str  # ok | needs_clarification | blocked
    profile: Profile | None = None
    plan: PlanBody | None = None
    questions: list[str] = []
    safety: SafetyReport = SafetyReport()


async def resolve_profile(structured: Profile | None, free_text: str | None) -> Profile:
    """Merge the form (wins) over what the LLM extracts from free text."""
    text = (free_text or "").strip()
    if not text:
        return structured or Profile()
    extracted = await extract_profile(text)
    merged = structured.merged_over(extracted) if structured else extracted
    if not merged.notes:
        merged.notes = text[:1500]
    return merged


async def build_plan(p: Profile, adjustment: str | None, safety: SafetyReport) -> PlanBody:
    t = targets(p)
    allowed = allowed_exercises(p)
    catalogue = "\n".join(f"{eid}: {ex['name']}" for eid, ex in allowed.items()) or "(none; use safe custom exercises)"
    note = (p.notes or "none")[:800]
    adj = f"Adjustment requested: {adjustment.strip()}\n" if adjustment and adjustment.strip() else ""

    workout = await llm_service.generate(
        prompts.WORKOUT_SYSTEM.format(
            days=p.days_per_week, minutes=p.minutes_per_session, level=p.level,
            n_ex=max(3, min(7, p.minutes_per_session // 9)), example=prompts.WORKOUT_EXAMPLE,
        ),
        prompts.WORKOUT_USER.format(profile=_profile_line(p), days=p.days_per_week, catalogue=catalogue, notes=note, adjustment=adj),
        _make_workout_parser(p, allowed),
        schema=LLMWorkout.model_json_schema(),
        max_tokens=3500,
    )
    meals = await llm_service.generate(
        prompts.MEALS_SYSTEM.format(
            calories=t["calories"], protein=t["protein_g"], diet=p.diet,
            allergies=", ".join(p.allergies) or "none", dislikes=", ".join(p.dislikes) or "none",
        ),
        prompts.MEALS_USER.format(
            goal=p.goal, calories=t["calories"], protein=t["protein_g"], carbs=t["carbs_g"], fat=t["fat_g"], notes=note,
        ),
        _make_meals_parser(p, t["calories"]),
        schema=LLMMeals.model_json_schema(),
        max_tokens=1800,
    )
    return PlanBody(
        title=workout.title,
        summary=workout.summary,
        disclaimer=DISCLAIMER,
        safety_flags=safety.flags,
        progression=PROGRESSION,
        weeks=expand_weeks(workout),
        nutrition=Nutrition(**{**t, "notes": t["notes"] + meals.notes}, meal_days=meals.meal_days),
    )


async def generate_plan(structured: Profile | None, free_text: str | None, adjustment: str | None) -> Outcome:
    extra = " ".join(filter(None, [free_text, adjustment]))
    # Cheap deterministic screen first so unsafe free text never costs an LLM call.
    early = screen_profile(structured or Profile(), extra)
    if early.blocked:
        return Outcome(status="blocked", profile=structured, safety=early)

    profile = await resolve_profile(structured, free_text)
    safety = screen_profile(profile, extra)
    if safety.blocked:
        return Outcome(status="blocked", profile=profile, safety=safety)

    if missing := profile.missing_fields():
        from .schemas import QUESTIONS

        return Outcome(status="needs_clarification", profile=profile, questions=[QUESTIONS[m] for m in missing], safety=safety)

    return Outcome(status="ok", profile=profile, plan=await build_plan(profile, adjustment, safety), safety=safety)


def to_markdown(plan: PlanBody) -> str:
    n = plan.nutrition
    out = [f"# {plan.title}", "", plan.summary, "", f"> {plan.disclaimer}", ""]
    if plan.safety_flags:
        out += ["## Safety notes", *[f"- {f}" for f in plan.safety_flags], ""]
    out += ["## Progression", plan.progression, ""]
    for wk in plan.weeks:
        out += [f"## Week {wk.week}: {wk.focus}", ""]
        for d in wk.days:
            out += [f"### {d.day}: {d.name}", "**Warm-up:** " + "; ".join(d.warmup), ""]
            for ex in d.exercises:
                amount = f"{ex.reps} reps" if ex.reps else f"{ex.duration_sec} s"
                out.append(f"- {ex.name}: {ex.sets} x {amount}, rest {ex.rest_sec} s" + (f" ({ex.notes})" if ex.notes else ""))
            out += ["", "**Cool-down:** " + "; ".join(d.cooldown), ""]
    out += ["## Nutrition", f"{n.calories} kcal · protein {n.protein_g} g · carbs {n.carbs_g} g · fat {n.fat_g} g · water {n.water_l} L/day", ""]
    out += [f"- {x}" for x in n.notes]
    for day in n.meal_days:
        out += ["", f"### {day.name}", *[f"- **{m.name}** (~{m.approx_kcal} kcal): {m.description}" for m in day.meals]]
    return "\n".join(out) + "\n"
