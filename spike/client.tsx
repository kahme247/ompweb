// Spike SPA entry: renders the existing AppShell without Next.
import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "@/components/AppShell";
import { Marker } from "./Marker";

function Root() {
  return (
    <Suspense fallback={<div role="status">Loading omp web</div>}>
      <Marker />
      <AppShell appName="omp web" />
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
