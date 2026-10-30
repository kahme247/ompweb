// Spike shim for next/dynamic: React.lazy + Suspense (client-only app, `ssr` is moot).
import { lazy, Suspense, type ComponentType } from "react";

type Loader<P> = () => Promise<ComponentType<P> | { default: ComponentType<P> }>;

export default function dynamic<P extends object>(loader: Loader<P>, options?: { loading?: ComponentType; ssr?: boolean }) {
  const Lazy = lazy(async () => {
    const loaded = await loader();
    return { default: "default" in loaded ? loaded.default : loaded };
  });
  const Loading = options?.loading;
  return function DynamicComponent(props: P) {
    return (
      <Suspense fallback={Loading ? <Loading /> : null}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}
