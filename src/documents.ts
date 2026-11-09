import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DesignError, STAGES, STAGE_LABELS, type UserRef, type Workflow } from './types.js';

export interface WriteDocumentInput {
  path: string;
  content: string;
  expectedHash: string | null;
  allowedRoot: string;
  operationId: string;
}

export interface ADRInput {
  id: string;
  title: string;
  status: 'proposed' | 'accepted' | 'superseded';
  background: string;
  choice: string;
  alternatives: string[];
  reason: string;
  consequences: string[];
  /** Source locations for interview, design, code and checks, never raw dialogue. */
  references?: string[];
  verification: string;
  revisit: string;
  userRef?: UserRef;
  supersededBy?: string;
  implementation?: 'pending' | 'implemented';
  verificationStatus?: 'pending' | 'verified';
}

export interface ADRProgress { implementation: 'pending' | 'implemented'; verification: 'pending' | 'verified' }

const STATUS_START = '<!-- system-design-status:start -->';
const STATUS_END = '<!-- system-design-status:end -->';
const VERIFICATION_START = '<!-- system-design-verification-evidence:start -->';
const VERIFICATION_END = '<!-- system-design-verification-evidence:end -->';
export const OBSIDIAN_START = '<!-- system-design-progress:start -->';
export const OBSIDIAN_END = '<!-- system-design-progress:end -->';
const DECISION_LABELS = { proposed: '제안', accepted: '확정', superseded: '다른 결정으로 대체됨' } as const;
const RUN_LABELS = {
  designing: '설계 중', awaiting_implementation: '구현 시작 요청 대기', implementing: '구현 중',
  verifying: '검증 중', complete: '완료',
} as const;
const INTERVIEW_LABELS = {
  awaiting_thought: '사용자의 생각 대기', awaiting_answer: '추가 답변 대기', explaining: '쉬운 설명',
  reviewing: '설계 검토', complete: '단계 검토 완료',
} as const;

export function hashText(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

/** Missing files are distinct from unreadable files and directories. Never follow a final symlink. */
export function hashFile(filePath: string): string | null {
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new DesignError('DOCUMENT_PATH_INVALID', '일반 문서 파일만 읽을 수 있습니다.', { path: filePath });
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) throw new DesignError('DOCUMENT_PATH_INVALID', '일반 문서 파일만 읽을 수 있습니다.', { path: filePath });
    return createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    if (error instanceof DesignError) throw error;
    throw new DesignError('DOCUMENT_READ_FAILED', '문서 내용을 확인하지 못했습니다.', { path: filePath, cause: errorCode(error) ?? 'unknown' });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** Resolve existing ancestors without requiring the configured document folder to exist yet. */
function canonicalFuturePath(input: string): string {
  let existing = input;
  const absent: string[] = [];
  for (;;) {
    try {
      const stat = fs.lstatSync(existing);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new DesignError('DOCUMENT_PATH_INVALID', '문서 상위 위치는 폴더여야 합니다.', { path: existing });
      }
      const resolved = fs.realpathSync(existing);
      if (!fs.statSync(resolved).isDirectory()) {
        throw new DesignError('DOCUMENT_PATH_INVALID', '문서 상위 위치는 폴더여야 합니다.', { path: existing });
      }
      return path.join(resolved, ...absent.reverse());
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new DesignError('DOCUMENT_PATH_INVALID', '문서 상위 폴더를 찾지 못했습니다.');
      absent.push(path.basename(existing));
      existing = parent;
    }
  }
}

