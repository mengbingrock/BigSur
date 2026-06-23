import { Layer } from "effect";
import { authRoutes } from "./routes/auth";
import { deckRoutes } from "./routes/deck";
import { skillsRoutes } from "./routes/skills";
import { staticRoute } from "./routes/static";

// API routes first, the static/SPA catch-all last so exact matches win.
export const routesLayer = Layer.mergeAll(
  ...authRoutes,
  ...skillsRoutes,
  ...deckRoutes,
  staticRoute,
);
