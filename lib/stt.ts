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

function cleanEnvVar(val?: string): string | undefined {
  const cleaned = val?.replace(/\\n|[\r\n]/g, "").trim();
  return cleaned || undefined;
}

export interface SttConfig {
  /** Unset: transcribe with `model` (an omp model selector) through omp's auth gateway. */
  endpoint: string | undefined;
  apiKey: string | undefined;
  model: string | undefined;
}

/** STT settings from OMP_WEB_STT_*; null when neither an endpoint nor a model is configured. */
export function readSttConfig(): SttConfig | null {
  const endpoint = cleanEnvVar(process.env.OMP_WEB_STT_ENDPOINT);
  const model = cleanEnvVar(process.env.OMP_WEB_STT_MODEL);
  if (!endpoint && !model) return null;
  return { endpoint, apiKey: cleanEnvVar(process.env.OMP_WEB_STT_KEY), model };
}
