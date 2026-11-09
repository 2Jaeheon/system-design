import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fingerprintTool, isExplicitInvocation, isReadOnlyShell, parseCoreInvocation,
  processHook, tokenizeReadCommand, type HookPort, type SessionBinding,
} from '../src/hooks.js';
import { STAGES, type Host, type UserRef, type Workflow } from '../src/types.js';

const CLI = '/plugins/system-design/runtime/cli.js';
const owner = { host: 'codex' as const, sessionId: 'session-1' };
function workflow(): Workflow {
  return {
    id: 'work-1', title: '테스트 설계', projectRoot: '/project', owner, revision: 3,
    stage: 'requirements', interview: 'awaiting_thought', run: 'designing', paused: false,
    stages: STAGES.map(stage => ({ stage, status: stage === 'requirements' ? 'active' : 'pending', criteria: {} })),
    openItems: [], decisions: [], learning: [], artifacts: [],
    paths: { designDir: '/project/docs/system-design', adrDir: '/project/docs/adr', obsidianNote: '/notes/project.md' },
    obsidianPending: false, createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z',
  };
}
function fixture(binding?: SessionBinding) {
  const events: { host: Host; sessionId: string; eventId: string; hash: string }[] = [];
  const grants = new Set<string>();
  const consumed: string[] = [];
  const archived: string[] = [];
  const refs: UserRef[] = [];
  const invoked = new Set<string>();
  const port: HookPort = {
    cliPath: CLI,
    findSession: () => binding,
    markInvoked: (host, sessionId) => { invoked.add(`${host}:${sessionId}`); },
    isInvokedSession: (host, sessionId) => invoked.has(`${host}:${sessionId}`),
    recordUserEvent: (host, sessionId, eventId, hash) => {
      events.push({ host, sessionId, eventId, hash });
      const ref: UserRef = { host, sessionId, eventId, actor: 'user' }; refs.push(ref); return ref;
    },
    latestUserRef: () => refs.at(-1),
    context: work => `현재 단계: ${work.stage}\n버전: ${work.revision}`,
    consumeGrant: (_work, _owner, digest) => {
      if (!grants.delete(digest)) return false;
      consumed.push(digest); return true;
    },
  };
  return { port, events, grants, consumed, archived, refs, invoked };
}
function event(toolName: string, toolInput: unknown = {}, extras = {}) {
  return { session_id: owner.sessionId, cwd: '/project', hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, ...extras };
}
function denied(result: Record<string, unknown>): string | undefined {
  const output = result.hookSpecificOutput as Record<string, unknown> | undefined;
  if (output?.permissionDecision !== 'deny') return undefined;
  return output.permissionDecisionReason as string;
}
const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";

test('explicit invocation does not activate from incidental prose', () => {
  for (const prompt of ['$system-design', '$system-design 시작', '/system-design:setup', 'system-design 시작', '  /system-design:system-design 설계']) assert.equal(isExplicitInvocation(prompt), true);
  for (const prompt of ['지난번 system-design 얘기를 정리해줘', 'system-design-plugin 설치', 'system-design이라는 이름', '다른 일을 진행해줘', '']) assert.equal(isExplicitInvocation(prompt), false);
});

test('native skill mentions activate anywhere outside Markdown code', () => {
  const mention = '[$system-design:system-design](/plugins/system-design/skills/system-design/SKILL.md)';
  assert.equal(isExplicitInvocation(mention + ' 설계 시작'), true);
  assert.equal(isExplicitInvocation('  [$system-design](</plugins/with spaces/system-design/SKILL.md>)'), true);
  assert.equal(isExplicitInvocation('이 기능을 ' + mention + ' 으로 설계해줘'), true);
  assert.equal(isExplicitInvocation('예약 기능을 $system-design:system-design 으로 설계해줘'), true);
  assert.equal(isExplicitInvocation('예약 기능을 /system-design:system-design 으로 설계해줘'), true);
  for (const prompt of [
    '`' + mention + '`',
    '```markdown\n' + mention + '\n```',
    '~~~markdown\n$system-design:system-design\n~~~',
    '[$system-design-other](/plugins/system-design/SKILL.md)',
    '[$other:system-design](/plugins/system-design/SKILL.md)',
  ]) assert.equal(isExplicitInvocation(prompt), false, prompt);
  const f = fixture();
  const result = processHook('codex', { session_id: owner.sessionId, cwd: '/project', hook_event_name: 'UserPromptSubmit', turn_id: 'native-mention', prompt: mention + ' 원문 고유표시 8241' }, f.port);
  assert.equal(f.events.length, 1);
  assert.match(JSON.stringify(result), /native-mention/u);
  assert.equal(JSON.stringify([result, f.events]).includes('8241'), false);
});

