export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

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

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(this.joinUrl(this.chatPath), {
          method: "POST",
          headers: this.buildHeaders(true),
          body: JSON.stringify({
            model: requestedModel,
            messages,
            temperature: options?.temperature ?? 0.15,
            max_tokens: options?.maxTokens ?? 1200,
            stream: false
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

        const responseModel =
          typeof data.model === "string" && data.model.trim().length > 0 ? data.model : requestedModel;

        return {
          content,
          usage: this.extractUsage(data),
          model: responseModel
        };
      } catch (error) {
        if (signal?.aborted) {
          throw new Error(`${this.providerName} request cancelled.`);
        }

        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= 2) {
          break;
        }

        await this.sleep(250 * attempt, signal);
      }
    }

    throw lastError ?? new Error(`${this.providerName} request failed.`);
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
