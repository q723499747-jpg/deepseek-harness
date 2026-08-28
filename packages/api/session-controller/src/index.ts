/** Session Remote owner: cold reads, explicit Agent commands, and live control state. */

import { isAbsolute, normalize } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { canOpenNativePath, openNativePath } from '@deepseek-ai/dsh-native-command'
import {
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRecoveryRequiredError,
} from '@deepseek-ai/dsh-session-persistence'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { Remote, TypertRemoteFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ApiSessionAgentController,
  inspectApiSession,
  type ApiSessionAgentResult,
} from './agent.ts'
import { SessionCommandController } from './commands.ts'
import { SessionControlController } from './control.ts'
import { SessionHistoryController } from './history.ts'
import { SessionFileReferences } from './file-references.ts'
import { ApiSessionList, DEFAULT_COLD_BLANK_PROBE_MAX_BYTES } from './list.ts'
import { buildModelCatalog } from './catalog.ts'
import { installModelSelectionProjection } from './model-selection-projection.ts'
import { SessionSkillCatalog } from './skill-catalog.ts'
import type {
  ModelCatalog,
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionControlFrame,
  SessionCreateRequest,
  SessionCreateValue,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionForkRequest,
  SessionForkValue,
  SessionListRequest,
  SessionListValue,
  SessionOpenWorkspacePathRequest,
  SessionOpenWorkspacePathValue,
  SessionPage,
  SessionPageRequest,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSearchRequest,
  SessionSearchValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
  ExternalTaskSessionMarker,
} from './types.ts'

export type * from './types.ts'
export { ApiSessionNotFound } from './agent.ts'
export { SessionFileReferences } from './file-references.ts'
export { SessionSkillCatalog } from './skill-catalog.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Session business API and Remote namespace owner. */
    sessionController: SessionController
  }
}

/** Session Controller deployment policy. */
export interface Config {
  /** Maximum cold Session artifact size eligible for one full projection observation. */
  readonly coldBlankProbeMaxBytes?: number
  /** Override platform desktop-opener detection. */
  readonly nativeOpen?: boolean
}

/** Host integrations replaceable by direct unit tests. */
export interface SessionControllerInternals {
  /** Native default-application handoff. */
  readonly openPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** Native handoff availability probe. */
  readonly canOpenPath?: () => boolean
}

/** Same-process request for publishing one exact durable Session into the live registry. */
export interface DurableSessionResolveRequest {
  /** Durable Session identity. */
  readonly sessionId: SessionId
  /** Exact absolute workspace path authorized by the caller. */
  readonly workspacePath: string
}

/** Successful durable Session resolution without an Agent or model turn. */
export interface DurableSessionResolveResult {
  /** Existing or newly hydrated exact Session. */
  readonly session: Session
  /** Whether this call observed a live Session or published the cold source. */
  readonly disposition: 'live' | 'hydrated'
}

/** Content-free reason an exact durable Session could not enter the live registry. */
export type DurableSessionResolveFailureCode =
  | 'NOT_FOUND'
  | 'WORKSPACE_MISMATCH'
  | 'SESSION_ID_MISMATCH'
  | 'RECOVERY_REQUIRED'
  | 'CORRUPT'
  | 'UNSUPPORTED_FORMAT'
  | 'PERSISTENCE_UNAVAILABLE'
  | 'REGISTRY_PUBLISH_FAILED'
  | 'UNKNOWN'

/** Host-safe exact durable Session result without persistence diagnostics. */
export type DurableSessionSafeResolveResult =
  | ({ readonly ok: true } & DurableSessionResolveResult)
  | { readonly ok: false; readonly code: DurableSessionResolveFailureCode }

/** Stable fail-closed reason from the same-process durable Session seam. */
export class DurableSessionResolveError extends Error {
  /**
   * @param code - stable failure class for Host integrations.
   * @param message - diagnostic without persistence contents.
   * @param options - underlying persistence or validation failure.
   */
  constructor(
    readonly code: DurableSessionResolveFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DurableSessionResolveError'
  }
}

/** Host service backing the generated `ctx.remote.session` namespace. */
export class SessionController extends TypertRemoteService {
  static inject = [
    'agentDefaultModel',
    'agents',
    'attachments',
    'llm',
    'sessions',
    'sessionProjections',
    'sessionQuery',
    'typert',
    'workspaceRegistry',
  ]

  static Config: z<Config> = z.object({
    coldBlankProbeMaxBytes: z.natural().default(DEFAULT_COLD_BLANK_PROBE_MAX_BYTES),
    nativeOpen: z.boolean(),
  })

