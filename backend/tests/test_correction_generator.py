import httpx
import pytest

from services import correction_generator as cg
from services.exercises import fault_cue, get_exercise, get_fault


@pytest.fixture(autouse=True)
def clear_cache():
    cg._variants.clear()
    cg._rotation.clear()


def test_fault_cue_side_only_in_front_view():
    jj = get_exercise("jumping_jack")
    arms = get_fault(jj, "arms_not_overhead")
    assert fault_cue(jj, arms, "right").startswith("Your right arm")
    assert fault_cue(jj, arms, None) == arms["cue"]
    squat = get_exercise("squat")
    assert fault_cue(squat, get_fault(squat, "shallow_squat"), "left") == get_fault(squat, "shallow_squat")["cue"]


def test_setup_is_a_known_fault_only_when_defined():
    assert get_fault(get_exercise("push_up"), "setup")["label"] == "Get into position"
    assert get_fault(get_exercise("squat"), "setup") is None


async def test_falls_back_to_authored_cue(monkeypatch):
    async def down(_):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(cg, "_ask_llm", down)
    ex = get_exercise("squat")
    text, source = await cg.generate_correction(ex, "chest_forward", "Chest dropping", "Lift your chest", "warn")
    assert (text, source) == ("Lift your chest.", "template")


async def test_llm_variants_are_collected_then_rotated(monkeypatch):
    replies = iter(["Chest proud as you sit back.", "Lift your chest up tall.", "Keep that chest high.", "never used"])
    prompts = []

    async def fake(prompt):
        prompts.append(prompt)
        return next(replies)

    monkeypatch.setattr(cg, "_ask_llm", fake)
    ex = get_exercise("squat")
    args = (ex, "chest_forward", "Chest dropping", "Lift your chest — keep your torso tall", "bad")
    got = [await cg.generate_correction(*args) for _ in range(5)]
    assert [s for _, s in got] == ["llm", "llm", "llm", "cache", "cache"]
    assert {t for t, _ in got[3:]} <= {t for t, _ in got[:3]}
    assert len(prompts) == 3
    # Later prompts ask the model to avoid earlier phrasings, and always carry the authored cue.
    assert "Chest proud as you sit back." in prompts[1]
    assert all("Lift your chest — keep your torso tall" in p for p in prompts)


def test_clean_rejects_rambling():
    assert cg._clean('"Sit back and lift your chest."  Extra sentence.') == "Sit back and lift your chest."
    assert cg._clean(" ".join(["word"] * 30)) == ""
