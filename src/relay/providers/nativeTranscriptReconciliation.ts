import { readNativeSession, type NativeSessionRead, type NativeTranscriptMessage } from './nativeSessionReader';
import type { NativeServerRecord } from './nativeServerLifecycle';

export type NativeTranscriptPage = Extract<NativeSessionRead, { status: 'READ' }>;
export interface NativeTranscriptStore {
  latest(serverId: string, sessionId: string, directory: string): NativeTranscriptPage | undefined;
  save(page: NativeTranscriptPage): void;
}
export interface TranscriptChanges {
  added: string[];
  changed: string[];
  unchanged: string[];
  /** A partial page's absence never proves deletion. */
  notInCurrentPage: string[];
}
export function compareNativeTranscriptPages(previous: NativeTranscriptPage | undefined, current: NativeTranscriptPage): TranscriptChanges {
  if (previous && (previous.serverId !== current.serverId || previous.session.id !== current.session.id || previous.session.directory !== current.session.directory)) throw new Error('Transcript scope mismatch');
  const before = new Map<string, NativeTranscriptMessage>(previous?.messages.map(message => [message.id, message]) ?? []);
  const changes: TranscriptChanges = { added: [], changed: [], unchanged: [], notInCurrentPage: [] };
  for (const message of current.messages) {
    const old = before.get(message.id);
    if (!old) changes.added.push(message.id);
    else if (JSON.stringify(old) === JSON.stringify(message)) changes.unchanged.push(message.id);
    else changes.changed.push(message.id);
    before.delete(message.id);
  }
  changes.notInCurrentPage = [...before.keys()];
  return changes;
}

/** Restart recovery reuses durable observations and reads provider evidence;
 * it never redispatches, fabricates missing turns or changes task authority. */
export async function reconcileNativeTranscript(serverStore: { get(serverId: string): NativeServerRecord | undefined },
  transcripts: NativeTranscriptStore, options: Parameters<typeof readNativeSession>[1]): Promise<
    { status: 'RECORDED'; page: NativeTranscriptPage; changes: TranscriptChanges } | Extract<NativeSessionRead, { status: 'BLOCKED' }>
  > {
  const result = await readNativeSession(serverStore, options);
  if (result.status === 'BLOCKED') return result;
  const previous = transcripts.latest(result.serverId, result.session.id, result.session.directory);
  const changes = compareNativeTranscriptPages(previous, result);
  transcripts.save(result);
  return { status: 'RECORDED', page: result, changes };
}
