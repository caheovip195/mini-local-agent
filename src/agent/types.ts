export type StepStatus = "pending" | "in_progress" | "done" | "failed";

export interface PlanStep {
  id: string;
  title: string;
  details: string;
  status: StepStatus;
}

export interface ExecutionPlan {
  summary: string;
  assumptions: string[];
  steps: PlanStep[];
}

export interface AgentAction {
  type: string;
  [key: string]: unknown;
}

export interface AgentDecision {
  reasoning: string;
  action: AgentAction;
}

export interface AgentConfig {
  workspaceRoot: string;
  maxTurnsPerStep: number;
  maxAskUser: number;
  minInvestigationsBeforeExecute: number;
  strategyCandidates: number;
  commandTimeoutMs: number;
  autoApplyWrites: boolean;
  extraSystemPrompt: string;
}

export interface StepResult {
  done: boolean;
  summary: string;
  changedFiles: string[];
}

export type AgentActivityStatus = "planned" | "executed" | "blocked" | "recovery";

export interface AgentUsageEvent {
  phase: "planner" | "executor";
  stepId?: string;
  turn?: number;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentActionEvent {
  stepId: string;
  turn: number;
  actionType: string;
  status: AgentActivityStatus;
  detail: string;
}

export interface RunnerCallbacks {
  onLog: (message: string) => void;
  onStatus: (message: string) => void;
  onPlan: (plan: ExecutionPlan) => void;
  onStepStatus: (stepId: string, status: StepStatus) => void;
  onDone: (summary: string) => void;
  onUsage?: (event: AgentUsageEvent) => void;
  onAction?: (event: AgentActionEvent) => void;
  onQuestion?: (question: string) => Promise<string>;
}
