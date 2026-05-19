import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeExecServerEvent,
  decodeProtobufValue,
  jsonSchemaToProtobufValue,
} from "../../open-sse/utils/cursorAgentProtobuf";
import {
  collectCompletedToolResults,
  newStreamCtx,
  processFrame,
} from "../../open-sse/executors/cursor";

// ─── Wire-format helpers ───────────────────────────────────────────────────

function v(n: number): Buffer {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}
function tag(field: number, wireType: number): Buffer {
  return v((field << 3) | wireType);
}
function lenPrefixed(field: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), v(payload.length), payload]);
}
function stringField(field: number, value: string): Buffer {
  return lenPrefixed(field, Buffer.from(value, "utf8"));
}
function varintField(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), v(value)]);
}

// Encodes a single map<string, bytes> entry: { key (1): k, value (2): valueBytes }
function mapEntry(field: number, key: string, valueBytes: Buffer): Buffer {
  const entry = Buffer.concat([stringField(1, key), lenPrefixed(2, valueBytes)]);
  return lenPrefixed(field, entry);
}

// AgentServerMessage { exec_server_message (2): ESM { id, exec_id, mcp_args (11): ... } }
function buildMcpArgsEvent(
  execMsgId: number,
  execId: string,
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>
): Buffer {
  const mcaParts: Buffer[] = [
    stringField(1, toolName), // name
    stringField(3, toolCallId), // tool_call_id
  ];
  for (const [k, val] of Object.entries(args)) {
    const valueBytes = jsonSchemaToProtobufValue(val);
    mcaParts.push(mapEntry(2, k, valueBytes)); // args = field 2
  }
  const mca = Buffer.concat(mcaParts);
  const esm = Buffer.concat([
    varintField(1, execMsgId),
    stringField(15, execId),
    lenPrefixed(11, mca),
  ]);
  return lenPrefixed(2, esm);
}

function buildReadArgsEvent(execMsgId: number, execId: string, filePath: string): Buffer {
  const readArgs = stringField(1, filePath);
  const esm = Buffer.concat([
    varintField(1, execMsgId),
    stringField(15, execId),
    lenPrefixed(7, readArgs),
  ]);
  return lenPrefixed(2, esm);
}

function buildWriteArgsEvent(
  execMsgId: number,
  execId: string,
  filePath: string,
  content: string
): Buffer {
  const writeArgs = Buffer.concat([stringField(1, filePath), stringField(2, content)]);
  const esm = Buffer.concat([
    varintField(1, execMsgId),
    stringField(15, execId),
    lenPrefixed(3, writeArgs), // ESM_WRITE_ARGS = 3
  ]);
  return lenPrefixed(2, esm);
}

function buildShellArgsEvent(
  execMsgId: number,
  execId: string,
  command: string,
  workingDir = ""
): Buffer {
  const shellArgs = Buffer.concat([
    stringField(1, command),
    workingDir ? stringField(2, workingDir) : Buffer.alloc(0),
  ]);
  const esm = Buffer.concat([
    varintField(1, execMsgId),
    stringField(15, execId),
    lenPrefixed(2, shellArgs), // ESM_SHELL_ARGS = 2
  ]);
  return lenPrefixed(2, esm);
}

// ─── decodeProtobufValue round-trip tests ──────────────────────────────────

test("decodeProtobufValue round-trips primitives", () => {
  assert.equal(decodeProtobufValue(jsonSchemaToProtobufValue("hi") as Buffer), "hi");
  assert.equal(decodeProtobufValue(jsonSchemaToProtobufValue(42.5)), 42.5);
  assert.equal(decodeProtobufValue(jsonSchemaToProtobufValue(true)), true);
  assert.equal(decodeProtobufValue(jsonSchemaToProtobufValue(false)), false);
  assert.equal(decodeProtobufValue(jsonSchemaToProtobufValue(null)), null);
});

test("decodeProtobufValue round-trips a flat object", () => {
  const obj = { name: "alice", age: 30, active: true };
  const encoded = jsonSchemaToProtobufValue(obj);
  assert.deepEqual(decodeProtobufValue(encoded), obj);
});

