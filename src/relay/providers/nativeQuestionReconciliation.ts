import { readNativePendingQuestions, type NativeQuestionRead } from './nativeQuestionReader';
import type { NativeServerRecord } from './nativeServerLifecycle';

export type NativeQuestionObservation = Extract<NativeQuestionRead, { status: 'READ' }>;
export interface NativeQuestionStore {
  latest(serverId: string, sessionId: string, directory: string): NativeQuestionObservation | undefined;
  save(observation: NativeQuestionObservation): void;
}
export interface NativeQuestionChanges {
  appeared: string[];
  changed: string[];
  unchanged: string[];
  resolved: string[];
}
export function compareNativeQuestionObservations(previous: NativeQuestionObservation | undefined, current: NativeQuestionObservation): NativeQuestionChanges {
  if (previous && (previous.serverId !== current.serverId || previous.sessionId !== current.sessionId || previous.directory !== current.directory)) throw new Error('Question scope mismatch');
  const before = new Map(previous?.questions.map(question => [question.requestId, question]) ?? []);
  const changes: NativeQuestionChanges = { appeared: [], changed: [], unchanged: [], resolved: [] };
  for (const question of current.questions) {
    const old = before.get(question.requestId);
    if (!old) changes.appeared.push(question.requestId);
    else if (JSON.stringify(old) === JSON.stringify(question)) changes.unchanged.push(question.requestId);
    else changes.changed.push(question.requestId);
    before.delete(question.requestId);
  }
  changes.resolved = [...before.keys()];
  return changes;
}
export async function reconcileNativeQuestions(
  serverStore: { get(serverId: string): NativeServerRecord | undefined }, questions: NativeQuestionStore,
  options: Parameters<typeof readNativePendingQuestions>[1],
): Promise<{ status: 'RECORDED'; observation: NativeQuestionObservation; changes: NativeQuestionChanges }
  | Extract<NativeQuestionRead, { status: 'BLOCKED' }>> {
  const result = await readNativePendingQuestions(serverStore, options);
  if (result.status === 'BLOCKED') return result;
  const previous = questions.latest(result.serverId, result.sessionId, result.directory);
  const changes = compareNativeQuestionObservations(previous, result);
  questions.save(result);
  return { status: 'RECORDED', observation: result, changes };
}
