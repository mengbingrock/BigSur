import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { attempt, bodyJson, error, sessionUser } from "../httpKit";
import { readDeckFile } from "../services/deck";
import { extractTextFromBuffer } from "../services/extract";
import { createSkill } from "../services/skills";

const safeBody = <T>() =>
  bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

interface FromDeckFileBody {
  deckPath?: string;
  name?: string;
}

/** POST /api/artifacts/from-deck-file — save an existing working-directory file
 *  as a new protocol artifact. Reads the deck file, converts it to markdown
 *  (md/txt/pdf/docx/doc/odt/rtf), and writes it into the caller's own folder as
 *  a `kind: "protocol"` skill so it shows up in the Artifacts catalog. */
export const fromDeckFileRoute = HttpRouter.add(
  "POST",
  "/api/artifacts/from-deck-file",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<FromDeckFileBody>();
    const deckPath = body?.deckPath?.trim();
    const name = body?.name?.trim();
    if (!deckPath) return yield* error("deckPath is required.", 400);
    if (!name) return yield* error("name is required.", 400);
    return yield* attempt(async () => {
      const { data } = await readDeckFile(user.email, deckPath);
      const { text } = await extractTextFromBuffer(data, deckPath);
      const skill = createSkill(
        { name, description: "", allowedTools: [], body: text, kind: "protocol" },
        user.email,
      );
      return { skill: { slug: skill.slug, name: skill.name } };
    });
  }),
);

export const artifactsRoutes = [fromDeckFileRoute] as const;
