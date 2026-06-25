import { Layer } from "effect";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { chatRoute } from "./routes/chat";
import { deckRoutes } from "./routes/deck";
import { extractChoicesRoute } from "./routes/extractChoices";
import { llmEditRoute } from "./routes/llmEdit";
import { llmRoutes } from "./routes/llmSettings";
import { skillsRoutes } from "./routes/skills";
import { staticRoute } from "./routes/static";

// API routes first, the static/SPA catch-all last so exact matches win.
export const routesLayer = Layer.mergeAll(
  ...authRoutes,
  ...adminRoutes,
  ...skillsRoutes,
  ...deckRoutes,
  ...llmRoutes,
  chatRoute,
  extractChoicesRoute,
  llmEditRoute,
  staticRoute,
);
