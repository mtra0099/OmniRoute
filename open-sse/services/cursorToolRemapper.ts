/**
 * Cursor tool-name remapping for csr/ (openai-compatible → Cursor backend) providers.
 *
 * Cursor-served models (composer-2.5, claude/grok/gpt via Cursor) are hard-trained
 * on Cursor / Claude-Code tool names (Read, Write, Edit, Grep, Glob, Bash, LS). When
 * a client like Hermes provides tools named read_file / search_files / write_file /
 * patch / terminal, these models either hallucinate the Cursor names (→ "tool does not
 * exist" → spiral) or refuse outright ("I'm in ask mode") because they don't recognise
 * the provided tools as real tools.
 *
 * Fix: on the request, rename the client's tools to the Cursor-native names the model
 * expects (keeping the client's OWN parameter schema — instruction-following models use
 * the declared schema, so args stay client-shaped). We record cursorName → originalName
 * in body._toolNameMap; chatCore extracts that into the response toolNameMap, and the
 * passthrough stream restores the original names on the model's tool_calls so the client
 * executes its real tools.
 */

const INTENT_TO_CURSOR: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  search: "Grep",
  glob: "Glob",
  shell: "Bash",
  list: "LS",
};

// Classify a client tool name into a Cursor intent. Order matters (most specific first).
function classifyToolName(name: string): string | null {
  const n = name.toLowerCase();
  if (/^(edit|patch|apply_patch|str_replace|multiedit|multi_edit)$/.test(n)) return "edit";
  if (/^(read_file|read|cat|view_file|open_file)$/.test(n)) return "read";
  if (/^(write_file|write|create_file|save_file)$/.test(n)) return "write";
  if (/^(search_files|search|grep|ripgrep|rg|find_in_files|code_search)$/.test(n)) return "search";
  if (/^(glob|find_files|file_search)$/.test(n)) return "glob";
  if (/^(terminal|bash|shell|sh|run_command|execute_command|run_shell|exec_command)$/.test(n))
    return "shell";
  if (/^(ls|list_dir|list_files|list_directory)$/.test(n)) return "list";
  return null;
}

type ToolFn = { name?: unknown };
type Tool = { function?: ToolFn; name?: unknown; type?: unknown };

function toolName(t: Tool): string {
  const fnName = (t.function as ToolFn | undefined)?.name;
  if (typeof fnName === "string" && fnName) return fnName;
  return typeof t.name === "string" ? t.name : "";
}
function setToolName(t: Tool, name: string): void {
  if (t.function && typeof t.function === "object") (t.function as { name?: unknown }).name = name;
  else (t as { name?: unknown }).name = name;
}

/**
 * Rename client tools to Cursor-native names in-place, record the reverse map in
 * body._toolNameMap (non-enumerable so it never leaks upstream). Also rewrites
 * assistant tool_calls in message history for naming consistency across turns.
 * Returns true if anything changed.
 */
export function remapCursorToolNamesInRequest(body: Record<string, unknown>): boolean {
  const tools = Array.isArray(body.tools) ? (body.tools as Tool[]) : [];
  if (tools.length === 0) return false;

  const map: Map<string, string> =
    body._toolNameMap instanceof Map ? (body._toolNameMap as Map<string, string>) : new Map();

  // Build originalName → cursorName for this request (1 client tool per intent).
  const origToCursor = new Map<string, string>();
  const claimedCursorNames = new Set<string>();
  let changed = false;

  for (const tool of tools) {
    const orig = toolName(tool);
    if (!orig) continue;
    const intent = classifyToolName(orig);
    if (!intent) continue; // leave non-core tools (delegate_task, todowrite, memory, ...) untouched
    const cursorName = INTENT_TO_CURSOR[intent];
    if (cursorName === orig) continue; // already Cursor-named
    if (claimedCursorNames.has(cursorName)) continue; // first client tool wins the Cursor name
    claimedCursorNames.add(cursorName);
    origToCursor.set(orig, cursorName);
    setToolName(tool, cursorName);
    map.set(cursorName, orig);
    changed = true;
  }

  if (!changed) return false;

  // Rewrite assistant tool_calls in history so the model sees consistent names.
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  for (const msg of messages) {
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls as Record<string, unknown>[]) {
      const fn = tc?.function as { name?: unknown } | undefined;
      const nm = typeof fn?.name === "string" ? fn.name : "";
      const mapped = origToCursor.get(nm);
      if (mapped) fn!.name = mapped;
    }
  }

  Object.defineProperty(body, "_toolNameMap", {
    value: map,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return true;
}
