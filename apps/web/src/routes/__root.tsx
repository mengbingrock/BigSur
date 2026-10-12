import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { SiteShell } from "~/components/SiteShell";
import { useCurrentUser } from "~/lib/auth";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  const { data: user, isLoading } = useCurrentUser();

  // Show the application sidebar only after authentication is confirmed.
  if (isLoading || !user) {
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
