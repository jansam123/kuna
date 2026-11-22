// Bundles what the iPhone app runs of Kuna's TypeScript: ios/bridge.ts (the shared logic plus the
// host helper and the project icons) into the script it runs in JavaScriptCore, and ios/web/page.ts (Markdown, code and
// diffs) into the script of its web views.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { absolutize, normalize, parsePath } from 'path-data-parser'
import { build, transformWithOxc } from 'vite'

const root = resolve(import.meta.dirname, '..')
const raw = readFileSync(resolve(root, 'src/main/remote/kuna.sh'), 'utf8')
// the same version as src/main/hosts/script.ts, so both apps agree on whether a host's helper is current
const version = createHash('sha1').update(raw).digest('hex').slice(0, 12)

// The Mac's project icons (ProjectIcon.tsx, SVG on a 24 grid) as plain drawing steps, so the phone
// draws the same ones without an SVG reader: each shape is a list of [0,x,y] move, [1,x,y] line,
// [2,…6] curve, [3] close, with its own stroke width, dashes and fill where the icon sets them.
async function projectIcons() {
  const file = resolve(root, 'src/renderer/src/components/ProjectIcon.tsx')
  const js = await transformWithOxc(readFileSync(file, 'utf8'), file, { jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'F' } })
  const h = "const F = 'F'; const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });"
  const { ICONS } = await import(`data:text/javascript,${encodeURIComponent(h + js.code)}`)
  const n = (v) => Number(v) || 0
  const oval = (cx, cy, rx, ry) => `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`
  const box = (x, y, w, ht, r) => (r ? `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${ht - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${2 * r - w}a${r} ${r} 0 0 1 ${-r} ${-r}v${2 * r - ht}a${r} ${r} 0 0 1 ${r} ${-r}Z` : `M${x} ${y}h${w}v${ht}h${-w}Z`)
  const shape = ({ type, props: p }) => {
    const d =
      type === 'path' ? p.d
      : type === 'circle' ? oval(n(p.cx), n(p.cy), n(p.r), n(p.r))
      : type === 'ellipse' ? oval(n(p.cx), n(p.cy), n(p.rx), n(p.ry))
      : type === 'rect' ? box(n(p.x), n(p.y), n(p.width), n(p.height), n(p.rx))
      : null
    if (!d) throw new Error(`ProjectIcon.tsx draws a <${type}>, which scripts/ios-bundle.mjs cannot turn into steps yet`)
    const turn = /^rotate\(([-\d.]+) ([-\d.]+) ([-\d.]+)\)$/.exec(p.transform ?? '')
    if (p.transform && !turn) throw new Error(`ProjectIcon.tsx uses transform="${p.transform}"; only rotate(a x y) is read`)
    const [a, ox, oy] = turn ? [(n(turn[1]) * Math.PI) / 180, n(turn[2]), n(turn[3])] : [0, 0, 0]
    const at = (x, y) => [ox + (x - ox) * Math.cos(a) - (y - oy) * Math.sin(a), oy + (x - ox) * Math.sin(a) + (y - oy) * Math.cos(a)].map((v) => Math.round(v * 1000) / 1000)
    const ops = normalize(absolutize(parsePath(d))).map(({ key, data }) => {
      const pts = []
      for (let i = 0; i + 1 < data.length; i += 2) pts.push(...at(data[i], data[i + 1]))
      return ['MLCZ'.indexOf(key), ...pts]
    })
    return {
      ops,
      ...(p.strokeWidth ? { w: n(p.strokeWidth) } : {}),
      ...(p.strokeDasharray ? { dash: p.strokeDasharray.split(/[ ,]+/).map(n) } : {}),
      ...(p.fill === 'currentColor' ? { fill: true } : {}),
      ...(p.stroke === 'none' ? { stroke: false } : {})
    }
  }
  const flat = (node) => (node.type === 'F' ? node.children.flatMap(flat) : [shape(node)])
  return Object.fromEntries(Object.entries(ICONS).map(([name, node]) => [name, flat(node)]))
}
const icons = await projectIcons()

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
  define: {
    __KUNA_ICONS__: JSON.stringify(JSON.stringify(icons)),
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
