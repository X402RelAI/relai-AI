// Generic Anthropic agentic loop: keeps calling claude.messages.create() with
// the running tool transcript until the model returns `stop_reason: "end_turn"`
// or hits a step cap.
//
// `tools` is an array of `{ name, description, input_schema, run(args) → result }`.
// `systemBlocks` is an array of strings — each becomes a `{type: "text"}` block
// in the system prompt. The LAST block gets `cache_control: ephemeral` so the
// stable prefix (skill body, references) is cached. See Anthropic prompt
// caching docs: https://docs.claude.com/en/docs/build-with-claude/prompt-caching
//
// `onAssistantText(text)` streams the assistant's intermediate text to stdout
// for live observability.

import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_STEPS = 40;

function blockText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export async function runAgent({
  apiKey,
  systemBlocks,
  initialUserMessage,
  tools,
  onAssistantText,
  onToolCall,
  onToolResult,
  model = DEFAULT_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
  maxSteps = DEFAULT_MAX_STEPS,
}) {
  if (!Array.isArray(systemBlocks) || systemBlocks.length === 0) {
    throw new Error("runAgent: systemBlocks must be a non-empty string[]");
  }

  const client = new Anthropic({ apiKey });

  const toolDefs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  const messages = [{ role: "user", content: initialUserMessage }];

  // Build the system prompt as multiple text blocks. cache_control on the
  // last block tags the entire stable prefix (persona + skill body +
  // references) for ephemeral cache. Saves 70–90% of input tokens across
  // the multi-step tool loop.
  const builtSystemBlocks = systemBlocks.map((text, idx) => {
    const block = { type: "text", text };
    if (idx === systemBlocks.length - 1) {
      block.cache_control = { type: "ephemeral" };
    }
    return block;
  });

  for (let step = 0; step < maxSteps; step += 1) {
    const resp = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: builtSystemBlocks,
      tools: toolDefs,
      messages,
    });

    const text = blockText(resp.content);
    if (text && onAssistantText) onAssistantText(text);

    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason === "end_turn") {
      return { messages, lastResponse: resp };
    }

    if (resp.stop_reason !== "tool_use") {
      return { messages, lastResponse: resp };
    }

    // Run every requested tool call and append a single user message with
    // all tool_result blocks (Anthropic spec).
    const toolResultBlocks = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      const tool = tools.find((t) => t.name === block.name);
      if (!tool) {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Tool "${block.name}" is not available to this agent.`,
          is_error: true,
        });
        continue;
      }
      if (onToolCall) onToolCall({ name: block.name, input: block.input });
      let result;
      let isError = false;
      try {
        result = await tool.run(block.input);
      } catch (err) {
        result = `Tool "${block.name}" threw: ${(err).message || String(err)}`;
        isError = true;
      }
      const stringified =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      if (onToolResult) onToolResult({ name: block.name, result: stringified, isError });
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: stringified,
        is_error: isError,
      });
    }

    messages.push({ role: "user", content: toolResultBlocks });
  }

  throw new Error(`agent exceeded ${maxSteps} steps without ending`);
}
