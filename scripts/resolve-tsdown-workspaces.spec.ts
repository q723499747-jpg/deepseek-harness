/** Root tsdown workspace package discovery. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTsdownWorkspaces } from './resolve-tsdown-workspaces.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tsdown-workspaces-'))
  roots.push(root)
  return root
}

async function writePackage(root: string, directory: string): Promise<void> {
  const path = join(root, directory)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'package.json'), '{}\n')
}

describe('resolveTsdownWorkspaces', () => {
  it('excludes phantom directories while preserving every declared package in stable order', async () => {
    const root = await fixtureRoot()
    await Promise.all([
      writePackage(root, 'vendor/zeta'),
      writePackage(root, 'packages/host/real'),
      writePackage(root, 'packages/client/real'),
      writePackage(root, 'apps/cli'),
      mkdir(join(root, 'packages/client/runtime/node_modules/ignored'), { recursive: true }),
      mkdir(join(root, 'packages/host/apiproxy'), { recursive: true }),
    ])

    expect(resolveTsdownWorkspaces(root)).toEqual([
      'apps/cli',
      'packages/client/real',
      'packages/host/real',
      'vendor/zeta',
    ])
  })
})
