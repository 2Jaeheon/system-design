import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {compactResult} from '../src/output.js';
import {Store,digest} from '../src/store.js';
import {Engine} from '../src/engine.js';
import type {Workflow} from '../src/types.js';

test('CLI compact and full views preserve versions, questions and recovery failures',t=>{
 const base=mkdtempSync(join(tmpdir(),'system-design-output-')),state=join(base,'state');
 mkdirSync(join(base,'project'));mkdirSync(join(base,'vault'));
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 const store=new Store(state),engine=new Engine(store),owner={host:'codex',sessionId:'output-test'};
 engine.execute('setup',{owner,obsidianVault:join(base,'vault'),obsidianFolder:'notes',archiveEnabled:false});
 const result=engine.execute('start',{owner,title:'테스트',projectRoot:join(base,'project'),designDir:'docs/design',adrDir:'docs/adr',obsidianNote:'notes/test.md'}) as {workflow:Workflow};
 store.recordUserEvent('codex','output-test','event-1',digest('범위 생각'));
 store.close();
 const cli=resolve('build/src/cli.js');
 const call=(args:object)=>{
  const child=spawnSync(process.execPath,[cli,'status','--input',JSON.stringify(args)],{env:{...process.env,SYSTEM_DESIGN_STATE_DIR:state},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout).result[0];
 };
 const small=call({owner}),full=call({owner,detail:'full'});
 assert.equal(small.expectedRevision,full.workflow.revision);
 assert.equal(small.workflowId,result.workflow.id);
 assert.deepEqual(small.pendingQuestion,full.workflow.pendingQuestion);
 assert.equal(small.workflow,undefined);
 assert.ok(JSON.stringify(small).length<JSON.stringify(full).length);
 const recovery=[{workflowId:result.workflow.id,path:'/changed.md',observedHash:null}];
 const projected=compactResult({...full,pendingRecovery:recovery,workflow:{...full.workflow,obsidianPending:true,obsidianError:'DOCUMENT_CONFLICT'}},'checkpoint') as Record<string,unknown>;
 assert.deepEqual(projected.pendingRecovery,recovery);assert.equal(projected.obsidianError,'DOCUMENT_CONFLICT');
 const help=spawnSync(process.execPath,[cli,'help','--input','{}'],{encoding:'utf8'});
 assert.ok(JSON.parse(help.stdout).result.checkpoint);
});