test("decodeProtobufValue round-trips an array of strings", () => {
  const arr = ["a", "b", "c"];
  const encoded = jsonSchemaToProtobufValue(arr);
  assert.deepEqual(decodeProtobufValue(encoded), arr);
});

test("decodeProtobufValue round-trips a nested object with mixed types", () => {
  const obj = {
    city: "Paris",
    coords: { lat: 48.8566, lng: 2.3522 },
    tags: ["europe", "capital"],
    populated: true,
    sister_city: null,
  };
  const encoded = jsonSchemaToProtobufValue(obj);
  assert.deepEqual(decodeProtobufValue(encoded), obj);
});

test("decodeProtobufValue handles deeply nested OpenAI tool args", () => {
  const args = {
    location: { city: "Tokyo", country: "JP" },
    units: "metric",
    days: 7,
  };
  const encoded = jsonSchemaToProtobufValue(args);
  assert.deepEqual(decodeProtobufValue(encoded), args);
});

// ─── McpArgs decoding tests ────────────────────────────────────────────────

test("decodeExecServerEvent populates args dict from McpArgs map entries", () => {
  const args = { city: "Paris", units: "celsius" };
  const event = decodeExecServerEvent(
    buildMcpArgsEvent(1, "exec-w", "get_weather", "call_abc", args)
  );
  assert.equal(event?.kind, "exec_mcp");
  if (event?.kind !== "exec_mcp") return;
  assert.equal(event.toolName, "get_weather");
  assert.equal(event.toolCallId, "call_abc");
  assert.deepEqual(event.args, args);
});

test("decodeExecServerEvent handles McpArgs with empty args", () => {
  const event = decodeExecServerEvent(buildMcpArgsEvent(1, "exec-x", "no_args_tool", "call_x", {}));
  if (event?.kind !== "exec_mcp") throw new Error("expected exec_mcp");
  assert.deepEqual(event.args, {});
});

test("decodeExecServerEvent handles McpArgs with nested object args", () => {
  const args = {
    location: { city: "London", country: "UK" },
    days: 3,
  };
  const event = decodeExecServerEvent(buildMcpArgsEvent(1, "exec-n", "weather", "call_n", args));
  if (event?.kind !== "exec_mcp") throw new Error("expected exec_mcp");
  assert.deepEqual(event.args, args);
});

// ─── Streaming SSE tool_calls emission ─────────────────────────────────────

