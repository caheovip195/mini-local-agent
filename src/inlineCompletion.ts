import * as vscode from "vscode";

import { LmStudioClient, type ChatMessage, type ThinkingEffort } from "./lmStudioClient";
import { extractJsonObject } from "./utils";

const DEFAULT_LM_BASE_URL = "http://127.0.0.1:1234/v1";
const MAX_CACHE_ITEMS = 120;
const MAX_INLINE_CANDIDATES = 6;
const COMMENT_WINDOW_LINES = 16;
const COMMENT_MAX_ITEMS = 10;
const INLINE_MAX_LINES = 14;

interface CacheValue {
  items: string[];
  timestamp: number;
}

export class LocalInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly cache = new Map<string, CacheValue>();

  constructor(private readonly output: vscode.OutputChannel) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[]> {
    const cfg = vscode.workspace.getConfiguration("localAgent");
    const enabled = cfg.get<boolean>("inline.enabled", true);
    if (!enabled || token.isCancellationRequested) {
      return [];
    }

    const line = document.lineAt(position.line);
    const linePrefix = line.text.slice(0, position.character);
    const lineSuffix = line.text.slice(position.character);
    const minPrefixChars = Math.max(0, cfg.get<number>("inline.minPrefixChars", 1));
    if (linePrefix.trim().length < minPrefixChars) {
      return [];
    }

    const debounceMs = Math.max(0, cfg.get<number>("inline.debounceMs", 180));
    if (debounceMs > 0) {
      await this.delay(debounceMs, token);
      if (token.isCancellationRequested) {
        return [];
      }
    }

    const providerPresetRaw = cfg.get<string>("provider.preset", "lmstudio").trim().toLowerCase();
    const configuredPreset = providerPresetRaw === "custom" ? "custom" : "lmstudio";
    const providerPreset = configuredPreset;
    const legacyBaseUrl = cfg.get<string>("lmStudio.baseUrl", DEFAULT_LM_BASE_URL);
    const providerBaseUrl = cfg.get<string>("provider.baseUrl", "").trim();
    const baseDefault = legacyBaseUrl;
    const baseInput = providerPreset === "custom" ? providerBaseUrl || legacyBaseUrl : legacyBaseUrl;
    const lmBaseUrl = this.normalizeBaseUrl(baseInput, baseDefault);

    const legacyApiKey = this.normalizeApiKey(cfg.get<string>("lmStudio.apiKey", ""));
    const providerApiKey = this.normalizeApiKey(cfg.get<string>("provider.apiKey", ""));
    const apiKey =
      providerPreset === "custom"
        ? providerApiKey.length > 0
          ? providerApiKey
          : legacyApiKey
        : providerApiKey.length > 0
          ? providerApiKey
          : legacyApiKey;

    const configuredModel = cfg.get<string>("lmStudio.model", "qwen2.5-coder-7b-instruct");
    const providerModel = cfg.get<string>("provider.model", "").trim();
    const providerApiModeRaw = cfg.get<string>("provider.apiMode", "chat_completions").trim().toLowerCase();
    const providerApiMode = providerApiModeRaw === "responses" ? "responses" : "chat_completions";
    const providerPresetName = cfg.get<string>("provider.presetName", "").trim();
    const legacyLmPreset = cfg.get<string>("lmStudio.preset", "").trim();
    const presetName = providerPresetName || legacyLmPreset;
    const inlineModel = cfg.get<string>("inline.model", "").trim();
    const defaultModel = providerPreset === "custom" ? providerModel || configuredModel : configuredModel;
    const model = inlineModel.length > 0 ? inlineModel : defaultModel;
    const providerChatPathDefault = providerApiMode === "responses" ? "/responses" : "/chat/completions";
    const providerChatPathRaw = cfg.get<string>("provider.chatPath", providerChatPathDefault);
    const providerChatPathNormalized = this.normalizeApiPath(providerChatPathRaw, providerChatPathDefault);
    const chatPath =
      providerApiMode === "responses" && providerChatPathNormalized === "/chat/completions"
        ? "/responses"
        : providerChatPathNormalized;
    const extraHeaders = this.parseHeaderJson(cfg.get<string>("provider.extraHeaders", "{}"));
    const extraBody = this.parseBodyJson(cfg.get<string>("provider.extraBody", "{}"));
    if (presetName.length > 0 && !Object.prototype.hasOwnProperty.call(extraBody, "preset")) {
      extraBody.preset = presetName;
    }
    const headers: Record<string, string> = { ...extraHeaders };
    const maxTokens = Math.min(Math.max(cfg.get<number>("inline.maxTokens", 160), 32), 400);
    const maxContextChars = Math.min(Math.max(cfg.get<number>("inline.maxContextChars", 6000), 1200), 20000);
    const maxSuggestionChars = Math.min(Math.max(cfg.get<number>("inline.maxSuggestionChars", 420), 80), 4000);
    const maxCandidates = Math.min(Math.max(cfg.get<number>("inline.maxCandidates", 3), 1), MAX_INLINE_CANDIDATES);
    const verboseLog = cfg.get<boolean>("inline.verboseLog", false);
    const globalThinkingEnabled = cfg.get<boolean>("thinking.enabled", false);
    const globalThinkingEffort = this.normalizeThinkingEffort(cfg.get<string>("thinking.effort", "medium"));
    const inlineThinkingEnabled = cfg.get<boolean>("inline.thinking.enabled", globalThinkingEnabled);
    const inlineThinkingEffort = this.normalizeThinkingEffort(
      cfg.get<string>("inline.thinking.effort", globalThinkingEffort)
    );
    const thinkingEffort: ThinkingEffort | undefined = inlineThinkingEnabled ? inlineThinkingEffort : undefined;

    const before = this.collectBeforeContext(document, position, maxContextChars);
    const after = this.collectAfterContext(document, position, Math.floor(maxContextChars / 2));
    const fileContext = this.collectWholeFileContext(document, Math.min(maxContextChars, 3200));
    const nearbyComments = this.collectNearbyComments(document, position, COMMENT_WINDOW_LINES, COMMENT_MAX_ITEMS);
    const nearbyFunctions = this.collectFunctionCandidates(document, 20);
    const cursorLine = position.line + 1;
    const cursorColumn = position.character + 1;
    const key = this.buildCacheKey(
      document.uri.toString(),
      linePrefix,
      lineSuffix,
      model,
      cursorLine,
      nearbyComments.join("|")
    );
    const cached = this.cache.get(key);
    const now = Date.now();

    if (cached && now - cached.timestamp <= 8000) {
      return cached.items.map((item) => new vscode.InlineCompletionItem(item, new vscode.Range(position, position)));
    }

    const client = new LmStudioClient({
      providerName: providerPreset === "custom" ? "Custom API" : "LM Studio",
      baseUrl: lmBaseUrl,
      apiKey,
      model,
      chatPath,
      headers,
      extraBody,
      onDebug: verboseLog ? (message) => this.output.appendLine(message) : undefined
    });

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "You are an inline code completion engine.",
          "Return STRICT JSON only.",
          "Schema:",
          "{",
          '  "candidates": [',
          '    { "text": "string", "label": "string" }',
          "  ]",
          "}",
          "Return 1-6 candidates based on intent from cursor and nearby comments.",
          "Each candidate.text is direct insertion text at cursor.",
          "Return code only. Do not include metadata labels, prose, or prompt echoes.",
          "Do not output lines like File path, Language, Cursor line, Current line prefix/suffix, Nearby comments.",
          "If current line is a comment describing intent, generate the code implementation directly below that comment.",
          "Do not include markdown, explanations, or code fences in text.",
          "Respect existing file structure, naming conventions, and local coding style.",
          "Prefer function-level completions when nearby comments imply planned function behavior.",
          "Do not duplicate already-written code before cursor.",
          "Avoid creating duplicate functions/files with slightly different names.",
          "Keep suggestion concise but production quality."
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `File path: ${document.uri.fsPath || document.uri.toString()}`,
          `Language: ${document.languageId}`,
          `Cursor line: ${cursorLine}`,
          `Cursor column: ${cursorColumn}`,
          "",
          "Current line prefix:",
          linePrefix || "(empty)",
          "",
          "Current line suffix:",
          lineSuffix || "(empty)",
          "",
          "Nearby user comments around cursor:",
          nearbyComments.length > 0 ? nearbyComments.join("\n") : "(none)",
          "",
          "Existing function candidates in file:",
          nearbyFunctions.length > 0 ? nearbyFunctions.join("\n") : "(none)",
          "",
          "Code before cursor (local context):",
          before || "(empty)",
          "",
          "Code after cursor (local context):",
          after || "(empty)",
          "",
          "Current file content snapshot:",
          fileContext || "(empty file)",
          "",
          `Return up to ${maxCandidates} candidates in JSON now.`
        ].join("\n")
      }
    ];

    const abortController = new AbortController();
    const cancelSub = token.onCancellationRequested(() => abortController.abort());

    try {
      const response = await client.chat(messages, abortController.signal, {
        model,
        temperature: 0.08,
        maxTokens,
        thinkingEnabled: inlineThinkingEnabled,
        thinkingEffort
      });

      const suggestions = this.parseModelCandidates(
        response.content,
        linePrefix,
        lineSuffix,
        maxSuggestionChars,
        maxCandidates
      );
      if (suggestions.length === 0) {
        return [];
      }

      if (verboseLog) {
        this.output.appendLine(
          `inline suggest file=${document.uri.fsPath || document.uri.toString()} model=${model} candidates=${suggestions.length}`
        );
      }

      this.setCache(key, suggestions);
      return suggestions.map((item) => new vscode.InlineCompletionItem(item, new vscode.Range(position, position)));
    } catch (error) {
      if (token.isCancellationRequested) {
        return [];
      }

      if (verboseLog) {
        const text = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`inline suggest failed: ${text}`);
      }
      return [];
    } finally {
      cancelSub.dispose();
    }
  }

  private parseModelCandidates(
    raw: string,
    linePrefix: string,
    lineSuffix: string,
    maxSuggestionChars: number,
    maxCandidates: number
  ): string[] {
    const candidates: string[] = [];

    try {
      const parsed = extractJsonObject(raw);
      if (parsed && typeof parsed === "object") {
        const row = parsed as Record<string, unknown>;
        const arr = Array.isArray(row.candidates) ? row.candidates : [];
        for (const item of arr) {
          if (typeof item === "string") {
            candidates.push(item);
            continue;
          }
          if (item && typeof item === "object") {
            const text = (item as Record<string, unknown>).text;
            if (typeof text === "string" && text.trim().length > 0) {
              candidates.push(text);
            }
          }
        }

        const primary = row.primary;
        if (typeof primary === "string" && primary.trim().length > 0) {
          candidates.unshift(primary);
        }
      }
    } catch {
      // fallback below
    }

    if (candidates.length === 0) {
      const blocks = [...raw.matchAll(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g)].map((m) => m[1]).filter(Boolean);
      if (blocks.length > 0) {
        candidates.push(...blocks);
      } else {
        const direct = raw.trim();
        if (this.looksLikeCode(direct) && !this.looksLikePromptEcho(direct)) {
          candidates.push(direct);
        }
      }
    }

    const normalized: string[] = [];
    const seen = new Set<string>();

    for (const item of candidates) {
      const text = this.normalizeSuggestion(item, linePrefix, lineSuffix, maxSuggestionChars);
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);
      normalized.push(text);
      if (normalized.length >= maxCandidates) {
        break;
      }
    }

    return normalized;
  }

  private normalizeSuggestion(
    raw: string,
    linePrefix: string,
    lineSuffix: string,
    maxSuggestionChars: number
  ): string {
    let text = raw.replace(/\r\n/g, "\n").trim();
    if (!text) {
      return "";
    }

    const fenced = text.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)```$/);
    if (fenced && fenced[1]) {
      text = fenced[1].trim();
    }

    text = text.replace(/^Here(?:'s| is).*\n/i, "");
    text = this.stripPromptEchoLines(text);
    if (this.looksLikePromptEcho(text)) {
      return "";
    }
    text = text.replace(/^\s*[-*]\s+/gm, "");
    text = text.replace(/^\d+\.\s+/gm, "");

    const lastPrefixLine = linePrefix.split("\n").pop() || "";
    if (lastPrefixLine && text.startsWith(lastPrefixLine)) {
      text = text.slice(lastPrefixLine.length);
    }

    if (lineSuffix && text.startsWith(lineSuffix)) {
      return "";
    }

    if (!text) {
      return "";
    }

    const lines = text.split("\n");
    if (lines.length > INLINE_MAX_LINES) {
      text = lines.slice(0, INLINE_MAX_LINES).join("\n");
    }

    if (text.length > maxSuggestionChars) {
      text = text.slice(0, maxSuggestionChars);
    }

    if (!this.looksLikeCode(text) || this.looksLikePromptEcho(text)) {
      return "";
    }

    return text;
  }

  private stripPromptEchoLines(value: string): string {
    const blockedLine = /^(file path|language|cursor line|cursor column|current line prefix|current line suffix|nearby user comments|existing function candidates|code before cursor|code after cursor|current file content snapshot|return up to)\s*:/i;
    const cleaned = value
      .split("\n")
      .filter((line) => !blockedLine.test(line.trim()))
      .join("\n")
      .trim();
    return cleaned;
  }

  private looksLikePromptEcho(value: string): boolean {
    const lower = value.toLowerCase();
    const markers = [
      "file path:",
      "language:",
      "cursor line:",
      "cursor column:",
      "current line prefix:",
      "current line suffix:",
      "nearby user comments around cursor:",
      "existing function candidates in file:",
      "code before cursor",
      "code after cursor",
      "current file content snapshot:"
    ];
    return markers.some((marker) => lower.includes(marker));
  }

  private looksLikeCode(value: string): boolean {
    const text = value.trim();
    if (!text) {
      return false;
    }
    if (this.looksLikePromptEcho(text)) {
      return false;
    }

    const codeSignals = [
      /[{}()[\];]/,
      /=>/,
      /\b(final|var|const|if|for|while|switch|return|await|try|catch|class|void|Future|List<|Map<|import)\b/,
      /^\s*[A-Za-z_]\w*\s*\([^)]*\)\s*(=>|\{)/m,
      /^\s*\.\w+\(/m
    ];
    return codeSignals.some((pattern) => pattern.test(text));
  }

  private collectWholeFileContext(document: vscode.TextDocument, maxChars: number): string {
    const text = document.getText();
    if (text.length <= maxChars) {
      return text;
    }

    const half = Math.floor(maxChars / 2);
    return `${text.slice(0, half)}\n...<truncated>...\n${text.slice(text.length - half)}`;
  }

  private collectNearbyComments(
    document: vscode.TextDocument,
    position: vscode.Position,
    windowLines: number,
    limit: number
  ): string[] {
    const start = Math.max(0, position.line - windowLines);
    const end = Math.min(document.lineCount - 1, position.line + windowLines);
    const comments: string[] = [];

    for (let i = start; i <= end; i += 1) {
      const raw = document.lineAt(i).text.trim();
      if (!raw) {
        continue;
      }

      let comment = "";
      if (raw.startsWith("//")) {
        comment = raw.slice(2).trim();
      } else if (raw.startsWith("#")) {
        comment = raw.slice(1).trim();
      } else if (raw.startsWith("--")) {
        comment = raw.slice(2).trim();
      } else if (raw.startsWith("/*")) {
        comment = raw.replace(/^\/\*\s*/, "").replace(/\*\/$/, "").trim();
      } else if (raw.startsWith("*")) {
        comment = raw.replace(/^\*\s*/, "").trim();
      }

      if (!comment) {
        continue;
      }

      comments.push(`L${i + 1}: ${comment}`);
      if (comments.length >= limit) {
        break;
      }
    }

    return comments;
  }

  private collectFunctionCandidates(document: vscode.TextDocument, limit: number): string[] {
    const lines = document.getText().split(/\r?\n/g);
    const out: string[] = [];
    const seen = new Set<string>();
    const bannedPrefixes = ["if", "for", "while", "switch", "catch", "return"];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (!trimmed || trimmed.length > 220) {
        continue;
      }

      const nextTrimmed = index + 1 < lines.length ? lines[index + 1].trim() : "";
      if (trimmed.endsWith(";") && !trimmed.includes("=>")) {
        continue;
      }

      const looksFunctionLike =
        /^function\s+[A-Za-z_]\w*\s*\(/.test(trimmed) ||
        /^(const|let|var)\s+[A-Za-z_]\w*\s*=\s*(async\s*)?\([^)]*\)\s*=>/.test(trimmed) ||
        /^(?:[A-Za-z_<>\[\]?,\s]+\s+)?[A-Za-z_]\w*\s*\([^;{}]*\)\s*(?:async\s*)?(?:\{|=>)$/.test(trimmed) ||
        (/^(?:[A-Za-z_<>\[\]?,\s]+\s+)?[A-Za-z_]\w*\s*\([^;{}]*\)\s*(?:async\s*)?$/.test(trimmed) &&
          nextTrimmed === "{") ||
        /^def\s+[A-Za-z_]\w*\s*\([^)]*\)\s*:/.test(trimmed) ||
        /^func\s+[A-Za-z_]\w*\s*\([^)]*\)\s*(\{|=>)?/.test(trimmed);

      if (!looksFunctionLike) {
        continue;
      }

      const lower = trimmed.toLowerCase();
      if (bannedPrefixes.some((prefix) => lower.startsWith(`${prefix} `))) {
        continue;
      }

      if (seen.has(trimmed)) {
        continue;
      }

      seen.add(trimmed);
      out.push(trimmed);
      if (out.length >= limit) {
        break;
      }
    }

    return out;
  }

  private collectBeforeContext(document: vscode.TextDocument, position: vscode.Position, maxChars: number): string {
    const startLine = Math.max(0, position.line - 160);
    const parts: string[] = [];

    for (let line = startLine; line <= position.line; line += 1) {
      const content = document.lineAt(line).text;
      if (line === position.line) {
        parts.push(content.slice(0, position.character));
      } else {
        parts.push(content);
      }
    }

    let text = parts.join("\n");
    if (text.length > maxChars) {
      text = text.slice(text.length - maxChars);
    }
    return text;
  }

  private collectAfterContext(document: vscode.TextDocument, position: vscode.Position, maxChars: number): string {
    const endLine = Math.min(document.lineCount - 1, position.line + 100);
    const parts: string[] = [];

    for (let line = position.line; line <= endLine; line += 1) {
      const content = document.lineAt(line).text;
      if (line === position.line) {
        parts.push(content.slice(position.character));
      } else {
        parts.push(content);
      }
    }

    let text = parts.join("\n");
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
    }
    return text;
  }

  private setCache(key: string, items: string[]): void {
    this.cache.set(key, {
      items,
      timestamp: Date.now()
    });

    if (this.cache.size <= MAX_CACHE_ITEMS) {
      return;
    }

    const oldest = this.cache.keys().next().value;
    if (oldest) {
      this.cache.delete(oldest);
    }
  }

  private buildCacheKey(
    uri: string,
    prefix: string,
    suffix: string,
    model: string,
    line: number,
    comments: string
  ): string {
    const prefixTail = prefix.slice(-180);
    const suffixHead = suffix.slice(0, 80);
    const commentsTail = comments.slice(-200);
    return `${uri}|${model}|L${line}|${prefixTail}|${suffixHead}|${commentsTail}`;
  }

  private async delay(ms: number, token: vscode.CancellationToken): Promise<void> {
    if (ms <= 0 || token.isCancellationRequested) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose();
        resolve();
      }, ms);

      const sub = token.onCancellationRequested(() => {
        clearTimeout(timer);
        sub.dispose();
        resolve();
      });
    });
  }

  private normalizeThinkingEffort(value: unknown): ThinkingEffort {
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "low" || raw === "high") {
      return raw;
    }
    return "medium";
  }

  private normalizeApiKey(value: unknown): string {
    const raw = String(value ?? "").trim();
    if (!raw) {
      return "";
    }
    if (raw.toLowerCase() === "lm-studio") {
      return "";
    }
    if (/^bearer\s+/i.test(raw)) {
      return raw.replace(/^bearer\s+/i, "").trim();
    }
    return raw;
  }

  private normalizeBaseUrl(input: string, fallback: string): string {
    const primary = this.sanitizeBaseUrlToken(input);
    const fallbackToken = this.sanitizeBaseUrlToken(fallback);

    const primaryNormalized = this.canonicalizeBaseUrl(primary);
    if (primaryNormalized) {
      return primaryNormalized;
    }

    const fallbackNormalized = this.canonicalizeBaseUrl(fallbackToken);
    if (fallbackNormalized) {
      return fallbackNormalized;
    }

    return DEFAULT_LM_BASE_URL;
  }

  private normalizeApiPath(value: string, fallback: string): string {
    const raw = value.trim();
    if (!raw) {
      return fallback;
    }
    return raw.startsWith("/") ? raw : `/${raw}`;
  }

  private parseHeaderJson(raw: string): Record<string, string> {
    const text = raw.trim();
    if (!text) {
      return {};
    }

    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }

      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const normalizedKey = key.trim();
        const normalizedValue = typeof value === "string" ? value.trim() : String(value ?? "").trim();
        if (!normalizedKey || !normalizedValue) {
          continue;
        }
        out[normalizedKey] = normalizedValue;
      }
      return out;
    } catch {
      return {};
    }
  }

  private parseBodyJson(raw: string): Record<string, unknown> {
    const text = raw.trim();
    if (!text) {
      return {};
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const normalizedKey = key.trim();
        if (!normalizedKey || value === undefined) {
          continue;
        }
        out[normalizedKey] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  private sanitizeBaseUrlToken(value: string): string {
    return value.trim().replace(/^['"]+|['"]+$/g, "").trim();
  }

  private canonicalizeBaseUrl(raw: string): string | undefined {
    if (!raw) {
      return undefined;
    }

    let normalized = raw.replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `http://${normalized}`;
    }

    try {
      const parsed = new URL(normalized);
      parsed.hash = "";
      parsed.search = "";

      const pathname = parsed.pathname.replace(/\/+$/, "");
      if (!pathname || pathname === "/") {
        parsed.pathname = "/v1";
      } else if (!/\/v1$/i.test(pathname)) {
        parsed.pathname = `${pathname}/v1`;
      } else {
        parsed.pathname = pathname;
      }

      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      return undefined;
    }
  }
}
