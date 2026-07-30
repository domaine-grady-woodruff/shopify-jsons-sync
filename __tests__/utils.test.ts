import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  expect,
  test,
  describe,
  beforeEach,
  afterEach,
  jest
} from '@jest/globals'

jest.mock('@actions/exec')
import {exec} from '@actions/exec'

import {
  readJsonFile,
  removeDisabledKeys,
  syncLocaleAndSettingsJSON,
  getNewTemplatesToRemote,
  sendFilesWithPathToShopify,
  cleanRemoteFiles
} from '../src/utils'

const mockedExec = exec as jest.MockedFunction<typeof exec>

let originalCwd: string
let tmpDir: string

beforeEach(() => {
  originalCwd = process.cwd()
  tmpDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'jsons-sync-test-'))
  )
  process.chdir(tmpDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

function writeJson(relPath: string, data: unknown): void {
  const full = path.join(tmpDir, relPath)
  fs.mkdirSync(path.dirname(full), {recursive: true})
  fs.writeFileSync(full, JSON.stringify(data, null, 2))
}

function writeRaw(relPath: string, content: string): void {
  const full = path.join(tmpDir, relPath)
  fs.mkdirSync(path.dirname(full), {recursive: true})
  fs.writeFileSync(full, content)
}

function readJson(relPath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, relPath), 'utf8'))
}

function exists(relPath: string): boolean {
  return fs.existsSync(path.join(tmpDir, relPath))
}

describe('removeDisabledKeys', () => {
  test('removes a block whose disabled value is exactly true', () => {
    const result = removeDisabledKeys({
      block1: {type: 'text', disabled: true}
    })
    expect(result).toEqual({})
  })

  test('keeps a block with disabled: false (regression: existence-check bug)', () => {
    // Previously this checked hasOwnProperty('disabled') instead of the value,
    // which incorrectly stripped explicitly-enabled blocks.
    const result = removeDisabledKeys({
      block1: {type: 'image', disabled: false}
    })
    expect(result).toEqual({block1: {type: 'image', disabled: false}})
  })

  test('keeps a block with no disabled key at all', () => {
    const result = removeDisabledKeys({
      block1: {type: 'video'}
    })
    expect(result).toEqual({block1: {type: 'video'}})
  })

  test('keeps non-object values untouched', () => {
    const result = removeDisabledKeys({
      order: ['block1', 'block2'],
      label: 'hello'
    })
    expect(result).toEqual({order: ['block1', 'block2'], label: 'hello'})
  })

  test('handles a mix of disabled, enabled, and keyless blocks', () => {
    const result = removeDisabledKeys({
      keep1: {type: 'text'},
      drop: {type: 'text', disabled: true},
      keep2: {type: 'image', disabled: false}
    })
    expect(result).toEqual({
      keep1: {type: 'text'},
      keep2: {type: 'image', disabled: false}
    })
  })
})

describe('readJsonFile', () => {
  test('returns {} when the file does not exist', async () => {
    const result = await readJsonFile('locales/does-not-exist.json')
    expect(result).toEqual({})
  })

  test('parses plain JSON with no comment header', async () => {
    writeJson('locales/en.default.json', {greeting: 'hello'})
    const result = await readJsonFile(
      path.join(tmpDir, 'locales/en.default.json')
    )
    expect(result).toEqual({greeting: 'hello'})
  })

  test("strips Shopify's auto-generated comment header before parsing", async () => {
    const content = `/*
 * ------------------------------------------------------------
 * IMPORTANT: The contents of this file are auto-generated.
 *
 * This file may be updated by the Shopify admin language editor
 * or related systems. Please exercise caution as any changes
 * made to this file may be overwritten.
 * ------------------------------------------------------------
 */
{
  "greeting": "hello"
}`
    writeRaw('locales/en.default.json', content)
    const result = await readJsonFile(
      path.join(tmpDir, 'locales/en.default.json')
    )
    expect(result).toEqual({greeting: 'hello'})
  })
})