/** Explicit root aliases are resolved once. Symlinks below that root are never writable. */
function checkDocumentPath(filePath: string, allowedRoot: string, expectedCanonicalRoot?: string): { target: string; root: string; canonicalRoot: string } {
  if (!path.isAbsolute(filePath) || !path.isAbsolute(allowedRoot)) {
    throw new DesignError('DOCUMENT_PATH_INVALID', '문서 위치와 허용 폴더는 절대 경로여야 합니다.');
  }
  const root = path.resolve(allowedRoot);
  const target = path.resolve(filePath);
  if (!isWithin(root, target) || target === root || !['.md', '.markdown'].includes(path.extname(target).toLowerCase())) {
    throw new DesignError('DOCUMENT_PATH_INVALID', '허용된 폴더 안의 Markdown 문서만 저장할 수 있습니다.', { path: target });
  }
  const canonicalRoot = canonicalFuturePath(root);
  if (expectedCanonicalRoot !== undefined && canonicalRoot !== expectedCanonicalRoot) {
    throw new DesignError('DOCUMENT_PATH_INVALID', '저장 중 문서 폴더의 실제 위치가 바뀌었습니다.', { path: root });
  }
  const pieces = path.relative(root, target).split(path.sep);
  let current = root;
  for (let i = 0; i < pieces.length; i++) {
    current = path.join(current, pieces[i]!);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (i < pieces.length - 1 && !stat.isDirectory()) || (i === pieces.length - 1 && !stat.isFile())) {
        throw new DesignError('DOCUMENT_PATH_INVALID', '문서 경로에 연결 파일이나 잘못된 폴더가 있습니다.', { path: current });
      }
      const actual = fs.realpathSync(current);
      if (!isWithin(canonicalRoot, actual)) throw new DesignError('DOCUMENT_PATH_INVALID', '문서 경로가 허용 폴더를 벗어납니다.', { path: current });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      break;
    }
  }
  return { target, root, canonicalRoot };
}

function conflict(filePath: string, expected: string | null, actual: string | null): never {
  throw new DesignError('DOCUMENT_CONFLICT', '직접 수정된 내용을 보존했습니다. 변경의 의미를 확인한 뒤 다시 반영해야 합니다.', {
    path: filePath, expectedHash: expected, actualHash: actual,
  });
}

/**
 * Optimistic document update. State writers must serialize operations separately.
 * This detects ordinary editor conflicts, not a hostile concurrent filesystem writer.
 */
export function safeWriteDocument(input: WriteDocumentInput): { hash: string; changed: boolean } {
  if (typeof input.content !== 'string' || input.content.trim().length === 0 || input.content.includes('\0') || !input.content.isWellFormed()) {
    throw new DesignError('DOCUMENT_CONTENT_INVALID', '비어 있지 않은 올바른 UTF-8 Markdown 내용을 제공해야 합니다.');
  }
  if (!input.operationId || typeof input.operationId !== 'string') {
    throw new DesignError('DOCUMENT_OPERATION_INVALID', '문서 저장 작업 번호가 필요합니다.');
  }
  if (input.expectedHash !== null && !/^[a-f0-9]{64}$/.test(input.expectedHash)) {
    throw new DesignError('DOCUMENT_HASH_INVALID', '이전 문서 해시가 올바르지 않습니다.');
  }

  let tempPath: string | undefined;
  let fd: number | undefined;
  try {
    const checked = checkDocumentPath(input.path, input.allowedRoot);
    const desiredHash = hashText(input.content);
    const previousHash = hashFile(checked.target);
    if (previousHash === desiredHash) return { hash: desiredHash, changed: false };
    if (previousHash !== input.expectedHash) conflict(checked.target, input.expectedHash, previousHash);

    fs.mkdirSync(path.dirname(checked.target), { recursive: true, mode: 0o700 });
    checkDocumentPath(checked.target, checked.root, checked.canonicalRoot);
    tempPath = path.join(path.dirname(checked.target), `.${path.basename(checked.target)}.${hashText(input.operationId).slice(0, 12)}.${randomUUID()}.tmp`);
    fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, input.content, 'utf8');
    if (previousHash !== null) fs.fchmodSync(fd, fs.lstatSync(checked.target).mode & 0o777);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    checkDocumentPath(checked.target, checked.root, checked.canonicalRoot);
    const latestHash = hashFile(checked.target);
    if (latestHash === desiredHash) return { hash: desiredHash, changed: false };
    if (latestHash !== input.expectedHash) conflict(checked.target, input.expectedHash, latestHash);
    fs.renameSync(tempPath, checked.target);
    tempPath = undefined;
    let dirFd: number | undefined;
    try {
      dirFd = fs.openSync(path.dirname(checked.target), fs.constants.O_RDONLY);
      fs.fsyncSync(dirFd);
    } finally {
      if (dirFd !== undefined) fs.closeSync(dirFd);
    }
    return { hash: desiredHash, changed: true };
  } catch (error) {
    if (error instanceof DesignError) throw error;
    throw new DesignError('DOCUMENT_WRITE_FAILED', '문서를 저장하지 못했습니다. 기존 기록을 확인한 뒤 같은 작업을 재시도할 수 있습니다.', {
      path: input.path, cause: errorCode(error) ?? 'unknown',
    });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (tempPath !== undefined) {
      try { fs.unlinkSync(tempPath); } catch (error) { if (errorCode(error) !== 'ENOENT') { /* The original write error remains authoritative. */ } }
    }
  }
}

