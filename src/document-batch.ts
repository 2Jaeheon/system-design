import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeWriteDocument, hashFile, hashText } from './documents.js';
import { Store, digest, inside, canonical } from './store.js';
import { fail, type Artifact, type Workflow } from './types.js';

interface Job { artifact: Artifact; previous?: Artifact; content: string; expectedHash: string|null; allowedRoot: string; optional: boolean }
interface Journal { workflowId: string; operationId: string; writes: {path:string;allowedRoot:string;before:string|null;beforeHash:string|null;afterHash:string}[] }

/** Short-lived recovery copies of design documents, never prompt/transcript captures. */
export class DocumentBatch {
  readonly jobs = new Map<string,Job>();
  private journalPath?: string;
  constructor(private store:Store,readonly workflowId:string,readonly operationId:string) {}
  stage(w:Workflow,target:Pick<Artifact,'id'|'kind'|'path'>,content:string,allowedRoot:string,optional=false):void {
    const existing=w.artifacts.find(a=>a.id===target.id),queued=this.jobs.get(target.id);
    const artifact:Artifact={...target,hash:hashText(content),revision:w.revision};
    this.jobs.set(target.id,{artifact,previous:queued?queued.previous:(existing?structuredClone(existing):undefined),content,expectedHash:queued?queued.expectedHash:existing?.hash??null,allowedRoot,optional});
    if(existing)Object.assign(existing,artifact);else w.artifacts.push(artifact);
  }
  content(path:string):string {return [...this.jobs.values()].find(j=>j.artifact.path===path)?.content??readFileSync(path,'utf8');}
  pendingHash(path:string):string|undefined {return [...this.jobs.values()].find(j=>j.artifact.path===path)?.artifact.hash;}
  apply(w:Workflow):void {
    if(!this.jobs.size)return;
    const jobs=[...this.jobs.values()].sort((a,b)=>Number(a.optional)-Number(b.optional));
    const writes:Journal['writes']=[];
    for(const job of jobs) {
      try {
        const beforeHash=hashFile(job.artifact.path);
        if(beforeHash!==job.expectedHash&&beforeHash!==job.artifact.hash)fail('DOCUMENT_CONFLICT','문서가 바뀌었습니다. 직접 수정한 내용을 확인해 주세요.',{artifactId:job.artifact.id,path:job.artifact.path,actualHash:beforeHash});
        writes.push({path:job.artifact.path,allowedRoot:job.allowedRoot,before:beforeHash===null?null:readFileSync(job.artifact.path,'utf8'),beforeHash,afterHash:job.artifact.hash});
      } catch(error) {
        if(!job.optional)throw error;
        this.optionalFailed(w,job,error);this.jobs.delete(job.artifact.id);
      }
    }
    const dir=join(this.store.dir,'document-journal');mkdirSync(dir,{recursive:true,mode:0o700});
    this.journalPath=join(dir,digest({workflowId:w.id,operationId:this.operationId})+'.json');
    const tmp=this.journalPath+'.'+randomUUID()+'.tmp';
    writeFileSync(tmp,JSON.stringify({workflowId:w.id,operationId:this.operationId,writes} satisfies Journal),{mode:0o600,flag:'wx'});renameSync(tmp,this.journalPath);
    try {
      for(const job of jobs)if(this.jobs.has(job.artifact.id)) {
        try {safeWriteDocument({path:job.artifact.path,content:job.content,expectedHash:job.expectedHash,allowedRoot:job.allowedRoot,operationId:this.operationId});}
        catch(error){if(!job.optional)throw error;this.optionalFailed(w,job,error);}
      }
    } catch(error) {this.rollback();throw error;}
  }
  private optionalFailed(w:Workflow,job:Job,error:unknown):void {
    w.obsidianPending=true;w.obsidianError=error&&typeof error==='object'&&'code' in error?String(error.code):'NOTE_WRITE_FAILED';
    // A rename may succeed before directory fsync fails. Keep the actual hash so
    // the next projection can retry without mistaking our own write for a human edit.
    try {if(hashFile(job.artifact.path)===job.artifact.hash)return;} catch { /* Keep the original metadata below. */ }
    w.artifacts=w.artifacts.filter(a=>a.id!==job.artifact.id);if(job.previous)w.artifacts.push(job.previous);
  }
  committed():void {if(this.journalPath&&existsSync(this.journalPath))unlinkSync(this.journalPath);this.journalPath=undefined;}
  rollback():void {if(this.journalPath&&existsSync(this.journalPath)){restoreJournal(this.store,this.journalPath);this.journalPath=undefined;}}
}

