"""Standalone TTS process: `python -m services.tts_worker <out_path> <rate>` with the text on stdin.

pyttsx3 drivers (NSSpeechSynthesizer on macOS, SAPI5, eSpeak) aren't safe to drive from
an asyncio server thread, so each synthesis runs in its own short-lived process.
"""

import sys

import pyttsx3


def main() -> None:
    out_path, rate = sys.argv[1], int(sys.argv[2])
    text = sys.stdin.read().strip()
    engine = pyttsx3.init()
    engine.setProperty("rate", rate)
    engine.save_to_file(text, out_path)
    engine.runAndWait()


if __name__ == "__main__":
    main()
