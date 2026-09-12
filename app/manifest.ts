import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "omp web",
    short_name: "omp web",
    description: "Web UI for the oh-my-pi (omp) coding agent",
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    // Chrome's install prompt requires both a 192px and a 512px PNG.
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
