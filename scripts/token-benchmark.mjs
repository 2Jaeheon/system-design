// Synthetic, local text comparison. No conversations or API requests are used.
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {getEncoding} from 'js-tiktoken';
import {Engine} from '../build/src/engine.js';
import {Store,digest} from '../build/src/store.js';
import {compactResult} from '../build/src/output.js';
import {renderProgress} from '../build/src/documents.js';
import {processHook} from '../build/src/hooks.js';
const encoder=getEncoding('o200k_base');
const normalize=s=>s.replace(/w-[0-9a-f-]{36}/g,'w-example').replace(/q-[0-9a-f-]{36}/g,'q-example').replace(/(?:adr|q|l|i)-[a-f0-9]{16}/g,'id-example').replace(/[a-f0-9]{64}/g,'HASH').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g,'DATE').replace(/\/private\/tmp\/sd-token-[^/"\\]+|\/tmp\/sd-token-[^/"\\]+|\/var\/folders\/[^"\\]+?\/sd-token-[^/"\\]+/g,'/fixture');
const tokens=value=>encoder.encode(normalize(typeof value==='string'?value:JSON.stringify(value))).length;
const samples=[
 {summary:'결과를 만든 뒤 공개할 수 있다.',question:'자동 공개인가요?'},
 {summary:'결과를 확인한 뒤 게시한다.',question:'직접 게시 버튼을 누르나요?'},
 {summary:'완성 결과는 작성자만 확인하고 직접 게시하면 공개한다.',question:'저장 기능은 어떻게 사용하나요?'}
];
function run(compact){
 const base=mkdtempSync(join(tmpdir(),'sd-token-'));mkdirSync(join(base,'project'));mkdirSync(join(base,'vault'));
 const store=new Store(join(base,'state')),engine=new Engine(store),owner={host:'codex',sessionId:'benchmark'},requests=[],responses=[];
 let w,operation=0;
 const event=i=>store.recordUserEvent(owner.host,owner.sessionId,'event-'+i,digest('synthetic '+i));
 const execute=(cmd,args)=>{const input={workflowId:w.id,owner,expectedRevision:w.revision,operationId:'op-'+(++operation),...args};const result=engine.execute(cmd,input);requests.push(tokens({command:cmd,input}));responses.push(tokens({ok:true,result:compact?compactResult(result,cmd):result}));w=result.workflow;return result;};
 try{
  engine.execute('setup',{owner,obsidianVault:join(base,'vault'),obsidianFolder:'notes',archiveEnabled:false});
  w=engine.execute('start',{owner,title:'공개 방식',projectRoot:join(base,'project'),designDir:'docs/design',adrDir:'docs/adr',obsidianNote:'notes/progress.md'}).workflow;
  const decision={title:'직접 게시할 때 공개',background:'생성과 공개를 구분한다.',choice:'사용자가 게시하면 공개한다.',alternatives:['자동 공개'],reason:'사용자가 공개 시점을 정한다.',consequences:['게시 동작이 필요하다.'],verification:'게시 전 비공개를 확인한다.',revisit:'공개 정책 변경 시',stages:['requirements']};
  const refs=[];
  for(let i=0;i<samples.length;i++){
   refs.push(event(i+1));const sample=samples[i];
   if(!compact){
    execute('answer',{questionId:w.pendingQuestion.id,userRef:refs.at(-1),interpretation:sample.summary});
    execute('design',{content:'# 공개 방식\n\n'+sample.summary});
    if(i===samples.length-1){execute('decision-propose',decision);execute('decision-accept',{decisionId:w.decisions.at(-1).id,userRef:refs.at(-1)});}
    execute('question',{text:sample.question});
   }
  }
  const last=samples.at(-1);
  if(compact)execute('checkpoint',{topic:'공개 방식',userRefs:refs,interpretation:last.summary,content:'# 공개 방식\n\n'+last.summary,decisions:[{...decision,userRef:refs.at(-1)}],nextQuestion:last.question});
  else execute('sync',{});
  assert.equal(w.stages[0].summary,last.summary);assert.equal(w.decisions[0].status,'accepted');assert.equal(w.pendingQuestion.text,last.question);
  assert.ok(readFileSync(w.paths.obsidianNote,'utf8').includes(last.question));
  const full=engine.view(w),statusFull=tokens(full),statusCompact=tokens(compactResult(full,'status'));
  const ref=refs.at(-1);
  const oldContext=['system-design 실행 정보','CLI: /plugin/runtime/cli.js',`현재 세션: ${JSON.stringify(owner)}`,'CLI 입력은 --input의 JSON 문자열로 전달한다. 제품 코드와 기록 변경은 현재 단계 규칙을 따른다.',`사용자 발화 참조: ${JSON.stringify(ref)}`,'이 참조는 실제 사용자 차례의 위치이며, AI 해석의 정확성을 보증하지 않는다.',renderProgress(w),JSON.stringify({workflowId:w.id,owner:w.owner,expectedRevision:w.revision,paused:w.paused,pendingQuestion:w.pendingQuestion,obsidianPending:w.obsidianPending})].join('\n');
  const port={cliPath:'/plugin/runtime/cli.js',findSession:()=>({workflow:w,readOnly:false}),recordUserEvent:()=>ref,latestUserRef:()=>ref,context:()=>'',consumeGrant:()=>false};
  const hook=processHook('codex',{session_id:owner.sessionId,hook_event_name:'UserPromptSubmit',turn_id:ref.eventId,prompt:'synthetic'},port);
  return {calls:requests.length,inputTokens:requests.reduce((a,b)=>a+b,0),outputTokens:responses.reduce((a,b)=>a+b,0),status:{full:statusFull,compact:statusCompact},hook:{before:tokens(oldContext),after:tokens(hook.hookSpecificOutput.additionalContext)}};
 }finally{store.close();rmSync(base,{recursive:true,force:true});}
}
const before=run(false),after=run(true),percent=(a,b)=>Math.round((1-b/a)*1000)/10;
const report={method:'Synthetic three-answer topic, same final summary/accepted ADR/next question/Obsidian note. Counts serialized command+input and response JSON only, without shell wrappers. Variable IDs, hashes, dates and fixture paths normalized.',encoding:'o200k_base (comparison only; not billed model usage)',before,after,reductionPercent:{calls:percent(before.calls,after.calls),input:percent(before.inputTokens,after.inputTokens),output:percent(before.outputTokens,after.outputTokens),combined:percent(before.inputTokens+before.outputTokens,after.inputTokens+after.outputTokens)},instructionTokens:{current:tokens(readFileSync(resolve('skills/system-design/SKILL.md'),'utf8'))}};
if(process.argv[2]){const old=readFileSync(join(process.argv[2],'system-design/SKILL.md'),'utf8');report.instructionTokens.before=tokens(old);report.instructionTokens.reductionPercent=percent(tokens(old),report.instructionTokens.current);report.startupGuideTokens={before:tokens(old)+tokens(readFileSync(join(process.argv[2],'system-design/references/cli.md'),'utf8')),after:report.instructionTokens.current+tokens(readFileSync(resolve('skills/system-design/references/cli.md'),'utf8'))};}
console.log(JSON.stringify(report,null,2));
