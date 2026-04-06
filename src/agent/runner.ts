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
const SEARCH_EXCLUDE =
  "**/{node_modules,.git,dist,build,.next,.dart_tool,coverage,target,vendor,Pods,.gradle,.turbo,.cache,.fvm,.pub-cache,.symlinks}/**";
const RG_SEARCH_EXCLUDE_GLOBS = [
  "!**/.git/**",
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/.next/**",
  "!**/.dart_tool/**",
  "!**/coverage/**",
  "!**/target/**",
  "!**/vendor/**",
  "!**/.gradle/**",
  "!**/Pods/**",
  "!**/.turbo/**",
  "!**/.cache/**",
  "!**/.fvm/**",
  "!**/.pub-cache/**",
  "!**/.symlinks/**",
  "!**/ios/Flutter/**",
  "!**/ios/Pods/**",
  "!**/android/.gradle/**",
  "!**/android/.cxx/**",
  "!**/android/build/**",
  "!**/macos/Flutter/**",
  "!**/linux/flutter/**",
  "!**/windows/flutter/**"
];
const SOURCE_FIRST_ROOTS = ["lib", "src", "app", "test", "integration_test", "packages"];
const TEST_FIRST_ROOTS = ["integration_test", "test", "lib", "src", "app", "packages"];
const STEP_HISTORY_TAIL_MESSAGES = 10;
const MAX_PARSE_ERROR_STREAK_BEFORE_RECOVERY = 2;
const MAX_REPEATED_ACTION_BLOCKS_BEFORE_RECOVERY = 2;
const NO_PROGRESS_WARNING_THRESHOLD = 3;
const MAX_EXTRA_INVESTIGATION_ACTIONS = 3;
const TURN_EXTENSION_CHUNK = 4;
const MAX_TURN_EXTENSION_TOTAL = 18;
const MAX_RESPONSIBILITY_BLOCKS_PER_STEP = 4;
const MAX_WRITE_FILE_CONTENT_CHARS = 4200;
const MAX_APPEND_FILE_CHUNK_CHARS = 2200;
const MAX_PATCH_REPLACE_CHARS = 3200;
const ASK_USER_MIN_INVESTIGATIONS = 4;
const WORKSPACE_INDEX_LIMIT = 4000;
const SNAPSHOT_HEAD_PREVIEW = 220;
const SNAPSHOT_TAIL_PREVIEW = 80;
const DUPLICATE_GUARD_LIMIT = 5;
const BROAD_SCOPE_STEP_LIMIT = 10;

interface ActionExecutionResult {
  kind: "tool" | "complete" | "final";
  message: string;
  progress: boolean;
}

interface ResponsibilityReviewResult {
  approve: boolean;
  reason: string;
}

type ScopeClass = "micro" | "small" | "medium" | "broad";

interface TaskScopeProfile {
  rawTask: string;
  scopeClass: ScopeClass;
  isTestTask: boolean;
  allowRewrite: boolean;
  maxChangedFiles: number;
  focusTerms: string[];
  primaryObjective: string;
  contract: string[];
}

interface WorkspaceSnapshotOptions {
  fileLimit: number;
  keyFiles: string[];
  keyFileCharLimit: number;
}

const PLANNER_SNAPSHOT_OPTIONS: WorkspaceSnapshotOptions = {
  fileLimit: 2500,
  keyFiles: [
    "README.md",
    "package.json",
    "tsconfig.json",
    "pubspec.yaml",
    "analysis_options.yaml",
    "pyproject.toml",
    "pytest.ini",
    "go.mod",
    "Cargo.toml"
  ],
  keyFileCharLimit: 1200
};

const EXECUTOR_SNAPSHOT_OPTIONS: WorkspaceSnapshotOptions = {
  fileLimit: 2500,
  keyFiles: [
    "README.md",
    "package.json",
    "tsconfig.json",
    "pubspec.yaml",
    "analysis_options.yaml",
    "pytest.ini",
    "src/extension.ts",
    "src/index.ts"
  ],
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
  private currentTaskScope?: TaskScopeProfile;
  private totalInvestigationActions = 0;

  constructor(
    private readonly client: LmStudioClient,
    private readonly config: AgentConfig,
    private readonly callbacks: RunnerCallbacks
  ) {}

  async createPlan(task: string, signal?: AbortSignal): Promise<ExecutionPlan> {
    const scopeProfile = this.buildTaskScope(task);
    this.currentTaskScope = scopeProfile;
    this.callbacks.onLog(
      `Task scope: class=${scopeProfile.scopeClass}, testTask=${scopeProfile.isTestTask}, allowRewrite=${scopeProfile.allowRewrite}, maxChangedFiles=${scopeProfile.maxChangedFiles}, focus=${scopeProfile.focusTerms.join(", ") || "(none)"}`
    );

    this.callbacks.onStatus(this.t("Analyzing workspace for planning...", "Đang phân tích workspace để lập kế hoạch..."));
    const workspaceContext = await this.getPlannerWorkspaceSnapshot();
    this.callbacks.onStatus(this.t("Comparing implementation approaches...", "Đang so sánh các hướng triển khai..."));
    this.selectedStrategyBrief = await this.buildImplementationStrategy(task, workspaceContext, scopeProfile, signal);
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
          "Task scope contract:",
          ...scopeProfile.contract,
          "",
          `Primary objective lock: ${scopeProfile.primaryObjective}`,
          `Preferred response language: ${this.getPreferredResponseLanguage()}`,
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

    const plannerResponse = await this.client.chat(messages, signal, {
      temperature: 0.1,
      maxTokens: 1400,
      thinkingEffort: this.getThinkingEffortOption(),
      responseFormat: "json_object"
    });
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

    const plan = this.parsePlan(rawPlan, task, scopeProfile);
    this.callbacks.onPlan(plan);
    return plan;
  }

  async run(task: string, signal?: AbortSignal): Promise<void> {
    this.verificationAttempted = false;
    this.totalInvestigationActions = 0;
    const plan = await this.createPlan(task, signal);

    this.callbacks.onStatus(this.t("Preparing execution context...", "Đang chuẩn bị ngữ cảnh thực thi..."));
    await this.getExecutorWorkspaceSnapshot();
    const failedSteps: Array<{ id: string; title: string; error: string }> = [];
    let completedSteps = 0;

    for (const step of plan.steps) {
      if (signal?.aborted) {
        throw new Error("Run cancelled.");
      }

      this.callbacks.onStepStatus(step.id, "in_progress");
      this.callbacks.onStatus(
        this.t(`Executing ${step.id}: ${step.title}`, `Đang thực thi ${step.id}: ${step.title}`)
      );

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
        this.callbacks.onStatus(
          this.t(
            `Step ${step.id} failed. Continuing with next step using assumptions...`,
            `Bước ${step.id} thất bại. Tiếp tục bước kế tiếp với giả định phù hợp...`
          )
        );
        continue;
      }
    }

    const changed = Array.from(this.changedFiles.values());
    const summary = [
      this.t("Agent execution completed.", "Agent đã hoàn tất thực thi."),
      this.t(
        `Completed steps: ${completedSteps}/${plan.steps.length}.`,
        `Số bước hoàn thành: ${completedSteps}/${plan.steps.length}.`
      ),
      failedSteps.length > 0
        ? this.t(
            `Failed steps (${failedSteps.length}): ${failedSteps.map((step) => `${step.id} (${step.error})`).join("; ")}`,
            `Bước thất bại (${failedSteps.length}): ${failedSteps.map((step) => `${step.id} (${step.error})`).join("; ")}`
          )
        : this.t("Failed steps: 0.", "Bước thất bại: 0."),
      changed.length > 0
        ? this.t(`Changed files (${changed.length}): ${changed.join(", ")}`, `Tệp đã đổi (${changed.length}): ${changed.join(", ")}`)
        : this.t("No files changed.", "Không có tệp nào thay đổi."),
      changed.length > 0 && !this.verificationAttempted
        ? this.t(
            "Verification warning: no test/lint/typecheck/build command was attempted.",
            "Cảnh báo xác minh: chưa chạy lệnh test/lint/typecheck/build."
          )
        : this.t("Verification: attempted.", "Xác minh: đã thực hiện.")
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
    const minInvestigations = this.computeRequiredInvestigationsForStep();
    const maxInvestigations = Math.max(minInvestigations + MAX_EXTRA_INVESTIGATION_ACTIONS, minInvestigations * 2);

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
          "Task scope contract:",
          ...(this.currentTaskScope?.contract ?? []),
          `Primary objective lock: ${this.currentTaskScope?.primaryObjective ?? "Follow user request exactly."}`,
          "You have full read access to all files under workspace root.",
          "Never ask the user where files/screens/components are located; discover by list/search/read actions.",
          `Minimum investigation actions required before write/run/complete: ${minInvestigations}`,
          "Action payload budget: keep one action JSON compact; if edit is large, split into multiple patch_file/append_file chunks.",
          `Preferred response language: ${this.getPreferredResponseLanguage()}`,
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
    let responsibilityBlocks = 0;
    const seenInvestigationSignatures = new Set<string>();
    let stepTurnLimit = Math.max(3, this.config.maxTurnsPerStep);
    const stepTurnHardLimit = Math.max(stepTurnLimit, stepTurnLimit + MAX_TURN_EXTENSION_TOTAL);
    const changedFilesAtStepStart = this.changedFiles.size;
    let lastExecutionProgressTurn = 0;
    let executionProgressCount = 0;
    let extensionCount = 0;

    for (let turn = 1; turn <= stepTurnLimit; turn += 1) {
      if (signal?.aborted) {
        throw new Error("Run cancelled.");
      }

      if (turn === stepTurnLimit && stepTurnLimit < stepTurnHardLimit) {
        const changedInThisStep = this.changedFiles.size > changedFilesAtStepStart;
        const recentExecutionProgress =
          lastExecutionProgressTurn > 0 && turn - lastExecutionProgressTurn <= 3;
        const shouldExtend =
          turnsWithoutProgress <= 2 &&
          (recentExecutionProgress || changedInThisStep || executionProgressCount >= 2);

        if (shouldExtend) {
          const extension = Math.min(TURN_EXTENSION_CHUNK, stepTurnHardLimit - stepTurnLimit);
          if (extension > 0) {
            stepTurnLimit += extension;
            extensionCount += 1;
            this.callbacks.onLog(
              `TurnBudgetGuard: extending ${step.id} by ${extension} turn(s) (new limit ${stepTurnLimit}/${stepTurnHardLimit}) due to ongoing execution progress.`
            );
          }
        }
      }

      this.compactStepMessages(stepMessages);
      this.callbacks.onStatus(
        this.t(`Step ${step.id} turn ${turn}/${stepTurnLimit}`, `Bước ${step.id} lượt ${turn}/${stepTurnLimit}`)
      );

      const streamId = `${step.id}:turn${turn}`;
      let streamedText = "";
      let pendingStreamChars = 0;
      let lastStreamEmitMs = 0;
      const emitStream = (done: boolean): void => {
        if (!this.callbacks.onStream) {
          return;
        }
        const preview = this.toStreamPreview(streamedText);
        if (!done && preview.length === 0) {
          return;
        }
        this.callbacks.onStream({
          phase: "executor",
          stepId: step.id,
          turn,
          streamId,
          text: preview,
          done
        });
      };

      let stepResponse;
      try {
        stepResponse = await this.client.chat(stepMessages, signal, {
          temperature: 0.1,
          maxTokens: this.getExecutorMaxTokens(),
          stream: true,
          thinkingEffort: this.getThinkingEffortOption(),
          responseFormat: "json_object",
          onDelta: (delta) => {
            if (!delta) {
              return;
            }
            streamedText += delta;
            pendingStreamChars += delta.length;
            const now = Date.now();
            if (pendingStreamChars >= 70 || now - lastStreamEmitMs >= 180) {
              emitStream(false);
              pendingStreamChars = 0;
              lastStreamEmitMs = now;
            }
          }
        });
      } catch (error) {
        if (streamedText.length > 0) {
          emitStream(true);
        }
        throw error;
      }
      if (streamedText.length > 0) {
        emitStream(true);
      }
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
        const parseErrorMessage = (error as Error).message;
        this.callbacks.onLog(`Decision parse error (${parseErrorStreak}): ${parseErrorMessage}`);
        const likelyTruncatedWritePayload = this.isLikelyTruncatedWritePayload(rawResponse, parseErrorMessage);

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
            content: likelyTruncatedWritePayload
              ? "Previous output appears to be truncated write_file JSON. Retry STRICT JSON with one action object only. Use patch_file/append_file or content_lines with smaller chunks."
              : "Output was not valid JSON for the required schema. Return STRICT JSON only with one action object."
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

      const investigationSignature = this.buildInvestigationSignature(actionType, decision.action);
      const isRepeatedInvestigation =
        this.isInvestigationAction(actionType) &&
        investigationSignature.length > 0 &&
        seenInvestigationSignatures.has(investigationSignature);

      if (this.isInvestigationAction(actionType) && investigationCount >= maxInvestigations && isRepeatedInvestigation) {
        const guardMessage = [
          "ExplorationGuard: investigation budget reached and action is repeating existing investigation evidence.",
          `Investigations done: ${investigationCount}/${maxInvestigations}.`,
          "Use a different file/query or proceed with write_file, run_command, or complete_step."
        ].join(" ");
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

      if (this.shouldRunResponsibilityReview(actionType)) {
        const review = await this.reviewActionForResponsibility(
          task,
          plan,
          step,
          decision.action,
          investigationCount,
          turn,
          signal
        );
        if (!review.approve && responsibilityBlocks < MAX_RESPONSIBILITY_BLOCKS_PER_STEP) {
          responsibilityBlocks += 1;
          const guardMessage = [
            `ResponsibilityGuard: ${review.reason}`,
            `Action '${actionType}' blocked to prevent off-target execution.`,
            `Primary objective: ${this.currentTaskScope?.primaryObjective ?? "Follow user request exactly."}`
          ].join(" ");
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
      }

      if (this.isInvestigationAction(actionType)) {
        investigationCount += 1;
        this.totalInvestigationActions += 1;
        if (investigationSignature.length > 0) {
          seenInvestigationSignatures.add(investigationSignature);
        }
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
      if (actionResult.progress && this.isExecutionAction(actionType)) {
        lastExecutionProgressTurn = turn;
        executionProgressCount += 1;
      }
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
      this.t(
        `Step ${step.id} exceeded max turns (${stepTurnLimit}${extensionCount > 0 ? `, extended ${extensionCount} time(s)` : ""}). Agent may be looping.`,
        `Bước ${step.id} đã vượt giới hạn lượt (${stepTurnLimit}${extensionCount > 0 ? `, đã gia hạn ${extensionCount} lần` : ""}). Có thể đang lặp.`
      )
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
      this.totalInvestigationActions += 1;
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
        const patternBlock = this.evaluateListPatternGuard(pattern);
        if (patternBlock) {
          return {
            kind: "tool",
            message: patternBlock,
            progress: false
          };
        }
        const relevanceBlock = this.evaluateInvestigationRelevanceGuard("list_files", pattern, investigationCount);
        if (relevanceBlock) {
          return {
            kind: "tool",
            message: relevanceBlock,
            progress: false
          };
        }

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
          const pathGuard = this.evaluatePathAccessGuard(relPath, "read");
          if (pathGuard) {
            return {
              kind: "tool",
              message: pathGuard,
              progress: false
            };
          }
          const relevanceBlock = this.evaluateReadRelevanceGuard(relPath, investigationCount);
          if (relevanceBlock) {
            return {
              kind: "tool",
              message: relevanceBlock,
              progress: false
            };
          }
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
        const relevanceBlock = this.evaluateInvestigationRelevanceGuard("search_code", pattern, investigationCount);
        if (relevanceBlock) {
          return {
            kind: "tool",
            message: relevanceBlock,
            progress: false
          };
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
        const content = this.resolveWriteContent(action);
        if (!filePath) {
          return { kind: "tool", message: "write_file failed: missing path.", progress: false };
        }
        if (typeof content !== "string") {
          return {
            kind: "tool",
            message:
              "write_file failed: missing content. Provide one of content (string), content_lines (string[]), or contentBase64.",
            progress: false
          };
        }
        if (content.length > MAX_WRITE_FILE_CONTENT_CHARS) {
          return {
            kind: "tool",
            message: [
              `write_file blocked: payload too large (${content.length} chars).`,
              `Use patch_file/append_file or split content into chunks <= ${MAX_WRITE_FILE_CONTENT_CHARS} chars.`
            ].join(" "),
            progress: false
          };
        }

        return this.applyWriteFile(filePath, content, {
          mode: "overwrite",
          allowCreate: true,
          allowDuplicate: action.allowDuplicate === true
        });
      }

      case "append_file": {
        if (!this.config.autoApplyWrites) {
          return {
            kind: "tool",
            message: "append_file blocked by config (localAgent.autoApplyWrites=false).",
            progress: false
          };
        }

        const filePath = toStringValue(action.path);
        const content = this.resolveWriteContent(action);
        const allowCreate = action.allowCreate === true || action.createIfMissing === true;
        if (!filePath) {
          return { kind: "tool", message: "append_file failed: missing path.", progress: false };
        }
        if (typeof content !== "string" || content.length === 0) {
          return {
            kind: "tool",
            message:
              "append_file failed: missing content. Provide content/content_lines/contentBase64 with non-empty chunk.",
            progress: false
          };
        }
        if (content.length > MAX_APPEND_FILE_CHUNK_CHARS) {
          return {
            kind: "tool",
            message: [
              `append_file blocked: chunk too large (${content.length} chars).`,
              `Append in smaller chunks <= ${MAX_APPEND_FILE_CHUNK_CHARS} chars.`
            ].join(" "),
            progress: false
          };
        }
        return this.applyWriteFile(filePath, content, {
          mode: "append",
          allowCreate,
          allowDuplicate: false
        });
      }

      case "patch_file": {
        if (!this.config.autoApplyWrites) {
          return {
            kind: "tool",
            message: "patch_file blocked by config (localAgent.autoApplyWrites=false).",
            progress: false
          };
        }

        const filePath = toStringValue(action.path);
        const findText = toStringValue(action.find);
        const replaceText = this.resolvePatchReplaceText(action);
        const replaceAll = action.all === true || action.replaceAll === true;
        if (!filePath) {
          return { kind: "tool", message: "patch_file failed: missing path.", progress: false };
        }
        if (!findText) {
          return { kind: "tool", message: "patch_file failed: missing find text.", progress: false };
        }
        if (typeof replaceText !== "string") {
          return {
            kind: "tool",
            message:
              "patch_file failed: missing replace content. Provide replace/replacement/replace_lines/replaceBase64.",
            progress: false
          };
        }
        if (replaceText.length > MAX_PATCH_REPLACE_CHARS) {
          return {
            kind: "tool",
            message: [
              `patch_file blocked: replacement too large (${replaceText.length} chars).`,
              `Split patch into smaller replacements <= ${MAX_PATCH_REPLACE_CHARS} chars.`
            ].join(" "),
            progress: false
          };
        }
        return this.applyPatchFile(filePath, findText, replaceText, replaceAll);
      }

      case "run_command": {
        const command = toStringValue(action.command);
        if (!command) {
          return { kind: "tool", message: "run_command failed: missing command.", progress: false };
        }

        const commandScopeBlock = this.evaluateCommandScopeGuard(command);
        if (commandScopeBlock) {
          return { kind: "tool", message: commandScopeBlock, progress: false };
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
        const summary = toStringValue(action.summary, "Step completed.");
        if (this.changedFiles.size > 0 && !this.verificationAttempted) {
          return {
            kind: "complete",
            message: `${summary} (Verification pending: run a relevant test/lint/typecheck/build command in later step.)`,
            progress: true
          };
        }
        return { kind: "complete", message: summary, progress: true };
      }

      case "final_answer": {
        if (this.currentTaskScope?.isTestTask) {
          const testQualityIssue = await this.validateChangedTestFilesQuality();
          if (testQualityIssue) {
            return { kind: "tool", message: testQualityIssue, progress: false };
          }
        }
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
    const scope = this.currentTaskScope;

    if (investigationCount <= 0) {
      if (scope?.isTestTask) {
        return {
          type: "list_files",
          pattern: await this.pickTestListPatternFromScope(),
          limit: 500
        };
      }
      return {
        type: "list_files",
        pattern: "**/*",
        limit: 500
      };
    }

    if (investigationCount <= 1) {
      if (scope?.isTestTask) {
        const focusedTestFile = await this.findFirstTestFileForScope();
        if (focusedTestFile) {
          return {
            type: "read_file",
            path: focusedTestFile,
            startLine: 1,
            endLine: 260
          };
        }
      }

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

  private async pickTestListPatternFromScope(): Promise<string> {
    const files = await this.getWorkspaceFileIndex(WORKSPACE_INDEX_LIMIT);
    const hasIntegrationTest = files.some((file) => file.startsWith("integration_test/"));
    if (hasIntegrationTest) {
      return "integration_test/**/*";
    }
    const hasTestDir = files.some((file) => file.startsWith("test/"));
    if (hasTestDir) {
      return "test/**/*";
    }
    const hasSpecDir = files.some((file) => file.startsWith("spec/"));
    if (hasSpecDir) {
      return "spec/**/*";
    }
    return "**/*test*";
  }

  private async findFirstTestFileForScope(): Promise<string | undefined> {
    const files = await this.getWorkspaceFileIndex(WORKSPACE_INDEX_LIMIT);
    const scope = this.currentTaskScope;
    const testFiles = files.filter((file) => this.isLikelyTestFile(file.toLowerCase()));
    if (testFiles.length === 0) {
      return undefined;
    }

    if (scope && scope.focusTerms.length > 0) {
      const focused = testFiles.find((file) => this.pathMatchesFocusTerms(file, scope.focusTerms));
      if (focused) {
        return focused;
      }
    }

    const preferred = testFiles.find(
      (file) => file.startsWith("integration_test/") || file.startsWith("test/")
    );
    return preferred ?? testFiles[0];
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
    scopeProfile: TaskScopeProfile,
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
            "- Strictly respect task scope; do not expand a narrow test/bugfix request into project rewrite.",
            `- Write all text fields in this language: ${this.getPreferredResponseLanguage()}.`,
            "- Keep concise and actionable."
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `Task:\n${task}`,
            "",
            "Task scope contract:",
            ...scopeProfile.contract,
            "",
            "Workspace context:",
            workspaceContext,
            "",
            "Return JSON now."
          ].join("\n")
        }
      ],
      signal,
      {
        temperature: 0.12,
        maxTokens: 1400,
        thinkingEffort: this.getThinkingEffortOption(),
        responseFormat: "json_object"
      }
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
    return ["write_file", "append_file", "patch_file", "run_command", "complete_step", "final_answer"].includes(type);
  }

  private computeRequiredInvestigationsForStep(): number {
    const base = Math.max(1, this.config.minInvestigationsBeforeExecute);
    const scope = this.currentTaskScope;

    if (this.totalInvestigationActions === 0) {
      return base;
    }

    if (scope?.isTestTask) {
      return Math.max(1, Math.min(2, base));
    }

    return Math.max(1, Math.min(2, base));
  }

  private isInvestigationAction(type: string): boolean {
    return ["list_files", "read_file", "search_code"].includes(type);
  }

  private isExecutionAction(type: string): boolean {
    return ["write_file", "append_file", "patch_file", "run_command"].includes(type);
  }

  private shouldRunResponsibilityReview(type: string): boolean {
    if (!this.config.strictResponsibilityMode) {
      return false;
    }
    return ["write_file", "append_file", "patch_file", "run_command", "complete_step", "final_answer"].includes(type);
  }

  private async reviewActionForResponsibility(
    task: string,
    plan: ExecutionPlan,
    step: PlanStep,
    action: AgentAction,
    investigationCount: number,
    turn: number,
    signal?: AbortSignal
  ): Promise<ResponsibilityReviewResult> {
    if (!this.config.strictResponsibilityMode) {
      return { approve: true, reason: "Responsibility mode disabled." };
    }

    try {
      const scope = this.currentTaskScope;
      const changedPreview = Array.from(this.changedFiles.values())
        .slice(0, 12)
        .join(", ");

      const response = await this.client.chat(
        [
          {
            role: "system",
            content: [
              "You are a strict responsibility reviewer for an autonomous coding agent.",
              "Decide if proposed action is directly aligned with user objective.",
              "Return STRICT JSON only with schema:",
              '{ "approve": true, "reason": "string" }',
              "Rules:",
              "- Reject actions that drift into unrelated feature work/refactor.",
              "- For test tasks: reject non-test implementation actions unless explicitly requested.",
              "- Reject complete_step/final_answer if request deliverable is likely not fulfilled.",
              "- Keep reason short and concrete.",
              `- Use language: ${this.getPreferredResponseLanguage()}.`
            ].join("\n")
          },
          {
            role: "user",
            content: [
              `Global task:\n${task}`,
              "",
              `Plan summary: ${plan.summary}`,
              `Current step (${step.id}): ${step.title}`,
              `Step details: ${step.details}`,
              "",
              `Primary objective: ${scope?.primaryObjective ?? "Follow user request exactly."}`,
              `Focus terms: ${(scope?.focusTerms ?? []).join(", ") || "(none)"}`,
              `Is test task: ${scope?.isTestTask ? "yes" : "no"}`,
              `Investigation count: ${investigationCount}`,
              `Changed files: ${changedPreview || "(none)"}`,
              "",
              `Proposed action JSON:\n${JSON.stringify(action)}`,
              "",
              "Return JSON now."
            ].join("\n")
          }
        ],
        signal,
        {
          temperature: 0.05,
          maxTokens: 220,
          thinkingEffort: this.getThinkingEffortOption(),
          responseFormat: "json_object"
        }
      );

      if (response.usage) {
        this.callbacks.onUsage?.({
          phase: "executor",
          stepId: step.id,
          turn,
          model: response.model,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens
        });
      }

      const parsed = extractJsonObject(response.content) as Record<string, unknown>;
      const approveRaw = parsed.approve;
      const approve =
        approveRaw === true ||
        (typeof approveRaw === "string" && ["true", "yes", "ok", "approved"].includes(approveRaw.toLowerCase()));
      const reason = toStringValue(parsed.reason, approve ? "Approved." : "Action appears off-target.");

      return {
        approve,
        reason
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.callbacks.onLog(`Responsibility review skipped: ${text}`);
      return { approve: true, reason: "Review unavailable; continue with safeguards." };
    }
  }

  private buildInvestigationSignature(type: string, action: AgentAction): string {
    if (!this.isInvestigationAction(type)) {
      return "";
    }

    if (type === "read_file") {
      const path = toStringValue(action.path).trim().toLowerCase();
      if (!path) {
        return "read_file:";
      }
      const startLine = toNumberValue(action.startLine, 1);
      const endLine = toNumberValue(action.endLine, Number.MAX_SAFE_INTEGER);
      return `read_file:${path}:${startLine}-${endLine}`;
    }

    if (type === "search_code") {
      const pattern = toStringValue(action.pattern).trim().toLowerCase();
      const limit = toNumberValue(action.limit, 100);
      return `search_code:${pattern}:${limit}`;
    }

    if (type === "list_files") {
      const pattern = toStringValue(action.pattern, "**/*").trim().toLowerCase();
      const limit = toNumberValue(action.limit, 500);
      return `list_files:${pattern}:${limit}`;
    }

    return `${type}:${JSON.stringify(action)}`;
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
      append: "append_file",
      appendfile: "append_file",
      patch: "patch_file",
      patchfile: "patch_file",
      replace: "patch_file",
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

  private getExecutorMaxTokens(): number {
    const raw = Number(this.config.executorMaxTokens);
    if (!Number.isFinite(raw)) {
      return 3200;
    }
    return Math.max(600, Math.min(8000, Math.floor(raw)));
  }

  private getThinkingEffortOption(): "low" | "medium" | "high" | undefined {
    if (!this.config.thinkingEnabled) {
      return undefined;
    }
    const raw = String(this.config.thinkingEffort || "").trim().toLowerCase();
    if (raw === "low" || raw === "high") {
      return raw;
    }
    return "medium";
  }

  private getPreferredResponseLanguage(): string {
    const raw = (this.config.preferredLanguage || "").trim();
    return raw.length > 0 ? raw : "Same as user request language";
  }

  private prefersVietnamese(): boolean {
    return /vietnamese|^vi\b|tiếng việt/i.test(this.getPreferredResponseLanguage());
  }

  private t(english: string, vietnamese: string): string {
    return this.prefersVietnamese() ? vietnamese : english;
  }

  private toStreamPreview(value: string, maxChars = 900): string {
    const text = value || "";
    if (text.length <= maxChars) {
      return text;
    }
    return `...${text.slice(text.length - maxChars)}`;
  }

  private isLikelyTruncatedWritePayload(rawResponse: string, parseErrorMessage: string): boolean {
    const lowerError = parseErrorMessage.toLowerCase();
    const looksTruncated =
      lowerError.includes("unterminated string") ||
      lowerError.includes("unexpected end of json") ||
      lowerError.includes("end of json input");
    if (!looksTruncated) {
      return false;
    }

    const lowerRaw = rawResponse.toLowerCase();
    return (
      lowerRaw.includes("write_file") ||
      lowerRaw.includes("append_file") ||
      lowerRaw.includes("patch_file") ||
      lowerRaw.includes("\"content\"") ||
      lowerRaw.includes("\"replace\"") ||
      lowerRaw.includes("\"path\"")
    );
  }

  private resolveWriteContent(action: AgentAction): string | undefined {
    if (typeof action.content === "string") {
      return action.content;
    }

    const linesRaw = action.content_lines ?? action.contentLines;
    if (Array.isArray(linesRaw)) {
      return linesRaw.map((line) => (typeof line === "string" ? line : String(line ?? ""))).join("\n");
    }

    const contentBase64 = toStringValue(action.contentBase64) || toStringValue(action.content_base64);
    if (contentBase64.trim().length > 0) {
      try {
        return Buffer.from(contentBase64, "base64").toString("utf8");
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  private resolvePatchReplaceText(action: AgentAction): string | undefined {
    const direct =
      toStringValue(action.replace) ||
      toStringValue(action.replacement) ||
      toStringValue(action.replaceText) ||
      toStringValue(action.newText);
    if (direct.length > 0) {
      return direct;
    }

    const linesRaw = action.replace_lines ?? action.replaceLines;
    if (Array.isArray(linesRaw)) {
      return linesRaw.map((line) => (typeof line === "string" ? line : String(line ?? ""))).join("\n");
    }

    const base64 = toStringValue(action.replaceBase64) || toStringValue(action.replace_base64);
    if (base64.trim().length > 0) {
      try {
        return Buffer.from(base64, "base64").toString("utf8");
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private async applyWriteFile(
    filePath: string,
    content: string,
    options: { mode: "overwrite" | "append"; allowCreate: boolean; allowDuplicate: boolean }
  ): Promise<ActionExecutionResult> {
    try {
      const absPath = this.resolveWorkspacePath(filePath);
      const relPath = this.toRelative(absPath);
      const pathGuard = this.evaluatePathAccessGuard(relPath, "write");
      if (pathGuard) {
        return { kind: "tool", message: pathGuard, progress: false };
      }

      const existsBeforeWrite = await this.fileExists(absPath);
      if (!existsBeforeWrite && !options.allowCreate) {
        return {
          kind: "tool",
          message: `append_file failed: '${relPath}' does not exist. Set allowCreate=true to create it first.`,
          progress: false
        };
      }

      if (!existsBeforeWrite && options.mode === "overwrite") {
        const duplicateCandidates = await this.findLikelyDuplicateFiles(relPath);
        if (!options.allowDuplicate && duplicateCandidates.length > 0) {
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

      let finalContent = content;
      if (options.mode === "append" && existsBeforeWrite) {
        const existing = await fs.readFile(absPath, "utf8");
        finalContent = `${existing}${content}`;
      }

      const writeScopeBlock = await this.evaluateWriteScopeGuard(relPath, existsBeforeWrite, finalContent);
      if (writeScopeBlock) {
        return { kind: "tool", message: writeScopeBlock, progress: false };
      }

      await fs.mkdir(path.dirname(absPath), { recursive: true });
      if (options.mode === "append" && existsBeforeWrite) {
        await fs.appendFile(absPath, content, "utf8");
      } else {
        await fs.writeFile(absPath, options.mode === "append" ? finalContent : content, "utf8");
      }

      this.markChangedFile(relPath);
      const verb =
        options.mode === "append" ? `Appended ${content.length} chars to` : existsBeforeWrite ? "Updated" : "Created";
      return {
        kind: "tool",
        message: `${verb} ${relPath} (${content.length} chars${options.mode === "append" ? " chunk" : ""}).`,
        progress: true
      };
    } catch (error) {
      const actionName = options.mode === "append" ? "append_file" : "write_file";
      return {
        kind: "tool",
        message: `${actionName} failed for ${filePath}: ${(error as Error).message}`,
        progress: false
      };
    }
  }

  private async applyPatchFile(
    filePath: string,
    findText: string,
    replaceText: string,
    replaceAll: boolean
  ): Promise<ActionExecutionResult> {
    try {
      const absPath = this.resolveWorkspacePath(filePath);
      const relPath = this.toRelative(absPath);
      const pathGuard = this.evaluatePathAccessGuard(relPath, "write");
      if (pathGuard) {
        return { kind: "tool", message: pathGuard, progress: false };
      }

      const existsBeforeWrite = await this.fileExists(absPath);
      if (!existsBeforeWrite) {
        return { kind: "tool", message: `patch_file failed: '${relPath}' does not exist.`, progress: false };
      }

      const original = await fs.readFile(absPath, "utf8");
      if (!original.includes(findText)) {
        return {
          kind: "tool",
          message: `patch_file failed: pattern not found in '${relPath}'.`,
          progress: false
        };
      }

      const updated = replaceAll ? original.split(findText).join(replaceText) : original.replace(findText, replaceText);
      const writeScopeBlock = await this.evaluateWriteScopeGuard(relPath, true, updated);
      if (writeScopeBlock) {
        return { kind: "tool", message: writeScopeBlock, progress: false };
      }

      await fs.writeFile(absPath, updated, "utf8");
      this.markChangedFile(relPath);

      const occurrences = replaceAll ? Math.max(0, original.split(findText).length - 1) : 1;
      return {
        kind: "tool",
        message: `Patched ${relPath}: replaced ${occurrences} occurrence(s).`,
        progress: true
      };
    } catch (error) {
      return {
        kind: "tool",
        message: `patch_file failed for ${filePath}: ${(error as Error).message}`,
        progress: false
      };
    }
  }

  private markChangedFile(relPath: string): void {
    this.changedFiles.add(relPath);
    this.executorSnapshotCache = undefined;
    if (this.workspaceFileIndexCache && !this.workspaceFileIndexCache.includes(relPath)) {
      this.workspaceFileIndexCache.push(relPath);
      this.workspaceFileIndexCache.sort((a, b) => a.localeCompare(b));
    }
  }

  private safeActionPreview(action: AgentAction): string {
    const copy: Record<string, unknown> = { ...action };
    if (typeof copy.content === "string" && copy.content.length > 180) {
      copy.content = `${copy.content.slice(0, 180)}...`;
    }
    if (typeof copy.replace === "string" && copy.replace.length > 180) {
      copy.replace = `${copy.replace.slice(0, 180)}...`;
    }
    if (typeof copy.replacement === "string" && copy.replacement.length > 180) {
      copy.replacement = `${copy.replacement.slice(0, 180)}...`;
    }
    if (Array.isArray(copy.content_lines) && copy.content_lines.length > 10) {
      copy.content_lines = [...copy.content_lines.slice(0, 10), "..."];
    }
    if (Array.isArray(copy.contentLines) && copy.contentLines.length > 10) {
      copy.contentLines = [...copy.contentLines.slice(0, 10), "..."];
    }
    if (Array.isArray(copy.replace_lines) && copy.replace_lines.length > 10) {
      copy.replace_lines = [...copy.replace_lines.slice(0, 10), "..."];
    }
    if (Array.isArray(copy.replaceLines) && copy.replaceLines.length > 10) {
      copy.replaceLines = [...copy.replaceLines.slice(0, 10), "..."];
    }
    if (typeof copy.contentBase64 === "string" && copy.contentBase64.length > 120) {
      copy.contentBase64 = `${copy.contentBase64.slice(0, 120)}...`;
    }
    if (typeof copy.content_base64 === "string" && copy.content_base64.length > 120) {
      copy.content_base64 = `${copy.content_base64.slice(0, 120)}...`;
    }
    return JSON.stringify(copy);
  }

  private async listFiles(pattern: string, limit: number): Promise<string[]> {
    const requestedPattern = pattern.trim() || "**/*";
    const broadPattern = this.isBroadListPattern(requestedPattern);
    if (broadPattern) {
      const roots = await this.getProjectFirstRoots();
      const seen = new Set<string>();

      for (const root of roots) {
        if (seen.size >= limit) {
          break;
        }
        const rootPattern = new vscode.RelativePattern(this.config.workspaceRoot, `${root}/**/*`);
        const files = await vscode.workspace.findFiles(rootPattern, SEARCH_EXCLUDE, limit);
        for (const file of files) {
          const rel = this.toRelative(file.fsPath);
          if (this.isFrameworkOrGeneratedPath(rel)) {
            continue;
          }
          seen.add(rel);
          if (seen.size >= limit) {
            break;
          }
        }
      }

      if (seen.size < limit) {
        const relativePattern = new vscode.RelativePattern(this.config.workspaceRoot, requestedPattern);
        const files = await vscode.workspace.findFiles(relativePattern, SEARCH_EXCLUDE, limit);
        const remainder = files
          .map((file) => this.toRelative(file.fsPath))
          .filter((file) => !this.isFrameworkOrGeneratedPath(file))
          .sort((a, b) => this.comparePathPriority(a, b));
        for (const rel of remainder) {
          seen.add(rel);
          if (seen.size >= limit) {
            break;
          }
        }
      }

      return Array.from(seen.values()).slice(0, limit);
    }

    const relativePattern = new vscode.RelativePattern(this.config.workspaceRoot, requestedPattern);
    const files = await vscode.workspace.findFiles(relativePattern, SEARCH_EXCLUDE, limit);
    return files
      .map((file) => this.toRelative(file.fsPath))
      .filter((file) => !this.isFrameworkOrGeneratedPath(file))
      .sort((a, b) => this.comparePathPriority(a, b));
  }

  private async searchCode(pattern: string, limit: number): Promise<string[]> {
    try {
      const roots = await this.getProjectFirstRoots();
      const preferredTargets = roots.length > 0 ? roots : ["."]; // keep search local to source first
      const preferred = await this.runRipgrep(pattern, limit, preferredTargets);
      if (preferred.length >= limit || preferredTargets[0] === ".") {
        return this.sortSearchResultsByPriority(preferred).slice(0, limit);
      }

      const fallback = await this.runRipgrep(pattern, limit, ["."]);
      const merged = new Set<string>(preferred);
      for (const item of fallback) {
        if (this.isFrameworkOrGeneratedSearchResult(item)) {
          continue;
        }
        merged.add(item);
        if (merged.size >= limit) {
          break;
        }
      }
      return this.sortSearchResultsByPriority(Array.from(merged.values())).slice(0, limit);
    } catch (error) {
      return this.searchCodeFallback(pattern, limit);
    }
  }

  private async runRipgrep(pattern: string, limit: number, targets: string[]): Promise<string[]> {
    try {
      const targetArgs = targets.length > 0 ? targets : ["."];
      const rgArgs = [
        "-n",
        "--no-heading",
        "--color",
        "never",
        "-i",
        ...RG_SEARCH_EXCLUDE_GLOBS.flatMap((glob) => ["--glob", glob]),
        pattern,
        ...targetArgs
      ];
      const { stdout } = await execFileAsync("rg", rgArgs, {
        cwd: this.config.workspaceRoot,
        timeout: this.config.commandTimeoutMs,
        maxBuffer: 4 * 1024 * 1024
      });
      return stdout
        .split(/\r?\n/g)
        .filter(Boolean)
        .filter((line) => !this.isFrameworkOrGeneratedSearchResult(line))
        .slice(0, limit);
    } catch (error) {
      const e = error as { code?: number };
      if (e.code === 1) {
        return [];
      }
      throw error;
    }
  }

  private async searchCodeFallback(pattern: string, limit: number): Promise<string[]> {
    const files = await this.getWorkspaceFileIndex(2000);
    const results: string[] = [];
    const lowerPattern = pattern.toLowerCase();

    for (const relPath of files) {
      if (this.isFrameworkOrGeneratedPath(relPath)) {
        continue;
      }
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

  private isBroadListPattern(pattern: string): boolean {
    const normalized = pattern.trim().toLowerCase();
    return normalized.length === 0 || normalized === "*" || normalized === "**" || normalized === "**/*";
  }

  private async getProjectFirstRoots(): Promise<string[]> {
    const preferred = this.currentTaskScope?.isTestTask ? TEST_FIRST_ROOTS : SOURCE_FIRST_ROOTS;
    const found: string[] = [];
    for (const dir of preferred) {
      try {
        const abs = this.resolveWorkspacePath(dir);
        const stats = await fs.stat(abs);
        if (stats.isDirectory()) {
          found.push(dir);
        }
      } catch {
        // Ignore missing folders.
      }
    }
    return found;
  }

  private comparePathPriority(leftPath: string, rightPath: string): number {
    const leftRank = this.getPathPriorityRank(leftPath);
    const rightRank = this.getPathPriorityRank(rightPath);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return leftPath.localeCompare(rightPath);
  }

  private getPathPriorityRank(relativePath: string): number {
    const lower = relativePath.replace(/\\/g, "/").toLowerCase();
    if (this.isFrameworkOrGeneratedPath(lower)) {
      return 100;
    }
    const roots = this.currentTaskScope?.isTestTask ? TEST_FIRST_ROOTS : SOURCE_FIRST_ROOTS;
    for (let i = 0; i < roots.length; i += 1) {
      const root = roots[i];
      if (lower === root || lower.startsWith(`${root}/`)) {
        return i;
      }
    }
    return roots.length + 1;
  }

  private sortSearchResultsByPriority(results: string[]): string[] {
    return [...results].sort((a, b) => {
      const aPath = a.split(":")[0] || a;
      const bPath = b.split(":")[0] || b;
      return this.comparePathPriority(aPath, bPath);
    });
  }

  private isFrameworkOrGeneratedSearchResult(line: string): boolean {
    const pathPart = line.split(":")[0] || "";
    return this.isFrameworkOrGeneratedPath(pathPart);
  }

  private isFrameworkOrGeneratedPath(relativePath: string): boolean {
    const lower = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
    if (
      lower.startsWith(".fvm/") ||
      lower.startsWith(".pub-cache/") ||
      lower.startsWith(".dart_tool/") ||
      lower.startsWith(".git/") ||
      lower.startsWith("node_modules/") ||
      lower.startsWith("vendor/") ||
      lower.startsWith("pods/") ||
      lower.startsWith("build/") ||
      lower.startsWith("dist/")
    ) {
      return true;
    }
    if (
      lower.startsWith("ios/flutter/") ||
      lower.startsWith("ios/pods/") ||
      lower.startsWith("android/.gradle/") ||
      lower.startsWith("android/.cxx/") ||
      lower.startsWith("android/build/") ||
      lower.startsWith("macos/flutter/") ||
      lower.startsWith("linux/flutter/") ||
      lower.startsWith("windows/flutter/")
    ) {
      return true;
    }
    return (
      lower.includes("/flutter_sdk/") ||
      lower.includes("/.pub-cache/") ||
      lower.includes("/ephemeral/")
    );
  }

  private evaluateListPatternGuard(pattern: string): string | undefined {
    if (this.taskExplicitlyAllowsFrameworkAccess()) {
      return undefined;
    }
    const lower = pattern.toLowerCase();
    const blockedHints = [
      ".fvm",
      ".pub-cache",
      "flutter_sdk",
      "ios/flutter",
      "ios/pods",
      "android/.gradle",
      "android/.cxx",
      "macos/flutter",
      "linux/flutter",
      "windows/flutter",
      "vendor",
      "node_modules"
    ];
    if (blockedHints.some((hint) => lower.includes(hint))) {
      return [
        "PathGuard: list_files pattern points to framework/dependency directories.",
        "Search project code first in lib/, src/, test/, integration_test/."
      ].join(" ");
    }
    return undefined;
  }

  private evaluatePathAccessGuard(relPath: string, mode: "read" | "write"): string | undefined {
    if (this.taskExplicitlyAllowsFrameworkAccess()) {
      return undefined;
    }
    if (!this.isFrameworkOrGeneratedPath(relPath)) {
      return undefined;
    }
    return [
      `PathGuard: blocked ${mode} on '${relPath}'.`,
      "This path is framework/dependency/generated area and usually off-scope.",
      "Focus on project files in lib/, src/, test/, integration_test/."
    ].join(" ");
  }

  private evaluateInvestigationRelevanceGuard(
    actionType: "list_files" | "search_code",
    rawTarget: string,
    investigationCount: number
  ): string | undefined {
    const scope = this.currentTaskScope;
    if (!scope || scope.scopeClass === "broad" || scope.allowRewrite) {
      return undefined;
    }
    if (scope.focusTerms.length === 0) {
      return undefined;
    }
    if (investigationCount < 2) {
      return undefined;
    }

    const target = rawTarget.trim().toLowerCase();
    if (!target) {
      return undefined;
    }
    if (this.pathMatchesFocusTerms(target, scope.focusTerms)) {
      return undefined;
    }

    if (actionType === "list_files" && this.isBroadListPattern(target)) {
      return [
        "ObjectiveGuard: broad list_files is off-focus now.",
        `Task focus: ${scope.focusTerms.join(", ")}.`,
        "List files using target-specific pattern or test folders related to requested screen/feature."
      ].join(" ");
    }

    if (scope.isTestTask) {
      if (/integration_test|(^|\/)test\/|(^|\/)spec\/|_test\.|\.test\./.test(target)) {
        return undefined;
      }
      if (investigationCount >= 3) {
        return [
          `ObjectiveGuard: ${actionType} target is drifting from test objective.`,
          `Task focus: ${scope.focusTerms.join(", ")}.`,
          "Search/list in related test files or focus module names only."
        ].join(" ");
      }
      return undefined;
    }

    if (investigationCount >= 3) {
      return [
        `ObjectiveGuard: ${actionType} target is not aligned with requested module.`,
        `Task focus: ${scope.focusTerms.join(", ")}.`,
        "Use focused path/query terms from user request."
      ].join(" ");
    }

    return undefined;
  }

  private evaluateReadRelevanceGuard(relPath: string, investigationCount: number): string | undefined {
    const scope = this.currentTaskScope;
    if (!scope || scope.scopeClass === "broad" || scope.allowRewrite) {
      return undefined;
    }
    if (scope.focusTerms.length === 0 || investigationCount < 2) {
      return undefined;
    }

    const lowerPath = relPath.toLowerCase();
    if (this.pathMatchesFocusTerms(lowerPath, scope.focusTerms)) {
      return undefined;
    }
    if (this.isContextBootstrapFile(lowerPath)) {
      return undefined;
    }

    if (scope.isTestTask) {
      const readsTestStructure =
        this.isLikelyTestFile(lowerPath) || lowerPath.startsWith("integration_test/") || lowerPath.startsWith("test/");
      if (readsTestStructure && investigationCount < 4) {
        return undefined;
      }
      return [
        `ObjectiveGuard: read_file '${relPath}' is drifting from requested test target.`,
        `Focus terms: ${scope.focusTerms.join(", ")}.`,
        "Read the closest source/test files matching target screen/feature."
      ].join(" ");
    }

    if (investigationCount >= 4) {
      return [
        `ObjectiveGuard: read_file '${relPath}' is outside current objective focus.`,
        `Focus terms: ${scope.focusTerms.join(", ")}.`,
        "Read files that directly match the requested module."
      ].join(" ");
    }

    return undefined;
  }

  private isContextBootstrapFile(relativePathLower: string): boolean {
    const fileName = path.posix.basename(relativePathLower);
    const bootstrapNames = new Set([
      "readme.md",
      "package.json",
      "tsconfig.json",
      "pubspec.yaml",
      "analysis_options.yaml",
      "pyproject.toml",
      "go.mod",
      "cargo.toml"
    ]);
    if (bootstrapNames.has(fileName)) {
      return true;
    }
    return (
      relativePathLower === "src/extension.ts" ||
      relativePathLower === "src/index.ts" ||
      relativePathLower.startsWith(".vscode/")
    );
  }

  private taskExplicitlyAllowsFrameworkAccess(): boolean {
    const text = this.currentTaskScope?.rawTask?.toLowerCase() ?? "";
    if (!text) {
      return false;
    }
    const signals = [
      "framework",
      "flutter sdk",
      "sdk",
      "vendor",
      "third-party",
      "third party",
      "generated",
      ".fvm",
      ".pub-cache",
      "ios/flutter",
      "android/.gradle"
    ];
    return signals.some((signal) => text.includes(signal));
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

    scored.sort((a, b) => b.score - a.score || this.comparePathPriority(a.file, b.file));
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

  private buildTaskScope(task: string): TaskScopeProfile {
    const primaryTask = this.extractPrimaryTaskText(task);
    const lower = primaryTask.toLowerCase();
    const isTestTask =
      /\bintegration\s+test\b/.test(lower) ||
      /\bunit\s+test\b/.test(lower) ||
      /\bwidget\s+test\b/.test(lower) ||
      /\be2e\b/.test(lower) ||
      /\btest\b/.test(lower) ||
      /\bspec\b/.test(lower);
    const allowRewrite =
      this.containsBroadRewriteLanguage(primaryTask) ||
      /\bfrom\s+scratch\b/.test(lower) ||
      /\bnew\s+architecture\b/.test(lower);
    const focusTerms = this.extractTaskFocusTerms(primaryTask, 8);
    const scopeClass = this.classifyScope(primaryTask, isTestTask, allowRewrite, focusTerms.length);
    const maxChangedFilesByScope: Record<ScopeClass, number> = {
      micro: 4,
      small: 7,
      medium: 14,
      broad: 200
    };

    let maxChangedFiles = maxChangedFilesByScope[scopeClass];
    if (isTestTask && scopeClass !== "broad") {
      maxChangedFiles = Math.min(maxChangedFiles, scopeClass === "micro" ? 4 : 6);
    }

    const focusLabel = focusTerms.length > 0 ? focusTerms.join(", ") : "explicit modules from the request";
    const primaryObjective = this.buildPrimaryObjective(primaryTask, isTestTask, focusTerms);
    const contract = [
      `- Primary objective: ${primaryObjective}`,
      `- Scope class: ${scopeClass}.`,
      `- Maximum changed files target: ${maxChangedFiles}.`,
      allowRewrite
        ? "- Broad refactor is explicitly allowed only if required by the request."
        : "- Do NOT rewrite architecture or refactor unrelated modules.",
      isTestTask
        ? "- Primary deliverable is test code. Prefer test directories and *test/*spec files."
        : "- Prefer minimal edits in existing files closest to the requested behavior.",
      `- Keep edits focused on: ${focusLabel}.`,
      "- If a proposed step is broad, shrink it to the smallest valid implementation."
    ];

    return {
      rawTask: primaryTask,
      scopeClass,
      isTestTask,
      allowRewrite,
      maxChangedFiles,
      focusTerms,
      primaryObjective,
      contract
    };
  }

  private buildPrimaryObjective(primaryTask: string, isTestTask: boolean, focusTerms: string[]): string {
    const focusLabel = focusTerms.length > 0 ? focusTerms.join(", ") : "requested target";
    if (isTestTask) {
      return `Write/update tests only for ${focusLabel}. Do not implement or refactor unrelated product features.`;
    }
    return `Implement exactly: ${primaryTask.trim()}. Keep changes limited to ${focusLabel}.`;
  }

  private extractPrimaryTaskText(task: string): string {
    const originalRequestMatch = task.match(/Original user request:\s*\n([\s\S]*)$/i);
    if (originalRequestMatch && originalRequestMatch[1].trim().length > 0) {
      return originalRequestMatch[1].trim();
    }

    const currentRequestMatch = task.match(
      /Current request:\s*\n([\s\S]*?)(?:\n\nExecution brief:|\n\nProject learning rules:|\n\nUnfinished run context:|\n\nOriginal user request:|$)/i
    );
    if (currentRequestMatch && currentRequestMatch[1].trim().length > 0) {
      return currentRequestMatch[1].trim();
    }

    return task.trim();
  }

  private classifyScope(
    task: string,
    isTestTask: boolean,
    allowRewrite: boolean,
    focusTermCount: number
  ): ScopeClass {
    const lower = task.toLowerCase();
    if (allowRewrite) {
      return "broad";
    }

    const broadSignals = [
      "entire project",
      "whole project",
      "rewrite all",
      "project-wide",
      "across all modules",
      "overhaul",
      "viet lai ca project"
    ];
    if (broadSignals.some((signal) => lower.includes(signal))) {
      return "broad";
    }

    if (/\brefactor\b/.test(lower) || /\bmigrate\b/.test(lower) || /\boptimiz/.test(lower)) {
      return "medium";
    }

    if (isTestTask) {
      return focusTermCount <= 1 ? "micro" : "small";
    }

    if (focusTermCount <= 1 && /\b(fix|bug|write|add|update|implement)\b/.test(lower)) {
      return "micro";
    }

    return "small";
  }

  private extractTaskFocusTerms(task: string, limit: number): string[] {
    const quoted = [...task.matchAll(/["'`]([^"'`]{2,})["'`]/g)].map((match) => match[1]);
    const rawTokens = task.split(/[^A-Za-z0-9_./-]+/g);
    const stopWords = new Set([
      "task",
      "write",
      "create",
      "update",
      "implement",
      "integration",
      "unit",
      "widget",
      "test",
      "tests",
      "spec",
      "screen",
      "page",
      "controller",
      "feature",
      "module",
      "project",
      "request",
      "continue",
      "resume",
      "tiep",
      "tuc",
      "lam",
      "cho",
      "va",
      "cac",
      "nhung"
    ]);

    const frequency = new Map<string, number>();
    for (const source of [...quoted, ...rawTokens]) {
      const parts = source.split(/[\/._-]+/g);
      for (const part of parts) {
        const token = part.trim().toLowerCase();
        if (token.length < 3 || stopWords.has(token) || /^\d+$/.test(token)) {
          continue;
        }
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
      }
    }

    return Array.from(frequency.entries())
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
      .slice(0, Math.max(1, limit))
      .map(([token]) => token);
  }

  private containsBroadRewriteLanguage(text: string): boolean {
    const lower = text.toLowerCase();
    const patterns = [
      /\brewrite\b/,
      /\bre-?architect/,
      /\boverhaul\b/,
      /\bfrom\s+scratch\b/,
      /\bfull\s+refactor\b/,
      /\bproject-wide\s+refactor\b/,
      /\brebuild\b/,
      /\bredesign\s+architecture\b/,
      /\breplace\s+the\s+whole\b/,
      /\bviet\s+lai\b/
    ];
    return patterns.some((pattern) => pattern.test(lower));
  }

  private enforcePlanScope(plan: ExecutionPlan, task: string, scope: TaskScopeProfile): ExecutionPlan {
    if (scope.scopeClass === "broad" || scope.allowRewrite) {
      return plan;
    }

    const stepLimit = scope.scopeClass === "micro" ? 6 : BROAD_SCOPE_STEP_LIMIT;
    const broadSteps = plan.steps.filter((step) =>
      this.containsBroadRewriteLanguage(`${step.title} ${step.details}`)
    );
    const tooManySteps = plan.steps.length > stepLimit;
    const suspiciousTestSteps =
      scope.isTestTask
        ? plan.steps.filter((step) => {
            const text = `${step.title} ${step.details}`.toLowerCase();
            if (/\btest\b|\bspec\b/.test(text)) {
              return false;
            }
            return (
              /\brefactor\b/.test(text) ||
              /\bmigrate\b/.test(text) ||
              /\bscaffold\b/.test(text) ||
              /\brewrite\b/.test(text) ||
              /\barchitecture\b/.test(text)
            );
          })
        : [];
    const focusCoverage =
      scope.focusTerms.length > 0
        ? plan.steps.filter((step) => this.pathMatchesFocusTerms(`${step.title} ${step.details}`, scope.focusTerms))
            .length
        : plan.steps.length;
    const lowFocusCoverage = scope.focusTerms.length > 0 && focusCoverage === 0 && plan.steps.length >= 2;

    if (!tooManySteps && broadSteps.length === 0 && suspiciousTestSteps.length === 0 && !lowFocusCoverage) {
      return plan;
    }

    const reasons: string[] = [];
    if (tooManySteps) {
      reasons.push(`step count ${plan.steps.length} exceeds scope limit ${stepLimit}`);
    }
    if (broadSteps.length > 0) {
      reasons.push(`broad rewrite wording in steps: ${broadSteps.map((step) => step.id).join(", ")}`);
    }
    if (suspiciousTestSteps.length > 0) {
      reasons.push(
        `test task drift detected in steps: ${suspiciousTestSteps.map((step) => step.id).join(", ")}`
      );
    }
    if (lowFocusCoverage) {
      reasons.push("none of the steps mention request focus terms");
    }

    const reasonText = reasons.join("; ");
    this.callbacks.onLog(`PlanScopeGuard: replacing planner output with scoped fallback (${reasonText}).`);
    return this.buildScopedFallbackPlan(task, scope, reasonText);
  }

  private buildScopedFallbackPlan(task: string, scope: TaskScopeProfile, reason: string): ExecutionPlan {
    const focusLabel = scope.focusTerms.length > 0 ? scope.focusTerms.join(", ") : "requested module/feature";
    const assumptions = [
      reason,
      "Apply minimal-change implementation and keep project structure intact."
    ].filter((item) => item.trim().length > 0);

    if (scope.isTestTask) {
      return {
        summary: "Scoped fallback plan for focused test implementation.",
        assumptions,
        steps: [
          {
            id: "S1",
            title: "Locate target module and existing test style",
            details: `Find files related to ${focusLabel} and inspect current testing patterns.`,
            status: "pending"
          },
          {
            id: "S2",
            title: "Create or update focused integration test",
            details:
              "Add test cases only for the requested scope, reusing existing naming and folder conventions.",
            status: "pending"
          },
          {
            id: "S3",
            title: "Cover realistic scenarios and edge cases",
            details: "Implement assertions for expected behavior and key failure/empty states.",
            status: "pending"
          },
          {
            id: "S4",
            title: "Run targeted verification",
            details: "Execute the most relevant test command and summarize changed files.",
            status: "pending"
          }
        ]
      };
    }

    return {
      summary: "Scoped fallback plan for minimal implementation.",
      assumptions,
      steps: [
        {
          id: "S1",
          title: "Locate exact affected files",
          details: `Discover files tied to ${focusLabel} and avoid unrelated modules.`,
          status: "pending"
        },
        {
          id: "S2",
          title: "Implement minimal code changes",
          details: "Edit only relevant files while preserving existing architecture and style.",
          status: "pending"
        },
        {
          id: "S3",
          title: "Run focused verification and summarize",
          details: "Run targeted tests/lint/typecheck and report what changed.",
          status: "pending"
        }
      ]
    };
  }

  private async evaluateWriteScopeGuard(
    relPath: string,
    existsBeforeWrite: boolean,
    content: string
  ): Promise<string | undefined> {
    const scope = this.currentTaskScope;
    if (!scope || scope.scopeClass === "broad" || scope.allowRewrite) {
      return undefined;
    }

    if (this.changedFiles.size >= scope.maxChangedFiles && !this.changedFiles.has(relPath)) {
      return `ScopeGuard: write blocked because changed file limit (${scope.maxChangedFiles}) is reached for this task scope.`;
    }

    const lowerPath = relPath.toLowerCase();
    const touchesFocus = this.pathMatchesFocusTerms(relPath, scope.focusTerms);
    const testFile = this.isLikelyTestFile(lowerPath);
    const globalFile = this.isGlobalProjectFile(lowerPath);

    if (scope.isTestTask) {
      if (!testFile) {
        return [
          `ScopeGuard: '${relPath}' is outside test-focused scope.`,
          "For test tasks, only write test/spec files and reuse existing source structure."
        ].join(" ");
      }

      const knownTestDirs = await this.getKnownTestDirectories();
      if (
        !touchesFocus &&
        knownTestDirs.length > 0 &&
        !knownTestDirs.some((dir) => this.isPathInsideDirectory(relPath, dir))
      ) {
        return [
          `ScopeGuard: '${relPath}' is outside current test directories (${knownTestDirs.slice(0, 5).join(", ")}).`,
          "Reuse existing test folder structure instead of creating a parallel one."
        ].join(" ");
      }

      const relatedTestFiles = await this.findRelatedExistingTestFiles(scope.focusTerms, 6);
      if (
        relatedTestFiles.length > 0 &&
        !relatedTestFiles.includes(relPath) &&
        !relatedTestFiles.some((candidate) => this.isSiblingPath(relPath, candidate))
      ) {
        if (!existsBeforeWrite) {
          return [
            `ReuseGuard: existing related test file(s) found: ${relatedTestFiles.join(", ")}.`,
            `Avoid creating unrelated new test file '${relPath}'. Update the closest existing test file first.`
          ].join(" ");
        }
        if (!touchesFocus) {
          return [
            `ObjectiveGuard: updating '${relPath}' is off-target for this test request.`,
            `Closest related test file(s): ${relatedTestFiles.join(", ")}.`,
            "Update the related test file instead of unrelated test areas."
          ].join(" ");
        }
      }

      const qualityBlock = this.evaluateTestContentQuality(relPath, content);
      if (qualityBlock) {
        return qualityBlock;
      }
    }

    if ((scope.scopeClass === "micro" || scope.scopeClass === "small") && globalFile && !touchesFocus) {
      return [
        `ScopeGuard: '${relPath}' looks project-wide and is off-scope for a narrow request.`,
        "Keep edits near the requested module unless user explicitly asks for global changes."
      ].join(" ");
    }

    if (!existsBeforeWrite && scope.scopeClass === "micro" && !testFile && !touchesFocus) {
      return [
        `ScopeGuard: creating new file '${relPath}' is likely off-scope for this micro task.`,
        "Reuse existing files or target-focused test files."
      ].join(" ");
    }

    return undefined;
  }

  private evaluateCommandScopeGuard(command: string): string | undefined {
    const scope = this.currentTaskScope;
    if (!scope || scope.scopeClass === "broad" || scope.allowRewrite) {
      return undefined;
    }

    const lower = command.toLowerCase();
    const scaffoldPatterns = [
      /\bnpm\s+init\b/,
      /\bnpx\s+create\b/,
      /\bpnpm\s+create\b/,
      /\byarn\s+create\b/,
      /\bflutter\s+create\b/,
      /\brails\s+new\b/,
      /\bcargo\s+new\b/,
      /\bgo\s+mod\s+init\b/,
      /\bgit\s+init\b/
    ];

    if (scaffoldPatterns.some((pattern) => pattern.test(lower))) {
      return "ScopeGuard: scaffold/init command blocked for narrow task scope.";
    }

    if ((scope.scopeClass === "micro" || scope.scopeClass === "small") && /\bcodemod\b|\bmigrate\b/.test(lower)) {
      return "ScopeGuard: broad migration command blocked for narrow task scope.";
    }

    return undefined;
  }

  private async getKnownTestDirectories(): Promise<string[]> {
    const files = await this.getWorkspaceFileIndex(WORKSPACE_INDEX_LIMIT);
    const dirs = new Set<string>();
    for (const file of files) {
      const lower = file.toLowerCase();
      if (!this.isLikelyTestFile(lower)) {
        continue;
      }
      const dir = path.posix.dirname(file);
      if (!dir || dir === ".") {
        continue;
      }
      dirs.add(dir);
    }
    return Array.from(dirs).sort((a, b) => a.localeCompare(b)).slice(0, 30);
  }

  private async findRelatedExistingTestFiles(focusTerms: string[], limit: number): Promise<string[]> {
    if (!Array.isArray(focusTerms) || focusTerms.length === 0) {
      return [];
    }
    const files = await this.getWorkspaceFileIndex(WORKSPACE_INDEX_LIMIT);
    return files
      .filter((file) => this.isLikelyTestFile(file.toLowerCase()) && this.pathMatchesFocusTerms(file, focusTerms))
      .slice(0, Math.max(1, limit));
  }

  private isPathInsideDirectory(relPath: string, directory: string): boolean {
    const normalizedPath = relPath.replace(/\\/g, "/").toLowerCase();
    const normalizedDir = directory.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!normalizedDir) {
      return false;
    }
    return normalizedPath === normalizedDir || normalizedPath.startsWith(`${normalizedDir}/`);
  }

  private isSiblingPath(relPath: string, candidate: string): boolean {
    const left = path.posix.dirname(relPath.toLowerCase());
    const right = path.posix.dirname(candidate.toLowerCase());
    return left === right;
  }

  private evaluateTestContentQuality(relPath: string, content: string): string | undefined {
    const lowerPath = relPath.toLowerCase();
    if (!this.isLikelyTestFile(lowerPath)) {
      return undefined;
    }

    const body = content.trim();
    if (body.length < 220) {
      return `QualityGuard: '${relPath}' test content is too short. Write a realistic integration test with full setup, actions, and assertions.`;
    }

    const caseCount = (body.match(/\b(test|it|testwidgets|describe)\s*\(/gi) ?? []).length;
    if (caseCount < 1) {
      return `QualityGuard: '${relPath}' has no detectable test case block (test/it/testWidgets/describe).`;
    }

    const assertionCount = (body.match(/\b(expect|assert|verify)\s*\(/gi) ?? []).length;
    if (assertionCount < 1) {
      return `QualityGuard: '${relPath}' has no assertions (expect/assert/verify).`;
    }

    return undefined;
  }

  private async validateChangedTestFilesQuality(): Promise<string | undefined> {
    const testFiles = Array.from(this.changedFiles.values()).filter((file) =>
      this.isLikelyTestFile(file.toLowerCase())
    );
    if (testFiles.length === 0) {
      return "QualityGuard: task is test-focused but no test file was changed.";
    }

    for (const relPath of testFiles) {
      try {
        const absPath = this.resolveWorkspacePath(relPath);
        const content = await fs.readFile(absPath, "utf8");
        const issue = this.evaluateTestContentQuality(relPath, content);
        if (issue) {
          return issue;
        }
      } catch {
        return `QualityGuard: unable to read changed test file '${relPath}' for validation.`;
      }
    }

    return undefined;
  }

  private pathMatchesFocusTerms(textOrPath: string, focusTerms: string[]): boolean {
    if (focusTerms.length === 0) {
      return false;
    }
    const lower = textOrPath.toLowerCase();
    return focusTerms.some((term) => term.length >= 3 && lower.includes(term.toLowerCase()));
  }

  private isLikelyTestFile(relativePathLower: string): boolean {
    return (
      /(^|\/)(test|tests|__tests__|integration_test|e2e)\//.test(relativePathLower) ||
      /\.(test|spec)\.[a-z0-9]+$/.test(relativePathLower) ||
      /_test\.[a-z0-9]+$/.test(relativePathLower)
    );
  }

  private isGlobalProjectFile(relativePathLower: string): boolean {
    const fileName = path.posix.basename(relativePathLower);
    const globalNames = new Set([
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "pubspec.yaml",
      "pubspec.lock",
      "tsconfig.json",
      "tsconfig.base.json",
      "analysis_options.yaml",
      "readme.md",
      "dockerfile",
      "docker-compose.yml",
      "docker-compose.yaml"
    ]);

    if (globalNames.has(fileName)) {
      return true;
    }
    if (relativePathLower.startsWith(".github/") || relativePathLower.startsWith(".vscode/")) {
      return true;
    }
    return /(^|\/)(vite|webpack|babel|eslint|prettier)\.config\.[a-z0-9]+$/.test(relativePathLower);
  }

  private parsePlan(raw: string, task: string, scopeProfile?: TaskScopeProfile): ExecutionPlan {
    const scope = scopeProfile ?? this.currentTaskScope ?? this.buildTaskScope(task);
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
        const fallback = this.buildScopedFallbackPlan(task, scope, "Planner returned no steps.");
        this.callbacks.onLog("PlanScopeGuard: planner returned empty steps. Using scoped fallback plan.");
        return fallback;
      }

      const parsedPlan: ExecutionPlan = {
        summary: toStringValue(parsed.summary, "Execution plan"),
        assumptions: asArray(parsed.assumptions),
        steps
      };
      return this.enforcePlanScope(parsedPlan, task, scope);
    } catch (error) {
      this.callbacks.onLog(`Plan parse failed, using fallback: ${(error as Error).message}`);
      return this.buildScopedFallbackPlan(task, scope, "Planner JSON parse failure.");
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
