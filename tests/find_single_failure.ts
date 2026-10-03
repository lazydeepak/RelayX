import { run } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const testDir = path.resolve('tests');
  const files = fs.readdirSync(testDir)
    .filter(f => f.endsWith('.test.ts') && f !== 'find_single_failure.test.ts')
    .map(f => path.join(testDir, f));

  for (const file of files) {
    const stream = run({
      files: [file],
      concurrency: 1,
    });
    
    let hasFailure = false;
    stream.on('test:fail', (data) => {
      hasFailure = true;
      console.log(`[FAIL] ${path.basename(file)} -> ${data.name}`);
      console.log(data.details);
    });

    for await (const chunk of stream) {}
  }
  console.log('Done checking all files.');
}

main().catch(console.error);
