import type { AvatarCommand, JointStatus, Side } from "@/types";

export type ServerMessage =
  | { type: "session_started"; session_id: string; exercise_id: string; llm: boolean; tts: boolean }
  | {
      type: "correction";
      id: number;
      fault_id: string;
      label: string;
      status: JointStatus;
      text: string;
      source: "llm" | "template" | "cache";
      avatar_command?: AvatarCommand | null;
    }
  // `url` is null when the server can't synthesise speech: the browser speaks `text` instead.
  | { type: "voice"; id: number; url: string | null; text: string; kind: "correction" | "praise" | "intro" }
  | { type: "session_saved"; session_id: string }
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "start"; exercise_id: string }
  | { type: "issue"; fault_id: string; status: "warn" | "bad"; side: Side | null; from_rep: boolean; message?: string }
  | { type: "praise" }
  | { type: "rep"; event: "rep" | "partial"; reps: number; rom: number }
  | { type: "end"; reps: number; avg_score: number | null; duration_sec: number };

export type ConnectionState = "offline" | "connecting" | "online";

interface Handlers {
  onMessage: (msg: ServerMessage) => void;
  onState: (state: ConnectionState) => void;
  /** Called on every (re)connect, so the caller can (re)start its session. */
  onOpen: () => void;
}

const MAX_BACKOFF_MS = 10_000;

/** A WebSocket that reconnects with backoff and silently drops messages while disconnected. */
export class CoachSocket {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string, private readonly handlers: Handlers) {}

  connect() {
    this.closedByUser = false;
    this.handlers.onState("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.handlers.onState("online");
      this.handlers.onOpen();
    };
    ws.onmessage = (e) => {
      try {
        this.handlers.onMessage(JSON.parse(e.data) as ServerMessage);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onState("offline");
      if (!this.closedByUser) {
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.retry++);
        this.timer = setTimeout(() => this.connect(), delay);
      }
    };
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }

  close() {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.handlers.onState("offline");
  }
}
