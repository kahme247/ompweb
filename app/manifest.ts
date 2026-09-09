import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "omp web",
    short_name: "omp web",
    description: "Web UI for the oh-my-pi (omp) coding agent",
    start_url: "/",
    display: "standalone",
    background_color: "#FAF9F6",
    theme_color: "#FAF9F6",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml" },
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
