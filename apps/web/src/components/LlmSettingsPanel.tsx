import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Loader2, Sparkles } from "lucide-react";
import type {
  AccountConnection,
  Connections,
  CredentialMode,
  LlmSettings,
  LlmSettingsUpdate,
  Provider,
  ProviderCatalogEntry,
} from "@labee/contracts";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { apiGet, apiSend } from "~/lib/api";
import { cn } from "~/lib/utils";

const SETTINGS_KEY = ["llm", "settings"] as const;

type SettingsMutation = ReturnType<typeof useMutation<LlmSettings, Error, LlmSettingsUpdate>>;

// ── Layout primitives (mirrors the AgentScience settings look) ──────────────

function SettingsSection({
  title,
  headerAction,
  children,
}: {
  title: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h2>
        {headerAction}
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-xs/5">
        {children}
      </div>
    </section>
  );
}

function SettingsRow({
  title,
  description,
  status,
  control,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-t border-border px-4 py-4 first:border-t-0 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          {status ? <div className="pt-1 text-[11px] text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** A compact horizontal segmented control. */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled || opt.disabled}
            onClick={() => !selected && onChange(opt.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-50",
              selected
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────

export function LlmSettingsPanel() {
  const qc = useQueryClient();

  const providersQ = useQuery({
    queryKey: ["llm", "providers"],
    queryFn: () => apiGet<{ providers: ProviderCatalogEntry[] }>("/api/llm/providers"),
  });
  const settingsQ = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => apiGet<LlmSettings>("/api/llm/settings"),
  });

  const mutation: SettingsMutation = useMutation({
    mutationFn: (patch: LlmSettingsUpdate) =>
      apiSend<LlmSettings>("PUT", "/api/llm/settings", patch),
    onSuccess: (next) => {
      qc.setQueryData(SETTINGS_KEY, next);
      qc.invalidateQueries({ queryKey: SETTINGS_KEY });
    },
  });

  const providers = providersQ.data?.providers ?? [];
  const settings = settingsQ.data;

  if (providersQ.isLoading || settingsQ.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (providersQ.isError || settingsQ.isError || !settings) {
    return (
      <p className="text-sm text-destructive">Couldn’t load LLM settings. Please try again.</p>
    );
  }

  const active = providers.find((p) => p.provider === settings.provider) ?? providers[0];

  return (
    <>
      <ConnectionSection />

      <SettingsSection
        title="Model provider"
        headerAction={
          <SaveIndicator
            isPending={mutation.isPending}
            isError={mutation.isError}
            error={mutation.error}
            isSuccess={mutation.isSuccess}
          />
        }
      >
        <SettingsRow
          title="Provider"
          description="Which LLM provider powers chat, extraction, and edits."
          control={
            <Segmented<Provider>
              options={providers.map((p) => ({ value: p.provider, label: p.label }))}
              value={settings.provider}
              onChange={(provider) => mutation.mutate({ provider })}
              disabled={mutation.isPending}
            />
          }
        />
        {active ? (
          <SettingsRow
            title="Model"
            description={`Default ${active.label} model for this account.`}
            control={
              <select
                value={settings.model}
                disabled={mutation.isPending}
                onChange={(e) => mutation.mutate({ model: e.target.value })}
                className={cn(
                  "h-8 min-w-[12rem] rounded-md border border-input bg-background px-2.5 text-sm text-foreground",
                  "outline-none transition focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                {active.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            }
          />
        ) : null}
        {active ? (
          <SettingsRow
            title="Capabilities"
            description={
              active.agentic
                ? "Runs the full agentic toolset (Bash, file edits, skills, web)."
                : "Plain chat only — no Bash, file, or skill tools in this mode yet."
            }
            control={
              <Badge variant={active.agentic ? "success" : "secondary"} size="sm">
                {active.agentic ? "Full tools" : "Chat only"}
              </Badge>
            }
          />
        ) : null}
      </SettingsSection>

      {active ? <AccountSection entry={active} settings={settings} mutation={mutation} /> : null}
    </>
  );
}

function SaveIndicator({
  isPending,
  isError,
  error,
  isSuccess,
}: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isSuccess: boolean;
}) {
  if (isPending) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Saving…
      </span>
    );
  }
  if (isError) {
    const message = error instanceof Error ? error.message : "Failed to save.";
    return <span className="text-[11px] text-destructive">{message}</span>;
  }
  if (isSuccess) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Check className="size-3 text-brand" /> Saved
      </span>
    );
  }
  return null;
}

function AccountSection({
  entry,
  settings,
  mutation,
}: {
  entry: ProviderCatalogEntry;
  settings: LlmSettings;
  mutation: SettingsMutation;
}) {
  const account = settings.accounts.find((a) => a.provider === entry.provider);
  const mode: CredentialMode = account?.mode ?? "own_api_key";
  const apiKeyField = entry.provider === "anthropic" ? "anthropicApiKey" : "openaiApiKey";
  const modeField = entry.provider === "anthropic" ? "anthropicMode" : "openaiMode";

  const setMode = (next: CredentialMode) => {
    if (next !== mode) mutation.mutate({ [modeField]: next } as LlmSettingsUpdate);
  };

  const modeOptions: { value: CredentialMode; label: string; disabled?: boolean }[] = [
    { value: "own_api_key", label: "Your API key" },
    { value: "own_subscription", label: "Your subscription", disabled: entry.subscriptionComingSoon },
    { value: "provided", label: "Labee provided", disabled: !entry.providedAvailable },
  ];

  return (
    <SettingsSection title={`${entry.label} — account`}>
      <SettingsRow
        title="Credential source"
        description="Use your own account, or Labee’s provided account."
        control={
          <Segmented<CredentialMode>
            options={modeOptions}
            value={mode}
            onChange={setMode}
            disabled={mutation.isPending}
          />
        }
      />

      {mode === "own_api_key" ? (
        <SettingsRow
          title="API key"
          description={`Stored encrypted; used only for your ${entry.label} requests.`}
          control={
            <ApiKeyControl
              field={apiKeyField}
              hasKey={!!account?.hasOwnApiKey}
              mutation={mutation}
            />
          }
        />
      ) : null}

      {mode === "own_subscription" ? (
        <SettingsRow
          title="Subscription"
          description={
            entry.subscriptionComingSoon
              ? "Sign-in for this provider isn’t wired up yet."
              : entry.provider === "anthropic"
                ? "Uses this machine’s Claude (claude.ai) sign-in — no API key needed."
                : "Uses your provider subscription sign-in."
          }
          control={
            entry.subscriptionComingSoon ? (
              <Badge variant="secondary" size="sm">
                Coming soon
              </Badge>
            ) : (
              <Badge variant="success" size="sm">
                Connected
              </Badge>
            )
          }
        />
      ) : null}

      {mode === "provided" ? (
        <SettingsRow
          title="Labee provided"
          description={
            entry.providedAvailable
              ? "Billed to your Labee plan — no key required."
              : "Not configured on this server."
          }
          control={
            <Badge variant={entry.providedAvailable ? "success" : "secondary"} size="sm">
              {entry.providedAvailable ? "Available" : "Unavailable"}
            </Badge>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

const CONNECTION_KEY = ["llm", "connection"] as const;

const CONNECTION_META: Record<Provider, { display: string; brand: string; cli: string }> = {
  anthropic: { display: "Claude", brand: "Continue with Claude", cli: "claude" },
  openai: { display: "ChatGPT", brand: "Continue with ChatGPT", cli: "codex" },
};

function ConnectionSection() {
  const [connecting, setConnecting] = useState<Provider | null>(null);

  const connQ = useQuery({
    queryKey: CONNECTION_KEY,
    queryFn: () => apiGet<Connections>("/api/llm/connection"),
    refetchInterval: connecting ? 3000 : false,
  });
  const conns = connQ.data;

  // Stop polling once the in-flight sign-in lands.
  useEffect(() => {
    if (connecting && conns?.[connecting]?.connected) setConnecting(null);
  }, [connecting, conns]);

  return (
    <SettingsSection title="Connection">
      {connQ.isLoading ? (
        <SettingsRow title="Accounts" description="Checking connections…" />
      ) : (
        (["anthropic", "openai"] as Provider[]).map((provider) => (
          <ConnectionRow
            key={provider}
            provider={provider}
            conn={conns?.[provider]}
            connecting={connecting === provider}
            onConnecting={(on) => setConnecting(on ? provider : null)}
          />
        ))
      )}
    </SettingsSection>
  );
}

function ConnectionRow({
  provider,
  conn,
  connecting,
  onConnecting,
}: {
  provider: Provider;
  conn: AccountConnection | undefined;
  connecting: boolean;
  onConnecting: (on: boolean) => void;
}) {
  const qc = useQueryClient();
  const meta = CONNECTION_META[provider];

  const connectMut = useMutation({
    mutationFn: () =>
      apiSend<{ started: boolean; authUrl?: string; message?: string }>(
        "POST",
        `/api/llm/connection/${provider}`,
      ),
    onSuccess: (res) => {
      if (res.authUrl) window.open(res.authUrl, "_blank", "noopener");
      onConnecting(true);
      qc.invalidateQueries({ queryKey: CONNECTION_KEY });
    },
  });

  const disconnectMut = useMutation({
    mutationFn: () => apiSend<{ ok: boolean }>("DELETE", `/api/llm/connection/${provider}`),
    onSuccess: () => {
      onConnecting(false);
      qc.invalidateQueries({ queryKey: CONNECTION_KEY });
    },
  });

  const connected = !!conn?.connected;
  const available = conn?.available ?? false;

  if (connected) {
    return (
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-[var(--success)]" />
            {conn?.planLabel ?? `${meta.display} account`}
          </span>
        }
        description="Labee will use this connection automatically."
        status={conn?.email ? <span className="font-mono">{conn.email}</span> : undefined}
        control={
          <Button
            variant="outline"
            size="xs"
            disabled={disconnectMut.isPending}
            onClick={() => disconnectMut.mutate()}
          >
            {disconnectMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Disconnect
          </Button>
        }
      />
    );
  }

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-brand" /> {meta.brand}
        </span>
      }
      description={
        connecting
          ? "Keep the browser tab open. Labee will connect automatically when sign-in finishes."
          : available
            ? `Best for most people. Use your ${meta.display} subscription — no API key needed.`
            : `Requires the ${meta.cli} CLI on this server to broker ${meta.display} sign-in.`
      }
      status={
        connectMut.isError ? (
          <span className="text-destructive">
            {connectMut.error instanceof Error ? connectMut.error.message : "Sign-in failed."}
          </span>
        ) : undefined
      }
      control={
        <Button
          size="xs"
          disabled={!available || connectMut.isPending || connecting}
          onClick={() => connectMut.mutate()}
        >
          {connectMut.isPending || connecting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ExternalLink className="size-3.5" />
          )}
          {connecting ? "Waiting…" : meta.brand}
        </Button>
      }
    />
  );
}

function ApiKeyControl({
  field,
  hasKey,
  mutation,
}: {
  field: "anthropicApiKey" | "openaiApiKey";
  hasKey: boolean;
  mutation: SettingsMutation;
}) {
  const [value, setValue] = useState("");

  // Clear the input after a successful save.
  useEffect(() => {
    if (mutation.isSuccess) setValue("");
  }, [mutation.isSuccess]);

  if (hasKey) {
    return (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm text-foreground">
          <Check className="size-4 text-brand" /> Key on file
        </span>
        <Button
          variant="outline"
          size="xs"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ [field]: null } as LlmSettingsUpdate)}
        >
          Remove
        </Button>
      </div>
    );
  }

  const save = () => {
    const trimmed = value.trim();
    if (trimmed) mutation.mutate({ [field]: trimmed } as LlmSettingsUpdate);
  };

  return (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <Input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste your API key"
        autoComplete="off"
        className="sm:w-64"
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      <Button size="xs" disabled={!value.trim() || mutation.isPending} onClick={save}>
        Save
      </Button>
    </div>
  );
}
