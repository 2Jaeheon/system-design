import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsNative from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { Engine, CRITERIA } from '../src/engine.js';
import { Store, digest } from '../src/store.js';
import { hashFile, patchADRStatus } from '../src/documents.js';
import { DocumentBatch, recoverDocuments } from '../src/document-batch.js';
import { DesignError, STAGES, type Criterion, type Owner, type Stage, type UserRef, type Workflow } from '../src/types.js';

type View = { workflow: Workflow; replayed?: boolean };
type Fixture = ReturnType<typeof createFixture>;

function hasCode(expected: string): (error: unknown) => boolean {
  return error => error instanceof DesignError && error.code === expected;
}

function filesIn(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesIn(path.join(root, entry.name)) : [path.join(root, entry.name)]);
}

function createFixture(t: { after(fn: () => void): void }, options: { existingNote?: string; initialThought?: string; preStartReply?: string; firstQuestion?: string; omitInitialRef?: boolean } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'system-design-engine-'));
  const project = path.join(base, 'project');
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  if (options.existingNote !== undefined) {
    fs.mkdirSync(path.join(vault, 'progress'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'progress/feedback.md'), options.existingNote);
  }
  const store = new Store(path.join(base, 'private-state'));
  const engine = new Engine(store);
  let activeOwner: Owner = { host: 'codex', sessionId: 'session-codex' };
  let eventCount = 0;
  let operationCount = 0;
  const event = (prompt = '새 사용자 답변', eventOwner = activeOwner): UserRef => store.recordUserEvent(eventOwner.host, eventOwner.sessionId, `event-${++eventCount}`, digest(prompt));
  const initialRef=options.initialThought===undefined?undefined:event(options.initialThought);
  if(options.preStartReply!==undefined)event(options.preStartReply);
  engine.execute('setup', { owner: activeOwner, obsidianVault: vault, obsidianFolder: 'progress', archiveEnabled: false });
  const view = engine.execute('start', { owner: activeOwner, title: '수정한 피드백 보존', projectRoot: project, designDir: 'docs/system-design', adrDir: 'docs/adr', obsidianNote: 'progress/feedback.md',
    ...(initialRef&&!options.omitInitialRef?{initialUserRef:initialRef}:{}),...(options.firstQuestion?{firstQuestion:options.firstQuestion}:{}) }) as View;
  const id = view.workflow.id;
  t.after(() => { store.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const get = () => store.get(id);
  const input = (args: Record<string, unknown> = {}) => ({ workflowId: id, owner: activeOwner, expectedRevision: get().revision, operationId: `operation-${++operationCount}`, ...args });
  const mutate = (command: string, args: Record<string, unknown> = {}) => engine.execute(command, input(args)) as View;
  return { base, project, vault, store, engine, id, event, get, input, mutate, initialRef, setOwner: (next: Owner) => { activeOwner = next; }, owner: () => activeOwner };
}

function criteria(stage: Stage): Record<string, Criterion> {
  return Object.fromEntries(CRITERIA[stage].map(key => [key, { status: 'met' as const, evidence: `${stage}/${key}: 저장된 설계에서 사용자 동작과 선택 이유를 검토했다.` }]));
}

function answer(f: Fixture, interpretation = '수정된 피드백은 보존하고 새 결과를 별도 초안으로 제공한다.', suppliedRef?: UserRef): UserRef {
  const question = f.get().pendingQuestion;
  assert.ok(question, 'fixture should be answering an actual pending question');
  const ref = suppliedRef ?? f.event('내 생각은 수정한 피드백을 그대로 두는 것이다.');
  f.mutate('answer', { questionId: question.id, userRef: ref, interpretation });
  return ref;
}

function prepareStage(f: Fixture): void {
  if (f.get().pendingQuestion) answer(f);
  const stage = f.get().stage;
  f.mutate('design', { content: `# ${stage}\n\n수정한 피드백을 보존한다. 재생성 결과는 별도 초안으로 제공한다.\n` });
  f.mutate('review', { criteria: criteria(stage), summary: `${stage}에서 요청과 결과, 실패 시 동작을 검토했다.` });
}

function finishDesign(f: Fixture): UserRef {
  let lastRef: UserRef | undefined;
  for (const expected of STAGES) {
    assert.equal(f.get().stage, expected);
    lastRef = answer(f);
    prepareStage(f);
    f.mutate('advance');
  }
  return lastRef!;
}

function propose(f: Fixture, overrides: Record<string, unknown> = {}): string {
  const out = f.mutate('decision-propose', {
    title: '사람이 수정한 초안 보존', background: '강사가 피드백을 수정할 수 있다.',
    choice: '기존 내용을 보존하고 별도 초안으로 생성한다.', alternatives: ['기존 내용을 덮어쓴다.', '새 초안을 만든다.'],
    reason: '수정한 내용을 잃지 않게 한다.', consequences: ['초안 선택이 필요하다.'],
    verification: '재생성 후 기존 수정 내용이 유지되는지 검사한다.', revisit: '초안 선택 비용이 커질 때 다시 검토한다.',
    stages: [f.get().stage],
    ...overrides,
  });
  return out.workflow.decisions.at(-1)!.id;
}

function finishDesignWithDecisions(f: Fixture, count: number): string[] {
  answer(f);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = propose(f, { title: `사람이 수정한 초안 보존 ${i + 1}` });
    f.mutate('decision-accept', { decisionId: id, userRef: f.event(`초안 보존 결정 ${i + 1}을 확정한다.`) });
    ids.push(id);
  }
  for (const stage of STAGES) {
    assert.equal(f.get().stage, stage);
    prepareStage(f);
    f.mutate('advance');
  }
  f.mutate('implement', { userRef: f.event('확정한 초안 보존 기능을 구현해줘.'), scope: '초안 보존', acceptance: ['수정한 초안을 보존한다.'] });
  return ids;
}

function recoverInFreshStore(f: Fixture): void {
  const resumed = new Store(f.store.dir);
  try { recoverDocuments(resumed); } finally { resumed.close(); }
}

test('a real initial design request can be saved without a repeated answer', t => {
  const f=createFixture(t,{initialThought:'사용자가 수정한 피드백을 보존하고 싶다.',preStartReply:'원문은 추가 보관하지 않는다.',firstQuestion:'재생성 결과는 어디에 보여줄까요?'});
  assert.equal(f.get().pendingQuestion?.text,'재생성 결과는 어디에 보여줄까요?');
  const ref=f.initialRef!;
  f.mutate('checkpoint',{topic:'기존 피드백 보존',userRefs:[ref],interpretation:'사용자가 수정한 피드백을 보존한다.',content:'# 기존 피드백 보존\n수정한 내용을 보존한다.',nextQuestion:'재생성 결과는 어디에 보여줄까요?'});
  assert.deepEqual(f.get().stages[0]?.thoughtRef,ref);
  assert.deepEqual(f.get().stages[0]?.answerRefs,[ref]);
  assert.equal(f.get().pendingQuestion?.text,'재생성 결과는 어디에 보여줄까요?');
  assert.throws(()=>f.mutate('checkpoint',{topic:'중복',userRefs:[ref],interpretation:'중복',content:'# 중복'}),hasCode('NEW_ANSWER_REQUIRED'));
});

test('initial evidence cannot hide newer turns or use an unregistered prior event', t => {
  const f=createFixture(t,{initialThought:'기존 초안을 보존하고 싶다.'});
  const latest=f.event('기존 초안은 남기고 새 결과를 별도로 저장한다.');
  const save={topic:'초안',interpretation:'기존 초안을 보존하고 새 결과를 별도로 저장한다.',content:'# 초안'};
  assert.throws(()=>f.mutate('checkpoint',{...save,userRefs:[f.initialRef!]}),hasCode('STALE_USER_ANSWER'));
  f.mutate('checkpoint',{...save,userRefs:[f.initialRef!,latest]});
  assert.deepEqual(f.get().stages[0]?.answerRefs,[f.initialRef,latest]);
  const other=createFixture(t,{initialThought:'이전 발화',omitInitialRef:true});
  assert.throws(()=>other.mutate('checkpoint',{...save,userRefs:[other.initialRef!]}),hasCode('NEW_ANSWER_REQUIRED'));
});

