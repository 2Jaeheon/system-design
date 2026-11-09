import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import type { Workflow } from '../src/types.js';

const cli=resolve('build/src/cli.js');
function call(state:string,command:string,input:object) {
  const child=spawnSync(process.execPath,[cli,command,'--input',JSON.stringify(input)],{
    env:{...process.env,SYSTEM_DESIGN_STATE_DIR:state},encoding:'utf8',
  });
  assert.ok(child.stdout,child.stderr);
  return {status:child.status,body:JSON.parse(child.stdout)};
}

test('read-only inspection of missing state creates no persistent directory or database',t=>{
  const base=mkdtempSync(join(tmpdir(),'system-design-read-empty-')),state=join(base,'absent');
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  assert.equal(call(state,'settings',{}).body.result,null);
  assert.deepEqual(call(state,'status',{owner:{host:'codex',sessionId:'missing'}}).body.result,[]);
  assert.equal(call(state,'status',{workflowId:'missing'}).body.error.code,'WORKFLOW_NOT_FOUND');
  assert.equal(existsSync(state),false);
});

test('read-only CLI reads live WAL state and a nonwritable directory without changing the database',t=>{
  const base=mkdtempSync(join(tmpdir(),'system-design-read-only-')),state=join(base,'state');
  const project=join(base,'project'),vault=join(base,'vault');mkdirSync(project);mkdirSync(vault);
  t.after(()=>{if(existsSync(state))chmodSync(state,0o700);rmSync(base,{recursive:true,force:true});});
  const store=new Store(state),engine=new Engine(store),owner={host:'codex',sessionId:'read-only'};
  engine.execute('setup',{owner,obsidianVault:vault,obsidianFolder:'notes',archiveEnabled:false});
  const started=engine.execute('start',{owner,title:'조회 테스트',projectRoot:project,designDir:'design',adrDir:'adr',obsidianNote:'notes/test.md'}) as {workflow:Workflow};
  // The writer remains open here: a read-only connection must include live WAL data.
  assert.equal(call(state,'status',{owner}).body.result[0].workflowId,started.workflow.id);
  assert.equal(call(state,'settings',{}).body.result.archiveEnabled,false);
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  store.close();
  const file=join(state,'state.sqlite'),before=createHash('sha256').update(readFileSync(file)).digest('hex');
  chmodSync(file,0o400);chmodSync(state,0o500);
  assert.equal(call(state,'status',{owner}).body.result[0].workflowId,started.workflow.id);
  assert.equal(call(state,'settings',{}).body.result.archiveEnabled,false);
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),before);
  assert.throws(()=>{const readOnly=new Store(state,{readOnly:true});try{readOnly.db.prepare('DELETE FROM settings').run();}finally{readOnly.close();}});
});

test('an inaccessible or invalid state database reports a useful state-open error',t=>{
  const base=mkdtempSync(join(tmpdir(),'system-design-read-error-')),state=join(base,'state');
  mkdirSync(join(state,'state.sqlite'),{recursive:true});
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const result=call(state,'settings',{});
  assert.notEqual(result.status,0);
  assert.equal(result.body.error.code,'STATE_OPEN_FAILED');
  assert.match(result.body.error.message,/진행 정보를 열 수 없습니다/u);
});
