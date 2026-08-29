/** Resolve the package directories owned by the root tsdown build. */

import { globSync } from 'node:fs'
import { dirname } from 'node:path'

const TSDOWN_PACKAGE_MANIFESTS = [
  'apps/cli/package.json',
  'packages/*/*/package.json',
  'vendor/*/package.json',
]

/**
 * Resolve only directories that declare a package manifest.
 *
 * @param root - Repository root used for manifest discovery.
 * @returns Deterministically ordered workspace package directories.
 */
export function resolveTsdownWorkspaces(root: string): string[] {
  return [...new Set(globSync(TSDOWN_PACKAGE_MANIFESTS, {
    cwd: root,
    exclude: ['**/node_modules/**'],
  }).map(path => dirname(path).replaceAll('\\', '/')))].sort()
}
