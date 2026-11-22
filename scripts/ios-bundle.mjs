// Bundles what the iPhone app runs of Kuna's TypeScript: ios/bridge.ts (the shared logic plus the
// host helper) into the script it runs in JavaScriptCore, and ios/web/page.ts (Markdown, code and
// diffs) into the script of its web views.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const raw = readFileSync(resolve(root, 'src/main/remote/kuna.sh'), 'utf8')
// the same version as src/main/hosts/script.ts, so both apps agree on whether a host's helper is current
const version = createHash('sha1').update(raw).digest('hex').slice(0, 12)

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
  define: {
    __KUNA_SCRIPT__: JSON.stringify(raw.replace('__KUNA_VERSION__', version)),
    __KUNA_VERSION__: JSON.stringify(version)
  },
  build: {
    lib: { entry: resolve(root, 'ios/bridge.ts'), formats: ['iife'], name: 'Kuna', fileName: () => 'kuna-shared.js' },
    outDir: resolve(root, 'ios/Sources/KunaCore/Resources'),
    emptyOutDir: false,
    minify: false
  }
})

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
  build: {
    lib: { entry: resolve(root, 'ios/web/page.ts'), formats: ['iife'], name: 'KunaWeb', fileName: () => 'kuna-web.js' },
    outDir: resolve(root, 'ios/Sources/KunaUI/Resources'),
    emptyOutDir: false,
    minify: true
  }
})