test('shell tokenizer permits quoted data and rejects execution syntax', () => {
  assert.deepEqual(tokenizeReadCommand("cat 'file with spaces.md'"), ['cat', 'file with spaces.md']);
  const json = JSON.stringify({ content: '사용자 --> API', choice: "it's a literal $(touch /tmp/x)" });
  assert.deepEqual(tokenizeReadCommand(`node '${CLI}' design --input ${shellQuote(json)}`), ['node', CLI, 'design', '--input', json]);
  for (const command of ['cat x; touch y', 'cat x && rm y', 'cat x | sh', 'cat $(touch x)', 'cat `touch x`', 'cat "$(touch x)"', 'cat x > y', 'node -e "1"', 'cat *.md', 'cat x\nrm y']) {
    assert.equal(isReadOnlyShell(command), false, command);
  }
});

test('only known executable paths and bounded read flags pass', () => {
  for (const command of ['pwd', 'ls -la /project', 'cat /project/readme.md', "sed -n '1,30p' /project/a.ts", "rg --no-config -n 'todo' /project/src", 'git status --short', 'git --no-pager log -n 3 --oneline', 'git diff --no-ext-diff --no-textconv --stat']) assert.equal(isReadOnlyShell(command), true, command);
  for (const command of ['/tmp/cat file', "sed -n '1e touch x' file", 'sed -i backup file', 'rg --pre tool text src', 'rg --no-config --pre tool text src', 'rg --no-config --pre=tool text src', 'rg text src', 'git -c alias.x=!touch x', 'git checkout main', 'git diff', 'git log -p', 'tail -f logfile', 'env node anything', 'sh -c pwd']) assert.equal(isReadOnlyShell(command), false, command);
});

test('trusted CLI requires exact path and JSON or explicit stdin shape', () => {
  const input = { workflowId: 'work-1', content: "literal ' and >" };
  assert.deepEqual(parseCoreInvocation(`node '${CLI}' design --input ${shellQuote(JSON.stringify(input))}`, CLI), { command: 'design', input, stdin: false });
  assert.equal(parseCoreInvocation(`node /tmp/cli.js design --input '{}'`, CLI), undefined);
  assert.equal(parseCoreInvocation(`node '${CLI}' hook --host codex`, CLI), undefined);
  assert.equal(parseCoreInvocation(`node -e "import('${CLI}')"`, CLI), undefined);
  assert.equal(parseCoreInvocation(`node '${CLI}' design --input '[]'`, CLI), undefined);
  assert.equal(parseCoreInvocation(`node '${CLI}' design --input '{}' > /project/a`, CLI), undefined);
});

test('unrelated and completed workflows do not intercept tools or retain prompts', () => {
  for (const binding of [undefined, { workflow: { ...workflow(), run: 'complete' as const }, readOnly: false }]) {
    const f = fixture(binding);
    assert.deepEqual(processHook('codex', event('Write', { file_path: '/project/a.ts', content: 'new' }), f.port), {});
    assert.deepEqual(processHook('codex', { session_id: 'session-1', cwd: '/project', hook_event_name: 'UserPromptSubmit', prompt: '개인적인 대화 내용' }, f.port), {});
    assert.equal(f.events.length, 0);
  }
});

test('explicit initial prompt stores only a user turn hash and supplies references', () => {
  const f = fixture();
  const prompt = '$system-design 시작. 보관하지 않을 원문 7319';
  const result = processHook('codex', { session_id: 'session-1', cwd: '/project', hook_event_name: 'UserPromptSubmit', turn_id: 'turn-7', prompt }, f.port);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0]!.eventId, 'turn-7');
  assert.match(f.events[0]!.hash, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(f.events).includes(prompt), false);
  assert.equal(JSON.stringify(result).includes('7319'), false);
  assert.match(JSON.stringify(result), /turn-7/u);
  assert.match(JSON.stringify(result), /runtime\/cli.js/u);
  assert.match(JSON.stringify(result), /실제 설계를 요청한 경우에만/u);
  assert.match(JSON.stringify(result), /리뷰, 수정 또는 설치 요청/u);
});

