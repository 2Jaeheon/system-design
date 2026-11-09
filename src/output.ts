import type { Workflow, UserRef } from './types.js';
interface View { workflow:Workflow; requiredCriteria:readonly string[]; latestUserRef?:UserRef; pendingRecovery:unknown[]; replayed?:boolean }
export function hookContext(w:Workflow):string {
  return JSON.stringify({workflowId:w.id,owner:w.owner,expectedRevision:w.revision,stage:w.stage,run:w.run,paused:w.paused,pendingQuestion:w.pendingQuestion,obsidianPending:w.obsidianPending,...(w.obsidianError?{obsidianError:w.obsidianError}:{})});
}
export function compactResult(value:unknown,command:string):unknown {
  if(Array.isArray(value))return value.map(x=>compactResult(x,command));
  if(!value||typeof value!=='object'||!('workflow' in value))return value;
  const v=value as View,w=v.workflow,record=w.stages.find(s=>s.stage===w.stage)!;
  const resume=command==='status'||command==='start'||command==='handoff';
  return {workflowId:w.id,owner:w.owner,expectedRevision:w.revision,stage:w.stage,
    stageNumber:w.stages.indexOf(record)+1,totalStages:w.stages.length,run:w.run,paused:w.paused,
    pendingQuestion:w.pendingQuestion,requiredCriteria:v.requiredCriteria,
    ...(resume?{summary:record.summary,...(!record.thoughtRef&&!record.answerRefs?.length&&record.initialUserRef?{initialUserRef:record.initialUserRef}:{}),completedStages:w.stages.filter(s=>s.status==='complete').map(s=>s.stage),paths:w.paths,openItems:w.openItems.filter(i=>!i.resolved)}:{}),
    decisions:w.decisions.filter(d=>resume||w.artifacts.some(a=>a.id===d.id&&a.revision===w.revision)).map(d=>({id:d.id,status:d.status})),
    artifacts:w.artifacts.filter(a=>resume||a.revision===w.revision).map(a=>({id:a.id,path:a.path})),
    latestUserRef:v.latestUserRef,obsidianPending:w.obsidianPending,...(w.obsidianError?{obsidianError:w.obsidianError}:{}),
    ...(v.pendingRecovery.length?{pendingRecovery:v.pendingRecovery}:{}),...(v.replayed!==undefined?{replayed:v.replayed}:{})};
}
