/**
 * Phase 1 — Main process stall thin service.
 * Confirmed only: first sample = candidate, second = confirmed incident.
 */
import { HealthIncidentEngine } from '../application/HealthIncidentEngine.ts';
import { evaluateMainProcessStall, MainProcessStallResult } from './mainProcessStallCheck.ts';
import { HealthObservation } from '../domain/healthDomain.ts';

interface MainProcessCandidate {
  count: number;
  firstObservedMs: number;
  lastObservedMs: number;
}

export class MainProcessStallService {
  private candidates = new Map<string, MainProcessCandidate>();

  constructor(private readonly engine: HealthIncidentEngine) {}

  async evaluate(nowMs: number = Date.now()): Promise<{
    kind: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
    confirmed: boolean;
    incident?: import('../domain/healthDomain.ts').HealthIncident;
    observation?: HealthObservation;
  }> {
    const result = await evaluateMainProcessStall({ count: this.candidates.has('main') ? (this.candidates.get('main')!.count) : 0, firstQualifyingAt: this.candidates.has('main') ? this.candidates.get('main')!.firstObservedMs : undefined }, nowMs);

    if (result.kind === 'HEALTHY') {
      this.candidates.delete('main');
      return { kind: 'HEALTHY', confirmed: false };
    }

    if (result.kind === 'DEGRADED' || result.kind === 'UNHEALTHY') {
      const existing = this.candidates.get('main');
      if (!existing) {
        // First qualifying observation: candidate only, do not call engine yet.
        this.candidates.set('main', {
          count: 1,
          firstObservedMs: nowMs,
          lastObservedMs: nowMs,
        });
        return { kind: result.kind, confirmed: false, observation: result.observation };
      }

      // Second (or later) qualifying observation: confirm and update/create incident.
      existing.count += 1;
      existing.lastObservedMs = nowMs;
      this.candidates.set('main', existing);

      if (result.observation) {
        const incident = await this.engine.recordUnhealthyObservation(result.observation);
        return { kind: result.kind, confirmed: true, incident, observation: result.observation };
      }
      return { kind: result.kind, confirmed: true, observation: result.observation };
    }

    return { kind: result.kind as 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN', confirmed: false, observation: result.observation };
  }

  getCandidate(): MainProcessCandidate | undefined {
    return this.candidates.get('main');
  }

  clear(): void {
    this.candidates.clear();
  }
}