test('Claude prompt gets its own user reference without original text', () => {
  const work = workflow(); work.owner = { host: 'claude', sessionId: 'claude-1' };
  const f = fixture({ workflow: work, readOnly: false });
  const result = processHook('claude', { session_id: 'claude-1', cwd: '/project', hook_event_name: 'UserPromptSubmit', prompt: '이것은 원문입니다 5528' }, f.port);
  assert.equal(f.events[0]!.host, 'claude');
  assert.match(f.events[0]!.eventId, /^prompt-/u);
  assert.equal(JSON.stringify(result).includes('5528'), false);
});

test('setup followup answers retain references until onboarding is deactivated', () => {
  const f = fixture();
  const promptEvent = (prompt: string, turn_id: string) => ({ session_id: owner.sessionId, cwd: '/project', hook_event_name: 'UserPromptSubmit', prompt, turn_id });
  processHook('codex', promptEvent('$system-design:setup', 'turn-1'), f.port);
  const second = processHook('codex', promptEvent('추가 원문 보관은 하지 않을게', 'turn-2'), f.port);
  assert.equal(f.events.length, 2);
  assert.match(JSON.stringify(second), /turn-2/u);
  assert.equal(JSON.stringify(second).includes('추가 원문 보관은'), false);
  f.invoked.clear();
  assert.deepEqual(processHook('codex', promptEvent('다른 이야기', 'turn-3'), f.port), {});
  assert.equal(f.events.length, 2);
});

test('completed work does not revive capture from a stale invocation marker', () => {
  const work = workflow(); work.run = 'complete';
  const f = fixture({ workflow: work, readOnly: false });
  f.invoked.add('codex:session-1');
  assert.deepEqual(processHook('codex', { session_id: owner.sessionId, cwd: '/project', hook_event_name: 'UserPromptSubmit', prompt: '이제 다른 일 하자' }, f.port), {});
  assert.equal(f.events.length, 0);
});

test('archiving is delegated only for the owning active workflow', () => {
  const work = workflow();
  const f = fixture({ workflow: work, readOnly: false });
  f.port.archivePrompt = (_work, prompt) => f.archived.push(prompt);
  processHook('codex', { session_id: 'session-1', cwd: '/project', hook_event_name: 'UserPromptSubmit', prompt: 'opt-in callback content' }, f.port);
  assert.deepEqual(f.archived, ['opt-in callback content']);
  const stale = fixture({ workflow: work, readOnly: true });
  stale.port.archivePrompt = (_work, prompt) => stale.archived.push(prompt);
  processHook('codex', { session_id: 'session-1', cwd: '/project', hook_event_name: 'UserPromptSubmit', prompt: 'old owner' }, stale.port);
  assert.deepEqual(stale.archived, []);
});

test('design phase blocks Codex patches and Claude native edits', () => {
  const f = fixture({ workflow: workflow(), readOnly: false });
  const patch = '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch';
  assert.match(denied(processHook('codex', event('apply_patch', { command: patch }), f.port))!, /제품 코드/u);
  assert.match(denied(processHook('codex', event('Write', { file_path: '/project/src/app.ts', content: 'x' }), f.port))!, /제품 코드/u);
  assert.match(denied(processHook('codex', event('NotebookEdit', { notebook_path: '/project/notebook.ipynb' }), f.port))!, /제품 코드/u);
});

test('managed documents must go through the conflict-aware writer', () => {
  const work = workflow(); work.run = 'implementing';
  const f = fixture({ workflow: work, readOnly: false });
  for (const path of ['/project/docs/adr/a.md', '/project/docs/system-design/a.md', '/notes/project.md']) {
    assert.match(denied(processHook('codex', event('Write', { file_path: path, content: 'x' }), f.port))!, /진행 관리 CLI/u);
  }
  const patch = '*** Begin Patch\n*** Update File: src/app.ts\n*** Move to: docs/adr/a.md\n@@\n-x\n+y\n*** End Patch';
  assert.match(denied(processHook('codex', event('apply_patch', { command: patch }), f.port))!, /진행 관리 CLI/u);
  assert.deepEqual(processHook('codex', event('Edit', { file_path: '/project/src/app.ts' }), f.port), {});
});

