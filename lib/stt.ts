export const MAX_STT_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_STT_REQUEST_BYTES = MAX_STT_AUDIO_BYTES + 1024 * 1024;

/**
 * What the composer does with the transcript once it lands: send it, or queue
 * it as a steer/follow-up. No intent means insert it for editing. Kept on the
 * server job so the choice survives the composer remounting (every session
 * switch) and reaches whichever browser claims the transcript.
 */
export type SttAfter = "send" | "steer" | "followup";

export function isSttAfter(value: unknown): value is SttAfter {
  return value === "send" || value === "steer" || value === "followup";
}
