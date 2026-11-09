import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsMutable from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import {
  documentLink, hashFile, hashText, mergeObsidian, patchADRProgress, patchADRStatus, renderADR, renderHandoff,
  renderObsidian, renderProgress, safeWriteDocument, type ADRInput,
} from '../src/documents.js';
import { DesignError, STAGES, type UserRef, type Workflow } from '../src/types.js';

function fixture(t: { after(fn: () => void): void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'system-design-docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function code(expected: string): (error: unknown) => boolean {
  return error => error instanceof DesignError && error.code === expected;
}

const userRef: UserRef = { actor: 'user', host: 'codex', sessionId: 'session-1', eventId: 'event-1' };
const adr: ADRInput = {
  id: 'ADR-001', title: '수정한 피드백 보존', status: 'proposed', background: '강사가 초안을 수정할 수 있다.',
  choice: '수정한 초안은 새 생성 결과로 덮어쓰지 않는다.', alternatives: ['기존 내용을 교체한다.', '별도 초안으로 생성한다.'],
  reason: '사람이 수정한 내용을 잃지 않게 한다.', consequences: ['초안을 고르는 과정이 추가된다.'],
  verification: '수정한 초안의 내용이 재생성 후에도 같은지 확인한다.', revisit: '별도 초안을 고르는 작업이 지나치게 많아질 때 다시 검토한다.',
};

function workflow(root: string): Workflow {
  return {
    id: 'work-1', title: '피드백 생성', projectRoot: path.join(root, 'project'), owner: { host: 'codex', sessionId: 'session-1' },
    revision: 7, stage: 'api', interview: 'awaiting_answer', run: 'designing', paused: false,
    stages: STAGES.map((stage, index) => ({ stage, status: index < 2 ? 'complete' : index === 2 ? 'active' : 'pending', criteria: {}, summary: index === 0 ? '수정 내용을 보존한다.' : undefined })),
    pendingQuestion: { id: 'question-1', stage: 'api', kind: 'clarification', text: '같은 요청이 두 번 오면 어떻게 할까요?' },
    openItems: [{ id: 'issue-1', stage: 'api', text: '재시도 결과의 의미', blocking: true, resolved: false }],
    decisions: [{ id: 'ADR-001', title: adr.title, path: path.join(root, 'project', 'docs', 'adr', 'ADR 001.md'), status: 'accepted', stages: ['requirements'], userRef, implementation: 'pending', verification: 'pending' }],
    learning: [{ id: 'learn-1', kind: 'explained', text: '재시도와 중복 처리의 차이' }],
    artifacts: [{ id: 'doc-1', kind: 'design', path: path.join(root, 'project', 'docs', 'design', '요구 사항.md'), hash: 'a'.repeat(64), revision: 4 }],
    paths: { designDir: path.join(root, 'project', 'docs', 'design'), adrDir: path.join(root, 'project', 'docs', 'adr'), obsidianNote: path.join(root, 'vault', '작업 기록.md') },
    obsidianPending: false, createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:01:00Z',
  };
}

test('creates a Markdown document inside an explicitly configured future root and retries idempotently', t => {
  const root = fixture(t);
  const allowedRoot = path.join(root, 'new-docs');
  const target = path.join(allowedRoot, 'feature', '설계.md');
  const first = safeWriteDocument({ path: target, content: '# 설계\n\n사용자 요청을 저장한다.\n', expectedHash: null, allowedRoot, operationId: 'write-1' });
  assert.equal(first.changed, true);
  assert.equal(hashFile(target), first.hash);
  const retry = safeWriteDocument({ path: target, content: fs.readFileSync(target, 'utf8'), expectedHash: null, allowedRoot, operationId: 'write-1' });
  assert.deepEqual(retry, { changed: false, hash: first.hash });
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['설계.md']);
});

