import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, normalize, resolve } from 'node:path';
import type { Host, Owner, UserRef, Workflow } from './types.js';

export interface SessionBinding { workflow: Workflow; readOnly: boolean }
export interface HookPort {
  /** Absolute path to the installed, trusted CLI entry point. */
  cliPath: string;
  nodePath?: string;
  safeReadTools?: readonly string[];
  findSession(host: Host, sessionId: string, cwd: string): SessionBinding | undefined;
  markInvoked?(host: Host, sessionId: string): void;
  isInvokedSession?(host: Host, sessionId: string): boolean;
  recordUserEvent(host: Host, sessionId: string, eventId: string, promptHash: string): UserRef;
  latestUserRef(host: Host, sessionId: string): UserRef | undefined;
  context(workflow: Workflow): string;
  consumeGrant(workflow: Workflow, owner: Owner, fingerprint: string): boolean;
  /** The implementation must check opt-in before retaining any text. */
  archivePrompt?(workflow: Workflow, prompt: string, userRef: UserRef): void;
}
export type HookOutput = Record<string, unknown>;
type JsonObject = Record<string, unknown>;

const CORE_COMMANDS = new Set([
  'checkpoint', 'setup', 'start', 'status', 'settings', 'resume', 'pause', 'handoff', 'question', 'answer',
  'answer-revise', 'explain', 'learning', 'issue', 'design', 'review', 'advance', 'reopen',
  'decision-propose', 'decision-accept', 'decision-retitle', 'decision-supersede', 'reconcile', 'recover',
  'sync', 'implement', 'verify', 'complete', 'grant', 'archive', 'help',
]);
const CORE_READ_COMMANDS = new Set(['status', 'help', 'settings']);
const READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'Search', 'WebSearch', 'WebFetch', 'ToolSearch',
  'read_file', 'list_dir', 'list_files', 'search_text', 'view_image',
  'AskUserQuestion', 'request_user_input', 'functions.request_user_input',
  'update_plan', 'get_plan', 'wait', 'wait_agent', 'list_agents',
]);
const ORCHESTRATION_TOOLS = new Set([
  'functions.exec', 'multi_tool_use.parallel', 'Agent', 'Task', 'spawn_agent',
]);
const EDIT_TOOLS = new Set(['apply_patch', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as JsonObject;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** This digest is only a call identifier. It does not authorize the call. */
export function fingerprintTool(toolName: string, toolInput: unknown, cwd = ''): string {
  return createHash('sha256').update(canonical({ toolName, toolInput, cwd })).digest('hex');
}

export function isExplicitInvocation(prompt: string): boolean {
  // Do not activate from a skill name shown as an example in Markdown code.
  let fence: string | undefined;
  const outsideFences = prompt.split('\n').map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`{3,}|~{3,})\s*$/u.test(line)) fence = undefined;
      return '';
    }
    if (marker) { fence = marker; return ''; }
    return line;
  }).join('\n').replace(/(`+)[\s\S]*?\1/gu, ' ');
  const trimmed = outsideFences.trimStart();
  return /^system-design(?=$|\s)/u.test(trimmed)
    || /(?:^|[^\p{L}\p{N}_\\$])\$system-design(?::[a-z-]+)?(?![a-z0-9_-])/u.test(outsideFences)
    || /(?:^|\s)\/system-design(?::[a-z-]+)?(?=$|\s|[.,!?])/u.test(outsideFences);
}

/**
 * A deliberately small shell grammar. Shell operators and expansion are not
 * accepted, even if the resulting command might happen to be read-only.
 * Quoted JSON is data, so characters such as > inside quotes remain usable.
 */
export function tokenizeReadCommand(command: string): string[] | undefined {
  if (!command || command.length > 524_288 || command.includes('\0')) return undefined;
  const words: string[] = [];
  let current = '';
  let started = false;
  let quote: 'single' | 'double' | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote === 'single') {
      if (char === "'") quote = undefined;
      else current += char;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') { quote = undefined; continue; }
      if (char === '$' || char === '`') return undefined;
      if (char === '\\') {
        const next = command[++index];
        if (next === undefined || next === '\n' || next === '\r') return undefined;
        if ('"\\$`'.includes(next)) current += next;
        else current += `\\${next}`;
      } else current += char;
      continue;
    }
    if (char === "'") { quote = 'single'; started = true; continue; }
    if (char === '"') { quote = 'double'; started = true; continue; }
    if (char === '\\') {
      const next = command[++index];
      if (next === undefined || next === '\n' || next === '\r') return undefined;
      current += next; started = true; continue;
    }
    if ('\n\r;|&<>`$(){}*?[]'.includes(char)) return undefined;
    if (/\s/u.test(char)) {
      if (started) { words.push(current); current = ''; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) return undefined;
  if (started) words.push(current);
  return words.length ? words : undefined;
}