test('initial reference must be a real event from the owner session', t => {
  const f=createFixture(t);
  const otherOwner={host:'codex' as const,sessionId:'another-session'};
  const ref=f.event('다른 세션의 생각',otherOwner);
  const start={owner:f.owner(),title:'다른 작업',projectRoot:f.project,designDir:'docs/other-design',adrDir:'docs/other-adr',obsidianNote:'progress/other.md'};
  const distinctOwner={host:'codex' as const,sessionId:'new-owner'};
  assert.throws(()=>f.engine.execute('start',{...start,owner:distinctOwner,initialUserRef:ref}),hasCode('USER_EVIDENCE_OWNER'));
  assert.throws(()=>f.engine.execute('start',{...start,owner:distinctOwner,initialUserRef:{...distinctOwner,actor:'user',eventId:'not-observed'}}),hasCode('USER_EVIDENCE_NOT_FOUND'));
});

test('the first user thought is required before design, review or a proposed decision', t => {
  const f = createFixture(t);
  assert.equal(f.get().interview, 'awaiting_thought');
  assert.equal(f.get().pendingQuestion?.kind, 'thought');
  assert.throws(() => f.mutate('design', { content: '# AI가 먼저 정한 설계' }), hasCode('USER_THOUGHT_REQUIRED'));
  assert.throws(() => f.mutate('review', { criteria: criteria('requirements'), summary: '완료' }), hasCode('USER_THOUGHT_REQUIRED'));
  assert.throws(() => propose(f), hasCode('USER_THOUGHT_REQUIRED'));
  assert.equal(f.get().revision, 0);
  assert.deepEqual(filesIn(f.project), []);
  answer(f);
  assert.equal(f.get().stages[0]?.thoughtRef?.actor, 'user');
  f.mutate('design', { content: '# 사용자의 판단을 반영한 설계\n\n기존 수정을 보존한다.' });
  assert.equal(f.get().artifacts.filter(a => a.kind === 'design').length, 1);
});

test('answers must correspond to a pending question and a new observed user event', t => {
  const f = createFixture(t);
  const first = answer(f);
  assert.throws(() => f.mutate('answer', { questionId: 'not-pending', userRef: first, interpretation: '없던 답변' }), hasCode('QUESTION_MISMATCH'));
  f.mutate('question', { text: '공개 전의 초안도 보존할까요?' });
  const pending = f.get().pendingQuestion!;
  assert.throws(() => f.mutate('answer', { questionId: pending.id, userRef: first, interpretation: '이전 발화를 새 답처럼 재사용' }), hasCode('NEW_ANSWER_REQUIRED'));
  const older = f.event('첫 번째 새 답');
  const newest = f.event('답을 고쳤다. 공개 여부와 무관하게 보존한다.');
  assert.throws(() => f.mutate('answer', { questionId: pending.id, userRef: older, interpretation: '오래된 답' }), hasCode('STALE_USER_ANSWER'));
  answer(f, '공개 여부와 무관하게 수정한 초안을 보존한다.', newest);
  assert.equal(f.get().pendingQuestion, undefined);
});

test('AI suggestions and unobserved references cannot become accepted human decisions', t => {
  const f = createFixture(t);
  answer(f);
  const decisionId = propose(f);
  const observed = f.event('별도 초안을 만드는 방법을 선택한다.');
  assert.throws(() => f.mutate('decision-accept', { decisionId, userRef: { ...observed, actor: 'assistant' } }), hasCode('USER_EVIDENCE_REQUIRED'));
  assert.throws(() => f.mutate('decision-accept', { decisionId, userRef: { ...observed, eventId: 'invented-event' } }), hasCode('USER_EVIDENCE_NOT_FOUND'));
  assert.equal(f.get().decisions[0]?.status, 'proposed');
  f.mutate('decision-accept', { decisionId, userRef: observed });
  assert.equal(f.get().decisions[0]?.status, 'accepted');
  assert.equal(f.get().decisions[0]?.implementation, 'pending');
  assert.equal(f.get().decisions[0]?.verification, 'pending');
});

test('explanation does not count as understanding or complete a pending interview', t => {
  const f = createFixture(t);
  f.mutate('explain', { summary: '같은 요청을 다시 보내도 결과가 같도록 처리하는 방법을 설명했다.', nextQuestion: '같은 생성 요청이 두 번 들어오면 어떤 결과가 맞을까요?' });
  assert.equal(f.get().interview, 'explaining');
  assert.equal(f.get().learning[0]?.kind, 'explained');
  assert.equal(f.get().stages[0]?.thoughtRef, undefined);
  assert.throws(() => f.mutate('learning', { kind: 'user_reported', text: '사용자가 이해했다.' }), hasCode('USER_EVIDENCE_REQUIRED'));
  answer(f);
  f.mutate('sync');
  const note = fs.readFileSync(f.get().paths.obsidianNote, 'utf8');
  assert.match(note, /설명을 제공한 기록/);
  assert.match(note, /사용자가 이해했다고 밝힌 내용\n\n- 아직 기록하지 않음/);
});

test('stage completion needs saved documents, all criteria and resolved blocking decisions', t => {
  const f = createFixture(t);
  answer(f);
  assert.throws(() => f.mutate('review', { criteria: criteria('requirements'), summary: '검토' }), hasCode('DESIGN_DOCUMENT_REQUIRED'));
  f.mutate('design', { content: '# 요구사항\n\n수정 내용을 보존한다.' });
  assert.throws(() => f.mutate('review', { criteria: { scope: criteria('requirements').scope }, summary: '일부만 검토' }), hasCode('INCOMPLETE_CRITERIA'));
  f.mutate('review', { criteria: criteria('requirements'), summary: '요구사항 검토' });
  f.mutate('issue', { action: 'add', stage: 'requirements', text: '공개 전 수정도 보존하는가?', blocking: true });
  assert.throws(() => f.mutate('advance'), hasCode('OPEN_DECISIONS'));
  const issueId = f.get().openItems[0]!.id;
  f.mutate('issue', { action: 'resolve', id: issueId, userRef: f.event('공개 전 수정도 보존한다.') });
  assert.throws(() => f.mutate('advance'), hasCode('INCOMPLETE_CRITERIA'));
  f.mutate('review', { criteria: criteria('requirements'), summary: '공개 전 수정 보존 요구사항을 다시 검토했다.' });
  const decisionId = propose(f);
  assert.throws(() => f.mutate('advance'), hasCode('INCOMPLETE_CRITERIA'));
  f.mutate('review', { criteria: criteria('requirements'), summary: '제안한 초안 보존 결정의 영향을 다시 검토했다.' });
  assert.throws(() => f.mutate('advance'), hasCode('OPEN_DECISIONS'));
  f.mutate('decision-accept', { decisionId, userRef: f.event('보존하는 선택을 확정한다.') });
  f.mutate('advance');
  assert.equal(f.get().stage, 'non-functional');
  assert.equal(f.get().stages[0]?.status, 'complete');
});

test('unmeasured evidence can be deferred with a plan, but unresolved scope cannot', t => {
  const f = createFixture(t);
  answer(f);
  f.mutate('design', { content: '# 요구사항\n\n목표 지연과 실제 측정은 구분한다.' });
  const scopeDeferred = criteria('requirements');
  scopeDeferred.scope = { status: 'deferred', evidence: '아직 만들 기능을 모른다.', verification: '구현하며 알아본다.' };
  assert.throws(() => f.mutate('review', { criteria: scopeDeferred, summary: '범위 미정' }), hasCode('BLOCKING_CRITERION'));
  const measuredLater = criteria('requirements');
  measuredLater.evidence = { status: 'deferred', evidence: '실제 응답 지연은 아직 측정하지 않았다.' };
  assert.throws(() => f.mutate('review', { criteria: measuredLater, summary: '측정 미정' }), hasCode('BLOCKING_CRITERION'));
  measuredLater.evidence.verification = '구현 후 대표 요청으로 응답 지연을 측정한다.';
  f.mutate('review', { criteria: measuredLater, summary: '목표와 측정 계획을 구분했다.' });
  f.mutate('advance');
  assert.equal(f.get().stage, 'non-functional');
});

