import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetadataRoute } from "next";
import type { NextRequest } from "next/server";
import { getInstallName } from "@/lib/install-name";
import { parseThemeColor } from "@/lib/manifest-theme";

// Packaged public assets are read/encoded once per server module. Native
// installers fetch HTTP icons without cookies, even with a credentialed manifest.
const pngDataUrl = (filename: string) =>
  `data:image/png;base64,${readFileSync(join(process.cwd(), "public", filename)).toString("base64")}`;

const manifest: MetadataRoute.Manifest = {
  description: "Web UI for the oh-my-pi (omp) coding agent",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#000000",
  theme_color: "#000000",
  icons: [
    { src: pngDataUrl("icon-192.png"), sizes: "192x192", type: "image/png" },
    { src: pngDataUrl("icon.png"), sizes: "512x512", type: "image/png" },
  ],
};

// Authentication is enforced by the existing /api/ web-password proxy guard.
export function GET(request: NextRequest) {
  const name = getInstallName(request.headers);
  // ?theme= comes from the page's manifest link (lib/manifest-theme.ts).
  // theme_color colors the installed app's system bars; background_color is
  // its window background, which shows through the navigation bar on
  // edge-to-edge Android (and on the splash screen).
  const color = parseThemeColor(request.nextUrl.searchParams.get("theme")) ?? manifest.theme_color;
  return Response.json({ ...manifest, theme_color: color, background_color: color, name, short_name: name }, {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "private, no-cache, max-age=0, must-revalidate",
    },
  });
}