function knownBinary(word: string, name: string, extraPath?: string): boolean {
  if (word === name) return true;
  if (!isAbsolute(word)) return false;
  if (extraPath && normalize(word) === normalize(extraPath)) return true;
  return [`/bin/${name}`, `/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`].includes(word);
}

function flagsAndOperands(
  args: readonly string[], boolFlags: ReadonlySet<string>, valueFlags: ReadonlySet<string>,
  validateValue: (flag: string, value: string) => boolean = () => true,
): boolean {
  let positional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (positional) continue;
    if (arg === '--') { positional = true; continue; }
    if (!arg.startsWith('-') || arg === '-') continue;
    const equal = arg.indexOf('=');
    const flag = equal > -1 ? arg.slice(0, equal) : arg;
    if (boolFlags.has(arg)) continue;
    if (valueFlags.has(flag)) {
      const value = equal > -1 ? arg.slice(equal + 1) : args[++index];
      if (value === undefined || !validateValue(flag, value)) return false;
      continue;
    }
    return false;
  }
  return true;
}

function isReadOnlyGit(args: readonly string[]): boolean {
  // Do not accept arbitrary git config, aliases, pagers, external diff or textconv.
  let index = 0;
  while (args[index] === '--no-pager' || args[index] === '--no-optional-locks') index++;
  const verb = args[index++];
  const tail = args.slice(index);
  if (verb === 'status') return flagsAndOperands(tail,
    new Set(['--short', '-s', '--branch', '-b', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--untracked-files=no', '--untracked-files=normal', '--untracked-files=all', '-uno', '-unormal', '-uall', '--ignored', '-z']), new Set());
  if (verb === 'rev-parse') return flagsAndOperands(tail,
    new Set(['--show-toplevel', '--show-prefix', '--show-cdup', '--git-dir', '--git-common-dir', '--absolute-git-dir', '--is-inside-work-tree', '--is-bare-repository', '--abbrev-ref', '--verify', '--quiet', '-q', '--short', '--end-of-options']), new Set());
  if (verb === 'ls-files') return flagsAndOperands(tail,
    new Set(['--cached', '-c', '--deleted', '-d', '--modified', '-m', '--others', '-o', '--ignored', '-i', '--stage', '-s', '--unmerged', '-u', '--exclude-standard', '-z', '--full-name', '--error-unmatch']), new Set());
  if (verb === 'diff') {
    // Requiring both disables execution through repository-defined diff drivers.
    if (!tail.includes('--no-ext-diff') || !tail.includes('--no-textconv')) return false;
    return flagsAndOperands(tail, new Set(['--no-ext-diff', '--no-textconv', '--no-color', '--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--cached', '--staged', '--check', '--quiet', '--exit-code', '--patch', '-p', '--raw', '-z']), new Set());
  }
  if (verb === 'log') {
    // --no-pager avoids custom pager execution; no patch/stat/textconv options.
    if (!args.slice(0, index - 1).includes('--no-pager')) return false;
    return flagsAndOperands(tail,
      new Set(['--oneline', '--decorate', '--no-decorate', '--all', '--branches', '--tags', '--reverse', '--no-merges', '--merges', '--no-color', '--no-show-signature']),
      new Set(['-n', '--max-count', '--format', '--pretty', '--since', '--until', '--author']),
      (flag, value) => flag === '-n' || flag === '--max-count' ? /^\d+$/u.test(value) : !value.includes('\0'));
  }
  return false;
}

export function isReadOnlyShell(command: string): boolean {
  const words = tokenizeReadCommand(command);
  if (!words) return false;
  const [binary, ...args] = words;
  if (!binary) return false;
  if (knownBinary(binary, 'pwd')) return args.every(arg => ['-L', '-P'].includes(arg));
  if (knownBinary(binary, 'ls')) return flagsAndOperands(args,
    new Set(['-a', '-A', '-l', '-la', '-al', '-lah', '-alh', '-ld', '-d', '-h', '-lh', '-1', '-R', '-F', '--all', '--almost-all', '--directory', '--human-readable', '--color=never']), new Set());
  if (knownBinary(binary, 'cat')) return flagsAndOperands(args,
    new Set(['-n', '-b', '-s', '-v', '-e', '-t', '-A', '-E', '-T', '--number', '--number-nonblank', '--squeeze-blank']), new Set());
  if (knownBinary(binary, 'head') || knownBinary(binary, 'tail')) return flagsAndOperands(args,
    new Set(['-q', '-v', '--quiet', '--verbose']), new Set(['-n', '-c', '--lines', '--bytes']),
    (_flag, value) => /^\+?\d+$/u.test(value));
  if (knownBinary(binary, 'wc')) return flagsAndOperands(args,
    new Set(['-l', '-w', '-c', '-m', '-L', '--lines', '--words', '--bytes', '--chars', '--max-line-length']), new Set());
  if (knownBinary(binary, 'sed')) {
    // Only address ranges ending in p. sed -f/-i/e/w and general scripts are denied.
    return args[0] === '-n' && !!args[1] && /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/u.test(args[1])
      && args.slice(2).every(arg => !arg.startsWith('-'));
  }
  if (knownBinary(binary, 'rg')) return flagsAndOperands(args,
    new Set(['--files', '--hidden', '--no-ignore', '--no-ignore-vcs', '--ignore-case', '-i', '--case-sensitive', '-s', '--smart-case', '-S', '--fixed-strings', '-F', '--line-number', '-n', '--with-filename', '-H', '--no-heading', '--heading', '--count', '-c', '--count-matches', '--files-with-matches', '-l', '--files-without-match', '--only-matching', '-o', '--invert-match', '-v', '--multiline', '-U', '--multiline-dotall', '--word-regexp', '-w', '--line-regexp', '-x', '--no-messages', '--quiet', '-q', '--json', '--null', '-0', '--no-config', '--no-pcre2-unicode', '--pcre2', '-P', '--color=never', '--text', '-a']),
    new Set(['-e', '--regexp', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '--max-depth', '-A', '--after-context', '-B', '--before-context', '-C', '--context', '--context-separator', '--max-columns', '--max-filesize', '--encoding']),
    (_flag, value) => !value.includes('\0')) && args.includes('--no-config');
  if (knownBinary(binary, 'git')) return isReadOnlyGit(args);
  return false;
}

export interface CoreInvocation { command: string; input?: JsonObject; stdin: boolean }
export function parseCoreInvocation(command: string, cliPath: string, nodePath = process.execPath): CoreInvocation | undefined {
  const words = tokenizeReadCommand(command);
  if (!words || !knownBinary(words[0]!, 'node', nodePath) || words[1] !== cliPath || !isAbsolute(cliPath)) return undefined;
  const name = words[2];
  if (!name || !CORE_COMMANDS.has(name)) return undefined;
  if (words.length === 3) return { command: name, stdin: false };
  if (words.length === 4 && words[3] === '--stdin') return { command: name, stdin: true };
  if (words.length !== 5 || words[3] !== '--input') return undefined;
  try {
    const input = object(JSON.parse(words[4]!));
    return input ? { command: name, input, stdin: false } : undefined;
  } catch { return undefined; }
}

function toolPathCandidates(toolName: string, input: JsonObject): string[] | undefined {
  if (toolName === 'apply_patch') {
    const patch = typeof input.command === 'string' ? input.command : typeof input.patch === 'string' ? input.patch : undefined;
    if (!patch) return undefined;
    const paths = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gmu)].map(match => match[1]!);
    return paths.length ? paths : undefined;
  }
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    const own = typeof input.file_path === 'string' ? [input.file_path] : [];
    const nested = input.edits.flatMap(value => { const record = object(value); return typeof record?.file_path === 'string' ? [record.file_path] : []; });
    return [...own, ...nested];
  }
  const path = input.file_path ?? input.path ?? input.notebook_path;
  return typeof path === 'string' ? [path] : undefined;
}

