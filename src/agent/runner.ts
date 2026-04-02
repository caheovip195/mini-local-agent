import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec as execCallback, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { LmStudioClient, type ChatMessage } from "../lmStudioClient";
import { asArray, extractJsonObject, toNumberValue, toStringValue, truncate } from "../utils";
import { buildExecutorSystemPrompt, buildPlannerSystemPrompt } from "./prompts";
import type {
  AgentAction,
  AgentConfig,
  AgentDecision,
  ExecutionPlan,
  PlanStep,
  RunnerCallbacks,
  StepResult
} from "./types";

const execAsync = promisify(execCallback);
const execFileAsync = promisify(execFileCallback);
const SEARCH_EXCLUDE = "**/{node_modules,.git,dist,build,.next,.dart_tool,coverage,target}/**";
const STEP_HISTORY_TAIL_MESSAGES = 10;
const MAX_PARSE_ERROR_STREAK_BEFORE_RECOVERY = 2;
const MAX_REPEATED_ACTION_BLOCKS_BEFORE_RECOVERY = 2;
const NO_PROGRESS_WARNING_THRESHOLD = 3;
const ASK_USER_MIN_INVESTIGATIONS = 4;
const WORKSPACE_INDEX_LIMIT = 4000;
const SNAPSHOT_HEAD_PREVIEW = 220;
const SNAPSHOT_TAIL_PREVIEW = 80;
const DUPLICATE_GUARD_LIMIT = 5;

interface ActionExecutionResult {
  kind: "tool" | "complete" | "final";
  message: string;
  progress: boolean;
}

interface WorkspaceSnapshotOptions {
  fileLimit: number;
  keyFiles: string[];
  keyFileCharLimit: number;
}

const PLANNER_SNAPSHOT_OPTIONS: WorkspaceSnapshotOptions = {
  fileLimit: 2500,
  keyFiles: ["README.md", "package.json", "tsconfig.json", "pyproject.toml", "go.mod"],
  keyFileCharLimit: 1200
};

const EXECUTOR_SNAPSHOT_OPTIONS: WorkspaceSnapshotOptions = {
  fileLimit: 2500,
  keyFiles: ["README.md", "package.json", "tsconfig.json", "src/extension.ts", "src/index.ts"],
  keyFileCharLimit: 700
};

export class LocalAgentRunner {
  private readonly changedFiles = new Set<string>();
  private askCount = 0;
  private plannerSnapshotCache?: string;
  private executorSnapshotCache?: string;
  private workspaceFileIndexCache?: string[];
  private selectedStrategyBrief = "Use minimal-change implementation aligned with existing project structure.";
  private verificationAttempted = false;

  constructor(
    private readonly client: LmStudioClient,
    private readonly config: AgentConfig,
    private readonly callbacks: RunnerCallbacks
  ) {}

