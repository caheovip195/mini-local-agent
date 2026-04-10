import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { LocalAgentRunner } from "./agent/runner";
import { extractJsonObject } from "./utils";
import type {
  AgentActivityStatus,
  AgentConfig,
  ExecutionPlan,
  StepStatus
} from "./agent/types";
import { LmStudioClient, type ChatMessage, type ThinkingEffort } from "./lmStudioClient";
import { LocalInlineCompletionProvider } from "./inlineCompletion";
import { buildWebviewHtml } from "./webviewHtml";

interface RunMode {
  type: "plan" | "agent" | "chat";
}

type WebviewEvent =
  | { type: "status"; text: string }
  | { type: "log"; text: string }
  | { type: "plan"; plan: ExecutionPlan }
  | { type: "step"; stepId: string; status: StepStatus }
  | { type: "done"; text: string }
  | { type: "error"; text: string }
  | { type: "running"; value: boolean }
  | { type: "chat_message"; role: "user" | "assistant"; text: string; timestamp: string }
  | { type: "thinking"; text?: string; clear?: boolean }
  | {
      type: "models";
      items: string[];
      selected: string;
      baseUrl: string;
      info?: string;
      error?: string;
    }
  | { type: "usage_reset" }
  | {
    type: "usage";
      phase: "preflight" | "planner" | "executor" | "chat";
      stepId?: string;
      turn?: number;
      model?: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cumulativePrompt: number;
      cumulativeCompletion: number;
      cumulativeTotal: number;
    }
  | {
      type: "activity";
      stepId: string;
      turn: number;
      actionType: string;
      status: AgentActivityStatus;
      detail: string;
    }
  | {
      type: "stream";
      phase: "executor";
      stepId: string;
      turn: number;
      streamId: string;
      text: string;
      done: boolean;
    }
  | {
      type: "run_context";
      mode: RunMode["type"];
      model: string;
    }
  | {
      type: "history";
      items: Array<{
        id: string;
        timestamp: string;
        mode: RunMode["type"];
        model: string;
        userPrompt: string;
        preflightSummary: string;
        runSummary: string;
        learningNote: string;
        remainingSteps: Array<{
          id: string;
          title: string;
          details: string;
          status: StepStatus;
        }>;
        status: "done" | "error" | "cancelled";
      }>;
    }
  | { type: "session_cleared" };

interface LmSettings {
  providerPreset: "lmstudio" | "custom";
  apiMode: "chat_completions" | "responses" | "lm_rest_chat";
  providerName: string;
  baseUrl: string;
  apiKey: string;
  apiKeySource: "lmStudio.apiKey" | "provider.apiKey" | "none";
  model: string;
  modelsPath: string;
  chatPath: string;
  presetName: string;
  headers: Record<string, string>;
  extraBody: Record<string, unknown>;
  lmStudioIntegrations: string[];
}

interface ModelBootstrapState {
  items: string[];
  selected: string;
  baseUrl: string;
  info?: string;
  error?: string;
}

interface UsageTotals {
  prompt: number;
  completion: number;
  total: number;
}

interface ThinkingSettings {
  enabled: boolean;
  effort: ThinkingEffort;
}

interface RemainingStepEntry {
  id: string;
  title: string;
  details: string;
  status: StepStatus;
}

interface LearningMemoryEntry {
  id: string;
  timestamp: string;
  status: "done" | "error" | "cancelled";
  task: string;
  lesson: string;
  rules: string[];
}

interface ConversationHistoryEntry {
  id: string;
  timestamp: string;
  mode: RunMode["type"];
  model: string;
  userPrompt: string;
  preflightSummary: string;
  runSummary: string;
  learningNote: string;
  remainingSteps: RemainingStepEntry[];
  status: "done" | "error" | "cancelled";
}

interface ChatTranscriptEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

const HISTORY_STORAGE_KEY = "localAgent.conversationHistory.v1";
const LEARNING_STORAGE_KEY = "localAgent.learningMemory.v1";
const CHAT_TRANSCRIPT_STORAGE_KEY = "localAgent.chatTranscript.v1";
const HISTORY_LIMIT = 40;
const LEARNING_LIMIT = 60;
const CHAT_TURN_LIMIT = 80;
const DEFAULT_LM_BASE_URL = "http://127.0.0.1:1234/v1";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Local Agent Coder");
  output.appendLine(`Local Agent Coder v${String((context.extension as unknown as { packageJSON?: { version?: string } }).packageJSON?.version ?? "unknown")} activated`);
  const provider = new LocalAgentViewProvider(context, output);
  const inlineProvider = new LocalInlineCompletionProvider(output);

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(LocalAgentViewProvider.viewType, provider),
    vscode.languages.registerInlineCompletionItemProvider(
      [{ scheme: "file" }, { scheme: "untitled" }],
      inlineProvider
    ),
    vscode.commands.registerCommand("localAgent.runTask", async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: "Enter task for Local Agent",
        placeHolder: "Implement feature X, fix bug Y..."
      });
      if (!prompt) {
        return;
      }
      await vscode.commands.executeCommand("workbench.view.extension.localAgent");
      await provider.run(prompt, { type: "agent" });
    }),
    vscode.commands.registerCommand("localAgent.planTask", async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: "Enter task to plan",
        placeHolder: "Plan implementation for..."
      });
      if (!prompt) {
        return;
      }
      await vscode.commands.executeCommand("workbench.view.extension.localAgent");
      await provider.run(prompt, { type: "plan" });
    }),
    vscode.commands.registerCommand("localAgent.reloadModels", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.localAgent");
      await provider.reloadModelsFromCommand();
    })
  );
}

export function deactivate(): void {
  // Nothing to clean up; disposables are registered in activate.
}

class LocalAgentViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "localAgent.chatView";

  private view?: vscode.WebviewView;
  private webviewReady = false;
  private pendingEvents: WebviewEvent[] = [];
  private running = false;
  private abortController?: AbortController;
  private usageTotals: UsageTotals = { prompt: 0, completion: 0, total: 0 };
  private history: ConversationHistoryEntry[] = [];
  private learningMemory: LearningMemoryEntry[] = [];
  private chatSession: ChatMessage[] = [];
  private chatTranscript: ChatTranscriptEntry[] = [];
  private sessionResetAtMs = 0;
  private modelBootstrap: ModelBootstrapState = {
    items: [],
    selected: "",
    baseUrl: DEFAULT_LM_BASE_URL
  };
  private didBootstrapRebuild = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.output.appendLine("resolveWebviewView: init");
    this.view = webviewView;
    this.webviewReady = false;
    this.pendingEvents = [];
    this.didBootstrapRebuild = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    this.history = this.readHistory();
    this.learningMemory = this.readLearningMemory();
    this.chatTranscript = this.readChatTranscript();
    this.chatSession = this.chatTranscript.map((entry) => ({ role: entry.role, content: entry.text }));
    const lm = this.readLmSettings();
    this.modelBootstrap = {
      items: lm.model ? [lm.model] : [],
      selected: lm.model,
      baseUrl: lm.baseUrl || DEFAULT_LM_BASE_URL
    };

    webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }

      const payload = message as Record<string, unknown>;
      const type = payload.type;
      this.output.appendLine(`webview message type=${String(type)}`);

      switch (type) {
        case "webview_ready": {
          this.webviewReady = true;
          this.output.appendLine("webview ready");
          this.flushPendingEvents();
          return;
        }

        case "run": {
          const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
          const mode = payload.mode === "plan" ? "plan" : payload.mode === "chat" ? "chat" : "agent";
          const model = typeof payload.model === "string" ? payload.model.trim() : "";
          const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl.trim() : "";
          const thinkingEnabled =
            typeof payload.thinkingEnabled === "boolean" ? payload.thinkingEnabled : undefined;
          const thinkingEffortRaw = typeof payload.thinkingEffort === "string" ? payload.thinkingEffort : undefined;
          const thinkingEffort = thinkingEffortRaw ? this.normalizeThinkingEffort(thinkingEffortRaw) : undefined;

          this.output.appendLine(
            `run request mode=${mode} model=${model || "-"} baseUrl=${baseUrl || "-"} thinking=${thinkingEnabled === true ? thinkingEffort || "medium" : "off"} promptChars=${prompt.length}`
          );

          if (!prompt) {
            this.post({ type: "error", text: "Prompt is required." });
            return;
          }

          await this.run(prompt, { type: mode }, model, baseUrl, thinkingEnabled, thinkingEffort);
          return;
        }

        case "stop": {
          this.abortController?.abort();
          return;
        }

        case "load_models": {
          const preferredModel = typeof payload.preferredModel === "string" ? payload.preferredModel : undefined;
          const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl : undefined;
          this.output.appendLine(
            `load_models request preferred=${preferredModel || "-"} baseUrl=${(baseUrl || "").trim() || "-"}`
          );
          this.post({
            type: "status",
            text: "Đang tải lại model list..."
          });
          await this.loadModels(preferredModel, baseUrl);
          return;
        }

        case "load_history": {
          this.postHistory();
          return;
        }

        case "clear_session": {
          await this.clearSession();
          return;
        }

        case "client_error": {
          const text = typeof payload.text === "string" ? payload.text : "Unknown webview error.";
          this.output.appendLine(`Webview error: ${text}`);
          return;
        }

        case "client_trace": {
          const text = typeof payload.text === "string" ? payload.text : "webview trace";
          this.output.appendLine(`Webview trace: ${text}`);
          return;
        }

        default:
          return;
      }
    });

    webviewView.webview.html = this.getHtml();

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        this.webviewReady = false;
        this.pendingEvents = [];
        this.didBootstrapRebuild = false;
      }
    });

    void this.loadModels(undefined, this.readLmSettings().baseUrl);
    this.postHistory();
    this.postChatTranscript();
  }

  async reloadModelsFromCommand(): Promise<void> {
    const lm = this.readLmSettings();
    this.output.appendLine(`manual reload command invoked baseUrl=${lm.baseUrl || "-"}`);
    this.post({ type: "status", text: "Đang tải lại model list..." });
    await this.loadModels(lm.model, lm.baseUrl);
  }

  async run(
    prompt: string,
    mode: RunMode,
    modelOverride?: string,
    baseUrlOverride?: string,
    thinkingEnabledOverride?: boolean,
    thinkingEffortOverride?: ThinkingEffort
  ): Promise<void> {
    if (this.running) {
      this.post({ type: "error", text: "Another task is already running." });
      return;
    }

    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.post({ type: "error", text: "Open a workspace folder first." });
      return;
    }

    const lmSettings = this.readLmSettings();
    const selectedModel = modelOverride && modelOverride.length > 0 ? modelOverride : lmSettings.model;
    const selectedBaseUrl = this.normalizeBaseUrl(baseUrlOverride || lmSettings.baseUrl, lmSettings.baseUrl);
    const defaultThinking = this.readThinkingSettings();
    const selectedThinkingEnabled =
      typeof thinkingEnabledOverride === "boolean" ? thinkingEnabledOverride : defaultThinking.enabled;
    const selectedThinkingEffort = this.normalizeThinkingEffort(thinkingEffortOverride ?? defaultThinking.effort);
    const preferredLanguage = this.toLanguageLabel(this.detectPreferredLanguage(prompt));

    const config = this.readConfig(
      workspace.uri.fsPath,
      {
        ...lmSettings,
        baseUrl: selectedBaseUrl,
        model: selectedModel
      },
      preferredLanguage,
      {
        enabled: selectedThinkingEnabled,
        effort: selectedThinkingEffort
      }
    );

    await this.persistLmSelection(selectedModel, selectedBaseUrl);
    await this.persistThinkingSelection(selectedThinkingEnabled, selectedThinkingEffort);

    this.output.appendLine(`Task mode=${mode.type}`);
    this.output.appendLine(`Provider=${lmSettings.providerName}`);
    this.output.appendLine(`API mode=${lmSettings.apiMode}`);
    this.output.appendLine(`Model=${selectedModel}`);
    this.output.appendLine(`BaseURL=${selectedBaseUrl}`);
    this.output.appendLine(`ChatPath=${config.chatPath}`);
    if (lmSettings.presetName) {
      this.output.appendLine(`LM Studio preset=${lmSettings.presetName}`);
    } else if (mode.type === "chat" && lmSettings.providerPreset === "lmstudio") {
      this.output.appendLine(
        "LM Studio preset is empty. If you rely on a custom LM Studio system prompt, set localAgent.lmStudio.preset/localAgent.provider.presetName so API requests use that preset."
      );
    }
    if (lmSettings.providerPreset === "lmstudio" && lmSettings.apiMode === "chat_completions") {
      this.output.appendLine(
        "Warning: LM Studio MCP servers are not available on /v1/chat/completions. Use localAgent.provider.apiMode='lm_rest_chat' (or chat mode auto MCP fallback) to use mcp.json integrations."
      );
      this.post({
        type: "log",
        text: "LM Studio MCP is disabled on /v1/chat/completions. Switch localAgent.provider.apiMode to 'lm_rest_chat' to use local mcp.json integrations."
      });
    }
    this.output.appendLine(`Thinking=${selectedThinkingEnabled ? selectedThinkingEffort : "off"}`);
    this.output.appendLine(`Prompt: ${prompt}`);

    this.running = true;
    this.abortController = new AbortController();
    this.resetUsage();

    this.post({ type: "run_context", mode: mode.type, model: selectedModel });
    this.post({ type: "running", value: true });
    this.post({
      type: "status",
      text:
        preferredLanguage === "Vietnamese"
          ? mode.type === "chat"
            ? "Đang chat..."
            : mode.type === "plan"
              ? "Đang lập kế hoạch..."
              : "Đang lập kế hoạch và thực thi..."
          : mode.type === "chat"
            ? "Chatting..."
            : mode.type === "plan"
              ? "Planning..."
            : "Planning + executing..."
    });
    this.post({
      type: "log",
      text: `Run started: mode=${mode.type}, model=${selectedModel}, baseUrl=${selectedBaseUrl}, thinking=${selectedThinkingEnabled ? selectedThinkingEffort : "off"}, apiMode=${lmSettings.apiMode}`
    });
    if (mode.type !== "chat") {
      this.post({
        type: "chat_message",
        role: "assistant",
        text:
          preferredLanguage === "Vietnamese"
            ? mode.type === "plan"
              ? `Đã bắt đầu lập kế hoạch bằng model ${selectedModel}.`
              : `Đã bắt đầu chạy agent bằng model ${selectedModel}.`
            : mode.type === "plan"
              ? `Planning started with model ${selectedModel}.`
              : `Agent run started with model ${selectedModel}.`,
        timestamp: new Date().toISOString()
      });
    }

    let chatIntegrations =
      mode.type === "chat" && lmSettings.providerPreset === "lmstudio"
        ? await this.resolveLmStudioIntegrations(lmSettings.lmStudioIntegrations)
        : [];
    let chatPathForRun =
      mode.type === "chat" &&
      lmSettings.providerPreset === "lmstudio" &&
      (lmSettings.apiMode === "lm_rest_chat" || chatIntegrations.length > 0)
        ? "/api/v1/chat"
        : config.chatPath;
    if (lmSettings.providerPreset === "lmstudio" && lmSettings.presetName && chatPathForRun === "/api/v1/chat") {
      chatPathForRun = "/chat/completions";
      if (chatIntegrations.length > 0) {
        this.output.appendLine(
          "LM Studio preset is set. Native /api/v1/chat does not support preset key, so integrations are disabled for this run."
        );
        this.post({
          type: "log",
          text: "Preset requires /v1/chat/completions. MCP integrations are disabled for this run."
        });
        chatIntegrations = [];
      }
      this.output.appendLine(
        `LM Studio preset compatibility: auto-switched chat path to ${chatPathForRun} (preset=${lmSettings.presetName}).`
      );
      this.post({
        type: "log",
        text: `Using preset '${lmSettings.presetName}' via /v1/chat/completions.`
      });
    }
    if (mode.type === "chat" && chatIntegrations.length > 0) {
      this.output.appendLine(
        `LM Studio MCP integrations enabled for chat: ${chatIntegrations.join(", ")} (path=${chatPathForRun})`
      );
      this.post({
        type: "log",
        text: `Using LM Studio MCP integrations: ${chatIntegrations.join(", ")}`
      });
    }

    const client = new LmStudioClient({
      providerName: config.providerName,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      modelsPath: config.modelsPath,
      chatPath: chatPathForRun,
      headers: config.headers,
      extraBody: config.extraBody,
      onDebug: (message) => this.output.appendLine(message)
    });

    let executionSummary =
      mode.type === "plan"
        ? "Plan created."
        : mode.type === "chat"
          ? "Chat completed."
          : "Execution finished.";
    let preflightSummary = "";
    let runStatus: ConversationHistoryEntry["status"] = "done";
    let latestPlan: ExecutionPlan | undefined;
    const stepStatuses = new Map<string, StepStatus>();
    const thinkingEffortForChat: ThinkingEffort | undefined = selectedThinkingEnabled ? selectedThinkingEffort : undefined;

    const runner =
      mode.type === "chat"
        ? undefined
        : new LocalAgentRunner(client, config.agentConfig, {
            onLog: (message) => {
              this.output.appendLine(message);
              this.post({ type: "log", text: message });
            },
            onStatus: (message) => {
              this.post({ type: "status", text: message });
            },
            onPlan: (plan) => {
              latestPlan = plan;
              for (const step of plan.steps) {
                stepStatuses.set(step.id, step.status);
              }
              this.post({ type: "plan", plan });
            },
            onStepStatus: (stepId, status) => {
              stepStatuses.set(stepId, status);
              this.post({ type: "step", stepId, status });
            },
            onDone: (summary) => {
              executionSummary = summary;
              this.post({ type: "done", text: summary });
            },
            onUsage: (event) => {
              this.pushUsageEvent({
                phase: event.phase,
                stepId: event.stepId,
                turn: event.turn,
                model: event.model,
                promptTokens: event.promptTokens,
                completionTokens: event.completionTokens,
                totalTokens: event.totalTokens
              });
            },
            onAction: (event) => {
              this.post({
                type: "activity",
                stepId: event.stepId,
                turn: event.turn,
                actionType: event.actionType,
                status: event.status,
                detail: event.detail
              });
            },
            onStream: (event) => {
              this.post({
                type: "stream",
                phase: event.phase,
                stepId: event.stepId,
                turn: event.turn,
                streamId: event.streamId,
                text: event.text,
                done: event.done
              });
            },
            onQuestion: async (question) => {
              const value = await vscode.window.showInputBox({
                prompt: `Agent needs input: ${question}`,
                placeHolder: "Leave empty to continue with default assumptions",
                ignoreFocusOut: true
              });
              return value?.trim() || "No additional input provided. Continue with best assumption.";
            }
          });

    try {
      if (mode.type === "chat") {
        preflightSummary = "Built-in preflight prompt disabled. Chat-only mode.";
        const userTimestamp = new Date().toISOString();
        await this.appendChatTranscript("user", prompt, userTimestamp);
        this.post({ type: "chat_message", role: "user", text: prompt, timestamp: userTimestamp });
        this.post({ type: "thinking", text: preferredLanguage === "Vietnamese" ? "Đang suy nghĩ..." : "Thinking..." });
        const chatGuardPrompt =
          "You are a coding assistant in VS Code. Reply in the same language as the user. Use clean Markdown formatting (headings, lists, code blocks, tables when useful). If the model supports reasoning channel, keep reasoning there and keep final answer readable.";
        let thinkingBuffer = "";
        let lastThinkingPushAt = 0;
        let sawReasoningDelta = false;
        let answerDeltaChars = 0;
        const pushThinking = (force = false): void => {
          const trimmed = thinkingBuffer.trim();
          if (!trimmed) {
            return;
          }
          const now = Date.now();
          if (!force && now - lastThinkingPushAt < 120) {
            return;
          }
          lastThinkingPushAt = now;
          this.post({ type: "thinking", text: trimmed.slice(-6000) });
        };
        const messages: ChatMessage[] = [
          { role: "system", content: chatGuardPrompt },
          ...this.chatSession,
        ];
        const response = await client.chat(messages, this.abortController.signal, {
          temperature: 0.25,
          maxTokens: 1600,
          stream: true,
          onDelta: (delta) => {
            const chunk = String(delta || "");
            if (!chunk) {
              return;
            }
            answerDeltaChars += chunk.length;
            if (sawReasoningDelta) {
              return;
            }
            const progressText =
              preferredLanguage === "Vietnamese"
                ? `Đang soạn câu trả lời... (${answerDeltaChars} ký tự)`
                : `Generating answer... (${answerDeltaChars} chars)`;
            thinkingBuffer = progressText;
            pushThinking(false);
          },
          onReasoningDelta: (delta) => {
            const next = String(delta || "");
            if (!next.trim()) {
              return;
            }
            sawReasoningDelta = true;
            thinkingBuffer += next;
            pushThinking(false);
          },
          thinkingEnabled: selectedThinkingEnabled,
          thinkingEffort: thinkingEffortForChat,
          integrations: chatIntegrations
        });
        if (response.usage) {
          this.pushUsageEvent({
            phase: "chat",
            model: response.model,
            promptTokens: response.usage.promptTokens,
            completionTokens: response.usage.completionTokens,
            totalTokens: response.usage.totalTokens
          });
        }
        if (!thinkingBuffer.trim() && response.reasoning && response.reasoning.trim()) {
          thinkingBuffer = response.reasoning.trim();
          pushThinking(true);
        }
        const answer = this.normalizeChatAnswer(response.content);
        if (!answer) {
          throw new Error("Model did not return a final answer text.");
        }
        const assistantTimestamp = new Date().toISOString();
        await this.appendChatTranscript("assistant", answer, assistantTimestamp);
        this.post({ type: "chat_message", role: "assistant", text: answer, timestamp: assistantTimestamp });
        this.post({ type: "thinking", clear: true });
        executionSummary = this.trimForPrompt(answer, 1200);
        this.post({ type: "done", text: preferredLanguage === "Vietnamese" ? "Chat xong." : "Chat completed." });
      } else if (mode.type === "plan") {
        preflightSummary = "Built-in preflight prompt disabled. Using raw user request.";
        this.output.appendLine(`Preflight summary: ${preflightSummary}`);
        this.post({ type: "log", text: `Preflight summary:\n${preflightSummary}` });
        const plan = await runner!.createPlan(prompt, this.abortController.signal);
        this.post({ type: "plan", plan });
        this.post({
          type: "done",
          text: "Plan created. No code was executed. Use 'Run Agent' to execute the plan."
        });
        executionSummary = `Plan created with ${plan.steps.length} steps.`;
      } else {
        preflightSummary = "Built-in preflight prompt disabled. Using raw user request.";
        this.output.appendLine(`Preflight summary: ${preflightSummary}`);
        this.post({ type: "log", text: `Preflight summary:\n${preflightSummary}` });
        await runner!.run(prompt, this.abortController.signal);
      }
    } catch (error) {
      runStatus = this.abortController?.signal.aborted ? "cancelled" : "error";
      const text = error instanceof Error ? error.message : String(error);
      executionSummary = text;
      this.output.appendLine(`Error: ${text}`);
      this.post({ type: "error", text });
      this.post({ type: "thinking", clear: true });
    } finally {
      const remainingSteps = this.collectRemainingSteps(latestPlan, stepStatuses);
      let learningNote = "";
      if (mode.type === "agent") {
        learningNote = "Built-in learning prompt disabled for LM Studio system prompt testing.";
      }

      try {
        await this.appendHistory({
          id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          mode: mode.type,
          model: selectedModel,
          userPrompt: prompt,
          preflightSummary,
          runSummary: executionSummary,
          learningNote,
          remainingSteps,
          status: runStatus
        });
      } catch (historyError) {
        const text = historyError instanceof Error ? historyError.message : String(historyError);
        this.output.appendLine(`History save error: ${text}`);
      }
      this.running = false;
      this.abortController = undefined;
      this.post({ type: "running", value: false });
    }
  }

  private async clearSession(): Promise<void> {
    if (this.running) {
      this.post({ type: "error", text: "Stop current run before clearing session." });
      return;
    }

    this.sessionResetAtMs = Date.now();
    this.chatSession = [];
    this.chatTranscript = [];
    await this.context.workspaceState.update(CHAT_TRANSCRIPT_STORAGE_KEY, this.chatTranscript);
    this.resetUsage();
    this.post({ type: "session_cleared" });
    this.post({ type: "status", text: "Session cleared. Ready for a new request." });
    this.post({ type: "thinking", clear: true });
    this.output.appendLine(`Session cleared at ${new Date(this.sessionResetAtMs).toISOString()}`);
  }

  private resetUsage(): void {
    this.usageTotals = { prompt: 0, completion: 0, total: 0 };
    this.post({ type: "usage_reset" });
  }

  private pushUsageEvent(event: {
    phase: "preflight" | "planner" | "executor" | "chat";
    stepId?: string;
    turn?: number;
    model?: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }): void {
    this.usageTotals.prompt += event.promptTokens;
    this.usageTotals.completion += event.completionTokens;
    this.usageTotals.total += event.totalTokens;

    this.post({
      type: "usage",
      phase: event.phase,
      stepId: event.stepId,
      turn: event.turn,
      model: event.model,
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
      totalTokens: event.totalTokens,
      cumulativePrompt: this.usageTotals.prompt,
      cumulativeCompletion: this.usageTotals.completion,
      cumulativeTotal: this.usageTotals.total
    });
  }

  private async buildPreflightTask(
    client: LmStudioClient,
    prompt: string,
    mode: RunMode,
    signal: AbortSignal,
    preferredLanguage: string,
    thinkingEnabled?: boolean,
    thinkingEffort?: ThinkingEffort
  ): Promise<{ compactTask: string; preflightSummary: string }> {
    const sessionHistory = this.getActiveSessionHistoryEntries();
    const unfinishedEntry = this.getMostRecentUnfinishedEntry(sessionHistory);
    const continuationIntent = this.isContinuationIntent(prompt);
    const relatedHistory = this.selectRelevantHistoryEntries(prompt, sessionHistory, 10);
    const hasRelatedHistory =
      continuationIntent && unfinishedEntry ? true : relatedHistory.length > 0;
    const learningRules = this.getLearningRulesForPrompt(prompt, 8);
    const learningRulesBlock =
      learningRules.length > 0
        ? learningRules.map((rule, index) => `${index + 1}. ${rule}`).join("\n")
        : "(No project learning rules yet)";

    const recentHistory = relatedHistory
      .map((entry, index) => {
        const remaining =
          entry.remainingSteps.length > 0
            ? this.formatRemainingSteps(entry.remainingSteps, 5)
            : "(none)";
        return [
          `History ${index + 1}:`,
          `- Time: ${entry.timestamp}`,
          `- Mode: ${entry.mode}`,
          `- Model: ${entry.model}`,
          `- Status: ${entry.status}`,
          `- User prompt: ${entry.userPrompt}`,
          `- Summary: ${entry.preflightSummary}`,
          `- Outcome: ${entry.runSummary}`,
          `- Learning: ${entry.learningNote || "(none)"}`,
          `- Remaining steps:\n${remaining}`
        ].join("\n");
      })
      .join("\n\n");

    const historyBlock =
      recentHistory.trim().length > 0 ? recentHistory : "(No related prior history for this request)";
    const unfinishedBlock =
      unfinishedEntry && unfinishedEntry.remainingSteps.length > 0
        ? [
            `Most recent unfinished run: ${unfinishedEntry.timestamp} (${unfinishedEntry.status})`,
            `Prompt: ${unfinishedEntry.userPrompt}`,
            "Remaining steps:",
            this.formatRemainingSteps(unfinishedEntry.remainingSteps, 8)
          ].join("\n")
        : "(No unfinished run context)";

    this.output.appendLine(
      `Preflight context selection: sessionHistory=${sessionHistory.length} relatedHistory=${relatedHistory.length} continuation=${continuationIntent ? "yes" : "no"}`
    );

    if (!hasRelatedHistory && !continuationIntent) {
      const executionBrief =
        preferredLanguage === "Vietnamese"
          ? "Không có hội thoại liên quan trước đó. Chỉ dùng yêu cầu hiện tại. Hãy đọc workspace trước rồi thực thi, tránh vòng lặp."
          : "No related prior conversation detected. Use only current request. Investigate workspace first, then execute without loops.";
      const preflightSummary = [
        preferredLanguage === "Vietnamese"
          ? "Hội thoại: (Không dùng ngữ cảnh trước đó liên quan.)"
          : "Conversation: (No related prior context used.)",
        preferredLanguage === "Vietnamese" ? `Yêu cầu hiện tại: ${prompt}` : `Current: ${prompt}`,
        preferredLanguage === "Vietnamese" ? `Tóm tắt thực thi: ${executionBrief}` : `Brief: ${executionBrief}`
      ].join("\n");

      const compactTask = [
        "Conversation memory summary:",
        "(No related prior context. Start fresh.)",
        "",
        `Current request:\n${prompt}`,
        "",
        `Execution brief:\n${executionBrief}`,
        "",
        `Original user request:\n${prompt}`
      ].join("\n");

      return { compactTask, preflightSummary };
    }

    const preflightResponse = await client.chat(
      [
        {
          role: "system",
          content: [
            "You compress conversation history for a coding agent.",
            "Goal: keep context short but actionable.",
            "Output STRICT JSON only with schema:",
            '{ "conversation_summary": "string", "current_request": "string", "execution_brief": "string", "assumptions": ["string"] }',
            "Rules:",
            "- Keep concise.",
            "- Mention only facts from history and current request.",
            "- Keep anti-loop and anti-stall mindset in execution_brief.",
            "- If the user asks to continue unfinished work, prioritize unresolved steps from history.",
            `- Write all fields in this language: ${preferredLanguage}.`
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `Mode: ${mode.type}`,
            "",
            "Previous conversation history:",
            historyBlock,
            "",
            "Project learning memory rules:",
            learningRulesBlock,
            "",
            "Unfinished run context:",
            unfinishedBlock,
            "",
            "Current user request:",
            prompt,
            "",
            "Return JSON now."
          ].join("\n")
        }
      ],
      signal,
      {
        temperature: 0.1,
        maxTokens: 700,
        thinkingEnabled,
        thinkingEffort,
        responseFormat: "json_object"
      }
    );

    if (preflightResponse.usage) {
      this.pushUsageEvent({
        phase: "preflight",
        model: preflightResponse.model,
        promptTokens: preflightResponse.usage.promptTokens,
        completionTokens: preflightResponse.usage.completionTokens,
        totalTokens: preflightResponse.usage.totalTokens
      });
    }

    let conversationSummary = "";
    let currentRequest = "";
    let executionBrief = "";

    try {
      const parsed = extractJsonObject(preflightResponse.content) as Record<string, unknown>;
      conversationSummary = this.toText(parsed.conversation_summary, "No prior context.");
      currentRequest = this.toText(parsed.current_request, prompt);
      executionBrief = this.toText(
        parsed.execution_brief,
        preferredLanguage === "Vietnamese"
          ? "Hãy đọc workspace trước, sau đó thực thi mà không hỏi dư thừa."
          : "Investigate workspace first, then execute without unnecessary questions."
      );
    } catch {
      conversationSummary = this.trimForPrompt(preflightResponse.content, 700);
      currentRequest = prompt;
      executionBrief =
        preferredLanguage === "Vietnamese"
          ? "Ưu tiên điều tra trước và thực thi với vòng lặp tối thiểu."
          : "Investigate first and execute with minimal loops.";
    }

    if (continuationIntent && unfinishedEntry && unfinishedEntry.remainingSteps.length > 0) {
      currentRequest = [
        currentRequest,
        "",
        "Continuation directive:",
        `Continue unfinished work from ${unfinishedEntry.timestamp}.`,
        "Prioritize remaining steps before opening new scope:",
        this.formatRemainingSteps(unfinishedEntry.remainingSteps, 8)
      ].join("\n");

      executionBrief = [
        executionBrief,
        preferredLanguage === "Vietnamese"
          ? "Bắt đầu từ các bước còn dang dở của lần chạy trước."
          : "Start from remaining steps of unfinished run.",
        preferredLanguage === "Vietnamese"
          ? "Không làm lại từ đầu nếu các bước trước đã hoàn thành."
          : "Do not restart from scratch if steps are already done."
      ].join(" ");
    }

    if (learningRules.length > 0) {
      executionBrief =
        preferredLanguage === "Vietnamese"
          ? `${executionBrief} Áp dụng các quy tắc rút ra từ lịch sử dự án.`
          : `${executionBrief} Apply project learning rules from memory.`;
    }

    const preflightSummary = [
      preferredLanguage === "Vietnamese"
        ? `Hội thoại: ${conversationSummary}`
        : `Conversation: ${conversationSummary}`,
      preferredLanguage === "Vietnamese" ? `Yêu cầu hiện tại: ${currentRequest}` : `Current: ${currentRequest}`,
      preferredLanguage === "Vietnamese" ? `Tóm tắt thực thi: ${executionBrief}` : `Brief: ${executionBrief}`,
      learningRules.length > 0
        ? preferredLanguage === "Vietnamese"
          ? `Quy tắc: ${learningRules.join(" | ")}`
          : `Rules: ${learningRules.join(" | ")}`
        : "",
      continuationIntent && unfinishedEntry
        ? preferredLanguage === "Vietnamese"
          ? `Nguồn tiếp tục: ${unfinishedEntry.timestamp}`
          : `Continuation source: ${unfinishedEntry.timestamp}`
        : ""
    ]
      .filter(Boolean)
      .join("\n")
      .trim();

    const compactTask = [
      `Conversation memory summary:\n${conversationSummary}`,
      `Current request:\n${currentRequest}`,
      `Execution brief:\n${executionBrief}`,
      `Project learning rules:\n${learningRulesBlock}`,
      `Unfinished run context:\n${unfinishedBlock}`,
      `Original user request:\n${prompt}`
    ].join("\n\n");

    return { compactTask, preflightSummary };
  }

  private toText(value: unknown, fallback: string): string {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  }

  private trimForPrompt(text: string, limit: number): string {
    if (text.length <= limit) {
      return text.trim();
    }
    return `${text.slice(0, limit).trim()}...`;
  }

  private isContinuationIntent(prompt: string): boolean {
    const text = prompt.toLowerCase();
    const patterns = [
      /continue/,
      /resume/,
      /tiếp tục/,
      /lam tiep/,
      /làm tiếp/,
      /dang do/,
      /dang d[oở]/,
      /unfinished/,
      /còn lại/,
      /còn dang dở/,
      /tiep phan con lai/,
      /phần còn lại/
    ];
    return patterns.some((pattern) => pattern.test(text));
  }

  private formatRemainingSteps(steps: RemainingStepEntry[], limit: number): string {
    if (!Array.isArray(steps) || steps.length === 0) {
      return "(none)";
    }
    return steps
      .slice(0, Math.max(1, limit))
      .map((step) => `[${step.id}] ${step.title} (${step.status}) - ${step.details}`)
      .join("\n");
  }

  private collectRemainingSteps(
    plan: ExecutionPlan | undefined,
    stepStatuses: Map<string, StepStatus>
  ): RemainingStepEntry[] {
    if (!plan || !Array.isArray(plan.steps)) {
      return [];
    }

    return plan.steps
      .map((step) => {
        const status = stepStatuses.get(step.id) ?? step.status ?? "pending";
        return {
          id: step.id,
          title: this.toText(step.title, step.id),
          details: this.toText(step.details, ""),
          status
        };
      })
      .filter((step) => step.status !== "done")
      .slice(0, 14);
  }

  private normalizeRemainingSteps(value: unknown): RemainingStepEntry[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item): RemainingStepEntry | undefined => {
        if (!item || typeof item !== "object") {
          return undefined;
        }
        const row = item as Record<string, unknown>;
        const id = this.toText(row.id, "");
        const title = this.toText(row.title, "");
        if (!id || !title) {
          return undefined;
        }
        const statusRaw = this.toText(row.status, "pending");
        const status: StepStatus =
          statusRaw === "done" || statusRaw === "in_progress" || statusRaw === "failed"
            ? statusRaw
            : "pending";
        return {
          id,
          title,
          details: this.toText(row.details, ""),
          status
        };
      })
      .filter((entry): entry is RemainingStepEntry => Boolean(entry))
      .slice(0, 14);
  }

  private getMostRecentUnfinishedEntry(
    source: ConversationHistoryEntry[] = this.history
  ): ConversationHistoryEntry | undefined {
    const reversed = [...source].reverse();
    return reversed.find((entry) => entry.remainingSteps.length > 0);
  }

  private getActiveSessionHistoryEntries(): ConversationHistoryEntry[] {
    if (this.sessionResetAtMs <= 0) {
      return this.history;
    }
    return this.history.filter((entry) => this.toTimestampMs(entry.timestamp) >= this.sessionResetAtMs);
  }

  private selectRelevantHistoryEntries(
    prompt: string,
    source: ConversationHistoryEntry[],
    limit: number
  ): ConversationHistoryEntry[] {
    if (source.length === 0) {
      return [];
    }

    const promptTerms = this.extractSemanticTerms(prompt);
    if (promptTerms.length === 0) {
      return source.slice(-Math.max(1, limit));
    }

    const promptSet = new Set(promptTerms);
    const scored = source
      .map((entry, index) => {
        const context = [
          entry.userPrompt,
          entry.preflightSummary,
          entry.runSummary,
          entry.learningNote,
          entry.remainingSteps.map((step) => `${step.id} ${step.title} ${step.details}`).join(" ")
        ]
          .filter(Boolean)
          .join("\n");
        const score = this.computeSemanticOverlap(promptSet, context);
        const directContainment =
          this.containsNormalizedText(prompt, entry.userPrompt) ||
          this.containsNormalizedText(entry.userPrompt, prompt);
        return {
          entry,
          index,
          score: directContainment ? Math.max(score, 0.24) : score
        };
      })
      .filter((row) => row.score >= 0.14)
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, Math.max(1, limit));

    return scored.map((row) => row.entry);
  }

  private getLearningRulesForPrompt(prompt: string, limit: number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const recent = [...this.learningMemory].slice(-12).reverse();
    const promptTerms = new Set(this.extractSemanticTerms(prompt));

    for (const item of recent) {
      const context = [item.task, item.lesson, item.rules.join(" ")].join("\n");
      const overlap = this.computeSemanticOverlap(promptTerms, context);
      if (promptTerms.size > 0 && overlap < 0.12) {
        continue;
      }

      for (const rule of item.rules) {
        const normalized = rule.trim();
        if (!normalized || seen.has(normalized)) {
          continue;
        }
        seen.add(normalized);
        out.push(normalized);
        if (out.length >= Math.max(1, limit)) {
          return out;
        }
      }
    }

    return out;
  }

  private extractSemanticTerms(text: string): string[] {
    const lower = text.toLowerCase();
    const tokens = lower.match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
    const stopWords = new Set([
      "the",
      "and",
      "for",
      "with",
      "from",
      "into",
      "this",
      "that",
      "have",
      "has",
      "your",
      "about",
      "task",
      "request",
      "please",
      "current",
      "history",
      "continue",
      "resume",
      "make",
      "just",
      "only",
      "lam",
      "tiep",
      "yeu",
      "cau",
      "cho",
      "toi",
      "nay",
      "cua",
      "nhung",
      "cac",
      "va",
      "mot"
    ]);

    const out: string[] = [];
    for (const token of tokens) {
      const normalized = token.trim();
      if (!normalized || stopWords.has(normalized) || /^\d+$/.test(normalized)) {
        continue;
      }
      out.push(normalized);
    }

    return Array.from(new Set(out)).slice(0, 40);
  }

  private computeSemanticOverlap(promptTerms: Set<string>, text: string): number {
    if (promptTerms.size === 0) {
      return 0;
    }
    const terms = new Set(this.extractSemanticTerms(text));
    if (terms.size === 0) {
      return 0;
    }
    let hits = 0;
    for (const token of promptTerms) {
      if (terms.has(token)) {
        hits += 1;
      }
    }
    return hits / Math.max(promptTerms.size, terms.size);
  }

  private containsNormalizedText(source: string, needle: string): boolean {
    const sourceText = source.trim().toLowerCase();
    const needleText = needle.trim().toLowerCase();
    if (!sourceText || !needleText) {
      return false;
    }
    return sourceText.includes(needleText);
  }

  private toTimestampMs(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private detectPreferredLanguage(prompt: string): "vi" | "en" {
    const text = prompt.toLowerCase();
    const vietnameseChars =
      /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;
    const vietnameseWords =
      /\b(tôi|mình|bạn|không|được|giúp|làm|viết|sửa|tiếp|dùng|cần|đang|màn|phần|lỗi|đúng|sai)\b/i;
    if (vietnameseChars.test(prompt) || vietnameseWords.test(text)) {
      return "vi";
    }
    return "en";
  }

  private toLanguageLabel(code: "vi" | "en"): string {
    return code === "vi" ? "Vietnamese" : "English";
  }

  private async buildLearningNote(
    client: LmStudioClient,
    input: {
      prompt: string;
      preflightSummary: string;
      runSummary: string;
      status: "done" | "error" | "cancelled";
      remainingSteps: RemainingStepEntry[];
    },
    preferredLanguage: string,
    thinkingEnabled?: boolean,
    thinkingEffort?: ThinkingEffort
  ): Promise<{ lesson: string; rules: string[] }> {
    const remainingBlock =
      input.remainingSteps.length > 0 ? this.formatRemainingSteps(input.remainingSteps, 6) : "(none)";
    const response = await client.chat(
      [
        {
          role: "system",
          content: [
            "You generate learning notes after each coding-agent run.",
            "Return STRICT JSON only with schema:",
            '{ "lesson": "string", "rules": ["string"] }',
            "Rules:",
            "- Keep lesson practical and short.",
            "- Rules must be concrete, reusable for the same project.",
            "- Focus on architecture fit, anti-loop behavior, and execution quality.",
            `- Write lesson and rules in this language: ${preferredLanguage}.`
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `Status: ${input.status}`,
            `Task: ${input.prompt}`,
            "",
            "Preflight summary:",
            input.preflightSummary || "(none)",
            "",
            "Run summary:",
            input.runSummary || "(none)",
            "",
            "Remaining steps:",
            remainingBlock,
            "",
            "Return JSON now."
          ].join("\n")
        }
      ],
      undefined,
      {
        temperature: 0.1,
        maxTokens: 260,
        thinkingEnabled,
        thinkingEffort,
        responseFormat: "json_object"
      }
    );

    if (response.usage) {
      this.pushUsageEvent({
        phase: "preflight",
        model: response.model,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens
      });
    }

    try {
      const parsed = extractJsonObject(response.content) as Record<string, unknown>;
      const lesson = this.toText(parsed.lesson, "Prioritize small, architecture-aligned changes with evidence.");
      const rules = (Array.isArray(parsed.rules) ? parsed.rules : [])
        .map((item) => this.toText(item, ""))
        .filter((item) => item.length > 0)
        .slice(0, 6);
      return { lesson: this.trimForPrompt(lesson, 500), rules };
    } catch {
      return {
        lesson: this.trimForPrompt(response.content, 500),
        rules: []
      };
    }
  }

  private readLearningMemory(): LearningMemoryEntry[] {
    const raw = this.context.workspaceState.get<unknown[]>(LEARNING_STORAGE_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map((item): LearningMemoryEntry | undefined => {
        if (!item || typeof item !== "object") {
          return undefined;
        }
        const row = item as Record<string, unknown>;
        const lesson = this.toText(row.lesson, "");
        if (!lesson) {
          return undefined;
        }
        const statusRaw = this.toText(row.status, "done");
        const status: LearningMemoryEntry["status"] =
          statusRaw === "error" || statusRaw === "cancelled" ? statusRaw : "done";

        return {
          id: this.toText(row.id, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`),
          timestamp: this.toText(row.timestamp, new Date().toISOString()),
          status,
          task: this.toText(row.task, ""),
          lesson,
          rules: (Array.isArray(row.rules) ? row.rules : [])
            .map((entry) => this.toText(entry, ""))
            .filter((entry) => entry.length > 0)
            .slice(0, 8)
        };
      })
      .filter((entry): entry is LearningMemoryEntry => Boolean(entry))
      .slice(-LEARNING_LIMIT);
  }

  private async appendLearningMemory(entry: LearningMemoryEntry): Promise<void> {
    const normalized: LearningMemoryEntry = {
      ...entry,
      task: this.trimForPrompt(entry.task, 700),
      lesson: this.trimForPrompt(entry.lesson, 700),
      rules: entry.rules.map((rule) => this.trimForPrompt(rule, 220)).slice(0, 8)
    };

    this.learningMemory = [...this.learningMemory, normalized].slice(-LEARNING_LIMIT);
    await this.context.workspaceState.update(LEARNING_STORAGE_KEY, this.learningMemory);
  }

  private readHistory(): ConversationHistoryEntry[] {
    const raw = this.context.workspaceState.get<unknown[]>(HISTORY_STORAGE_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map((item): ConversationHistoryEntry | undefined => {
        if (!item || typeof item !== "object") {
          return undefined;
        }

        const row = item as Record<string, unknown>;
        const userPrompt = this.toText(row.userPrompt, "");
        if (!userPrompt) {
          return undefined;
        }

        const mode = row.mode === "plan" ? "plan" : row.mode === "chat" ? "chat" : "agent";
        const statusRaw = this.toText(row.status, "done");
        const status: ConversationHistoryEntry["status"] =
          statusRaw === "error" || statusRaw === "cancelled" ? statusRaw : "done";

        return {
          id: this.toText(row.id, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`),
          timestamp: this.toText(row.timestamp, new Date().toISOString()),
          mode,
          model: this.toText(row.model, "unknown"),
          userPrompt,
          preflightSummary: this.toText(row.preflightSummary, ""),
          runSummary: this.toText(row.runSummary, ""),
          learningNote: this.toText(row.learningNote, ""),
          remainingSteps: this.normalizeRemainingSteps(row.remainingSteps),
          status
        };
      })
      .filter((entry): entry is ConversationHistoryEntry => Boolean(entry))
      .slice(-HISTORY_LIMIT);
  }

  private async appendHistory(entry: ConversationHistoryEntry): Promise<void> {
    const normalized: ConversationHistoryEntry = {
      ...entry,
      userPrompt: this.trimForPrompt(entry.userPrompt, 2000),
      preflightSummary: this.trimForPrompt(entry.preflightSummary, 1400),
      runSummary: this.trimForPrompt(entry.runSummary, 1400),
      learningNote: this.trimForPrompt(entry.learningNote, 800),
      remainingSteps: this.normalizeRemainingSteps(entry.remainingSteps)
    };

    this.history = [...this.history, normalized].slice(-HISTORY_LIMIT);
    await this.context.workspaceState.update(HISTORY_STORAGE_KEY, this.history);
    this.postHistory();
  }

  private postHistory(): void {
    this.post({
      type: "history",
      items: [...this.history].reverse()
    });
  }

  private readChatTranscript(): ChatTranscriptEntry[] {
    const raw = this.context.workspaceState.get<unknown[]>(CHAT_TRANSCRIPT_STORAGE_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((item): ChatTranscriptEntry | undefined => {
        if (!item || typeof item !== "object") {
          return undefined;
        }
        const row = item as Record<string, unknown>;
        const role: ChatTranscriptEntry["role"] = row.role === "user" ? "user" : "assistant";
        const text = this.toText(row.text, "");
        if (!text) {
          return undefined;
        }
        return {
          role,
          text: this.trimForPrompt(text, 4000),
          timestamp: this.toText(row.timestamp, new Date().toISOString())
        };
      })
      .filter((entry): entry is ChatTranscriptEntry => Boolean(entry))
      .slice(-CHAT_TURN_LIMIT);
  }

  private async appendChatTranscript(role: "user" | "assistant", text: string, timestamp: string): Promise<void> {
    const normalized: ChatTranscriptEntry = {
      role,
      text: this.trimForPrompt(text, 4000),
      timestamp: this.toText(timestamp, new Date().toISOString())
    };
    this.chatTranscript = [...this.chatTranscript, normalized].slice(-CHAT_TURN_LIMIT);
    this.chatSession = this.chatTranscript.map((entry) => ({ role: entry.role, content: entry.text }));
    await this.context.workspaceState.update(CHAT_TRANSCRIPT_STORAGE_KEY, this.chatTranscript);
  }

  private postChatTranscript(): void {
    for (const item of this.chatTranscript) {
      this.post({ type: "chat_message", role: item.role, text: item.text, timestamp: item.timestamp });
    }
  }

  private async persistLmSelection(model: string, baseUrl: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("localAgent");
    const updates: Array<Thenable<unknown>> = [];

    if (model.trim()) {
      updates.push(cfg.update("lmStudio.model", model, vscode.ConfigurationTarget.Workspace));
      updates.push(cfg.update("provider.model", model, vscode.ConfigurationTarget.Workspace));
    }

    if (baseUrl.trim()) {
      updates.push(cfg.update("lmStudio.baseUrl", baseUrl, vscode.ConfigurationTarget.Workspace));
      updates.push(cfg.update("provider.baseUrl", baseUrl, vscode.ConfigurationTarget.Workspace));
    }

    if (updates.length === 0) {
      return;
    }

    try {
      await Promise.all(updates);
    } catch {
      // Ignore config update errors and continue run.
    }
  }

  private async persistThinkingSelection(enabled: boolean, effort: ThinkingEffort): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("localAgent");
    try {
      await Promise.all([
        cfg.update("thinking.enabled", enabled, vscode.ConfigurationTarget.Workspace),
        cfg.update("thinking.effort", this.normalizeThinkingEffort(effort), vscode.ConfigurationTarget.Workspace)
      ]);
    } catch {
      // Ignore config update errors and continue run.
    }
  }

  private async loadModels(preferredModel?: string, baseUrlOverride?: string): Promise<void> {
    const lm = this.readLmSettings();
    const selectedBaseUrl = this.normalizeBaseUrl(baseUrlOverride || lm.baseUrl, lm.baseUrl);
    const fallbackModel = preferredModel || lm.model;
    this.output.appendLine(
      `loadModels start provider=${lm.providerName} apiMode=${lm.apiMode} baseUrl=${selectedBaseUrl} preferred=${preferredModel || "-"} auth=${lm.apiKeySource}${lm.apiKey ? "(set)" : "(empty)"}`
    );

    try {
      const createClient = (modelsPath: string) =>
        new LmStudioClient({
          providerName: lm.providerName,
          baseUrl: selectedBaseUrl,
          apiKey: lm.apiKey,
          model: fallbackModel,
          modelsPath,
          chatPath: lm.chatPath,
          headers: lm.headers,
          extraBody: lm.extraBody,
          onDebug: (message) => this.output.appendLine(message)
        });

      let modelsPathUsed = lm.modelsPath;
      let models: string[] = [];
      try {
        const timeoutMs = 12000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          models = await createClient(modelsPathUsed).listModels(controller.signal);
        } finally {
          clearTimeout(timer);
        }
      } catch (firstError) {
        if (lm.modelsPath !== "/models") {
          this.output.appendLine(
            `loadModels retry with /models after failure at ${lm.modelsPath}: ${firstError instanceof Error ? firstError.message : String(firstError)}`
          );
          modelsPathUsed = "/models";
          const timeoutMs = 12000;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            models = await createClient(modelsPathUsed).listModels(controller.signal);
          } finally {
            clearTimeout(timer);
          }
        } else {
          throw firstError;
        }
      }
      const items = models.length > 0 ? models : [fallbackModel];
      const selected = items.includes(fallbackModel) ? fallbackModel : items[0];
      this.output.appendLine(
        `loadModels ok provider=${lm.providerName} apiMode=${lm.apiMode} baseUrl=${selectedBaseUrl} modelsPath=${modelsPathUsed} chatPath=${lm.chatPath} preset=${lm.presetName || "-"} count=${items.length} selected=${selected}`
      );

      this.post({
        type: "models",
        items,
        selected,
        baseUrl: selectedBaseUrl,
        info: `Loaded ${items.length} model(s) from ${lm.providerName}.`
      });
      this.modelBootstrap = {
        items,
        selected,
        baseUrl: selectedBaseUrl,
        info: `Loaded ${items.length} model(s) from ${lm.providerName}.`
      };
      this.rebuildWebviewIfNotReady("models_loaded_before_ready");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const normalizedText = /aborted|cancelled|canceled/i.test(text)
        ? "Model load timed out after 12s. Please verify LM Studio server is reachable at this URL."
        : text;
      this.output.appendLine(`loadModels failed baseUrl=${selectedBaseUrl} error=${text}`);
      this.post({
        type: "models",
        items: [fallbackModel],
        selected: fallbackModel,
        baseUrl: selectedBaseUrl,
        error: `Could not load models: ${normalizedText}`
      });
      this.modelBootstrap = {
        items: [fallbackModel],
        selected: fallbackModel,
        baseUrl: selectedBaseUrl,
        error: `Could not load models: ${normalizedText}`
      };
      this.rebuildWebviewIfNotReady("models_error_before_ready");
    }
  }

  private rebuildWebviewIfNotReady(reason: string): void {
    if (!this.view || this.webviewReady || this.didBootstrapRebuild) {
      return;
    }
    this.didBootstrapRebuild = true;
    this.output.appendLine(`webview rebuild fallback reason=${reason}`);
    this.view.webview.html = this.getHtml();
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

  private post(event: WebviewEvent): void {
    if (!this.view) {
      return;
    }

    void this.view.webview.postMessage(event);

    if (!this.webviewReady) {
      this.pendingEvents.push(event);
      if (this.pendingEvents.length > 40) {
        this.pendingEvents = this.pendingEvents.slice(-40);
      }
    }
  }

  private flushPendingEvents(): void {
    if (!this.view || !this.webviewReady || this.pendingEvents.length === 0) {
      return;
    }

    const queued = this.pendingEvents;
    this.pendingEvents = [];

    for (const event of queued) {
      void this.view.webview.postMessage(event);
    }
  }

  private readLmSettings(): LmSettings {
    const cfg = vscode.workspace.getConfiguration("localAgent");
    const legacyBaseUrl = cfg.get<string>("lmStudio.baseUrl", DEFAULT_LM_BASE_URL);
    const legacyApiKey = this.normalizeApiKey(cfg.get<string>("lmStudio.apiKey", ""));
    const legacyModel = cfg.get<string>("lmStudio.model", "qwen2.5-coder-7b-instruct");

    const rawPreset = cfg.get<string>("provider.preset", "lmstudio").trim().toLowerCase();
    const configuredPreset: LmSettings["providerPreset"] = rawPreset === "custom" ? "custom" : "lmstudio";
    const providerPreset: LmSettings["providerPreset"] = configuredPreset;
    const apiModeInspect = cfg.inspect<string>("provider.apiMode");
    const hasUserApiModeOverride =
      typeof apiModeInspect?.workspaceFolderValue === "string" ||
      typeof apiModeInspect?.workspaceValue === "string" ||
      typeof apiModeInspect?.globalValue === "string";
    const rawApiMode = cfg.get<string>("provider.apiMode", "lm_rest_chat").trim().toLowerCase();
    let apiMode: LmSettings["apiMode"] =
      rawApiMode === "chat_completions"
        ? "chat_completions"
        : rawApiMode === "lm_rest_chat"
          ? "lm_rest_chat"
          : "responses";
    if (configuredPreset === "lmstudio" && !hasUserApiModeOverride) {
      apiMode = "lm_rest_chat";
    }
    const configuredPresetName = cfg.get<string>("provider.presetName", "").trim();
    const legacyLmPreset = cfg.get<string>("lmStudio.preset", "").trim();
    const presetName = configuredPresetName || legacyLmPreset;

    const providerBaseUrl = cfg.get<string>("provider.baseUrl", "").trim();
    const providerApiKey = this.normalizeApiKey(cfg.get<string>("provider.apiKey", ""));
    const providerModel = cfg.get<string>("provider.model", "").trim();
    const providerModelsPath = this.normalizeApiPath(cfg.get<string>("provider.modelsPath", "/models"), "/models");
    const providerChatPathDefault =
      apiMode === "responses" ? "/responses" : apiMode === "lm_rest_chat" ? "/api/v1/chat" : "/chat/completions";
    const providerChatPathRaw = cfg.get<string>("provider.chatPath", providerChatPathDefault);
    const providerChatPathNormalized = this.normalizeApiPath(providerChatPathRaw, providerChatPathDefault);
    const providerChatPath =
      apiMode === "responses" && providerChatPathNormalized === "/chat/completions"
        ? "/responses"
        : providerChatPathNormalized;
    const lmStudioIntegrations = this.normalizeIntegrationIds(cfg.get<string[]>("lmStudio.integrations", []));
    const extraHeaders = this.parseHeaderJson(cfg.get<string>("provider.extraHeaders", "{}"));
    const extraBody = this.parseBodyJson(cfg.get<string>("provider.extraBody", "{}"));
    if (presetName.length > 0 && !Object.prototype.hasOwnProperty.call(extraBody, "preset")) {
      extraBody.preset = presetName;
    }

    let baseUrl = legacyBaseUrl;
    let apiKey = providerApiKey.length > 0 ? providerApiKey : legacyApiKey;
    let apiKeySource: LmSettings["apiKeySource"] =
      providerApiKey.length > 0 ? "provider.apiKey" : legacyApiKey.length > 0 ? "lmStudio.apiKey" : "none";
    let model = legacyModel;
    let modelsPath = "/models";
    let chatPath = providerChatPath;
    let headers: Record<string, string> = {};

    if (providerPreset === "custom") {
      baseUrl = providerBaseUrl.length > 0 ? providerBaseUrl : legacyBaseUrl;
      apiKey = providerApiKey.length > 0 ? providerApiKey : legacyApiKey;
      apiKeySource = providerApiKey.length > 0 ? "provider.apiKey" : legacyApiKey.length > 0 ? "lmStudio.apiKey" : "none";
      model = providerModel.length > 0 ? providerModel : legacyModel;
      modelsPath = providerModelsPath;
      chatPath = providerChatPath;
      headers = { ...extraHeaders };
    }
    const providerName = providerPreset === "custom" ? "Custom API" : "LM Studio";

    return {
      providerPreset,
      apiMode,
      providerName,
      baseUrl,
      apiKey,
      apiKeySource,
      model,
      modelsPath,
      chatPath,
      presetName,
      headers,
      extraBody,
      lmStudioIntegrations
    };
  }

  private normalizeThinkingEffort(value: unknown): ThinkingEffort {
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "low" || raw === "high") {
      return raw;
    }
    return "medium";
  }

  private readThinkingSettings(): ThinkingSettings {
    const cfg = vscode.workspace.getConfiguration("localAgent");
    const enabled = cfg.get<boolean>("thinking.enabled", false);
    const effort = this.normalizeThinkingEffort(cfg.get<string>("thinking.effort", "medium"));
    return { enabled, effort };
  }

  private readConfig(
    workspaceRoot: string,
    lm: LmSettings,
    preferredLanguage: string,
    thinking?: ThinkingSettings
  ): {
    providerName: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    modelsPath: string;
    chatPath: string;
    headers: Record<string, string>;
    extraBody: Record<string, unknown>;
    agentConfig: AgentConfig;
  } {
    const cfg = vscode.workspace.getConfiguration("localAgent");
    const thinkingSettings = thinking ?? this.readThinkingSettings();

    return {
      providerName: lm.providerName,
      baseUrl: lm.baseUrl,
      apiKey: lm.apiKey,
      model: lm.model,
      modelsPath: lm.modelsPath,
      chatPath: lm.chatPath,
      headers: lm.headers,
      extraBody: lm.extraBody,
      agentConfig: {
        workspaceRoot,
        preferredLanguage,
        guardMode: this.normalizeGuardMode(cfg.get<string>("guardMode", "relaxed")),
        thinkingEnabled: thinkingSettings.enabled,
        thinkingEffort: thinkingSettings.effort,
        systemPromptMode: this.normalizeSystemPromptMode(cfg.get<string>("systemPromptMode", "strict")),
        strictResponsibilityMode: cfg.get<boolean>("strictResponsibilityMode", false),
        maxTurnsPerStep: cfg.get<number>("maxTurnsPerStep", 14),
        executorMaxTokens: cfg.get<number>("executorMaxTokens", 7000),
        maxAskUser: cfg.get<number>("maxAskUser", 1),
        minInvestigationsBeforeExecute: cfg.get<number>("minInvestigationsBeforeExecute", 1),
        strategyCandidates: cfg.get<number>("strategyCandidates", 3),
        commandTimeoutMs: cfg.get<number>("commandTimeoutMs", 120000),
        autoApplyWrites: cfg.get<boolean>("autoApplyWrites", true),
        extraSystemPrompt: cfg.get<string>("systemPromptExtra", "")
      }
    };
  }

  private normalizeApiPath(value: string, fallback: string): string {
    const raw = value.trim();
    if (!raw) {
      return fallback;
    }
    return raw.startsWith("/") ? raw : `/${raw}`;
  }

  private normalizeGuardMode(value: unknown): "strict" | "balanced" | "relaxed" {
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "strict" || raw === "balanced" || raw === "relaxed") {
      return raw;
    }
    return "relaxed";
  }

  private normalizeSystemPromptMode(value: unknown): "strict" | "provider_first" {
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "provider_first" || raw === "provider-first" || raw === "providerfirst") {
      return "provider_first";
    }
    return "strict";
  }

  private normalizeChatAnswer(value: string): string {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    const withoutLedger = raw.replace(/\n{0,2}LEDGER_UPDATE[\s\S]*$/i, "").trim();
    const cleaned = withoutLedger
      .replace(/^thinking process:\s*/i, "")
      .replace(/^reasoning:\s*/i, "")
      .trim();
    return cleaned;
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
      this.output.appendLine("provider.extraHeaders parse failed. Expected JSON object.");
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
      this.output.appendLine("provider.extraBody parse failed. Expected JSON object.");
      return {};
    }
  }

  private normalizeIntegrationIds(items: readonly string[]): string[] {
    if (!Array.isArray(items)) {
      return [];
    }
    const out: string[] = [];
    for (const value of items) {
      const raw = String(value ?? "").trim();
      if (!raw) {
        continue;
      }
      const normalized = raw.startsWith("mcp/") ? raw : `mcp/${raw}`;
      out.push(normalized);
    }
    return Array.from(new Set(out));
  }

  private async resolveLmStudioIntegrations(configured: string[]): Promise<string[]> {
    const normalizedConfigured = this.normalizeIntegrationIds(configured);
    if (normalizedConfigured.length > 0) {
      return normalizedConfigured;
    }

    const mcpPath = `${os.homedir()}/.lmstudio/mcp.json`;
    try {
      const raw = await fs.readFile(mcpPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const servers = parsed?.mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
        return [];
      }
      const labels = Object.keys(servers).map((key) => key.trim()).filter((key) => key.length > 0);
      const discovered = this.normalizeIntegrationIds(labels);
      if (discovered.length > 0) {
        this.output.appendLine(`Discovered LM Studio MCP integrations from ${mcpPath}: ${discovered.join(", ")}`);
      }
      return discovered;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`No LM Studio mcp.json integrations discovered: ${text}`);
      return [];
    }
  }

  private getHtml(): string {
    return buildWebviewHtml(this.readThinkingSettings(), this.modelBootstrap);
  }
}
