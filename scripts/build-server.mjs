// Bundles the web server (src/server/index.ts) into out/server/index.js.
//
// The server reuses the desktop main-process modules (library, settings,
// thumbs, pipeline) without modifying them. Two redirects make that work:
//   - 'electron' resolves to src/server/electron-shim.ts
//   - './env' imported from src/main resolves to src/server/env.ts
import { build } from 'esbuild'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mainDir = join(root, 'src', 'main')
const watch = process.argv.includes('--watch')

const redirectDesktopEnv = {
  name: 'redirect-desktop-env',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({
      path: join(root, 'src', 'server', 'electron-shim.ts')
    }))
    b.onResolve({ filter: /^\.\/env$/ }, (args) =>
      resolve(args.resolveDir) === mainDir ? { path: join(root, 'src', 'server', 'env.ts') } : undefined
    )
  }
}

const options = {
  entryPoints: [join(root, 'src', 'server', 'index.ts')],
  outfile: join(root, 'out', 'server', 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  plugins: [redirectDesktopEnv]
}

if (watch) {
  const { context } = await import('esbuild')
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}