test('safe calls leave host permissions unchanged, never return broad allow', () => {
  const f = fixture({ workflow: workflow(), readOnly: false });
  for (const [name, input] of [['Read', { file_path: '/project/a.ts' }], ['Bash', { command: 'cat /project/a.ts' }], ['AskUserQuestion', {}], ['functions.exec', { code: 'orchestration' }]] as const) {
    assert.deepEqual(processHook('codex', event(name, input), f.port), {});
  }
  assert.ok(denied(processHook('codex', event('mcp__unknown__read_file', {}), f.port)));
});

test('trusted CLI stays available without enabling arbitrary interpreter calls', () => {
  const f = fixture({ workflow: workflow(), readOnly: false });
  assert.deepEqual(processHook('codex', event('Bash', { command: `node '${CLI}' answer --input ${shellQuote(JSON.stringify({ owner }))}` }), f.port), {});
  const readOnly = fixture({ workflow: workflow(), readOnly: true });
  assert.deepEqual(processHook('codex', event('Bash', { command: `node '${CLI}' settings --input '{}'` }), readOnly.port), {});
  assert.ok(denied(processHook('codex', event('Bash', { command: `node '${CLI}' answer --stdin` }), f.port)));
  assert.ok(denied(processHook('codex', event('Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"' }), f.port)));
});

test('trusted mutations use the actual hook owner and cannot be granted around', () => {
  const f = fixture({ workflow: workflow(), readOnly: false });
  for (const supplied of [undefined, { host: 'claude', sessionId: owner.sessionId }, { host: owner.host, sessionId: 'another-task' }]) {
    const input = { command: `node '${CLI}' answer --input ${shellQuote(JSON.stringify({ owner: supplied }))}` };
    f.grants.add(fingerprintTool('Bash', input, '/project'));
    assert.match(denied(processHook('codex', event('Bash', input), f.port))!, /현재 호스트와 세션/u);
  }
  assert.equal(f.consumed.length, 0);
});

test('document recovery is a trusted mutation restricted to the actual owner', () => {
  const call = event('Bash', { command: `node '${CLI}' recover --input ${shellQuote(JSON.stringify({ owner }))}` });
  assert.deepEqual(processHook('codex', call, fixture({ workflow: workflow(), readOnly: false }).port), {});
  assert.ok(denied(processHook('codex', call, fixture({ workflow: workflow(), readOnly: true }).port)));
  assert.ok(denied(processHook('codex', { ...call, agent_id: 'child' }, fixture({ workflow: workflow(), readOnly: false }).port)));
});

test('invoked onboarding binds setup owner before a workflow exists', () => {
  const f = fixture();
  f.invoked.add('codex:session-1');
  const setup = (submitted: unknown) => event('Bash', { command: `node '${CLI}' setup --input ${shellQuote(JSON.stringify({ owner: submitted }))}` });
  assert.deepEqual(processHook('codex', setup(owner), f.port), {});
  assert.match(denied(processHook('codex', setup({ host: 'codex', sessionId: 'other' }), f.port))!, /현재 호스트와 세션/u);
  assert.ok(denied(processHook('codex', { ...setup(owner), agent_id: 'child' }, f.port)));
});

test('unknown-call grants match exact canonical input and working directory once', () => {
  const work = workflow(); const f = fixture({ workflow: work, readOnly: false });
  const input = { command: 'custom-read-tool', timeout_ms: 1000 };
  const digest = fingerprintTool('Bash', input, '/project');
  assert.equal(digest, fingerprintTool('Bash', { timeout_ms: 1000, command: 'custom-read-tool' }, '/project'));
  assert.notEqual(digest, fingerprintTool('Bash', input, '/elsewhere'));
  f.grants.add(digest);
  assert.ok(denied(processHook('codex', event('Bash', { ...input, command: 'custom-write-tool' }), f.port)));
  assert.deepEqual(processHook('codex', event('Bash', input), f.port), {});
  assert.ok(denied(processHook('codex', event('Bash', input), f.port)));
  assert.deepEqual(f.consumed, [digest]);
});

