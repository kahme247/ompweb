import "./boot";
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { AppShell } from "@/components/AppShell";
import { IosFocusZoomGuard } from "@/components/IosFocusZoomGuard";
import { LoginForm } from "@/components/LoginForm";
import { RouteLoadingFallback } from "@/components/RouteLoadingFallback";

// createRoot (not hydrateRoot) replaces the static skeleton that app/index.html puts in #root.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <IosFocusZoomGuard />
      {location.pathname === "/login" ? (
        <LoginForm />
      ) : (
        <Suspense fallback={<RouteLoadingFallback />}>
          <AppShell appName={document.title} />
        </Suspense>
      )}
    </AppErrorBoundary>
  </StrictMode>,
);