test('seven reviewed stages stop at implementation request and need new user authorization', t => {
  const f = createFixture(t);
  const oldDesignAnswer = finishDesign(f);
  assert.equal(f.get().run, 'awaiting_implementation');
  assert.equal(f.get().implementationRequest, undefined);
  assert.equal(f.get().stages.filter(s => s.status === 'complete').length, 7);
  assert.throws(() => f.mutate('implement', { scope: '초안 보존 기능', acceptance: ['기존 수정 내용을 보존한다.'] }), hasCode('USER_EVIDENCE_REQUIRED'));
  assert.throws(() => f.mutate('implement', { userRef: oldDesignAnswer, scope: '초안 보존 기능', acceptance: ['기존 수정 내용을 보존한다.'] }), hasCode('NEW_IMPLEMENTATION_REQUEST_REQUIRED'));
  f.mutate('implement', { userRef: f.event('이 설계의 초안 보존 기능을 구현해줘.'), scope: '초안 보존 기능', acceptance: ['기존 수정 내용을 보존한다.'] });
  assert.equal(f.get().run, 'implementing');
  assert.ok(f.get().artifacts.some(a => a.kind === 'handoff'));
});

test('completion requires actual passing evidence for every acceptance criterion', t => {
  const f = createFixture(t);
  finishDesign(f);
  f.mutate('implement', { userRef: f.event('이 범위를 구현해줘.'), scope: '초안 보존과 중복 요청 처리', acceptance: ['수정한 초안을 보존한다.', '같은 요청으로 초안이 중복 생성되지 않는다.'] });
  assert.throws(() => f.mutate('complete'), hasCode('VERIFICATION_INCOMPLETE'));
  f.mutate('verify', { checks: [{ criterion: 0, result: 'passed', evidence: '수정 전후 내용 비교 검사 통과' }] });
  assert.throws(() => f.mutate('complete'), hasCode('VERIFICATION_INCOMPLETE'));
  f.mutate('verify', { checks: [{ criterion: 0, result: 'passed', evidence: '내용 비교 검사 통과' }, { criterion: 1, result: 'failed', evidence: '중복 초안이 만들어짐' }] });
  assert.throws(() => f.mutate('complete'), hasCode('VERIFICATION_INCOMPLETE'));
  assert.throws(() => f.mutate('verify', { checks: [{ criterion: 0, result: 'passed', evidence: '' }] }), hasCode('INVALID_CHECKS'));
  f.mutate('verify', { checks: [{ criterion: 0, result: 'passed', evidence: '내용 비교 검사 통과' }, { criterion: 1, result: 'passed', evidence: '중복 요청 통합 검사 통과' }] });
  f.mutate('complete');
  assert.equal(f.get().run, 'complete');
});

test('stale versions, duplicate mutations and cross-host ownership are enforced', t => {
  const f = createFixture(t);
  const args = f.input({ kind: 'explained', text: '단계별 진행 방식 설명' });
  const first = f.engine.execute('learning', args) as View;
  const retry = f.engine.execute('learning', args) as View;
  assert.equal(first.workflow.revision, retry.workflow.revision);
  assert.equal(retry.replayed, true);
  assert.equal(f.get().learning.length, 1);
  assert.throws(() => f.engine.execute('learning', { ...args, text: '다른 내용' }), hasCode('OPERATION_REUSED'));
  assert.throws(() => f.mutate('learning', { kind: 'explained', text: '오래된 상태 변경', expectedRevision: 0 }), hasCode('STALE_REVISION'));
  const originalOwner = f.owner();
  const recipient: Owner = { host: 'claude', sessionId: 'session-claude' };
  f.mutate('handoff', { userRef: f.event('Claude Code에서 이어가겠다.'), to: recipient });
  assert.equal(f.store.findSession(originalOwner.host, originalOwner.sessionId)?.readOnly, true);
  assert.equal(f.store.findSession(recipient.host, recipient.sessionId)?.readOnly, false);
  assert.throws(() => f.mutate('learning', { owner: originalOwner, kind: 'explained', text: '이전 세션의 변경' }), hasCode('NOT_OWNER'));
  f.setOwner(recipient);
  answer(f);
  assert.equal(f.get().stages[0]?.thoughtRef?.host, 'claude');
});

test('rewriting a design invalidates its previous review and manual edits are preserved', t => {
  const f = createFixture(t);
  prepareStage(f);
  f.mutate('design', { content: '# 변경한 요구사항\n\n공개 전 수정도 보존한다.' });
  assert.throws(() => f.mutate('advance'), hasCode('INCOMPLETE_CRITERIA'));
  f.mutate('review', { criteria: criteria('requirements'), summary: '수정한 요구사항 검토' });
  const artifact = f.get().artifacts.find(a => a.kind === 'design')!;
  const humanText = fs.readFileSync(artifact.path, 'utf8') + '\n사용자가 직접 추가한 중요한 정책\n';
  fs.writeFileSync(artifact.path, humanText);
  assert.throws(() => f.mutate('advance'), hasCode('DOCUMENT_CONFLICT'));
  assert.throws(() => f.mutate('design', { content: '# 덮어쓰기 시도' }), hasCode('DOCUMENT_CONFLICT'));
  assert.equal(fs.readFileSync(artifact.path, 'utf8'), humanText);
  f.mutate('reconcile', { artifactId: artifact.id, observedHash: hashFile(artifact.path), userRef: f.event('추가한 정책이 설계의 의미를 바꾼다.'), meaning: 'changed', stages: ['requirements'] });
  assert.equal(f.get().interview, 'awaiting_thought');
  assert.deepEqual(f.get().stages[0]?.criteria, {});
  assert.equal(fs.readFileSync(artifact.path, 'utf8'), humanText);
});

test('ADR manual edits survive confirmation and project write failure cannot advance state', t => {
  const f = createFixture(t);
  answer(f);
  const decisionId = propose(f);
  const artifact = f.get().artifacts.find(a => a.id === decisionId)!;
  const manual = fs.readFileSync(artifact.path, 'utf8') + '\n## 개인 검토\n\n직접 검토한 근거\n';
  fs.writeFileSync(artifact.path, manual);
  const ref = f.event('직접 적은 근거를 확인했고 선택을 유지한다.');
  assert.throws(() => f.mutate('decision-accept', { decisionId, userRef: ref }), hasCode('DOCUMENT_CONFLICT'));
  assert.equal(f.get().decisions[0]?.status, 'proposed');
  f.mutate('reconcile', { artifactId: artifact.id, observedHash: hashFile(artifact.path), userRef: ref, meaning: 'unchanged' });
  f.mutate('decision-accept', { decisionId, userRef: ref });
  assert.match(fs.readFileSync(artifact.path, 'utf8'), /직접 검토한 근거/);
  const before = f.get().revision;
  fs.writeFileSync(f.get().paths.designDir, 'a file blocks the design directory');
  assert.throws(() => f.mutate('design', { content: '# 저장되지 않는 문서' }), (error: unknown) => error instanceof DesignError && error.code.startsWith('DOCUMENT_'));
  assert.equal(f.get().revision, before);
  assert.ok(!f.get().artifacts.some(a => a.kind === 'design'));
});

test('Obsidian-only failure is visible and nonblocking; a later retry writes one note', t => {
  const f = createFixture(t);
  prepareStage(f);
  fs.writeFileSync(path.join(f.vault, 'progress'), 'blocks only the personal note folder');
  f.mutate('advance');
  assert.equal(f.get().stage, 'non-functional');
  assert.equal(f.get().obsidianPending, true);
  assert.ok(f.get().obsidianError);
  assert.equal(f.get().artifacts.filter(a => a.kind === 'design').length, 1);
  fs.unlinkSync(path.join(f.vault, 'progress'));
  const syncArgs = f.input();
  f.engine.execute('sync', syncArgs);
  f.engine.execute('sync', syncArgs);
  assert.equal(f.get().obsidianPending, false);
  assert.equal(f.get().artifacts.filter(a => a.kind === 'obsidian').length, 1);
  assert.equal(filesIn(path.join(f.vault, 'progress')).length, 1);
});