  async createPlan(task: string, signal?: AbortSignal): Promise<ExecutionPlan> {
    this.callbacks.onStatus("Analyzing workspace for planning...");
    const workspaceContext = await this.getPlannerWorkspaceSnapshot();
    this.callbacks.onStatus("Comparing implementation approaches...");
    this.selectedStrategyBrief = await this.buildImplementationStrategy(task, workspaceContext, signal);
    this.callbacks.onLog(`Selected strategy:\n${this.selectedStrategyBrief}`);

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildPlannerSystemPrompt(this.config.extraSystemPrompt)
      },
      {
        role: "user",
        content: [
          `User task:\n${task}`,
          "",
          "Selected implementation strategy:",
          this.selectedStrategyBrief,
          "",
          "Workspace context:",
          workspaceContext,
          "",
          "Return JSON now."
        ].join("\n")
      }
    ];

    const plannerResponse = await this.client.chat(messages, signal, { temperature: 0.1, maxTokens: 1400 });
    const rawPlan = plannerResponse.content;
    if (plannerResponse.usage) {
      this.callbacks.onUsage?.({
        phase: "planner",
        model: plannerResponse.model,
        promptTokens: plannerResponse.usage.promptTokens,
        completionTokens: plannerResponse.usage.completionTokens,
        totalTokens: plannerResponse.usage.totalTokens
      });
    }
    this.callbacks.onLog(`Planner raw output:\n${rawPlan}`);

    const plan = this.parsePlan(rawPlan, task);
    this.callbacks.onPlan(plan);
    return plan;
  }

  async run(task: string, signal?: AbortSignal): Promise<void> {
    this.verificationAttempted = false;
    const plan = await this.createPlan(task, signal);

    this.callbacks.onStatus("Preparing execution context...");
    await this.getExecutorWorkspaceSnapshot();
    const failedSteps: Array<{ id: string; title: string; error: string }> = [];
    let completedSteps = 0;

    for (const step of plan.steps) {
      if (signal?.aborted) {
        throw new Error("Run cancelled.");
      }

      this.callbacks.onStepStatus(step.id, "in_progress");
      this.callbacks.onStatus(`Executing ${step.id}: ${step.title}`);

      try {
        const result = await this.executeStep(task, plan, step, signal);
        if (!result.done) {
          throw new Error(`Step ${step.id} did not complete.`);
        }
        this.callbacks.onLog(`Step ${step.id} completed: ${result.summary}`);
        this.callbacks.onStepStatus(step.id, "done");
        completedSteps += 1;
      } catch (error) {
        this.callbacks.onStepStatus(step.id, "failed");
        const text = error instanceof Error ? error.message : String(error);
        failedSteps.push({
          id: step.id,
          title: step.title,
          error: text
        });
        this.callbacks.onLog(`Step ${step.id} failed: ${text}`);
        this.callbacks.onStatus(`Step ${step.id} failed. Continuing with next step using assumptions...`);
        continue;
      }
    }

    const changed = Array.from(this.changedFiles.values());
    const summary = [
      "Agent execution completed.",
      `Completed steps: ${completedSteps}/${plan.steps.length}.`,
      failedSteps.length > 0
        ? `Failed steps (${failedSteps.length}): ${failedSteps.map((step) => `${step.id} (${step.error})`).join("; ")}`
        : "Failed steps: 0.",
      changed.length > 0 ? `Changed files (${changed.length}): ${changed.join(", ")}` : "No files changed."
    ].join("\n");

    this.callbacks.onDone(summary);
  }

  private async executeStep(
    task: string,
    plan: ExecutionPlan,
    step: PlanStep,
    signal?: AbortSignal
  ): Promise<StepResult> {
    const workspaceContext = await this.getExecutorWorkspaceSnapshot();
    const minInvestigations = Math.max(1, this.config.minInvestigationsBeforeExecute);

    const stepMessages: ChatMessage[] = [
      {
        role: "system",
        content: buildExecutorSystemPrompt(this.config.extraSystemPrompt)
      },
      {
        role: "user",
        content: [
          `Global task:\n${task}`,
          "",
          `Plan summary: ${plan.summary}`,
          `Current step (${step.id}): ${step.title}`,
          `Step details: ${step.details}`,
          `Workspace root: ${this.config.workspaceRoot}`,
          `Selected strategy:\n${this.selectedStrategyBrief}`,
          "You have full read access to all files under workspace root.",
          "Never ask the user where files/screens/components are located; discover by list/search/read actions.",
          `Minimum investigation actions required before write/run/complete: ${minInvestigations}`,
          "Workspace context:",
          workspaceContext,
          "Return JSON action now."
        ].join("\n")
      }
    ];

    let investigationCount = 0;
    let parseErrorStreak = 0;
    let lastActionSignature = "";
    let repeatedCount = 0;
    let repeatedActionBlocks = 0;
    let turnsWithoutProgress = 0;

    for (let turn = 1; turn <= this.config.maxTurnsPerStep; turn += 1) {
      if (signal?.aborted) {
        throw new Error("Run cancelled.");
      }

      this.compactStepMessages(stepMessages);
      this.callbacks.onStatus(`Step ${step.id} turn ${turn}/${this.config.maxTurnsPerStep}`);

      const stepResponse = await this.client.chat(stepMessages, signal, {
        temperature: 0.1,
        maxTokens: 1200
      });
      const rawResponse = stepResponse.content;
      if (stepResponse.usage) {
        this.callbacks.onUsage?.({
          phase: "executor",
          stepId: step.id,
          turn,
          model: stepResponse.model,
          promptTokens: stepResponse.usage.promptTokens,
          completionTokens: stepResponse.usage.completionTokens,
          totalTokens: stepResponse.usage.totalTokens
        });
      }

      this.callbacks.onLog(`Agent ${step.id} turn ${turn}:\n${rawResponse}`);
      stepMessages.push({ role: "assistant", content: rawResponse });

      let decision: AgentDecision;
      try {
        decision = this.parseDecision(rawResponse);
      } catch (error) {
        parseErrorStreak += 1;
        this.callbacks.onLog(`Decision parse error (${parseErrorStreak}): ${(error as Error).message}`);

        if (parseErrorStreak >= MAX_PARSE_ERROR_STREAK_BEFORE_RECOVERY) {
          const recoveryAction = await this.buildRecoveryAction(step, investigationCount);
          const recovery = await this.executeRecoveryAction(
            recoveryAction,
            investigationCount,
            stepMessages,
            "ParseRecovery",
            step.id,
            turn
          );
          investigationCount = recovery.investigationCount;
          turnsWithoutProgress = recovery.progress ? 0 : turnsWithoutProgress + 1;
          parseErrorStreak = 0;

          if (recovery.finalResult) {
            return recovery.finalResult;
          }
        } else {
          stepMessages.push({
            role: "user",
            content:
              "Output was not valid JSON for the required schema. Return STRICT JSON only with one action object."
          });
        }

        continue;
      }

      parseErrorStreak = 0;
      const actionType = this.normalizeActionType(toStringValue(decision.action.type).trim());
      decision.action.type = actionType;
      this.callbacks.onAction?.({
        stepId: step.id,
        turn,
        actionType,
        status: "planned",
        detail: this.safeActionPreview(decision.action)
      });

      const actionSignature = JSON.stringify(decision.action);
      if (actionSignature === lastActionSignature) {
        repeatedCount += 1;
      } else {
        repeatedCount = 0;
        repeatedActionBlocks = 0;
      }
      lastActionSignature = actionSignature;

      if (repeatedCount >= 2) {
        repeatedActionBlocks += 1;
        const message =
          "LoopGuard: repeated the same action too many times. Choose a different action with new evidence.";

        this.callbacks.onLog(message);
        this.callbacks.onAction?.({
          stepId: step.id,
          turn,
          actionType,
          status: "blocked",
          detail: message
        });
        stepMessages.push({
          role: "user",
          content: message
        });

        if (repeatedActionBlocks >= MAX_REPEATED_ACTION_BLOCKS_BEFORE_RECOVERY) {
          const recoveryAction = await this.buildRecoveryAction(step, investigationCount);
          const recovery = await this.executeRecoveryAction(
            recoveryAction,
            investigationCount,
            stepMessages,
            "LoopRecovery",
            step.id,
            turn
          );
          investigationCount = recovery.investigationCount;
          turnsWithoutProgress = recovery.progress ? 0 : turnsWithoutProgress + 1;
          repeatedCount = 0;
          repeatedActionBlocks = 0;

          if (recovery.finalResult) {
            return recovery.finalResult;
          }
        }

        continue;
      }

      if (actionType === "ask_user") {
        const question = toStringValue(decision.action.question, "").trim();
        const askGuard = this.evaluateAskUserGate(question, investigationCount);
        if (askGuard.blocked) {
          this.callbacks.onLog(askGuard.message);
          this.callbacks.onAction?.({
            stepId: step.id,
            turn,
            actionType,
            status: "blocked",
            detail: askGuard.message
          });
          stepMessages.push({ role: "user", content: `TOOL_RESULT:\n${askGuard.message}` });

          const recoveryAction = await this.buildRecoveryAction(step, investigationCount);
          const recovery = await this.executeRecoveryAction(
            recoveryAction,
            investigationCount,
            stepMessages,
            "AskUserRecovery",
            step.id,
            turn
          );
          investigationCount = recovery.investigationCount;
          turnsWithoutProgress = recovery.progress ? 0 : turnsWithoutProgress + 1;

          if (recovery.finalResult) {
            return recovery.finalResult;
          }
          continue;
        }
      }

      if (this.requiresInvestigation(actionType) && investigationCount < minInvestigations) {
        const guardMessage = this.buildInvestigationGuardMessage(
          actionType,
          investigationCount,
          minInvestigations
        );
        this.callbacks.onLog(guardMessage);
        this.callbacks.onAction?.({
          stepId: step.id,
          turn,
          actionType,
          status: "blocked",
          detail: guardMessage
        });
        stepMessages.push({ role: "user", content: `TOOL_RESULT:\n${guardMessage}` });
        turnsWithoutProgress += 1;
        continue;
      }

      if (this.isInvestigationAction(actionType)) {
        investigationCount += 1;
      }

      const actionResult = await this.executeAction(decision.action, investigationCount);
      this.callbacks.onAction?.({
        stepId: step.id,
        turn,
        actionType,
        status: "executed",
        detail: truncate(actionResult.message, 400)
      });
      if (actionResult.kind === "complete" || actionResult.kind === "final") {
        return {
          done: true,
          summary: actionResult.message,
          changedFiles: Array.from(this.changedFiles.values())
        };
      }

      turnsWithoutProgress = actionResult.progress ? 0 : turnsWithoutProgress + 1;
      const noProgressNote =
        turnsWithoutProgress >= NO_PROGRESS_WARNING_THRESHOLD
          ? "\nNoProgressGuard: avoid blocked actions; inspect files or search code with a new query."
          : "";

      stepMessages.push({
        role: "user",
        content: `TOOL_RESULT:\n${actionResult.message}${noProgressNote}`
      });
    }

    throw new Error(
      `Step ${step.id} exceeded max turns (${this.config.maxTurnsPerStep}). Agent may be looping.`
    );
  }

  private async executeRecoveryAction(
    action: AgentAction,
    investigationCount: number,
    stepMessages: ChatMessage[],
    reason: string,
    stepId: string,
    turn: number
  ): Promise<{ investigationCount: number; progress: boolean; finalResult?: StepResult }> {
    const actionType = this.normalizeActionType(toStringValue(action.type));
    action.type = actionType;
    let nextInvestigationCount = investigationCount;
    if (this.isInvestigationAction(actionType)) {
      nextInvestigationCount += 1;
    }

    this.callbacks.onLog(`${reason}: auto action ${JSON.stringify(action)}`);
    this.callbacks.onAction?.({
      stepId,
      turn,
      actionType,
      status: "recovery",
      detail: `${reason}: ${this.safeActionPreview(action)}`
    });
    const result = await this.executeAction(action, nextInvestigationCount);

    if (result.kind === "complete" || result.kind === "final") {
      return {
        investigationCount: nextInvestigationCount,
        progress: true,
        finalResult: {
          done: true,
          summary: result.message,
          changedFiles: Array.from(this.changedFiles.values())
        }
      };
    }

    stepMessages.push({
      role: "user",
      content: `TOOL_RESULT (auto-recovery):\n${result.message}`
    });

    return {
      investigationCount: nextInvestigationCount,
      progress: result.progress
    };
  }

  private async executeAction(
    action: AgentAction,
    investigationCount: number
  ): Promise<ActionExecutionResult> {
    const type = this.normalizeActionType(toStringValue(action.type).trim());

    switch (type) {
      case "list_files": {
        const pattern = toStringValue(action.pattern, "**/*");
        const limit = Math.min(Math.max(toNumberValue(action.limit, 500), 1), 3000);

        try {
          const files = await this.listFiles(pattern, limit);
          return {
            kind: "tool",
            message: truncate(`Found ${files.length} files:\n${files.join("\n")}`),
            progress: files.length > 0
          };
        } catch (error) {
          return {
            kind: "tool",
            message: `list_files failed: ${(error as Error).message}`,
            progress: false
          };
        }
      }

      case "read_file": {
        const filePath = toStringValue(action.path);
        if (!filePath) {
          return { kind: "tool", message: "read_file failed: missing path.", progress: false };
        }

        try {
          const startLineRaw = toNumberValue(action.startLine, 1);
          const endLineRaw = toNumberValue(action.endLine, Number.MAX_SAFE_INTEGER);
          const absPath = this.resolveWorkspacePath(filePath);
          const relPath = this.toRelative(absPath);
          const content = await fs.readFile(absPath, "utf8");
          const lines = content.split(/\r?\n/g);
          const startLine = Math.max(1, Math.floor(startLineRaw));
          const endLine = Math.max(startLine, Math.floor(endLineRaw));
          const chunk = lines.slice(startLine - 1, endLine).join("\n");

          return {
            kind: "tool",
            message: truncate(`FILE ${relPath} [${startLine}-${endLine}]\n${chunk}`),
            progress: true
          };
        } catch (error) {
          return {
            kind: "tool",
            message: `read_file failed for ${filePath}: ${(error as Error).message}`,
            progress: false
          };
        }
      }

      case "search_code": {
        const pattern = toStringValue(action.pattern);
        const limit = Math.min(Math.max(toNumberValue(action.limit, 100), 1), 500);
        if (!pattern) {
          return { kind: "tool", message: "search_code failed: missing pattern.", progress: false };
        }

        const results = await this.searchCode(pattern, limit);
        if (results.length === 0) {
          const filenameHints = await this.searchFileNames(pattern, Math.min(limit, 120));
          if (filenameHints.length > 0) {
            return {
              kind: "tool",
              message: truncate(
                [
                  "Search results in file content: none.",
                  `Potential related files by name (${filenameHints.length}):`,
                  ...filenameHints
                ].join("\n")
              ),
              progress: true
            };
          }
        }
        const hasSearchProgress = results.length > 0;
        return {
          kind: "tool",
          message: truncate(
            results.length > 0
              ? `Search results (${results.length}):\n${results.join("\n")}`
              : "Search results: none"
          ),
          progress: hasSearchProgress
        };
      }

      case "write_file": {
        if (!this.config.autoApplyWrites) {
          return {
            kind: "tool",
            message: "write_file blocked by config (localAgent.autoApplyWrites=false).",
            progress: false
          };
        }

        const filePath = toStringValue(action.path);
        const content = toStringValue(action.content);
        if (!filePath) {
          return { kind: "tool", message: "write_file failed: missing path.", progress: false };
        }

        try {
          const absPath = this.resolveWorkspacePath(filePath);
          const relPath = this.toRelative(absPath);
          const existsBeforeWrite = await this.fileExists(absPath);

          if (!existsBeforeWrite) {
            const duplicateCandidates = await this.findLikelyDuplicateFiles(relPath);
            const allowDuplicate = action.allowDuplicate === true;
            if (!allowDuplicate && duplicateCandidates.length > 0) {
              return {
                kind: "tool",
                message: [
                  `DuplicateGuard: creating '${relPath}' may duplicate existing files.`,
                  `Potential duplicates: ${duplicateCandidates.join(", ")}`,
                  "If this is truly a separate file, set allowDuplicate=true. Otherwise edit existing file."
                ].join(" "),
                progress: false
              };
            }
          }

          await fs.mkdir(path.dirname(absPath), { recursive: true });
          await fs.writeFile(absPath, content, "utf8");

          this.changedFiles.add(relPath);
          this.executorSnapshotCache = undefined;
          if (this.workspaceFileIndexCache && !this.workspaceFileIndexCache.includes(relPath)) {
            this.workspaceFileIndexCache.push(relPath);
            this.workspaceFileIndexCache.sort((a, b) => a.localeCompare(b));
          }

          return {
            kind: "tool",
            message: `${existsBeforeWrite ? "Updated" : "Created"} ${relPath} (${content.length} chars).`,
            progress: true
          };
        } catch (error) {
          return {
            kind: "tool",
            message: `write_file failed for ${filePath}: ${(error as Error).message}`,
            progress: false
          };
        }
      }

      case "run_command": {
        const command = toStringValue(action.command);
        if (!command) {
          return { kind: "tool", message: "run_command failed: missing command.", progress: false };
        }

        if (this.isDangerousCommand(command)) {
          return { kind: "tool", message: "Command blocked by safety policy.", progress: false };
        }

        const isVerificationCommand = this.isVerificationCommand(command);
        if (isVerificationCommand) {
          this.verificationAttempted = true;
        }

        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: this.config.workspaceRoot,
            timeout: this.config.commandTimeoutMs,
            maxBuffer: 2 * 1024 * 1024,
            shell: "/bin/bash"
          });

          const output = [
            stdout ? `STDOUT:\n${stdout}` : "",
            stderr ? `STDERR:\n${stderr}` : ""
          ]
            .filter(Boolean)
            .join("\n");

          return {
            kind: "tool",
            message: truncate(output.length > 0 ? output : "Command executed with no output."),
            progress: true
          };
        } catch (error) {
          const e = error as { message?: string; stdout?: string; stderr?: string };
          const output = [
            e.message ? `ERROR: ${e.message}` : "",
            e.stdout ? `STDOUT:\n${e.stdout}` : "",
            e.stderr ? `STDERR:\n${e.stderr}` : ""
          ]
            .filter(Boolean)
            .join("\n");

          return { kind: "tool", message: truncate(output || "Command failed."), progress: false };
        }
      }

      case "ask_user": {
        const question = toStringValue(action.question, "Missing question.");
        const askGuard = this.evaluateAskUserGate(question, investigationCount);
        if (askGuard.blocked) {
          return { kind: "tool", message: askGuard.message, progress: false };
        }

        if (investigationCount < this.config.minInvestigationsBeforeExecute) {
          return {
            kind: "tool",
            message:
              "ask_user blocked: investigate first with list/search/read actions. Continue with assumptions.",
            progress: false
          };
        }

        if (this.askCount >= this.config.maxAskUser) {
          return {
            kind: "tool",
            message:
              "ask_user blocked: max questions reached. Continue with best assumption and execute.",
            progress: false
          };
        }

        this.askCount += 1;
        if (!this.callbacks.onQuestion) {
          return {
            kind: "tool",
            message:
              "No direct user input channel available. Assume default implementation choices and continue.",
            progress: false
          };
        }

        const answer = await this.callbacks.onQuestion(question);
        return { kind: "tool", message: `USER_RESPONSE: ${answer}`, progress: true };
      }

      case "complete_step": {
        if (this.changedFiles.size > 0 && !this.verificationAttempted) {
          return {
            kind: "tool",
            message:
              "QualityGuard: code changed but no verification command was attempted. Run test/lint/typecheck/build first.",
            progress: false
          };
        }
        const summary = toStringValue(action.summary, "Step completed.");
        return { kind: "complete", message: summary, progress: true };
      }

      case "final_answer": {
        if (this.changedFiles.size > 0 && !this.verificationAttempted) {
          return {
            kind: "tool",
            message:
              "QualityGuard: code changed but no verification command was attempted. Run test/lint/typecheck/build first.",
            progress: false
          };
        }
        const summary = toStringValue(action.summary, "Task completed.");
        return { kind: "final", message: summary, progress: true };
      }

      default:
        return {
          kind: "tool",
          message: `Unknown action type: ${type}. Choose a valid action.`,
          progress: false
        };
    }
  }

  private async buildRecoveryAction(step: PlanStep, investigationCount: number): Promise<AgentAction> {
    if (investigationCount <= 0) {
      return {
        type: "list_files",
        pattern: "**/*",
        limit: 500
      };
    }

    if (investigationCount <= 1) {
      const bootstrapFile = await this.findFirstExistingFile([
        "README.md",
        "package.json",
        "src/extension.ts",
        "src/index.ts",
        "main.py",
        "go.mod",
        "pyproject.toml",
        "Cargo.toml"
      ]);

      if (bootstrapFile) {
        return {
          type: "read_file",
          path: bootstrapFile,
          startLine: 1,
          endLine: 220
        };
      }
    }

    if (investigationCount % 2 === 0) {
      return {
        type: "list_files",
        pattern: this.buildFilePatternFromStep(step),
        limit: 500
      };
    }

    return {
      type: "search_code",
      pattern: this.buildSearchPatternFromStep(step),
      limit: 200
    };
  }

  private buildSearchPatternFromStep(step: PlanStep): string {
    const keywords = this.extractStepKeywords(step, 4);
    if (keywords.length === 0) {
      return "todo|fix|implement";
    }
    return keywords.join("|");
  }

  private buildFilePatternFromStep(step: PlanStep): string {
    const keywords = this.extractStepKeywords(step, 3);
    for (const keyword of keywords) {
      const safe = keyword.replace(/[^a-z0-9_-]/gi, "");
      if (safe.length >= 3) {
        return `**/*${safe}*`;
      }
    }
    return "**/*";
  }

  private extractStepKeywords(step: PlanStep, max = 4): string[] {
    const raw = `${step.title} ${step.details}`.toLowerCase();
    const tokens = raw.match(/[a-z_][a-z0-9_]{2,}/g) ?? [];
    const stopWords = new Set([
      "the",
      "and",
      "for",
      "with",
      "from",
      "into",
      "step",
      "task",
      "code",
      "file",
      "files",
      "agent",
      "plan",
      "implement",
      "identify",
      "create",
      "write",
      "inspect",
      "locate",
      "location",
      "using",
      "used",
      "same",
      "directory",
      "screen",
      "page",
      "new",
      "test",
      "basic",
      "controller",
      "if",
      "not",
      "continue",
      "next"
    ]);

    const frequency = new Map<string, number>();
    for (const token of tokens) {
      if (stopWords.has(token)) {
        continue;
      }
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }

    return Array.from(frequency.entries())
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
      .slice(0, Math.max(1, max))
      .map(([token]) => token);
  }

  private async buildImplementationStrategy(
    task: string,
    workspaceContext: string,
    signal?: AbortSignal
  ): Promise<string> {
    const candidateCount = Math.min(Math.max(this.config.strategyCandidates, 2), 5);
    const strategyResponse = await this.client.chat(
      [
        {
          role: "system",
          content: [
            "You are a senior software architect for an autonomous coding agent.",
            "Goal: evaluate multiple implementation approaches and choose the best fit for THIS project.",
            "Output STRICT JSON only with schema:",
            "{",
            '  "project_profile": "string",',
            '  "approaches": [',
            "    {",
            '      "id": "A1",',
            '      "name": "string",',
            '      "summary": "string",',
            '      "fit_score": 0,',
            '      "pros": ["string"],',
            '      "cons": ["string"],',
            '      "risks": ["string"],',
            '      "affected_paths": ["string"]',
            "    }",
            "  ],",
            '  "selected_id": "A1",',
            '  "selection_reason": "string",',
            '  "execution_rules": ["string"]',
            "}",
            "Rules:",
            `- Provide ${candidateCount} distinct approaches.`,
            "- Evaluate against existing structure, naming, and dependencies in workspace context.",
            "- Prefer minimal invasive change and reuse existing modules/tests.",
            "- Do not ask user for file paths.",
            "- Keep concise and actionable."
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `Task:\n${task}`,
            "",
            "Workspace context:",
            workspaceContext,
            "",
            "Return JSON now."
          ].join("\n")
        }
      ],
      signal,
      { temperature: 0.12, maxTokens: 1400 }
    );

    if (strategyResponse.usage) {
      this.callbacks.onUsage?.({
        phase: "planner",
        model: strategyResponse.model,
        promptTokens: strategyResponse.usage.promptTokens,
        completionTokens: strategyResponse.usage.completionTokens,
        totalTokens: strategyResponse.usage.totalTokens
      });
    }

    this.callbacks.onLog(`Strategy raw output:\n${strategyResponse.content}`);

    try {
      const parsed = extractJsonObject(strategyResponse.content) as Record<string, unknown>;
      const projectProfile = toStringValue(
        parsed.project_profile,
        "Project profile is not clearly inferred; default to minimal-change integration."
      );

      const approachesRaw = Array.isArray(parsed.approaches) ? parsed.approaches : [];
      const approaches = approachesRaw
        .map((item, index) => {
          if (!item || typeof item !== "object") {
            return undefined;
          }
          const row = item as Record<string, unknown>;
          const id = toStringValue(row.id, `A${index + 1}`);
          const name = toStringValue(row.name, `Approach ${index + 1}`);
          const summary = toStringValue(row.summary, "No summary");
          const fitScore = Math.max(0, Math.min(100, Math.floor(toNumberValue(row.fit_score, 0))));
          const pros = asArray(row.pros).slice(0, 3);
          const cons = asArray(row.cons).slice(0, 3);
          const risks = asArray(row.risks).slice(0, 3);
          const affectedPaths = asArray(row.affected_paths).slice(0, 4);

          return {
            id,
            name,
            summary,
            fitScore,
            pros,
            cons,
            risks,
            affectedPaths
          };
        })
        .filter(
          (
            item
          ): item is {
            id: string;
            name: string;
            summary: string;
            fitScore: number;
            pros: string[];
            cons: string[];
            risks: string[];
            affectedPaths: string[];
          } => Boolean(item)
        );

      if (approaches.length === 0) {
        throw new Error("Strategy response had no approaches.");
      }

      const selectedId = toStringValue(parsed.selected_id);
      const selectedById = approaches.find((approach) => approach.id === selectedId);
      const selected =
        selectedById ??
        [...approaches].sort((a, b) => b.fitScore - a.fitScore || a.id.localeCompare(b.id))[0];
      const selectionReason = toStringValue(parsed.selection_reason, selected.summary);
      const executionRules = asArray(parsed.execution_rules).slice(0, 5);

      const approachLines = approaches
        .slice(0, candidateCount)
        .map((approach) => {
          const hints = approach.affectedPaths.length > 0 ? ` paths=${approach.affectedPaths.join(", ")}` : "";
          return `${approach.id} score=${approach.fitScore}: ${approach.name} - ${approach.summary}${hints}`;
        });

      return truncate(
        [
          `Project profile: ${projectProfile}`,
          `Candidate approaches (${Math.min(approaches.length, candidateCount)}):`,
          ...approachLines,
          `Selected approach: ${selected.id} - ${selected.name} (score=${selected.fitScore})`,
          `Selection reason: ${selectionReason}`,
          executionRules.length > 0 ? `Execution rules: ${executionRules.join(" | ")}` : ""
        ]
          .filter(Boolean)
          .join("\n"),
        2200
      );
    } catch (error) {
      this.callbacks.onLog(`Strategy parse failed, fallback strategy used: ${(error as Error).message}`);
      return [
        "Project profile: inferred from workspace snapshot.",
        "Candidate approaches: evaluate minimal-change integration, adapter-based extension, and isolated rewrite.",
        "Selected approach: minimal-change integration with existing architecture.",
        "Selection reason: best compatibility with current structure and lowest regression risk.",
        "Execution rules: reuse existing modules, keep naming conventions, avoid introducing parallel architecture."
      ].join("\n");
    }
  }

  private evaluateAskUserGate(
    question: string,
    investigationCount: number
  ): { blocked: boolean; message: string } {
    if (!question) {
      return {
        blocked: true,
        message:
          "ask_user blocked: empty question. Continue with a reasonable assumption and inspect more files."
      };
    }

    if (this.isLikelyCodebaseLocationQuestion(question)) {
      return {
        blocked: true,
        message: [
          "ask_user blocked: do not ask user where code lives.",
          "You already have full read access to workspace.",
          "Use list_files/search_code/read_file with broader synonyms and filename-based lookup."
        ].join(" ")
      };
    }

    const askMinInvestigations = Math.max(this.config.minInvestigationsBeforeExecute + 2, ASK_USER_MIN_INVESTIGATIONS);
    if (investigationCount < askMinInvestigations) {
      const remaining = askMinInvestigations - investigationCount;
      return {
        blocked: true,
        message: [
          "ask_user blocked: investigation depth is too low.",
          `Completed ${investigationCount}/${askMinInvestigations} investigations.`,
          `Do ${remaining} more investigation action(s) first, then continue with best assumption.`
        ].join(" ")
      };
    }

    return { blocked: false, message: "" };
  }

  private isLikelyCodebaseLocationQuestion(question: string): boolean {
    const q = question.toLowerCase();
    const patterns = [
      /where\s+can\s+i\s+find/,
      /where\s+is/,
      /which\s+file/,
      /file\s+name/,
      /what\s+is\s+.*name/,
      /path\s+to/,
      /where\s+.*screen/,
      /where\s+.*component/,
      /where\s+.*page/,
      /in\s+which\s+folder/
    ];
    return patterns.some((pattern) => pattern.test(q));
  }

  private requiresInvestigation(type: string): boolean {
    return ["write_file", "run_command", "complete_step", "final_answer"].includes(type);
  }

  private isInvestigationAction(type: string): boolean {
    return ["list_files", "read_file", "search_code"].includes(type);
  }

  private buildInvestigationGuardMessage(
    actionType: string,
    currentCount: number,
    requiredCount: number
  ): string {
    const remaining = Math.max(0, requiredCount - currentCount);
    return [
      `ActionGuard: '${actionType}' blocked until investigation is done.`,
      `Investigation actions completed: ${currentCount}/${requiredCount}.`,
      remaining > 0
        ? `Do ${remaining} more list_files/read_file/search_code action(s) before executing.`
        : "Proceed after gathering file evidence."
    ].join(" ");
  }

  private compactStepMessages(messages: ChatMessage[]): void {
    if (messages.length <= STEP_HISTORY_TAIL_MESSAGES + 2) {
      return;
    }

    const fixedPrefix = messages.slice(0, 2);
    const tail = messages.slice(-STEP_HISTORY_TAIL_MESSAGES);
    messages.splice(0, messages.length, ...fixedPrefix, ...tail);
  }

  private normalizeActionType(rawType: string): string {
    const normalized = rawType.trim().toLowerCase();
    const aliases: Record<string, string> = {
      list: "list_files",
      listfiles: "list_files",
      read: "read_file",
      readfile: "read_file",
      search: "search_code",
      searchcode: "search_code",
      grep: "search_code",
      write: "write_file",
      writefile: "write_file",
      edit: "write_file",
      run: "run_command",
      runcommand: "run_command",
      command: "run_command",
      ask: "ask_user",
      askuser: "ask_user",
      complete: "complete_step",
      completestep: "complete_step",
      done: "complete_step",
      final: "final_answer",
      finalanswer: "final_answer"
    };

    return aliases[normalized] ?? normalized;
  }

  private safeActionPreview(action: AgentAction): string {
    const copy: Record<string, unknown> = { ...action };
    if (typeof copy.content === "string" && copy.content.length > 180) {
      copy.content = `${copy.content.slice(0, 180)}...`;
    }
    return JSON.stringify(copy);
  }

  private async listFiles(pattern: string, limit: number): Promise<string[]> {
    const relativePattern = new vscode.RelativePattern(this.config.workspaceRoot, pattern);
    const files = await vscode.workspace.findFiles(relativePattern, SEARCH_EXCLUDE, limit);
    return files.map((file) => this.toRelative(file.fsPath)).sort((a, b) => a.localeCompare(b));
  }

  private async searchCode(pattern: string, limit: number): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        "rg",
        ["-n", "--no-heading", "--color", "never", "-i", pattern, "."],
        {
          cwd: this.config.workspaceRoot,
          timeout: this.config.commandTimeoutMs,
          maxBuffer: 4 * 1024 * 1024
        }
      );

      return stdout
        .split(/\r?\n/g)
        .filter(Boolean)
        .slice(0, limit);
    } catch (error) {
      const e = error as { code?: number };
      if (e.code === 1) {
        return [];
      }
      return this.searchCodeFallback(pattern, limit);
    }
  }

  private async searchCodeFallback(pattern: string, limit: number): Promise<string[]> {
    const files = await this.getWorkspaceFileIndex(2000);
    const results: string[] = [];
    const lowerPattern = pattern.toLowerCase();

    for (const relPath of files) {
      if (results.length >= limit) {
        break;
      }

      try {
        const absPath = this.resolveWorkspacePath(relPath);
        const content = await fs.readFile(absPath, "utf8");
        const lines = content.split(/\r?\n/g);

        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].toLowerCase().includes(lowerPattern)) {
            results.push(`${relPath}:${index + 1}:${lines[index].trim()}`);
            if (results.length >= limit) {
              break;
            }
          }
        }
      } catch {
        // Ignore non-text or inaccessible files.
      }
    }

    return results;
  }

  private async fileExists(absPath: string): Promise<boolean> {
    try {
      await fs.access(absPath);
      return true;
    } catch {
      return false;
    }
  }

  private isVerificationCommand(command: string): boolean {
    const lower = command.toLowerCase();
    const checks = [
      /\btest\b/,
      /\blint\b/,
      /\btypecheck\b/,
      /\btsc\b/,
      /\bcheck\b/,
      /\bbuild\b/,
      /\bpytest\b/,
      /\bjest\b/,
      /\bvitest\b/,
      /\bgo\s+test\b/,
      /\bcargo\s+test\b/,
      /\bflutter\s+test\b/
    ];
    return checks.some((pattern) => pattern.test(lower));
  }

  private async findLikelyDuplicateFiles(targetRelPath: string): Promise<string[]> {
    const files = await this.getWorkspaceFileIndex(WORKSPACE_INDEX_LIMIT);
    const targetExt = path.extname(targetRelPath).toLowerCase();
    const targetBase = path.basename(targetRelPath).toLowerCase();
    const targetTokens = this.getFileNameTokens(targetBase);
    const targetDir = path.posix.dirname(targetRelPath);
    if (targetTokens.length === 0) {
      return [];
    }

    const matches: Array<{ file: string; score: number }> = [];
    for (const file of files) {
      if (file === targetRelPath) {
        continue;
      }

      const fileExt = path.extname(file).toLowerCase();
      if (targetExt && fileExt && targetExt !== fileExt) {
        continue;
      }

      const fileBase = path.basename(file).toLowerCase();
      const fileTokens = this.getFileNameTokens(fileBase);
      if (fileTokens.length === 0) {
        continue;
      }

      const score = this.computeTokenSimilarity(targetTokens, fileTokens);
      const contains = targetBase.includes(fileBase) || fileBase.includes(targetBase);
      const sameDir = path.posix.dirname(file) === targetDir;
      const boosted = score + (contains ? 0.25 : 0) + (sameDir ? 0.1 : 0);

      if (boosted >= 0.65 || (contains && boosted >= 0.55)) {
        matches.push({ file, score: boosted });
      }
    }

    return matches
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, DUPLICATE_GUARD_LIMIT)
      .map((entry) => entry.file);
  }

  private getFileNameTokens(fileName: string): string[] {
    const name = fileName.replace(/\.[^.]+$/, "");
    const tokens = name
      .split(/[^a-z0-9]+/gi)
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length >= 3);
    return Array.from(new Set(tokens));
  }

  private computeTokenSimilarity(a: string[], b: string[]): number {
    const left = new Set(a);
    const right = new Set(b);
    let overlap = 0;
    for (const token of left) {
      if (right.has(token)) {
        overlap += 1;
      }
    }
    if (left.size === 0 || right.size === 0) {
      return 0;
    }
    return overlap / Math.max(left.size, right.size);
  }

  private async searchFileNames(pattern: string, limit: number): Promise<string[]> {
    const terms = this.extractSearchTerms(pattern);
    if (terms.length === 0) {
      return [];
    }

    const files = await this.getWorkspaceFileIndex(WORKSPACE_INDEX_LIMIT);
    const scored: Array<{ file: string; score: number }> = [];

    for (const file of files) {
      const lower = file.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (lower.includes(term)) {
          score += term.length;
        }
      }
      if (score > 0) {
        scored.push({ file, score });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    return scored.slice(0, limit).map((item) => item.file);
  }

  private extractSearchTerms(raw: string): string[] {
    const quoted = [...raw.matchAll(/['"]([^'"]{2,})['"]/g)].map((match) => match[1]);
    const direct = raw.split(/[^A-Za-z0-9_/-]+/g);
    const stopWords = new Set([
      "the",
      "and",
      "for",
      "with",
      "from",
      "into",
      "where",
      "what",
      "which",
      "screen",
      "file",
      "code",
      "component",
      "page"
    ]);
    const terms = [...quoted, ...direct]
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length >= 3 && !stopWords.has(term));
    return Array.from(new Set(terms));
  }

  private async collectWorkspaceSnapshot(options: WorkspaceSnapshotOptions): Promise<string> {
    const files = await this.getWorkspaceFileIndex(options.fileLimit);
    const headPreview = files.slice(0, SNAPSHOT_HEAD_PREVIEW);
    const tailPreview =
      files.length > SNAPSHOT_HEAD_PREVIEW + SNAPSHOT_TAIL_PREVIEW ? files.slice(-SNAPSHOT_TAIL_PREVIEW) : [];
    const filePreview = tailPreview.length > 0 ? [...headPreview, "...", ...tailPreview] : headPreview;
    const chunks: string[] = [];

    for (const file of options.keyFiles) {
      try {
        const abs = this.resolveWorkspacePath(file);
        const content = await fs.readFile(abs, "utf8");
        chunks.push(`### ${file}\n${truncate(content, options.keyFileCharLimit)}`);
      } catch {
        // Ignore missing files.
      }
    }

    return [
      `Workspace index scanned: ${files.length} file(s).`,
      "Top-level directory summary:",
      this.buildDirectorySummary(files, 18),
      "",
      "File index preview:",
      filePreview.length > 0 ? filePreview.join("\n") : "(workspace appears empty)",
      chunks.join("\n\n")
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private async getWorkspaceFileIndex(limit = WORKSPACE_INDEX_LIMIT): Promise<string[]> {
    const targetLimit = Math.max(1, Math.min(limit, WORKSPACE_INDEX_LIMIT));
    if (!this.workspaceFileIndexCache || this.workspaceFileIndexCache.length < targetLimit) {
      this.workspaceFileIndexCache = await this.listFiles("**/*", targetLimit);
    }
    return this.workspaceFileIndexCache.slice(0, targetLimit);
  }

  private buildDirectorySummary(files: string[], limit: number): string {
    if (files.length === 0) {
      return "(no files)";
    }

    const counts = new Map<string, number>();
    for (const file of files) {
      const firstSegment = file.includes("/") ? file.split("/")[0] : ".";
      counts.set(firstSegment, (counts.get(firstSegment) ?? 0) + 1);
    }

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.max(1, limit))
      .map(([dir, count]) => `${dir}: ${count}`)
      .join("\n");
  }

  private async getPlannerWorkspaceSnapshot(): Promise<string> {
    if (!this.plannerSnapshotCache) {
      this.plannerSnapshotCache = await this.collectWorkspaceSnapshot(PLANNER_SNAPSHOT_OPTIONS);
    }
    return this.plannerSnapshotCache;
  }

  private async getExecutorWorkspaceSnapshot(): Promise<string> {
    if (!this.executorSnapshotCache) {
      this.executorSnapshotCache = await this.collectWorkspaceSnapshot(EXECUTOR_SNAPSHOT_OPTIONS);
    }
    return this.executorSnapshotCache;
  }

  private async findFirstExistingFile(candidates: string[]): Promise<string | undefined> {
    for (const candidate of candidates) {
      try {
        await fs.access(this.resolveWorkspacePath(candidate));
        return candidate;
      } catch {
        // Keep searching.
      }
    }
    return undefined;
  }

  private parsePlan(raw: string, task: string): ExecutionPlan {
    try {
      const parsed = extractJsonObject(raw) as Record<string, unknown>;
      const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];

      const steps: PlanStep[] = [];
      rawSteps.forEach((item, index) => {
        if (!item || typeof item !== "object") {
          return;
        }
        const step = item as Record<string, unknown>;
        const id = toStringValue(step.id, `S${index + 1}`);
        const title = toStringValue(step.title, `Step ${index + 1}`);
        const details = toStringValue(step.details, "");
        steps.push({
          id,
          title,
          details,
          status: "pending"
        });
      });

      if (steps.length === 0) {
        return {
          summary: "Fallback plan generated because planner output had no steps.",
          assumptions: ["Implement directly from user task."],
          steps: [
            {
              id: "S1",
              title: "Implement request",
              details: task,
              status: "pending"
            }
          ]
        };
      }

      return {
        summary: toStringValue(parsed.summary, "Execution plan"),
        assumptions: asArray(parsed.assumptions),
        steps
      };
    } catch (error) {
      this.callbacks.onLog(`Plan parse failed, using fallback: ${(error as Error).message}`);
      return {
        summary: "Fallback plan due to parser failure.",
        assumptions: ["Planner returned invalid JSON."],
        steps: [
          {
            id: "S1",
            title: "Implement request",
            details: task,
            status: "pending"
          }
        ]
      };
    }
  }

  private parseDecision(raw: string): AgentDecision {
    const parsed = extractJsonObject(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Decision is not an object.");
    }

    const decision = parsed as Record<string, unknown>;
    const action = this.extractActionFromDecision(decision);
    if (!action) {
      throw new Error("Decision missing usable action.");
    }

    return {
      reasoning: toStringValue(decision.reasoning, ""),
      action
    };
  }

  private extractActionFromDecision(decision: Record<string, unknown>): AgentAction | undefined {
    const actionRaw = decision.action;
    if (actionRaw && typeof actionRaw === "object") {
      const nested = this.coerceActionObject(actionRaw as Record<string, unknown>);
      if (nested) {
        return nested;
      }
    }

    const direct = this.coerceActionObject(decision);
    if (direct) {
      return direct;
    }

    const toolCallAction = this.extractActionFromToolCalls(decision);
    if (toolCallAction) {
      return toolCallAction;
    }

    return undefined;
  }

  private coerceActionObject(raw: Record<string, unknown>): AgentAction | undefined {
    const actionField = raw.action;
    const rawType =
      toStringValue(raw.type) ||
      toStringValue(raw.actionType) ||
      toStringValue(raw.action_type) ||
      toStringValue(raw.tool) ||
      (typeof actionField === "string" ? actionField : "");

    if (!rawType) {
      return undefined;
    }

    return {
      ...raw,
      type: this.normalizeActionType(rawType)
    };
  }

  private extractActionFromToolCalls(decision: Record<string, unknown>): AgentAction | undefined {
    const toolCallsRaw = decision.tool_calls;
    if (!Array.isArray(toolCallsRaw) || toolCallsRaw.length === 0) {
      return undefined;
    }

    const firstCall = toolCallsRaw[0];
    if (!firstCall || typeof firstCall !== "object") {
      return undefined;
    }

    const functionRaw = (firstCall as Record<string, unknown>).function;
    if (!functionRaw || typeof functionRaw !== "object") {
      return undefined;
    }

    const fn = functionRaw as Record<string, unknown>;
    const name = toStringValue(fn.name);
    if (!name) {
      return undefined;
    }

    let args: Record<string, unknown> = {};
    const rawArgs = fn.arguments;

    if (typeof rawArgs === "string" && rawArgs.trim().length > 0) {
      try {
        const parsedArgs = extractJsonObject(rawArgs);
        if (parsedArgs && typeof parsedArgs === "object") {
          args = parsedArgs as Record<string, unknown>;
        }
      } catch {
        // Keep args empty when the model returns invalid JSON arguments.
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>;
    }

    return {
      ...args,
      type: this.normalizeActionType(name)
    };
  }

  private resolveWorkspacePath(inputPath: string): string {
    const absolutePath = path.isAbsolute(inputPath)
      ? path.normalize(inputPath)
      : path.resolve(this.config.workspaceRoot, inputPath);

    const relative = path.relative(this.config.workspaceRoot, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path escapes workspace: ${inputPath}`);
    }

    return absolutePath;
  }

  private toRelative(absolutePath: string): string {
    return path.relative(this.config.workspaceRoot, absolutePath).split(path.sep).join("/");
  }

  private isDangerousCommand(command: string): boolean {
    const lower = command.toLowerCase();
    const patterns = [/rm\s+-rf/, /git\s+reset\s+--hard/, /mkfs/, /shutdown/, /reboot/];
    return patterns.some((pattern) => pattern.test(lower));
  }
}
