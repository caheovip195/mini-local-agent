export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ThinkingEffort = "low" | "medium" | "high";

interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName?: string;
  modelsPath?: string;
  chatPath?: string;
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
  headers?: Record<string, string>;
}

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  stream?: boolean;
  onDelta?: (delta: string) => void;
  responseFormat?: "json_object";
  thinkingEffort?: ThinkingEffort;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  usage?: TokenUsage;
  model: string;
}

interface ChatCompletionMessage {
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<Record<string, unknown>>;
}

interface ChatCompletionChoice {
  message?: ChatCompletionMessage;
  text?: string | null;
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  output_text?: string;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface ModelsResponse {
  data?: Array<{
    id?: string;
  }>;
}

export class LmStudioClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly providerName: string;
  private readonly modelsPath: string;
  private readonly chatPath: string;
  private readonly apiKeyHeader: string;
  private readonly apiKeyPrefix: string;
  private readonly headers: Record<string, string>;
  private model: string;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.providerName = options.providerName?.trim() || "Provider";
    this.modelsPath = this.normalizePath(options.modelsPath, "/models");
    this.chatPath = this.normalizePath(options.chatPath, "/chat/completions");
    this.apiKeyHeader = options.apiKeyHeader?.trim() || "Authorization";
    this.apiKeyPrefix =
      typeof options.apiKeyPrefix === "string"
        ? options.apiKeyPrefix
        : this.apiKeyHeader.toLowerCase() === "authorization"
          ? "Bearer "
          : "";
    this.headers = this.normalizeHeaders(options.headers);
    this.model = options.model;
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    const next = model.trim();
    if (next.length > 0) {
      this.model = next;
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await fetch(this.joinUrl(this.modelsPath), {
      method: "GET",
      headers: this.buildHeaders(false),
      signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${this.providerName} models error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as ModelsResponse;
    const ids = (data.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0);

    return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
  }

  async chat(
    messages: ChatMessage[],
    signal?: AbortSignal,
    options?: ChatOptions
  ): Promise<ChatResult> {
    let lastError: Error | undefined;
    const requestedModel = options?.model?.trim() || this.model;
    const streamRequested = options?.stream === true;
    let effectiveOptions: ChatOptions = { ...(options ?? {}) };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        if (streamRequested) {
          try {
            return await this.chatStream(messages, requestedModel, signal, effectiveOptions);
          } catch (streamError) {
            const streamEmitted = (streamError as { streamEmitted?: boolean }).streamEmitted === true;
            if (!streamEmitted) {
              return await this.chatJson(messages, requestedModel, signal, effectiveOptions);
            }
            throw streamError;
          }
        }

        return await this.chatJson(messages, requestedModel, signal, effectiveOptions);
      } catch (error) {
        if (signal?.aborted) {
          throw new Error(`${this.providerName} request cancelled.`);
        }

        lastError = error instanceof Error ? error : new Error(String(error));
        if (effectiveOptions.responseFormat && this.isResponseFormatUnsupportedError(lastError.message)) {
          effectiveOptions = { ...effectiveOptions, responseFormat: undefined };
          if (attempt < 2) {
            continue;
          }
        }
        if (effectiveOptions.thinkingEffort && this.isThinkingUnsupportedError(lastError.message)) {
          effectiveOptions = { ...effectiveOptions, thinkingEffort: undefined };
          if (attempt < 2) {
            continue;
          }
        }
        if (attempt >= 2) {
          break;
        }

        await this.sleep(250 * attempt, signal);
      }
    }

    throw lastError ?? new Error(`${this.providerName} request failed.`);
  }

  private isResponseFormatUnsupportedError(message: string): boolean {
    const text = message.toLowerCase();
    const mentionsResponseFormat = text.includes("response_format") || text.includes("response format");
    const unsupportedSignal =
      text.includes("unsupported") ||
      text.includes("not support") ||
      text.includes("unknown") ||
      text.includes("invalid") ||
      text.includes("unexpected") ||
      text.includes("must be") ||
      text.includes("expected") ||
      text.includes("json_schema") ||
      text.includes("json schema");
    return mentionsResponseFormat && unsupportedSignal;
  }

  private isThinkingUnsupportedError(message: string): boolean {
    const text = message.toLowerCase();
    const mentionsThinking =
      text.includes("reasoning_effort") ||
      text.includes("reasoning") ||
      text.includes("thinking") ||
      text.includes("extra inputs are not permitted");
    const unsupportedSignal =
      text.includes("unsupported") ||
      text.includes("not support") ||
      text.includes("unknown") ||
      text.includes("invalid") ||
      text.includes("unexpected") ||
      text.includes("extra inputs are not permitted");
    return mentionsThinking && unsupportedSignal;
  }