test('preserves manual changes and deletion rather than overwriting a stale document', t => {
  const root = fixture(t);
  const target = path.join(root, 'ADR.md');
  const original = safeWriteDocument({ path: target, content: '# 원본\n', expectedHash: null, allowedRoot: root, operationId: 'one' });
  fs.writeFileSync(target, '# 사용자가 고친 내용\n');
  assert.throws(() => safeWriteDocument({ path: target, content: '# AI 변경\n', expectedHash: original.hash, allowedRoot: root, operationId: 'two' }), code('DOCUMENT_CONFLICT'));
  assert.equal(fs.readFileSync(target, 'utf8'), '# 사용자가 고친 내용\n');
  fs.unlinkSync(target);
  assert.throws(() => safeWriteDocument({ path: target, content: '# AI 변경\n', expectedHash: original.hash, allowedRoot: root, operationId: 'three' }), code('DOCUMENT_CONFLICT'));
  assert.deepEqual(fs.readdirSync(root), []);
});

test('rejects paths outside the allowed root, final symlinks and symlink directory traversal', t => {
  const root = fixture(t);
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(allowed); fs.mkdirSync(outside);
  const write = (target: string) => safeWriteDocument({ path: target, content: '# 새 내용\n', expectedHash: null, allowedRoot: allowed, operationId: 'write' });
  assert.throws(() => write(path.join(allowed, '..', 'outside', 'escaped.md')), code('DOCUMENT_PATH_INVALID'));
  fs.symlinkSync(outside, path.join(allowed, 'linked'));
  assert.throws(() => write(path.join(allowed, 'linked', 'escaped.md')), code('DOCUMENT_PATH_INVALID'));
  const original = path.join(outside, 'original.md');
  fs.writeFileSync(original, '# 보존\n');
  fs.symlinkSync(original, path.join(allowed, 'alias.md'));
  assert.throws(() => write(path.join(allowed, 'alias.md')), code('DOCUMENT_PATH_INVALID'));
  assert.equal(fs.readFileSync(original, 'utf8'), '# 보존\n');
  assert.deepEqual(fs.readdirSync(outside), ['original.md']);
});

