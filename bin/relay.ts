#!/usr/bin/env node
import path from 'path';
import os from 'os';
import fs from 'fs';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { ChatGPTProvider, OpenCodeProvider, VSCodeProvider } from '../src/relay/providers/adapters.ts';
import { PairId, RuntimeSessionId } from '../src/relay/domain/types.ts';

function getDbPath(): string {
  // Check standard Electron userData path or local override
  const home = os.homedir();
  const candidates = [
    process.env.RELAY_DB_PATH,
    path.join(home, 'Library/Application Support/relay-app/relay.sqlite'),
    path.join(home, 'Library/Application Support/Relay/relay.sqlite'),
    path.join(process.cwd(), 'relay.sqlite'),
  ].filter(Boolean) as string[];

  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  // Default to first candidate
  return candidates[1] || path.join(process.cwd(), 'relay.sqlite');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  const dbPath = getDbPath();
  const db = new SqliteRelayDatabase(dbPath);
  const engine = new RelayEngine(db);

  engine.registerProvider(new ChatGPTProvider());
  engine.registerProvider(new OpenCodeProvider());
  engine.registerProvider(new VSCodeProvider());

  try {
    switch (command) {
      case 'status': {
        const pairs = await db.pairs.findAll();
        const runtimes = await db.runtimes.findAll();
        const attention = await db.attention.findOpen();
        const assignments = await db.assignments.findActive();

        console.log('\n--- Relay Engine Status ---');
        console.log(`Database: ${dbPath}`);
        console.log(`Pairs: ${pairs.length} total (${pairs.filter((p) => p.status === 'active').length} active)`);
        console.log(`Runtimes: ${runtimes.length} registered (${runtimes.filter((r) => r.status === 'working').length} working)`);
        console.log(`Active Assignments: ${assignments.length}`);
        console.log(`Open Attention Items: ${attention.length}`);
        console.log('---------------------------\n');
        break;
      }

      case 'pairs': {
        const pairs = await db.pairs.findAll();
        console.log(JSON.stringify(pairs, null, 2));
        break;
      }

      case 'supervise': {
        console.log('Running Relay supervision tick...');
        const result = await engine.runSupervisionTick();
        console.log('Supervision Tick Complete:');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'assign': {
        const pairId = args[1];
        const title = args[2];
        const instruction = args[3];
        if (!pairId || !title || !instruction) {
          console.error('Usage: relay assign <pairId> <title> <instruction>');
          process.exit(1);
        }
        const assignment = await engine.createAssignment(pairId as PairId, title, instruction);
        console.log(`Assignment created: ${assignment.id}`);
        console.log(JSON.stringify(assignment, null, 2));
        break;
      }

      case 'attention': {
        const items = await db.attention.findOpen();
        console.log(`Found ${items.length} open attention item(s):`);
        console.log(JSON.stringify(items, null, 2));
        break;
      }

      case 'evidence': {
        const sessionId = args[1];
        if (!sessionId) {
          console.error('Usage: relay evidence <runtimeSessionId>');
          process.exit(1);
        }
        const runtime = await db.runtimes.findById(sessionId as RuntimeSessionId);
        if (!runtime) {
          console.error(`Runtime session '${sessionId}' not found.`);
          process.exit(1);
        }
        console.log(`Latest Evidence for ${runtime.name} (${runtime.id}):`);
        console.log(JSON.stringify(runtime.lastEvidence ?? { note: 'No evidence observed yet' }, null, 2));
        break;
      }

      default: {
        console.log(`Unknown command: ${command}`);
        console.log('Available commands: status, pairs, supervise, assign, attention, evidence');
        process.exit(1);
      }
    }
  } finally {
    if (db.db) {
      try {
        db.db.close();
      } catch {}
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('CLI Error:', err);
    process.exit(1);
  });
}
