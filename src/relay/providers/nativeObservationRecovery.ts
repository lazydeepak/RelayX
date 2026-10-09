import { observeNativeEvents, type NativeEventRead } from './nativeEventObserver';
import { readNativeSession, type NativeSessionRead } from './nativeSessionReader';
import { readNativePendingQuestions, type NativeQuestionRead } from './nativeQuestionReader';
import { compareNativeTranscriptPages, type NativeTranscriptStore, type TranscriptChanges } from './nativeTranscriptReconciliation';
import { compareNativeQuestionObservations, type NativeQuestionStore, type NativeQuestionChanges } from './nativeQuestionReconciliation';
import type { NativeServerRecord } from './nativeServerLifecycle';
import type { SqliteNativeEventRepository } from '../persistence/sqlite/SqliteNativeEventRepository';

type EventBatch = Extract<NativeEventRead, { status: 'READ' }>;
type TranscriptPage = Extract<NativeSessionRead, { status: 'READ' }>;
type QuestionObservation = Extract<NativeQuestionRead, { status: 'READ' }>;
type Blocked = { status: 'BLOCKED'; phase: 'EVENTS' | 'TRANSCRIPT' | 'QUESTIONS'; reason: string };

export interface NativeRecoveryStores {
  servers: { get(serverId: string): NativeServerRecord | undefined };
  events: Pick<SqliteNativeEventRepository, 'latestCursor' | 'save'>;
  transcripts: NativeTranscriptStore;
  questions: NativeQuestionStore;
  transaction<T>(work: () => Promise<T>): Promise<T>;
}

/** Creates one durable evidence checkpoint. Network reads happen before the
 * transaction; all three observations commit together after repository-level
 * revision checks. A blocked read persists none of the checkpoint.
 */
export async function recoverNativeObservationCheckpoint(stores: NativeRecoveryStores, options: {
  serverId: string; sessionId: string; directory: string; observedAt: number;
  maximumInspectionAgeMs: number; messageLimit: number; maximumEvents: number; maximumEventBytes: number;
  fetch: typeof fetch; signal: AbortSignal; resolveAuthorization: (keyRef: string) => Promise<string | undefined>;
}): Promise<Blocked | {
  status: 'RECORDED'; eventBatch: EventBatch; transcript: TranscriptPage; questions: QuestionObservation;
  eventChanges: { inserted: string[]; duplicates: string[] };
  transcriptChanges: TranscriptChanges; questionChanges: NativeQuestionChanges;
  taskStateChanged: false; dispatchAttempted: false;
}> {
  const common = { serverId: options.serverId, sessionId: options.sessionId, directory: options.directory,
    observedAt: options.observedAt, maximumInspectionAgeMs: options.maximumInspectionAgeMs,
    fetch: options.fetch, signal: options.signal, resolveAuthorization: options.resolveAuthorization };
  const priorEventId = stores.events.latestCursor(options.serverId, options.sessionId, options.directory);
  const eventBatch = await observeNativeEvents(stores.servers, { ...common, maximumEvents: options.maximumEvents,
    maximumBytes: options.maximumEventBytes, ...(priorEventId ? { priorEventId } : {}) });
  if (eventBatch.status === 'BLOCKED') return { ...eventBatch, phase: 'EVENTS' };
  const transcript = await readNativeSession(stores.servers, { ...common, messageLimit: options.messageLimit });
  if (transcript.status === 'BLOCKED') return { ...transcript, phase: 'TRANSCRIPT' };
  const questions = await readNativePendingQuestions(stores.servers, common);
  if (questions.status === 'BLOCKED') return { ...questions, phase: 'QUESTIONS' };

  const previousTranscript = stores.transcripts.latest(options.serverId, options.sessionId, options.directory);
  const previousQuestions = stores.questions.latest(options.serverId, options.sessionId, options.directory);
  const transcriptChanges = compareNativeTranscriptPages(previousTranscript, transcript);
  const questionChanges = compareNativeQuestionObservations(previousQuestions, questions);
  return stores.transaction(async () => {
    const eventChanges = stores.events.save(eventBatch);
    stores.transcripts.save(transcript);
    stores.questions.save(questions);
    return { status: 'RECORDED' as const, eventBatch, transcript, questions, eventChanges,
      transcriptChanges, questionChanges, taskStateChanged: false as const, dispatchAttempted: false as const };
  });
}
