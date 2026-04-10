export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ThinkingEffort = "low" | "medium" | "high";
type ThinkingApiStyle = "auto" | "reasoning_effort" | "reasoning_object";
type EndpointMode = "chat_completions" | "responses" | "lm_rest_chat";

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
  extraBody?: Record<string, unknown>;
  onDebug?: (message: string) => void;
}

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  stream?: boolean;
  onDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  responseFormat?: "json_object";
  thinkingEnabled?: boolean;
  thinkingEffort?: ThinkingEffort;
  thinkingApiStyle?: ThinkingApiStyle;
  integrations?: Array<string | Record<string, unknown>>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  reasoning?: string;
  usage?: TokenUsage;
  model: string;
}

interface ChatCompletionMessage {
  content?: string | Record<string, unknown> | Array<unknown> | null;
  tool_calls?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface ChatCompletionChoice {
  message?: ChatCompletionMessage;
  text?: string | null;
  [key: string]: unknown;
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  output_text?: string;
  model?: string;
  output?: Array<Record<string, unknown>>;
  [key: string]: unknown;
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
  private readonly extraBody: Record<string, unknown>;
  private readonly onDebug?: (message: string) => void;
  private model: string;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = this.normalizeApiKey(options.apiKey);
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
    this.extraBody = this.normalizeExtraBody(options.extraBody);
    this.onDebug = options.onDebug;
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
    const candidates = this.buildModelEndpointCandidates();
    let lastError: Error | undefined;
    for (const url of candidates) {
      this.debug(`listModels: GET ${url}`);
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: this.buildHeaders(false),
          signal
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(this.buildHttpErrorMessage(response.status, errorText, "models error"));
        }

        const payload = (await response.json()) as unknown;
        const ids = this.extractModelIds(payload);
        this.debug(`listModels: success url=${url} count=${ids.length}`);
        return ids;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.debug(`listModels: failed url=${url} error=${lastError.message}`);
      }
    }
    throw lastError ?? new Error(`${this.providerName} models request failed.`);
  }

  async chat(
    messages: ChatMessage[],
    signal?: AbortSignal,
    options?: ChatOptions
  ): Promise<ChatResult> {
    let lastError: Error | undefined;
    const requestedModel = options?.model?.trim() || this.model;
    const endpointMode = this.getEndpointMode();
    const streamRequested = options?.stream === true && endpointMode === "chat_completions";
    if (options?.stream === true && endpointMode !== "chat_completions") {
      this.debug(`chat:stream disabled for ${endpointMode} endpoint (using non-streaming mode)`);
    }
    let effectiveOptions: ChatOptions = {
      ...(options ?? {}),
      thinkingApiStyle: this.normalizeThinkingApiStyle(options?.thinkingApiStyle)
    };

    const maxAttempts = 6;
    this.debug(
      `chat:start endpoint=${endpointMode} model=${requestedModel} stream=${streamRequested ? "true" : "false"} opts=${this.describeChatOptions(effectiveOptions, endpointMode)}`
    );
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.debug(`chat:attempt ${attempt}/${maxAttempts} opts=${this.describeChatOptions(effectiveOptions, endpointMode)}`);
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
        this.debug(`chat:error attempt=${attempt} message=${lastError.message}`);
        if (Array.isArray(effectiveOptions.integrations) && effectiveOptions.integrations.length > 0) {
          const deniedIntegration = this.extractDeniedIntegrationId(lastError.message);
          const integrationPermissionIssue =
            this.isIntegrationPermissionError(lastError.message) ||
            this.isIntegrationsParamError(lastError.message);
          if (integrationPermissionIssue) {
            const current = effectiveOptions.integrations;
            let next = current;
            if (deniedIntegration) {
              next = current.filter((item) => this.getIntegrationIdentifier(item) !== deniedIntegration);
            }

            if (next.length === 0 || next.length === current.length) {
              this.debug(
                `chat:fallback disable integrations due provider rejection${deniedIntegration ? ` (${deniedIntegration})` : ""}`
              );
              effectiveOptions = { ...effectiveOptions, integrations: undefined };
            } else {
              this.debug(
                `chat:fallback remove denied integration ${deniedIntegration}; remaining=${next.map((item) => this.getIntegrationIdentifier(item)).join(",")}`
              );
              effectiveOptions = { ...effectiveOptions, integrations: next };
            }
            if (attempt < maxAttempts) {
              continue;
            }
          }
        }
        if (effectiveOptions.responseFormat && this.isResponseFormatUnsupportedError(lastError.message)) {
          effectiveOptions = { ...effectiveOptions, responseFormat: undefined };
          this.debug("chat:fallback drop responseFormat");
          if (attempt < maxAttempts) {
            continue;
          }
        }
        if (effectiveOptions.responseFormat && this.isJsonModeEmptyPayloadError(lastError.message)) {
          effectiveOptions = { ...effectiveOptions, responseFormat: undefined };
          this.debug("chat:fallback drop responseFormat due empty json payload");
          if (attempt < maxAttempts) {
            continue;
          }
        }
        if (this.isThinkingUnsupportedError(lastError.message)) {
          const lower = lastError.message.toLowerCase();
          const mentionsEnableThinking = lower.includes("enable_thinking");
          const mentionsReasoning =
            lower.includes("reasoning_effort") || /\breasoning\b/.test(lower) || lower.includes("thinking effort");
          const requestedThinkingStyle = this.normalizeThinkingApiStyle(effectiveOptions.thinkingApiStyle);
          const thinkingStyle =
            requestedThinkingStyle === "auto"
              ? endpointMode === "responses"
                ? "reasoning_object"
                : "reasoning_effort"
              : requestedThinkingStyle;

          if (mentionsEnableThinking && typeof effectiveOptions.thinkingEnabled === "boolean") {
            effectiveOptions = { ...effectiveOptions, thinkingEnabled: undefined };
            this.debug("chat:fallback drop thinkingEnabled (provider rejected enable_thinking)");
            if (attempt < maxAttempts) {
              continue;
            }
          }
          if (mentionsReasoning && effectiveOptions.thinkingEffort) {
            if (requestedThinkingStyle === "auto" && endpointMode === "chat_completions") {
              effectiveOptions = { ...effectiveOptions, thinkingApiStyle: "reasoning_object" };
              this.debug("chat:fallback switch thinking style auto -> reasoning_object");
              if (attempt < maxAttempts) {
                continue;
              }
            }
            effectiveOptions = { ...effectiveOptions, thinkingEffort: undefined };
            this.debug(`chat:fallback drop thinkingEffort (provider rejected ${thinkingStyle})`);
            if (attempt < maxAttempts) {
              continue;
            }
          }

          // Generic fallback order: drop enable flag first, then effort.
          if (typeof effectiveOptions.thinkingEnabled === "boolean") {
            effectiveOptions = { ...effectiveOptions, thinkingEnabled: undefined };
            this.debug("chat:fallback drop thinkingEnabled (generic)");
            if (attempt < maxAttempts) {
              continue;
            }
          }
          if (effectiveOptions.thinkingEffort) {
            effectiveOptions = { ...effectiveOptions, thinkingEffort: undefined };
            this.debug("chat:fallback drop thinkingEffort (generic)");
            if (attempt < maxAttempts) {
              continue;
            }
          }
        }
        if (attempt >= maxAttempts) {
          break;
        }

        await this.sleep(250 * attempt, signal);
      }
    }

    throw lastError ?? new Error(`${this.providerName} request failed.`);
  }

  private isIntegrationPermissionError(message: string): boolean {
    const text = message.toLowerCase();
    return (
      (text.includes("permission denied") || text.includes("not allowed") || text.includes("forbidden")) &&
      (text.includes("plugin") || text.includes("integration") || text.includes("mcp/"))
    );
  }

  private isIntegrationsParamError(message: string): boolean {
    const text = message.toLowerCase();
    return (
      text.includes("integrations") &&
      (text.includes("invalid_request") ||
        text.includes("invalid") ||
        text.includes("unsupported") ||
        text.includes("unknown"))
    );
  }

  private extractDeniedIntegrationId(message: string): string | undefined {
    const patterns = [
      /plugin\s+'([^']+)'/i,
      /plugin\s+"([^"]+)"/i,
      /integration\s+'([^']+)'/i,
      /integration\s+"([^"]+)"/i,
      /(mcp\/[a-z0-9._/-]+)/i
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(message);
      if (!match || typeof match[1] !== "string") {
        continue;
      }
      const id = match[1].trim();
      if (id.length > 0) {
        return id;
      }
    }
    return undefined;
  }

  private getIntegrationIdentifier(value: string | Record<string, unknown>): string {
    if (typeof value === "string") {
      return value.trim();
    }
    if (!value || typeof value !== "object") {
      return "";
    }
    const typed = value as Record<string, unknown>;
    const candidates = [typed.id, typed.integration, typed.plugin, typed.name];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return "";
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
      text.includes("enable_thinking") ||
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

  private isJsonModeEmptyPayloadError(message: string): boolean {
    const text = message.toLowerCase();
    return (
      text.includes("empty completion payload") ||
      text.includes("stream response was empty") ||
      text.includes("stream returned no content")
    );
  }

  private normalizeThinkingApiStyle(value: unknown): ThinkingApiStyle {
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "reasoning_effort" || raw === "reasoning_object") {
      return raw;
    }
    return "auto";
  }

  private buildThinkingPayload(
    options: ChatOptions | undefined,
    endpointMode: EndpointMode,
    requestedModel: string
  ): Record<string, unknown> {
    let effort = options?.thinkingEffort;
    const enabled = typeof options?.thinkingEnabled === "boolean" ? options.thinkingEnabled : undefined;
    const requestedStyle = this.normalizeThinkingApiStyle(options?.thinkingApiStyle);
    const style =
      requestedStyle === "auto"
        ? endpointMode === "responses"
        ? "reasoning_object"
        : "reasoning_effort"
        : requestedStyle;
    if (effort && this.isToggleOnlyReasoningModel(requestedModel)) {
      this.debug(
        `chat:thinking effort '${effort}' ignored for toggle-only model '${requestedModel}' (using enable_thinking only)`
      );
      effort = undefined;
    }
    if (!effort && typeof enabled !== "boolean") {
      return {};
    }

    const payload: Record<string, unknown> = {};
    if (effort) {
      if (style === "reasoning_object") {
        payload.reasoning = { effort };
      } else {
        payload.reasoning_effort = effort;
      }
    }
    if (typeof enabled === "boolean") {
      payload.enable_thinking = enabled;
    }
    return payload;
  }

  private buildLmRestThinking(options: ChatOptions | undefined, requestedModel: string): Record<string, unknown> {
    const enabled = typeof options?.thinkingEnabled === "boolean" ? options.thinkingEnabled : undefined;
    const effort = options?.thinkingEffort;
    if (enabled === false) {
      return { reasoning: "off" };
    }
    if (this.isToggleOnlyReasoningModel(requestedModel)) {
      if (enabled === true || effort) {
        return { reasoning: "on" };
      }
      return {};
    }
    if (effort) {
      return { reasoning: effort };
    }
    if (enabled === true) {
      return { reasoning: "on" };
    }
    return {};
  }

  private isToggleOnlyReasoningModel(modelId: string): boolean {
    const id = modelId.trim().toLowerCase();
    if (!id) {
      return false;
    }
    return /(^|[\/_-])qwen3([._/-]|$)/i.test(id) || /(^|[\/_-])qwen\/qwen3([._/-]|$)/i.test(id);
  }

  private buildChatRequestBody(
    messages: ChatMessage[],
    requestedModel: string,
    options: ChatOptions | undefined,
    stream: boolean
  ): Record<string, unknown> {
    const endpointMode = this.getEndpointMode();
    const extraBodyPatch = this.buildExtraBodyPatch();
    if (endpointMode === "lm_rest_chat") {
      if (Object.prototype.hasOwnProperty.call(extraBodyPatch, "preset")) {
        delete extraBodyPatch.preset;
        this.debug("chat:removed unsupported extraBody key 'preset' for lm_rest_chat endpoint");
      }
    }
    const thinkingPayload =
      endpointMode === "lm_rest_chat"
        ? this.buildLmRestThinking(options, requestedModel)
        : this.buildThinkingPayload(options, endpointMode, requestedModel);
    const systemPrompt = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content.trim())
      .filter((value) => value.length > 0)
      .join("\n\n");
    const lmRestInput = this.toLmRestInput(messages);
    const body: Record<string, unknown> =
      endpointMode === "responses"
        ? {
            model: requestedModel,
            input: this.toResponsesInput(messages),
            temperature: options?.temperature ?? 0.15,
            max_output_tokens: options?.maxTokens ?? 1200,
            stream,
            ...extraBodyPatch,
            ...thinkingPayload
          }
        : endpointMode === "lm_rest_chat"
          ? {
              model: requestedModel,
              input: lmRestInput,
              temperature: options?.temperature ?? 0.15,
              max_output_tokens: options?.maxTokens ?? 1200,
              ...extraBodyPatch,
              ...(systemPrompt.length > 0 ? { system_prompt: systemPrompt } : {}),
              ...(Array.isArray(options?.integrations) && options.integrations.length > 0
                ? { integrations: options.integrations }
                : {}),
              ...thinkingPayload
            }
          : {
              model: requestedModel,
              messages,
              temperature: options?.temperature ?? 0.15,
              max_tokens: options?.maxTokens ?? 1200,
              stream,
              ...extraBodyPatch,
              ...thinkingPayload,
              ...(options?.responseFormat === "json_object" ? { response_format: { type: "json_object" } } : {})
            };
    const responseFormatApplied =
      endpointMode === "chat_completions" ? options?.responseFormat ?? "none" : `disabled_for_${endpointMode}`;
    this.debug(
      `chat:request endpoint=${endpointMode} model=${requestedModel} stream=${stream ? "true" : "false"} thinkingPayload=${JSON.stringify(thinkingPayload)} extraBodyKeys=${Object.keys(extraBodyPatch).join(",") || "-"} responseFormat=${responseFormatApplied} integrations=${Array.isArray(options?.integrations) ? options.integrations.length : 0}`
    );
    return body;
  }

  private describeChatOptions(options: ChatOptions | undefined, endpointMode: EndpointMode): string {
    const thinkingState =
      options?.thinkingEnabled === false
        ? "off"
        : options?.thinkingEffort
          ? `effort:${options.thinkingEffort}`
          : options?.thinkingEnabled === true
            ? "on"
            : "default";
    const responseFormat = options?.responseFormat ?? "none";
    const stream = options?.stream === true ? "true" : "false";
    const requestedStyle = this.normalizeThinkingApiStyle(options?.thinkingApiStyle);
    const effectiveStyle =
      requestedStyle === "auto"
        ? endpointMode === "responses"
          ? "reasoning_object"
          : endpointMode === "lm_rest_chat"
            ? "native_reasoning"
          : "reasoning_effort"
        : requestedStyle;
    return `thinking=${thinkingState}, thinkingStyle=${effectiveStyle}, responseFormat=${responseFormat}, stream=${stream}`;
  }

  private debug(message: string): void {
    try {
      this.onDebug?.(`[LmStudioClient] ${message}`);
    } catch {
      // no-op
    }
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
      body: JSON.stringify(this.buildChatRequestBody(messages, requestedModel, options, false)),
      signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(this.buildHttpErrorMessage(response.status, errorText, "error"));
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = this.extractCompletionContent(data, options?.responseFormat === "json_object");
    const reasoning = this.extractCompletionReasoning(data, options?.responseFormat === "json_object");
    if (!content) {
      if (reasoning && reasoning.trim().length > 0) {
        throw new Error(
          `${this.providerName} returned reasoning but no final answer. Enable/adjust model thinking output mode or prompt the model to return final answer text. ${this.previewPayloadForError(data)}`
        );
      }
      throw new Error(`${this.providerName} returned empty completion payload. ${this.previewPayloadForError(data)}`);
    }

    const responseModel = typeof data.model === "string" && data.model.trim().length > 0 ? data.model : requestedModel;
    return {
      content,
      reasoning: reasoning && reasoning.trim().length > 0 ? reasoning.trim() : undefined,
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
        body: JSON.stringify(this.buildChatRequestBody(messages, requestedModel, options, true)),
        signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(this.buildHttpErrorMessage(response.status, errorText, "error"));
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("application/json")) {
        const data = (await response.json()) as ChatCompletionResponse;
        const content = this.extractCompletionContent(data, options?.responseFormat === "json_object");
        const reasoning = this.extractCompletionReasoning(data, options?.responseFormat === "json_object");
        if (!content) {
          if (reasoning && reasoning.trim().length > 0) {
            throw new Error(
              `${this.providerName} stream response returned reasoning but no final answer. Enable/adjust model thinking output mode or prompt the model to return final answer text. ${this.previewPayloadForError(data)}`
            );
          }
          throw new Error(`${this.providerName} stream response was empty. ${this.previewPayloadForError(data)}`);
        }
        return {
          content,
          reasoning: reasoning && reasoning.trim().length > 0 ? reasoning.trim() : undefined,
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
      let assembledReasoning = "";
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

        const delta = this.extractStreamDeltaContent(payload, options?.responseFormat === "json_object");
        const reasoningDelta = this.extractStreamDeltaReasoning(payload, options?.responseFormat === "json_object");

        if (delta) {
          assembled += delta;
          emittedAny = true;
          try {
            options?.onDelta?.(delta);
          } catch {
            // Ignore stream callback failures to keep generation alive.
          }
        }
        if (reasoningDelta) {
          assembledReasoning += reasoningDelta;
          emittedAny = true;
          try {
            options?.onReasoningDelta?.(reasoningDelta);
          } catch {
            // Ignore stream callback failures to keep generation alive.
          }
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
        if (assembledReasoning.trim().length > 0) {
          throw new Error(
            `${this.providerName} stream returned reasoning without final answer. Enable/adjust model thinking output mode or prompt the model to return final answer text.`
          );
        }
        throw new Error(`${this.providerName} stream returned no content.`);
      }

      return {
        content,
        reasoning: assembledReasoning.trim().length > 0 ? assembledReasoning.trim() : undefined,
        usage,
        model: responseModel
      };
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      (wrapped as { streamEmitted?: boolean }).streamEmitted = emittedAny;
      throw wrapped;
    }
  }

  private extractStreamDeltaContent(payload: Record<string, unknown>, jsonMode = false): string {
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
          if (delta.content && typeof delta.content === "object" && !Array.isArray(delta.content)) {
            const text = this.partToText(delta.content);
            if (text.trim().length > 0) {
              return text;
            }
          }
          if (Array.isArray(delta.content)) {
            const joined = delta.content
              .map((part) => this.partToText(part))
              .join("");
            if (joined.trim().length > 0) {
              return joined;
            }
          }
          if (!jsonMode && typeof delta.text === "string") {
            return delta.text;
          }
        }

        const messageRaw = choice.message;
        if (messageRaw && typeof messageRaw === "object") {
          const messageText = this.extractMessageContent(messageRaw as ChatCompletionMessage, !jsonMode);
          if (messageText) {
            return messageText;
          }
        }

        if (!jsonMode && typeof choice.text === "string") {
          return choice.text;
        }
        if (!jsonMode && typeof choice.content === "string") {
          return choice.content;
        }
      }
    }

    if (!jsonMode && typeof payload.output_text === "string") {
      return payload.output_text;
    }

    return "";
  }

  private extractStreamDeltaReasoning(payload: Record<string, unknown>, jsonMode = false): string {
    if (jsonMode) {
      return "";
    }

    const choicesRaw = payload.choices;
    if (Array.isArray(choicesRaw) && choicesRaw.length > 0) {
      const firstChoice = choicesRaw[0];
      if (firstChoice && typeof firstChoice === "object") {
        const choice = firstChoice as Record<string, unknown>;
        const deltaRaw = choice.delta;
        if (deltaRaw && typeof deltaRaw === "object") {
          const delta = deltaRaw as Record<string, unknown>;
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.trim().length > 0) {
            return delta.reasoning_content;
          }
          if (typeof delta.reasoning === "string" && delta.reasoning.trim().length > 0) {
            return delta.reasoning;
          }
          const text = this.partToText(delta.reasoning_content, true).trim() || this.partToText(delta.reasoning, true).trim();
          if (text.length > 0) {
            return text;
          }
        }

        const messageRaw = choice.message;
        if (messageRaw && typeof messageRaw === "object") {
          const message = messageRaw as Record<string, unknown>;
          const messageReasoning =
            this.partToText(message.reasoning_content, true).trim() || this.partToText(message.reasoning, true).trim();
          if (messageReasoning.length > 0) {
            return messageReasoning;
          }
        }
      }
    }

    const outputArrayReasoning = this.extractOutputArrayReasoning(payload.output);
    if (outputArrayReasoning) {
      return outputArrayReasoning;
    }

    return "";
  }

  private extractCompletionContent(data: ChatCompletionResponse, jsonMode = false): string | undefined {
    const choices = Array.isArray(data.choices) ? data.choices : [];
    for (const row of choices) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const choice = row as ChatCompletionChoice;
      const message = choice.message;

      const messageContent = this.extractMessageContent(message, false);
      if (messageContent) {
        return messageContent;
      }

      if (message?.tool_calls && message.tool_calls.length > 0) {
        return JSON.stringify({
          reasoning: "Converted from tool_calls response.",
          tool_calls: message.tool_calls
        });
      }

      if (!jsonMode && typeof choice.text === "string" && choice.text.trim().length > 0) {
        return choice.text.trim();
      }

      if (!jsonMode) {
        const choiceContent = this.partToText((choice as Record<string, unknown>).content, false);
        if (choiceContent.trim().length > 0) {
          return choiceContent.trim();
        }
      }
    }

    if (!jsonMode && typeof data.output_text === "string" && data.output_text.trim().length > 0) {
      return data.output_text.trim();
    }

    if (!jsonMode) {
      const outputArrayText = this.extractOutputArrayText(data.output);
      if (outputArrayText) {
        return outputArrayText;
      }
    }

    if (!jsonMode) {
      const topText = this.partToText((data as Record<string, unknown>).text, false);
      if (topText.trim().length > 0) {
        return topText.trim();
      }
    }

    return undefined;
  }

  private extractCompletionReasoning(data: ChatCompletionResponse, jsonMode = false): string | undefined {
    if (jsonMode) {
      return undefined;
    }

    const choices = Array.isArray(data.choices) ? data.choices : [];
    const reasoningParts: string[] = [];

    for (const row of choices) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const choice = row as ChatCompletionChoice;
      const message = choice.message;
      if (message && typeof message === "object") {
        const raw = message as Record<string, unknown>;
        const reasoning =
          this.partToText(raw.reasoning_content, true).trim() || this.partToText(raw.reasoning, true).trim();
        if (reasoning.length > 0) {
          reasoningParts.push(reasoning);
        }
      }
    }

    const outputReasoning = this.extractOutputArrayReasoning(data.output);
    if (outputReasoning) {
      reasoningParts.push(outputReasoning);
    }

    if (reasoningParts.length === 0) {
      return undefined;
    }

    return reasoningParts.join("\n").trim() || undefined;
  }

  private extractMessageContent(
    message: ChatCompletionMessage | undefined,
    allowReasoningFallback = true
  ): string | undefined {
    if (!message) {
      return undefined;
    }

    const reasoningFallback = (): string | undefined => {
      if (!allowReasoningFallback) {
        return undefined;
      }
      const raw = message as Record<string, unknown>;
      const reasoningContent = this.partToText(raw.reasoning_content, true) || this.partToText(raw.reasoning, true);
      const trimmed = reasoningContent.trim();
      if (trimmed.length > 0) {
        this.debug(`chat:response reasoning chars=${trimmed.length}`);
      }
      return trimmed.length > 0 ? trimmed : undefined;
    };

    const content = message.content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
      return reasoningFallback();
    }

    if (content && typeof content === "object" && !Array.isArray(content)) {
      const single = this.partToText(content, allowReasoningFallback);
      const trimmed = single.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }

    if (!Array.isArray(content)) {
      return reasoningFallback();
    }

    const parts = content
      .map((part) => this.partToText(part, allowReasoningFallback))
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (parts.length === 0) {
      return reasoningFallback();
    }

    return parts.join("\n");
  }

  private partToText(part: unknown, allowReasoning = true): string {
    if (typeof part === "string") {
      return part;
    }
    if (!part || typeof part !== "object") {
      return "";
    }
    const row = part as Record<string, unknown>;

    const directText = row.text;
    if (typeof directText === "string") {
      return directText;
    }

    const value = row.value;
    if (typeof value === "string") {
      return value;
    }

    const outputText = row.output_text;
    if (typeof outputText === "string") {
      return outputText;
    }

    if (allowReasoning) {
      const reasoningContent = row.reasoning_content;
      if (typeof reasoningContent === "string") {
        return reasoningContent;
      }
      const reasoning = row.reasoning;
      if (typeof reasoning === "string") {
        return reasoning;
      }
    }

    const content = row.content;
    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => this.partToText(item, allowReasoning))
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .join("\n");
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

    const delta = row.delta;
    if (delta && typeof delta === "object") {
      const deltaText = this.partToText(delta, allowReasoning);
      if (deltaText.trim().length > 0) {
        return deltaText;
      }
    }

    return "";
  }

  private extractOutputArrayText(output: unknown): string | undefined {
    if (!Array.isArray(output)) {
      return undefined;
    }
    const messageParts: string[] = [];
    const reasoningParts: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const row = item as Record<string, unknown>;
      const type = typeof row.type === "string" ? row.type : "";
      const text = this.partToText(row, false).trim();
      if (!text) {
        continue;
      }
      if (type === "message") {
        messageParts.push(text);
      } else if (type === "reasoning") {
        reasoningParts.push(text);
      }
    }
    if (messageParts.length > 0) {
      return messageParts.join("\n");
    }
    if (reasoningParts.length > 0) {
      return reasoningParts.join("\n");
    }
    const parts = output
      .map((item) => this.partToText(item, false))
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (parts.length === 0) {
      return undefined;
    }
    return parts.join("\n");
  }

  private extractOutputArrayReasoning(output: unknown): string | undefined {
    if (!Array.isArray(output)) {
      return undefined;
    }
    const reasoningParts: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const row = item as Record<string, unknown>;
      const type = typeof row.type === "string" ? row.type : "";
      if (type !== "reasoning") {
        continue;
      }
      const text = this.partToText(row, true).trim();
      if (text.length > 0) {
        reasoningParts.push(text);
      }
    }
    if (reasoningParts.length === 0) {
      return undefined;
    }
    return reasoningParts.join("\n");
  }

  private previewPayloadForError(payload: unknown): string {
    try {
      const text = JSON.stringify(payload);
      if (!text) {
        return "Raw payload: (empty)";
      }
      const compact = text.replace(/\s+/g, " ").trim();
      const preview = compact.length > 900 ? `${compact.slice(0, 900)}...` : compact;
      return `Raw payload preview: ${preview}`;
    } catch {
      return "Raw payload preview unavailable.";
    }
  }

  private extractUsage(data: ChatCompletionResponse): TokenUsage | undefined {
    const promptTokens = this.toNonNegativeInt(data.usage?.prompt_tokens);
    const completionTokens = this.toNonNegativeInt(data.usage?.completion_tokens);
    const totalTokens = this.toNonNegativeInt(data.usage?.total_tokens);

    if (promptTokens + completionTokens + totalTokens <= 0) {
      const stats = (data as unknown as { stats?: Record<string, unknown> }).stats;
      const statsPrompt = this.toNonNegativeInt(stats?.input_tokens);
      const statsCompletion = this.toNonNegativeInt(stats?.total_output_tokens);
      const statsTotal = this.toNonNegativeInt(stats?.total_tokens);

      if (statsPrompt + statsCompletion + statsTotal <= 0) {
        return undefined;
      }
      return {
        promptTokens: statsPrompt,
        completionTokens: statsCompletion,
        totalTokens: statsTotal > 0 ? statsTotal : statsPrompt + statsCompletion
      };
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
    if (/^https?:\/\//i.test(pathname)) {
      return pathname;
    }
    const base = this.baseUrl.replace(/\/+$/, "");
    let path = pathname.startsWith("/") ? pathname : `/${pathname}`;
    try {
      const parsed = new URL(base);
      const basePath = parsed.pathname.replace(/\/+$/, "").toLowerCase();
      const lowerPath = path.toLowerCase();
      if (basePath.endsWith("/v1") && lowerPath.startsWith("/api/")) {
        return `${parsed.protocol}//${parsed.host}${path}`;
      }
      if (basePath.endsWith("/v1") && (lowerPath === "/v1" || lowerPath.startsWith("/v1/"))) {
        path = path.slice(3);
        if (!path.startsWith("/")) {
          path = `/${path}`;
        }
      }
    } catch {
      // keep default path join
    }
    return `${base}${path}`;
  }

  private normalizePath(pathname: string | undefined, fallback: string): string {
    const value = pathname?.trim();
    if (!value) {
      return fallback;
    }
    return value.startsWith("/") ? value : `/${value}`;
  }

  private buildModelEndpointCandidates(): string[] {
    const urls = new Set<string>();
    urls.add(this.joinUrl(this.modelsPath));
    urls.add(this.joinUrl("/models"));
    urls.add(this.joinUrl("/v1/models"));

    try {
      const parsed = new URL(this.baseUrl);
      const origin = `${parsed.protocol}//${parsed.host}`;
      urls.add(`${origin}/v1/models`);
      urls.add(`${origin}/models`);
    } catch {
      // keep joined-path fallbacks only
    }

    return Array.from(urls);
  }

  private extractModelIds(payload: unknown): string[] {
    const pushIds = (rows: unknown[]): string[] =>
      rows
        .map((item) => {
          if (typeof item === "string") {
            return item.trim();
          }
          if (item && typeof item === "object") {
            const id = (item as Record<string, unknown>).id;
            if (typeof id === "string") {
              return id.trim();
            }
          }
          return "";
        })
        .filter((id): id is string => id.length > 0);

    if (Array.isArray(payload)) {
      return Array.from(new Set(pushIds(payload))).sort((a, b) => a.localeCompare(b));
    }

    if (!payload || typeof payload !== "object") {
      return [];
    }

    const row = payload as Record<string, unknown>;
    const fromData = Array.isArray(row.data) ? pushIds(row.data) : [];
    const fromModels = Array.isArray(row.models) ? pushIds(row.models) : [];
    const merged = Array.from(new Set([...fromData, ...fromModels])).sort((a, b) => a.localeCompare(b));
    return merged;
  }

  private getEndpointMode(): EndpointMode {
    const path = this.chatPath.trim().toLowerCase();
    if (path === "/api/v1/chat" || path.endsWith("/api/v1/chat")) {
      return "lm_rest_chat";
    }
    return path.endsWith("/responses") ? "responses" : "chat_completions";
  }

  private toResponsesInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages.map((message) => ({
      role: message.role,
      content: message.content
    }));
  }

  private toLmRestInput(messages: ChatMessage[]): string {
    const withoutSystem = messages.filter((message) => message.role !== "system");
    if (withoutSystem.length === 1 && withoutSystem[0].role === "user") {
      return withoutSystem[0].content;
    }
    if (withoutSystem.length > 0) {
      return withoutSystem
        .map((message) => `[${message.role}] ${message.content}`)
        .join("\n\n")
        .trim();
    }
    const fallback = messages.map((message) => `[${message.role}] ${message.content}`).join("\n\n").trim();
    return fallback.length > 0 ? fallback : "Continue.";
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

  private normalizeExtraBody(value: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!value || typeof value !== "object") {
      return {};
    }
    const out: Record<string, unknown> = {};
    for (const [rawKey, rawVal] of Object.entries(value)) {
      const key = rawKey.trim();
      if (!key || rawVal === undefined) {
        continue;
      }
      out[key] = rawVal;
    }
    return out;
  }

  private buildExtraBodyPatch(): Record<string, unknown> {
    if (Object.keys(this.extraBody).length === 0) {
      return {};
    }
    const protectedKeys = new Set([
      "model",
      "messages",
      "input",
      "stream",
      "temperature",
      "max_tokens",
      "max_output_tokens"
    ]);
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.extraBody)) {
      if (protectedKeys.has(key)) {
        continue;
      }
      patch[key] = value;
    }
    return patch;
  }

  private buildHeaders(withJsonContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (withJsonContentType) {
      headers["Content-Type"] = "application/json";
    }

    const token = this.normalizeApiKey(this.apiKey);
    if (token.length > 0) {
      headers[this.apiKeyHeader] = `${this.apiKeyPrefix}${token}`;
    }

    return {
      ...headers,
      ...this.headers
    };
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

  private buildHttpErrorMessage(status: number, errorText: string, label: string): string {
    const base = `${this.providerName} ${label} ${status}: ${errorText}`;
    if (status !== 401) {
      return base;
    }
    const lower = String(errorText || "").toLowerCase();
    if (!lower.includes("invalid_api_key") && !lower.includes("malformed") && !lower.includes("api token")) {
      return base;
    }
    return `${base}\nHint: Set a valid token in localAgent.lmStudio.apiKey (or localAgent.provider.apiKey). Use raw token only, not 'Bearer ...' and not placeholder 'lm-studio'.`;
  }
}
