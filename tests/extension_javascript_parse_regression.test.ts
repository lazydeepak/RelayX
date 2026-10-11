import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('Chrome-extension JavaScript parse regression', () => {
  const extensionDir = join(process.cwd(), 'tools', 'planner-observer', 'extension');
  const files = [
    'background.js',
    'content.js',
  ];

  it('loads real browser JS files without TypeScript-only syntax', () => {
    for (const file of files) {
      const fullPath = join(extensionDir, file);
      const source = readFileSync(fullPath, 'utf8');
      const result = spawnSync(process.execPath, ['--check', fullPath], {
        encoding: 'utf8',
      });
      assert.strictEqual(result.status, 0, `${file} failed parse check:\n${result.stderr || result.stdout || source}`);
      assert.doesNotMatch(source, /\b\w+\s*\?:\s*\w+/g, `${file} contains TypeScript parameter syntax`);
    }
  });

  it('forwards observerInstanceId in the next-command payload', async () => {
    const workerSource = readFileSync(join(extensionDir, 'background.js'), 'utf8');
    assert.match(workerSource, /observerInstanceId\b/, 'background.js must include observerInstanceId in the next-command request');
    assert.match(workerSource, /getNextCommand\s*\(\s*conversationId\s*,\s*observerInstanceId\s*\)/, 'background.js must accept the observerInstanceId parameter in valid JS');
  });
});
