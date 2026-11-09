import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, realpathSync, chmodSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fail, type Host, type Owner, type UserRef, type Workflow, type Settings, type MutationContext } from './types.js';

export const DEFAULT_STATE_DIR = join(homedir(), '.local', 'state', 'system-design');
export function inside(root: string, target: string): boolean {
  const r = relative(root, target); return r === '' || (!r.startsWith('..' + '/') && r !== '..' && !isAbsolute(r));
}
export function canonical(path: string): string {
  let ancestor = resolve(path); const suffix: string[] = [];
  while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) break; suffix.unshift(ancestor.slice(parent.length + (parent === '/' ? 0 : 1))); ancestor = parent; }
  return resolve(realpathSync(ancestor), ...suffix);
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableJson((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function digest(value: unknown): string { return createHash('sha256').update(stableJson(value)).digest('hex'); }
export function sameOwner(a: Owner, b: Owner): boolean { return a.host === b.host && a.sessionId === b.sessionId; }
export function assertOwner(value: unknown): asserts value is Owner {
  if (!value || typeof value !== 'object') fail('INVALID_OWNER', '호스트와 세션 번호가 필요합니다.');
  const o = value as Owner;
  if (!['codex', 'claude'].includes(o.host) || typeof o.sessionId !== 'string' || !o.sessionId.trim() || o.sessionId.length > 256) fail('INVALID_OWNER', '올바른 호스트와 세션 번호가 필요합니다.');
}
function checkStatePath(path: string): void {
  let p = canonical(path);
  for (;;) { if (existsSync(join(p, '.git'))) fail('STATE_IN_GIT', '진행 정보는 Git 저장소 밖에 보관해야 합니다.'); const parent = dirname(p); if (parent === p) break; p = parent; }
}

export class Store {
  readonly dir: string;
  readonly db: DatabaseSync;
  constructor(dir = process.env.SYSTEM_DESIGN_STATE_DIR || DEFAULT_STATE_DIR, options: {readOnly?: boolean} = {}) {
    this.dir = canonical(dir); checkStatePath(this.dir);
    const file = join(this.dir, 'state.sqlite');
    let missing = false;
    if (options.readOnly) {
      try { statSync(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
        else throw error;
      }
    }
    if (options.readOnly && !missing) {
      this.db = new DatabaseSync(file, {readOnly: true});
      try {
        this.db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON;');
        const version = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('schema_version') as {value: string} | undefined;
        if (!version || version.value !== '1') fail('SCHEMA_VERSION', '현재 프로그램이 읽을 수 없는 진행 정보 버전입니다.');
      } catch (error) { this.db.close(); throw error; }
      return;
    }
    if (!options.readOnly) { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); chmodSync(this.dir, 0o700); }
    this.db = new DatabaseSync(options.readOnly ? ':memory:' : file);
    if (!options.readOnly) chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings (host TEXT NOT NULL, session_id TEXT NOT NULL, workflow_id TEXT NOT NULL, mode TEXT NOT NULL, PRIMARY KEY(host,session_id));
      CREATE TABLE IF NOT EXISTS user_events (host TEXT NOT NULL, session_id TEXT NOT NULL, event_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(host,session_id,event_id));
      CREATE TABLE IF NOT EXISTS receipts (workflow_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(workflow_id,operation_id));
      CREATE TABLE IF NOT EXISTS grants (workflow_id TEXT NOT NULL, revision INTEGER NOT NULL, host TEXT NOT NULL, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(workflow_id,revision,host,session_id,fingerprint));
      CREATE TABLE IF NOT EXISTS invoked_sessions (host TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(host,session_id));
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const version = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('schema_version') as {value: string} | undefined;
    if (version && version.value !== '1') { this.db.close(); fail('SCHEMA_VERSION', '현재 프로그램이 읽을 수 없는 진행 정보 버전입니다.'); }
    if (!version) this.db.prepare('INSERT INTO metadata VALUES (?,?)').run('schema_version', '1');
  }
  close(): void { this.db.close(); }
  markInvoked(host:Host,sessionId:string):void { this.db.prepare('INSERT OR IGNORE INTO invoked_sessions VALUES (?,?)').run(host,sessionId); }
  isInvokedSession(host:Host,sessionId:string):boolean { return !!this.db.prepare('SELECT 1 FROM invoked_sessions WHERE host=? AND session_id=?').get(host,sessionId); }
  endInvocation(host:Host,sessionId:string):void { this.db.prepare('DELETE FROM invoked_sessions WHERE host=? AND session_id=?').run(host,sessionId); }
  transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = body(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  settings(): Settings | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE id=1').get() as {value: string} | undefined;
    return row ? JSON.parse(row.value) as Settings : undefined;
  }
  saveSettings(settings: Settings): void {
    if (inside(settings.obsidianVault, this.dir)) fail('STATE_IN_VAULT', '진행 DB는 Obsidian 볼트 밖의 개인 폴더에 보관해야 합니다.');
    this.db.prepare('INSERT INTO settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(settings));
  }
  get(id: string): Workflow {
    const row = this.db.prepare('SELECT value FROM workflows WHERE id=?').get(id) as {value: string} | undefined;
    if (!row) fail('WORKFLOW_NOT_FOUND', '해당 설계 작업을 찾을 수 없습니다.');
    return JSON.parse(row.value) as Workflow;
  }
  all(): Workflow[] { return (this.db.prepare('SELECT value FROM workflows ORDER BY rowid DESC').all() as {value: string}[]).map(r => JSON.parse(r.value) as Workflow); }
  put(w: Workflow): void { this.db.prepare('INSERT INTO workflows VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(w.id, JSON.stringify(w)); }
  bind(owner: Owner, workflowId: string, mode = 'owner'): void {
    this.db.prepare('INSERT INTO bindings VALUES (?,?,?,?) ON CONFLICT(host,session_id) DO UPDATE SET workflow_id=excluded.workflow_id,mode=excluded.mode').run(owner.host, owner.sessionId, workflowId, mode);
  }
  findSession(host: Host, sessionId: string, _cwd = ''): {workflow: Workflow; readOnly: boolean} | undefined {
    const row = this.db.prepare('SELECT workflow_id, mode FROM bindings WHERE host=? AND session_id=?').get(host, sessionId) as {workflow_id: string; mode: string} | undefined;
    if (!row) return undefined;
    const workflow = this.get(row.workflow_id);
    return {workflow, readOnly: row.mode !== 'owner' || !sameOwner(workflow.owner, {host, sessionId})};
  }
  recordUserEvent(host: Host, sessionId: string, eventId: string, hash: string): UserRef {
    assertOwner({host, sessionId});
    if (!eventId || eventId.length > 256 || !/^[a-f0-9]{64}$/.test(hash)) fail('INVALID_USER_EVENT', '사용자 발화의 참조 정보가 올바르지 않습니다.');
    const existing = this.db.prepare('SELECT hash FROM user_events WHERE host=? AND session_id=? AND event_id=?').get(host, sessionId, eventId) as {hash: string} | undefined;
    if (existing && existing.hash !== hash) fail('EVENT_CONFLICT', '같은 발화 번호의 내용이 달라 확인이 필요합니다.');
    this.db.prepare('INSERT OR IGNORE INTO user_events VALUES (?,?,?,?)').run(host, sessionId, eventId, hash);
    return {host, sessionId, eventId, actor: 'user'};
  }
  latestUserRef(host: Host, sessionId: string): UserRef | undefined {
    const row = this.db.prepare('SELECT event_id FROM user_events WHERE host=? AND session_id=? ORDER BY rowid DESC LIMIT 1').get(host, sessionId) as {event_id: string} | undefined;
    return row ? {host, sessionId, eventId: row.event_id, actor: 'user'} : undefined;
  }
  eventSequence(ref:UserRef):number {
    return Number((this.db.prepare('SELECT rowid AS seq FROM user_events WHERE host=? AND session_id=? AND event_id=?').get(ref.host,ref.sessionId,ref.eventId) as {seq:number}|undefined)?.seq??0);
  }
  assertUserRef(ref: UserRef, owner?: Owner): void {
    if (!ref || ref.actor !== 'user') fail('USER_EVIDENCE_REQUIRED', '사용자가 직접 말한 발화의 참조가 필요합니다.');
    assertOwner(ref);
    if (owner && !sameOwner(ref, owner)) fail('USER_EVIDENCE_OWNER', '현재 담당 세션의 사용자 답변을 참조해야 합니다.');
    if (!this.db.prepare('SELECT 1 FROM user_events WHERE host=? AND session_id=? AND event_id=?').get(ref.host, ref.sessionId, ref.eventId)) fail('USER_EVIDENCE_NOT_FOUND', '훅에서 확인한 사용자 발화가 없습니다. 실제 답변을 기다려 주세요.');
  }
  mutate(ctx: MutationContext, fingerprint: string, body: (w: Workflow) => void): {workflow: Workflow; replayed: boolean} {
    assertOwner(ctx.owner);
    if (!ctx.operationId || typeof ctx.operationId !== 'string' || ctx.operationId.length > 200) fail('OPERATION_ID_REQUIRED', '재시도를 구분할 작업 번호가 필요합니다.');
    return this.transaction(() => {
      const w = this.get(ctx.workflowId);
      const receipt = this.db.prepare('SELECT fingerprint FROM receipts WHERE workflow_id=? AND operation_id=?').get(w.id, ctx.operationId) as {fingerprint: string} | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail('OPERATION_REUSED', '같은 작업 번호를 서로 다른 내용에 사용할 수 없습니다.');
        return {workflow: w, replayed: true};
      }
      if (!sameOwner(w.owner, ctx.owner)) fail('NOT_OWNER', '이 작업은 다른 세션에서 진행 중입니다. 명시적으로 작업을 넘겨받아야 합니다.');
      if (ctx.expectedRevision !== w.revision) fail('STALE_REVISION', '진행 정보가 바뀌었습니다. 현황을 다시 읽어 주세요.', {currentRevision: w.revision});
      w.revision += 1; w.updatedAt = new Date().toISOString();
      body(w);
      this.put(w);
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(w.id, ctx.operationId, fingerprint);
      return {workflow: w, replayed: false};
    });
  }
  addGrant(w: Workflow, fingerprint: string): void {
    this.db.prepare('INSERT OR IGNORE INTO grants VALUES (?,?,?,?,?)').run(w.id, w.revision, w.owner.host, w.owner.sessionId, fingerprint);
  }
  consumeGrant(w: Workflow, owner: Owner, fingerprint: string): boolean {
    return this.transaction(() => {
      const current = this.get(w.id);
      if (!sameOwner(current.owner, owner) || current.revision !== w.revision) return false;
      return Number(this.db.prepare('DELETE FROM grants WHERE workflow_id=? AND revision=? AND host=? AND session_id=? AND fingerprint=?').run(w.id, w.revision, owner.host, owner.sessionId, fingerprint).changes) === 1;
    });
  }
  archive(w: Workflow, question: string, answer: string, userRef: UserRef): void {
    const settings = this.settings();
    if (!settings?.archiveEnabled || !settings.archiveConsent) fail('ARCHIVE_DISABLED', '대화 원문 추가 보관이 켜져 있지 않습니다.');
    this.assertUserRef(userRef, w.owner);
    const sequence=(r:UserRef)=> Number((this.db.prepare('SELECT rowid AS seq FROM user_events WHERE host=? AND session_id=? AND event_id=?').get(r.host,r.sessionId,r.eventId) as {seq:number}|undefined)?.seq??0);
    if(sequence(userRef)<=sequence(settings.archiveConsent))fail('ARCHIVE_BEFORE_CONSENT','추가 보관을 선택하기 전의 대화는 복사하지 않습니다.');
    const folder = join(this.dir, 'archives',w.id); mkdirSync(folder, {recursive: true, mode: 0o700});
    const file = join(folder, digest(userRef) + '.json');
    // This is the only intentionally raw-content store, enabled by explicit setup consent.
    const content=JSON.stringify({question,answer,userRef})+'\n';
    if(existsSync(file)){if(readFileSync(file,'utf8')!==content)fail('ARCHIVE_CONFLICT','이미 보관한 발화의 내용과 다릅니다. 원본을 보존합니다.');return;}
    writeFileSync(file, content, {mode: 0o600,flag:'wx'});
  }
}
