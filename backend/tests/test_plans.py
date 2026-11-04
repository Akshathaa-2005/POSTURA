import json

import pytest
from fastapi.testclient import TestClient

from main import app
from plans import llm_service
from plans.nutrition import targets
from plans.safety import excluded_exercises, screen_profile
from plans.schemas import GenerateRequest, Profile

USER = "plan-user_1"

FORM = {
    "goal": "build_muscle", "level": "beginner", "age": 30, "sex": "male", "height": 180, "weight": 80,
    "equipment": ["none"], "days_per_week": 3, "minutes_per_session": 40, "diet": "vegetarian", "allergies": ["peanut"],
}


def workout_json(days=3, ex=None):
    ex = ex or [
        {"exercise_id": "squat", "name": "x", "sets": 3, "reps": 12, "rest_sec": 60},
        {"exercise_id": "plank", "name": "x", "sets": 3, "reps": 10, "rest_sec": 45},  # wrong mode → coerced to a hold
        {"exercise_id": None, "name": "Dead bug", "sets": 2, "reps": 10, "rest_sec": 30},
    ]
    day = {"day": "?", "name": "Full body", "warmup": ["march"], "exercises": ex, "cooldown": ["stretch"]}
    return {"title": "Starter", "summary": "s", "week_focus": ["a", "b", "c", "d"], "days": [day] * days}


def meals_json(extra=""):
    meal = lambda n, k: {"name": n, "description": f"oats and berries{extra}", "approx_kcal": k}
    day = lambda n: {"name": n, "meals": [meal("Breakfast", 500), meal("Lunch", 700), meal("Dinner", 600)]}
    return {"notes": ["prep ahead"], "meal_days": [day("A"), day("B"), day("C")]}


@pytest.fixture
def fake_llm(monkeypatch):
    """Replaces the Ollama call. `replies` is consumed in order; each is a dict, str, or Exception."""
    calls: list[list[dict]] = []
    replies: list = []

    async def chat(messages, schema, max_tokens):
        calls.append(list(messages))
        r = replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r if isinstance(r, str) else json.dumps(r)

    monkeypatch.setattr(llm_service, "_chat", chat)
    chat.calls, chat.replies = calls, replies
    return chat


# ---- pure logic --------------------------------------------------------------------------------------------


def test_profile_converts_imperial_and_validates():
    p = Profile(units="imperial", height=70, weight=176, age=30)
    assert p.units == "metric" and p.height == 177.8 and p.weight == 79.8
    with pytest.raises(ValueError):
        Profile(height=20, weight=70)
    assert Profile(goal="lose_fat").missing_fields() == ["level", "age", "sex", "height", "weight", "days_per_week"]


def test_merge_form_wins_and_lists_union():
    extracted = Profile(goal="lose_fat", age=40, injuries=["left knee"])
    form = Profile.model_validate({"goal": "build_muscle", "age": None, "injuries": ["wrist"]})
    m = form.merged_over(extracted)
    assert (m.goal, m.age) == ("build_muscle", 40) and m.injuries == ["left knee", "wrist"]


def test_request_needs_input():
    with pytest.raises(ValueError):
        GenerateRequest()


def test_nutrition_targets_and_floor():
    p = Profile.model_validate(FORM)
    t = targets(p)
    assert 2600 < t["calories"] < 3000 and t["protein_g"] == 144
    assert abs(t["protein_g"] * 4 + t["carbs_g"] * 4 + t["fat_g"] * 9 - t["calories"]) < 20
    tiny = Profile.model_validate({**FORM, "sex": "female", "weight": 45, "height": 150, "age": 60, "goal": "lose_fat", "days_per_week": 1})
    assert targets(tiny)["calories"] == 1200


@pytest.mark.parametrize(
    "overrides,blocked",
    [
        ({"age": 16}, True),
        ({"pregnant": True}, True),
        ({"medical_conditions": ["heart arrhythmia"]}, True),
        ({"notes": "I want to starve myself and lose 10kg in a week"}, True),
        ({"weight": 40, "height": 180}, True),
        ({"medical_conditions": ["type 2 diabetes"]}, False),
        ({}, False),
    ],
)
def test_screening(overrides, blocked):
    assert screen_profile(Profile.model_validate({**FORM, **overrides})).blocked is blocked


