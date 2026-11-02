/**
 * The shell silhouette shown until AppShell renders. app/index.html carries the same markup as static HTML, so the
 * browser paints it as soon as the page and its stylesheet arrive (Next server-rendered it); RouteLoadingFallback.test
 * keeps the two copies identical.
 */
export function RouteLoadingFallback() {
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
