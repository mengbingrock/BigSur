import { Layer } from "effect";
import { adminRoutes } from "./routes/admin";
import { agentRoutes } from "./routes/agents";
import { authRoutes } from "./routes/auth";
import { chatRoute } from "./routes/chat";
import { deckRoutes } from "./routes/deck";
import { fsRoutes } from "./routes/fs";
import { googleRoutes } from "./routes/google";
import { extractChoicesRoute } from "./routes/extractChoices";
import { llmEditRoute } from "./routes/llmEdit";
import { llmRoutes } from "./routes/llmSettings";
import { skillsRoutes } from "./routes/skills";
import { staticRoute } from "./routes/static";

// API routes first, the static/SPA catch-all last so exact matches win.
export const routesLayer = Layer.mergeAll(
  ...authRoutes,
  ...googleRoutes,
  ...adminRoutes,
  ...skillsRoutes,
  ...deckRoutes,
  ...llmRoutes,
  ...agentRoutes,
  ...fsRoutes,
  chatRoute,
  extractChoicesRoute,
  llmEditRoute,
  staticRoute,
);