def test_injury_exclusions():
    assert "squat" in excluded_exercises(["Left knee pain"]) and excluded_exercises(["none"]) == set()


# ---- API ---------------------------------------------------------------------------------------------------


def test_generate_store_export_delete(fake_llm):
    fake_llm.replies += [workout_json(), meals_json()]
    with TestClient(app) as c:
        r = c.post(f"/api/users/{USER}/plans/generate", json={"profile": FORM})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "ok"
        plan = body["plan"]["plan"]
        assert "not medical advice" in plan["disclaimer"] and len(plan["weeks"]) == 4
        w1, w2, w3, w4 = (w["days"][0]["exercises"] for w in plan["weeks"])
        assert [d["day"] for d in plan["weeks"][0]["days"]] == ["Mon", "Wed", "Fri"]
        assert w1[1]["duration_sec"] and w1[1]["reps"] is None  # plank coerced to a hold
        assert w2[0]["reps"] == 13 and w3[0]["sets"] == 4 and w4[0]["sets"] == 2
        assert plan["nutrition"]["calories"] == targets(Profile.model_validate(FORM))["calories"]
        for d in plan["nutrition"]["meal_days"]:
            assert abs(sum(m["approx_kcal"] for m in d["meals"]) - plan["nutrition"]["calories"]) < 20

        pid = body["plan"]["id"]
        assert [p["id"] for p in c.get(f"/api/users/{USER}/plans").json()] == [pid]
        assert c.get(f"/api/users/{USER}/plans/{pid}").json()["plan"]["title"] == "Starter"
        assert c.get(f"/api/users/{USER}/plans/{pid}/export?fmt=md").text.startswith("# Starter")
        assert c.get(f"/api/users/{USER}/plans/{pid}/export").json()["id"] == pid
        assert c.get(f"/api/users/other-user/plans/{pid}").status_code == 404  # ownership
        assert c.delete(f"/api/users/{USER}/plans/{pid}").status_code == 204
        assert c.get(f"/api/users/{USER}/plans/{pid}").status_code == 404


def test_free_text_missing_fields_asks_questions(fake_llm):
    fake_llm.replies += [{"goal": "lose_fat", "age": 35, "weight": None}]
    with TestClient(app) as c:
        body = c.post(f"/api/users/{USER}/plans/generate", json={"free_text": "I'm 35 and want to lose fat"}).json()
    assert body["status"] == "needs_clarification"
    assert body["profile"]["age"] == 35 and len(body["questions"]) == 5


def test_unsafe_request_blocked_without_llm(fake_llm):
    with TestClient(app) as c:
        body = c.post(f"/api/users/{USER}/plans/generate", json={"profile": {**FORM, "age": 15}}).json()
        text = c.post(f"/api/users/{USER}/plans/generate", json={"free_text": "need a crash diet, anorexia is fine"}).json()
    assert body["status"] == text["status"] == "blocked" and body["safety"]["reasons"]
    assert not fake_llm.calls


def test_injury_removes_exercises_and_flags(fake_llm):
    fake_llm.replies += [workout_json(ex=[
        {"exercise_id": "squat", "name": "x", "sets": 3, "reps": 12, "rest_sec": 60},
        {"exercise_id": "glute_bridge", "name": "x", "sets": 3, "reps": 12, "rest_sec": 60},
    ]), meals_json()]
    with TestClient(app) as c:
        body = c.post(f"/api/users/{USER}/plans/generate", json={"profile": {**FORM, "injuries": ["knee"]}}).json()
    names = [e["name"] for e in body["plan"]["plan"]["weeks"][0]["days"][0]["exercises"]]
    assert names == ["Glute Bridge"] and body["plan"]["plan"]["safety_flags"]


def test_bad_output_retried_with_feedback(fake_llm):
    fake_llm.replies += ["not json", workout_json(days=2), workout_json(), meals_json("")]
    with TestClient(app) as c:
        r = c.post(f"/api/users/{USER}/plans/generate", json={"profile": FORM})
    assert r.status_code == 502  # attempts=2: both workout replies rejected (bad JSON, then wrong day count)
    assert "rejected" in fake_llm.calls[1][-1]["content"]


