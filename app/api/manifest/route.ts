import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetadataRoute } from "next";
import { getInstallName } from "@/lib/install-name";

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
export function GET(request: Request) {
  const name = getInstallName(request.headers);
  return Response.json({ ...manifest, name, short_name: name }, {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "private, no-cache, max-age=0, must-revalidate",
    },
  });
}
