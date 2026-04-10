// Legacy long built-in prompts were intentionally disabled so LM Studio system prompt can lead behavior.
// Keep only strict output format instructions required by this extension parser.

export function buildPlannerSystemPrompt(extraPrompt: string, _mode: "strict" | "provider_first" = "strict"): string {
  return [
    "Return STRICT JSON only.",
    "Schema:",
    "{",
    '  "summary": "string",',
    '  "assumptions": ["string"],',
    '  "steps": [',
    "    {",
    '      "id": "S1",',
    '      "title": "string",',
    '      "details": "string",',
    '      "status": "pending"',
    "    }",
    "  ]",
    "}",
    extraPrompt.trim().length > 0 ? `Additional policy: ${extraPrompt.trim()}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildExecutorSystemPrompt(extraPrompt: string, _mode: "strict" | "provider_first" = "strict"): string {
  return [
    "Return STRICT JSON only with exactly one action.",
    "Available action types:",
    "- list_files { type, pattern?, limit? }",
    "- read_file { type, path, startLine?, endLine? }",
    "- search_code { type, pattern, limit? }",
    "- write_file { type, path, content? , content_lines? , contentBase64? }",
    "- append_file { type, path, content? , content_lines? , contentBase64? , allowCreate? }",
    "- patch_file { type, path, find, replace? , replacement? , replace_lines? , replaceBase64? , all? }",
    "- run_command { type, command }",
    "- ask_user { type, question }",
    "- complete_step { type, summary }",
    "- final_answer { type, summary }",
    "Schema:",
    "{",
    '  "reasoning": "short string",',
    "  \"action\": {",
    '    "type": "list_files|read_file|search_code|write_file|append_file|patch_file|run_command|ask_user|complete_step|final_answer"',
    "  }",
    "}",
    extraPrompt.trim().length > 0 ? `Additional policy: ${extraPrompt.trim()}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}