test('a product edit cannot be authorized by an unknown-command grant', () => {
  const f = fixture({ workflow: workflow(), readOnly: false });
  const input = { file_path: '/project/app.ts', content: 'changed' };
  f.grants.add(fingerprintTool('Write', input, '/project'));
  assert.ok(denied(processHook('codex', event('Write', input), f.port)));
  assert.equal(f.consumed.length, 0);
});

test('old owners retain only read access after handoff, including during implementation', () => {
  const work = workflow(); work.owner = { host: 'claude', sessionId: 'next-session' }; work.run = 'implementing';
  const f = fixture({ workflow: work, readOnly: false });
  assert.deepEqual(processHook('codex', event('Bash', { command: 'cat /project/a.ts' }), f.port), {});
  assert.deepEqual(processHook('codex', event('Bash', { command: `node '${CLI}' status --input '{}'` }), f.port), {});
  assert.ok(denied(processHook('codex', event('Bash', { command: `node '${CLI}' resume --input '{}'` }), f.port)));
  assert.ok(denied(processHook('codex', event('Bash', { command: 'touch /project/a.ts' }), f.port)));
  assert.ok(denied(processHook('codex', event('Agent', {}), f.port)));
});

test('paused workflows keep product changes and exceptional calls blocked', () => {
  const work = workflow(); work.run = 'implementing'; work.paused = true;
  const f = fixture({ workflow: work, readOnly: false });
  const input = { command: 'custom-tool' }; f.grants.add(fingerprintTool('Bash', input, '/project'));
  assert.ok(denied(processHook('codex', event('Bash', input), f.port)));
  assert.deepEqual(processHook('codex', event('Bash', { command: 'pwd' }), f.port), {});
});

test('identified subagents inherit restrictions and cannot accept decisions', () => {
  const f = fixture({ workflow: workflow(), readOnly: false });
  const extras = { agent_id: 'child-1' };
  assert.ok(denied(processHook('codex', event('Bash', { command: `node '${CLI}' decision-accept --input '{}'` }, extras), f.port)));
  assert.deepEqual(processHook('codex', event('Bash', { command: 'cat /project/a.ts' }, extras), f.port), {});
  assert.match(JSON.stringify(processHook('codex', { session_id: owner.sessionId, cwd: '/project', hook_event_name: 'SubagentStart', agent_id: 'child-1' }, f.port)), /부모 대화/u);
});

test('resume supplies state context and Stop does not restart a waiting interview', () => {
  const f = fixture({ workflow: workflow(), readOnly: false });
  assert.match(JSON.stringify(processHook('codex', { session_id: owner.sessionId, cwd: '/project', hook_event_name: 'SessionStart', source: 'resume' }, f.port)), /requirements/u);
  assert.deepEqual(processHook('codex', { session_id: owner.sessionId, cwd: '/project', hook_event_name: 'Stop' }, f.port), {});
});

test('errors never expose user or tool payloads and pre-tool failures deny safely', () => {
  const f = fixture();
  f.port.findSession = () => { throw new Error('secret-raw-payload'); };
  const result = processHook('codex', event('Bash', { command: 'secret-raw-payload' }), f.port);
  assert.ok(denied(result));
  assert.equal(JSON.stringify(result).includes('secret-raw-payload'), false);
  assert.deepEqual(processHook('codex', null, f.port), {});
});

test('ordinary turns do not inject stale questions or duplicate full state; checkpoints remain guarded',()=>{
 const w=workflow();w.pendingQuestion={id:'q-old',stage:'requirements',kind:'thought',text:'OLD-SAVED-QUESTION'};
 const f=fixture({workflow:w,readOnly:false});
 const result=processHook('codex',{session_id:owner.sessionId,cwd:'/project',hook_event_name:'UserPromptSubmit',turn_id:'topic-turn',prompt:'새 질문에 답한다.'},f.port);
 const text=JSON.stringify(result);
 assert.ok(!text.includes('OLD-SAVED-QUESTION'));
 assert.ok(text.includes('topic-turn'));assert.ok(text.includes('expectedRevision'));
 const command=`node '${CLI}' checkpoint --input '${JSON.stringify({owner,workflowId:w.id,expectedRevision:0,operationId:'topic'})}'`;
 assert.deepEqual(processHook('codex',event('Bash',{command}),f.port),{});
 assert.ok(denied(processHook('codex',event('Bash',{command},{agent_id:'child'}),f.port)));
});
