import { test } from 'node:test'
import assert from 'node:assert/strict'
import { embedCandidatePaths } from '../desktop/src/embeds.mjs'

test('Obsidian media folders are checked before vault-wide scanning', () => {
  const root = '/home/testuser/.hermes/remote-workspaces/obsidian'
  const image = 'Pasted image 20250805185724.png'
  const paths = embedCandidatePaths([root], 'Example/Learning/General/Math', image)

  assert.ok(paths.includes(`${root}/Ink/${image}`))
  assert.ok(paths.includes(`${root}/Images/${image}`))
  assert.ok(paths.includes(`${root}/attachments/${image}`))
  assert.equal(paths[0], `${root}/Example/Learning/General/Math/${image}`)
})
