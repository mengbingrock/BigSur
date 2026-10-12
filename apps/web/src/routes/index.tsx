import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BrandHome } from "~/components/BrandHome";
import { useCurrentUser } from "~/lib/auth";

export const Route = createFileRoute("/")({
  component: Home,
});

/** Signed in → the protocol library, which is what people open Labee to reach.
 *  Chats are one click away in the sidebar and reopen where they left off. The
 *  hero is only for people who are not signed in, i.e. visitors to the public
 *  site. */
function Home() {
  const navigate = useNavigate();
  const { data: user, isLoading } = useCurrentUser();

  useEffect(() => {
    if (!isLoading && user) navigate({ to: "/protocols", replace: true });
  }, [isLoading, user, navigate]);

  if (isLoading || user) {
    return (
      <div className="flex h-full w-full items-center justify-center py-24 text-sm text-ink-light">
        Opening your protocols…
      </div>
    );
  }
  return <BrandHome />;
}