function restoredKey(journal:Journal):string{return 'document-recovery:'+journal.workflowId+':'+journal.operationId;}
function assertJournalPath(store:Store,workflow:Workflow,entry:Journal['writes'][number]):void {
  const allowed=[workflow.paths.designDir,workflow.paths.adrDir,store.settings()?.obsidianVault].filter((x):x is string=>!!x);
  if(!allowed.includes(entry.allowedRoot)||!inside(canonical(entry.allowedRoot),canonical(entry.path)))fail('JOURNAL_PATH_INVALID','복구 문서의 위치가 등록된 범위를 벗어났습니다.');
}
function restoreJournal(store:Store,path:string):void {
  const journal=JSON.parse(readFileSync(path,'utf8')) as Journal;
  const workflow=store.get(journal.workflowId);
  const committed=store.db.prepare('SELECT 1 FROM receipts WHERE workflow_id=? AND operation_id=?').get(journal.workflowId,journal.operationId);
  const resolved=store.db.prepare('SELECT 1 FROM metadata WHERE key=?').get(restoredKey(journal));
  if(committed||resolved){unlinkSync(path);return;}
  // Check the whole set before restoring anything. A manual edit blocks this
  // batch while preserving every file for a deliberate user-backed recovery.
  for(const entry of journal.writes) {
    assertJournalPath(store,workflow,entry);
    const actual=hashFile(entry.path);
    if(actual!==entry.beforeHash&&actual!==entry.afterHash)fail('DOCUMENT_RECOVERY_CONFLICT','저장 중단 뒤 사람이 문서를 수정했습니다. status에서 내용을 확인한 뒤 recover로 보존해 주세요.',{workflowId:journal.workflowId,operationId:journal.operationId,path:entry.path});
  }
  for(const entry of journal.writes.slice().reverse()) {
    const actual=hashFile(entry.path);
    if(actual===entry.beforeHash)continue;
    if(actual!==entry.afterHash)fail('DOCUMENT_RECOVERY_CONFLICT','저장 중단 뒤 사람이 문서를 수정했습니다. 내용을 보존하고 확인이 필요합니다.',{path:entry.path});
    if(entry.before===null)unlinkSync(entry.path);
    else safeWriteDocument({path:entry.path,content:entry.before,expectedHash:entry.afterHash,allowedRoot:entry.allowedRoot,operationId:journal.operationId+'-rollback'});
  }
  unlinkSync(path);
}
export function pendingRecovery(store:Store):{workflowId:string;operationId:string;documents:{path:string;observedHash:string|null}[]}[] {
  const dir=join(store.dir,'document-journal');if(!existsSync(dir))return [];
  return readdirSync(dir).filter(n=>n.endsWith('.json')).map(name=>{
    const j=JSON.parse(readFileSync(join(dir,name),'utf8')) as Journal;
    return {workflowId:j.workflowId,operationId:j.operationId,documents:j.writes.map(e=>({path:e.path,observedHash:hashFile(e.path)}))};
  });
}
/** Preserve the exact reviewed files; does not replay an unfinished design decision. */
export function acknowledgeRecovery(store:Store,w:Workflow,operationId:string,observed:unknown):void {
  const path=join(store.dir,'document-journal',digest({workflowId:w.id,operationId})+'.json');
  if(!existsSync(path))fail('RECOVERY_NOT_FOUND','확인할 미완료 문서 저장을 찾을 수 없습니다.');
  const j=JSON.parse(readFileSync(path,'utf8')) as Journal;
  if(j.workflowId!==w.id||j.operationId!==operationId)fail('RECOVERY_NOT_FOUND','복구할 작업이 일치하지 않습니다.');
  if(!Array.isArray(observed)||observed.length!==j.writes.length)fail('RECOVERY_EVIDENCE_REQUIRED','저장 중단에 관련된 모든 문서의 현재 경로와 해시를 확인해 주세요.');
  for(const entry of j.writes) {
    assertJournalPath(store,w,entry);
    const actual=hashFile(entry.path);
    if(!observed.some(d=>d&&d.path===entry.path&&d.observedHash===actual))fail('DOCUMENT_CHANGED_AGAIN','복구 확인 중 문서가 다시 바뀌었습니다. 현재 내용을 다시 읽어 주세요.');
    // Existing canonical artifacts become reconcilable. Uncommitted new files
    // remain untouched and unregistered; they must be reviewed before adoption.
    const artifact=w.artifacts.find(a=>a.path===entry.path);
    if(artifact&&actual){artifact.hash=actual;artifact.revision=w.revision;}
    if(artifact&&!actual&&artifact.kind!=='adr'&&artifact.kind!=='handoff') {
      w.artifacts=w.artifacts.filter(a=>a!==artifact);
      for(const s of w.stages)if(s.artifactId===artifact.id)s.artifactId=undefined;
    }
    // A deleted ADR or implementation handoff remains tracked as missing.
    // Stage gates must require its explicit restoration, never silently forget it.
  }
  store.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(restoredKey(j),String(w.revision));
}
export function recoverDocuments(store:Store):void {
  const dir=join(store.dir,'document-journal');if(!existsSync(dir))return;
  // Serialize recovery against a live mutation before inspecting its unfinished journal.
  store.transaction(()=>{for(const name of readdirSync(dir))if(name.endsWith('.json'))restoreJournal(store,join(dir,name));});
}