def test_allergen_in_meals_is_rejected_then_fixed(fake_llm):
    fake_llm.replies += [workout_json(), meals_json(" with peanut butter"), meals_json()]
    with TestClient(app) as c:
        assert c.post(f"/api/users/{USER}/plans/generate", json={"profile": FORM}).json()["status"] == "ok"
    assert "peanut" in fake_llm.calls[-1][-1]["content"]


def test_vegetarian_diet_enforced(fake_llm):
    fake_llm.replies += [workout_json(), meals_json(" and chicken"), meals_json(" and chicken")]
    with TestClient(app) as c:
        assert c.post(f"/api/users/{USER}/plans/generate", json={"profile": FORM}).status_code == 502


def test_ollama_down_is_503(fake_llm):
    fake_llm.replies += [llm_service.LLMUnavailable("Can't reach the local Ollama server. Is it running?")]
    with TestClient(app) as c:
        r = c.post(f"/api/users/{USER}/plans/generate", json={"profile": FORM})
    assert r.status_code == 503 and r.json()["code"] == "llm_unavailable"


def test_real_unreachable_ollama_maps_to_unavailable():
    # conftest points OLLAMA_API_URL at a dead port; no fake here
    with TestClient(app) as c:
        r = c.post(f"/api/users/{USER}/plans/generate", json={"profile": FORM})
    assert r.status_code == 503


def test_validation_422_and_bad_user_id():
    with TestClient(app) as c:
        assert c.post(f"/api/users/{USER}/plans/generate", json={"profile": {"age": 500}}).status_code == 422
        assert c.post(f"/api/users/{USER}/plans/generate", json={}).status_code == 422
        assert c.get("/api/users/bad%20id!/plans").status_code == 422


def test_peanut_allergy_does_not_ban_tree_nuts(fake_llm):
    fake_llm.replies += [workout_json(), meals_json(" with almond milk")]
    with TestClient(app) as c:
        assert c.post(f"/api/users/{USER}/plans/generate", json={"profile": FORM}).json()["status"] == "ok"


def test_injury_filter_catches_unlabelled_and_custom_exercises(fake_llm):
    fake_llm.replies += [workout_json(ex=[
        {"exercise_id": None, "name": "Bodyweight Squat", "sets": 3, "reps": 12, "rest_sec": 60},  # no id given
        {"exercise_id": None, "name": "Wall squat pulses", "sets": 3, "reps": 12, "rest_sec": 60},  # custom lookalike
        {"exercise_id": None, "name": "Glute Bridge", "sets": 3, "reps": 12, "rest_sec": 60},
    ]), meals_json()]
    with TestClient(app) as c:
        body = c.post(f"/api/users/{USER}/plans/generate", json={"profile": {**FORM, "injuries": ["knee"]}}).json()
    ex = body["plan"]["plan"]["weeks"][0]["days"][0]["exercises"]
    assert [(e["name"], e["exercise_id"]) for e in ex] == [("Glute Bridge", "glute_bridge")]


def test_mixed_nuts_rejected_for_peanut_allergy(fake_llm):
    fake_llm.replies += [workout_json(), meals_json(" and mixed nuts"), meals_json(" and mixed nuts")]
    with TestClient(app) as c:
        assert c.post(f"/api/users/{USER}/plans/generate", json={"profile": FORM}).status_code == 502


def test_negated_mentions_are_not_violations(fake_llm):
    fake_llm.replies += [workout_json(), meals_json(" (peanut-free, no peanuts)")]
    with TestClient(app) as c:
        assert c.post(f"/api/users/{USER}/plans/generate", json={"profile": FORM}).json()["status"] == "ok"


def test_gluten_free_does_not_excuse_peanut(fake_llm):
    fake_llm.replies += [workout_json(), meals_json(" gluten-free peanut sauce"), meals_json(" gluten-free peanut sauce")]
    with TestClient(app) as c:
        assert c.post(f"/api/users/{USER}/plans/generate", json={"profile": FORM}).status_code == 502


def test_tips_restating_the_allergy_are_fine(fake_llm):
    m = meals_json()
    m["notes"] = ["Since you are allergic to peanuts, all meals are nut-safe"]
    fake_llm.replies += [workout_json(), m]
    with TestClient(app) as c:
        assert c.post(f"/api/users/{USER}/plans/generate", json={"profile": FORM}).json()["status"] == "ok"
