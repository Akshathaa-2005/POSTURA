import time

from fastapi.testclient import TestClient

import websocket_handler
from main import app

USER = "test-user_1"


def receive_until(ws, kind, limit=20):
    for _ in range(limit):
        msg = ws.receive_json()
        if msg["type"] == kind:
            return msg
    raise AssertionError(f"no {kind} message received")


def test_health_and_exercises():
    with TestClient(app) as client:
        health = client.get("/api/health").json()
        assert health["database"]["ok"] is True
        assert health["llm"]["available"] is False
        exercises = client.get("/api/exercises").json()
        squat = next(e for e in exercises if e["id"] == "squat")
        assert squat["view"] == "side" and squat["faults"]
        assert client.get("/api/exercises/nope").status_code == 404


def test_full_workout_flow():
    with TestClient(app) as client:
        with client.websocket_connect(f"/ws/workout/{USER}") as ws:
            ws.send_json({"type": "start", "exercise_id": "squat"})
            started = receive_until(ws, "session_started")
            assert started["llm"] is False and started["tts"] is False
            session_id = started["session_id"]

            ws.send_json({"type": "issue", "fault_id": "shallow_squat", "status": "warn", "from_rep": True})
            correction = receive_until(ws, "correction")
            assert correction["fault_id"] == "shallow_squat"
            assert correction["label"] == "Not deep enough"
            assert correction["source"] == "template"
            assert correction["text"] == "Sink a little deeper — aim for thighs parallel to the floor."

            ws.send_json({"type": "rep", "event": "rep", "reps": 1, "rom": 100})
            ws.send_json({"type": "rep", "event": "partial", "reps": 1, "rom": 60})
            ws.send_json({"type": "end", "reps": 3, "avg_score": 88.5, "duration_sec": 42})
            saved = receive_until(ws, "session_saved")
            assert saved["session_id"] == session_id

        sessions = client.get(f"/api/users/{USER}/sessions").json()
        s = next(s for s in sessions if s["id"] == session_id)
        assert (s["reps"], s["partial_reps"], s["avg_score"], s["duration_sec"]) == (3, 1, 88.5, 42)
        assert s["ended_at"] is not None

        stats = client.get(f"/api/users/{USER}/stats").json()
        assert stats["total_reps"] >= 3
        assert stats["common_issues"][0] == {"fault_id": "shallow_squat", "label": "Not deep enough", "count": 1}


def test_front_view_cue_names_the_side():
    with TestClient(app) as client:
        with client.websocket_connect("/ws/workout/sider") as ws:
            ws.send_json({"type": "start", "exercise_id": "jumping_jack"})
            receive_until(ws, "session_started")
            ws.send_json({"type": "issue", "fault_id": "arms_not_overhead", "status": "warn", "side": "left"})
            text = receive_until(ws, "correction")["text"]
            assert text == "Your left arm isn't reaching overhead — swing it all the way up."


def test_coach_paces_corrections(monkeypatch):
    settings = websocket_handler.get_settings()
    monkeypatch.setattr(settings, "correction_cooldown_sec", 0.0)
    monkeypatch.setattr(settings, "same_issue_cooldown_sec", 60.0)
    with TestClient(app) as client:
        with client.websocket_connect("/ws/workout/pacer") as ws:
            ws.send_json({"type": "start", "exercise_id": "push_up"})
            receive_until(ws, "session_started")
            ws.send_json({"type": "issue", "fault_id": "hips_sagging", "status": "bad"})
            assert receive_until(ws, "correction")["fault_id"] == "hips_sagging"
            time.sleep(0.3)  # let the first cue finish (logging + voice) — the coach speaks one cue at a time
            # Same fault again is suppressed; a different one gets through.
            ws.send_json({"type": "issue", "fault_id": "hips_sagging", "status": "bad"})
            ws.send_json({"type": "issue", "fault_id": "setup", "status": "warn"})
            nxt = receive_until(ws, "correction")
            assert nxt["fault_id"] == "setup"
            assert "plank" in nxt["text"]


def test_disconnect_without_end_still_saves_session():
    with TestClient(app) as client:
        with client.websocket_connect("/ws/workout/dropper") as ws:
            ws.send_json({"type": "start", "exercise_id": "squat"})
            sid = receive_until(ws, "session_started")["session_id"]
        # The server saves the session just after the socket closes.
        for _ in range(50):
            s = client.get(f"/api/sessions/{sid}").json()
            if s["ended_at"] is not None:
                break
            time.sleep(0.02)
        assert s["ended_at"] is not None


def test_protocol_errors():
    with TestClient(app) as client:
        with client.websocket_connect("/ws/workout/u2") as ws:
            ws.send_json({"type": "issue", "fault_id": "shallow_squat", "status": "warn"})
            assert "start" in receive_until(ws, "error")["message"]
            ws.send_json({"type": "start", "exercise_id": "nope"})
            assert "Unknown exercise" in receive_until(ws, "error")["message"]
            ws.send_json({"type": "start", "exercise_id": "squat"})
            receive_until(ws, "session_started")
            ws.send_json({"type": "issue", "fault_id": "hips_sagging", "status": "warn"})
            assert "Unknown fault" in receive_until(ws, "error")["message"]
            ws.send_json({"type": "issue", "fault_id": "shallow_squat", "status": "terrible"})
            assert "Invalid issue" in receive_until(ws, "error")["message"]
            ws.send_json({"type": "issue", "fault_id": "unseen", "status": "warn", "from_rep": True})
            assert receive_until(ws, "correction")["label"] == "Can't see you"
            ws.send_json({"type": "pose"})
            assert "Unknown message type" in receive_until(ws, "error")["message"]