function inline(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}\[\]<>])/g, '\\$1');
}

function nonempty(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !value.isWellFormed()) {
    throw new DesignError('DOCUMENT_CONTENT_INVALID', `${name} 내용을 적어야 합니다.`);
  }
  return value.trim();
}

function bullets(values: string[], fallback = '아직 기록하지 않음'): string {
  return values.length ? values.map(value => `- ${value.trim().replace(/\n/g, '\n  ')}`).join('\n') : `- ${fallback}`;
}

function referenceItems(values: string[], name: string): string[] {
  if (!Array.isArray(values)) throw new DesignError('DOCUMENT_CONTENT_INVALID', `${name} 항목은 문자열 목록이어야 합니다.`);
  return values.map(value => {
    const item = nonempty(value, name);
    if ([STATUS_START, STATUS_END, VERIFICATION_START, VERIFICATION_END].some(marker => item.includes(marker))) {
      throw new DesignError('DOCUMENT_CONTENT_INVALID', `${name} 항목에 문서 관리 표시를 넣을 수 없습니다.`);
    }
    return item;
  });
}

function userReference(ref?: UserRef): string {
  if (!ref) return '아직 없음';
  if (ref.actor !== 'user' || !ref.eventId || !ref.sessionId || !['codex', 'claude'].includes(ref.host)) {
    throw new DesignError('USER_REFERENCE_INVALID', '사용자 발화 위치를 가리키는 근거가 필요합니다.');
  }
  return `${ref.host === 'codex' ? 'Codex' : 'Claude Code'} 세션 ${inline(ref.sessionId)} / 이벤트 ${inline(ref.eventId)}`;
}

function validateADRProgress(progress: ADRProgress): void {
  if (!['pending', 'implemented'].includes(progress.implementation) || !['pending', 'verified'].includes(progress.verification) || (progress.verification === 'verified' && progress.implementation !== 'implemented')) {
    throw new DesignError('DECISION_PROGRESS_INVALID', '구현과 검증 상태를 확인해야 합니다. 구현 전에는 검증 완료로 표시할 수 없습니다.');
  }
}

function decisionStatus(status: ADRInput['status'], userRef?: UserRef, supersededBy?: string, progress: ADRProgress = { implementation: 'pending', verification: 'pending' }): string {
  if (!Object.hasOwn(DECISION_LABELS, status)) throw new DesignError('DECISION_STATUS_INVALID', '결정 상태가 올바르지 않습니다.');
  if (status !== 'proposed' && !userRef) throw new DesignError('USER_REFERENCE_REQUIRED', '확정한 결정에는 사용자 발화 근거가 필요합니다.');
  if (status === 'superseded' && !supersededBy) throw new DesignError('SUPERSEDING_DECISION_REQUIRED', '대체한 결정 번호가 필요합니다.');
  validateADRProgress(progress);
  return [
    STATUS_START,
    `상태: ${DECISION_LABELS[status]}`,
    `사용자 결정 근거: ${userReference(userRef)}`,
    `대체 결정: ${supersededBy ? inline(supersededBy) : '없음'}`,
    `구현 상태: ${progress.implementation === 'implemented' ? '완료' : '대기'}`,
    `검증 상태: ${progress.verification === 'verified' ? '완료' : '대기'}`,
    STATUS_END,
  ].join('\n');
}

export function renderADR(input: ADRInput): string {
  return [
    `# ${inline(nonempty(input.id, '결정 번호'))}: ${inline(nonempty(input.title, '제목'))}`,
    '', decisionStatus(input.status, input.userRef, input.supersededBy, { implementation: input.implementation ?? 'pending', verification: input.verificationStatus ?? 'pending' }), '',
    '## 배경', '', nonempty(input.background, '배경'), '',
    '## 결정', '', nonempty(input.choice, '결정'), '',
    '## 비교한 대안', '', bullets(input.alternatives), '',
    '## 선택한 이유', '', nonempty(input.reason, '선택 이유'), '',
    '## 영향과 감수하는 점', '', bullets(input.consequences), '',
    '## 근거와 연결', '', bullets(referenceItems(input.references ?? [], '근거와 연결'), '아직 연결 없음'), '',
    '## 검증 방법', '', nonempty(input.verification, '검증 방법'), '',
    '## 다시 검토할 조건', '', nonempty(input.revisit, '재검토 조건'), '',
    '이 문서의 결정 상태는 구현 완료나 검증 완료를 뜻하지 않습니다.', '',
  ].join('\n');
}

