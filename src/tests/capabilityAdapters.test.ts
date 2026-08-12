import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildCodexSkillDirectories,
  discoverCodexSkills,
} from '../providers/capabilities/codexCapabilities.js';
import { mapClaudeSlashCommands } from '../providers/capabilities/claudeCapabilities.js';
import { parseCopilotSkillList } from '../providers/capabilities/copilotCapabilities.js';
import { parseCursorSkillList } from '../providers/capabilities/cursorCapabilities.js';
import { buildGeminiCommandDirectories } from '../providers/capabilities/geminiCapabilities.js';

const temporaryDirectories: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrlnode-caps-'));
  temporaryDirectories.push(dir);
  return dir;
}

function writeSkill(root: string, name: string, contents: string): void {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), contents, 'utf8');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('claude capabilities', () => {
  test('maps SDK slash commands to /name invocations', () => {
    const skills = mapClaudeSlashCommands([
      { name: 'review', description: 'Review the diff', argumentHint: '<pr>' },
      { name: 'deploy' },
    ]);

    expect(skills[0]).toMatchObject({
      name: 'review',
      description: 'Review the diff',
      argumentHint: '<pr>',
      invocation: '/review',
      userInvocable: true,
      enabled: true,
    });
    expect(skills[1].invocation).toBe('/deploy');
  });

  test('strips a leading slash the SDK already included', () => {
    expect(mapClaudeSlashCommands([{ name: '/compact' }])[0].invocation).toBe('/compact');
  });

  test('ignores entries without a usable name', () => {
    expect(mapClaudeSlashCommands([{ name: '' }, { name: '   ' }])).toEqual([]);
  });
});

describe('codex capabilities', () => {
  test('inserts $name because Codex does not use slash syntax', () => {
    const workingDirectory = makeTempDir();
    const skillsRoot = path.join(workingDirectory, '.agents', 'skills');
    writeSkill(skillsRoot, 'lint-fix', '---\nname: lint-fix\ndescription: Fix lint\n---\n');

    const skills = discoverCodexSkills(workingDirectory, undefined);

    expect(skills.find((s) => s.name === 'lint-fix')?.invocation).toBe('$lint-fix');
  });

  test('walks from the working directory up to the repository root', () => {
    const root = makeTempDir();
    const nested = path.join(root, 'packages', 'api');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });

    const directories = buildCodexSkillDirectories(nested, undefined);

    expect(directories).toContain(path.join(nested, '.agents', 'skills'));
    expect(directories).toContain(path.join(root, '.agents', 'skills'));
  });

  test('includes the per-agent CODEX_HOME skills directory', () => {
    const codexHome = makeTempDir();

    expect(buildCodexSkillDirectories(makeTempDir(), codexHome))
      .toContain(path.join(codexHome, 'skills'));
  });

  test('discovers user skills from HOME/.agents/skills', () => {
    const userHome = makeTempDir();
    writeSkill(
      path.join(userHome, '.agents', 'skills'),
      'service-logging',
      '---\nname: service-logging\ndescription: Add service logs\n---\n',
    );

    const skills = discoverCodexSkills(makeTempDir(), undefined, userHome);

    expect(skills.find((skill) => skill.name === 'service-logging')).toMatchObject({
      invocation: '$service-logging',
      scope: 'user',
    });
  });

  test('discovers bundled skills below CODEX_HOME/skills/.system', () => {
    const codexHome = makeTempDir();
    writeSkill(
      path.join(codexHome, 'skills', '.system'),
      'skill-creator',
      '---\nname: skill-creator\ndescription: Create a Codex skill\n---\n',
    );

    const skills = discoverCodexSkills(makeTempDir(), codexHome);

    expect(skills.find((skill) => skill.name === 'skill-creator')).toMatchObject({
      invocation: '$skill-creator',
      scope: 'builtin',
    });
  });

  test('does not advertise project skills in OUTPUT mode', () => {
    const workingDirectory = makeTempDir();
    writeSkill(
      path.join(workingDirectory, '.agents', 'skills'),
      'project-only',
      '---\nname: project-only\ndescription: Project workflow\n---\n',
    );

    const skills = discoverCodexSkills(workingDirectory, undefined, undefined, false);

    expect(skills.some((skill) => skill.name === 'project-only')).toBe(false);
  });
});

describe('copilot capabilities', () => {
  test('parses the JSON catalogue emitted by `copilot skill list --json`', () => {
    const skills = parseCopilotSkillList(
      JSON.stringify([
        { name: 'triage', description: 'Triage issues', scope: 'project' },
        { name: 'release', description: 'Cut a release', scope: 'user' },
      ]),
    );

    expect(skills).toHaveLength(2);
    expect(skills[0]).toMatchObject({ name: 'triage', invocation: '/triage', scope: 'project' });
    expect(skills[1].scope).toBe('user');
  });

  test('accepts a wrapped { skills: [...] } payload', () => {
    const skills = parseCopilotSkillList(JSON.stringify({ skills: [{ name: 'build' }] }));

    expect(skills).toHaveLength(1);
    expect(skills[0].invocation).toBe('/build');
  });

  test('returns empty on non-JSON output instead of throwing', () => {
    expect(parseCopilotSkillList('command not found')).toEqual([]);
  });

  test('defaults an unknown scope to user', () => {
    expect(parseCopilotSkillList(JSON.stringify([{ name: 'x', scope: 'weird' }]))[0].scope)
      .toBe('user');
  });
});

describe('cursor capabilities', () => {
  test('parses a cursor-agent JSON skill catalogue', () => {
    const skills = parseCursorSkillList(JSON.stringify({ skills: [{ name: 'refactor' }] }));

    expect(skills[0]).toMatchObject({ name: 'refactor', invocation: '/refactor' });
  });

  test('tolerates malformed output', () => {
    expect(parseCursorSkillList('<html>error</html>')).toEqual([]);
  });
});

describe('gemini capabilities', () => {
  test('looks at project and user command directories', () => {
    const workingDirectory = makeTempDir();

    const directories = buildGeminiCommandDirectories(workingDirectory, '/home/vil');

    expect(directories).toContain(path.join(workingDirectory, '.gemini', 'commands'));
    expect(directories).toContain(path.join('/home/vil', '.gemini', 'commands'));
  });
});
