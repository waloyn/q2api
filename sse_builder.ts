export function sse_format(eventType: string, data: any): string {
  const jsonData = JSON.stringify(data);
  return `event: ${eventType}\ndata: ${jsonData}\n\n`;
}

export function build_message_start(conversationId: string, model: string = "claude-sonnet-4.5", inputTokens: number = 0): string {
  const data = {
    type: "message_start",
    message: {
      id: conversationId,
      type: "message",
      role: "assistant",
      content: [],
      model: model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 }
    }
  };
  return sse_format("message_start", data);
}

export function build_content_block_start(index: number, blockType: string = "text"): string {
  const data = {
    type: "content_block_start",
    index: index,
    content_block: blockType === "text" ? { type: "text", text: "" } : { type: blockType }
  };
  return sse_format("content_block_start", data);
}

export function build_content_block_delta(index: number, text: string): string {
  const data = {
    type: "content_block_delta",
    index: index,
    delta: { type: "text_delta", text: text }
  };
  return sse_format("content_block_delta", data);
}

export function build_content_block_stop(index: number): string {
  const data = {
    type: "content_block_stop",
    index: index
  };
  return sse_format("content_block_stop", data);
}

export function build_ping(): string {
  return sse_format("ping", { type: "ping" });
}

export function build_message_stop(inputTokens: number, outputTokens: number, stopReason: string | null = null): string {
  const deltaData = {
    type: "message_delta",
    delta: { stop_reason: stopReason || "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens }
  };
  const deltaEvent = sse_format("message_delta", deltaData);

  const stopData = { type: "message_stop" };
  const stopEvent = sse_format("message_stop", stopData);

  return deltaEvent + stopEvent;
}

export function build_tool_use_start(index: number, toolUseId: string, toolName: string): string {
  const data = {
    type: "content_block_start",
    index: index,
    content_block: {
      type: "tool_use",
      id: toolUseId,
      name: toolName,
      input: {}
    }
  };
  return sse_format("content_block_start", data);
}

export function build_tool_use_input_delta(index: number, inputJsonDelta: string): string {
  const data = {
    type: "content_block_delta",
    index: index,
    delta: {
      type: "input_json_delta",
      partial_json: inputJsonDelta
    }
  };
  return sse_format("content_block_delta", data);
}
