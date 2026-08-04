import {create} from '@actions/glob'
import {mkdir, readFile, writeFile} from 'fs/promises'
import {existsSync} from 'fs'
import {dirname} from 'path'
import deepmerge from 'deepmerge'
import {rmRF} from '@actions/io'
import {exec} from '@actions/exec'
import {copySync} from 'fs-extra'
import {debug, error as errorLog} from '@actions/core'
import {
  ShopifySettingsOrTemplateJSON,
  ISyncLocalJSONWithRemoteJSONForStore
} from './types.d'

export const EXEC_OPTIONS = {
  listeners: {
    stdout: (data: Buffer) => {
      debug(data.toString())
    },
    stderr: (data: Buffer) => {
      errorLog(data.toString())
    }
  }
}

export const fetchFiles = async (pattern: string): Promise<string[]> => {
  const globber = await create(pattern)
  const files = await globber.glob()
  return files
}

const fetchLocalFileForRemoteFile = async (
  remoteFile: string
): Promise<string> => {
  return remoteFile.replace('remote/', '')
}

// Shopify prepends auto-generated locale/template files with a block comment like:
// /*
// * ------------------------------------------------------------
// * IMPORTANT: The contents of this file are auto-generated.
// *
// * This file may be updated by the Shopify admin language editor
// * or related systems. Please exercise caution as any changes
// * made to this file may be overwritten.
// * ------------------------------------------------------------
// */
// which is not valid JSON, so it must be stripped before parsing.
const cleanJSONStringofShopifyComment = (
  jsonString: string
): ShopifySettingsOrTemplateJSON => {
  const withoutComment = jsonString.replace(/\/\*.*?\*\//s, '').trim()
  return JSON.parse(withoutComment)
}

export const readJsonFile = async (
  file: string
): Promise<ShopifySettingsOrTemplateJSON> => {
  if (!existsSync(file)) {
    return {} // Return empty object if file doesn't exist
  }
  const buffer = await readFile(file)
  return cleanJSONStringofShopifyComment(buffer.toString())
}

export const cleanRemoteFiles = async (): Promise<void> => {
  const remoteDir = 'remote'

  if (!existsSync(remoteDir)) {
    debug(`Skipping cleanRemoteFiles: ${remoteDir} directory not found`)
    return
  }

  try {
    await rmRF(remoteDir)
  } catch (error) {
    if (error instanceof Error) debug(error.message)
  }
}

export const sendFilesWithPathToShopify = async (
  files: string[],
  {targetThemeId, store}: ISyncLocalJSONWithRemoteJSONForStore
): Promise<string[]> => {
  if (files.length === 0) {
    debug('No files to push to Shopify, skipping push')
    return files
  }

  for (const file of files) {
    debug(`Pushing ${file} to Shopify`)
  }
  const pushOnlyCommand = files
    .map(
      file =>
        `--only=${file.replace('./', '').replace(`${process.cwd()}/`, '')}`
    )
    .join(' ')
  debug(`Push Only Command: ${pushOnlyCommand}`)
  for (const file of files) {
    const baseFile = file.replace(process.cwd(), '')
    const destination = `${process.cwd()}/remote/new/${baseFile}`
    debug(`Copying ${file} to ${destination}`)
    copySync(file, destination, {
      overwrite: true
    })
  }

  await exec(
    `shopify theme ${[
      'push',
      pushOnlyCommand,
      '--theme',
      targetThemeId,
      '--store',
      store,
      '--verbose',
      '--path',
      'remote/new',
      '--nodelete'
    ].join(' ')}`,
    [],
    EXEC_OPTIONS
  )

  return files
}

// Go through all keys in the object and if a key's value has disabled: true, remove it from the object
export const removeDisabledKeys = (
  obj: ShopifySettingsOrTemplateJSON
): ShopifySettingsOrTemplateJSON => {
  const newObj = {...obj}
  for (const key in obj) {
    const value = newObj[key] as {disabled?: boolean} | undefined
    if (value?.disabled === true) {
      delete newObj[key]
    }
  }
  return newObj
}

export const syncLocaleAndSettingsJSON = async (): Promise<string[]> => {
  const remoteFiles = await fetchFiles(['./remote/locales/*.json'].join('\n'))

  for (const remoteFile of remoteFiles) {
    debug(`Remote File: ${remoteFile}`)
  }
  const localFilesToPush: string[] = []
  for (const file of remoteFiles) {
    try {
      // Read JSON for Remote File
      const remoteFile = await readJsonFile(file)
      debug(`Remote File: ${file}`)

      // Get Local Version of File Path
      const localFileRef = await fetchLocalFileForRemoteFile(file)
      debug(`Local File Ref: ${localFileRef}`)
      // Read JSON for Local File
      const localFile = await readJsonFile(localFileRef)

      // Merge Local and Remote Files with Remote as Primary
      const mergeOptions: deepmerge.Options = {
        arrayMerge: (_, sourceArray) => sourceArray,
        customMerge: key => {
          if (key === 'blocks') {
            // Merge both sides' blocks together (remote wins on conflicts,
            // same as the rest of the file) before stripping disabled ones -
            // previously this returned newBlock alone, which silently
            // dropped any block that only existed locally (e.g. a new
            // block's schema translations added in code but not yet
            // present on the source theme).
            return (
              localBlocks: ShopifySettingsOrTemplateJSON,
              remoteBlocks: ShopifySettingsOrTemplateJSON
            ) => {
              const mergedBlocks = deepmerge<ShopifySettingsOrTemplateJSON>(
                localBlocks,
                remoteBlocks,
                mergeOptions
              )
              return removeDisabledKeys(mergedBlocks)
            }
          }
        }
      }
      const mergedFile = deepmerge(localFile, remoteFile, mergeOptions)

      // Write Merged File to Local File (parent dir may not exist yet for a
      // locale file that's new to the local repo, e.g. a language just added
      // on the live theme)
      await mkdir(dirname(localFileRef), {recursive: true})
      await writeFile(localFileRef, JSON.stringify(mergedFile, null, 2))
      localFilesToPush.push(localFileRef)
    } catch (error) {
      if (error instanceof Error) {
        debug('Error in syncLocaleAndSettingsJSON')
        debug(error.message)
      }
      continue
    }
  }

  return localFilesToPush
}

export const getNewTemplatesToRemote = async (): Promise<string[]> => {
  const remoteTemplateFilesNames = (
    (await fetchFiles('./remote/templates/**/*.json')) || []
  ).map(file => file.replace('remote/', ''))

  const localTemplateFiles = await fetchFiles('./templates/**/*.json')
  const localeFilesToMove = localTemplateFiles.filter(
    file => !remoteTemplateFilesNames.includes(file)
  )

  return localeFilesToMove
}