test('manual Obsidian edits are preserved until meaning is confirmed, including text inside its managed area', t => {
  const f = createFixture(t);
  prepareStage(f); f.mutate('advance');
  const artifact = f.get().artifacts.find(a => a.kind === 'obsidian')!;
  const manual = fs.readFileSync(artifact.path, 'utf8').replace('## 단계별 정리', '직접 고친 진행 내용\n\n## 단계별 정리') + '\n개인 메모 원문\n';
  fs.writeFileSync(artifact.path, manual);
  f.mutate('sync');
  assert.equal(f.get().obsidianPending, true);
  assert.equal(fs.readFileSync(artifact.path, 'utf8'), manual);
  f.mutate('reconcile', { artifactId: artifact.id, observedHash: hashFile(artifact.path), userRef: f.event('내가 수정한 개인 기록을 보존하고 진행표를 갱신해줘.'), meaning: 'changed' });
  const merged = fs.readFileSync(artifact.path, 'utf8');
  assert.match(merged, /직접 고친 진행 내용/);
  assert.match(merged, /개인 메모 원문/);
  assert.equal(f.get().obsidianPending, false);
});

test('default state, Markdown files and error paths do not duplicate raw user dialogue', t => {
  const f = createFixture(t);
  const raw = 'PRIVATE_RAW_DIALOGUE_775e77c5_사용자_대화_원문';
  const ref = f.event(raw);
  f.mutate('answer', { questionId: f.get().pendingQuestion!.id, userRef: ref, interpretation: '수정한 초안 보존을 요청했다.', answer: raw });
  prepareStage(f); f.mutate('advance');
  const archiveAttempt = () => f.mutate('archive', { userRef: ref, question: '개인 질문', answer: raw });
  assert.throws(archiveAttempt, hasCode('ARCHIVE_DISABLED'));
  assert.ok(!fs.existsSync(path.join(f.store.dir, 'archives')));
  for (const file of filesIn(f.base)) assert.equal(fs.readFileSync(file).includes(Buffer.from(raw)), false, `${file} should not duplicate raw dialogue`);
  assert.equal(JSON.stringify(f.get()).includes(raw), false);
});

test('raw archive is explicit opt-in, future-only, private and idempotent', t => {
  const f = createFixture(t);
  const historic = f.event('보관 동의 이전의 대화');
  assert.throws(() => f.engine.execute('setup', { owner: f.owner(), obsidianVault: f.vault, obsidianFolder: 'progress', archiveEnabled: true }), hasCode('USER_EVIDENCE_REQUIRED'));
  const consent = f.event('이후 이 작업의 질문과 답변을 개인 보관하겠다.');
  f.engine.execute('setup', { owner: f.owner(), obsidianVault: f.vault, obsidianFolder: 'progress', archiveEnabled: true, userRef: consent });
  assert.throws(() => f.mutate('archive', { userRef: historic, question: '과거 질문', answer: '보관 동의 이전의 대화' }), hasCode('ARCHIVE_BEFORE_CONSENT'));
  const raw = '동의 이후에 새로 한 답변';
  const ref = f.event(raw);
  const args = f.input({ userRef: ref, question: '현재 질문', answer: raw });
  f.engine.execute('archive', args);
  f.engine.execute('archive', args);
  const archived = filesIn(path.join(f.store.dir, 'archives'));
  assert.equal(archived.length, 1);
  assert.match(fs.readFileSync(archived[0]!, 'utf8'), /동의 이후에 새로 한 답변/);
  assert.equal(fs.statSync(archived[0]!).mode & 0o777, 0o600);
  assert.ok(filesIn(f.project).every(file => !fs.readFileSync(file).includes(Buffer.from(raw))));
  f.engine.execute('setup', { owner: f.owner(), obsidianVault: f.vault, obsidianFolder: 'progress', archiveEnabled: false });
  assert.throws(() => f.mutate('archive', { userRef: f.event('더 보관하지 않는다.'), question: '다음 질문', answer: '다음 답변' }), hasCode('ARCHIVE_DISABLED'));
});

test('reopening an affected stage suspends implementation without deleting earlier decisions', t => {
  const f = createFixture(t);
  finishDesign(f);
  f.mutate('implement', { userRef: f.event('구현을 시작해줘.'), scope: '초안 보존', acceptance: ['기존 초안을 보존한다.'] });
  f.mutate('reopen', { stages: ['api', 'evaluation'], reason: '재시도 응답 정책을 바꿀 필요가 있다.' });
  assert.equal(f.get().run, 'designing');
  assert.equal(f.get().stage, 'api');
  assert.equal(f.get().stages[0]?.status, 'complete');
  assert.equal(f.get().stages[1]?.status, 'complete');
  assert.equal(f.get().stages.find(s => s.stage === 'api')?.thoughtRef, undefined);
  assert.equal(f.get().stages.find(s => s.stage === 'evaluation')?.status, 'needs_review');
  assert.ok(f.get().implementationRequest);
});

test('state storage cannot be put inside Git, a project or the Obsidian vault', t => {
  const f = createFixture(t);
  assert.throws(() => new Store(path.join(f.project, '.private-state')), hasCode('STATE_IN_GIT'));
  const inVault = new Store(path.join(f.vault, '.state'));
  try {
    assert.throws(() => new Engine(inVault).execute('setup', { owner: f.owner(), obsidianVault: f.vault, obsidianFolder: 'progress', archiveEnabled: false }), hasCode('STATE_IN_VAULT'));
  } finally { inVault.close(); }
});

test('a new interview answer invalidates an earlier stage review before advancing', t => {
  const f = createFixture(t);
  prepareStage(f);
  f.mutate('question', { text: '초안을 공개한 뒤 수정해도 보존해야 하나요?' });
  answer(f, '공개한 초안을 수정한 내용도 계속 보존한다.');
  assert.throws(() => f.mutate('advance'), hasCode('INCOMPLETE_CRITERIA'));
  assert.equal(f.get().stage, 'requirements');
  assert.equal(f.get().stages[0]?.status, 'active');
  f.mutate('review', { criteria: criteria('requirements'), summary: '공개 여부와 무관하게 수정한 내용을 보존하도록 다시 검토했다.' });
  f.mutate('advance');
  assert.equal(f.get().stage, 'non-functional');
});

test('correcting an AI interpretation preserves its evidence and pending question without inventing an answer', t => {
  const f=createFixture(t),ref=answer(f,'AI가 잘못 요약한 내용');
  prepareStage(f);
  f.mutate('question',{text:'아직 정하지 않은 처리 범위는 무엇인가요?'});
  const before=f.get(),pending=before.pendingQuestion;
  const unrelated=f.event('설치 확인만 요청한다.');
  assert.throws(()=>f.mutate('answer-revise',{userRef:unrelated,interpretation:'새 답변처럼 처리',reason:'수정'}),hasCode('ANSWER_REFERENCE_REQUIRED'));
  f.mutate('answer-revise',{userRef:ref,interpretation:'사용자가 수정한 피드백은 보존한다.',reason:'앞선 해석에 사용자가 말하지 않은 문장을 넣었다.'});
  const after=f.get();
  assert.deepEqual(after.pendingQuestion,pending);
  assert.deepEqual(after.stages[0]!.answerRefs,before.stages[0]!.answerRefs);
  assert.equal(after.stages[0]!.interpretationRevisions?.length,1);
  assert.equal(after.stages[0]!.interpretationRevisions?.[0]?.userRef.eventId,ref.eventId);
  assert.equal(after.stages[0]!.interpretationRevisions?.[0]?.previous,before.stages[0]!.summary);
  assert.equal(after.stages[0]!.summary,'사용자가 수정한 피드백은 보존한다.');
  assert.deepEqual(after.stages[0]!.criteria,{});
  assert.deepEqual(after.decisions,[]);
  assert.throws(()=>f.mutate('advance'),hasCode('ANSWER_PENDING'));
});

