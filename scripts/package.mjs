import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function runtimeFiles(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await runtimeFiles(join(source, entry.name), join(destination, entry.name));
    else if (entry.isFile() && entry.name.endsWith('.js')) await cp(join(source, entry.name), join(destination, entry.name));
  }
}

function hooks(host) {
  const rootVariable = host === 'codex' ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT';
  const command = `node "\${${rootVariable}}/runtime/cli.js" hook --host ${host}`;
  const entry = { hooks: [{ type: 'command', command, timeout: 10 }] };
  return {
    hooks: {
      SessionStart: [entry],
      UserPromptSubmit: [entry],
      PreToolUse: [{ matcher: '.*', ...entry }],
      PostToolUse: [{ matcher: '.*', ...entry }],
      PreCompact: [entry],
      SubagentStart: [entry],
      Stop: [entry],
    },
  };
}

async function prepareSkills(sourceRoot, packageRoot, host) {
  await cp(join(sourceRoot, 'skills'), join(packageRoot, 'skills'), { recursive: true });
  for (const name of ['system-design', 'setup']) {
    const skillRoot = join(packageRoot, 'skills', name);
    const path = join(skillRoot, 'SKILL.md');
    const content = await readFile(path, 'utf8');
    if (!/^---\nname: [^\n]+\n/.test(content)) throw new Error(`Invalid skill frontmatter: ${name}`);
    if (host === 'claude') {
      await writeFile(path, content.replace(/^---\n/, '---\ndisable-model-invocation: true\n'), 'utf8');
    } else {
      await mkdir(join(skillRoot, 'agents'), { recursive: true });
      const description = name === 'setup' ? 'system-design 기록 위치와 보관 설정' : '사용자의 판단으로 진행하는 단계별 시스템 설계';
      const displayName = name === 'setup' ? 'system-design 설정' : 'system-design';
      const prompt = name === 'setup' ? '$system-design:setup 초기 설정을 진행해줘.' : '$system-design:system-design 이 작업의 설계를 함께 진행해줘.';
      await writeFile(join(skillRoot, 'agents', 'openai.yaml'),
        `interface:\n  display_name: ${JSON.stringify(displayName)}\n  short_description: ${JSON.stringify(description)}\n  default_prompt: ${JSON.stringify(prompt)}\npolicy:\n  allow_implicit_invocation: false\n`, 'utf8');
    }
  }
}

/** Generate isolated, installable host packages from the shared source. */
export async function buildPackages({ sourceRoot = defaultRoot } = {}) {
  sourceRoot = resolve(sourceRoot);
  const metadata = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  const runtimeSource = join(sourceRoot, 'build', 'src');
  await readFile(join(runtimeSource, 'cli.js'), 'utf8');
  const dist = join(sourceRoot, 'dist');
  await mkdir(dist, { recursive: true });
  const identity = {
    name: 'system-design',
    version: metadata.version,
    description: '사용자의 생각을 먼저 듣고 설계 판단과 기록을 함께 정리합니다.',
    author: { name: 'lee' },
    keywords: ['system-design', 'interview', 'adr', 'obsidian'],
  };
  for (const host of ['codex', 'claude']) {
    const destination = join(dist, host);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await runtimeFiles(runtimeSource, join(destination, 'runtime'));
    await json(join(destination, 'package.json'), { name: 'system-design', version: metadata.version, private: true, type: 'module', engines: metadata.engines });
    await prepareSkills(sourceRoot, destination, host);
    await json(join(destination, 'hooks', `${host}.json`), hooks(host));
    if (host === 'codex') {
      await json(join(destination, '.codex-plugin', 'plugin.json'), {
        ...identity,
        skills: './skills/',
        hooks: './hooks/codex.json',
        extensions: {
          'com.openai': { onboardingSkill: './skills/setup/SKILL.md' },
        },
        interface: {
          displayName: 'system-design',
          shortDescription: '함께 생각하고 기록하는 시스템 설계',
          developerName: 'lee',
          category: 'Developer Tools',
          capabilities: ['Read', 'Write'],
          defaultPrompt: ['$system-design:system-design 이 작업의 설계를 함께 진행해줘.'],
        },
      });
    } else {
      await json(join(destination, '.claude-plugin', 'plugin.json'), {
        ...identity, displayName: 'system-design', hooks: './hooks/claude.json',
      });
    }
  }
  await json(join(dist, '.agents', 'plugins', 'marketplace.json'), {
    name: 'system-design-local',
    interface: { displayName: 'system-design 개인 플러그인' },
    plugins: [{ name: 'system-design', source: { source: 'local', path: './codex' }, category: 'Developer Tools' }],
  });
  await json(join(dist, '.claude-plugin', 'marketplace.json'), {
    name: 'system-design-local', owner: { name: 'lee' },
    plugins: [{ name: 'system-design', source: './claude', description: identity.description }],
  });
  return { codex: join(dist, 'codex'), claude: join(dist, 'claude'), marketplace: dist };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await buildPackages())}\n`);
  } catch (error) {
    process.stderr.write(`Package build failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
