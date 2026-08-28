/** Stable failures exposed by the session-persistence service. */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** The requested Session identity has no materialized durable log. */
export class SessionPersistenceNotFoundError extends Error {
  /** @param sessionId - absent durable Session identity. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" not found`)
    this.name = 'SessionPersistenceNotFoundError'
  }
}

/** The durable log is readable but requires a write-side repair before publication. */
export class SessionPersistenceRecoveryRequiredError extends Error {
  /** @param sessionId - durable Session identity that cannot be restored read-only. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" requires persistence recovery before it can be restored read-only`)
    this.name = 'SessionPersistenceRecoveryRequiredError'
  }
}
