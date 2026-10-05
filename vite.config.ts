import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

/**
 * Paths under the project root that a running local tool writes RUNTIME DATA into,
 * as opposed to source code.
 *
 * Why this list exists
 * -------------------
 * The dev server watches the whole project root, and `@tailwindcss/vite` treats *any*
 * change to a file inside it as "scanned source changed" and pushes
 * `{ type: 'full-reload' }` to the HMR client — deliberately, because Tailwind cannot
 * hot-apply a regenerated stylesheet to an arbitrary entry graph. The Vite client answers
 * that with `location.reload()`.
 *
 * RelayX runs long-lived local tools that append to files inside the repo while the app
 * is open (for example `tools/planner-observer/bridge.mjs` appending every ChatGPT planner
 * observation to `observations.jsonl`). Those writes are not source edits, but they were
 * indistinguishable from one, so every append reloaded the entire renderer — destroying all
 * in-memory UI state. That is exactly what made the Add Project wizard vanish the moment
 * ChatGPT planner discovery started.
 *
 * Keeping runtime artifacts out of the watch set makes that class of reload impossible,
 * no matter which tool produces them. Real source files stay fully watched, so HMR keeps
 * working exactly as before.
 */
const RUNTIME_ARTIFACT_GLOBS = [
  // Append-only observation / evidence / trace logs written by running tools.
  '**/*.jsonl',
  '**/*.log',
  // Local databases a developer tool may create inside the repo.
  '**/*.sqlite',
  '**/*.sqlite-*',
  '**/*.db',
  '**/*.db-*',
  // The planner-observer bridge's own runtime log.
  'tools/planner-observer/observations*.json*',
];

export default defineConfig(() => {
  return {
    base: './',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname || '.', '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch:
        process.env.DISABLE_HMR === 'true'
          ? null
          : {
              // Never let runtime artifact writes become a full renderer reload.
              ignored: [...RUNTIME_ARTIFACT_GLOBS, '**/.git/**', '**/node_modules/**'],
            },
    },
  };
});
