// Build/resume the context embedding index in the configured LABEE_DATA_DIR.
// bun run apps/server/scripts/indexContext.ts --email scientist@example.com
const i = process.argv.indexOf("--email");
const email = i >= 0 ? process.argv[i + 1] : undefined;
if (!email) throw new Error("Usage: indexContext.ts --email <account>");
const { buildContextEmbeddings } =
  await import("../src/services/context/embeddings");
for (;;) {
  const status = await buildContextEmbeddings(email, 20);
  console.log(JSON.stringify(status));
  if (!status.available)
    throw new Error(
      "No embedding provider is configured for this account. Configure its OpenAI embedding credential or the provided-tier embedding proxy.",
    );
  if (status.ready) break;
  if (status.built === 0)
    await new Promise((resolve) => setTimeout(resolve, 100));
}
