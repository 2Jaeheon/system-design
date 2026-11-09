import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('isolated simulated turns persist a topic, resume it, and preserve a manual edit', t => {
  const base = mkdtempSync(join(tmpdir(), 'system-design-conversation-'));
  const project = join(base, 'project'), vault = join(base, 'vault'), state = join(base, 'state');
  mkdirSync(project); mkdirSync(vault);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cli = resolve('build/src/cli.js');
  const env = { ...process.env, SYSTEM_DESIGN_STATE_DIR: state };
  const owner = { host: 'codex', sessionId: 'simulated-conversation' };
  const run = (args: string[], input?: string) => {
    const p = spawnSync(process.execPath, [cli, ...args], { env, input, encoding: 'utf8' });
    assert.ok(p.stdout, p.stderr);
    return { status: p.status, body: JSON.parse(p.stdout) };
  };
  const call = (name: string, input: object) => run([name, '--input', JSON.stringify(input)]);
  const prompt = (id: string, text: string) => run(['hook', '--host', 'codex'], JSON.stringify({
    hook_event_name: 'UserPromptSubmit', session_id: owner.sessionId, turn_id: id, cwd: project, prompt: text,
  }));

  // These are explicitly simulated events, not user decisions or a model conversation.
  prompt('sim-1', '$system-design:system-design 메모 생성 실패를 설계해줘');
  assert.equal(call('setup', { owner, obsidianVault: vault, obsidianFolder: 'notes', archiveEnabled: false }).status, 0);
  const started = call('start', { owner, title: '[가상] 메모 생성 실패', projectRoot: project,
    designDir: 'docs/design', adrDir: 'docs/adr', obsidianNote: 'notes/progress.md' });
  assert.equal(started.status, 0);
  const workflowId = started.body.result.workflowId;
  assert.equal(started.body.result.stage, 'requirements');
  prompt('sim-2', '[가상 답변] 실패한 요청의 내용을 남겨서 다시 시도하고 싶어요.');
  const ref = { ...owner, actor: 'user', eventId: 'sim-2' };
  const input = { workflowId, owner, expectedRevision: 0, operationId: 'simulated-save', topic: '[가상] 실패 요청',
    interpretation: '[가상] 실패한 요청 내용을 보존한다.', userRefs: [ref],
    content: '# 가상 요구사항\n\n실패한 요청 내용을 보존한다.\n\n현재 확인: 요청 처리 코드.\n미확인: 외부 서비스 응답.\n',
    nextQuestion: '실패한 요청을 언제 다시 시도할까요?' };
  const saved = call('checkpoint', input);
  assert.equal(saved.status, 0);
  assert.equal(saved.body.result.expectedRevision, 1);
  assert.equal(saved.body.result.obsidianPending, false);
  const doc = saved.body.result.artifacts.find((a: { id: string }) => a.id === 'design-requirements').path;
  assert.match(readFileSync(doc, 'utf8'), /미확인: 외부 서비스 응답/);
  assert.ok(readFileSync(join(vault, 'notes/progress.md'), 'utf8').includes('실패한 요청'));
  assert.equal(call('checkpoint', input).body.result.replayed, true);
  const resumed = call('status', { owner, detail: 'full' }).body.result[0].workflow;
  assert.equal(resumed.revision, 1);
  assert.equal(resumed.pendingQuestion.text, input.nextQuestion);
  assert.equal(resumed.run, 'designing');
  writeFileSync(doc, '# 사람이 직접 남긴 변경\n');
  prompt('sim-3', '[가상 답변] 사용자가 직접 다시 시도해요.');
  const conflict = call('checkpoint', { ...input, expectedRevision: 1, operationId: 'simulated-conflict',
    userRefs: [{ ...owner, actor: 'user', eventId: 'sim-3' }] });
  assert.notEqual(conflict.status, 0);
  assert.equal(conflict.body.error.code, 'DOCUMENT_CONFLICT');
  assert.equal(readFileSync(doc, 'utf8'), '# 사람이 직접 남긴 변경\n');
  assert.equal(call('status', { owner, detail: 'full' }).body.result[0].workflow.revision, 1);
});

test('isolated CLI saves the initial request without asking for the same thought again', t => {
  const base=mkdtempSync(join(tmpdir(),'system-design-initial-turn-'));
  const project=join(base,'project'),vault=join(base,'vault'),state=join(base,'state');
  mkdirSync(project);mkdirSync(vault);
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const cli=resolve('build/src/cli.js'),env={...process.env,SYSTEM_DESIGN_STATE_DIR:state};
  const owner={host:'codex',sessionId:'initial-turn'},ref={...owner,actor:'user',eventId:'initial-1'};
  const run=(args:string[],input?:string)=>{
    const child=spawnSync(process.execPath,[cli,...args],{env,input,encoding:'utf8'});
    assert.ok(child.stdout,child.stderr);return {status:child.status,body:JSON.parse(child.stdout)};
  };
  const call=(command:string,input:object)=>run([command,'--input',JSON.stringify(input)]);
  const hook=run(['hook','--host','codex'],JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:owner.sessionId,turn_id:ref.eventId,cwd:project,
    prompt:'[가상] 이 기능을 $system-design:system-design 으로 설계해줘. 실패한 요청은 다시 시도할 수 있게 남기고 싶어요.'}));
  assert.equal(hook.status,0);assert.match(JSON.stringify(hook.body),/initial-1/u);
  assert.equal(call('setup',{owner,obsidianVault:vault,obsidianFolder:'notes',archiveEnabled:false}).status,0);
  const started=call('start',{owner,title:'[가상] 실패 요청',projectRoot:project,designDir:'docs/design',adrDir:'docs/adr',obsidianNote:'notes/progress.md',
    initialUserRef:ref,firstQuestion:'재시도는 누가 시작하나요?'});
  assert.equal(started.status,0);assert.equal(started.body.result.pendingQuestion.text,'재시도는 누가 시작하나요?');
  assert.deepEqual(started.body.result.initialUserRef,ref);
  assert.deepEqual(call('status',{owner}).body.result[0].initialUserRef,ref);
  const saved=call('checkpoint',{workflowId:started.body.result.workflowId,owner,expectedRevision:0,operationId:'save-initial',
    topic:'실패 요청 보존',interpretation:'실패한 요청을 다시 시도할 수 있게 남긴다.',userRefs:[ref],
    content:'# 실패 요청 보존\n\n실패한 요청을 다시 시도할 수 있게 남긴다.',nextQuestion:'재시도는 누가 시작하나요?'});
  assert.equal(saved.status,0);assert.equal(saved.body.result.expectedRevision,1);
  const resumed=call('status',{owner,detail:'full'}).body.result[0].workflow;
  assert.deepEqual(resumed.stages[0].thoughtRef,ref);
  assert.equal(resumed.pendingQuestion.text,'재시도는 누가 시작하나요?');
});
