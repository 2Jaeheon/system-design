import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isExplicitInvocation } from '../src/hooks.js';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}

test('host packages are self-contained, explicit-only and register each hook once', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'system-design-package-'));
  try {
    await cp(join(sourceRoot, 'skills'), join(fixture, 'skills'), { recursive: true });
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ version: '0.1.0-test', engines: { node: '>=26.5.0 <27' } }));
    await mkdir(join(fixture, 'build/src'), { recursive: true });
    await writeFile(join(fixture, 'build/src/cli.js'), 'import { value } from "./value.js"; console.log(JSON.stringify({ok:true,result:value}));\n');
    await writeFile(join(fixture, 'build/src/value.js'), 'export const value = "packaged runtime";\n');
    await writeFile(join(fixture, 'build/src/private.d.ts'), 'export type Private = never;\n');
    const packaging = await import(pathToFileURL(join(sourceRoot, 'scripts/package.mjs')).href);
    const outputs = await packaging.buildPackages({ sourceRoot: fixture }) as Record<string, string>;
    for (const host of ['codex', 'claude'] as const) {
      const packageRoot = outputs[host]!;
      const manifestPath = join(packageRoot, host === 'codex' ? '.codex-plugin/plugin.json' : '.claude-plugin/plugin.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      assert.equal(manifest.name, 'system-design');
      const hookPath = manifest.hooks;
      assert.equal(typeof hookPath, 'string');
      assert.deepEqual((await files(packageRoot)).filter(path => path.endsWith('/plugin.json')), [manifestPath]);
      const config = JSON.parse(await readFile(join(packageRoot, hookPath), 'utf8'));
      for (const [event, registrations] of Object.entries(config.hooks) as [string, Array<{hooks:Array<{command:string}>}>][]) {
        assert.equal(registrations.length, 1, event);
        assert.equal(registrations[0]!.hooks.length, 1, event);
        assert.match(registrations[0]!.hooks[0]!.command, new RegExp(`hook --host ${host}$`));
      }
      assert.ok(!(await files(packageRoot)).some(path => path.endsWith('hooks/hooks.json')));
      assert.ok(!(await files(packageRoot)).some(path => path.endsWith('.d.ts')));
      for (const name of ['system-design', 'setup']) {
        const skillRoot = join(packageRoot, 'skills', name);
        const skill = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
        if (host === 'claude') assert.match(skill, /^---\ndisable-model-invocation: true\n/);
        else {
          const metadata = await readFile(join(skillRoot, 'agents/openai.yaml'), 'utf8');
          assert.match(metadata, /allow_implicit_invocation: false/);
          const prompt = metadata.match(/^  default_prompt: (.+)$/m)?.[1];
          assert.ok(prompt, 'The skill has an explicit invocation prompt');
          assert.ok(isExplicitInvocation(JSON.parse(prompt)), 'The generated prompt activates the invocation hook');
        }
      }
      if (host === 'codex') {
        assert.equal(manifest.skills, './skills/');
        assert.equal(manifest.onboardingSkill, undefined);
        assert.deepEqual(Object.keys(manifest.extensions['com.openai']), ['onboardingSkill']);
        await readdir(join(packageRoot, manifest.skills));
        await readFile(join(packageRoot, manifest.extensions['com.openai'].onboardingSkill), 'utf8');
        assert.ok(manifest.interface.defaultPrompt.every(isExplicitInvocation));
      }
      const result = spawnSync(process.execPath, [join(packageRoot, 'runtime/cli.js')], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).result, 'packaged runtime');
    }
    const market = JSON.parse(await readFile(join(outputs.marketplace!, '.agents/plugins/marketplace.json'), 'utf8'));
    assert.equal(resolve(outputs.marketplace!, market.plugins[0].source.path), outputs.codex);
    const claudeMarket = JSON.parse(await readFile(join(outputs.marketplace!, '.claude-plugin/marketplace.json'), 'utf8'));
    assert.equal(resolve(outputs.marketplace!, claudeMarket.plugins[0].source), outputs.claude);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('shared skill references resolve and runtime guidance is independent', async () => {
  const guideFiles = (await files(join(sourceRoot, 'skills'))).filter(path => path.endsWith('.md'));
  const forbiddenSource = /\bLMS\b|techcourse-lms|woowahan\.com\/missions|참고해서 만들었|수업 자료를 (열|확인|읽)/i;
  const prohibitedCharacters = /[·←-⇿]/u;
  for (const path of guideFiles) {
    const text = await readFile(path, 'utf8');
    assert.ok(!forbiddenSource.test(text), `External course dependency in ${path}`);
    assert.ok(!prohibitedCharacters.test(text), `Unsupported prose character in ${path}`);
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]!;
      if (/^(https?:|#)/.test(target)) continue;
      await readFile(resolve(dirname(path), target.split('#')[0]!), 'utf8');
    }
  }
});
