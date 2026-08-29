/** Pure durable Session hydration for same-process Host integrations. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRecoveryRequiredError,
} from '@deepseek-ai/dsh-session-persistence'
import {
  DurableSessionResolveError,
  type SessionController,
} from '../src/index.ts'
import { createSessionTestController } from './test-remote.ts'

const WORKSPACE = '/workspace/durable-task'

interface HydrationHarness {
  readonly ctx: Context
  readonly controller: SessionController
  readonly prepared: Session
  readonly prepareExact: ReturnType<typeof vi.fn>
  readonly release: ReturnType<typeof vi.fn>
}

async function harness(
  options: { readonly returnedId?: string; readonly cwd?: string; readonly providePersistence?: boolean } = {},
): Promise<HydrationHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const requestedId = SessionId('durable-task')
  const returnedId = SessionId(options.returnedId ?? requestedId)
  const prepared = ctx.sessions.prepare(returnedId, {
    meta: { version: 0, id: returnedId, createdAt: 1, cwd: options.cwd ?? WORKSPACE },
    seed: [],
    seedSource: 'persistence',
  })
  const release = vi.fn()
  const prepareExact = vi.fn(async () => SessionPreparation.create(prepared, { release }))
  if (options.providePersistence !== false) ctx.provide('sessionPersistence', { prepareExact } as never)
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: WORKSPACE,
  })
  return { ctx, controller, prepared, prepareExact, release }
}

describe('SessionController.resolveDurableSession', () => {
  it('hydrates once without appending events, mounting an Agent, or marking list visibility', async () => {
    const h = await harness()
    const sessionId = SessionId('durable-task')
    const before = [...h.prepared.events]

    try {
      const first = h.controller.resolveDurableSession({ sessionId, workspacePath: WORKSPACE })
      const second = h.controller.resolveDurableSession({ sessionId, workspacePath: `${WORKSPACE}/.` })
      const [resolved, shared] = await Promise.all([first, second])

      expect(resolved).toEqual({ session: h.prepared, disposition: 'hydrated' })
      expect(shared).toEqual(resolved)
      expect(h.prepareExact).toHaveBeenCalledTimes(1)
      expect(h.ctx.sessions.get(sessionId)).toBe(h.prepared)
      expect(h.ctx.agents.get(sessionId)).toBeUndefined()
      expect(h.prepared.events).toEqual(before)
      expect(h.prepared.events.some(event => event.type === 'session/external-task')).toBe(false)
      expect(h.release).toHaveBeenCalledTimes(1)

      await expect(h.controller.resolveDurableSession({ sessionId, workspacePath: WORKSPACE }))
        .resolves.toEqual({ session: h.prepared, disposition: 'live' })
      expect(h.prepareExact).toHaveBeenCalledTimes(1)
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('fails closed for wrong workspace before or after hydration', async () => {
    const h = await harness()
    const sessionId = SessionId('durable-task')

    try {
      await expect(h.controller.resolveDurableSession({ sessionId, workspacePath: '/workspace/wrong' }))
        .rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' })
      expect(h.ctx.sessions.get(sessionId)).toBeUndefined()

      await expect(h.controller.resolveDurableSession({ sessionId, workspacePath: WORKSPACE }))
        .resolves.toMatchObject({ disposition: 'hydrated' })
      expect(() => h.controller.resolveDurableSession({ sessionId, workspacePath: 'relative' }))
        .toThrow(DurableSessionResolveError)
      expect(() => h.controller.resolveDurableSession({ sessionId, workspacePath: '/workspace/wrong' }))
        .toThrow(expect.objectContaining({ code: 'WORKSPACE_MISMATCH' }))
      expect(h.prepareExact).toHaveBeenCalledTimes(2)
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('rejects a persistence identity mismatch without publishing either identity', async () => {
    const h = await harness({ returnedId: 'different-session' })
    const sessionId = SessionId('durable-task')

    try {
      await expect(h.controller.resolveDurableSession({ sessionId, workspacePath: WORKSPACE }))
        .rejects.toMatchObject({ code: 'SESSION_ID_MISMATCH' })
      expect(h.ctx.sessions.get(sessionId)).toBeUndefined()
      expect(h.ctx.sessions.get(SessionId('different-session'))).toBeUndefined()
      expect(h.release).toHaveBeenCalledTimes(1)
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('classifies persistence failures without exposing their contents', async () => {
    const h = await harness()
    const sessionId = SessionId('durable-task')
    const failures = [
      [new SessionPersistenceNotFoundError(sessionId), 'NOT_FOUND'],
      [new SessionPersistenceRecoveryRequiredError(sessionId), 'RECOVERY_REQUIRED'],
      [new SessionPersistenceCorruptionError('secret archive path', { cause: new Error('secret') }), 'CORRUPT'],
      [new SessionFormatUnsupportedError('secret archive path'), 'UNSUPPORTED_FORMAT'],
      [new Error('secret archive path'), 'UNKNOWN'],
    ] as const

    try {
      for (const [failure, code] of failures) {
        h.prepareExact.mockRejectedValueOnce(failure)
        await expect(h.controller.resolveDurableSessionSafe({ sessionId, workspacePath: WORKSPACE }))
          .resolves.toEqual({ ok: false, code })
        expect(h.ctx.sessions.get(sessionId)).toBeUndefined()
      }
      expect(h.prepareExact).toHaveBeenCalledTimes(failures.length)
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('returns a typed success and a safe workspace failure', async () => {
    const h = await harness()
    const sessionId = SessionId('durable-task')

    try {
      await expect(h.controller.resolveDurableSessionSafe({ sessionId, workspacePath: WORKSPACE }))
        .resolves.toEqual({ ok: true, session: h.prepared, disposition: 'hydrated' })
      await expect(h.controller.resolveDurableSessionSafe({ sessionId, workspacePath: '/workspace/wrong' }))
        .resolves.toEqual({ ok: false, code: 'WORKSPACE_MISMATCH' })
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('classifies an unavailable persistence service and registry publication failure', async () => {
    const unavailable = await harness({ providePersistence: false })
    const publishFailure = await harness()
    const sessionId = SessionId('durable-task')
    const enter = vi.spyOn(publishFailure.ctx.sessions, 'enter')
      .mockImplementation(() => { throw new Error('registry internals') })

    try {
      await expect(unavailable.controller.resolveDurableSessionSafe({ sessionId, workspacePath: WORKSPACE }))
        .resolves.toEqual({ ok: false, code: 'PERSISTENCE_UNAVAILABLE' })
      await expect(publishFailure.controller.resolveDurableSessionSafe({ sessionId, workspacePath: WORKSPACE }))
        .resolves.toEqual({ ok: false, code: 'REGISTRY_PUBLISH_FAILED' })
      expect(publishFailure.ctx.sessions.get(sessionId)).toBeUndefined()
      expect(publishFailure.release).toHaveBeenCalledTimes(1)
    } finally {
      enter.mockRestore()
      await unavailable.ctx.fiber.dispose()
      await publishFailure.ctx.fiber.dispose()
    }
  })
})
