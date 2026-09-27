import { build } from '../build/node_modules/esbuild/lib/main.js'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const root = fileURLToPath(new URL('.', import.meta.url))

const worker = await build({
  bundle: true,
  entryPoints: [`${root}../build/node_modules/monaco-editor/esm/vs/editor/editor.worker.js`],
  format: 'iife',
  platform: 'browser',
  write: false
})

await mkdir(`${root}dist`, { recursive: true })
const sharedCss = await readFile(`${root}../build/src/editor.css`, 'utf8')
const desktopCss = await readFile(`${root}src/editor.css`, 'utf8')
const plugin = await build({
  alias: { 'monaco-editor': `${root}../build/node_modules/monaco-editor` },
  banner: { js: `const __HE_MONACO_WORKER__=${JSON.stringify(worker.outputFiles[0].text)};` },
  bundle: true,
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  entryPoints: [`${root}src/plugin.js`],
  external: ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'],
  format: 'esm',
  minify: true,
  outfile: `${root}dist/plugin.js`,
  platform: 'browser',
  target: 'es2022',
  write: false
})

const js = plugin.outputFiles.find(file => file.path.endsWith('.js'))
const dependencyCss = plugin.outputFiles.find(file => file.path.endsWith('.css'))?.text || ''
if (!js) throw new Error('Desktop plugin JavaScript output missing')
const css = `${sharedCss}\n${desktopCss}\n${dependencyCss}`
// Runtime plugins normally import the SDK and React through loader-generated
// blob URLs. Its conservative import scanner cannot distinguish two
// `from","` sequences in Monaco/KaTeX vocabulary data from imports, though.
// Resolve the only two allowed runtime dependencies from the globals that the
// loader installs before evaluation; the result has no ESM imports to scan.
// This preserves the app's React singleton and SDK namespace.
const namedBindings = names => names.split(',').map(binding => {
  const [original, local = original] = binding.split(/\s+as\s+/)
  return original === local ? original : `${original}:${local}`
}).join(',')
const inlineRuntimeImport = (source, specifier, global) => source.replace(
  new RegExp(`import\\s*(?:([A-Za-z_$][\\w$]*)\\s*,?)?\\{([^}]+)\\}from["']${specifier}["'];`, 'g'),
  (_match, defaultBinding, named) => `const {${defaultBinding ? `default:${defaultBinding},` : ''}${namedBindings(named)}}=globalThis.${global};`
)
const runtimeSource = inlineRuntimeImport(
  inlineRuntimeImport(js.text, 'react', '__HERMES_REACT__'),
  '@hermes/plugin-sdk',
  '__HERMES_PLUGIN_SDK__'
).replaceAll('from","', 'from\\x22,')
const output = Buffer.from(`const __HE_EDITOR_DESKTOP_CSS__=${JSON.stringify(css)};${runtimeSource}`)
await writeFile(`${root}dist/plugin.js`, output)
await writeFile(`${root}dist/plugin.js.gz`, gzipSync(output))
// Hermes discovers unified desktop plugins at desktop/plugin.js. Keep the
// dist copy for release artifacts, but always publish the runtime entry too.
await writeFile(`${root}plugin.js`, output)