export function patchADRStatus(content: string, status: ADRInput['status'], userRef?: UserRef, supersededBy?: string): string {
  const { start, end } = adrBounds(content);
  const block = content.slice(start, end);
  const progress: ADRProgress = {
    implementation: /^구현 상태: 완료$/m.test(block) ? 'implemented' : 'pending',
    verification: /^검증 상태: 완료$/m.test(block) ? 'verified' : 'pending',
  };
  const evidence = verificationBounds(block);
  const next = decisionStatus(status, userRef, supersededBy, progress);
  const updated = evidence ? next.replace(STATUS_END, () => block.slice(evidence.start, evidence.end) + '\n' + STATUS_END) : next;
  return content.slice(0, start) + updated + content.slice(end);
}

function adrBounds(content: string): { start: number; end: number } {
  const start = content.indexOf(STATUS_START);
  const end = content.indexOf(STATUS_END);
  if (start === -1 || end < start || content.indexOf(STATUS_START, start + STATUS_START.length) !== -1 || content.indexOf(STATUS_END, end + STATUS_END.length) !== -1) {
    throw new DesignError('ADR_METADATA_MISSING', 'ADR의 상태 영역이 변경되었습니다. 문서를 확인한 뒤 다시 반영해야 합니다.');
  }
  return { start, end: end + STATUS_END.length };
}

function verificationBounds(block: string): { start: number; end: number } | null {
  const start = block.indexOf(VERIFICATION_START);
  const end = block.indexOf(VERIFICATION_END);
  if (start === -1 && end === -1) return null;
  if (start === -1 || end < start || block.indexOf(VERIFICATION_START, start + VERIFICATION_START.length) !== -1 || block.indexOf(VERIFICATION_END, end + VERIFICATION_END.length) !== -1) {
    throw new DesignError('ADR_METADATA_MISSING', 'ADR의 검증 근거 영역이 변경되었습니다. 문서를 확인해야 합니다.');
  }
  return { start, end: end + VERIFICATION_END.length };
}

export function patchADRProgress(content: string, progress: ADRProgress, evidence?: string[]): string {
  validateADRProgress(progress);
  const { start, end } = adrBounds(content);
  let block = content.slice(start, end);
  verificationBounds(block);
  for (const [label, value] of [
    ['구현 상태', progress.implementation === 'implemented' ? '완료' : '대기'],
    ['검증 상태', progress.verification === 'verified' ? '완료' : '대기'],
  ]) {
    const pattern = new RegExp(`^${label}:.*$`, 'gm');
    const matches = block.match(pattern) ?? [];
    if (matches.length > 1) throw new DesignError('ADR_METADATA_MISSING', 'ADR 상태 항목이 중복되었습니다. 문서를 확인해야 합니다.');
    block = matches.length ? block.replace(pattern, `${label}: ${value}`) : block.replace(STATUS_END, `${label}: ${value}\n${STATUS_END}`);
  }
  if (evidence !== undefined) {
    const generated = [VERIFICATION_START, '검증 근거:', bullets(referenceItems(evidence, '검증 근거'), '아직 검증 근거 없음'), VERIFICATION_END].join('\n');
    const previous = verificationBounds(block);
    block = previous ? block.slice(0, previous.start) + generated + block.slice(previous.end) : block.replace(STATUS_END, () => generated + '\n' + STATUS_END);
  }
  return content.slice(0, start) + block + content.slice(end);
}

/** Relative links inside a project; external canonical documents use encoded file URLs. */
export function documentLink(fromPath: string, targetPath: string, label: string, projectRoot?: string): string {
  const target = path.resolve(targetPath);
  const from = path.resolve(fromPath);
  const href = projectRoot && isWithin(path.resolve(projectRoot), from) && isWithin(path.resolve(projectRoot), target)
    ? path.relative(path.dirname(from), target).split(path.sep).map(encodeURIComponent).join('/')
    : pathToFileURL(target).href;
  return `[${inline(label)}](${href})`;
}

