/**
 * Test support for a confirmation-authoritative OpenCode provider.
 *
 * Pairing and session adoption require verified, provider-evidenced project
 * association. Adoption additionally requires a confirmation authority: a
 * caller-supplied `ses_…` id is not evidence on its own, so when no OpenCode
 * provider is registered there is nothing that could corroborate it and
 * adoption must stop (see `adoptOpenCodeSession`).
 *
 * Tests that exercise adoption/identity semantics rather than provider
 * negotiation register this stub so the confirmation step has an authority to
 * consult. Tests that specifically assert the fail-closed behaviour must NOT
 * register it.
 */

/** Options controlling how the stub answers a confirmation request. */
export interface ConfirmingOpenCodeProviderOptions {
  /** Session ids that confirm. Omitted means "confirm everything". */
  confirm?: (sessionId: string, projectPath: string) => boolean;
  providerType?: 'opencode' | 'chatgpt';
  integrationStatus?: string;
}

/**
 * Builds a minimal provider object exposing `confirmSessionForProject`.
 *
 * Returned as a loose object (not a full `IRuntimeProvider`) because the
 * pairing/adoption paths only require the confirmation method to be present.
 */
export function makeConfirmingOpenCodeProvider(
  options: ConfirmingOpenCodeProviderOptions = {},
) {
  const { confirm, providerType = 'opencode', integrationStatus = 'partial' } = options;
  return {
    providerType,
    integrationStatus,
    async confirmSessionForProject(sessionId: string, projectPath: string) {
      const confirmed = confirm ? confirm(sessionId, projectPath) : true;
      return {
        confirmed,
        externalSessionId: sessionId,
        projectPath,
      };
    },
  } as any;
}
