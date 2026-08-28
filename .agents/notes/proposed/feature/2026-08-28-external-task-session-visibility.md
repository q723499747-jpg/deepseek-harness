# Agent Note: Durable external-task Session visibility

Status: proposed

English | [中文](2026-08-28-external-task-session-visibility.zh.md)

## Problem

An integration can own a durable Session without starting a model turn. Its log-only task events and cards survive restart, but the Session-list projection remains `blank: true` because it recognizes only `turn/start`. The Web list hides that Session, so its durable task history is addressable by API but not discoverable in the workspace.

Appending `turn/start` or `user/message` would misrepresent an external process as a model interaction. Keeping a private integration-specific list override would make Session visibility depend on each client and would not survive a Host restart.

## Proposal

`SessionController.markExternalTaskVisible(session, marker)` appends one idempotent `session/external-task` event. The marker carries only a producer name and an opaque task id. It is log-only: model history, token accounting, and turn lifecycle ignore it.

The `sessionListMetadata` projection treats either `turn/start` or `session/external-task` as evidence that a Session is not blank. Its state version increments so old projection-cache rows cannot preserve obsolete blankness after upgrade. The ordinary persistence log and projection replay make the decision survive restart without a mutable Session header or client-only exception.

## Alternatives considered

**Append a synthetic model turn.** Rejected because it creates false model history and breaks turn invariants for an operation that never called a model.

**Let each integration patch the Web list.** Rejected because it is neither durable nor authoritative, and every integration would need to duplicate client behavior.

**Extend immutable Session headers.** Rejected because an external task becomes material only after a Session exists, while headers are creation-time metadata and zero-event sessions are intentionally absent from persistence listings.

## Acceptance criteria

- A Session with one external-task marker is listed with `blank: false` while its log contains no `turn/start`, `user/message`, or assistant event.
- Repeating the same producer/task marker is idempotent.
- Persisted projection replay keeps the Session visible after restart.
- Ordinary blank and model-turn Sessions retain their current behavior.

## Risks

An integration that marks a task before it has accepted durable ownership can expose an empty row. The Host integration therefore calls the method only after its own durable reservation succeeds. The marker carries no display text, actor identity, credential, URL, or business payload, so list visibility does not create a second data projection.