function parseChunk(line: string): {
  delta?: {
    tool_calls?: Array<{
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
} {
  return JSON.parse(line.replace(/^data: /, "").trim()).choices[0];
}

test("processFrame emits OpenAI tool_calls deltas for an mcp_args event", () => {
  const emitted: string[] = [];
  const ctx = newStreamCtx("auto", (s) => emitted.push(s));
  const payload = buildMcpArgsEvent(1, "exec-tc", "get_weather", "cursor_call_x", {
    city: "Paris",
  });
  processFrame(payload, ctx, new Set());

  // Expect: role chunk + tool_calls init chunk + tool_calls args chunk
  assert.equal(emitted.length, 3);
  const roleChunk = parseChunk(emitted[0]);
  assert.ok(roleChunk.delta);
  // Init chunk: id + name
  const initChunk = parseChunk(emitted[1]);
  const initCall = initChunk.delta?.tool_calls?.[0];
  assert.equal(initCall?.index, 0);
  assert.match(initCall?.id ?? "", /^call_/);
  assert.equal(initCall?.function?.name, "get_weather");
  assert.equal(initCall?.function?.arguments, "");
  // Args chunk
  const argsChunk = parseChunk(emitted[2]);
  const argsCall = argsChunk.delta?.tool_calls?.[0];
  assert.equal(argsCall?.index, 0);
  assert.equal(argsCall?.function?.arguments, JSON.stringify({ city: "Paris" }));

  // Side-effects on ctx
  assert.equal(ctx.toolCalls.length, 1);
  assert.equal(ctx.toolCalls[0].name, "get_weather");
  assert.equal(ctx.emittedToolCallIndex, 1);
});

test("processFrame indexes parallel tool calls sequentially", () => {
  const emitted: string[] = [];
  const ctx = newStreamCtx("auto", (s) => emitted.push(s));
  const acked = new Set<string>();
  processFrame(buildMcpArgsEvent(1, "exec-1", "tool_a", "ca", { x: 1 }), ctx, acked);
  processFrame(buildMcpArgsEvent(2, "exec-2", "tool_b", "cb", { y: 2 }), ctx, acked);
  assert.equal(ctx.toolCalls.length, 2);
  assert.equal(ctx.emittedToolCallIndex, 2);
  // emitted[0] = role chunk
  // emitted[1] = init for tool_a (index=0)
  // emitted[2] = args for tool_a (index=0)
  // emitted[3] = init for tool_b (index=1)
  // emitted[4] = args for tool_b (index=1)
  const initB = parseChunk(emitted[3]);
  assert.equal(initB.delta?.tool_calls?.[0].index, 1);
  assert.equal(initB.delta?.tool_calls?.[0].function?.name, "tool_b");
});

test("processFrame emits text + tool_calls in mixed order", () => {
  const emitted: string[] = [];
  const ctx = newStreamCtx("auto", (s) => emitted.push(s));
  const acked = new Set<string>();

  // Build a text_delta payload
  function textDelta(text: string): Buffer {
    const tdu = lenPrefixed(1, Buffer.from(text, "utf8"));
    const iu = lenPrefixed(1, tdu);
    return lenPrefixed(1, iu);
  }

  processFrame(textDelta("Let me check"), ctx, acked);
  processFrame(buildMcpArgsEvent(1, "exec-mix", "lookup", "c1", {}), ctx, acked);

  assert.equal(ctx.totalText, "Let me check");
  assert.equal(ctx.toolCalls.length, 1);
  // Order: role chunk, content chunk, tool_call init, tool_call args
  assert.equal(emitted.length, 4);
  const contentChunk = JSON.parse(emitted[1].replace(/^data: /, "").trim());
  assert.equal(contentChunk.choices[0].delta.content, "Let me check");
  const initChunk = JSON.parse(emitted[2].replace(/^data: /, "").trim());
  assert.ok(initChunk.choices[0].delta.tool_calls);
});

test("processFrame doesn't emit tool_calls for the same exec_id twice", () => {
  const emitted: string[] = [];
  const ctx = newStreamCtx("auto", (s) => emitted.push(s));
  const acked = new Set<string>();
  const payload = buildMcpArgsEvent(1, "exec-dup", "tool", "cd", {});
  processFrame(payload, ctx, acked);
  processFrame(payload, ctx, acked);
  assert.equal(ctx.toolCalls.length, 1);
});

test("processFrame converts repeated completed MCP tool calls into final text", () => {
  const emitted: string[] = [];
  const ctx = newStreamCtx("auto", (s) => emitted.push(s), [
    {
      name: "get_weather",
      argumentsJson: JSON.stringify({ city: "Paris" }),
      content: "sunny, 22C",
    },
  ]);
  const payload = buildMcpArgsEvent(1, "exec-repeat", "get_weather", "cursor_call_x", {
    city: "Paris",
  });

  processFrame(payload, ctx, new Set());

  assert.equal(ctx.endReason, "turn_ended");
  assert.equal(ctx.toolCalls.length, 0);
  assert.equal(ctx.totalText, "sunny, 22C");
  const contentChunk = JSON.parse(emitted[1].replace(/^data: /, "").trim());
  assert.equal(contentChunk.choices[0].delta.content, "sunny, 22C");
});

test("processFrame surfaces Cursor built-in read as a matching OpenAI tool_call", () => {
  const emitted: string[] = [];
  const ctx = newStreamCtx("auto", (s) => emitted.push(s));
  const acked = new Set<string>();

  processFrame(buildReadArgsEvent(11, "exec-read", "/tmp/foo.txt"), ctx, acked, {
    mcpTools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchemaBytes: Buffer.alloc(0),
        toolName: "read_file",
      },
    ],
  });

  assert.equal(ctx.endReason, "tool_calls");
  assert.equal(ctx.toolCalls.length, 1);
  assert.equal(ctx.toolCalls[0].name, "read_file");
  assert.equal(ctx.toolCalls[0].argumentsJson, JSON.stringify({ path: "/tmp/foo.txt" }));

  const initChunk = parseChunk(emitted[1]);
  assert.equal(initChunk.delta?.tool_calls?.[0].function?.name, "read_file");
  const argsChunk = parseChunk(emitted[2]);
  assert.equal(argsChunk.delta?.tool_calls?.[0].function?.arguments, '{"path":"/tmp/foo.txt"}');
});

