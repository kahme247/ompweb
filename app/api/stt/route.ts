import { NextResponse } from "next/server";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { isSttAfter, MAX_STT_AUDIO_BYTES, MAX_STT_REQUEST_BYTES, readSttConfig } from "@/lib/stt";
import { listSttJobs, startSttJob } from "@/lib/stt-jobs";

export const dynamic = "force-dynamic";

const MAX_SCOPE_LENGTH = 1024;

/** GET /api/stt?scope=<draft key> — live jobs for that composer, newest first. */
export async function GET(request: Request) {
  const scope = new URL(request.url).searchParams.get("scope");
  if (!scope || scope.length > MAX_SCOPE_LENGTH) {
    return NextResponse.json({ error: "scope is required", code: "missing_scope" }, { status: 400 });
  }
  return NextResponse.json({ jobs: listSttJobs(scope) });
}

/**
 * POST /api/stt (multipart: file, optional scope) — keeps the audio and starts
 * a server-side transcription job. Returns 202 { jobId }; poll
 * GET /api/stt/[jobId] for the result.
 */
export async function POST(request: Request) {
  try {
    const config = readSttConfig();
    if (!config) {
      return NextResponse.json(
        { error: "STT not configured. Set OMP_WEB_STT_ENDPOINT or OMP_WEB_STT_MODEL." },
        { status: 501 }
      );
    }

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
    const scope = formData.get("scope");
    if (scope !== null && (typeof scope !== "string" || scope.length > MAX_SCOPE_LENGTH)) {
      return NextResponse.json({ error: "Invalid scope", code: "invalid_scope" }, { status: 400 });
    }
    // The uploader's claim token: it gets first claim on the transcript.
    const owner = formData.get("owner");
    // What to do with the transcript (send/steer/followup); absent = insert.
    const after = formData.get("after");
    if (after !== null && !isSttAfter(after)) {
      return NextResponse.json({ error: "Invalid after", code: "invalid_after" }, { status: 400 });
    }

    const jobId = startSttJob(config, {
      audio: file,
      scope: scope || null,
      owner: typeof owner === "string" && owner ? owner.slice(0, 128) : undefined,
      after: after ?? undefined,
    });
    if (!jobId) {
      return NextResponse.json(
        { error: "Too many transcriptions in progress", code: "stt_busy" },
        { status: 429 }
      );
    }
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { error: "Audio file too large (max 25MB)", code: "audio_too_large" },
        { status: 413 }
      );
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