function isUnder(path: string, root: string): boolean {
  const normalized = resolve(root);
  return path === normalized || path.startsWith(`${normalized}/`);
}
function touchesManagedDocument(paths: string[] | undefined, cwd: string, workflow: Workflow): boolean {
  if (!paths) return false;
  return paths.some(path => {
    const candidate = resolve(cwd, path);
    return isUnder(candidate, workflow.paths.designDir) || isUnder(candidate, workflow.paths.adrDir)
      || candidate === resolve(workflow.paths.obsidianNote);
  });
}

function deny(reason: string, fingerprint?: string): HookOutput {
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: reason + (fingerprint ? `\n호출 식별값: ${fingerprint}` : ''),
  } };
}
function guardCoreInvocation(invocation: CoreInvocation, owner: Owner, readOnly: boolean): HookOutput | undefined {
  const mutates = !CORE_READ_COMMANDS.has(invocation.command);
  if (readOnly && mutates) return deny('현재 세션은 진행 정보를 변경할 수 없습니다. 현황을 확인하고 부모 또는 현재 소유 세션에서 진행해 주세요.');
  // A long-lived stdin command would permit uninspected subsequent input.
  if (invocation.stdin) return deny('진행 관리 입력은 --input JSON으로 한 번에 전달해 주세요. 대기 중인 셸에 입력을 추가하는 방식은 허용하지 않습니다.');
  if (mutates) {
    const submittedOwner = object(invocation.input?.owner);
    if (submittedOwner?.host !== owner.host || submittedOwner.sessionId !== owner.sessionId) {
      return deny('진행 변경의 owner는 훅이 알려 준 현재 호스트와 세션이어야 합니다. 다른 작업의 담당 정보로 변경을 요청할 수 없습니다.');
    }
  }
  return undefined;
}
function contextOutput(eventName: string, text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: text } };
}
function sessionContext(host: Host, sessionId: string, port: HookPort, binding?: SessionBinding, userRef?: UserRef): string {
  const lines = [
    'system-design 실행 정보',
    `CLI: ${port.cliPath}`,
    `현재 세션: ${JSON.stringify({ host, sessionId })}`,
    'CLI 입력은 --input의 JSON 문자열로 전달한다. 제품 코드와 기록 변경은 현재 단계 규칙을 따른다.',
  ];
  if (userRef) lines.push(`사용자 발화 참조: ${JSON.stringify(userRef)}`, '이 참조는 실제 사용자 차례의 위치이며, AI 해석의 정확성을 보증하지 않는다.');
  if (binding) {
    lines.push(port.context(binding.workflow));
    if (binding.readOnly) lines.push('이 세션은 작업을 다른 도구에 넘겼다. 현황 조회만 가능하며, 다시 수정하려면 현재 소유 세션에서 작업을 넘겨받아야 한다.');
  } else lines.push('아직 연결된 설계 작업이 없다. 사용자가 실제 설계를 요청한 경우에만 초기 설정과 작업 위치를 확인한 뒤 start로 연결한다. 스킬의 리뷰, 수정 또는 설치 요청에서는 설계를 자동 시작하지 않는다.');
  return lines.join('\n');
}