// ─── Schema-aware translation of cursor built-ins onto client tools ────────
//
// Cursor's models (especially composer-2 / composer-2.5) emit tool calls
// through cursor's built-in tools (exec_read, exec_write, exec_shell) with
// cursor's wire arg names (`path`, `command`). Clients like opencode declare
// their own tools with different schemas (`filePath`, `command + description`).
// processFrame must rewrite cursor's native args onto whatever shape the
// client actually declared, otherwise opencode rejects every call with
// SchemaError and the agent loop is stuck reading a file that doesn't exist.

test("processFrame translates exec_read path → filePath for opencode-style schema", () => {
  const emitted: string[] = [];
  const ctx = newStreamCtx("auto", (s) => emitted.push(s));
  const acked = new Set<string>();

  processFrame(buildReadArgsEvent(11, "exec-read", "/tmp/foo.txt"), ctx, acked, {
    mcpTools: [
      {
        name: "read",
        description: "Read a file",
        inputSchemaBytes: Buffer.alloc(0),
        toolName: "read",
      },
    ],
    rawTools: [
      {
        type: "function",
        function: {
          name: "read",
          parameters: {
            type: "object",
            properties: { filePath: { type: "string" }, offset: { type: "number" } },
            required: ["filePath"],
          },
        },
      },
    ],
  });

  assert.equal(ctx.toolCalls.length, 1);
  assert.equal(ctx.toolCalls[0].name, "read");
  assert.equal(ctx.toolCalls[0].argumentsJson, JSON.stringify({ filePath: "/tmp/foo.txt" }));
});

test("processFrame translates exec_write to opencode write({filePath, content})", () => {
  const emitted: string[] = [];
  const ctx = newStreamCtx("auto", (s) => emitted.push(s));
  const acked = new Set<string>();

  processFrame(
    buildWriteArgsEvent(12, "exec-write", "/tmp/fib.cpp", "int main(){}\n"),
    ctx,
    acked,
    {
      mcpTools: [
        {
          name: "write",
          description: "Write a file",
          inputSchemaBytes: Buffer.alloc(0),
          toolName: "write",
        },
      ],
      rawTools: [
        {
          type: "function",
          function: {
            name: "write",
            parameters: {
              type: "object",
              properties: { filePath: { type: "string" }, content: { type: "string" } },
              required: ["filePath", "content"],
            },
          },
        },
      ],
    }
  );

  assert.equal(ctx.endReason, "tool_calls");
  assert.equal(ctx.toolCalls.length, 1);
  assert.equal(ctx.toolCalls[0].name, "write");
  assert.equal(
    ctx.toolCalls[0].argumentsJson,
    JSON.stringify({ filePath: "/tmp/fib.cpp", content: "int main(){}\n" })
  );
});

test("processFrame falls back to cursor's native arg name when no schema is given", () => {
  // Hermes flow: tool registered as `read_file` with `path` param. With no
  // raw OpenAI tool list available, the mapper must use cursor's native
  // `path` field name so legacy callers continue to work — even before any
  // schema-aware client was a thing.
  const ctx = newStreamCtx("auto", () => {});
  processFrame(buildReadArgsEvent(13, "exec-read-hermes", "/tmp/foo.txt"), ctx, new Set(), {
    mcpTools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchemaBytes: Buffer.alloc(0),
        toolName: "read_file",
      },
    ],
    // rawTools intentionally omitted
  });
  assert.equal(ctx.toolCalls[0].argumentsJson, JSON.stringify({ path: "/tmp/foo.txt" }));
});