test('two workflows sharing an ADR directory may reuse an operation id without sharing a document', t => {
  const f = createFixture(t);
  answer(f);
  const operationId = 'propose-first-decision';
  const firstId = propose(f, { operationId });
  const first = f.get().decisions.find(d => d.id === firstId)!;
  const firstBody = fs.readFileSync(first.path, 'utf8');
  const secondOwner: Owner = { host: 'claude', sessionId: 'another-design-session' };
  const second = f.engine.execute('start', { owner: secondOwner, title: '공개된 초안의 변경 이력', projectRoot: f.project, designDir: 'docs/system-design', adrDir: 'docs/adr', obsidianNote: 'progress/second.md' }) as View;
  f.engine.execute('answer', {
    workflowId: second.workflow.id, owner: secondOwner, expectedRevision: 0, operationId: 'first-answer',
    questionId: second.workflow.pendingQuestion!.id, userRef: f.event('공개한 초안의 수정 이력을 남기고 싶다.', secondOwner), interpretation: '공개한 초안의 수정 이력을 남긴다.',
  });
  const secondId = propose(f, { workflowId: second.workflow.id, owner: secondOwner, expectedRevision: 1, operationId, title: '공개한 초안의 수정 이력 보존' });
  const secondDecision = f.store.get(second.workflow.id).decisions.find(d => d.id === secondId)!;
  assert.notEqual(firstId, secondId);
  assert.notEqual(first.path, secondDecision.path);
  assert.equal(fs.readFileSync(first.path, 'utf8'), firstBody);
  assert.match(fs.readFileSync(secondDecision.path, 'utf8'), /공개한 초안의 수정 이력 보존/);
});

