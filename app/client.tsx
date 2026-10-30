import "./boot";
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { AppShell } from "@/components/AppShell";
import { IosFocusZoomGuard } from "@/components/IosFocusZoomGuard";
import { LoginForm } from "@/components/LoginForm";

function RouteLoadingFallback() {
  return (
    <div className="route-fallback" role="status" aria-busy="true" aria-label="Loading omp web">
      <aside className="route-fallback-sidebar" aria-hidden="true">
        <div className="skeleton route-fallback-sidebar-title" />
        <div className="skeleton route-fallback-sidebar-button" />
        <div className="route-fallback-sidebar-list">
          <div className="skeleton route-fallback-sidebar-row" />
          <div className="skeleton route-fallback-sidebar-row" />
          <div className="skeleton route-fallback-sidebar-row" />
        </div>
      </aside>
      <main className="route-fallback-main" aria-hidden="true">
        <div className="route-fallback-topbar">
          <div className="skeleton route-fallback-topbar-control" />
          <div className="skeleton route-fallback-topbar-title" />
          <div className="skeleton route-fallback-topbar-control" />
        </div>
        <div className="route-fallback-content">
          <div className="skeleton route-fallback-line route-fallback-line-short" />
          <div className="skeleton route-fallback-line" />
          <div className="skeleton route-fallback-line" />
          <div className="skeleton route-fallback-composer" />
        </div>
      </main>
    </div>
  );
}

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