test("processFrame translates exec_shell onto opencode bash, populating required description", () => {
  // opencode's `bash` tool requires both `command` and `description`. Cursor
  // sends only the command — we inject a placeholder description so the
  // schema validation in the client doesn't reject the call.
  const ctx = newStreamCtx("auto", () => {});
  processFrame(buildShellArgsEvent(14, "exec-sh", "ls -la /tmp"), ctx, new Set(), {
    mcpTools: [
      {
        name: "bash",
        description: "Run shell",
        inputSchemaBytes: Buffer.alloc(0),
        toolName: "bash",
      },
    ],
    rawTools: [
      {
        type: "function",
        function: {
          name: "bash",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string" },
              description: { type: "string" },
            },
            required: ["command", "description"],
          },
        },
      },
    ],
  });
  assert.equal(ctx.toolCalls.length, 1);
  assert.equal(ctx.toolCalls[0].name, "bash");
  const args = JSON.parse(ctx.toolCalls[0].argumentsJson);
  assert.equal(args.command, "ls -la /tmp");
  assert.equal(typeof args.description, "string");
  assert.ok(args.description.length > 0);
});

test("processFrame converts repeated completed built-in read calls into final text", () => {
  const emitted: string[] = [];
  const ctx = newStreamCtx("auto", (s) => emitted.push(s), [
    {
      name: "read_file",
      argumentsJson: JSON.stringify({ path: "/tmp/foo.txt" }),
      content: JSON.stringify({ content: "     1|hello from foo", total_lines: 1 }),
    },
  ]);

  processFrame(buildReadArgsEvent(11, "exec-read-repeat", "/tmp/foo.txt"), ctx, new Set(), {
    mcpTools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchemaBytes: Buffer.alloc(0),
        toolName: "read_file",
      },
    ],
  });

  assert.equal(ctx.endReason, "turn_ended");
  assert.equal(ctx.toolCalls.length, 0);
  assert.equal(ctx.totalText, "hello from foo");
  const contentChunk = JSON.parse(emitted[1].replace(/^data: /, "").trim());
  assert.equal(contentChunk.choices[0].delta.content, "hello from foo");
});

test("processFrame extracts read_file content from truncated JSON-ish tool results", () => {
  const emitted: string[] = [];
  const ctx = newStreamCtx("auto", (s) => emitted.push(s), [
    {
      name: "read_file",
      argumentsJson: JSON.stringify({ path: "/tmp/foo.txt" }),
      content: '{"content": "     1|hello from foo", "total_lines": 0, "is_i...',
    },
  ]);

  processFrame(buildReadArgsEvent(11, "exec-read-repeat", "/tmp/foo.txt"), ctx, new Set(), {
    mcpTools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchemaBytes: Buffer.alloc(0),
        toolName: "read_file",
      },
    ],
  });

  assert.equal(ctx.endReason, "turn_ended");
  assert.equal(ctx.totalText, "hello from foo");
});

test("collectCompletedToolResults handles cursor-translated tool result blocks", () => {
  const results = collectCompletedToolResults([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_read",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"/tmp/foo.txt"}' },
        },
      ],
    },
    {
      role: "user",
      content:
        "<tool_result>\n" +
        "<tool_name>read_file</tool_name>\n" +
        "<tool_call_id>call_read</tool_call_id>\n" +
        "<result>{&quot;content&quot;: &quot;     1|hello from foo&quot;}</result>\n" +
        "</tool_result>",
    },
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].name, "read_file");
  assert.equal(results[0].argumentsJson, '{"path":"/tmp/foo.txt"}');
  assert.equal(results[0].content, '{"content": "     1|hello from foo"}');
});
