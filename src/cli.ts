#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, COMMAND_HELP } from './engine.js';
import { Store, DEFAULT_STATE_DIR } from './store.js';
import { DesignError, type Host } from './types.js';
import { processHook, isExplicitInvocation } from './hooks.js';
import { compactResult, hookContext } from './output.js';

function input(args:string[]):Record<string,unknown> {
  const idx=args.indexOf('--input');
  const raw=idx>=0?args[idx+1]:args.includes('--stdin')?readFileSync(0,'utf8'):'{}';
  if(!raw||raw.length>1_000_000)throw new DesignError('INVALID_INPUT','입력이 없거나 너무 큽니다.');
  try { const value:unknown=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value as Record<string,unknown>; }
  catch{throw new DesignError('INVALID_JSON','입력은 JSON 객체여야 합니다. 내용은 오류 로그에 남기지 않았습니다.');}
}
function output(value:unknown):void {process.stdout.write(JSON.stringify(value)+'\n');}
function main():void {
  const [command,...args]=process.argv.slice(2);
  if(command==='hook'){runHook(args);return;}
  let store:Store|undefined;
  try {
    if(command==='--version'){output({ok:true,result:{version:'0.1.9'}});return;}
    if(!command||command==='help'||command==='--help') {
      const a=input(args),name=typeof a.command==='string'?a.command:undefined;
      output({ok:true,result:name?COMMAND_HELP[name]??{error:'unknown command'}:COMMAND_HELP});return;
    }
    const a=input(args),readOnly=command==='settings'||command==='status';
    try { store=new Store(undefined,{readOnly}); }
    catch(error) {
      const e=error as NodeJS.ErrnoException & {errcode?:number};
      if(['EACCES','EPERM'].includes(e.code??'')||(e.code==='ERR_SQLITE_ERROR'&&[8,10,14,23].includes((e.errcode??0)&255)))
        throw new DesignError('STATE_OPEN_FAILED','진행 정보를 열 수 없습니다. 상태 폴더의 접근 권한과 DB 상태를 확인해 주세요.');
      throw error;
    }
    output({ok:true,result:a.detail==='full'?new Engine(store).execute(command,a):compactResult(new Engine(store).execute(command,a),command)});
  } catch(error) {
    // No input, prompt, stack, or file content is ever included in an error response.
    const e=error instanceof DesignError?error:new DesignError('INTERNAL_ERROR','처리를 완료하지 못했습니다. 기록을 보존하고 현황을 확인해 주세요.');
    output({ok:false,error:{code:e.code,message:e.message,...(e.details?{details:e.details}:{})}});process.exitCode=1;
  } finally {store?.close();}
}
function runHook(args:string[]):void {
  let store:Store|undefined;let event:Record<string,unknown>={};
  try {
    const idx=args.indexOf('--host'),host=args[idx+1] as Host;
    if(!['codex','claude'].includes(host))throw new Error('invalid host');
    const raw=readFileSync(0,'utf8');if(raw.length>1_000_000)throw new Error('oversized');
    event=JSON.parse(raw) as Record<string,unknown>;
    const file=join(process.env.SYSTEM_DESIGN_STATE_DIR||DEFAULT_STATE_DIR,'state.sqlite');
    const explicitlyInvoked=event.hook_event_name==='UserPromptSubmit'&&typeof event.prompt==='string'&&isExplicitInvocation(event.prompt);
    if(!existsSync(file)&&!explicitlyInvoked){output({});return;}
    store=new Store();const s=store;
    const result=processHook(host,event,{
      cliPath:fileURLToPath(import.meta.url),nodePath:process.execPath,
      findSession:(h,id,cwd)=>s.findSession(h,id,cwd),
      recordUserEvent:(h,id,turn,hash)=>s.recordUserEvent(h,id,turn,hash),
      latestUserRef:(h,id)=>s.latestUserRef(h,id),
      markInvoked:(h,id)=>s.markInvoked(h,id),isInvokedSession:(h,id)=>s.isInvokedSession(h,id),
      context:hookContext,
      consumeGrant:(w,o,f)=>s.consumeGrant(w,o,f),
      archivePrompt:(w,prompt,ref)=>{
        if(!s.settings()?.archiveEnabled)return;
        // Explicit archive mode only. Normal operation never retains this text.
        s.archive(w,w.pendingQuestion?.text??'(해당 작업의 사용자 입력)',prompt,ref);
      },
    });output(result);
  } catch {
    // Avoid leaking raw hook JSON even on malformed data. Deny supported tool calls on guard failure.
    if(event.hook_event_name==='PreToolUse')output({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'system-design 진행 상태를 읽지 못해 실행을 중단했습니다. 설정과 저장 상태를 확인해 주세요.'}});
    else output({systemMessage:'system-design 진행 정보를 복원하지 못했습니다. 원문은 오류 기록에 남기지 않았습니다.'});
  } finally {store?.close();}
}
main();
