import { NextResponse } from "next/server";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";

export const dynamic = "force-dynamic";

export const MAX_STT_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_STT_REQUEST_BYTES = MAX_STT_AUDIO_BYTES + 1024 * 1024;

function extractUpstreamErrorMessage(data: unknown, rawText: string, status: number): string {
  if (data && typeof data === "object" && "error" in data) {
    const error: unknown = data.error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object" && "message" in error) {
      const message: unknown = error.message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  if (rawText.trim()) return rawText.trim().slice(0, 500);
  return `Transcription failed (upstream ${status})`;
}

function cleanEnvVar(val?: string): string | undefined {
  const cleaned = val?.replace(/\\n|[\r\n]/g, "").trim();
  return cleaned || undefined;
}

export async function POST(request: Request) {
  let apiKey: string | undefined;
  try {
    const endpoint = cleanEnvVar(process.env.OMP_WEB_STT_ENDPOINT);
    if (!endpoint) {
      return NextResponse.json(
        { error: "STT not configured. Set OMP_WEB_STT_ENDPOINT." },
        { status: 501 }
      );
    }

    apiKey = cleanEnvVar(process.env.OMP_WEB_STT_KEY);
    const model = cleanEnvVar(process.env.OMP_WEB_STT_MODEL);
    const formData = await parseFormDataWithinLimit(request, MAX_STT_REQUEST_BYTES);
    const file = formData.get("file");
    if (!file || typeof file === "string" || file.size === 0) {
      return NextResponse.json(
        { error: "Audio file is required", code: "missing_audio_file" },
        { status: 400 }
      );
    }
    if (file.size > MAX_STT_AUDIO_BYTES) {
      return NextResponse.json(
        { error: "Audio file too large (max 25MB)", code: "audio_too_large" },
        { status: 413 }
      );
    }

    if (model && !formData.has("model")) {
      formData.append("model", model);
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    const rawText = await res.text();
    let data: unknown = null;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = null;
    }

    if (!res.ok) {
      return NextResponse.json(
        { error: extractUpstreamErrorMessage(data, rawText, res.status) },
        { status: res.status }
      );
    }

    if (data !== null) {
      return NextResponse.json(data, { status: res.status });
    }
    return NextResponse.json({ text: rawText }, { status: res.status });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { error: "Audio file too large (max 25MB)", code: "audio_too_large" },
        { status: 413 }
      );
    }
    const rawMsg = error instanceof Error ? error.message : String(error);
    const safeMsg = apiKey ? rawMsg.replaceAll(apiKey, "[REDACTED]") : rawMsg;
    return NextResponse.json({ error: safeMsg }, { status: 500 });
  }
}