describe('syncLocaleAndSettingsJSON', () => {
  test('adds a key that only exists remotely (new key)', async () => {
    writeJson('locales/en.default.json', {greeting: 'hello'})
    writeJson('remote/locales/en.default.json', {
      greeting: 'hello',
      farewell: 'goodbye'
    })

    const pushed = await syncLocaleAndSettingsJSON()

    // @actions/glob resolves matches to absolute paths, so the returned
    // "local file ref" is absolute too - not just the relative repo path.
    expect(pushed).toEqual([path.join(tmpDir, 'locales/en.default.json')])
    expect(readJson('locales/en.default.json')).toEqual({
      greeting: 'hello',
      farewell: 'goodbye'
    })
  })

  test('keeps a key that only exists locally (merged keys, not overwritten)', async () => {
    writeJson('locales/en.default.json', {
      greeting: 'hello',
      local_only: 'stays'
    })
    writeJson('remote/locales/en.default.json', {greeting: 'hello'})

    await syncLocaleAndSettingsJSON()

    expect(readJson('locales/en.default.json')).toEqual({
      greeting: 'hello',
      local_only: 'stays'
    })
  })

  test('remote value wins when the same key differs on both sides', async () => {
    writeJson('locales/en.default.json', {greeting: 'stale local value'})
    writeJson('remote/locales/en.default.json', {
      greeting: 'fresh remote value'
    })

    await syncLocaleAndSettingsJSON()

    expect(readJson('locales/en.default.json')).toEqual({
      greeting: 'fresh remote value'
    })
  })

  test('nested objects merge key-by-key rather than being replaced wholesale', async () => {
    writeJson('locales/en.default.json', {
      product: {title: 'stale title', local_only: 'stays'}
    })
    writeJson('remote/locales/en.default.json', {
      product: {title: 'fresh title', new_field: 'added'}
    })

    await syncLocaleAndSettingsJSON()

    expect(readJson('locales/en.default.json')).toEqual({
      product: {
        title: 'fresh title',
        local_only: 'stays',
        new_field: 'added'
      }
    })
  })

  test('KNOWN GAP: a key deleted remotely is NOT removed locally', async () => {
    // deepmerge only adds/overwrites keys present in the source (remote) object;
    // it never deletes target (local) keys that are simply absent from source.
    // So if a string is removed from the live theme's locale file, it lingers
    // in the synced local file indefinitely unless removed by hand.
    writeJson('locales/en.default.json', {
      greeting: 'hello',
      deprecated_string: 'should have been removed on remote'
    })
    writeJson('remote/locales/en.default.json', {greeting: 'hello'})

    await syncLocaleAndSettingsJSON()

    expect(readJson('locales/en.default.json')).toEqual({
      greeting: 'hello',
      deprecated_string: 'should have been removed on remote'
    })
  })

  test('arrays are replaced wholesale by the remote array, not concatenated', async () => {
    writeJson('locales/en.default.json', {
      tags: ['local-a', 'local-b']
    })
    writeJson('remote/locales/en.default.json', {
      tags: ['remote-a']
    })

    await syncLocaleAndSettingsJSON()

    expect(readJson('locales/en.default.json')).toEqual({tags: ['remote-a']})
  })

  test('disabled blocks are stripped when "blocks" exists on both sides', async () => {
    writeJson('locales/en.default.json', {
      blocks: {
        keep: {type: 'text'}
      }
    })
    writeJson('remote/locales/en.default.json', {
      blocks: {
        keep: {type: 'text'},
        drop: {type: 'image', disabled: true}
      }
    })

    await syncLocaleAndSettingsJSON()

    expect(readJson('locales/en.default.json')).toEqual({
      blocks: {keep: {type: 'text'}}
    })
  })

  test('KNOWN GAP: disabled blocks survive when local has no "blocks" key yet', async () => {
    // customMerge('blocks') is only invoked by deepmerge when BOTH sides already
    // have a 'blocks' object at that key. If the local file has never had a
    // 'blocks' key (e.g. first sync of a file that only recently gained blocks
    // on the live theme), remote's blocks are copied through untouched -
    // including ones marked disabled: true.
    writeJson('locales/en.default.json', {})
    writeJson('remote/locales/en.default.json', {
      blocks: {
        keep: {type: 'text'},
        drop: {type: 'image', disabled: true}
      }
    })

    await syncLocaleAndSettingsJSON()

    expect(readJson('locales/en.default.json')).toEqual({
      blocks: {
        keep: {type: 'text'},
        drop: {type: 'image', disabled: true}
      }
    })
  })

  test('creates the local file and its directory when neither exists yet', async () => {
    // Regression: a brand-new locale file (e.g. a language just added on the
    // live theme) has no local counterpart, so `locales/` itself may not
    // exist locally either. writeFile alone would throw ENOENT here.
    writeJson('remote/locales/fr.json', {greeting: 'bonjour'})
    expect(exists('locales')).toBe(false)

    const pushed = await syncLocaleAndSettingsJSON()

    expect(pushed).toEqual([path.join(tmpDir, 'locales/fr.json')])
    expect(readJson('locales/fr.json')).toEqual({greeting: 'bonjour'})
  })

  test('skips an unparseable remote file but still processes the others', async () => {
    writeRaw('remote/locales/broken.json', '{ not valid json')
    writeJson('remote/locales/en.default.json', {greeting: 'hello'})
    writeJson('locales/en.default.json', {})

    const pushed = await syncLocaleAndSettingsJSON()

    expect(pushed).toEqual([path.join(tmpDir, 'locales/en.default.json')])
    expect(exists('locales/broken.json')).toBe(false)
  })

  test('returns an empty array when there are no remote locale files', async () => {
    const pushed = await syncLocaleAndSettingsJSON()
    expect(pushed).toEqual([])
  })
})