export function renderProgress(workflow: Workflow): string {
  const completed = workflow.stages.filter(stage => stage.status === 'complete').map(stage => STAGE_LABELS[stage.stage]);
  const currentIndex = workflow.stages.findIndex(s => s.stage === workflow.stage);
  const nextStage = workflow.stages[currentIndex + 1]?.stage;
  const next = workflow.run === 'awaiting_implementation' ? '사용자의 구현 시작 요청'
    : workflow.run === 'implementing' ? '확정한 범위의 구현과 검증'
    : workflow.run === 'verifying' ? '완료 조건 확인'
    : workflow.run === 'complete' ? '완료'
    : nextStage ? STAGE_LABELS[nextStage] : '설계 평가 후 구현 요청 대기';
  return [
    `전체 ${workflow.stages.length}단계 중 ${currentIndex + 1}단계: ${STAGE_LABELS[workflow.stage]}`,
    `완료한 단계: ${completed.length ? completed.join(', ') : '없음'}`,
    `현재 진행: ${workflow.paused ? '일시 중단' : RUN_LABELS[workflow.run]} / ${INTERVIEW_LABELS[workflow.interview]}`,
    `이번에 검토하는 것: ${workflow.pendingQuestion ? inline(workflow.pendingQuestion.text) : '현재 단계의 결과와 남은 판단'}`,
    `다음: ${next}`,
  ].join('\n');
}

export function renderObsidian(workflow: Workflow): string {
  const notePath = workflow.paths.obsidianNote;
  const stageSummaries = workflow.stages.filter(stage => stage.summary).map(stage => `${STAGE_LABELS[stage.stage]}: ${stage.summary}`);
  const unresolved = workflow.openItems.filter(item => !item.resolved).map(item => `[${STAGE_LABELS[item.stage]}${item.blocking ? ', 진행 전 확인 필요' : ''}] ${item.text}`);
  if (workflow.pendingQuestion) unresolved.unshift(`[현재 질문] ${workflow.pendingQuestion.text}`);
  const decisions = workflow.decisions.map(decision =>
    `${documentLink(notePath, decision.path, `${decision.id}: ${decision.title}`, workflow.projectRoot)} / ${DECISION_LABELS[decision.status]} / 구현 ${decision.implementation === 'implemented' ? '완료' : '대기'} / 검증 ${decision.verification === 'verified' ? '완료' : '대기'}`);
  const designs = workflow.artifacts.filter(artifact => artifact.kind === 'design' || artifact.kind === 'handoff')
    .map(artifact => documentLink(notePath, artifact.path, artifact.kind === 'handoff' ? '구현 인계 문서' : path.basename(artifact.path), workflow.projectRoot));
  const learning = (kind: Workflow['learning'][number]['kind']) => workflow.learning.filter(item => item.kind === kind)
    .map(item => item.text + (item.userRef ? ` (대화 위치: ${userReference(item.userRef)})` : ''));
  return [
    OBSIDIAN_START,
    `# ${inline(workflow.title)}`, '',
    `작업 번호: ${inline(workflow.id)}`, `기록 기준 버전: ${workflow.revision}`, '',
    '## 진행 상황', '', renderProgress(workflow), '',
    '## 단계별 정리', '', bullets(stageSummaries), '',
    '## 설계 결정', '', bullets(decisions, '아직 기록된 결정 없음'), '',
    '## 설명받은 내용', '',
    '아래는 설명을 제공한 기록입니다. 사용자가 이해했다는 뜻은 아닙니다.', '', bullets(learning('explained')), '',
    '## 사용자가 이해했다고 밝힌 내용', '', bullets(learning('user_reported')), '',
    '## 사용자가 직접 설명한 내용', '', bullets(learning('user_explained')), '',
    '## 남은 질문', '', bullets(unresolved, '현재 남은 질문 없음'), '',
    '## 프로젝트 원본', '', bullets(designs, '아직 저장한 설계 문서 없음'), '',
    '대화 원문과 ADR 전문은 이 기록에 복제하지 않습니다. 대화 위치 참조는 원문을 별도로 보관했다는 뜻이 아닙니다.',
    OBSIDIAN_END, '',
    '## 개인 메모', '',
    '이 영역은 직접 작성한 내용을 유지합니다.', '',
  ].join('\n');
}

