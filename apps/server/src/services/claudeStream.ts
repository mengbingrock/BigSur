// Translates a single line of the claude CLI's `stream-json` output into the
// SSE events the chat client consumes. Kept dependency-free (only the event
// object, the `send` callback, and per-block bookkeeping maps) so it's directly
// unit-testable without spinning up the whole route.
//
// Two sources of tool_use input are handled, on purpose:
//  - `stream_event` partial deltas (content_block_start/delta/stop) drive the
//    live streaming UI.
//  - the complete `assistant` message carries the *authoritative* tool input.
//    Partial deltas can be missing or cut short when the CLI tears a block down
//    early (notably AskUserQuestion, which it can't run headless), so we emit
//    the real input from the assistant message too — the client applies it
//    idempotently, which is what keeps the question card from getting stuck on
//    "(still streaming…)".

export function handleEvent(
  evt: Record<string, unknown>,
  send: (event: string, data: unknown) => void,
  blockType: Map<number, string>,
  blockId: Map<number, string>,
  blockName: Map<number, string>,
  blockInputJson: Map<number, string>,
  onQuestionAsked?: () => void,
) {
  const type = evt.type;

  if (type === "system") {
    const sub = evt.subtype;
    if (sub === "init") {
      send("init", {
        model: evt.model,
        session_id: evt.session_id,
        cwd: evt.cwd,
        permission_mode: evt.permissionMode,
        api_key_source: evt.apiKeySource,
        claude_code_version: evt.claude_code_version,
        tools: evt.tools,
        skills: evt.skills,
        slash_commands: evt.slash_commands,
      });
    } else if (sub === "status") {
      send("status", { status: evt.status });
    }
    return;
  }

  if (type === "stream_event") {
    const inner = (evt as { event?: Record<string, unknown> }).event;
    if (!inner || typeof inner !== "object") return;
    const innerType = inner.type;

    if (innerType === "message_start") {
      const msg = inner.message as { id?: string } | undefined;
      send("message_start", { id: msg?.id });
      return;
    }
    if (innerType === "content_block_start") {
      const index = inner.index as number;
      const block = inner.content_block as Record<string, unknown> | undefined;
      if (!block) return;
      const bt = block.type as string;
      blockType.set(index, bt);
      if (bt === "thinking") {
        send("thinking_start", { index });
      } else if (bt === "tool_use") {
        const id = block.id as string;
        const name = block.name as string;
        blockId.set(index, id);
        blockName.set(index, name);
        blockInputJson.set(index, "");
        send("tool_start", { index, id, name });
      } else if (bt === "text") {
        send("text_start", { index });
      }
      return;
    }
    if (innerType === "content_block_delta") {
      const index = inner.index as number;
      const delta = inner.delta as Record<string, unknown> | undefined;
      if (!delta) return;
      const dt = delta.type;
      if (dt === "text_delta" && typeof delta.text === "string") {
        send("delta", { index, text: delta.text });
      } else if (dt === "thinking_delta" && typeof delta.thinking === "string") {
        send("thinking_delta", { index, text: delta.thinking });
      } else if (dt === "input_json_delta" && typeof delta.partial_json === "string") {
        const prev = blockInputJson.get(index) ?? "";
        blockInputJson.set(index, prev + delta.partial_json);
        // Key the delta by the tool_use id so the client can match it to the
        // activity item (which it tracks by id, like tool_start/tool_stop).
        send("tool_input_delta", {
          index,
          id: blockId.get(index),
          partial_json: delta.partial_json,
        });
      }
      return;
    }
    if (innerType === "content_block_stop") {
      const index = inner.index as number;
      const bt = blockType.get(index);
      if (bt === "thinking") {
        send("thinking_stop", { index });
      } else if (bt === "tool_use") {
        const id = blockId.get(index);
        const name = blockName.get(index);
        const inputRaw = blockInputJson.get(index) ?? "";
        let parsedInput: unknown = null;
        try {
          parsedInput = inputRaw ? JSON.parse(inputRaw) : {};
        } catch {
          parsedInput = inputRaw;
        }
        send("tool_stop", { index, id, name, input: parsedInput, inputRaw });
        // AskUserQuestion can't run in the headless CLI — it returns a tool
        // error, which makes the model "fall back to defaults" and finish the
        // turn. Instead, end the turn here: the card is already rendered client
        // side and the user's picks return as the next user message. The model
        // never sees the error and never invents answers.
        if (name === "AskUserQuestion") onQuestionAsked?.();
      } else if (bt === "text") {
        send("text_stop", { index });
      }
      return;
    }
    if (innerType === "message_delta") {
      const usage = (inner as { usage?: unknown }).usage;
      const stopReason = (inner.delta as Record<string, unknown> | undefined)?.stop_reason;
      send("message_delta", { stop_reason: stopReason, usage });
      return;
    }
    if (innerType === "message_stop") {
      send("message_stop", {});
      return;
    }
    return;
  }

  if (type === "assistant") {
    // The complete assistant message carries the authoritative, fully-formed
    // tool_use input. Emit it so the client always has the real input, even when
    // the partial-stream deltas were missing or cut short (see file header).
    const message = evt.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const item of content as Record<string, unknown>[]) {
      if (item.type !== "tool_use") continue;
      send("tool_input", { id: item.id, name: item.name, input: item.input ?? null });
    }
    return;
  }

  if (type === "user") {
    const message = evt.message as Record<string, unknown> | undefined;
    if (!message) return;
    const content = message.content;
    if (!Array.isArray(content)) return;
    for (const item of content as Record<string, unknown>[]) {
      if (item.type !== "tool_result") continue;
      send("tool_result", {
        id: item.tool_use_id,
        is_error: Boolean(item.is_error),
        content: item.content,
      });
    }
    return;
  }

  if (type === "result") {
    send("result", {
      subtype: evt.subtype,
      duration_ms: evt.duration_ms,
      duration_api_ms: evt.duration_api_ms,
      total_cost_usd: evt.total_cost_usd,
      num_turns: evt.num_turns,
      usage: evt.usage,
      permission_denials: evt.permission_denials,
      is_error: evt.is_error,
      result: evt.result,
    });
    return;
  }
}
