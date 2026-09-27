import { readFile, writeFile } from 'node:fs/promises'

const template = await readFile(new URL('./src/dashboard.css', import.meta.url), 'utf8')
const editor = await readFile(new URL('./src/editor.css', import.meta.url), 'utf8')
const marker = '/* @hermes-editor-shared */'

if (template.split(marker).length !== 2) throw new Error('dashboard CSS shared marker missing or duplicated')
await writeFile(new URL('../dashboard/dist/style.css', import.meta.url), template.replace(marker, editor))
