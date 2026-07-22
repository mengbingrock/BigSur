import { Layer } from "effect";
import { adminRoutes } from "./routes/admin";
import { agentRoutes } from "./routes/agents";
import { artifactsRoutes } from "./routes/artifacts";
import { authRoutes } from "./routes/auth";
import { billingRoutes } from "./routes/billing";
import { chatRoute } from "./routes/chat";
import { deckRoutes } from "./routes/deck";
import { fsRoutes } from "./routes/fs";
import { googleRoutes } from "./routes/google";
import { extractChoicesRoute } from "./routes/extractChoices";
import { llmEditRoute } from "./routes/llmEdit";
import { llmProxyRoutes } from "./routes/llmProxy";
import { llmRoutes } from "./routes/llmSettings";
import { mcpProxyRoute, mcpTokenRoute } from "./routes/protocolsMcp";
import { skillsRoutes } from "./routes/skills";
import { transcribeRoute } from "./routes/transcribe";
import { staticRoute } from "./routes/static";

// API routes first, the static/SPA catch-all last so exact matches win.
export const routesLayer = Layer.mergeAll(
  ...authRoutes,
  ...googleRoutes,
  ...adminRoutes,
  ...skillsRoutes,
  ...artifactsRoutes,
  ...deckRoutes,
  ...llmRoutes,
  ...llmProxyRoutes,
  ...billingRoutes,
  ...agentRoutes,
  ...fsRoutes,
  mcpTokenRoute,
  mcpProxyRoute,
  chatRoute,
  extractChoicesRoute,
  llmEditRoute,
  transcribeRoute,
  staticRoute,
);
