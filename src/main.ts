import * as core from '@actions/core'
import {
  EXEC_OPTIONS,
  cleanRemoteFiles,
  getNewTemplatesToRemote,
  sendFilesWithPathToShopify,
  syncLocaleAndSettingsJSON
} from './utils'
import {exec} from '@actions/exec'
import {mkdirP} from '@actions/io'
import {debug} from '@actions/core'

async function run(): Promise<void> {
  try {
    const store: string = core.getInput('store')

    // TARGET THEME: This is the destination theme that will RECEIVE the synced JSON files
    // All processed locale and template JSON files will be pushed TO this theme
    const targetThemeId: string = core.getInput('theme')

    // SOURCE THEME: This is the theme we pull/sync JSON files FROM
    // If not specified, we'll use the live theme as the source
    const sourceThemeId: string = core.getInput('source-theme')

    const workingDirectory: string = core.getInput('working-directory', {
      trimWhitespace: true
    })

    if (!!workingDirectory && workingDirectory !== '') {
      debug(`Changing working directory to ${workingDirectory}`)
      process.chdir(workingDirectory)
    }

    await cleanRemoteFiles()
    // `shopify theme pull --path remote` requires the target directory to
    // already exist - it does not create it itself.
    await mkdirP('remote')

    // Determine source: use source-theme if provided, otherwise use live theme
    // This controls WHERE we pull the JSON files FROM
    const themeFlag = sourceThemeId ? `--theme ${sourceThemeId}` : '--live'
    const syncThemeInfo = sourceThemeId
      ? `theme ${sourceThemeId}`
      : 'live theme'

    debug(
      `Syncing JSON files from ${syncThemeInfo} to target theme ${targetThemeId}`
    )

    // STEP 1: Pull JSON files FROM the source theme (or live theme)
    // Note: config/*_data.json (settings_data.json) is intentionally not pulled -
    // this action only syncs locales and templates, see README for details.
    //
    // IMPORTANT: `templates/**/*.json` alone does NOT match direct children of
    // templates/ in the Shopify CLI's own --only glob matching (confirmed via
    // CI logs: "Ignoring theme file templates/index.json via --only..." for
    // every top-level template). Without `templates/*.json` too, every
    // existing top-level template (index.json, product.json, cart.json, etc.)
    // is silently excluded from the pull, which then makes
    // getNewTemplatesToRemote() wrongly think they don't exist remotely and
    // force-pushes the local repo's version over the real content on the
    // target theme. Only genuinely nested templates (e.g.
    // templates/metaobject/promotions.json) were ever matched by `**` alone.
    await exec(
      `shopify theme pull --only templates/*.json --only templates/**/*.json --only locales/*.json ${themeFlag} --path remote --store ${store} --verbose`,
      [],
      EXEC_OPTIONS
    )

    // STEP 2: Process and prepare the JSON files for syncing
    const localeFilesToPush = await syncLocaleAndSettingsJSON()
    const newTemplatesToPush = await getNewTemplatesToRemote()

    // STEP 3: Push the processed JSON files TO the target theme
    await sendFilesWithPathToShopify(
      [...localeFilesToPush, ...newTemplatesToPush],
      {
        targetThemeId,
        store
      }
    )
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  } finally {
    await cleanRemoteFiles()
  }
}

run()
