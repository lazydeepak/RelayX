import { observeNativeEvents, type NativeEventRead } from './nativeEventObserver';
import type { NativeServerRecord } from './nativeServerLifecycle';
import type { SqliteNativeEventRepository } from '../persistence/sqlite/SqliteNativeEventRepository';

/** Opens one bounded connection from the durable cursor and records it. Every
 * boundary requires authoritative transcript and question reads before Engine
 * conclusions, because SSE replay continuity is not assumed.
 */
export async function recoverNativeEventConnection(
  servers: { get(serverId: string): NativeServerRecord | undefined },
  events: Pick<SqliteNativeEventRepository, 'latestCursor' | 'save'>,
  options: Omit<Parameters<typeof observeNativeEvents>[1], 'priorEventId'>,
): Promise<({ status: 'RECORDED'; batch: Extract<NativeEventRead, { status: 'READ' }>;
  inserted: string[]; duplicates: string[]; reconcileTranscript: true; reconcileQuestions: true })
  | Extract<NativeEventRead, { status: 'BLOCKED' }>> {
  const priorEventId = events.latestCursor(options.serverId, options.sessionId, options.directory);
  const result = await observeNativeEvents(servers, { ...options, ...(priorEventId ? { priorEventId } : {}) });
  if (result.status === 'BLOCKED') return result;
  const saved = events.save(result);
  return { status: 'RECORDED', batch: result, ...saved, reconcileTranscript: true, reconcileQuestions: true };
}
