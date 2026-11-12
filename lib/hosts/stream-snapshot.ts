import { applyMessageDelta, isDeltaUpdate, withStreamedArguments } from "../message-delta";
import { isRecord } from "../type-guards";
import type { WireEvent } from "./pending-requests";

/** One open assistant message, fed the events of the channel's `event` frames. */
export class StreamSnapshot {
  private frame: WireEvent | null = null;

  note(frame: WireEvent): boolean {
    if ((frame.type === "message_end" && (!isRecord(frame.message) || frame.message.role === "assistant")
      && (frame.messageId === undefined || this.frame?.messageId === undefined || frame.messageId === this.frame.messageId))
      || (frame.type === "agent_end" && frame.isTerminal !== false)) {
      this.clear();
    } else if (frame.type === "message_start" && isRecord(frame.message) && frame.message.role === "assistant") {
      this.frame = { ...frame, type: "message_update" };
    } else if (frame.type === "message_update" && isRecord(frame.message) && frame.message.role === "assistant") {
      if (!isDeltaUpdate(frame)) this.frame = frame;
      else {
        const base = this.frame && this.frame.messageId === frame.messageId && isRecord(this.frame.message) ? this.frame.message : undefined;
        const message = applyMessageDelta(base, frame.assistantMessageEvent);
        this.frame = message ? { ...frame, message } : null;
        return message !== null;
      }
    }
    return true;
  }

  whole(): string | null {
    if (!this.frame || !isRecord(this.frame.message)) return null;
    // A snapshot is a full update, not the delta already represented by it.
    return JSON.stringify({ t: "event", event: { ...this.frame, assistantMessageEvent: undefined, message: withStreamedArguments(this.frame.message) } });
  }

  clear(): void { this.frame = null; }
}
