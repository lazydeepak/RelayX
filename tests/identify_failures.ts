import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const testDir = path.resolve('tests');
  const files = fs.readdirSync(testDir)
    .filter(f => f.endsWith('.test.ts'))
    .map(f => path.join(testDir, f));

  console.log(`Running ${files.length} test files...`);

  for (const file of files) {
    try {
      const stream = run({ files: [file] });
      const reporter = new spec();
      stream.pipe(reporter);
      
      let failed = false;
      stream.on('test:fail', () => {
        failed = true;
      });

      await new Promise((resolve) => {
        stream.on('end', resolve);
      });

      if (failed) {
        console.log(`[FAIL] ${path.basename(file)}`);
      } else {
        // console.log(`[PASS] ${path.basename(file)}`);
      }
    } catch (err) {
      console.log(`[ERROR] ${path.basename(file)}: ${err.message}`);
    }
  }
}

main();
