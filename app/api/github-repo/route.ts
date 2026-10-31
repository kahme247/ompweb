import fs from "fs";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { resolveGithubRepo } from "@/lib/github-repo";

export async function GET(request: Request) {
  const cwd = new URL(request.url).searchParams.get("cwd")?.trim() ?? "";
  if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
    return Response.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return Response.json({ error: "Directory not found", code: "directory_not_found" }, { status: 404 });
  }
  if (!stat.isDirectory()) {
    return Response.json({ error: "Not a directory", code: "not_a_directory" }, { status: 400 });
  }
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
  }
  return Response.json({ repo: await resolveGithubRepo(cwd) });
}
