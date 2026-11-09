import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { Store, canonical, inside, digest, assertOwner, sameOwner } from './store.js';
import { STAGES, STAGE_LABELS, DesignError, fail, type Workflow, type Stage, type UserRef, type Owner, type MutationContext, type Artifact, type Criterion, type Settings } from './types.js';
import { hashFile, renderADR, patchADRStatus, patchADRProgress, renderObsidian, mergeObsidian, renderHandoff, renderProgress, documentLink, OBSIDIAN_START, OBSIDIAN_END } from './documents.js';
import { DocumentBatch, recoverDocuments, pendingRecovery, acknowledgeRecovery } from './document-batch.js';

type Args = Record<string, unknown>;
export const CRITERIA: Record<Stage, readonly string[]> = {
  requirements: ['scope', 'exclusions', 'evidence'],
  'non-functional': ['scale', 'latency', 'reliability', 'security', 'cost', 'evidence'],
  entities: ['definitions', 'relationships', 'boundaries'],
  api: ['coverage', 'contracts', 'identity', 'retries'],
  architecture: ['paths', 'responsibilities', 'async', 'failures'],
  'deep-dive': ['priorities', 'alternatives', 'tradeoffs', 'validation'],
  evaluation: ['traceability', 'gaps', 'revisit', 'implementation'],
};
const PROMPTS: Record<Stage, string> = {
  requirements: '이번 작업에서 사용자가 무엇을 할 수 있어야 한다고 생각하나요? 먼저 생각한 범위를 말해 주세요.',
  'non-functional': '앞에서 정한 기능을 실제로 사용할 때 가장 먼저 고려할 조건 하나는 무엇이라고 생각하나요?',
  entities: '앞에서 정한 기능에 어떤 핵심 개념이 필요하다고 생각하나요? 이름과 뜻을 먼저 말해 주세요.',
  api: '앞에서 정한 기능을 요청하고 결과를 받으려면 어떤 호출이 필요하다고 생각하나요?',
  architecture: '핵심 요청 하나가 들어와 처리되고 결과를 돌려주기까지 어떻게 이어져야 한다고 생각하나요?',
  'deep-dive': '지금 설계에서 품질 목표를 지키기 가장 어려운 지점 하나는 어디라고 생각하나요?',
  evaluation: '처음 정한 요구사항과 지금 설계를 비교할 때 가장 먼저 검토할 부분은 무엇이라고 생각하나요?',
};
export const COMMAND_HELP: Record<string, unknown> = {
  commonMutation: { required: ['workflowId', 'owner:{host:codex|claude,sessionId}', 'expectedRevision:number', 'operationId:unique-string'], userRef: '{actor:user,host,sessionId,eventId} from the host hook; never invent it' },
  checkpoint: {context:'commonMutation', required:['topic','interpretation:current stage summary','userRefs:UserRef[] in chronological order','content:current stage Markdown'], optional:['decisions:ADR input[] (userRef only for accepted choices)','issues:issue input[]','learning:learning input[]','nextQuestion','criteria','reviewSummary','advance:boolean','nextStageQuestion (only with advance:true)'], note:'One topic per atomic save. References must be observed in this owner session and include the latest turn after start. A registered initialUserRef may be included once in the first topic even though it preceded start. No raw dialogue.'},
  settings: {note:'Read existing setup only. Does not repeat onboarding or expose any transcript.'},
  setup: {required: ['owner', 'obsidianVault:absolute-existing-directory', 'obsidianFolder:relative-folder', 'archiveEnabled:boolean'], optional: ['userRef (required to enable archive)']},
  start: {required: ['title', 'projectRoot:absolute-existing-directory', 'owner', 'designDir', 'adrDir', 'obsidianNote'], optional: ['initialUserRef:an observed request containing design thoughts', 'firstQuestion:one unresolved question'], note: 'Project-relative design/ADR directories; vault-relative Obsidian note. An initial user reference is evidence of a real turn, not proof of its meaning. Previously configured project paths may be omitted.'},
  status: {optional: ['workflowId', 'owner', 'detail:full (CLI default is compact)'], note: 'Returns matching workflow(s), progress, pending question, criteria and last observed user reference.'},
  resume: {context: 'commonMutation', note: 'Unpauses the same owner; use handoff to change host/session.'},
  pause: {context: 'commonMutation'},
  handoff: {context: 'commonMutation', required: ['to:{host,sessionId}', 'userRef'], note: 'User request in the current owner session; receiving host resumes only after this transfer.'},
  question: {context: 'commonMutation', required: ['text'], optional: ['replace:boolean (only rephrase pending question)']},
  answer: {context: 'commonMutation', required: ['questionId', 'userRef', 'interpretation:short cumulative AI paraphrase of this stage'], optional: ['needsExplanation:boolean'], note: 'Never submit/store the original answer here. The source stays in the host session.'},
  'answer-revise': {context:'commonMutation',required:['userRef (an existing answer reference in the current stage)','interpretation','reason'],note:'Correct only the AI paraphrase of an already observed answer. Keep prior interpretation and reason; do not invent a new answer, close a pending question, or accept decisions. Clear prior review criteria.'},
  explain: {context: 'commonMutation', required: ['summary:what was explained'], optional: ['nextQuestion']},
  learning: {context: 'commonMutation', required: ['kind:explained|user_reported|user_explained', 'text'], optional: ['userRef (required for user kinds)']},
  issue: {context: 'commonMutation', required: ['action:add|resolve'], add: ['text', 'stage', 'blocking:boolean'], resolve: ['id', 'userRef'], note: 'Use source inspection to clarify facts before adding a blocking user-decision question.'},
  design: {context: 'commonMutation', required: ['content:Markdown'], note: 'Writes the current stage artifact; no transcript.'},
  review: {context: 'commonMutation', required: ['criteria:{key:{status:met|deferred,evidence,verification?}}', 'summary'], criteria: CRITERIA, note: 'Only requirements.evidence, non-functional.evidence and deep-dive.validation may be deferred, with a concrete verification plan. Other criteria must be met; evidence does not imply measured performance.'},
  advance: {context: 'commonMutation', optional: ['nextStageQuestion'], note: 'Requires first user thought, all criteria, saved unchanged docs, no pending question/blocking issue/proposed decision. Automatic transition never authorizes implementation.'},
  reopen: {context: 'commonMutation', required: ['stages:affected stage names', 'reason'], note: 'Suspends implementation; marks affected results for review without deleting decisions.'},
  'decision-propose': {context: 'commonMutation', required: ['title', 'background', 'choice', 'alternatives:string[]', 'reason', 'consequences:string[]', 'verification', 'revisit', 'stages:Stage[]'], optional:['references:string[] (code, inspection or verification links)'],note:'Adds relevant design document and interview references automatically. References contain locations and facts, never raw conversation.'},
  'decision-accept': {context: 'commonMutation', required: ['decisionId', 'userRef']},
  'decision-retitle': {context:'commonMutation',required:['decisionId','title','reason'],note:'Correct title wording only; preserve decision body, status, evidence and previous title. A changed decision requires a new ADR and supersede, never this command.'},
  'decision-supersede': {context: 'commonMutation', required: ['decisionId', 'replacementId (already accepted)', 'userRef']},
  reconcile: {context: 'commonMutation', required: ['artifactId', 'observedHash', 'userRef', 'meaning:unchanged|changed'], optional: ['stages (required when a project document decision changed)'], note: 'Preserve manual edits; never accept unknown content without reviewing it with the user.'},
  recover: {context:'commonMutation',required:['pendingOperationId','documents:[{path,observedHash:string|null}]','userRef','stages:affected stage names'],note:'After status reports interrupted-save conflicts, read every listed document with the user. Preserve these exact versions and reopen affected stages. Never infer that an interrupted decision completed.'},
  sync: {context: 'commonMutation', note: 'Retry Obsidian projection. Errors leave obsidianPending=true; never overwrite manual edits.'},
  implement: {context: 'commonMutation', required: ['userRef', 'scope', 'acceptance:string[]'], optional: ['continuation:boolean'], note: 'Separate explicit user request; continuation reuses the previously authorized scope only.'},
  verify: {context: 'commonMutation', required: ['checks:[{criterion:index,result:passed|failed|not_run,evidence}]'], optional: ['implementedDecisionIds:string[]', 'verifiedDecisionIds:string[]']},
  complete: {context: 'commonMutation', note: 'Every acceptance criterion must pass with execution evidence.'},
  grant: {context: 'commonMutation', required: ['fingerprint:64-hex from denied hook output', 'userRef'], note: 'One exact unknown call in current workflow revision; never grants a whole tool.'},
  archive: {context: 'commonMutation', required: ['question', 'answer', 'userRef'], note: 'Only usable after explicit archive opt-in. No retroactive session export.'},
};
function text(a: Args, key: string, max = 4000): string {
  const v = a[key]; if (typeof v !== 'string' || !v.trim() || v.length > max || v.includes('\0')) fail('INVALID_INPUT', `${key} 항목에 올바른 문자열이 필요합니다.`); return v;
}
function strings(a: Args, key: string): string[] {
  const v = a[key]; if (!Array.isArray(v) || !v.length || v.length > 100 || v.some(x => typeof x !== 'string' || !x.trim() || x.length > 4000)) fail('INVALID_INPUT', `${key} 항목에 비어 있지 않은 문자열 목록이 필요합니다.`); return v as string[];
}
function stageList(a: Args): Stage[] {
  const result = strings(a, 'stages'); if (result.some(s => !STAGES.includes(s as Stage))) fail('INVALID_STAGE', '알 수 없는 설계 단계입니다.'); return [...new Set(result)] as Stage[];
}
function current(w: Workflow) { return w.stages.find(s => s.stage === w.stage)!; }
function shortId(input: string): string { return digest(input).slice(0, 16); }
function owner(a: Args): Owner { assertOwner(a.owner); return a.owner; }

