import { NextResponse } from "next/server";
import { runNpx } from "@/lib/npx";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

const ANSI_RE = /\x1B\[[0-9;]*m/g;

// POST /api/skills/install  body: { package: string; scope: "global" | "project"; cwd?: string }
export async function POST(req: Request) {
  try {
    const { package: pkg, scope, cwd } = await req.json() as { package?: string; scope?: string; cwd?: string };
    if (!pkg?.trim()) return NextResponse.json({ error: "package required", code: "package_required" }, { status: 400 });
    // npm package-name grammar: scope-optional, URL-safe segments. Rejecting
    // leading dashes/`-` prefixes stops a value like `--force` from being
    // interpreted as npx/CLI options instead of a package name.
    const name = pkg.trim();
    if (name.startsWith("-") || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      return NextResponse.json({ error: "Invalid package name", code: "package_invalid" }, { status: 400 });
    }
    const isGlobal = scope !== "project";
    if (!isGlobal) {
      if (!cwd) return NextResponse.json({ error: "cwd required for project install", code: "cwd_required_for_project_install" }, { status: 400 });
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
      }
    }
    // The skills.sh CLI has no omp agent entry; "universal" installs into the
    // ecosystem-standard ~/.agents/skills (global) / <cwd>/.agents/skills
    // (project), both of which omp discovers via its agent-dirs provider.
    const args = ["skills", "add", name, "-y", "--agent", "universal"];
    if (isGlobal) args.push("-g");

    const { stdout, stderr } = await runNpx(args, {
      timeout: 60000,
      cwd: !isGlobal && cwd ? cwd : undefined,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const output = (stdout + stderr).replace(ANSI_RE, "");
    const success = /Installation complete|Installed \d+ skill/.test(output);
    if (!success) {
      const detail = output.slice(-300);
      return NextResponse.json(
        detail ? { error: detail } : { error: "Install failed", code: "skill_install_failed" },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: true, output });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = ((err.stdout ?? "") + (err.stderr ?? "")).replace(ANSI_RE, "");
    return NextResponse.json({ error: output || (err.message ?? String(e)) }, { status: 500 });
  }
}
