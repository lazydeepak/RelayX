import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { ChatGPTProvider } from '../src/relay/providers/adapters.ts';

describe('ChatGPTProvider URL Parsing, Canonicalization & Resolution Tests', () => {
  const provider = new ChatGPTProvider();
  const originalPlatform = process.platform;

  before(() => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });
  });

  after(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  test('extractChatGPTProjectId extracts g-p- ID from project root URL', () => {
    const url = 'https://chatgpt.com/g/g-p-123456abcdef-my-awesome-project/project';
    const id = provider.extractChatGPTProjectId(url);
    assert.strictEqual(id, 'g-p-123456abcdef-my-awesome-project');
  });

  test('extractChatGPTProjectId extracts g-p- ID from project root URL without trailing /project', () => {
    const url = 'https://chatgpt.com/g/g-p-123456abcdef-my-awesome-project';
    const id = provider.extractChatGPTProjectId(url);
    assert.strictEqual(id, 'g-p-123456abcdef-my-awesome-project');
  });

  test('extractChatGPTProjectId extracts g-p- ID from conversation within project URL', () => {
    const url = 'https://chatgpt.com/g/g-p-123456abcdef-my-awesome-project/c/conv-9999-xyz';
    const id = provider.extractChatGPTProjectId(url);
    assert.strictEqual(id, 'g-p-123456abcdef-my-awesome-project');
  });

  test('extractChatGPTProjectId rejects unrelated /g/ URLs (custom GPTs without g-p-)', () => {
    const url = 'https://chatgpt.com/g/g-customgpt123-some-bot/c/abc';
    const id = provider.extractChatGPTProjectId(url);
    assert.strictEqual(id, null);
  });

  test('extractChatGPTProjectId rejects standard chat URLs or malformed URLs', () => {
    assert.strictEqual(provider.extractChatGPTProjectId('https://chatgpt.com/c/standard-chat-id'), null);
    assert.strictEqual(provider.extractChatGPTProjectId('not-a-url'), null);
    assert.strictEqual(provider.extractChatGPTProjectId(''), null);
  });

  test('canonicalizeChatGPTProjectUrl canonicalizes project root or conversation URLs correctly', () => {
    const rootUrl = 'https://chatgpt.com/g/g-p-123-alpha/project';
    assert.strictEqual(provider.canonicalizeChatGPTProjectUrl(rootUrl), 'https://chatgpt.com/g/g-p-123-alpha/project');

    const convUrl = 'https://chatgpt.com/g/g-p-123-alpha/c/conversation-id-789';
    assert.strictEqual(provider.canonicalizeChatGPTProjectUrl(convUrl), 'https://chatgpt.com/g/g-p-123-alpha/project');

    const bareUrl = 'https://chatgpt.com/g/g-p-123-alpha';
    assert.strictEqual(provider.canonicalizeChatGPTProjectUrl(bareUrl), 'https://chatgpt.com/g/g-p-123-alpha/project');
  });

  test('resolveChatGPTProject handles current-tab short-circuit when active tab is already in project', async () => {
    const originalRun = (provider as any).runAppleScript;
    try {
      // Mock AppleScript to return a tab already inside a ChatGPT project
      (provider as any).runAppleScript = (script: string) => {
        if (script.includes('URL of t')) {
          return {
            success: true,
            output: 'https://chatgpt.com/g/g-p-999-existing/c/conv-111|||false'
          };
        }
        return { success: true, output: '' };
      };

      const res = await provider.resolveChatGPTProject('Existing Project');
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.projectId, 'g-p-999-existing');
      assert.strictEqual(res.projectUrl, 'https://chatgpt.com/g/g-p-999-existing/project');
      assert.strictEqual(res.diagnostics.shortCircuited, true);
    } finally {
      (provider as any).runAppleScript = originalRun;
    }
  });

  test('resolveChatGPTProject handles single match navigation and URL extraction', async () => {
    const originalRun = (provider as any).runAppleScript;
    try {
      let callCount = 0;
      (provider as any).runAppleScript = (script: string) => {
        callCount++;
        if (callCount === 1) {
          // Initial check: not in project
          return { success: true, output: 'https://chatgpt.com|||false' };
        } else {
          // Navigation script execution result
          return {
            success: true,
            output: 'https://chatgpt.com|||https://chatgpt.com/g/g-p-456-beta/project|||' + JSON.stringify({
              status: 'OPENED::https://chatgpt.com/g/g-p-456-beta/project',
              totalAnchorsFound: 1,
              matchDetails: [{ title: 'beta project', matched: true, reason: 'Matched target project name' }]
            })
          };
        }
      };

      const res = await provider.resolveChatGPTProject('Beta Project');
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.projectId, 'g-p-456-beta');
      assert.strictEqual(res.projectUrl, 'https://chatgpt.com/g/g-p-456-beta/project');
    } finally {
      (provider as any).runAppleScript = originalRun;
    }
  });

  test('resolveChatGPTProject handles multiple matching projects', async () => {
    const originalRun = (provider as any).runAppleScript;
    try {
      let callCount = 0;
      (provider as any).runAppleScript = (script: string) => {
        callCount++;
        if (callCount === 1) {
          return { success: true, output: 'https://chatgpt.com|||false' };
        } else {
          return {
            success: true,
            output: 'https://chatgpt.com|||https://chatgpt.com|||' + JSON.stringify({
              status: 'MULTIPLE::Alpha Project::https://chatgpt.com/g/g-p-1-alpha/project|Alpha Pro::https://chatgpt.com/g/g-p-2-alphapro/project',
              totalAnchorsFound: 2
            })
          };
        }
      };

      const res = await provider.resolveChatGPTProject('Alpha');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error, 'Multiple projects found');
      assert.strictEqual(res.foundMultiple?.length, 2);
      assert.strictEqual(res.foundMultiple![0].name, 'Alpha Project');
    } finally {
      (provider as any).runAppleScript = originalRun;
    }
  });

  test('resolveChatGPTProject handles zero matches (not found)', async () => {
    const originalRun = (provider as any).runAppleScript;
    try {
      let callCount = 0;
      (provider as any).runAppleScript = (script: string) => {
        callCount++;
        if (callCount === 1) {
          return { success: true, output: 'https://chatgpt.com|||false' };
        } else {
          return {
            success: true,
            output: 'https://chatgpt.com|||https://chatgpt.com|||' + JSON.stringify({
              status: 'NOT_FOUND',
              totalAnchorsFound: 0
            })
          };
        }
      };

      const res = await provider.resolveChatGPTProject('Nonexistent');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error, 'Project not found through navigation aid');
    } finally {
      (provider as any).runAppleScript = originalRun;
    }
  });
});
