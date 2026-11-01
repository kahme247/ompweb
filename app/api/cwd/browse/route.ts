import { apiErrorResponse } from "@/lib/api-utils";
import { stat } from "fs/promises";
import {
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";

// GET /api/cwd/browse?path=... — lists readable subdirectories in the filesystem.
export async function GET(request: Request) {
  try {
    const requested = new URL(request.url).searchParams.get("path")?.trim();
    if (shouldShowWindowsDrivePicker(requested)) {
      return Response.json({ path: "", parentPath: null, drives: await listWindowsDrives(), directories: [] });
    }
    const candidate = getBrowseStartDirectory(requested);

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return Response.json({ error: "Directory does not exist", code: "directory_not_found" }, { status: 404 });
    }


    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return Response.json({ error: "Path is not a directory", code: "not_a_directory" }, { status: 400 });
    }

    const directories = await listDirectories(resolved);

    return Response.json({
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
