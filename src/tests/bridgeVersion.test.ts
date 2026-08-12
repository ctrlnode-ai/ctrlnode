import { expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

test('reports the same release version declared by package.json', async () => {
  const { BRIDGE_VERSION } = await import('../config');
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '../../package.json'), 'utf8'));

  expect(BRIDGE_VERSION).toBe(`v${packageJson.version}`);
});
