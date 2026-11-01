// A small in-process event bus. Everything the UI shows live (API calls, decisions, state)
// goes through here and out to the browser over Server-Sent Events.
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

export type Level = "info" | "api" | "warn" | "error";

export interface LogEntry {
  id: number;
  time: string;
  level: Level;
  message: string;
  /** The SDK call, e.g. `media.enableByTag("promo")`. */
  call?: string;
  /** HTTP requests the call made, e.g. `PUT /v2/api/media/tags/promo/enable → 200`. */
  requests?: string[];
  /** Parsed response data, shown in the log panel. */
  result?: unknown;
  durationMs?: number;
}

const bus = new EventEmitter();
bus.setMaxListeners(50);

const history: LogEntry[] = [];
let nextId = 1;

export function log(level: Level, message: string, extra: Partial<LogEntry> = {}): LogEntry {
  const entry: LogEntry = { id: nextId++, time: new Date().toISOString(), level, message, ...extra };
  history.push(entry);
  if (history.length > 200) history.shift();
  bus.emit("log", entry);
  const prefix = level === "error" ? "✖" : level === "warn" ? "!" : level === "api" ? "→" : "·";
  console.log(`${prefix} ${extra.call ?? message}${extra.call && message ? `  ${message}` : ""}`);
  return entry;
}

export function emitState(state: unknown): void {
  bus.emit("state", state);
}

/** `GET /api/events`: replays recent log entries, then streams new ones and state changes. */
export function sse(getState: () => unknown) {
  return (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("state", getState());
    for (const entry of history) send("log", entry);

    const onLog = (e: LogEntry) => send("log", e);
    const onState = (s: unknown) => send("state", s);
    bus.on("log", onLog);
    bus.on("state", onState);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      bus.off("log", onLog);
      bus.off("state", onState);
    });
  };
}
