import { Suspense } from "react";
import { headers } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { getInstallName } from "@/lib/install-name";

export default async function Home() {
  const appName = getInstallName(await headers());
  return (
    <Suspense fallback={<RouteLoadingFallback />}>
      <AppShell appName={appName} />
    </Suspense>
  );
}

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