test('ADR links retain design versions, interview references and optional code evidence', t => {
  const f = createFixture(t);
  const ref=answer(f);
  f.mutate('design',{content:'# 요구사항\n\n사람이 수정한 피드백을 보존한다.'});
  const design=f.get().artifacts.find(a=>a.kind==='design')!;
  const id=propose(f,{references:['[관련 코드](../../src/feedback.ts) / 기존 보존 동작을 확인했다.']});
  const adr=f.get().decisions.find(d=>d.id===id)!;
  const body=fs.readFileSync(adr.path,'utf8');
  assert.match(body,/## 근거와 연결/);
  assert.ok(body.includes(design.hash));
  assert.ok(body.includes('1-requirements.md'));
  assert.ok(body.includes(ref.eventId));
  assert.ok(body.includes('../../src/feedback.ts'));
});

test('a title typo can be corrected without changing an accepted decision or its evidence', t => {
  const f=createFixture(t);answer(f);
  const id=propose(f,{title:'잘못 입력한 제목'});
  f.mutate('decision-accept',{decisionId:id,userRef:f.event('수정된 초안을 보존하는 선택을 확정한다.')});
  const before=f.get().decisions[0]!;
  const body=fs.readFileSync(before.path,'utf8').split('\n').slice(1).join('\n');
  f.mutate('decision-retitle',{decisionId:id,title:'사람이 수정한 피드백 보존',reason:'선택과 관계없는 문구를 제목에 넣은 오기를 수정한다.'});
  const after=f.get().decisions[0]!;
  assert.equal(after.title,'사람이 수정한 피드백 보존');
  assert.equal(after.status,'accepted');assert.deepEqual(after.userRef,before.userRef);
  assert.equal(after.titleRevisions?.[0]?.previous,'잘못 입력한 제목');
  assert.equal(fs.readFileSync(after.path,'utf8').split('\n').slice(1).join('\n'),body);
  assert.equal(f.get().decisions.length,1);
});

test('invalid later decision ids cannot partially update earlier ADRs and a corrected retry succeeds', t => {
  const f = createFixture(t);
  const [decisionId] = finishDesignWithDecisions(f, 1);
  const before = f.get();
  const decision = before.decisions.find(d => d.id === decisionId)!;
  const body = fs.readFileSync(decision.path, 'utf8');
  const args = f.input({ checks: [{ criterion: 0, result: 'passed', evidence: '수정한 내용 보존 검사가 통과했다.' }], implementedDecisionIds: [decisionId, 'missing-decision'] });
  assert.throws(() => f.engine.execute('verify', args), hasCode('DECISION_NOT_FOUND'));
  assert.equal(fs.readFileSync(decision.path, 'utf8'), body);
  assert.deepEqual(f.get(), before);
  const corrected = { ...args, implementedDecisionIds: [decisionId], verifiedDecisionIds: [decisionId] };
  f.engine.execute('verify', corrected);
  assert.equal(f.get().decisions[0]?.implementation, 'implemented');
  assert.equal(f.get().decisions[0]?.verification, 'verified');
  const result = fs.readFileSync(decision.path, 'utf8');
  assert.match(result, /^구현 상태: 완료$/m);
  assert.match(result, /^검증 상태: 완료$/m);
  assert.match(result,/수정한 내용 보존 검사가 통과했다\./);
  assert.equal((f.engine.execute('verify', corrected) as View).replayed, true);
  assert.equal(fs.readFileSync(decision.path, 'utf8'), result);
});

test('a failure writing the second required ADR restores the first document and allows a clean retry', t => {
  const f = createFixture(t);
  const ids = finishDesignWithDecisions(f, 2);
  const before = f.get();
  const [first, second] = ids.map(id => before.decisions.find(d => d.id === id)!);
  const originalBodies = new Map(before.decisions.map(d => [d.path, fs.readFileSync(d.path, 'utf8')]));
  const args = f.input({ checks: [{ criterion: 0, result: 'passed', evidence: '수정 내용 보존 검사가 통과했다.' }], implementedDecisionIds: ids });
  const originalRename = fsNative.renameSync;
  let firstWasWritten = false;
  let failureInjected = false;
  const renamed = t.mock.method(fsNative, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === first!.path) firstWasWritten = true;
    if (String(to) === second!.path && !failureInjected) {
      failureInjected = true;
      throw Object.assign(new Error('Injected failure on the second required file'), { code: 'EIO' });
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => f.engine.execute('verify', args), error => error instanceof DesignError && error.code.startsWith('DOCUMENT_'));
  } finally {
    renamed.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(firstWasWritten, true, 'the failure must happen after the earlier required document was actually replaced');
  assert.equal(failureInjected, true);
  assert.deepEqual(f.get(), before);
  for (const [file, body] of originalBodies) assert.equal(fs.readFileSync(file, 'utf8'), body);
  assert.deepEqual(filesIn(path.join(f.store.dir, 'document-journal')), []);
  assert.ok(filesIn(f.project).every(file => !file.endsWith('.tmp')));
  f.engine.execute('verify', args);
  assert.ok(f.get().decisions.every(d => d.implementation === 'implemented'));
  assert.ok(f.get().decisions.every(d => /^구현 상태: 완료$/m.test(fs.readFileSync(d.path, 'utf8'))));
});

test('an optional note fsync failure after replacement remains nonblocking and can be retried', t => {
  const f = createFixture(t);
  prepareStage(f); f.mutate('advance');
  const note = f.get().paths.obsidianNote;
  const oldBody = fs.readFileSync(note, 'utf8');
  const noteDirectory = fs.statSync(path.dirname(note));
  prepareStage(f);
  const advanceArgs = f.input();
  const originalFsync = fsNative.fsyncSync;
  let failureInjected = false;
  let replacedBody = '';
  const synced = t.mock.method(fsNative, 'fsyncSync', (fd: number) => {
    const stat = fs.fstatSync(fd);
    if (!failureInjected && stat.isDirectory() && stat.dev === noteDirectory.dev && stat.ino === noteDirectory.ino) {
      failureInjected = true;
      replacedBody = fs.readFileSync(note, 'utf8');
      throw Object.assign(new Error('Injected fsync failure after replacing the optional note'), { code: 'EIO' });
    }
    return originalFsync(fd);
  });
  syncBuiltinESMExports();
  try {
    f.engine.execute('advance', advanceArgs);
  } finally {
    synced.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(failureInjected, true);
  assert.notEqual(replacedBody, oldBody, 'the optional failure must happen after replacing the note');
  assert.equal(f.get().stage, 'entities');
  assert.equal(f.get().obsidianPending, true);
  assert.equal(f.get().obsidianError, 'DOCUMENT_WRITE_FAILED');
  assert.equal((f.engine.execute('advance', advanceArgs) as View).replayed, true);
  assert.equal(f.get().stage, 'entities');
  const retry = f.input();
  f.engine.execute('sync', retry);
  assert.equal(f.get().obsidianPending, false);
  assert.equal(f.get().artifacts.find(a => a.kind === 'obsidian')?.hash, hashFile(note));
  assert.equal(fs.readFileSync(note, 'utf8').split('<!-- system-design-progress:start -->').length - 1, 1);
  assert.equal((f.engine.execute('sync', retry) as View).replayed, true);
  assert.deepEqual(filesIn(path.join(f.store.dir, 'document-journal')), []);
});

test('recovery without a committed receipt restores replaced files and removes newly created files', t => {
  const f = createFixture(t);
  prepareStage(f);
  const before = f.get();
  const artifact = before.artifacts.find(a => a.kind === 'design')!;
  const originalBody = fs.readFileSync(artifact.path, 'utf8');
  const addedPath = path.join(path.dirname(artifact.path), 'additional-review.md');
  const ctx = f.input();
  const batch = new DocumentBatch(f.store, f.id, ctx.operationId);
  const interrupted = new Error('Interrupted before the state transaction could commit');
  assert.throws(() => f.store.mutate(ctx, digest({ fixture: 'uncommitted document batch' }), w => {
    batch.stage(w, artifact, '# 저장 직후 중단된 새 설계\n', w.paths.designDir);
    batch.stage(w, { id: 'additional-review', kind: 'design', path: addedPath }, '# 추가 검토\n', w.paths.designDir);
    batch.apply(w);
    f.store.put(w);
    throw interrupted;
  }), error => error === interrupted);
  assert.match(fs.readFileSync(artifact.path, 'utf8'), /중단된 새 설계/);
  assert.equal(fs.existsSync(addedPath), true);
  assert.equal(filesIn(path.join(f.store.dir, 'document-journal')).length, 1);
  recoverInFreshStore(f);
  assert.equal(fs.readFileSync(artifact.path, 'utf8'), originalBody);
  assert.equal(fs.existsSync(addedPath), false);
  assert.deepEqual(f.get(), before);
  assert.deepEqual(filesIn(path.join(f.store.dir, 'document-journal')), []);
});

test('recovery with a committed receipt keeps the committed write and subsequent human edits', t => {
  const f = createFixture(t);
  prepareStage(f);
  const artifact = f.get().artifacts.find(a => a.kind === 'design')!;
  const ctx = f.input();
  const batch = new DocumentBatch(f.store, f.id, ctx.operationId);
  const committedBody = '# 확정된 새 설계\n\n공개한 초안도 보존한다.\n';
  const committed = f.store.mutate(ctx, digest({ fixture: 'committed document batch' }), w => {
    batch.stage(w, artifact, committedBody, w.paths.designDir);
    batch.apply(w);
  });
  assert.equal(filesIn(path.join(f.store.dir, 'document-journal')).length, 1);
  const manual = committedBody + '\n사용자가 저장 후 추가한 설명\n';
  fs.writeFileSync(artifact.path, manual);
  recoverInFreshStore(f);
  assert.equal(fs.readFileSync(artifact.path, 'utf8'), manual);
  assert.deepEqual(f.get(), committed.workflow);
  assert.deepEqual(filesIn(path.join(f.store.dir, 'document-journal')), []);
});

test('uncommitted recovery preserves a manually changed file and leaves its recovery record for review', t => {
  const f = createFixture(t);
  prepareStage(f);
  const before = f.get();
  const artifact = before.artifacts.find(a => a.kind === 'design')!;
  const w = structuredClone(before);
  const batch = new DocumentBatch(f.store, f.id, 'interrupted-before-receipt');
  batch.stage(w, artifact, '# 저장 중이던 설계\n', w.paths.designDir);
  batch.apply(w);
  const manual = '# 사람이 복구 중 직접 확정한 문서\n\n이 내용을 자동으로 되돌리면 안 된다.\n';
  fs.writeFileSync(artifact.path, manual);
  assert.throws(() => recoverInFreshStore(f), hasCode('DOCUMENT_RECOVERY_CONFLICT'));
  assert.equal(fs.readFileSync(artifact.path, 'utf8'), manual);
  assert.deepEqual(f.get(), before);
  assert.equal(filesIn(path.join(f.store.dir, 'document-journal')).length, 1);
});

test('a note that existed at workflow start can be explicitly adopted without losing its content', t => {
  const personal = '# 내 설계 기록\n\n지금도 중요한 기존 개인 메모\n';
  const f = createFixture(t, { existingNote: personal });
  assert.equal(f.get().artifacts.some(a => a.kind === 'obsidian'), false);
  f.mutate('sync');
  assert.equal(f.get().obsidianPending, true);
  assert.equal(fs.readFileSync(f.get().paths.obsidianNote, 'utf8'), personal);
  const args = { artifactId: 'obsidian', observedHash: hashFile(f.get().paths.obsidianNote), meaning: 'unchanged' };
  assert.throws(() => f.mutate('reconcile', args), hasCode('USER_EVIDENCE_REQUIRED'));
  f.mutate('reconcile', { ...args, userRef: f.event('이 개인 기록의 기존 내용을 유지하고 이 작업의 진행표를 추가해줘.') });
  const adopted = fs.readFileSync(f.get().paths.obsidianNote, 'utf8');
  assert.ok(adopted.startsWith(personal));
  assert.equal(adopted.split('<!-- system-design-progress:start -->').length - 1, 1);
  assert.equal(f.get().obsidianPending, false);
  assert.equal(f.get().stage, 'requirements');
  assert.equal(f.get().stages[0]?.thoughtRef, undefined);
  assert.equal(f.get().artifacts.filter(a => a.kind === 'obsidian').length, 1);
  f.mutate('sync');
  assert.equal(fs.readFileSync(f.get().paths.obsidianNote, 'utf8').split(personal).length - 1, 1);
});

test('user-backed recovery can inspect and preserve conflicted files without confirming an interrupted decision', t => {
  const f = createFixture(t);
  prepareStage(f);
  const decisionId = propose(f);
  const before = f.get();
  const design = before.artifacts.find(a => a.kind === 'design')!;
  const adr = before.artifacts.find(a => a.id === decisionId)!;
  const interruptedRef = f.event('초안 보존 선택을 확정하고 싶다.');
  const pendingOperationId = 'interrupted-acceptance';
  const pending = structuredClone(before);
  const batch = new DocumentBatch(f.store, f.id, pendingOperationId);
  batch.stage(pending, design, '# 저장 중 갱신된 설계\n\n공개한 수정 내용도 보존한다.\n', pending.paths.designDir);
  batch.stage(pending, adr, patchADRStatus(fs.readFileSync(adr.path, 'utf8'), 'accepted', interruptedRef), pending.paths.adrDir);
  pending.decisions.find(d => d.id === decisionId)!.status = 'accepted';
  batch.apply(pending);
  const manual = fs.readFileSync(design.path, 'utf8') + '\n사용자가 중단 후 직접 추가한 예외 조건\n';
  fs.writeFileSync(design.path, manual);
  const adrAtInterruption = fs.readFileSync(adr.path, 'utf8');

  assert.throws(() => f.mutate('sync'), hasCode('DOCUMENT_RECOVERY_CONFLICT'));
  assert.equal(fs.readFileSync(design.path, 'utf8'), manual);
  assert.equal(fs.readFileSync(adr.path, 'utf8'), adrAtInterruption, 'a conflict in one document must not roll back another document before user review');
  const status = f.engine.execute('status', { workflowId: f.id, owner: f.owner() }) as ReturnType<Engine['view']>[];
  const recovery = status[0]!.pendingRecovery[0]!;
  assert.equal(recovery.operationId, pendingOperationId);
  assert.deepEqual(new Set(recovery.documents.map(d => d.path)), new Set([design.path, adr.path]));
  assert.ok(recovery.documents.every(d => d.observedHash === hashFile(d.path)));
  assert.equal(JSON.stringify(recovery).includes('사용자가 중단 후 직접 추가한 예외 조건'), false);
  assert.equal(status[0]!.workflow.decisions[0]?.status, 'proposed');

  const common = { pendingOperationId, documents: recovery.documents, stages: ['requirements'] };
  assert.throws(() => f.mutate('recover', common), hasCode('USER_EVIDENCE_REQUIRED'));
  const userRef = f.event('현재 두 문서를 읽었다. 이 버전을 보존하고 요구사항과 결정을 다시 검토하자.');
  assert.throws(() => f.mutate('recover', { ...common, userRef, documents: recovery.documents.slice(1) }), hasCode('RECOVERY_EVIDENCE_REQUIRED'));
  const args = f.input({ ...common, userRef });
  const staleDocuments = recovery.documents.map((d, i) => i === 1 ? { ...d, observedHash: '0'.repeat(64) } : d);
  assert.throws(() => f.engine.execute('recover', { ...args, documents: staleDocuments }), hasCode('DOCUMENT_CHANGED_AGAIN'));
  assert.deepEqual(f.get(), before);
  assert.equal(filesIn(path.join(f.store.dir, 'document-journal')).length, 1);
  assert.equal(fs.readFileSync(design.path, 'utf8'), manual);
  assert.equal(fs.readFileSync(adr.path, 'utf8'), adrAtInterruption);

  const recovered = f.engine.execute('recover', args) as ReturnType<Engine['view']>;
  assert.deepEqual(recovered.pendingRecovery, []);
  assert.equal(f.get().run, 'designing');
  assert.equal(f.get().interview, 'awaiting_thought');
  assert.deepEqual(f.get().stages[0]?.criteria, {});
  assert.equal(f.get().stages[0]?.thoughtRef, undefined);
  assert.equal(f.get().decisions[0]?.status, 'proposed');
  assert.equal(f.get().decisions[0]?.implementation, 'pending');
  assert.equal(f.get().implementationRequest, undefined);
  assert.equal(fs.readFileSync(design.path, 'utf8'), manual);
  assert.equal(fs.readFileSync(adr.path, 'utf8'), adrAtInterruption);
  assert.deepEqual(filesIn(path.join(f.store.dir, 'document-journal')), []);
  assert.equal((f.engine.execute('recover', args) as View).replayed, true);
  answer(f, '수정 내용을 보존하면서 새 예외 조건을 다시 검토한다.');
  assert.throws(() => f.mutate('advance'), hasCode('INCOMPLETE_CRITERIA'));
});

test('recovering a deleted accepted ADR retains its tracking and blocks review or advancement until restored', t => {
  const f = createFixture(t);
  answer(f);
  const decisionId = propose(f);
  f.mutate('decision-accept', { decisionId, userRef: f.event('수정한 초안 보존 결정을 확정한다.') });
  prepareStage(f);
  const before = f.get();
  const decision = before.decisions.find(d => d.id === decisionId)!;
  const artifact = before.artifacts.find(a => a.id === decisionId)!;
  const acceptedBody = fs.readFileSync(artifact.path, 'utf8');
  const pendingOperationId = 'interrupted-accepted-adr-update';
  const pending = structuredClone(before);
  const batch = new DocumentBatch(f.store, f.id, pendingOperationId);
  batch.stage(pending, artifact, acceptedBody + '\n저장 중 추가하던 검토 근거\n', pending.paths.adrDir);
  batch.apply(pending);
  fs.unlinkSync(artifact.path);
  assert.throws(() => f.mutate('sync'), hasCode('DOCUMENT_RECOVERY_CONFLICT'));
  const status = f.engine.execute('status', { workflowId: f.id }) as ReturnType<Engine['view']>[];
  const recovery = status[0]!.pendingRecovery[0]!;
  assert.deepEqual(recovery.documents, [{ path: artifact.path, observedHash: null }]);
  f.mutate('recover', {
    pendingOperationId, documents: recovery.documents, stages: ['requirements'],
    userRef: f.event('ADR 파일이 없어진 상태를 확인했다. 원본을 복원한 다음 요구사항을 다시 검토하자.'),
  });
  assert.equal(fs.existsSync(artifact.path), false);
  assert.deepEqual(f.get().decisions.find(d => d.id === decisionId), decision);
  assert.deepEqual(f.get().artifacts.find(a => a.id === decisionId), artifact);
  assert.deepEqual(filesIn(path.join(f.store.dir, 'document-journal')), []);

  answer(f, '확정된 초안 보존 결정의 원본을 복원한 뒤 진행해야 한다.');
  const beforeReview = f.get().revision;
  assert.throws(() => f.mutate('review', { criteria: criteria('requirements'), summary: '원본이 없는 결정을 사용한 검토' }), hasCode('DOCUMENT_CONFLICT'));
  assert.equal(f.get().revision, beforeReview);
  assert.equal(f.get().stages[0]?.status, 'active');
  assert.equal(f.get().decisions.find(d => d.id === decisionId)?.status, 'accepted');
  assert.ok(f.get().artifacts.some(a => a.id === decisionId && a.path === artifact.path));

  fs.writeFileSync(artifact.path, acceptedBody);
  f.mutate('review', { criteria: criteria('requirements'), summary: '복원한 ADR 원본과 요구사항을 다시 검토했다.' });
  fs.unlinkSync(artifact.path);
  assert.throws(() => f.mutate('advance'), hasCode('DOCUMENT_CONFLICT'));
  assert.equal(f.get().stage, 'requirements');
  assert.equal(f.get().stages[0]?.status, 'active');
  assert.equal(f.get().decisions.find(d => d.id === decisionId)?.status, 'accepted');
  assert.ok(f.get().artifacts.some(a => a.id === decisionId));
});

test('topic checkpoint persists several turns, accepted choice and next question in one revision', t => {
  const f=createFixture(t), before=f.get();
  const first=f.event('완성 결과를 먼저 확인하고 싶다.');
  const last=f.event('직접 게시할 때만 공개한다.');
  assert.equal(f.get().revision,before.revision);
  assert.equal(filesIn(f.project).length,0);
  const args=f.input({topic:'공개 조건',userRefs:[first,last],interpretation:'완성 결과를 확인한 뒤 직접 게시할 때 공개한다.',content:'# 공개 조건\n\n직접 게시할 때만 공개한다.',nextQuestion:'저장 기능은 어떻게 사용하나요?',decisions:[{title:'직접 게시',background:'생성과 공개를 구분한다.',choice:'직접 게시한다.',alternatives:['자동 공개'],reason:'사용자가 공개 시점을 정한다.',consequences:['게시 동작이 필요하다.'],verification:'게시 전 노출되지 않는다.',revisit:'공개 정책 변경 시',stages:['requirements'],userRef:last}]});
  const result=f.engine.execute('checkpoint',args) as View;
  assert.equal(result.workflow.revision,before.revision+1);
  assert.deepEqual(result.workflow.stages[0]!.answerRefs,[first,last]);
  assert.equal(result.workflow.decisions[0]!.status,'accepted');
  assert.match(fs.readFileSync(result.workflow.paths.obsidianNote,'utf8'),/저장 기능은 어떻게/);
  assert.equal(result.workflow.pendingQuestion?.text,'저장 기능은 어떻게 사용하나요?');
  const again=f.engine.execute('checkpoint',args) as View;
  assert.equal(again.replayed,true);
  assert.equal(again.workflow.decisions.length,1);
});

test('checkpoint rejects unobserved, stale, out-of-order and old topic evidence without files', t => {
  const f=createFixture(t), one=f.event('첫 판단'),two=f.event('바뀐 판단');
  const data={topic:'범위',interpretation:'최근 판단',content:'# 범위'};
  assert.throws(()=>f.mutate('checkpoint',{...data,userRefs:[one]}),hasCode('STALE_USER_ANSWER'));
  assert.throws(()=>f.mutate('checkpoint',{...data,userRefs:[two,one]}),hasCode('NEW_ANSWER_REQUIRED'));
  assert.throws(()=>f.mutate('checkpoint',{...data,userRefs:[{...two,eventId:'missing'}]}),hasCode('USER_EVIDENCE_NOT_FOUND'));
  assert.throws(()=>f.mutate('checkpoint',{...data,userRefs:[{...two,sessionId:'elsewhere'}]}),hasCode('USER_EVIDENCE_OWNER'));
  assert.equal(f.get().revision,0);assert.equal(filesIn(f.project).length,0);
  f.mutate('checkpoint',{...data,userRefs:[one,two],nextQuestion:'다음 주제?'});
  const next=f.event('다음 주제 답변');
  assert.throws(()=>f.mutate('checkpoint',{...data,userRefs:[two,next]}),hasCode('NEW_ANSWER_REQUIRED'));
});

test('checkpoint rolls back docs, decisions and revision when review or document checks fail', t=>{
  const f=createFixture(t), ref=f.event('범위를 정했다.');
  const data={topic:'범위',userRefs:[ref],interpretation:'범위',content:'# 범위'};
  assert.throws(()=>f.mutate('checkpoint',{...data,criteria:{},advance:true}),hasCode('INCOMPLETE_CRITERIA'));
  assert.equal(f.get().revision,0);assert.equal(filesIn(f.project).length,0);
  f.mutate('checkpoint',{...data,nextQuestion:'추가 조건?'});
  const before=f.get(), artifact=before.artifacts.find(a=>a.kind==='design')!;
  fs.writeFileSync(artifact.path,'# 사람이 수정한 문서');
  assert.throws(()=>f.mutate('checkpoint',{...data,userRefs:[f.event('조건 추가')],content:'# 덮어쓰기'}),hasCode('DOCUMENT_CONFLICT'));
  assert.equal(f.get().revision,before.revision);
  assert.equal(fs.readFileSync(artifact.path,'utf8'),'# 사람이 수정한 문서');
});

test('functional checkpoint advances to separate quality stage and quality targets cannot be deferred',t=>{
  const f=createFixture(t);
  f.mutate('checkpoint',{topic:'기능 범위',userRefs:[f.event()],interpretation:'사용자 기능 범위',content:'# 기능 범위',criteria:criteria('requirements'),advance:true});
  assert.equal(f.get().stage,'non-functional');
  assert.equal(f.get().stages.length,7);
  const ref=f.event('규모와 지연 목표, 장애와 보존, 권한, 비용 조건을 정했다.');
  const targets=criteria('non-functional');
  delete targets.cost;
  const data={topic:'품질 목표',userRefs:[ref],interpretation:'품질 조건',content:'# 품질 조건',advance:true};
  assert.throws(()=>f.mutate('checkpoint',{...data,criteria:targets}),hasCode('INCOMPLETE_CRITERIA'));
  const deferred=criteria('non-functional');deferred.latency={status:'deferred',evidence:'속도 미정',verification:'나중에 정한다.'};
  assert.throws(()=>f.mutate('checkpoint',{...data,criteria:deferred}),hasCode('BLOCKING_CRITERION'));
  const good=criteria('non-functional');good.evidence={status:'deferred',evidence:'실측 전 목표',verification:'대표 부하로 P95와 실패율을 측정한다.'};
  f.mutate('checkpoint',{...data,criteria:good});
  assert.equal(f.get().stage,'entities');
});

test('a focused next-stage question is stored atomically and survives pause and resume', t => {
  const f=createFixture(t), ref=f.event('그림 생성 결과를 나중에 확인한다.');
  const question='그림 생성 결과를 사용자가 얼마나 기다릴 수 있을까요?';
  const args=f.input({topic:'기능 범위',userRefs:[ref],interpretation:'결과를 나중에 확인한다.',content:'# 기능 범위',criteria:criteria('requirements'),advance:true,nextStageQuestion:question});
  const result=f.engine.execute('checkpoint',args) as View;
  assert.equal(result.workflow.stage,'non-functional');
  assert.equal(result.workflow.pendingQuestion?.text,question);
  const replay=f.engine.execute('checkpoint',args) as View;
  assert.equal(replay.replayed,true);
  f.mutate('pause');
  f.mutate('resume');
  const reopened=new Store(f.store.dir);
  try { assert.deepEqual(reopened.get(f.id).pendingQuestion,result.workflow.pendingQuestion); }
  finally { reopened.close(); }
  assert.match(fs.readFileSync(result.workflow.paths.obsidianNote,'utf8'),/얼마나 기다릴/);
});

test('stage questions use one open fallback and do not overwrite an existing waiting question', t => {
  const f=createFixture(t);
  f.mutate('checkpoint',{topic:'기능 범위',userRefs:[f.event()],interpretation:'기능 범위',content:'# 기능 범위',criteria:criteria('requirements'),advance:true});
  const pending=f.get().pendingQuestion!;
  assert.match(pending.text,/조건 하나/);
  assert.doesNotMatch(pending.text,/속도, 사용 규모/);
  f.mutate('pause');f.mutate('resume');
  assert.deepEqual(f.get().pendingQuestion,pending);
  const legacy=f.get();
  legacy.pendingQuestion!.text='예전 버전에서 이미 전달된 넓은 질문';
  f.store.put(legacy);
  f.mutate('pause');f.mutate('resume');
  assert.equal(f.get().pendingQuestion?.text,'예전 버전에서 이미 전달된 넓은 질문');
});

test('separate advance stores the selected next-stage question', t => {
  const f=createFixture(t);
  prepareStage(f);
  const question='사용자가 얼마나 오래 기다릴 수 있나요?';
  f.mutate('advance',{nextStageQuestion:question});
  assert.equal(f.get().stage,'non-functional');
  assert.equal(f.get().pendingQuestion?.text,question);
});

test('next-stage question requires an actual transition', t => {
  const f=createFixture(t), ref=f.event('범위를 정했다.');
  const before=f.get();
  assert.throws(()=>f.mutate('checkpoint',{topic:'범위',userRefs:[ref],interpretation:'범위',content:'# 범위',nextStageQuestion:'다음 단계 질문?'}),hasCode('INVALID_INPUT'));
  assert.equal(f.get().revision,before.revision);
  assert.deepEqual(filesIn(f.project),[]);
  assert.throws(()=>f.mutate('checkpoint',{topic:'범위',userRefs:[ref],interpretation:'범위',content:'# 범위',criteria:criteria('requirements'),advance:true,nextStageQuestion:''}),hasCode('INVALID_INPUT'));
  assert.equal(f.get().revision,before.revision);
  assert.deepEqual(filesIn(f.project),[]);
});

test('legacy six-stage workflows keep their original quality gate and order', t=>{
  const f=createFixture(t),w=f.get();w.stages=w.stages.filter(s=>s.stage!=='non-functional');f.store.put(w);
  answer(f);f.mutate('design',{content:'# 기존 요구사항'});
  assert.throws(()=>f.mutate('review',{criteria:criteria('requirements'),summary:'품질 누락'}),hasCode('INCOMPLETE_CRITERIA'));
  f.mutate('review',{criteria:{...criteria('requirements'),quality:{status:'met',evidence:'기존 품질 목표 확인'}},summary:'기존 기준 검토'});
  f.mutate('advance');assert.equal(f.get().stage,'entities');assert.equal(f.get().stages.length,6);
});