describe('getNewTemplatesToRemote', () => {
  test('returns local template files that do not exist remotely', async () => {
    writeJson('templates/index.json', {sections: {}})
    writeJson('templates/product.json', {sections: {}})
    writeJson('remote/templates/index.json', {sections: {}})

    const result = await getNewTemplatesToRemote()

    expect(result).toHaveLength(1)
    expect(result[0]).toMatch(/templates\/product\.json$/)
  })

  test('returns an empty array when every local template already exists remotely', async () => {
    writeJson('templates/index.json', {sections: {}})
    writeJson('remote/templates/index.json', {sections: {}})

    const result = await getNewTemplatesToRemote()

    expect(result).toEqual([])
  })

  test('returns an empty array when there are no local templates', async () => {
    const result = await getNewTemplatesToRemote()
    expect(result).toEqual([])
  })
})

describe('sendFilesWithPathToShopify', () => {
  test('skips the shopify push entirely when there is nothing to send', async () => {
    const result = await sendFilesWithPathToShopify([], {
      targetThemeId: '123',
      store: 'test-store.myshopify.com'
    })

    expect(result).toEqual([])
    expect(mockedExec).not.toHaveBeenCalled()
  })

  test('copies files into a staging dir and pushes with matching --only flags', async () => {
    mockedExec.mockResolvedValue(0)
    writeJson('locales/en.default.json', {greeting: 'hello'})
    const filePath = path.join(tmpDir, 'locales/en.default.json')

    const result = await sendFilesWithPathToShopify([filePath], {
      targetThemeId: '123',
      store: 'test-store.myshopify.com'
    })

    expect(result).toEqual([filePath])
    expect(exists('remote/new/locales/en.default.json')).toBe(true)
    expect(mockedExec).toHaveBeenCalledTimes(1)

    const [command] = mockedExec.mock.calls[0]
    expect(command).toContain('--only=locales/en.default.json')
    expect(command).toContain('--theme 123')
    expect(command).toContain('--store test-store.myshopify.com')
    expect(command).toContain('--path remote/new')
    expect(command).toContain('--nodelete')
  })
})

describe('cleanRemoteFiles', () => {
  test('does nothing when the remote directory does not exist', async () => {
    await expect(cleanRemoteFiles()).resolves.toBeUndefined()
  })

  test('removes the remote directory when it exists', async () => {
    writeJson('remote/locales/en.default.json', {greeting: 'hello'})
    expect(exists('remote')).toBe(true)

    await cleanRemoteFiles()

    expect(exists('remote')).toBe(false)
  })
})
