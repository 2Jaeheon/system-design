export const STAGES = ['requirements', 'non-functional', 'entities', 'api', 'architecture', 'deep-dive', 'evaluation'] as const;
export type Stage = typeof STAGES[number];
export const STAGE_LABELS: Record<Stage, string> = {
  requirements: '기능 요구사항', 'non-functional': '비기능 요구사항', entities: '핵심 객체', api: 'API', architecture: '전체 설계',
  'deep-dive': '상세 검토', evaluation: '설계 평가',
};
export type Host = 'codex' | 'claude';
export interface Owner { host: Host; sessionId: string }
export interface UserRef extends Owner { eventId: string; actor: 'user' }
export type InterviewStatus = 'awaiting_thought' | 'awaiting_answer' | 'explaining' | 'reviewing' | 'complete';
export type RunStatus = 'designing' | 'awaiting_implementation' | 'implementing' | 'verifying' | 'complete';
export interface Criterion { status: 'met' | 'deferred'; evidence: string; verification?: string }
export interface StageRecord {
  stage: Stage;
  status: 'pending' | 'active' | 'complete' | 'needs_review';
  thoughtRef?: UserRef;
  answerRefs?: UserRef[];
  criteria: Record<string, Criterion>;
  summary?: string;
  interpretationRevisions?: {previous:string;replacement:string;reason:string;userRef:UserRef;revision:number}[];
  artifactId?: string;
  checkpointRef?: UserRef;
  initialUserRef?: UserRef;
  initialBoundaryEventId?: string;
  topic?: string;
}
export interface Question { id: string; stage: Stage; kind: 'thought' | 'clarification'; text: string; afterEventId?: string }
export interface OpenItem { id: string; stage: Stage; text: string; blocking: boolean; resolved: boolean }
export interface Learning {
  id: string; kind: 'explained' | 'user_reported' | 'user_explained'; text: string;
  userRef?: UserRef;
}
export interface DecisionRef {
  id: string; title: string; path: string; status: 'proposed' | 'accepted' | 'superseded';
  stages: Stage[]; userRef?: UserRef; supersededBy?: string;
  implementation: 'pending' | 'implemented'; verification: 'pending' | 'verified';
  titleRevisions?: {previous:string;replacement:string;reason:string;revision:number}[];
}
export interface Artifact {
  id: string; kind: 'design' | 'adr' | 'obsidian' | 'handoff'; path: string;
  hash: string; revision: number;
}
export interface ProjectPaths { designDir: string; adrDir: string; obsidianNote: string }
export interface Workflow {
  id: string; title: string; projectRoot: string; owner: Owner; revision: number;
  stage: Stage; interview: InterviewStatus; run: RunStatus; paused: boolean;
  stages: StageRecord[]; pendingQuestion?: Question; openItems: OpenItem[];
  decisions: DecisionRef[]; learning: Learning[]; artifacts: Artifact[];
  paths: ProjectPaths; obsidianPending: boolean; obsidianError?: string;
  implementationRequest?: UserRef; implementationRevision?: number;
  readyAfterEventId?: string;
  implementationScope?: string; acceptance?: string[];
  checks?: { criterion: number; result: 'passed' | 'failed' | 'not_run'; evidence: string }[];
  createdAt: string; updatedAt: string;
}
export interface Settings {
  version: 1; obsidianVault: string; obsidianFolder: string;
  archiveEnabled: boolean; archiveConsent?: UserRef;
}
export interface MutationContext { workflowId: string; owner: Owner; expectedRevision: number; operationId: string }
export class DesignError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) { super(message); this.name = 'DesignError'; }
}
export function fail(code: string, message: string, details?: Record<string, unknown>): never { throw new DesignError(code, message, details); }
