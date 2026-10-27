"""Deterministic safety screening, run before the LLM sees anything and again on what it returns."""

import re

from .schemas import Profile, SafetyReport

# Conditions where unsupervised programming is inappropriate: refuse and refer to a clinician.
BLOCKING_CONDITIONS = re.compile(
    r"heart|cardiac|chest pain|arrhythmia|stroke|aneurysm|embolism|thrombosis|uncontrolled|epilep|seizure|"
    r"recent surgery|post[- ]?op|hernia|fracture|dissect|cancer|chemo|kidney (failure|disease)|"
    r"retinal|eating disorder|anorexi|bulimi",
    re.I,
)
# Conditions that are fine to train with but need a flag and a doctor's OK.
FLAG_CONDITIONS = re.compile(r"diabet|hypertens|blood pressure|asthma|thyroid|arthritis|osteopor|pcos|anemi", re.I)
# Free text that signals an unsafe goal or a vulnerable user.
UNSAFE_TEXT = re.compile(
    r"starv|purg|pro[- ]?ana|fast(ing)? for \d+ ?(h|hours|days)|water fast|crash diet|"
    r"(lose|drop) \d+ ?(kg|kgs|lb|lbs|pounds|kilos) in (a|one|1|\d+) ?(day|days|week|weeks)|"
    r"steroid|sarm|clenbuterol|dnp|diuretic|laxative|self[- ]?harm|hurt myself|train through (the )?pain|"
    r"eating disorder|anorexi|bulimi",
    re.I,
)
# Things the LLM must never put in a plan.
UNSAFE_OUTPUT = re.compile(
    r"steroid|sarm|clenbuterol|\bdnp\b|diuretic|laxative|purge|water fast|dry fast|"
    r"fast for \d+ ?(h|hours|days)|\d{3,} ?mg|train through (the )?pain|ignore (the )?pain",
    re.I,
)

# Catalogue exercises to drop for a reported injury area.
INJURY_AVOID: dict[str, set[str]] = {
    "knee": {"squat", "sumo_squat", "lunge", "reverse_lunge", "side_lunge", "wall_sit", "jumping_jack", "high_knees"},
    "ankle": {"jumping_jack", "high_knees", "lunge", "reverse_lunge", "side_lunge"},
    "hip": {"sumo_squat", "side_lunge", "lunge", "reverse_lunge", "hip_hinge"},
    "back": {"hip_hinge", "bent_over_row", "sit_up", "leg_raise", "jumping_jack", "high_knees"},
    "spine": {"hip_hinge", "bent_over_row", "sit_up", "leg_raise"},
    "shoulder": {"shoulder_press", "lateral_raise", "front_raise", "push_up", "knee_push_up", "overhead_tricep_extension", "plank", "side_plank"},
    "wrist": {"push_up", "knee_push_up", "plank", "side_plank"},
    "elbow": {"bicep_curl", "overhead_tricep_extension", "push_up", "knee_push_up"},
    "neck": {"sit_up", "shoulder_press", "overhead_tricep_extension"},
}


def excluded_exercises(injuries: list[str]) -> set[str]:
    text = " ".join(injuries).lower()
    out: set[str] = set()
    for part, ids in INJURY_AVOID.items():
        if part in text:
            out |= ids
    return out


def screen_profile(p: Profile, extra_text: str = "") -> SafetyReport:
    r = SafetyReport()
    if p.age is not None:
        if p.age < 18:
            r.reasons.append("Plans are only generated for adults (18+). Young people should train under a qualified coach or doctor's guidance.")
        elif p.age >= 65:
            r.flags.append("Check with your doctor before starting a new exercise programme at your age; start gently.")
    if p.pregnant:
        r.reasons.append("Pregnancy needs exercise and nutrition advice from your midwife or doctor, so no plan was generated.")
    for c in p.medical_conditions:
        if BLOCKING_CONDITIONS.search(c):
            r.reasons.append(f'"{c}" needs medical clearance and supervised programming; no plan was generated.')
        elif FLAG_CONDITIONS.search(c):
            r.flags.append(f'"{c}": get your doctor\'s OK first and monitor how you feel.')
        else:
            r.flags.append(f'"{c}": check with your doctor before following this plan.')
    if p.injuries:
        r.flags.append("Injuries reported (" + ", ".join(p.injuries) + "): affected movements were removed. See a physiotherapist if pain persists.")
    text = " ".join([p.notes, extra_text, *p.injuries, *p.medical_conditions])
    if UNSAFE_TEXT.search(text):
        r.reasons.append("Your request mentions something unsafe or medically sensitive; a plan can't responsibly be generated for it. Please talk to a doctor or dietitian.")
    if p.height and p.weight:
        bmi = p.weight / (p.height / 100) ** 2
        if bmi < 17:
            r.reasons.append("Your weight is very low for your height; please see a doctor before starting a plan.")
        if p.target_weight:
            tbmi = p.target_weight / (p.height / 100) ** 2
            if p.goal == "lose_fat" and tbmi < 18.5:
                r.reasons.append("The target weight is in the underweight range, which isn't a safe goal.")
        if p.goal == "lose_fat" and bmi < 20:
            r.flags.append("You're already lean; the calorie deficit has been kept small.")
    r.blocked = bool(r.reasons)
    return r


def unsafe_output(text: str) -> str | None:
    m = UNSAFE_OUTPUT.search(text)
    return m.group(0) if m else None
