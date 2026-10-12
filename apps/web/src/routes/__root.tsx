import type { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  useRouterState,
} from "@tanstack/react-router";
import { SiteShell } from "~/components/SiteShell";
import { useCurrentUser } from "~/lib/auth";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { data: user, isLoading } = useCurrentUser();

  // Only the public home gets a standalone page. Keep the application shell
  // for signed-in users and every other route; wait for auth before showing it.
  if (pathname === "/" && (isLoading || !user)) {
    return (
      <div className="h-dvh w-full overflow-y-auto">
        <Outlet />
      </div>
    );
  }

  return (
    <SiteShell>
      <Outlet />
    </SiteShell>
  );
}
