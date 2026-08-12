import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseSkillFrontmatter,
  sanitizeSkills,
  scanSkillDirectories,
} from '../providers/capabilities/skillScanner.js';
import { MAX_DESCRIPTION_LENGTH, MAX_SKILLS } from '../providers/capabilities/types.js';

const temporaryDirectories: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrlnode-skills-'));
  temporaryDirectories.push(dir);
  return dir;
}

function writeSkill(root: string, name: string, contents: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), contents, 'utf8');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('parseSkillFrontmatter', () => {
  test('reads name and description from YAML frontmatter', () => {
    const parsed = parseSkillFrontmatter(
      '---\nname: deploy-api\ndescription: Ships the API container\n---\n\n# Body that must never run\n',
    );

    expect(parsed.name).toBe('deploy-api');
    expect(parsed.description).toBe('Ships the API container');
  });

  test('ignores the body so instructions are never treated as metadata', () => {
    const parsed = parseSkillFrontmatter(
      '---\nname: safe\n---\n\ndescription: injected-from-body\n',
    );

    expect(parsed.name).toBe('safe');
    expect(parsed.description).toBeUndefined();
  });

  test('returns empty metadata when there is no frontmatter block', () => {
    expect(parseSkillFrontmatter('# Just a heading\n')).toEqual({});
  });

  test('strips surrounding quotes from values', () => {
    const parsed = parseSkillFrontmatter('---\nname: "quoted-skill"\ndescription: \'single\'\n---\n');

    expect(parsed.name).toBe('quoted-skill');
    expect(parsed.description).toBe('single');
  });
});

describe('scanSkillDirectories', () => {
  test('discovers SKILL.md folders and uses the directory name as fallback id', () => {
    const root = makeTempDir();
    writeSkill(root, 'no-frontmatter', '# nothing here\n');
    writeSkill(root, 'named', '---\nname: explicit-name\ndescription: With metadata\n---\n');

    const found = scanSkillDirectories([root], 'project');

    expect(found.map((s) => s.name).sort()).toEqual(['explicit-name', 'no-frontmatter']);
    const named = found.find((s) => s.name === 'explicit-name');
    expect(named?.description).toBe('With metadata');
    expect(named?.scope).toBe('project');
  });

  test('skips directories that do not exist without throwing', () => {
    expect(scanSkillDirectories([path.join(makeTempDir(), 'missing')], 'user')).toEqual([]);
  });

  test('ignores folders without a SKILL.md', () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, 'not-a-skill'), { recursive: true });

    expect(scanSkillDirectories([root], 'project')).toEqual([]);
  });

  test('earlier directories win when the same skill name appears twice', () => {
    const first = makeTempDir();
    const second = makeTempDir();
    writeSkill(first, 'dupe', '---\nname: dupe\ndescription: from first\n---\n');
    writeSkill(second, 'dupe', '---\nname: dupe\ndescription: from second\n---\n');

    const found = scanSkillDirectories([first, second], 'project');

    expect(found).toHaveLength(1);
    expect(found[0].description).toBe('from first');
  });
});

describe('sanitizeSkills', () => {
  test('truncates overlong descriptions', () => {
    const [skill] = sanitizeSkills([
      {
        id: 'long',
        name: 'long',
        description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 50),
        invocation: '/long',
        scope: 'user',
        userInvocable: true,
        enabled: true,
      },
    ]);

    expect(skill.description!.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  });

  test('drops skills whose name is empty', () => {
    expect(
      sanitizeSkills([
        { id: '', name: '   ', invocation: '/', scope: 'user', userInvocable: true, enabled: true },
      ]),
    ).toEqual([]);
  });

  test('caps the total number of skills', () => {
    const many = Array.from({ length: MAX_SKILLS + 25 }, (_, i) => ({
      id: `skill-${i}`,
      name: `skill-${i}`,
      invocation: `/skill-${i}`,
      scope: 'user' as const,
      userInvocable: true,
      enabled: true,
    }));

    expect(sanitizeSkills(many)).toHaveLength(MAX_SKILLS);
  });

  test('removes absolute paths that leaked into a description', () => {
    const [skill] = sanitizeSkills([
      {
        id: 'leaky',
        name: 'leaky',
        description: 'Reads C:\\Users\\vil\\secrets and /home/vil/.ssh/id_rsa',
        invocation: '/leaky',
        scope: 'user',
        userInvocable: true,
        enabled: true,
      },
    ]);

    expect(skill.description).not.toContain('C:\\Users\\vil');
    expect(skill.description).not.toContain('/home/vil');
  });
});
