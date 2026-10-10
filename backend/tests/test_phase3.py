from fastapi.testclient import TestClient

from main import app
from services import correction_generator as cg
from services.exercises import load_exercises


def receive_until(ws, kind, limit=20):
    for _ in range(limit):
        msg = ws.receive_json()
        if msg["type"] == kind:
            return msg
    raise AssertionError(f"no {kind} message received")


def test_catalog_is_usable_by_the_backend():
    exercises = load_exercises()
    assert len(exercises) >= 20
    for eid, ex in exercises.items():
        assert ex["faults"], eid
        for f in ex["faults"]:
            assert f["id"] and f["label"] and f["cue"], (eid, f)
        if ex.get("mode") == "hold":
            assert ex.get("setup") and ex.get("hold_target_sec"), eid
        else:
            assert ex.get("rep") and ex["rep_target"] > 0, eid


def test_hold_sessions_are_reported_as_seconds_not_reps():
    with TestClient(app) as client:
        for exercise, value in [("plank", 45), ("squat", 10)]:
            with client.websocket_connect("/ws/workout/holder") as ws:
                ws.send_json({"type": "start", "exercise_id": exercise})
                receive_until(ws, "session_started")
                ws.send_json({"type": "end", "reps": value, "avg_score": 90, "duration_sec": 50})
                receive_until(ws, "session_saved")
        stats = client.get("/api/users/holder/stats").json()
        assert (stats["total_reps"], stats["total_hold_sec"]) == (10, 45)


def test_llm_prompt_uses_persona_and_examples():
    ex = load_exercises()["squat"]
    prompt = cg.build_prompt(ex, "Not deep enough", "Sink a little deeper", "warn", True, ["Go lower."])
    assert prompt.endswith("Coach:")
    assert "on the last rep" in prompt and "(minor)" in prompt and "Go lower." in prompt
    assert "Examples:" in cg.SYSTEM_PROMPT


def test_clean_strips_echoed_label():
    assert cg._clean("Coach: Sit back and lift your chest.") == "Sit back and lift your chest."


def test_unhandled_errors_return_json_without_details(monkeypatch):
    from routes import exercises as routes_exercises

    def boom():
        raise RuntimeError("secret internals")

    monkeypatch.setattr(routes_exercises, "load_exercises", boom)
    with TestClient(app, raise_server_exceptions=False) as client:
        r = client.get("/api/exercises")
    assert r.status_code == 500
    assert r.json() == {"detail": "Internal server error"}
    assert "secret" not in r.text