  private async chatJson(
    messages: ChatMessage[],
    requestedModel: string,
    signal: AbortSignal | undefined,
    options?: ChatOptions
  ): Promise<ChatResult> {
    const response = await fetch(this.joinUrl(this.chatPath), {
      method: "POST",
      headers: this.buildHeaders(true),
      body: JSON.stringify({
        model: requestedModel,
        messages,
        temperature: options?.temperature ?? 0.15,
        max_tokens: options?.maxTokens ?? 1200,
        stream: false,
        ...(options?.thinkingEffort
          ? {
              reasoning_effort: options.thinkingEffort,
              reasoning: { effort: options.thinkingEffort }
            }
          : {}),
        ...(options?.responseFormat === "json_object" ? { response_format: { type: "json_object" } } : {})
      }),
      signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${this.providerName} error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = this.extractCompletionContent(data);
    if (!content) {
      throw new Error("LM Studio returned empty completion payload.");
    }

    const responseModel = typeof data.model === "string" && data.model.trim().length > 0 ? data.model : requestedModel;
    return {
      content,
      usage: this.extractUsage(data),
      model: responseModel
    };
  }

  private async chatStream(
    messages: ChatMessage[],
    requestedModel: string,
    signal: AbortSignal | undefined,
    options?: ChatOptions
  ): Promise<ChatResult> {
    let emittedAny = false;

    try {
      const response = await fetch(this.joinUrl(this.chatPath), {
        method: "POST",
        headers: this.buildHeaders(true),
      body: JSON.stringify({
        model: requestedModel,
        messages,
        temperature: options?.temperature ?? 0.15,
        max_tokens: options?.maxTokens ?? 1200,
        stream: true,
        ...(options?.thinkingEffort
          ? {
              reasoning_effort: options.thinkingEffort,
              reasoning: { effort: options.thinkingEffort }
            }
          : {}),
        ...(options?.responseFormat === "json_object" ? { response_format: { type: "json_object" } } : {})
      }),
      signal
    });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${this.providerName} error ${response.status}: ${errorText}`);
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("application/json")) {
        const data = (await response.json()) as ChatCompletionResponse;
        const content = this.extractCompletionContent(data);
        if (!content) {
          throw new Error(`${this.providerName} stream response was empty.`);
        }
        return {
          content,
          usage: this.extractUsage(data),
          model: typeof data.model === "string" && data.model.trim().length > 0 ? data.model : requestedModel
        };
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error(`${this.providerName} stream body is unavailable.`);
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let assembled = "";
      let responseModel = requestedModel;
      let usage: TokenUsage | undefined;

      const processEventBlock = (block: string): void => {
        const lines = block.split("\n");
        const dataParts: string[] = [];
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) {
            continue;
          }
          dataParts.push(line.slice(5).trimStart());
        }
        if (dataParts.length === 0) {
          return;
        }

        const payloadText = dataParts.join("\n").trim();
        if (!payloadText || payloadText === "[DONE]") {
          return;
        }

        let payload: Record<string, unknown>;
        try {
          const parsed = JSON.parse(payloadText) as unknown;
          if (!parsed || typeof parsed !== "object") {
            return;
          }
          payload = parsed as Record<string, unknown>;
        } catch {
          return;
        }

        if (typeof payload.model === "string" && payload.model.trim().length > 0) {
          responseModel = payload.model;
        }

        const parsedUsage = this.extractUsage(payload as unknown as ChatCompletionResponse);
        if (parsedUsage) {
          usage = parsedUsage;
        }

        const delta = this.extractStreamDeltaContent(payload);
        if (!delta) {
          return;
        }

        assembled += delta;
        emittedAny = true;
        try {
          options?.onDelta?.(delta);
        } catch {
          // Ignore stream callback failures to keep generation alive.
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        while (true) {
          const boundaryIndex = buffer.indexOf("\n\n");
          if (boundaryIndex < 0) {
            break;
          }
          const eventBlock = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);
          processEventBlock(eventBlock);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        processEventBlock(buffer.replace(/\r\n/g, "\n"));
      }

      const content = assembled.trim();
      if (!content) {
        throw new Error(`${this.providerName} stream returned no content.`);
      }

      return {
        content,
        usage,
        model: responseModel
      };
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      (wrapped as { streamEmitted?: boolean }).streamEmitted = emittedAny;
      throw wrapped;
    }
  }

  private extractStreamDeltaContent(payload: Record<string, unknown>): string {
    const choicesRaw = payload.choices;
    if (Array.isArray(choicesRaw) && choicesRaw.length > 0) {
      const firstChoice = choicesRaw[0];
      if (firstChoice && typeof firstChoice === "object") {
        const choice = firstChoice as Record<string, unknown>;
        const deltaRaw = choice.delta;
        if (deltaRaw && typeof deltaRaw === "object") {
          const delta = deltaRaw as Record<string, unknown>;
          if (typeof delta.content === "string") {
            return delta.content;
          }
          if (Array.isArray(delta.content)) {
            const joined = delta.content
              .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
              .map((part) => this.partToText(part))
              .join("");
            if (joined.trim().length > 0) {
              return joined;
            }
          }
          if (typeof delta.text === "string") {
            return delta.text;
          }
        }

        const messageRaw = choice.message;
        if (messageRaw && typeof messageRaw === "object") {
          const messageText = this.extractMessageContent(messageRaw as ChatCompletionMessage);
          if (messageText) {
            return messageText;
          }
        }

        if (typeof choice.text === "string") {
          return choice.text;
        }
      }
    }

    if (typeof payload.output_text === "string") {
      return payload.output_text;
    }

    return "";
  }

  private extractCompletionContent(data: ChatCompletionResponse): string | undefined {
    const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
    const message = choice?.message;

    const messageContent = this.extractMessageContent(message);
    if (messageContent) {
      return messageContent;
    }

    if (message?.tool_calls && message.tool_calls.length > 0) {
      return JSON.stringify({
        reasoning: "Converted from LM Studio tool_calls response.",
        tool_calls: message.tool_calls
      });
    }

    if (typeof choice?.text === "string" && choice.text.trim().length > 0) {
      return choice.text.trim();
    }

    if (typeof data.output_text === "string" && data.output_text.trim().length > 0) {
      return data.output_text.trim();
    }

    return undefined;
  }

  private extractMessageContent(message: ChatCompletionMessage | undefined): string | undefined {
    if (!message) {
      return undefined;
    }

    const content = message.content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }

    if (!Array.isArray(content)) {
      return undefined;
    }

    const parts = content
      .map((part) => this.partToText(part))
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (parts.length === 0) {
      return undefined;
    }

    return parts.join("\n");
  }

  private partToText(part: Record<string, unknown>): string {
    const directText = part.text;
    if (typeof directText === "string") {
      return directText;
    }

    const content = part.content;
    if (typeof content === "string") {
      return content;
    }

    if (content && typeof content === "object") {
      const nested = content as Record<string, unknown>;
      if (typeof nested.text === "string") {
        return nested.text;
      }
      if (typeof nested.value === "string") {
        return nested.value;
      }
    }

    return "";
  }

  private extractUsage(data: ChatCompletionResponse): TokenUsage | undefined {
    const promptTokens = this.toNonNegativeInt(data.usage?.prompt_tokens);
    const completionTokens = this.toNonNegativeInt(data.usage?.completion_tokens);
    const totalTokens = this.toNonNegativeInt(data.usage?.total_tokens);

    if (promptTokens + completionTokens + totalTokens <= 0) {
      return undefined;
    }

    return {
      promptTokens,
      completionTokens,
      totalTokens: totalTokens > 0 ? totalTokens : promptTokens + completionTokens
    };
  }

  private toNonNegativeInt(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0;
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`${this.providerName} request cancelled.`));
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private joinUrl(pathname: string): string {
    return `${this.baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  }

  private normalizePath(pathname: string | undefined, fallback: string): string {
    const value = pathname?.trim();
    if (!value) {
      return fallback;
    }
    return value.startsWith("/") ? value : `/${value}`;
  }

  private normalizeHeaders(value: Record<string, string> | undefined): Record<string, string> {
    if (!value) {
      return {};
    }

    const out: Record<string, string> = {};
    for (const [rawKey, rawVal] of Object.entries(value)) {
      const key = rawKey.trim();
      const val = String(rawVal ?? "").trim();
      if (!key || !val) {
        continue;
      }
      out[key] = val;
    }
    return out;
  }

  private buildHeaders(withJsonContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (withJsonContentType) {
      headers["Content-Type"] = "application/json";
    }

    if (this.apiKey.trim().length > 0) {
      headers[this.apiKeyHeader] = `${this.apiKeyPrefix}${this.apiKey}`;
    }

    return {
      ...headers,
      ...this.headers
    };
  }
}