  private readonly agents: ApiSessionAgentController
  private readonly commands: SessionCommandController
  private readonly controlState: SessionControlController
  private readonly history: SessionHistoryController
  private readonly listState: ApiSessionList
  private readonly openPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly canOpenPath: () => boolean
  private readonly promotions = new Set<Promise<void>>()
  private readonly hydrations = new Map<SessionId, Promise<DurableSessionResolveResult>>()

  /**
   * @param ctx - Host context containing the Session capability assembly.
   * @param config - cold-list observation policy.
   */
  constructor(ctx: Context, config: Config, internals: SessionControllerInternals = {}) {
    super(ctx, 'sessionController', { namespace: 'session' })
    installModelSelectionProjection(ctx)
    this.agents = new ApiSessionAgentController(ctx)
    this.commands = new SessionCommandController(ctx, this.agents, process.cwd())
    this.controlState = new SessionControlController(ctx)
    // Registered before history so reverse-order teardown closes every
    // follower before waiting for already-admitted promotions.
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.promotions])
    }, 'session-controller.promotions')
    this.history = new SessionHistoryController(ctx, (observation) => { this.promote(observation) })
    this.listState = new ApiSessionList(
      ctx,
      config.coldBlankProbeMaxBytes ?? DEFAULT_COLD_BLANK_PROBE_MAX_BYTES,
    )
    this.openPath = internals.openPath ?? openNativePath
    this.canOpenPath = internals.canOpenPath
      ?? (() => config.nativeOpen ?? (internals.openPath !== undefined || canOpenNativePath()))
    ctx.plugin(SessionFileReferences)
    ctx.plugin(SessionSkillCatalog)

    ctx.on('session/created', (session) => {
      ctx.emit('api-session/added', this.listState.summaryFor(session))
    })
    ctx.on('session/disposed', (session) => {
      ctx.emit('api-session/removed', session.id)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      ctx.emit('api-session/status', agent.id, status === 'running')
    })
    ctx.on('agent/error', ({ agent, error }) => {
      ctx.emit('api-session/error', agent.id, errorChain(error))
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'request/header') {
        const agent = ctx.agents.get(session.id)
        if (agent?.session === session) this.agents.consumeSelection(
          agent,
          event.data.header.config.provider,
          event.data.header.config.model,
          event.data.header.config.reasoningEffort,
        )
      }
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
      ctx.emit('api-session/activity', session.id, event.time)
    })
  }

  /**
   * Persist one idempotent list-visibility marker for an external task Session.
   * This operation never appends a model turn or a user/model message.
   * @param session - live Session owned by the calling Host integration.
   * @param marker - opaque producer/task correlation.
   */
  markExternalTaskVisible(session: Session, marker: ExternalTaskSessionMarker): void {
    const exists = session.events.some(event => event.type === 'session/external-task'
      && event.data.producer === marker.producer && event.data.taskId === marker.taskId)
    if (!exists) session.append('session/external-task', marker)
  }

  /**
   * Publish one exact durable Session into the live registry without mounting
   * an Agent, appending an event, marking it list-visible, or calling a model.
   * Concurrent callers for one identity share the same hydration transaction.
   * @param request - exact durable identity and authorized workspace.
   * @param signal - optional cancellation before registry publication.
   * @returns the live exact Session and whether this call hydrated it.
   */
  resolveDurableSession(
    request: DurableSessionResolveRequest,
    signal?: AbortSignal,
  ): Promise<DurableSessionResolveResult> {
    const workspacePath = this.validateWorkspacePath(request.sessionId, request.workspacePath)
    const live = this.ctx.sessions.get(request.sessionId)
    if (live !== undefined) {
      this.assertWorkspace(request.sessionId, live.header, workspacePath)
      return Promise.resolve({ session: live, disposition: 'live' })
    }
    const inFlight = this.hydrations.get(request.sessionId)
    if (inFlight !== undefined) {
      return inFlight.then((result) => {
        this.assertWorkspace(request.sessionId, result.session.header, workspacePath)
        return result
      })
    }
    const hydration = this.hydrateDurableSession(request.sessionId, workspacePath, signal)
    this.hydrations.set(request.sessionId, hydration)
    void hydration.finally(() => {
      if (this.hydrations.get(request.sessionId) === hydration) {
        this.hydrations.delete(request.sessionId)
      }
    }).catch(() => {})
    return hydration
  }

  /**
   * Resolve one durable Session with a bounded classification safe for Host consumers.
   * @param request - exact durable identity and authorized workspace.
   * @param signal - optional cancellation before registry publication.
   * @returns the resolved Session or a content-free failure code.
   */
  async resolveDurableSessionSafe(
    request: DurableSessionResolveRequest,
    signal?: AbortSignal,
  ): Promise<DurableSessionSafeResolveResult> {
    try {
      return { ok: true, ...await this.resolveDurableSession(request, signal) }
    } catch (error) {
      return { ok: false, code: this.classifyDurableSessionFailure(error).code }
    }
  }

  /** Prepare, validate, and publish one cold Session without durable mutation. */
  private async hydrateDurableSession(
    sessionId: SessionId,
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<DurableSessionResolveResult> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new DurableSessionResolveError(
        'PERSISTENCE_UNAVAILABLE',
        `cannot hydrate session "${sessionId}": session persistence is not configured`,
      )
    }
    signal?.throwIfAborted()
    let preparation: SessionPreparation
    try { preparation = await persistence.prepareExact(sessionId, signal) }
    catch (error) { throw this.classifyDurableSessionFailure(error) }
    using ownedPreparation = preparation
    signal?.throwIfAborted()
    const prepared = ownedPreparation.session
    if (prepared.id !== sessionId || prepared.header.id !== sessionId) {
      throw new DurableSessionResolveError(
        'SESSION_ID_MISMATCH',
        `cannot hydrate session "${sessionId}": persistence returned a different identity`,
      )
    }
    this.assertWorkspace(sessionId, prepared.header, workspacePath)
    const raced = this.ctx.sessions.get(sessionId)
    if (raced !== undefined) {
      this.assertWorkspace(sessionId, raced.header, workspacePath)
      return { session: raced, disposition: 'live' }
    }
    try {
      this.ctx.effect(function* (this: SessionController) {
        yield this.ctx.sessions.enter(prepared)
        this.ctx.sessions.announce(prepared)
      }.bind(this), `session-controller hydrate ${sessionId}`)
    } catch (error) {
      throw new DurableSessionResolveError(
        'REGISTRY_PUBLISH_FAILED',
        'durable session registry publication failed',
        { cause: error },
      )
    }
    return { session: prepared, disposition: 'hydrated' }
  }

  /** Normalize and validate one caller-supplied absolute workspace path. */
  private validateWorkspacePath(sessionId: SessionId, workspacePath: string): string {
    if (workspacePath.length === 0 || !isAbsolute(workspacePath)) {
      throw new DurableSessionResolveError(
        'WORKSPACE_MISMATCH',
        `cannot hydrate session "${sessionId}": workspace path must be absolute`,
      )
    }
    return normalize(workspacePath)
  }

  /** Require the durable Session header to remain in the caller's workspace. */
  private assertWorkspace(
    sessionId: SessionId,
    header: SessionHeader,
    workspacePath: string,
  ): void {
    if (header.cwd === undefined || normalize(header.cwd) !== workspacePath) {
      throw new DurableSessionResolveError(
        'WORKSPACE_MISMATCH',
        `cannot hydrate session "${sessionId}": durable workspace does not match the requested workspace`,
      )
    }
  }

  /** Collapse persistence and registry errors to a stable, content-free Host code. */
  private classifyDurableSessionFailure(error: unknown): DurableSessionResolveError {
    if (error instanceof DurableSessionResolveError) return error
    if (error instanceof SessionPersistenceNotFoundError) {
      return new DurableSessionResolveError(
        'NOT_FOUND',
        'durable session was not found',
        { cause: error },
      )
    }
    if (error instanceof SessionPersistenceRecoveryRequiredError) {
      return new DurableSessionResolveError(
        'RECOVERY_REQUIRED',
        'durable session requires write-side recovery',
        { cause: error },
      )
    }
    if (error instanceof SessionPersistenceCorruptionError) {
      return new DurableSessionResolveError(
        'CORRUPT',
        'durable session failed validation',
        { cause: error },
      )
    }
    if (error instanceof SessionFormatUnsupportedError) {
      return new DurableSessionResolveError(
        'UNSUPPORTED_FORMAT',
        'durable session format is unsupported',
        { cause: error },
      )
    }
    return new DurableSessionResolveError('UNKNOWN', 'durable session resolution failed', {
      cause: error instanceof Error ? error : undefined,
    })
  }

  private promote(observation: SessionObservation): void {
    const sessionId = observation.header.id
    const task = (async () => {
      using ownedObservation = observation
      const result = await this.agents.resolveObservedAgent(ownedObservation)
      if ('error' in result) this.ctx.emit('api-session/error', sessionId, result.error.message)
    })().catch((error: unknown) => {
      this.ctx.logger.error(`session-controller: background activation for "${sessionId}" failed: ${errorChain(error)}`)
    })
    this.promotions.add(task)
    void task.finally(() => { this.promotions.delete(task) })
  }

  /**
   * Resolve or resume one ordinary Session for another Host API domain.
   * @param sessionId - Session identity whose Agent owns the operation.
   * @returns the live Agent or the stable Session-domain failure.
   */
  resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.agents.resolveAgent(sessionId)
  }

  /**
   * Inspect one attached or persisted Session without activating its Agent.
   * @param sessionId - durable Session identity.
   * @param signal - optional caller cancellation for persistence reads.
   * @returns the current attached state or persisted header and event prefix.
   */
  inspect(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      return Promise.resolve({ meta: attached.header, events: [...attached.events] })
    }
    return inspectApiSession(this.ctx, sessionId, signal)
  }

  /**
   * Read all visible Session rows without resuming an Agent.
   * @param _request - reserved empty list request.
   * @param signal - cancellation for persistence reads.
   * @returns visible Session summaries ordered by activity.
   */
  @Remote('list')
  async list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue> {
    return { items: await this.listState.list(signal) }
  }

  /**
   * Search visible Session content without resuming an Agent.
   * @param request - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  @Remote('search')
  search(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> {
    return this.listState.search(request.query, signal)
  }

  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   */
  @Remote('create')
  create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    return this.commands.create(request)
  }

  /**
   * Select one Session-local model after explicitly resuming the Session.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session.
   */
  @Remote('selectModel')
  selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    return this.commands.selectModel(request)
  }

  /**
   * Describe every currently routable model for Host-generation selectors.
   * @returns provider-grouped models, the deployment default, and isolated provider failures.
   */
  @Remote('modelCatalog')
  modelCatalog(): Promise<ModelCatalog> {
    return buildModelCatalog(this.ctx)
  }

  /**
   * Report whether this deployment can hand a Session workspace path to a native desktop.
   * @returns true when the matching open operation is available.
   */
  @Remote
  canOpenWorkspacePath(): boolean {
    return this.canOpenPath()
  }

  /**
   * Open one path prepared by a Session-aware caller on the Host desktop.
   * @param request - path after best-effort Session workspace resolution.
   * @param signal - caller lifetime; abort terminates the native command.
   * @returns confirmation after the native opener accepts the path.
   * @throws TypertRemoteFailure when the request is invalid, cancelled, or the opener fails.
   */
  @Remote('openWorkspacePath')
  async openWorkspacePath(
    request: SessionOpenWorkspacePathRequest,
    signal: AbortSignal,
  ): Promise<SessionOpenWorkspacePathValue> {
    if (request.path.length === 0) {
      throw new TypertRemoteFailure({
        code: 'bad-request',
        message: 'session.openWorkspacePath requires a non-empty path',
        details: {},
      })
    }
    signal.throwIfAborted()
    try {
      await this.openPath(request.path, signal)
      return { opened: true }
    } catch (error: unknown) {
      if (signal.aborted) {
        throw new TypertRemoteFailure({
          code: 'cancelled', message: 'path open was aborted', details: {},
        })
      }
      throw new TypertRemoteFailure({
        code: 'internal',
        message: `path open failed: ${error instanceof Error ? error.message : String(error)}`,
        details: {},
      })
    }
  }

  /**
   * Rename one Session after explicitly resuming it.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  @Remote('rename')
  rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    return this.commands.rename(request)
  }

  /**
   * Fork one cold-readable completed-turn prefix into a new Session.
   * @param request - source Session and optional event anchor.
   * @returns the new Session identity.
   */
  @Remote('fork')
  fork(request: SessionForkRequest): Promise<SessionForkValue> {
    return this.commands.fork(request)
  }

  /**
   * Admit one prompt after explicitly resuming its Session.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @param signal - caller cancellation before prompt admission begins.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  @Remote('prompt')
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
    signal.throwIfAborted()
    return this.commands.prompt(request)
  }

  /**
   * Read one image proven reachable from the addressed Session log.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  @Remote('attachment')
  attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    return this.commands.attachment(request)
  }

  /**
   * Mutate one still-pending queue occurrence on a live Agent.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  @Remote('updateQueue')
  updateQueue(request: SessionUpdateQueueRequest): SessionUpdateQueueValue {
    return this.commands.updateQueue(request)
  }

  /**
   * Cancel one active Agent turn without dropping its pending inbox.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  @Remote('cancel')
  cancel(request: SessionCancelRequest): SessionCancelValue {
    return this.commands.cancel(request)
  }

  /**
   * Read one cold-safe, message-aligned Session history page.
   * @param request - durable address, backward cursor, and page budget.
   * @param signal - cancellation for persistence reads.
   * @returns one chronological page.
   */
  @Remote('page')
  page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    return this.history.page(request, signal)
  }

  /**
   * Follow one Session log from its opening or resume cursor.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns a complete opening snapshot followed by gap-free event frames.
   */
  @Remote({ mode: 'stream' })
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    return this.history.follow(request, signal)
  }

  /**
   * Stream a complete live-control baseline followed by replacement frames.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns one complete baseline followed by live replacement frames.
   */
  @Remote({ mode: 'stream' })
  control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    return this.controlState.control(signal)
  }

}

export { buildModelCatalog }
export default SessionController
