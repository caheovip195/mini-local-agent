import * as vscode from "vscode";

import { LocalAgentRunner } from "./agent/runner";
import { extractJsonObject } from "./utils";
import type {
  AgentActivityStatus,
  AgentConfig,
  ExecutionPlan,
  StepStatus
} from "./agent/types";
import { LmStudioClient } from "./lmStudioClient";
import { LocalInlineCompletionProvider } from "./inlineCompletion";

interface RunMode {
  type: "plan" | "agent";
}

type WebviewEvent =
  | { type: "status"; text: string }
  | { type: "log"; text: string }
  | { type: "plan"; plan: ExecutionPlan }
  | { type: "step"; stepId: string; status: StepStatus }
  | { type: "done"; text: string }
  | { type: "error"; text: string }
  | { type: "running"; value: boolean }
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
      phase: "preflight" | "planner" | "executor";
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
  providerPreset: "lmstudio" | "openrouter" | "custom";
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  modelsPath: string;
  chatPath: string;
  headers: Record<string, string>;
  quickOpenRouter: boolean;
}

interface UsageTotals {
  prompt: number;
  completion: number;
  total: number;
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

const HISTORY_STORAGE_KEY = "localAgent.conversationHistory.v1";
const LEARNING_STORAGE_KEY = "localAgent.learningMemory.v1";
const HISTORY_LIMIT = 40;
const LEARNING_LIMIT = 60;
const DEFAULT_LM_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Local Agent Coder");
  output.appendLine("Local Agent Coder v0.0.22 activated");
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
    vscode.commands.registerCommand("localAgent.setupOpenRouterSimple", async () => {
      await provider.setupOpenRouterSimple();
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
  private sessionResetAtMs = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.webviewReady = false;
    this.pendingEvents = [];

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    this.history = this.readHistory();
    this.learningMemory = this.readLearningMemory();

    webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }

      const payload = message as Record<string, unknown>;
      const type = payload.type;
      this.output.appendLine(`webview message type=${String(type)}`);

      if (type === "webview_ready") {
        this.webviewReady = true;
        this.output.appendLine("webview ready");
        this.flushPendingEvents();
        return;
      }

      if (type === "run") {
        const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
        const mode = payload.mode === "plan" ? "plan" : "agent";
        const model = typeof payload.model === "string" ? payload.model.trim() : "";
        const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl.trim() : "";

        if (!prompt) {
          this.post({ type: "error", text: "Prompt is required." });
          return;
        }

        await this.run(prompt, { type: mode }, model, baseUrl);
      }

      if (type === "stop") {
        this.abortController?.abort();
      }

      if (type === "load_models") {
        const preferredModel = typeof payload.preferredModel === "string" ? payload.preferredModel : undefined;
        const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl : undefined;
        this.output.appendLine(
          `load_models request preferred=${preferredModel || "-"} baseUrl=${(baseUrl || "").trim() || "-"}`
        );
        await this.loadModels(preferredModel, baseUrl);
      }

      if (type === "load_history") {
        this.postHistory();
      }

      if (type === "clear_session") {
        this.clearSession();
      }

      if (type === "client_error") {
        const text = typeof payload.text === "string" ? payload.text : "Unknown webview error.";
        this.output.appendLine(`Webview error: ${text}`);
      }

      if (type === "client_trace") {
        const text = typeof payload.text === "string" ? payload.text : "webview trace";
        this.output.appendLine(`Webview trace: ${text}`);
      }
    });

    webviewView.webview.html = this.getHtml();

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        this.webviewReady = false;
        this.pendingEvents = [];
      }
    });

    void this.loadModels(undefined, this.readLmSettings().baseUrl);
    this.postHistory();
  }

  async setupOpenRouterSimple(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("localAgent");
    const existingKey = cfg.get<string>("openRouter.apiKey", "").trim();
    const existingModel = cfg.get<string>("openRouter.model", "openrouter/auto").trim() || "openrouter/auto";

    const keyInput = await vscode.window.showInputBox({
      prompt: "OpenRouter API key",
      placeHolder: "sk-or-v1-...",
      password: true,
      ignoreFocusOut: true
    });
    if (keyInput === undefined) {
      return;
    }

    const nextApiKey = keyInput.trim().length > 0 ? keyInput.trim() : existingKey;
    if (!nextApiKey) {
      vscode.window.showErrorMessage("OpenRouter API key is required.");
      return;
    }

    const modelInput = await vscode.window.showInputBox({
      prompt: "OpenRouter model (simple mode)",
      placeHolder: "openrouter/auto",
      value: existingModel,
      ignoreFocusOut: true
    });
    if (modelInput === undefined) {
      return;
    }
    const nextModel = modelInput.trim() || "openrouter/auto";

    try {
      await Promise.all([
        cfg.update("openRouter.simpleMode", true, vscode.ConfigurationTarget.Workspace),
        cfg.update("openRouter.apiKey", nextApiKey, vscode.ConfigurationTarget.Workspace),
        cfg.update("openRouter.model", nextModel, vscode.ConfigurationTarget.Workspace),
        cfg.update("provider.preset", "openrouter", vscode.ConfigurationTarget.Workspace)
      ]);
      this.output.appendLine(`OpenRouter simple setup saved. model=${nextModel}`);
      void this.loadModels(nextModel, DEFAULT_OPENROUTER_BASE_URL);
      vscode.window.showInformationMessage("OpenRouter simple mode is enabled.");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`OpenRouter simple setup failed: ${text}`);
      vscode.window.showErrorMessage(`OpenRouter setup failed: ${text}`);
    }
  }

  async run(
    prompt: string,
    mode: RunMode,
    modelOverride?: string,
    baseUrlOverride?: string
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
    if (lmSettings.providerPreset === "openrouter" && this.isMissingOpenRouterApiKey(lmSettings.apiKey)) {
      this.post({
        type: "error",
        text:
          "OpenRouter API key is missing. Set localAgent.openRouter.apiKey (simple mode) or localAgent.provider.apiKey."
      });
      return;
    }
    const selectedModel = modelOverride && modelOverride.length > 0 ? modelOverride : lmSettings.model;
    const selectedBaseUrl = this.normalizeBaseUrl(baseUrlOverride || lmSettings.baseUrl, lmSettings.baseUrl);

    const config = this.readConfig(workspace.uri.fsPath, {
      ...lmSettings,
      baseUrl: selectedBaseUrl,
      model: selectedModel
    });

    await this.persistLmSelection(selectedModel, selectedBaseUrl);

    this.output.appendLine(`Task mode=${mode.type}`);
    this.output.appendLine(`Provider=${lmSettings.providerName}`);
    this.output.appendLine(`Model=${selectedModel}`);
    this.output.appendLine(`BaseURL=${selectedBaseUrl}`);
    this.output.appendLine(`Prompt: ${prompt}`);

    this.running = true;
    this.abortController = new AbortController();
    this.resetUsage();

    this.post({ type: "run_context", mode: mode.type, model: selectedModel });
    this.post({ type: "running", value: true });
    this.post({ type: "status", text: mode.type === "plan" ? "Planning..." : "Planning + executing..." });

    const client = new LmStudioClient({
      providerName: config.providerName,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      modelsPath: config.modelsPath,
      chatPath: config.chatPath,
      headers: config.headers
    });

    let executionSummary =
      mode.type === "plan"
        ? "Plan created."
        : "Execution finished.";
    let preflightSummary = "";
    let runStatus: ConversationHistoryEntry["status"] = "done";
    let latestPlan: ExecutionPlan | undefined;
    const stepStatuses = new Map<string, StepStatus>();

    const runner = new LocalAgentRunner(client, config.agentConfig, {
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
      this.post({ type: "status", text: "Summarizing conversation memory..." });
      const preflight = await this.buildPreflightTask(client, prompt, mode, this.abortController.signal);
      preflightSummary = preflight.preflightSummary;
      this.output.appendLine(`Preflight summary: ${preflightSummary}`);
      this.post({ type: "log", text: `Preflight summary:\n${preflightSummary}` });

      if (mode.type === "plan") {
        const plan = await runner.createPlan(preflight.compactTask, this.abortController.signal);
        this.post({ type: "plan", plan });
        this.post({
          type: "done",
          text: "Plan created. No code was executed. Use 'Run Agent' to execute the plan."
        });
        executionSummary = `Plan created with ${plan.steps.length} steps.`;
      } else {
        await runner.run(preflight.compactTask, this.abortController.signal);
      }
    } catch (error) {
      runStatus = this.abortController?.signal.aborted ? "cancelled" : "error";
      const text = error instanceof Error ? error.message : String(error);
      executionSummary = text;
      this.output.appendLine(`Error: ${text}`);
      this.post({ type: "error", text });
    } finally {
      const remainingSteps = this.collectRemainingSteps(latestPlan, stepStatuses);
      let learningNote = "";

      if (mode.type === "agent" && runStatus !== "cancelled") {
        try {
          const learning = await this.buildLearningNote(client, {
            prompt,
            preflightSummary,
            runSummary: executionSummary,
            status: runStatus,
            remainingSteps
          });
          learningNote = learning.lesson;
          await this.appendLearningMemory({
            id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            status: runStatus,
            task: this.trimForPrompt(prompt, 600),
            lesson: learning.lesson,
            rules: learning.rules
          });
          this.output.appendLine(`Learning note: ${learning.lesson}`);
          if (learning.rules.length > 0) {
            this.post({ type: "log", text: `Learning rules: ${learning.rules.join(" | ")}` });
          }
        } catch (learningError) {
          const text = learningError instanceof Error ? learningError.message : String(learningError);
          this.output.appendLine(`Learning note skipped: ${text}`);
        }
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
      void this.loadModels(selectedModel, selectedBaseUrl);
    }
  }

  private clearSession(): void {
    if (this.running) {
      this.post({ type: "error", text: "Stop current run before clearing session." });
      return;
    }

    this.sessionResetAtMs = Date.now();
    this.resetUsage();
    this.post({ type: "session_cleared" });
    this.post({ type: "status", text: "Session cleared. Ready for a new request." });
    this.output.appendLine(`Session cleared at ${new Date(this.sessionResetAtMs).toISOString()}`);
  }

  private resetUsage(): void {
    this.usageTotals = { prompt: 0, completion: 0, total: 0 };
    this.post({ type: "usage_reset" });
  }

  private pushUsageEvent(event: {
    phase: "preflight" | "planner" | "executor";
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
    signal: AbortSignal
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
        "No related prior conversation detected. Use only current request. Investigate workspace first, then execute without loops.";
      const preflightSummary = [
        "Conversation: (No related prior context used.)",
        `Current: ${prompt}`,
        `Brief: ${executionBrief}`
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
            "- If the user asks to continue unfinished work, prioritize unresolved steps from history."
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
      { temperature: 0.1, maxTokens: 700 }
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
        "Investigate workspace first, then execute without unnecessary questions."
      );
    } catch {
      conversationSummary = this.trimForPrompt(preflightResponse.content, 700);
      currentRequest = prompt;
      executionBrief = "Investigate first and execute with minimal loops.";
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
        "Start from remaining steps of unfinished run.",
        "Do not restart from scratch if steps are already done."
      ].join(" ");
    }

    if (learningRules.length > 0) {
      executionBrief = `${executionBrief} Apply project learning rules from memory.`;
    }

    const preflightSummary = [
      `Conversation: ${conversationSummary}`,
      `Current: ${currentRequest}`,
      `Brief: ${executionBrief}`,
      learningRules.length > 0 ? `Rules: ${learningRules.join(" | ")}` : "",
      continuationIntent && unfinishedEntry ? `Continuation source: ${unfinishedEntry.timestamp}` : ""
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

  private async buildLearningNote(
    client: LmStudioClient,
    input: {
      prompt: string;
      preflightSummary: string;
      runSummary: string;
      status: "done" | "error" | "cancelled";
      remainingSteps: RemainingStepEntry[];
    }
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
            "- Focus on architecture fit, anti-loop behavior, and execution quality."
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
      { temperature: 0.1, maxTokens: 260 }
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

        const mode = row.mode === "plan" ? "plan" : "agent";
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

  private async persistLmSelection(model: string, baseUrl: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("localAgent");
    const updates: Array<Thenable<unknown>> = [];
    const quickOpenRouter = cfg.get<boolean>("openRouter.simpleMode", false);

    if (model.trim()) {
      updates.push(cfg.update("lmStudio.model", model, vscode.ConfigurationTarget.Workspace));
      updates.push(cfg.update("provider.model", model, vscode.ConfigurationTarget.Workspace));
      if (quickOpenRouter) {
        updates.push(cfg.update("openRouter.model", model, vscode.ConfigurationTarget.Workspace));
      }
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

  private async loadModels(preferredModel?: string, baseUrlOverride?: string): Promise<void> {
    const lm = this.readLmSettings();
    const selectedBaseUrl = this.normalizeBaseUrl(baseUrlOverride || lm.baseUrl, lm.baseUrl);
    const fallbackModel = preferredModel || lm.model;
    if (lm.providerPreset === "openrouter" && this.isMissingOpenRouterApiKey(lm.apiKey)) {
      const message =
        "OpenRouter API key is missing. Set localAgent.openRouter.apiKey (simple mode) or localAgent.provider.apiKey.";
      this.output.appendLine(`loadModels blocked: ${message}`);
      this.post({
        type: "models",
        items: [fallbackModel],
        selected: fallbackModel,
        baseUrl: selectedBaseUrl,
        error: message
      });
      return;
    }

    try {
      const client = new LmStudioClient({
        providerName: lm.providerName,
        baseUrl: selectedBaseUrl,
        apiKey: lm.apiKey,
        model: fallbackModel,
        modelsPath: lm.modelsPath,
        chatPath: lm.chatPath,
        headers: lm.headers
      });

      const models = await client.listModels();
      const items = models.length > 0 ? models : [fallbackModel];
      const selected = items.includes(fallbackModel) ? fallbackModel : items[0];
      this.output.appendLine(
        `loadModels ok provider=${lm.providerName} baseUrl=${selectedBaseUrl} count=${items.length} selected=${selected}`
      );

      this.post({
        type: "models",
        items,
        selected,
        baseUrl: selectedBaseUrl,
        info: `Loaded ${items.length} model(s) from ${lm.providerName}.`
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`loadModels failed baseUrl=${selectedBaseUrl} error=${text}`);
      this.post({
        type: "models",
        items: [fallbackModel],
        selected: fallbackModel,
        baseUrl: selectedBaseUrl,
        error: `Could not load models: ${text}`
      });
    }
  }

  private isMissingOpenRouterApiKey(value: string): boolean {
    const key = value.trim();
    if (!key) {
      return true;
    }
    const placeholder = new Set(["lm-studio", "your-openrouter-key", "changeme", "none"]);
    return placeholder.has(key.toLowerCase());
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
    const legacyApiKey = cfg.get<string>("lmStudio.apiKey", "lm-studio");
    const legacyModel = cfg.get<string>("lmStudio.model", "qwen2.5-coder-7b-instruct");
    const quickOpenRouter = cfg.get<boolean>("openRouter.simpleMode", false);
    const quickOpenRouterApiKey = cfg.get<string>("openRouter.apiKey", "").trim();
    const quickOpenRouterModel = cfg.get<string>("openRouter.model", "openrouter/auto").trim();
    const quickOpenRouterSiteUrl = cfg.get<string>("openRouter.siteUrl", "").trim();
    const quickOpenRouterAppName = cfg.get<string>("openRouter.appName", "Local Agent Coder").trim();

    const rawPreset = cfg.get<string>("provider.preset", "lmstudio").trim().toLowerCase();
    const configuredPreset: LmSettings["providerPreset"] =
      rawPreset === "openrouter" || rawPreset === "custom" ? rawPreset : "lmstudio";
    const providerPreset: LmSettings["providerPreset"] = quickOpenRouter ? "openrouter" : configuredPreset;

    const providerBaseUrl = cfg.get<string>("provider.baseUrl", "").trim();
    const providerApiKey = cfg.get<string>("provider.apiKey", "").trim();
    const providerModel = cfg.get<string>("provider.model", "").trim();
    const providerModelsPath = this.normalizeApiPath(cfg.get<string>("provider.modelsPath", "/models"), "/models");
    const providerChatPath = this.normalizeApiPath(
      cfg.get<string>("provider.chatPath", "/chat/completions"),
      "/chat/completions"
    );
    const extraHeaders = this.parseHeaderJson(cfg.get<string>("provider.extraHeaders", "{}"));

    const baseDefault = providerPreset === "openrouter" ? DEFAULT_OPENROUTER_BASE_URL : legacyBaseUrl;
    const baseUrl = quickOpenRouter
      ? DEFAULT_OPENROUTER_BASE_URL
      : providerBaseUrl.length > 0
        ? providerBaseUrl
        : baseDefault;
    const apiKey = quickOpenRouter
      ? quickOpenRouterApiKey || providerApiKey || legacyApiKey
      : providerApiKey.length > 0
        ? providerApiKey
        : legacyApiKey;
    const model = quickOpenRouter
      ? quickOpenRouterModel || providerModel || legacyModel
      : providerModel.length > 0
        ? providerModel
        : legacyModel;
    const modelsPath = quickOpenRouter ? "/models" : providerModelsPath;
    const chatPath = quickOpenRouter ? "/chat/completions" : providerChatPath;

    const headers: Record<string, string> = { ...extraHeaders };
    if (providerPreset === "openrouter") {
      const configuredSiteUrl = cfg.get<string>("provider.openRouterSiteUrl", "").trim();
      const configuredAppName = cfg.get<string>("provider.openRouterAppName", "Local Agent Coder").trim();
      const siteUrl = quickOpenRouter ? quickOpenRouterSiteUrl || configuredSiteUrl : configuredSiteUrl;
      const appName = quickOpenRouter ? quickOpenRouterAppName || configuredAppName : configuredAppName;
      if (siteUrl.length > 0) {
        headers["HTTP-Referer"] = siteUrl;
      }
      if (appName.length > 0) {
        headers["X-Title"] = appName;
      }
    }

    const providerName =
      providerPreset === "openrouter"
        ? quickOpenRouter
          ? "OpenRouter (Simple)"
          : "OpenRouter"
        : providerPreset === "custom"
          ? "Custom API"
          : "LM Studio";

    return {
      providerPreset,
      providerName,
      baseUrl,
      apiKey,
      model,
      modelsPath,
      chatPath,
      headers,
      quickOpenRouter
    };
  }

  private readConfig(workspaceRoot: string, lm: LmSettings): {
    providerName: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    modelsPath: string;
    chatPath: string;
    headers: Record<string, string>;
    agentConfig: AgentConfig;
  } {
    const cfg = vscode.workspace.getConfiguration("localAgent");

    return {
      providerName: lm.providerName,
      baseUrl: lm.baseUrl,
      apiKey: lm.apiKey,
      model: lm.model,
      modelsPath: lm.modelsPath,
      chatPath: lm.chatPath,
      headers: lm.headers,
      agentConfig: {
        workspaceRoot,
        maxTurnsPerStep: cfg.get<number>("maxTurnsPerStep", 10),
        executorMaxTokens: cfg.get<number>("executorMaxTokens", 3200),
        maxAskUser: cfg.get<number>("maxAskUser", 0),
        minInvestigationsBeforeExecute: cfg.get<number>("minInvestigationsBeforeExecute", 3),
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

  private getHtml(): string {
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>Local Agent</title>
  <style>
    :root {
      --bg: #f3f7f4;
      --ink: #172126;
      --muted: #587178;
      --line: #cfddcf;
      --panel: #ffffff;
      --accent: #0c8c72;
      --accent-strong: #066d59;
      --warn: #d98e2f;
      --bad: #c75050;
      --ok: #17845f;
      --chip: #e9f4ef;
    }

    body {
      margin: 0;
      padding: 12px;
      color: var(--ink);
      background: radial-gradient(circle at 0% 0%, #d8eee6 0%, var(--bg) 45%), linear-gradient(150deg, #f3f7f4 0%, #eef7f2 100%);
      font-family: "Space Grotesk", "IBM Plex Sans", "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1.5;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
      gap: 10px;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
      padding: 10px;
      box-shadow: 0 6px 24px rgba(20, 40, 32, 0.08);
      margin-bottom: 10px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 6px;
    }

    .title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }

    .hint {
      color: var(--muted);
      font-size: 11px;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      background: #eef6f1;
      color: #244c43;
      padding: 3px 8px;
      border-radius: 999px;
      font-weight: 600;
      max-width: 100%;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
    }

    .row {
      display: flex;
      gap: 8px;
      margin-top: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .grow {
      flex: 1;
      min-width: 180px;
    }

    textarea, select, input, button {
      font: inherit;
    }

    textarea {
      width: 100%;
      min-height: 100px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
      box-sizing: border-box;
      background: #fbfefd;
      color: var(--ink);
    }

    select, input[type="text"] {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px;
      background: #fbfefd;
      color: var(--ink);
    }

    button {
      border: 0;
      border-radius: 10px;
      padding: 8px 11px;
      background: #dbeae2;
      color: #1f3b35;
      cursor: pointer;
      font-weight: 600;
    }

    button.primary {
      background: var(--accent);
      color: #f5fffc;
    }

    button.warn {
      background: #f6d9d9;
      color: #7a2f2f;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .metric {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fbfefd;
      padding: 8px;
    }

    .metric .k {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    .metric .v {
      font-size: 16px;
      font-weight: 700;
      margin-top: 2px;
    }

    .progress {
      margin-top: 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      height: 8px;
      overflow: hidden;
      background: #f0f5f1;
    }

    .progress > div {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, var(--accent) 0%, #4ec0a5 100%);
      transition: width 120ms ease;
    }

    .list {
      list-style: none;
      padding: 0;
      margin: 0;
      max-height: 260px;
      overflow: auto;
      display: grid;
      gap: 6px;
    }

    .item {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px;
      background: #fbfefd;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .item[data-status="in_progress"] { border-color: #f2cb95; background: #fff8ef; }
    .item[data-status="done"] { border-color: #9bd3b8; background: #f0fbf4; }
    .item[data-status="failed"] { border-color: #e8a2a2; background: #fff2f2; }

    .activity {
      max-height: 260px;
      overflow: auto;
      display: grid;
      gap: 6px;
    }

    .activity-card {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px;
      background: #fbfefd;
    }

    .history-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      margin-bottom: 6px;
    }

    .history-meta {
      color: var(--muted);
      font-size: 10px;
    }

    .history-btn {
      border: 1px solid var(--line);
      background: #eef6f1;
      color: #234941;
      border-radius: 8px;
      font-size: 11px;
      padding: 4px 8px;
    }

    .model-tags {
      margin-top: 6px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .model-tag {
      border: 1px solid var(--line);
      background: #eef6f1;
      color: #234941;
      border-radius: 999px;
      font-size: 11px;
      padding: 3px 8px;
      cursor: pointer;
    }

    .model-tag.active {
      background: #0c8c72;
      border-color: #0c8c72;
      color: #f4fffb;
    }

    .activity-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }

    .badge {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      border-radius: 999px;
      padding: 2px 7px;
      background: var(--chip);
      color: #2c564d;
      border: 1px solid #b8d6c7;
    }

    .badge.blocked { background: #fff2df; color: #87510f; border-color: #efc891; }
    .badge.recovery { background: #f3e9ff; color: #5d3f8f; border-color: #d1b8ef; }

    .mono {
      font-family: "IBM Plex Mono", "Cascadia Mono", monospace;
      font-size: 11px;
    }

    .logs {
      max-height: 180px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px;
      background: #fcfefd;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .error { color: var(--bad); }
    .done { color: var(--ok); }

    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      .meta-grid { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>
  <div class="panel">
    <div class="header">
      <div class="title">Local Agent</div>
      <div id="status" class="status-pill">Idle</div>
    </div>
    <div class="hint">Plan only creates the plan. Run Agent actually executes tools and code changes.</div>
  </div>

  <div class="layout">
    <div>
      <div class="panel">
        <div class="header">
          <div class="title">Task</div>
          <div id="runMeta" class="hint">Mode: - | Model: -</div>
        </div>

        <div class="row">
          <div class="grow">
            <input id="baseUrlInput" type="text" placeholder="LM Studio URL (e.g. http://127.0.0.1:1234/v1)" />
          </div>
        </div>

        <div class="row">
          <div class="grow">
            <select id="modelSelect"></select>
          </div>
          <button id="reloadModels">Reload Models</button>
        </div>
        <div id="modelTags" class="model-tags"></div>
        <div id="modelInfo" class="hint"></div>

        <textarea id="prompt" placeholder="Describe what to build or fix..."></textarea>

        <div class="row">
          <button id="planBtn">Plan Only</button>
          <button id="runBtn" class="primary">Run Agent</button>
          <button id="stopBtn" class="warn">Stop</button>
          <button id="clearSessionBtn">Clear Session</button>
        </div>
      </div>

      <div class="panel">
        <div class="header">
          <div class="title">Plan Progress</div>
          <div id="stepStats" class="hint">0/0 done</div>
        </div>
        <div class="progress"><div id="progressBar"></div></div>
        <ul id="plan" class="list" style="margin-top:8px;"></ul>
      </div>
    </div>

    <div>
      <div class="panel">
        <div class="title" style="margin-bottom:8px;">Token Usage</div>
        <div class="meta-grid">
          <div class="metric"><div class="k">Prompt</div><div id="tokPrompt" class="v">0</div></div>
          <div class="metric"><div class="k">Completion</div><div id="tokCompletion" class="v">0</div></div>
          <div class="metric"><div class="k">Total</div><div id="tokTotal" class="v">0</div></div>
          <div class="metric"><div class="k">Last Call</div><div id="tokLast" class="v">-</div></div>
        </div>
      </div>

      <div class="panel">
        <div class="header">
          <div class="title">History</div>
          <div class="hint">Saved per workspace</div>
        </div>
        <div id="history" class="activity"></div>
      </div>

      <div class="panel">
        <div class="header">
          <div class="title">Agent Activity</div>
          <div class="hint">Realtime action timeline</div>
        </div>
        <div id="activity" class="activity"></div>
      </div>

      <div class="panel">
        <div class="header">
          <div class="title">Logs</div>
          <div class="hint">Raw debug output</div>
        </div>
        <div id="logs" class="logs mono"></div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const promptEl = document.getElementById("prompt");
    const statusEl = document.getElementById("status");
    const runMetaEl = document.getElementById("runMeta");
    const planBtn = document.getElementById("planBtn");
    const runBtn = document.getElementById("runBtn");
    const stopBtn = document.getElementById("stopBtn");
    const clearSessionBtn = document.getElementById("clearSessionBtn");
    const reloadModelsBtn = document.getElementById("reloadModels");
    const baseUrlInputEl = document.getElementById("baseUrlInput");
    const modelSelectEl = document.getElementById("modelSelect");
    const modelTagsEl = document.getElementById("modelTags");
    const modelInfoEl = document.getElementById("modelInfo");
    const planEl = document.getElementById("plan");
    const progressBarEl = document.getElementById("progressBar");
    const stepStatsEl = document.getElementById("stepStats");
    const logsEl = document.getElementById("logs");
    const historyEl = document.getElementById("history");
    const activityEl = document.getElementById("activity");
    const tokPromptEl = document.getElementById("tokPrompt");
    const tokCompletionEl = document.getElementById("tokCompletion");
    const tokTotalEl = document.getElementById("tokTotal");
    const tokLastEl = document.getElementById("tokLast");

    const state = {
      running: false,
      mode: "-",
      model: "-"
    };
    const streamNodes = new Map();

    const post = (message) => {
      try {
        vscode.postMessage(message);
      } catch {
        // ignore post failures
      }
    };
    const postTrace = (text) => post({ type: "client_trace", text });

    post({ type: "webview_ready" });
    postTrace("boot");

    window.addEventListener("error", (event) => {
      const text = (event && event.message) ? String(event.message) : "Unknown script error.";
      appendLog("UI error: " + text, "error");
      post({ type: "client_error", text });
    });

    window.addEventListener("unhandledrejection", (event) => {
      const reason = event && event.reason ? String(event.reason) : "Unknown promise rejection.";
      appendLog("UI promise rejection: " + reason, "error");
      post({ type: "client_error", text: reason });
    });

    const fmt = (n) => Number(n || 0).toLocaleString();

    const appendLog = (text, cls = "") => {
      if (!logsEl) {
        post({ type: "client_error", text: "logs element not found" });
        return;
      }
      const line = document.createElement("div");
      if (cls) {
        line.className = cls;
      }
      line.textContent = text;
      logsEl.appendChild(line);
      while (logsEl.childNodes.length > 500) {
        logsEl.removeChild(logsEl.firstChild);
      }
      logsEl.scrollTop = logsEl.scrollHeight;
    };

    const updateStreamLog = (message) => {
      if (!logsEl) {
        return;
      }
      const key = String(message.streamId || "default");
      let line = streamNodes.get(key);
      if (line && !line.isConnected) {
        streamNodes.delete(key);
        line = undefined;
      }
      if (!line) {
        line = document.createElement("div");
        line.className = "hint mono";
        line.dataset.streamId = key;
        logsEl.appendChild(line);
        streamNodes.set(key, line);
      }

      const header = "[stream " + (message.stepId || "-") + " t" + String(message.turn || 0) + "] ";
      line.textContent = header + String(message.text || "");
      if (message.done) {
        line.className = "mono";
        streamNodes.delete(key);
      }
      logsEl.scrollTop = logsEl.scrollHeight;
    };

    const appendActivity = (activity) => {
      if (!activityEl) {
        return;
      }
      const card = document.createElement("div");
      card.className = "activity-card";

      const head = document.createElement("div");
      head.className = "activity-head";

      const left = document.createElement("div");
      left.className = "mono";
      left.textContent = "[" + activity.stepId + " | t" + activity.turn + "] " + activity.actionType;

      const badge = document.createElement("div");
      badge.className = "badge " + (activity.status || "");
      badge.textContent = activity.status;

      head.appendChild(left);
      head.appendChild(badge);

      const detail = document.createElement("div");
      detail.className = "mono";
      detail.style.marginTop = "4px";
      detail.textContent = activity.detail || "";

      card.appendChild(head);
      card.appendChild(detail);
      activityEl.appendChild(card);

      while (activityEl.childNodes.length > 180) {
        activityEl.removeChild(activityEl.firstChild);
      }
      activityEl.scrollTop = activityEl.scrollHeight;
    };

    const renderHistory = (items) => {
      if (!historyEl) {
        return;
      }
      historyEl.innerHTML = "";

      const rows = Array.isArray(items) ? items : [];
      if (rows.length === 0) {
        const empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = "No saved history yet.";
        historyEl.appendChild(empty);
        return;
      }

      for (const row of rows) {
        const card = document.createElement("div");
        card.className = "activity-card";

        const top = document.createElement("div");
        top.className = "history-row";

        const meta = document.createElement("div");
        meta.className = "history-meta";
        meta.textContent =
          "[" + row.mode + "] " + (row.model || "-") + " | " + (row.status || "-") + " | " + (row.timestamp || "-");

        const useBtn = document.createElement("button");
        useBtn.className = "history-btn";
        useBtn.textContent = "Use Prompt";
        useBtn.addEventListener("click", () => {
          if (promptEl) {
            promptEl.value = row.userPrompt || "";
          }
        });

        top.appendChild(meta);
        top.appendChild(useBtn);

        const prompt = document.createElement("div");
        prompt.className = "mono";
        prompt.textContent = "Prompt: " + (row.userPrompt || "");

        const summary = document.createElement("div");
        summary.className = "mono";
        summary.style.marginTop = "4px";
        summary.textContent = "Summary: " + (row.preflightSummary || row.runSummary || "");

        const learning = document.createElement("div");
        learning.className = "mono";
        learning.style.marginTop = "4px";
        learning.textContent = "Learning: " + (row.learningNote || "(none)");

        const remainingList = Array.isArray(row.remainingSteps) ? row.remainingSteps : [];
        const remaining = document.createElement("div");
        remaining.className = "mono";
        remaining.style.marginTop = "4px";
        if (remainingList.length > 0) {
          remaining.textContent =
            "Remaining: " +
            remainingList
              .slice(0, 4)
              .map((step) => "[" + step.id + "] " + step.title + " (" + step.status + ")")
              .join(" | ");
        } else {
          remaining.textContent = "Remaining: (none)";
        }

        card.appendChild(top);
        card.appendChild(prompt);
        card.appendChild(summary);
        card.appendChild(learning);
        card.appendChild(remaining);
        historyEl.appendChild(card);
      }
    };

    const refreshRunMeta = () => {
      if (runMetaEl) {
        runMetaEl.textContent = "Mode: " + state.mode + " | Model: " + state.model;
      }
    };

    const clearForRun = () => {
      if (activityEl) {
        activityEl.innerHTML = "";
      }
      if (logsEl) {
        logsEl.innerHTML = "";
      }
      streamNodes.clear();
      if (tokPromptEl) {
        tokPromptEl.textContent = "0";
      }
      if (tokCompletionEl) {
        tokCompletionEl.textContent = "0";
      }
      if (tokTotalEl) {
        tokTotalEl.textContent = "0";
      }
      if (tokLastEl) {
        tokLastEl.textContent = "-";
      }
      if (statusEl) {
        statusEl.textContent = "Starting...";
      }
    };

    const clearSessionUi = () => {
      if (activityEl) {
        activityEl.innerHTML = "";
      }
      if (logsEl) {
        logsEl.innerHTML = "";
      }
      streamNodes.clear();
      if (planEl) {
        planEl.innerHTML = "";
      }
      if (stepStatsEl) {
        stepStatsEl.textContent = "0/0 done";
      }
      if (progressBarEl) {
        progressBarEl.style.width = "0%";
      }
      if (tokPromptEl) {
        tokPromptEl.textContent = "0";
      }
      if (tokCompletionEl) {
        tokCompletionEl.textContent = "0";
      }
      if (tokTotalEl) {
        tokTotalEl.textContent = "0";
      }
      if (tokLastEl) {
        tokLastEl.textContent = "-";
      }
      if (promptEl) {
        promptEl.value = "";
      }
      state.mode = "-";
      state.model = modelSelectEl ? (modelSelectEl.value || "-") : "-";
      refreshRunMeta();
      if (statusEl) {
        statusEl.textContent = "Idle";
      }
    };

    const updatePlanProgress = () => {
      if (!planEl) {
        return;
      }
      const nodes = Array.from(planEl.querySelectorAll("li"));
      const total = nodes.length;
      let done = 0;
      nodes.forEach((node) => {
        if (node.dataset.status === "done") {
          done += 1;
        }
      });

      if (stepStatsEl) {
        stepStatsEl.textContent = done + "/" + total + " done";
      }
      const percent = total > 0 ? Math.round((done * 100) / total) : 0;
      if (progressBarEl) {
        progressBarEl.style.width = String(percent) + "%";
      }
    };

    const renderPlan = (plan) => {
      if (!planEl) {
        return;
      }
      planEl.innerHTML = "";
      if (!plan || !Array.isArray(plan.steps)) {
        updatePlanProgress();
        return;
      }

      for (const step of plan.steps) {
        const li = document.createElement("li");
        li.className = "item";
        li.dataset.stepId = step.id;
        li.dataset.status = step.status || "pending";
        li.textContent = "[" + step.id + "] " + step.title + " (" + li.dataset.status + ")\\n" + (step.details || "");
        planEl.appendChild(li);
      }

      updatePlanProgress();
    };

    const updateStepStatus = (stepId, status) => {
      if (!planEl) {
        return;
      }
      const node = planEl.querySelector('li[data-step-id="' + stepId + '"]');
      if (!node) {
        return;
      }
      node.dataset.status = status;
      const text = node.textContent || "";
      node.textContent = text.replace(/\\((pending|in_progress|done|failed)\\)/, "(" + status + ")");
      updatePlanProgress();
    };

    const normalizeModelItems = (payload) => {
      const out = [];

      if (Array.isArray(payload.items)) {
        for (const item of payload.items) {
          if (typeof item === "string" && item.trim()) {
            out.push(item.trim());
          } else if (item && typeof item === "object" && typeof item.id === "string" && item.id.trim()) {
            out.push(item.id.trim());
          }
        }
      } else if (payload.items && typeof payload.items === "string") {
        try {
          const parsed = JSON.parse(payload.items);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (typeof item === "string" && item.trim()) {
                out.push(item.trim());
              }
            }
          }
        } catch {
          // ignore
        }
      }

      if (out.length === 0 && payload.data && Array.isArray(payload.data)) {
        for (const row of payload.data) {
          if (row && typeof row === "object" && typeof row.id === "string" && row.id.trim()) {
            out.push(row.id.trim());
          }
        }
      }

      return Array.from(new Set(out));
    };

    const updateModels = (payload) => {
      if (!modelSelectEl) {
        appendLog("Model UI error: modelSelect element not found.", "error");
        return;
      }
      if (modelSelectEl.tagName !== "SELECT") {
        appendLog("Model UI error: modelSelect is not a <select> element.", "error");
        return;
      }

      const previous = modelSelectEl.value;
      while (modelSelectEl.options.length > 0) {
        modelSelectEl.remove(0);
      }
      if (modelTagsEl) {
        modelTagsEl.innerHTML = "";
      }

      const models = normalizeModelItems(payload);
      const modelList = models.length > 0 ? models : [""];
      for (const model of modelList) {
        const label = model || "(No models)";
        const option = document.createElement("option");
        option.value = model;
        option.textContent = label;
        modelSelectEl.add(option);
      }

      if (models.length === 0) {
        modelSelectEl.selectedIndex = 0;
      }

      const selected = payload.selected || previous || (models[0] || "");
      if (selected && models.includes(selected)) {
        modelSelectEl.value = selected;
      } else if (models.length > 0) {
        modelSelectEl.selectedIndex = 0;
      }

      const activeModel = modelSelectEl.value;
      if (modelTagsEl && models.length > 0) {
        for (const model of models) {
          const tag = document.createElement("button");
          tag.type = "button";
          tag.className = "model-tag" + (model === activeModel ? " active" : "");
          tag.textContent = model;
          tag.addEventListener("click", () => {
            modelSelectEl.value = model;
            const tags = modelTagsEl.querySelectorAll(".model-tag");
            tags.forEach((node) => {
              if (node.textContent === model) {
                node.classList.add("active");
              } else {
                node.classList.remove("active");
              }
            });
          });
          modelTagsEl.appendChild(tag);
        }
      }

      if (baseUrlInputEl && payload.baseUrl && typeof payload.baseUrl === "string") {
        baseUrlInputEl.value = payload.baseUrl;
      }

      if (modelInfoEl) {
        if (payload.error) {
          modelInfoEl.textContent = payload.error;
          modelInfoEl.className = "hint error";
        } else {
          modelInfoEl.textContent = payload.info || "";
          modelInfoEl.className = "hint";
        }
      }

      appendLog(
        payload.error
          ? "Model load failed at URL " + (payload.baseUrl || "-")
          : "Model load success: " + String(models.length) + " model(s) from " + (payload.baseUrl || "-"),
        payload.error ? "error" : ""
      );
    };

    const requestModels = () => {
      try {
        const preferredModel = modelSelectEl ? (modelSelectEl.value || "") : "";
        const baseUrl = String((baseUrlInputEl && baseUrlInputEl.value) || "");
        postTrace("load_models clicked: " + (baseUrl || "(empty)"));
        post({
          type: "load_models",
          preferredModel,
          baseUrl
        });
        appendLog("Requesting models from URL: " + (baseUrl || "(empty -> fallback config)"));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        post({ type: "client_error", text: "requestModels failed: " + text });
      }
    };

    window.requestModels = requestModels;

    if (planBtn) {
      planBtn.addEventListener("click", () => {
        const prompt = String((promptEl && promptEl.value) || "");
        const model = String((modelSelectEl && modelSelectEl.value) || "");
        const baseUrl = String((baseUrlInputEl && baseUrlInputEl.value) || "");
        clearForRun();
        post({ type: "run", mode: "plan", prompt, model, baseUrl });
      });
    }

    if (runBtn) {
      runBtn.addEventListener("click", () => {
        const prompt = String((promptEl && promptEl.value) || "");
        const model = String((modelSelectEl && modelSelectEl.value) || "");
        const baseUrl = String((baseUrlInputEl && baseUrlInputEl.value) || "");
        clearForRun();
        post({ type: "run", mode: "agent", prompt, model, baseUrl });
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener("click", () => {
        post({ type: "stop" });
      });
    }

    if (clearSessionBtn) {
      clearSessionBtn.addEventListener("click", () => {
        if (state.running) {
          appendLog("Stop current run before clearing session.", "error");
          return;
        }
        post({ type: "clear_session" });
      });
    }

    if (reloadModelsBtn) {
      reloadModelsBtn.addEventListener("click", () => {
        requestModels();
      });
      reloadModelsBtn.onclick = () => {
        requestModels();
      };
    }

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target || typeof target !== "object") {
        return;
      }
      const node = target;
      if (node && node.id === "reloadModels") {
        requestModels();
      }
    });

    if (baseUrlInputEl) {
      baseUrlInputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          requestModels();
        }
      });
    }

    if (modelSelectEl) {
      modelSelectEl.addEventListener("change", () => {
        if (!modelTagsEl) {
          return;
        }
        const current = modelSelectEl.value;
        const tags = modelTagsEl.querySelectorAll(".model-tag");
        tags.forEach((node) => {
          if (node.textContent === current) {
            node.classList.add("active");
          } else {
            node.classList.remove("active");
          }
        });
      });
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      switch (message.type) {
        case "status":
          if (statusEl) {
            statusEl.textContent = message.text;
          }
          break;

        case "run_context":
          state.mode = message.mode;
          state.model = message.model || "-";
          refreshRunMeta();
          break;

        case "running": {
          const disabled = Boolean(message.value);
          state.running = disabled;
          if (planBtn) {
            planBtn.disabled = disabled;
          }
          if (runBtn) {
            runBtn.disabled = disabled;
          }
          if (clearSessionBtn) {
            clearSessionBtn.disabled = disabled;
          }
          if (reloadModelsBtn) {
            reloadModelsBtn.disabled = disabled;
          }
          if (baseUrlInputEl) {
            baseUrlInputEl.disabled = disabled;
          }
          if (modelSelectEl) {
            modelSelectEl.disabled = disabled;
          }
          break;
        }

        case "models":
          try {
            updateModels(message);
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            appendLog("Model UI render failed: " + text, "error");
            post({ type: "client_error", text: "updateModels failed: " + text });
          }
          break;

        case "usage_reset":
          if (tokPromptEl) {
            tokPromptEl.textContent = "0";
          }
          if (tokCompletionEl) {
            tokCompletionEl.textContent = "0";
          }
          if (tokTotalEl) {
            tokTotalEl.textContent = "0";
          }
          if (tokLastEl) {
            tokLastEl.textContent = "-";
          }
          break;

        case "usage": {
          if (tokPromptEl) {
            tokPromptEl.textContent = fmt(message.cumulativePrompt);
          }
          if (tokCompletionEl) {
            tokCompletionEl.textContent = fmt(message.cumulativeCompletion);
          }
          if (tokTotalEl) {
            tokTotalEl.textContent = fmt(message.cumulativeTotal);
          }

          const callText =
            message.phase + " " +
            "p:" + fmt(message.promptTokens) +
            " c:" + fmt(message.completionTokens) +
            " t:" + fmt(message.totalTokens);
          if (tokLastEl) {
            tokLastEl.textContent = callText;
          }
          break;
        }

        case "history":
          renderHistory(message.items);
          break;

        case "activity":
          appendActivity(message);
          break;

        case "stream":
          updateStreamLog(message);
          break;

        case "log":
          appendLog(message.text);
          break;

        case "plan":
          renderPlan(message.plan);
          appendLog("Plan: " + (message.plan.summary || ""));
          break;

        case "step":
          updateStepStatus(message.stepId, message.status);
          appendLog("Step " + message.stepId + " -> " + message.status);
          break;

        case "done":
          appendLog(message.text, "done");
          if (statusEl) {
            statusEl.textContent = "Done";
          }
          break;

        case "error":
          appendLog(message.text, "error");
          if (statusEl) {
            statusEl.textContent = "Error";
          }
          break;

        case "session_cleared":
          clearSessionUi();
          appendLog("Session cleared. New request will start fresh.");
          break;

        default:
          break;
      }
    });

    refreshRunMeta();
    postTrace("boot-complete");
    requestModels();
    post({ type: "load_history" });
  </script>
</body>
</html>`;
  }
}

function createNonce(length = 32): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let output = "";
  for (let i = 0; i < length; i += 1) {
    output += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return output;
}