function managedBounds(content: string): { start: number; end: number } | null {
  const start = content.indexOf(OBSIDIAN_START);
  const end = content.indexOf(OBSIDIAN_END);
  if (start === -1 && end === -1) return null;
  if (start === -1 || end < start || content.indexOf(OBSIDIAN_START, start + OBSIDIAN_START.length) !== -1 || content.indexOf(OBSIDIAN_END, end + OBSIDIAN_END.length) !== -1) {
    throw new DesignError('OBSIDIAN_METADATA_INVALID', '진행 기록 영역이 변경되었습니다. 기존 문서를 확인해야 합니다.');
  }
  return { start, end: end + OBSIDIAN_END.length };
}

/**
 * Merge only the generated area. The caller must still check the full-file hash
 * and confirm changed meaning before writing a manually edited managed area.
 */
export function mergeObsidian(existing: string | null, generated: string): string {
  const generatedBounds = managedBounds(generated);
  if (!generatedBounds) throw new DesignError('OBSIDIAN_METADATA_INVALID', '새 진행 기록에 관리 영역이 없습니다.');
  if (existing === null) return generated;
  const newBlock = generated.slice(generatedBounds.start, generatedBounds.end);
  const existingBounds = managedBounds(existing);
  if (!existingBounds) return existing + (existing.endsWith('\n') ? '\n' : '\n\n') + newBlock + '\n';
  return existing.slice(0, existingBounds.start) + newBlock + existing.slice(existingBounds.end);
}

export function renderHandoff(workflow: Workflow): string {
  const handoffPath = path.join(workflow.paths.designDir, workflow.id, 'handoff.md');
  const documents = workflow.artifacts.filter(artifact => artifact.kind === 'design')
    .map(artifact => `${documentLink(handoffPath, artifact.path, path.basename(artifact.path), workflow.projectRoot)} / 문서 해시 ${artifact.hash}`);
  const decisions = workflow.decisions.filter(decision => decision.status === 'accepted')
    .map(decision => `${documentLink(handoffPath, decision.path, `${decision.id}: ${decision.title}`, workflow.projectRoot)} / 근거 ${userReference(decision.userRef)}`);
  const checks = workflow.stages.flatMap(stage => Object.entries(stage.criteria).map(([key, criterion]) =>
    `[${STAGE_LABELS[stage.stage]} / ${key}] ${criterion.status === 'deferred' ? '검증 예정' : '설계 검토 근거'}: ${criterion.evidence}${criterion.verification ? `\n검증 방법: ${criterion.verification}` : ''}`));
  return [
    `# ${inline(workflow.title)} 구현 인계`, '',
    `작업 번호: ${inline(workflow.id)}`, `설계 버전: ${workflow.implementationRevision ?? workflow.revision}`, '',
    `구현 시작 요청: ${workflow.implementationRequest ? userReference(workflow.implementationRequest) : '아직 없음'}`, '',
    '설계가 정리된 것과 구현이 시작된 것은 다릅니다. 사용자의 구현 시작 요청과 확정한 범위를 따라 진행합니다.', '',
    '## 확정한 설계', '', bullets(documents, '저장된 설계 문서 없음'), '',
    '## 확정한 결정', '', bullets(decisions, '확정한 ADR 없음'), '',
    '## 단계별 판단과 구현 범위', '', bullets(workflow.stages.filter(stage => stage.summary).map(stage => `${STAGE_LABELS[stage.stage]}: ${stage.summary}`)), '',
    '## 완료 조건과 검증', '', bullets(checks), '',
    '계산과 예상은 운영 성능을 측정한 결과와 구분합니다. 검증 예정 항목은 구현 후 실제 결과를 확인해야 합니다.', '',
    '## 남은 질문과 한계', '', bullets(workflow.openItems.filter(item => !item.resolved).map(item => `${item.blocking ? '[진행 전 확인 필요] ' : ''}${item.text}`), '현재 남은 질문 없음'), '',
    '새 설계 판단이 필요하면 해당 단계로 돌아가 질문하고, 영향을 받는 설계와 검증 조건을 다시 확인합니다.', '',
  ].join('\n');
}