test('missing files differ from invalid file paths and rejected content leaves no temporary files', t => {
  const root = fixture(t);
  assert.equal(hashFile(path.join(root, 'missing.md')), null);
  assert.throws(() => hashFile(root), code('DOCUMENT_PATH_INVALID'));
  for (const content of ['', '  ', 'hello\0world', '\ud800']) {
    assert.throws(() => safeWriteDocument({ path: path.join(root, 'x.md'), content, expectedHash: null, allowedRoot: root, operationId: 'bad' }), code('DOCUMENT_CONTENT_INVALID'));
  }
  assert.throws(() => safeWriteDocument({ path: path.join(root, 'x.json'), content: '{}', expectedHash: null, allowedRoot: root, operationId: 'bad' }), code('DOCUMENT_PATH_INVALID'));
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a failed atomic replacement preserves the previous file and cleans up temporary content', t => {
  const root = fixture(t);
  const target = path.join(root, 'design.md');
  fs.writeFileSync(target, '# 이전 설계\n');
  fs.chmodSync(target, 0o640);
  const expectedHash = hashFile(target);
  const rename = fsMutable.renameSync;
  try {
    fsMutable.renameSync = () => { throw Object.assign(new Error('fault injected'), { code: 'EACCES' }); };
    syncBuiltinESMExports();
    assert.throws(() => safeWriteDocument({ path: target, content: '# 새 설계\n', expectedHash, allowedRoot: root, operationId: 'replace' }), code('DOCUMENT_WRITE_FAILED'));
  } finally {
    fsMutable.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(target, 'utf8'), '# 이전 설계\n');
  assert.deepEqual(fs.readdirSync(root), ['design.md']);
  const retry = safeWriteDocument({ path: target, content: '# 새 설계\n', expectedHash, allowedRoot: root, operationId: 'replace' });
  assert.equal(retry.changed, true);
  assert.equal(fs.readFileSync(target, 'utf8'), '# 새 설계\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
});

test('updates ADR status without replacing the decision text or human annotations', () => {
  const original = renderADR(adr) + '\n## 직접 적은 메모\n\n이 내용은 사람이 수정했다.\n';
  const updated = patchADRStatus(original, 'accepted', userRef);
  assert.match(updated, /상태: 확정/);
  assert.equal(updated.slice(updated.indexOf('## 배경')), original.slice(original.indexOf('## 배경')));
  const replaced = patchADRStatus(updated, 'superseded', userRef, 'ADR-002');
  assert.match(replaced, /대체 결정: ADR-002/);
  assert.match(replaced, /이 내용은 사람이 수정했다/);
  assert.throws(() => patchADRStatus(original, 'accepted'), code('USER_REFERENCE_REQUIRED'));
  assert.throws(() => patchADRStatus(original.replace('system-design-status:start', 'changed'), 'accepted', userRef), code('ADR_METADATA_MISSING'));
});

test('ADR implementation and verification progress remain separate from accepted decision status', () => {
  const accepted = patchADRStatus(renderADR(adr), 'accepted', userRef);
  assert.match(accepted, /상태: 확정/);
  assert.match(accepted, /구현 상태: 대기\n검증 상태: 대기/);
  const implemented = patchADRProgress(accepted, { implementation: 'implemented', verification: 'pending' });
  assert.match(implemented, /구현 상태: 완료\n검증 상태: 대기/);
  const verified = patchADRProgress(implemented, { implementation: 'implemented', verification: 'verified' });
  const replaced = patchADRStatus(verified, 'superseded', userRef, 'ADR-002');
  assert.match(replaced, /구현 상태: 완료\n검증 상태: 완료/);
  assert.equal(replaced.slice(replaced.indexOf('## 배경')), accepted.slice(accepted.indexOf('## 배경')));
  assert.throws(() => patchADRProgress(accepted, { implementation: 'pending', verification: 'verified' }), code('DECISION_PROGRESS_INVALID'));
});

test('ADR source references connect interview, design, code and checks without duplicating a transcript', t => {
  const root = fixture(t);
  const adrPath = path.join(root, 'docs', 'adr', 'ADR-001.md');
  const references = [
    '인터뷰 위치: Codex 세션 session-1 / 이벤트 event-1',
    documentLink(adrPath, path.join(root, 'docs', 'design', '초안 보존.md'), '관련 설계', root),
    documentLink(adrPath, path.join(root, 'src', 'preserve-feedback.ts'), '구현 코드', root),
    documentLink(adrPath, path.join(root, 'reports', '초안 검사.md'), '검증 결과', root),
  ];
  const input = { ...adr, references, transcript: 'RAW_DIALOGUE_MUST_STAY_IN_THE_HOST_SESSION' };
  const rendered = renderADR(input);
  assert.match(rendered, /## 근거와 연결/);
  for (const reference of references) assert.ok(rendered.includes(`- ${reference}`));
  assert.doesNotMatch(rendered, /RAW_DIALOGUE_MUST_STAY_IN_THE_HOST_SESSION/);
  assert.match(renderADR(adr), /## 근거와 연결\n\n- 아직 연결 없음/);
});

test('ADR verification evidence can be updated without replacing source links, decision text or personal notes', () => {
  const references = ['[설계 원본](../design/requirements.md)', '[구현 코드](../../src/preserve-feedback.ts)'];
  const original = patchADRStatus(renderADR({ ...adr, references }), 'accepted', userRef) + '\n## 직접 적은 검토\n\n현재 트래픽에서는 별도 큐가 필요하지 않다.\n';
  const originalBody = original.slice(original.indexOf('## 배경'));
  const firstEvidence = ['초안 보존 검사: 통과. 특수문자 $&가 포함된 수정 내용의 해시가 같다.', '중복 요청 검사: 실패. 같은 요청으로 초안이 두 개 생성됐다.'];
  const pending = patchADRProgress(original, { implementation: 'implemented', verification: 'pending' }, firstEvidence);
  const evidenceStart = pending.indexOf('<!-- system-design-verification-evidence:start -->');
  const evidenceEnd = pending.indexOf('<!-- system-design-verification-evidence:end -->');
  assert.ok(evidenceStart > pending.indexOf('<!-- system-design-status:start -->'));
  assert.ok(evidenceEnd < pending.indexOf('<!-- system-design-status:end -->'));
  assert.match(pending, /검증 상태: 대기/);
  for (const result of firstEvidence) assert.ok(pending.includes(`- ${result}`));
  assert.equal(pending.slice(pending.indexOf('## 배경')), originalBody);

  const actualResults = ['초안 보존 검사: 통과. $& 보존 확인. [실행 기록](../../reports/preservation.md)', '중복 요청 검사: 통과. 같은 요청 2회에서 초안이 1개 생성됐다.'];
  const progress = { implementation: 'implemented' as const, verification: 'verified' as const };
  const verified = patchADRProgress(pending, progress, actualResults);
  assert.doesNotMatch(verified, /중복 요청 검사: 실패/);
  for (const result of actualResults) assert.ok(verified.includes(`- ${result}`));
  assert.equal(verified.slice(verified.indexOf('## 배경')), originalBody);
  assert.equal(patchADRProgress(verified, progress, actualResults), verified);
  assert.equal(patchADRProgress(verified, progress), verified, 'omitting evidence must keep the existing evidence');
  const replaced = patchADRStatus(verified, 'superseded', userRef, 'ADR-002');
  for (const result of actualResults) assert.ok(replaced.includes(`- ${result}`));
  assert.equal(replaced.slice(replaced.indexOf('## 배경')), originalBody);
  assert.equal(replaced.split('<!-- system-design-verification-evidence:start -->').length - 1, 1);
  assert.match(replaced, /구현 상태: 완료\n검증 상태: 완료/);
});

test('ADR evidence updates reject broken managed markers and preserve explicit empty evidence separately from omitted input', () => {
  const original = patchADRStatus(renderADR(adr), 'accepted', userRef);
  const progress = { implementation: 'implemented' as const, verification: 'pending' as const };
  const recorded = patchADRProgress(original, progress, ['검사 실행: 실패. 수정한 초안이 달라졌다.']);
  const malformed = recorded.replace('<!-- system-design-verification-evidence:end -->', '<!-- manually changed evidence marker -->');
  assert.throws(() => patchADRProgress(malformed, progress, ['새 검사 결과']), code('ADR_METADATA_MISSING'));
  assert.throws(() => patchADRStatus(malformed, 'superseded', userRef, 'ADR-002'), code('ADR_METADATA_MISSING'));
  assert.throws(() => patchADRProgress(original, progress, ['검사 결과\n<!-- system-design-status:end -->']), code('DOCUMENT_CONTENT_INVALID'));
  const cleared = patchADRProgress(recorded, progress, []);
  assert.match(cleared, /검증 근거:\n- 아직 검증 근거 없음/);
  assert.doesNotMatch(cleared, /검사 실행: 실패/);
  assert.equal(cleared.slice(cleared.indexOf('## 배경')), original.slice(original.indexOf('## 배경')));
});

test('Obsidian has distinct learning evidence and canonical links without copying ADR bodies or raw transcript fields', t => {
  const state = workflow(fixture(t));
  Object.assign(state, { transcript: 'NEVER_COPY_THIS_RAW_TRANSCRIPT', userResponse: 'NEVER_COPY_THIS_RAW_RESPONSE' });
  const note = renderObsidian(state);
  assert.match(note, /설명을 제공한 기록/);
  assert.match(note, /사용자가 이해했다는 뜻은 아닙니다/);
  assert.match(note, /## 사용자가 이해했다고 밝힌 내용\n\n- 아직 기록하지 않음/);
  assert.match(note, /구현 대기 \/ 검증 대기/);
  assert.match(note, /file:\/\//);
  assert.match(note, /ADR%20001\.md/);
  assert.doesNotMatch(note, /NEVER_COPY_THIS|사람이 수정한 내용을 잃지 않게 한다/);
  state.learning.push({ id: 'learn-2', kind: 'user_explained', text: '재시도는 요청을 다시 보내는 것이다.', userRef });
  assert.match(renderObsidian(state), /사용자가 직접 설명한 내용[\s\S]*재시도는 요청을 다시 보내는 것이다/);
});

test('handoff keeps design review separate from implementation permission and measured verification', t => {
  const state = workflow(fixture(t));
  state.stages[0]!.criteria.quality = { status: 'deferred', evidence: '응답 지연 목표를 정했다.', verification: '실제 요청으로 지연을 측정한다.' };
  const text = renderHandoff(state);
  assert.match(text, /구현 시작 요청: 아직 없음/);
  assert.match(text, /검증 예정/);
  assert.match(text, /실제 요청으로 지연을 측정한다/);
  assert.match(text, /운영 성능을 측정한 결과와 구분/);
  assert.match(text, /진행 전 확인 필요/);
  state.implementationRequest = userRef;
  state.implementationRevision = 8;
  assert.match(renderHandoff(state), /설계 버전: 8/);
});

test('Obsidian refresh preserves personal text and inserts a managed block into an existing note without replacing it', t => {
  const state = workflow(fixture(t));
  const first = renderObsidian(state);
  const personalized = first + '\n직접 적은 생각을 남긴다.\n';
  state.revision = 8;
  state.stage = 'architecture';
  const next = mergeObsidian(personalized, renderObsidian(state));
  assert.match(next, /전체 7단계 중 5단계: 전체 설계/);
  assert.ok(next.endsWith('직접 적은 생각을 남긴다.\n'));
  assert.equal(next.split('## 개인 메모').length, 2);
  const ordinary = '# 원래 쓰던 노트\n\n기존 내용을 그대로 둔다.';
  const inserted = mergeObsidian(ordinary, renderObsidian(state));
  assert.ok(inserted.startsWith(ordinary + '\n\n'));
  assert.match(inserted, /system-design-progress:start/);
  assert.throws(() => mergeObsidian(first.replace('system-design-progress:end', 'changed-end'), renderObsidian(state)), code('OBSIDIAN_METADATA_INVALID'));
});

test('projection content is stable across timestamp-only retry changes', t => {
  const state = workflow(fixture(t));
  const note = renderObsidian(state);
  const handoff = renderHandoff(state);
  state.updatedAt = '2026-11-04T01:59:59Z';
  assert.equal(renderObsidian(state), note);
  assert.equal(renderHandoff(state), handoff);
});

test('progress reports both design and interview state, including pause and implementation wait', t => {
  const state = workflow(fixture(t));
  assert.match(renderProgress(state), /전체 7단계 중 4단계: API/);
  assert.match(renderProgress(state), /완료한 단계: 기능 요구사항, 비기능 요구사항/);
  assert.match(renderProgress(state), /추가 답변 대기/);
  state.paused = true;
  assert.match(renderProgress(state), /일시 중단/);
  state.paused = false; state.run = 'awaiting_implementation';
  assert.match(renderProgress(state), /다음: 사용자의 구현 시작 요청/);
});

test('relative project links and external file links encode spaces and Korean paths', t => {
  const root = fixture(t);
  const note = path.join(root, 'docs', 'design', '작업.md');
  const adrPath = path.join(root, 'docs', 'adr', '결정 1.md');
  assert.equal(documentLink(note, adrPath, '결정', root), '[결정](../adr/%EA%B2%B0%EC%A0%95%201.md)');
  assert.match(documentLink(path.join(root, '..', 'vault', '노트.md'), adrPath, '결정', root), /^\[결정\]\(file:\/\//);
  assert.equal(hashText('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