/** Native hook adapters share one policy. {} means leave host permissions alone. */
export function processHook(host: Host, rawEvent: unknown, port: HookPort): HookOutput {
  const event = object(rawEvent);
  if (!event || typeof event.session_id !== 'string' || typeof event.hook_event_name !== 'string') return {};
  const sessionId = event.session_id;
  const eventName = event.hook_event_name;
  const cwd = typeof event.cwd === 'string' && isAbsolute(event.cwd) ? event.cwd : process.cwd();
  try {
    const binding = port.findSession(host, sessionId, cwd);
    const active = binding && binding.workflow.run !== 'complete'
      ? { ...binding, readOnly: binding.readOnly || binding.workflow.owner.host !== host || binding.workflow.owner.sessionId !== sessionId }
      : undefined;
    const invoked = binding?.workflow.run !== 'complete' && (port.isInvokedSession?.(host, sessionId) ?? false);
    if (eventName === 'UserPromptSubmit') {
      const prompt = typeof event.prompt === 'string' ? event.prompt : '';
      const explicit = isExplicitInvocation(prompt);
      if (!active && !invoked && !explicit) return {};
      if (explicit) port.markInvoked?.(host, sessionId);
      const eventId = typeof event.turn_id === 'string' ? event.turn_id
        : typeof event.message_id === 'string' ? event.message_id : `prompt-${randomUUID()}`;
      const userRef = port.recordUserEvent(host, sessionId, eventId, createHash('sha256').update(prompt).digest('hex'));
      if (active && !active.readOnly) port.archivePrompt?.(active.workflow, prompt, userRef);
      if(active&&!explicit)return contextOutput(eventName,'system-design '+JSON.stringify({workflowId:active.workflow.id,owner:active.workflow.owner,expectedRevision:active.workflow.revision,stage:active.workflow.stage,run:active.workflow.run,paused:active.workflow.paused,readOnly:active.readOnly,userRef,obsidianPending:active.workflow.obsidianPending,...(active.workflow.obsidianError?{obsidianError:active.workflow.obsidianError}:{})})+'\n주제 중간에는 저장 호출 없이 대화한다. 마지막 저장 이후의 질문은 현재 대화를 따른다.');
      return contextOutput(eventName, sessionContext(host, sessionId, port, active, userRef));
    }
    if (eventName === 'SessionStart' && (active || invoked)) return contextOutput(eventName, sessionContext(host, sessionId, port, active, port.latestUserRef(host, sessionId)));
    if (!active) {
      // Initial setup has no workflow yet, but its supplied owner still belongs to this invocation.
      if (invoked && eventName === 'PreToolUse' && ['Bash', 'exec_command', 'shell_command'].includes(String(event.tool_name))) {
        const toolInput = object(event.tool_input);
        const command = typeof toolInput?.command === 'string' ? toolInput.command : typeof toolInput?.cmd === 'string' ? toolInput.cmd : '';
        const invocation = parseCoreInvocation(command, port.cliPath, port.nodePath);
        const subagent = typeof event.agent_id === 'string' || typeof event.parent_session_id === 'string' || event.is_subagent === true;
        if (invocation) return guardCoreInvocation(invocation, { host, sessionId }, subagent) ?? {};
      }
      return {};
    }
    if (eventName === 'SubagentStart') return contextOutput(eventName,
      `${sessionContext(host, sessionId, port, active)}\n하위 에이전트는 현재 단계에서 읽기와 검토만 한다. 단계 이동, 결정 확정, 소유권 변경, 구현 승인은 부모 대화에서 수행한다.`);
    // A question waiting for the user is a valid stopping state. Never restart it.
    if (eventName !== 'PreToolUse') return {};
    const toolName = typeof event.tool_name === 'string' ? event.tool_name : '';
    const toolInput = object(event.tool_input) ?? {};
    const fingerprint = fingerprintTool(toolName, event.tool_input, cwd);
    const owner = { host, sessionId };
    const workflow = active.workflow;
    const protectedStage = active.readOnly || workflow.paused || !['implementing', 'verifying'].includes(workflow.run);
    const subagent = typeof event.agent_id === 'string' || typeof event.parent_session_id === 'string' || event.is_subagent === true;

    if (toolName === 'Bash' || toolName === 'exec_command' || toolName === 'shell_command') {
      const command = typeof toolInput.command === 'string' ? toolInput.command : typeof toolInput.cmd === 'string' ? toolInput.cmd : '';
      const invocation = parseCoreInvocation(command, port.cliPath, port.nodePath);
      if (invocation) {
        return guardCoreInvocation(invocation, owner, active.readOnly || subagent) ?? {};
      }
      if (!protectedStage) return {};
      if (isReadOnlyShell(command)) return {};
    } else if (EDIT_TOOLS.has(toolName)) {
      if (touchesManagedDocument(toolPathCandidates(toolName, toolInput), cwd, workflow)) return deny('설계와 ADR, Obsidian 기록은 진행 관리 CLI로 갱신해 주세요. 직접 수정된 내용을 확인하고 보존하기 위한 규칙입니다.');
      if (!protectedStage) return {};
      // Product edits are never enabled merely by a one-command exception.
      return deny('설계 중에는 제품 코드를 수정할 수 없습니다. 설계 평가를 마치고 사용자의 구현 시작 요청을 확인해 주세요.');
    } else if (READ_TOOLS.has(toolName) || port.safeReadTools?.includes(toolName)) return {};
    else if (ORCHESTRATION_TOOLS.has(toolName)) {
      if (active.readOnly && ['Agent', 'Task', 'spawn_agent'].includes(toolName)) return deny('작업을 넘긴 세션에서는 새 작업 에이전트를 시작할 수 없습니다. 현황 조회만 진행해 주세요.');
      return {};
    } else if (!protectedStage) return {};

    if (active.readOnly) return deny('이 세션은 작업을 다른 도구에 넘겼습니다. 현황 조회만 가능하며, 변경은 현재 소유 세션에서 진행해 주세요.');
    if (subagent) return deny('하위 에이전트에서 분류되지 않은 실행을 시작할 수 없습니다. 필요한 실행을 부모 대화에 알려주세요.', fingerprint);
    if (!workflow.paused && port.consumeGrant(workflow, owner, fingerprint)) return {};
    return deny('이 호출이 읽기만 수행하는지 확인하지 못했습니다. 실행 목적과 영향을 사용자에게 설명하고, 이 호출에 대한 허용을 받은 뒤 다시 진행해 주세요.', fingerprint);
  } catch {
    // Never echo the received event or exception: they may contain raw user text.
    if (eventName === 'PreToolUse') return deny('진행 상태를 확인하지 못해 실행을 멈췄습니다. 상태 저장 위치와 플러그인 연결을 확인해 주세요.');
    return { systemMessage: 'system-design 진행 정보를 불러오지 못했습니다. 사용자 발화와 도구 입력은 오류 메시지에 보관하지 않았습니다.' };
  }
}
