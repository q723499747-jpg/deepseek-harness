import { describe, expect, it, vi } from 'vitest'
import { detectModuleLoaderVersion } from '../../../../vendor/loader/src/internal.ts'

const builtin = { format: 'builtin', url: 'node:path' } as const

describe('detectModuleLoaderVersion', () => {
  it('detects the request-object v2 convention', () => {
    const resolveSync = vi.fn((parentURL: unknown, request: unknown) => {
      if (typeof parentURL !== 'string' || typeof request !== 'object' || request === null) {
        throw new TypeError('expected v2 arguments')
      }
      if (Reflect.get(request, 'specifier') !== 'node:path') throw new Error('unexpected specifier')
      return builtin
    })

    expect(detectModuleLoaderVersion({ resolveSync })).toBe('v2')
    expect(resolveSync).toHaveBeenCalledTimes(1)
  })

  it('detects the legacy positional convention even on a Node 24 runtime', () => {
    const resolveSync = vi.fn((specifier: unknown, parentURL: unknown) => {
      if (specifier !== 'node:path' || typeof parentURL !== 'string') {
        throw new TypeError('expected v1 arguments')
      }
      return builtin
    })

    expect(detectModuleLoaderVersion({ resolveSync })).toBe('v1')
    expect(resolveSync).toHaveBeenCalledTimes(2)
  })

  it('accepts Node 24 builtin results that omit format', () => {
    const resolveSync = vi.fn((specifier: unknown, parentURL: unknown) => {
      if (specifier !== 'node:path' || typeof parentURL !== 'string') {
        throw new TypeError('expected v1 arguments')
      }
      return { url: 'node:path' }
    })

    expect(detectModuleLoaderVersion({ resolveSync })).toBe('v1')
    expect(resolveSync).toHaveBeenCalledTimes(2)
  })

  it('returns undefined when neither internal convention is usable', () => {
    const resolveSync = vi.fn(() => { throw new Error('unsupported') })

    expect(detectModuleLoaderVersion({ resolveSync })).toBeUndefined()
    expect(resolveSync).toHaveBeenCalledTimes(2)
  })
})
