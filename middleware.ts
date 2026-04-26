import { NextResponse, type NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, type SessionData } from "@/lib/session";

// Protected paths are guarded by checking the session cookie. The matcher
// below already restricts which paths run this middleware.
export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const session = await getIronSession<SessionData>(req, res, sessionOptions);
  const path = req.nextUrl.pathname;
  const isApi = path.startsWith("/api/");
  const isAdminPath = path.startsWith("/admin") || path.startsWith("/api/admin");

  if (!session.email) {
    if (isApi) {
      return new NextResponse(
        JSON.stringify({ error: "Unauthorized — please sign in." }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  if (isAdminPath && !session.isAdmin) {
    if (isApi) {
      return new NextResponse(
        JSON.stringify({ error: "Admin only." }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/chat";
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: [
    "/chat/:path*",
    "/skills/:path*",
    "/admin/:path*",
    "/api/chat",
    "/api/files/:path*",
    "/api/admin/:path*",
  ],
};
