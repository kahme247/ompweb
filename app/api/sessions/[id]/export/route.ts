import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { promisify } from "util";
import { NextResponse } from "next/server";
import { resolveOmpBin } from "@/lib/omp/omp-cli";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { getContentDisposition } from "@/lib/content-disposition";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

/**
 * Render a session to self-contained HTML by shelling out to the user's omp
 * binary: `omp --export <sessionPath> <outPath>` (the output path is the first
 * positional argument; verified against oh-my-pi main.ts/flag-tables.ts).
 */
async function exportSession(filePath: string, outputPath: string): Promise<void> {
  const bin = resolveOmpBin();
  if (!bin) {
    throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  }
  await execFileAsync(bin, ["--export", filePath, outputPath], {
    cwd: tmpdir(),
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const inline = new URL(req.url).searchParams.get("inline") === "1";

  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const tempDir = join(tmpdir(), "omp-web-export");
    mkdirSync(tempDir, { recursive: true });

    const sessionBase = basename(filePath, ".jsonl");
    const fileName = `omp-session-${sessionBase}.html`;
    const outputPath = join(tempDir, `${randomUUID()}.html`);

    try {
      await exportSession(filePath, outputPath);

      const html = readFileSync(outputPath, "utf8");
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": getContentDisposition(fileName, inline, "session.html"),
          "Cache-Control": "no-cache",
        },
      });
    } finally {
      rmSync(outputPath, { force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("omp binary not found")) {
      return NextResponse.json({ error: message, code: "omp_not_found" }, { status: 500 });
    }
    return apiErrorResponse(error);
  }
}