export class Engine {
  private batch?: DocumentBatch;
  constructor(readonly store: Store) {}
  execute(command: string, a: Args): unknown {
    // Read-only inspection stays available when interrupted writes meet manual edits.
    if(!['help','settings','status','recover'].includes(command))recoverDocuments(this.store);
    if (command === 'help') return a.command ? COMMAND_HELP[text(a, 'command')] ?? fail('UNKNOWN_COMMAND', '알 수 없는 명령입니다.') : COMMAND_HELP;
    if (command === 'settings') return this.store.settings()??null;
    if (command === 'setup') return this.setup(a);
    if (command === 'start') return this.start(a);
    if (command === 'status') {
      const o = a.owner ? owner(a) : undefined;
      const found = a.workflowId ? [this.store.get(text(a, 'workflowId'))] : o ? [this.store.findSession(o.host, o.sessionId)?.workflow].filter((w):w is Workflow => !!w) : this.store.all();
      return found.map(workflow => this.view(workflow));
    }
    if (!(command in COMMAND_HELP)) fail('UNKNOWN_COMMAND', '알 수 없는 명령입니다. help로 사용법을 확인해 주세요.');
    const ctx: MutationContext = {workflowId: text(a, 'workflowId'), owner: owner(a), expectedRevision: a.expectedRevision as number, operationId: text(a, 'operationId', 200)};
    const batch = new DocumentBatch(this.store, ctx.workflowId, ctx.operationId);
    this.batch = batch;
    try {
    const result = this.store.mutate(ctx, digest({command, input: a}), w => {
      if (w.paused && !['resume', 'handoff', 'sync', 'reconcile','recover'].includes(command)) fail('PAUSED', '중단된 작업입니다. resume으로 먼저 이어가 주세요.');
      const id = shortId(ctx.workflowId + ':' + ctx.operationId);
      this.apply(command, a, w, ctx, id);
      batch.apply(w);
    });
    batch.committed();
    if(command==='recover')recoverDocuments(this.store);
    return {...this.view(result.workflow),replayed:result.replayed};
    } catch(error) {batch.rollback();throw error;} finally {this.batch=undefined;}
  }
  private apply(command:string,a:Args,w:Workflow,ctx:MutationContext,id:string):void {
      switch (command) {
        case 'checkpoint': this.checkpoint(a,w,ctx,id); break;
        case 'pause': w.paused = true; break;
        case 'resume': w.paused = false; break;
        case 'handoff': {
          this.user(a, w); assertOwner(a.to);
          const other = this.store.findSession(a.to.host, a.to.sessionId);
          if (other && other.workflow.id !== w.id && other.workflow.run !== 'complete') fail('SESSION_BUSY', '받는 세션이 다른 작업을 진행하고 있습니다.');
          this.store.bind(w.owner, w.id, 'read-only'); w.owner = a.to; this.store.bind(w.owner, w.id); break;
        }
        case 'question': {
          this.designing(w);
          if (w.pendingQuestion && a.replace !== true) fail('QUESTION_PENDING', '이미 기다리는 질문이 있습니다. 먼저 답변을 받거나 replace로 질문을 쉽게 바꿔 주세요.');
          current(w).criteria = {};
          w.pendingQuestion = {id: 'q-' + id, stage: w.stage, kind: current(w).thoughtRef ? 'clarification' : 'thought', text: text(a, 'text', 2000), afterEventId: this.store.latestUserRef(w.owner.host, w.owner.sessionId)?.eventId};
          w.interview = current(w).thoughtRef ? 'awaiting_answer' : 'awaiting_thought'; break;
        }
        case 'answer': {
          this.designing(w); const ref = this.user(a, w);
          if (!w.pendingQuestion || text(a, 'questionId') !== w.pendingQuestion.id) fail('QUESTION_MISMATCH', '현재 기다리는 질문의 답변이 아닙니다.');
          if (ref.eventId === w.pendingQuestion.afterEventId) fail('NEW_ANSWER_REQUIRED', '질문 뒤의 새로운 사용자 답변을 기다려 주세요.');
          if (this.store.latestUserRef(ref.host, ref.sessionId)?.eventId !== ref.eventId) fail('STALE_USER_ANSWER', '가장 최근 사용자 답변을 기준으로 해석해 주세요.');
          if (!current(w).thoughtRef) current(w).thoughtRef = ref;
          (current(w).answerRefs??=[]).push(ref);
          current(w).criteria = {};
          current(w).summary = text(a, 'interpretation', 2000);
          w.pendingQuestion = undefined; w.interview = a.needsExplanation === true ? 'explaining' : 'reviewing'; break;
        }
        case 'explain': {
          this.designing(w);
          current(w).criteria = {};
          w.learning.push({id: 'l-' + id, kind: 'explained', text: text(a, 'summary', 2000)});
          w.interview = 'explaining';
          w.pendingQuestion = {id:'q-' + id, stage:w.stage,kind:current(w).thoughtRef?'clarification':'thought',text: typeof a.nextQuestion === 'string' ? text(a,'nextQuestion',2000):PROMPTS[w.stage],afterEventId:this.store.latestUserRef(w.owner.host,w.owner.sessionId)?.eventId};
          break;
        }
        case 'answer-revise': {
          this.designing(w);const ref=this.user(a,w),record=current(w);
          if(!(record.answerRefs??[]).some(r=>r.eventId===ref.eventId&&sameOwner(r,ref)))fail('ANSWER_REFERENCE_REQUIRED','현재 단계에서 이미 받은 답변의 참조로 AI 해석만 수정할 수 있습니다.');
          const replacement=text(a,'interpretation',2000),reason=text(a,'reason',2000);
          (record.interpretationRevisions??=[]).push({previous:record.summary??'',replacement,reason,userRef:ref,revision:w.revision});
          record.summary=replacement;record.criteria={};this.syncNote(w,ctx.operationId);break;
        }
        case 'learning': {
          const kind = a.kind; if (!['explained', 'user_reported', 'user_explained'].includes(String(kind))) fail('INVALID_LEARNING', '학습 기록 종류가 올바르지 않습니다.');
          w.learning.push({id:'l-'+id,kind:kind as 'explained'|'user_reported'|'user_explained',text:text(a,'text',2000),...(kind==='explained'?{}:{userRef:this.user(a,w)})}); break;
        }
        case 'issue': {
          if (a.action === 'add') { const stage = a.stage as Stage; if (!STAGES.includes(stage) || typeof a.blocking !== 'boolean') fail('INVALID_INPUT','질문의 단계와 중요 여부가 필요합니다.'); w.openItems.push({id:'i-'+id,stage,text:text(a,'text',2000),blocking:a.blocking,resolved:false}); }
          else if (a.action === 'resolve') { this.user(a,w); const item=w.openItems.find(i=>i.id===text(a,'id')); if(!item) fail('ISSUE_NOT_FOUND','해당 질문을 찾을 수 없습니다.'); item.resolved=true; if(item.blocking)w.stages.find(s=>s.stage===item.stage)!.criteria={}; }
          else fail('INVALID_INPUT','action은 add 또는 resolve여야 합니다.'); break;
        }
        case 'design': {
          this.designing(w);
          if (!current(w).thoughtRef) fail('USER_THOUGHT_REQUIRED','사용자의 생각을 먼저 듣고 설계 문서를 작성해 주세요.');
          const artifactId='design-'+w.stage;
          this.write(w,{id:artifactId,kind:'design',path:join(w.paths.designDir,w.id,`${w.stages.findIndex(s=>s.stage===w.stage)+1}-${w.stage}.md`)},text(a,'content',200000),w.paths.designDir,ctx.operationId);
          current(w).artifactId=artifactId; current(w).criteria={}; break;
        }
        case 'review': {
          this.designing(w); if (!current(w).thoughtRef) fail('USER_THOUGHT_REQUIRED','사용자의 생각을 먼저 들어 주세요.');
          if(w.pendingQuestion || w.interview==='explaining') fail('ANSWER_PENDING','사용자 답변을 기다리거나 설명 중에는 검토를 완료할 수 없습니다.');
          this.assertProjectArtifacts(w);
          const criteria=a.criteria as Record<string,Criterion>;
          if(!criteria || typeof criteria!=='object' || Array.isArray(criteria)) fail('INVALID_CRITERIA','단계별 검토 결과가 필요합니다.');
          const clean:Record<string,Criterion>={};
          for(const key of this.criteriaFor(w)) {
            const item=criteria[key];
            if(!item || !['met','deferred'].includes(item.status) || typeof item.evidence!=='string'||!item.evidence.trim()||item.evidence.length>4000) fail('INCOMPLETE_CRITERIA',`${key} 검토 근거가 필요합니다.`);
            if(item.status==='deferred') {
              if(!((['requirements','non-functional'].includes(w.stage)&&key==='evidence')||(w.stage==='deep-dive'&&key==='validation')) || typeof item.verification!=='string'||!item.verification.trim()) fail('BLOCKING_CRITERION',`${key} 판단은 해결해야 하며, 측정 보류에는 검증 계획이 필요합니다.`);
            }
            clean[key]={status:item.status,evidence:item.evidence,...(item.verification?{verification:item.verification}:{})};
          }
          if(!current(w).artifactId) fail('DESIGN_DOCUMENT_REQUIRED','먼저 현재 단계의 설계를 문서에 저장해 주세요.');
          current(w).criteria=clean; current(w).summary=text(a,'summary',2000); w.interview='reviewing'; break;
        }
        case 'advance': {
          this.designing(w); this.gate(w); current(w).status='complete';
          const next=w.stages.find(s=>s.status!=='complete');
          const nextQuestion=a.nextStageQuestion===undefined?undefined:text(a,'nextStageQuestion',2000);
          if(next) { w.stage=next.stage; next.status='active'; this.firstQuestion(w,'q-'+id,nextQuestion); }
          else {if(nextQuestion!==undefined)fail('INVALID_INPUT','마지막 단계 완료에는 다음 단계 질문을 지정할 수 없습니다.');w.interview='complete';w.pendingQuestion=undefined;w.run='awaiting_implementation';w.readyAfterEventId=this.store.latestUserRef(w.owner.host,w.owner.sessionId)?.eventId;}
          this.syncNote(w,ctx.operationId); break;
        }
        case 'reopen': this.invalidate(w,stageList(a),text(a,'reason',2000),'q-'+id); break;
        case 'decision-propose': {
          this.designing(w); if(!current(w).thoughtRef) fail('USER_THOUGHT_REQUIRED','사용자의 생각을 먼저 들은 뒤 선택지를 정리해 주세요.');
          const stages=stageList(a), decisionId='adr-'+id;
          const path=join(w.paths.adrDir,decisionId+'.md');
          const title=text(a,'title',300);
          const references=stages.flatMap(stage=>{
            const record=w.stages.find(s=>s.stage===stage)!;
            const artifact=w.artifacts.find(x=>x.id===record.artifactId);
            const target=artifact?.path??join(w.paths.designDir,w.id,`${w.stages.findIndex(s=>s.stage===stage)+1}-${stage}.md`);
            const links=[documentLink(path,target,STAGE_LABELS[stage]+' 설계',w.projectRoot)+(artifact?` / 기록 버전 ${artifact.revision}, SHA-256 ${artifact.hash}`:' / 작성 예정')];
            for(const ref of record.answerRefs??(record.thoughtRef?[record.thoughtRef]:[]))links.push(`인터뷰 참조: ${ref.host} / ${ref.sessionId} / ${ref.eventId}`);
            return links;
          });
          if(a.references!==undefined)references.push(...strings(a,'references'));
          const content=renderADR({id:decisionId,title,status:'proposed',background:text(a,'background'),choice:text(a,'choice'),alternatives:strings(a,'alternatives'),reason:text(a,'reason'),consequences:strings(a,'consequences'),verification:text(a,'verification'),revisit:text(a,'revisit'),references:[...new Set(references)]});
          this.write(w,{id:decisionId,kind:'adr',path},content,w.paths.adrDir,ctx.operationId);
          for(const record of w.stages.filter(s=>stages.includes(s.stage))){record.criteria={};if(record.status==='complete')record.status='needs_review';}
          w.decisions.push({id:decisionId,title,path,status:'proposed',stages,implementation:'pending',verification:'pending'}); break;
        }
        case 'decision-accept': {
          const ref=this.user(a,w), decision=w.decisions.find(d=>d.id===text(a,'decisionId'));
          if(!decision || decision.status!=='proposed') fail('DECISION_NOT_PROPOSED','확정할 제안 상태의 결정이 없습니다.');
          const artifact=w.artifacts.find(x=>x.id===decision.id)!;
          this.assertArtifact(artifact);
          this.write(w,artifact,patchADRStatus(this.readDocument(artifact.path),'accepted',ref),w.paths.adrDir,ctx.operationId);
          decision.status='accepted';decision.userRef=ref;this.syncNote(w,ctx.operationId);break;
        }
        case 'decision-retitle': {
          const decision=w.decisions.find(d=>d.id===text(a,'decisionId'));
          if(!decision)fail('DECISION_NOT_FOUND','제목을 수정할 결정을 찾을 수 없습니다.');
          const artifact=w.artifacts.find(x=>x.id===decision.id)!;this.assertArtifact(artifact);
          const content=this.readDocument(artifact.path),end=content.indexOf('\n');
          if(end<0||!content.startsWith('# '+decision.id+': '))fail('ADR_METADATA_MISSING','문서 제목의 형식이 달라 직접 수정 여부를 확인해야 합니다.');
          const title=text(a,'title',300).replace(/[\r\n]+/g,' '),reason=text(a,'reason',2000);
          (decision.titleRevisions??=[]).push({previous:decision.title,replacement:title,reason,revision:w.revision});
          decision.title=title;
          this.write(w,artifact,'# '+decision.id+': '+title+content.slice(end),w.paths.adrDir,ctx.operationId);
          this.syncNote(w,ctx.operationId);break;
        }
        case 'decision-supersede': {
          const ref=this.user(a,w), old=w.decisions.find(d=>d.id===text(a,'decisionId')), replacement=w.decisions.find(d=>d.id===text(a,'replacementId'));
          if(!old || old.status!=='accepted'||!replacement||replacement.status!=='accepted'||old.id===replacement.id) fail('INVALID_REPLACEMENT','기존 확정 결정과 새 확정 결정이 필요합니다.');
          const artifact=w.artifacts.find(x=>x.id===old.id)!; this.assertArtifact(artifact);
          this.write(w,artifact,patchADRStatus(this.readDocument(artifact.path),'superseded',ref,replacement.id),w.paths.adrDir,ctx.operationId);
          old.status='superseded';old.supersededBy=replacement.id;
          this.invalidate(w,[...new Set([...old.stages,...replacement.stages])],'설계 결정이 대체되어 관련 부분을 다시 검토합니다.','q-'+id); this.syncNote(w,ctx.operationId); break;
        }
        case 'reconcile': {
          this.user(a,w);const artifactId=text(a,'artifactId');let artifact=w.artifacts.find(x=>x.id===artifactId);
          if(!artifact&&artifactId==='obsidian') {
            const observed=hashFile(w.paths.obsidianNote);
            if(!observed||observed!==text(a,'observedHash'))fail('DOCUMENT_CHANGED_AGAIN','현재 개인 기록을 읽고 수정 여부를 확인해 주세요.');
            artifact={id:'obsidian',kind:'obsidian',path:w.paths.obsidianNote,hash:observed,revision:w.revision};w.artifacts.push(artifact);
          }
          if(!artifact)fail('ARTIFACT_NOT_FOUND','기록된 문서를 찾을 수 없습니다.');
          const hash=hashFile(artifact.path);if(!hash || hash!==text(a,'observedHash'))fail('DOCUMENT_CHANGED_AGAIN','문서가 다시 바뀌었거나 없어졌습니다. 현재 내용을 확인해 주세요.');
          if(!['unchanged','changed'].includes(String(a.meaning)))fail('INVALID_INPUT','수정이 설계의 의미를 바꾸는지 확인해 주세요.');
          if(artifact.kind==='obsidian') {
            // Keep any manually edited managed block verbatim as personal material before refreshing it.
            const content=readFileSync(artifact.path,'utf8');const start=content.indexOf(OBSIDIAN_START),end=content.indexOf(OBSIDIAN_END);
            if(start>=0&&end>start) {
              const preserved=content.slice(start+OBSIDIAN_START.length,end).trim();
              const newContent=content+'\n\n## 직접 수정한 기록 보존\n\n'+preserved+'\n';
              artifact.hash=hash;this.write(w,artifact,newContent,this.requireSettings().obsidianVault,ctx.operationId);
            } else artifact.hash=hash;
          } else artifact.hash=hash;
          artifact.revision=w.revision;
          if(a.meaning==='changed'&&artifact.kind!=='obsidian') this.invalidate(w,stageList(a),'사용자가 직접 수정한 설계의 의미를 반영합니다.','q-'+id);
          if(artifact.kind==='obsidian') this.syncNote(w,ctx.operationId);break;
        }
        case 'sync': this.syncNote(w,ctx.operationId);break;
        case 'recover': {
          this.user(a,w);acknowledgeRecovery(this.store,w,text(a,'pendingOperationId'),a.documents);
          this.invalidate(w,stageList(a),'저장이 중단된 문서의 현재 내용을 보존하고 관련 판단을 다시 검토합니다.','q-'+id);break;
        }
        case 'implement': {
          if(w.run!=='awaiting_implementation')fail('DESIGN_NOT_READY','모든 설계 단계의 검토를 먼저 끝내야 합니다.');
          const ref=this.user(a,w),scope=text(a,'scope'),acceptance=strings(a,'acceptance');
          if(a.continuation!==true&&(ref.eventId===w.readyAfterEventId||this.store.latestUserRef(ref.host,ref.sessionId)?.eventId!==ref.eventId))fail('NEW_IMPLEMENTATION_REQUEST_REQUIRED','설계 평가 뒤에 사용자가 직접 구현을 시작해 달라고 요청한 발화가 필요합니다.');
          if(a.continuation===true && (!w.implementationRequest || scope!==w.implementationScope || digest(acceptance)!==digest(w.acceptance)))fail('SCOPE_CHANGED','기존 요청을 이어가려면 구현 범위와 완료 조건이 같아야 합니다. 변경한 범위는 사용자의 새 요청으로 정해 주세요.');
          this.assertProjectArtifacts(w);if(w.openItems.some(x=>x.blocking&&!x.resolved)||w.decisions.some(x=>x.status==='proposed'))fail('OPEN_DECISIONS','구현을 바꿀 미해결 판단이 남아 있습니다.');
          w.implementationRequest=ref;w.implementationRevision=w.revision;w.implementationScope=scope;w.acceptance=acceptance;w.checks=[];w.run='implementing';
          this.write(w,{id:'handoff',kind:'handoff',path:join(w.paths.designDir,w.id,'implementation.md')},renderHandoff(w)+'\n\n## 구현 범위\n\n'+scope+'\n\n## 완료 조건\n\n'+acceptance.map((s,i)=>`${i+1}. ${s}`).join('\n')+'\n',w.paths.designDir,ctx.operationId);
          break;
        }
        case 'verify': {
          if(!['implementing','verifying'].includes(w.run))fail('NOT_IMPLEMENTING','구현을 시작한 작업에서 검증 결과를 기록할 수 있습니다.');
          const checks=a.checks as Workflow['checks'];
          if(!Array.isArray(checks)||!checks.length||checks.some(c=>!Number.isInteger(c.criterion)||c.criterion<0||c.criterion>=(w.acceptance?.length??0)||!['passed','failed','not_run'].includes(c.result)||typeof c.evidence!=='string'||!c.evidence.trim()))fail('INVALID_CHECKS','완료 조건 번호와 실제 검증 근거가 필요합니다.');
          if(new Set(checks.map(c=>c.criterion)).size!==checks.length)fail('INVALID_CHECKS','같은 완료 조건의 결과를 중복으로 기록할 수 없습니다.');
          w.checks=checks.map(c=>({criterion:c.criterion,result:c.result,evidence:c.evidence}));w.run='verifying';
          for(const key of ['implementedDecisionIds','verifiedDecisionIds']) if(a[key]!==undefined) {
            for(const decisionId of strings(a,key)) {const d=w.decisions.find(x=>x.id===decisionId);if(!d||d.status!=='accepted')fail('DECISION_NOT_FOUND','확정된 결정만 구현 결과와 연결할 수 있습니다.');if(key==='implementedDecisionIds')d.implementation='implemented';else {if(d.implementation!=='implemented'||!this.allPassed(w))fail('VERIFICATION_INCOMPLETE','구현과 모든 완료 조건의 검증을 먼저 확인해 주세요.');d.verification='verified';}
              const artifact=w.artifacts.find(x=>x.id===d.id)!;this.assertArtifact(artifact);this.write(w,artifact,patchADRProgress(this.readDocument(artifact.path),{implementation:d.implementation,verification:d.verification},w.checks.map(c=>`${w.acceptance![c.criterion]} / ${c.result} / ${c.evidence}`)),w.paths.adrDir,ctx.operationId);
            }
          } break;
        }
        case 'complete': if(w.run!=='verifying'||!this.allPassed(w))fail('VERIFICATION_INCOMPLETE','모든 완료 조건에 실제 통과 근거가 있어야 완료할 수 있습니다.');else{this.assertProjectArtifacts(w);w.run='complete';this.store.endInvocation(w.owner.host,w.owner.sessionId);this.syncNote(w,ctx.operationId);}break;
        case 'grant': {this.user(a,w);const fp=text(a,'fingerprint');if(!/^[a-f0-9]{64}$/.test(fp))fail('INVALID_GRANT','차단된 정확한 호출의 식별값이 필요합니다.');this.store.addGrant(w,fp);break;}
        case 'archive': this.store.archive(w,text(a,'question',100000),text(a,'answer',100000),this.user(a,w));break;
      }
  }
  view(w:Workflow) {return {workflow:w,progress:renderProgress(w),requiredCriteria:this.criteriaFor(w),latestUserRef:this.store.latestUserRef(w.owner.host,w.owner.sessionId),pendingRecovery:pendingRecovery(this.store).filter(r=>r.workflowId===w.id)};}
  private criteriaFor(w:Workflow):readonly string[] {
    // Older six-stage workflows keep their original quality gate and document order.
    return w.stage==='requirements'&&!w.stages.some(s=>s.stage==='non-functional')
      ? ['scope','exclusions','quality','evidence'] : CRITERIA[w.stage];
  }
  private checkpoint(a:Args,w:Workflow,ctx:MutationContext,id:string):void {
    this.designing(w);
    const record=current(w), refs=a.userRefs as UserRef[];
    if(!Array.isArray(refs)||!refs.length||refs.length>100)fail('USER_EVIDENCE_REQUIRED','이번 주제에 해당하는 사용자 발화 참조가 필요합니다.');
    const savedBoundaries=[record.checkpointRef,record.answerRefs?.at(-1)];
    let previous=Math.max(0,...savedBoundaries.filter((ref):ref is UserRef=>!!ref).map(ref=>this.store.eventSequence(ref)));
    const questionBoundary=w.pendingQuestion?.afterEventId?this.store.eventSequence({...w.owner,actor:'user',eventId:w.pendingQuestion.afterEventId}):0;
    const initial=record.stage==='requirements'&&!record.thoughtRef&&!record.answerRefs?.length&&!record.checkpointRef?record.initialUserRef:undefined;
    for(const [index,ref] of refs.entries()){
      this.store.assertUserRef(ref,w.owner);
      const seq=this.store.eventSequence(ref),isInitial=index===0&&!!initial&&sameOwner(ref,initial)&&ref.eventId===initial.eventId;
      if(seq<=previous||(!isInitial&&seq<=questionBoundary))fail('NEW_ANSWER_REQUIRED','참조는 이전 저장 이후의 발화를 시간 순서대로 지정해야 합니다.');
      previous=seq;
    }
    const latest=this.store.latestUserRef(w.owner.host,w.owner.sessionId),first=refs[0]!;
    const onlyInitial=refs.length===1&&!!initial&&sameOwner(first,initial)&&first.eventId===initial.eventId;
    if(refs.at(-1)!.eventId!==latest?.eventId&&!(onlyInitial&&latest?.eventId===record.initialBoundaryEventId))fail('STALE_USER_ANSWER','가장 최근 답변까지 반영한 주제를 저장해 주세요.');
    if(a.advance!==undefined&&typeof a.advance!=='boolean')fail('INVALID_INPUT','advance는 boolean이어야 합니다.');
    if(a.advance===true&&a.nextQuestion!==undefined)fail('INVALID_INPUT','단계 이동과 같은 단계의 다음 질문을 함께 지정할 수 없습니다.');
    if(a.advance!==true&&a.nextStageQuestion!==undefined)fail('INVALID_INPUT','다음 단계 질문은 단계 이동 시에만 지정할 수 있습니다.');
    record.thoughtRef??=refs[0];
    record.answerRefs=[...(record.answerRefs??[]),...refs].filter((ref,i,all)=>all.findIndex(r=>r.eventId===ref.eventId&&sameOwner(r,ref))===i);
    record.checkpointRef=refs.at(-1);record.topic=text(a,'topic',300);record.summary=text(a,'interpretation',2000);record.criteria={};
    w.pendingQuestion=undefined;w.interview='reviewing';
    this.apply('design',{content:a.content},w,ctx,id);
    const items=(key:string):Args[]=>{if(a[key]===undefined)return [];const value=a[key];if(!Array.isArray(value)||value.length>30||value.some(x=>!x||typeof x!=='object'||Array.isArray(x)))fail('INVALID_INPUT',key+' 목록이 올바르지 않습니다.');return value as Args[];};
    for(const [i,decision] of items('decisions').entries()){
      const childId=shortId(id+':decision:'+i);
      this.apply('decision-propose',decision,w,ctx,childId);
      if(decision.userRef!==undefined){
        const ref=decision.userRef as UserRef;
        this.store.assertUserRef(ref,w.owner);
        if(!refs.some(r=>r.eventId===ref.eventId&&sameOwner(r,ref)))fail('USER_EVIDENCE_REQUIRED','확정할 선택의 근거는 이번 주제의 참조에 포함해야 합니다.');
        this.apply('decision-accept',{decisionId:'adr-'+childId,userRef:ref},w,ctx,childId);
      }
    }
    for(const [i,item] of items('issues').entries())this.apply('issue',item,w,ctx,shortId(id+':issue:'+i));
    for(const [i,item] of items('learning').entries())this.apply('learning',item,w,ctx,shortId(id+':learning:'+i));
    if(a.criteria!==undefined)this.apply('review',{criteria:a.criteria,summary:a.reviewSummary??record.summary},w,ctx,id);
    if(a.advance===true)this.apply('advance',{nextStageQuestion:a.nextStageQuestion},w,ctx,id);
    else if(a.nextQuestion!==undefined)this.apply('question',{text:a.nextQuestion},w,ctx,id);
    this.syncNote(w,ctx.operationId);
  }
  private setup(a:Args): Settings {
    const setupOwner=owner(a);
    const vault=canonical(text(a,'obsidianVault'));if(!existsSync(vault)||!statSync(vault).isDirectory())fail('VAULT_NOT_FOUND','기존 Obsidian 볼트 폴더를 선택해 주세요.');
    const folder=text(a,'obsidianFolder');if(isAbsolute(folder)||!inside(vault,canonical(resolve(vault,folder))))fail('INVALID_NOTE_FOLDER','Obsidian 기록 폴더는 선택한 볼트 안에 있어야 합니다.');
    if(typeof a.archiveEnabled!=='boolean')fail('ARCHIVE_CHOICE_REQUIRED','대화 원문 추가 보관 여부를 먼저 선택해 주세요.');
    const previous=this.store.settings(); let consent=previous?.archiveConsent;
    if(a.archiveEnabled&&!previous?.archiveEnabled){consent=a.userRef as UserRef;this.store.assertUserRef(consent,setupOwner);}
    const settings:Settings={version:1,obsidianVault:vault,obsidianFolder:folder,archiveEnabled:a.archiveEnabled,...(a.archiveEnabled&&consent?{archiveConsent:consent}:{})};this.store.saveSettings(settings);this.store.endInvocation(setupOwner.host,setupOwner.sessionId);return settings;
  }
  private requireSettings():Settings {return this.store.settings()??fail('SETUP_REQUIRED','먼저 setup에서 기록 위치와 원문 보관 여부를 정해 주세요.');}
  private start(a:Args):unknown {
    const settings=this.requireSettings(),o=owner(a),root=canonical(text(a,'projectRoot')),title=text(a,'title',300);
    if(!existsSync(root)||!statSync(root).isDirectory())fail('PROJECT_NOT_FOUND','기존 프로젝트 폴더가 필요합니다.');
    if(inside(root,this.store.dir))fail('STATE_IN_PROJECT','진행 정보는 프로젝트 밖에 보관해야 합니다.');
    return this.store.transaction(()=>{
      const binding=this.store.findSession(o.host,o.sessionId);
      if(binding&&binding.workflow.run!=='complete') {
        if(!binding.readOnly&&binding.workflow.projectRoot===root&&binding.workflow.title===title)return this.view(binding.workflow);
        fail('SESSION_BUSY','이 세션에 이미 연결된 작업이 있습니다. 이어가거나 작업을 넘겨 주세요.');
      }
      const prior=this.store.all().find(w=>w.projectRoot===root);
      const pathInput=(key:'designDir'|'adrDir')=> typeof a[key]==='string'?canonical(resolve(root,text(a,key))):prior?.paths[key]??fail('PROJECT_SETUP_REQUIRED','프로젝트의 설계 문서와 ADR 위치를 먼저 선택해 주세요.',{suggestedDesignDir:'docs/system-design',suggestedAdrDir:'docs/adr'});
      const designDir=pathInput('designDir'),adrDir=pathInput('adrDir');
      if(!inside(root,designDir)||!inside(root,adrDir)||designDir===root||adrDir===root||inside(designDir,adrDir)||inside(adrDir,designDir))fail('INVALID_PROJECT_PATHS','설계 문서와 ADR은 프로젝트 안의 서로 구분된 폴더에 보관해야 합니다.');
      const id='w-'+randomUUID();
      const note= typeof a.obsidianNote==='string'?canonical(resolve(settings.obsidianVault,text(a,'obsidianNote'))):prior?join(settings.obsidianVault,settings.obsidianFolder,id+'.md'):fail('NOTE_PATH_REQUIRED','개인 Obsidian의 진행 기록 위치를 먼저 선택해 주세요.');
      if(!inside(settings.obsidianVault,note)||!note.endsWith('.md')||inside(designDir,note)||inside(adrDir,note))fail('INVALID_NOTE_PATH','개인 기록은 볼트 안의 별도 Markdown 문서여야 합니다.');
      if(this.store.all().some(w=>w.paths.obsidianNote===note))fail('NOTE_IN_USE','다른 설계 작업이 사용하는 개인 기록입니다. 새 문서 이름을 선택해 주세요.');
      const initialUserRef=a.initialUserRef as UserRef|undefined;
      if(initialUserRef!==undefined)this.store.assertUserRef(initialUserRef,o);
      const firstQuestion=a.firstQuestion===undefined?undefined:text(a,'firstQuestion',2000);
      const now=new Date().toISOString();
      const w:Workflow={id,title,projectRoot:root,owner:o,revision:0,stage:'requirements',interview:'awaiting_thought',run:'designing',paused:false,stages:STAGES.map(stage=>({stage,status:stage==='requirements'?'active':'pending',criteria:{}})),openItems:[],decisions:[],learning:[],artifacts:[],paths:{designDir,adrDir,obsidianNote:note},obsidianPending:false,createdAt:now,updatedAt:now};
      if(initialUserRef){current(w).initialUserRef=initialUserRef;current(w).initialBoundaryEventId=this.store.latestUserRef(o.host,o.sessionId)?.eventId;}
      this.firstQuestion(w,'q-'+randomUUID(),firstQuestion);this.store.put(w);this.store.bind(o,w.id);return this.view(w);
    });
  }
  private user(a:Args,w:Workflow):UserRef {const ref=a.userRef as UserRef;this.store.assertUserRef(ref,w.owner);return ref;}
  private designing(w:Workflow):void {if(w.run!=='designing')fail('NOT_DESIGNING','설계 변경은 reopen으로 관련 단계부터 다시 검토해 주세요.');}
  private firstQuestion(w:Workflow,id:string,question?:string):void {w.interview='awaiting_thought';w.pendingQuestion={id,stage:w.stage,kind:'thought',text:question??PROMPTS[w.stage],afterEventId:this.store.latestUserRef(w.owner.host,w.owner.sessionId)?.eventId};}
  private readDocument(path:string):string {return this.batch?.content(path)??readFileSync(path,'utf8');}
  private assertArtifact(artifact:Artifact):void {const actual=this.batch?.pendingHash(artifact.path)??hashFile(artifact.path);if(actual!==artifact.hash)fail('DOCUMENT_CONFLICT','직접 수정되었거나 없어진 문서입니다. 내용을 확인하고 reconcile로 반영해 주세요.',{artifactId:artifact.id,path:artifact.path,actualHash:actual,expectedHash:artifact.hash});}
  private assertProjectArtifacts(w:Workflow):void {for(const artifact of w.artifacts.filter(a=>a.kind!=='obsidian'))this.assertArtifact(artifact);}
  private write(w:Workflow,target:Pick<Artifact,'id'|'kind'|'path'>,content:string,allowedRoot:string,operationId:string):void {
    if(!this.batch)fail('DOCUMENT_TRANSACTION_REQUIRED','문서 저장은 진행 상태와 함께 처리해야 합니다.');
    this.batch.stage(w,target,content,allowedRoot,target.kind==='obsidian');
  }
  private syncNote(w:Workflow,operationId:string):void {
    try {
      const settings=this.requireSettings();const previous=w.artifacts.find(a=>a.id==='obsidian');
      if(previous)this.assertArtifact(previous);
      else if(hashFile(w.paths.obsidianNote)!==null)fail('DOCUMENT_CONFLICT','기존 개인 기록을 먼저 확인해 주세요. 새 기록 위치를 선택하거나 수동 수정으로 등록해야 합니다.');
      const old=this.batch?.pendingHash(w.paths.obsidianNote)||existsSync(w.paths.obsidianNote)?this.readDocument(w.paths.obsidianNote):null;
      w.obsidianPending=false;w.obsidianError=undefined;
      this.write(w,{id:'obsidian',kind:'obsidian',path:w.paths.obsidianNote},mergeObsidian(old,renderObsidian(w)),settings.obsidianVault,operationId);
    } catch(error) {w.obsidianPending=true;w.obsidianError=error instanceof DesignError?error.code:'NOTE_WRITE_FAILED';}
  }
  private gate(w:Workflow):void {
    const stage=current(w);if(!stage.thoughtRef)fail('USER_THOUGHT_REQUIRED','사용자의 생각을 먼저 들어 주세요.');
    if(w.pendingQuestion||w.interview!=='reviewing')fail('ANSWER_PENDING','기다리는 답변이나 검토가 남아 있습니다.');
    if(!stage.artifactId)fail('DESIGN_DOCUMENT_REQUIRED','설계 문서가 저장되어야 합니다.');
    if(this.criteriaFor(w).some(k=>!stage.criteria[k]))fail('INCOMPLETE_CRITERIA','현재 단계의 검토 기준을 모두 확인해 주세요.');
    if(w.openItems.some(i=>i.stage===w.stage&&i.blocking&&!i.resolved)||w.decisions.some(d=>d.stages.includes(w.stage)&&d.status==='proposed'))fail('OPEN_DECISIONS','구현을 바꿀 미해결 판단이 남아 있습니다.');
    this.assertProjectArtifacts(w);
  }
  private invalidate(w:Workflow,stages:Stage[],reason:string,questionId:string):void {
    for(const s of w.stages.filter(s=>stages.includes(s.stage))){s.status='needs_review';s.criteria={};s.thoughtRef=undefined;}
    w.stage=w.stages.find(s=>s.status!=='complete')!.stage;current(w).status='active';w.run='designing';w.checks=[];
    this.firstQuestion(w,questionId);w.openItems.push({id:'change-'+questionId,stage:w.stage,text:reason,blocking:false,resolved:false});
  }
  private allPassed(w:Workflow):boolean {return !!w.acceptance?.length&&w.acceptance.every((_,i)=>w.checks?.some(c=>c.criterion===i&&c.result==='passed'&&c.evidence.trim()));}
}
