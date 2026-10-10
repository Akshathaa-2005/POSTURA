import { useCallback, useEffect, useRef } from "react";
import type { FormIssue, RepEvent } from "@/types";
import { backendUrl, getUserId, WS_URL } from "@/utils/api";
import { CoachSocket, type ServerMessage } from "@/utils/websocket";
import { useWorkoutState } from "./useWorkoutState";

function handleMessage(msg: ServerMessage) {
  const { setCoach } = useWorkoutState.getState();
  switch (msg.type) {
    case "session_started":
      setCoach({ sessionId: msg.session_id, llm: msg.llm, tts: msg.tts });
      break;
    case "correction":
      setCoach({
        correction: {
          id: msg.id,
          faultId: msg.fault_id,
          label: msg.label,
          status: msg.status,
          text: msg.text,
          source: msg.source,
          at: Date.now(),
        },
      });
      break;
    case "voice": {
      const voice = { id: msg.id, url: backendUrl(msg.url), text: msg.text };
      if (msg.kind === "correction") {
        setCoach({ voice });
      } else {
        // Intro and encouragement have no preceding correction message — show them as the transcript too.
        setCoach({
          voice,
          correction: {
            id: msg.id,
            faultId: msg.kind,
            label: msg.kind === "intro" ? "Welcome" : "Encouragement",
            status: "good",
            text: msg.text,
            source: "template",
            at: Date.now(),
          },
        });
      }
      break;
    }
    case "error":
      console.warn("[coach]", msg.message);
      break;
  }
}

/**
 * Connects to the coaching backend while a workout is active. Each (exercise, sessionKey)
 * is one server-side session; it is ended (and saved) when the workout stops or resets.
 * Everything degrades gracefully: if the backend is down, local feedback keeps working.
 */
export function useWebSocket({ exerciseId, active, sessionKey }: { exerciseId: string; active: boolean; sessionKey: number }) {
  const socketRef = useRef<CoachSocket | null>(null);

  useEffect(() => {
    if (!active) return;
    const socket: CoachSocket = new CoachSocket(`${WS_URL}/workout/${getUserId()}`, {
      onState: (connection) => useWorkoutState.getState().setCoach({ connection }),
      onOpen: () => socket.send({ type: "start", exercise_id: exerciseId }),
      onMessage: handleMessage,
    });
    socketRef.current = socket;
    socket.connect();

    return () => {
      const s = useWorkoutState.getState();
      // Hold exercises report seconds held in the reps field (the backend knows which mode the exercise uses).
      const reps = s.holdMs > 0 && s.reps === 0 ? Math.round(s.holdMs / 1000) : s.reps;
      socket.send({ type: "end", reps, avg_score: s.averageScore, duration_sec: s.activeMs / 1000 });
      socket.close();
      socketRef.current = null;
    };
  }, [active, exerciseId, sessionKey]);

  // The browser detects faults at full frame rate; the server phrases them (LLM), speaks them (TTS),
  // paces them so the coach doesn't nag, and logs them.
  const sendIssue = useCallback((issue: FormIssue) => {
    socketRef.current?.send({
      type: "issue",
      fault_id: issue.id,
      status: issue.status,
      side: issue.side,
      from_rep: issue.fromRep,
    });
  }, []);

  const sendPraise = useCallback(() => {
    socketRef.current?.send({ type: "praise" });
  }, []);

  const sendRep = useCallback((event: RepEvent, reps: number) => {
    socketRef.current?.send({ type: "rep", event: event.type, reps, rom: event.rom });
  }, []);

  return { sendRep, sendIssue, sendPraise };
}
