/**
 * Install dsh-session-groups into a DSH profile (default: the desktop profile).
 *
 * Usage:
 *   node tools/install-profile.mjs [--profile-name desktop] [--dry-run]
 *
 * It links this package into <profile>/node_modules and registers it in
 * package.json (dsh.profile.bundles + dependencies["link:..."]). Existing
 * package.json is backed up as package.json.bak-dsg-session-groups.
 *
 * Run this with a shell that is allowed to write outside the workspace
 * (the profile lives in $DSH_HOME, not in the workspace).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-session-groups'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_DIR = path.resolve(HERE, '..')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const profileName = (() => {
  const index = args.indexOf('--profile-name')
  if (index >= 0 && args[index + 1]) return args[index + 1]
  return process.env.DSH_PROFILE || 'desktop'
})()

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = process.env.DSH_PROFILE_DIR || path.join(dshHome, 'profiles', profileName)
const manifestPath = path.join(profileDir, 'package.json')
const nodeModules = path.join(profileDir, 'node_modules')
const linkPath = path.join(nodeModules, PACKAGE_NAME)

function fail(message) {
  console.error('[dsh-session-groups] ERROR: ' + message)
  process.exit(1)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`cannot read JSON at ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------------------------------------------------------------- validate

const sourceManifestPath = path.join(SOURCE_DIR, 'package.json')
if (!fs.existsSync(sourceManifestPath)) fail(`source package.json not found at ${sourceManifestPath}`)
const sourceManifest = readJson(sourceManifestPath)
if (sourceManifest.name !== PACKAGE_NAME) fail(`source package name is ${sourceManifest.name}, expected ${PACKAGE_NAME}`)
if (!fs.existsSync(path.join(SOURCE_DIR, 'lib', 'index.js'))) fail('lib/index.js missing in source package')
if (!fs.existsSync(path.join(SOURCE_DIR, 'client', 'client.js'))) fail('client/client.js missing in source package')
if (!fs.existsSync(manifestPath)) fail(`profile manifest not found at ${manifestPath}`)
if (!fs.existsSync(nodeModules)) fail(`profile node_modules not found at ${nodeModules}`)

console.log(`[dsh-session-groups] profile: ${profileDir}`)
console.log(`[dsh-session-groups] source : ${SOURCE_DIR}`)

// ------------------------------------------------------------------- link

let linkState = 'create'
if (fs.existsSync(linkPath)) {
  let stat = null
  try {
    stat = fs.lstatSync(linkPath)
  } catch {
    stat = null
  }
  let resolved = null
  try {
    resolved = fs.realpathSync(linkPath)
  } catch {
    resolved = null
  }
  if (stat && (stat.isSymbolicLink() || (stat.isDirectory() && resolved === null))) {
    // A link/junction; make sure it points at this checkout.
    if (resolved && path.resolve(resolved) !== path.resolve(SOURCE_DIR)) {
      fail(`existing link ${linkPath} points at ${resolved}, not ${SOURCE_DIR}; refusing to replace it`)
    }
    linkState = 'existing'
  } else if (stat && stat.isDirectory() && fs.existsSync(path.join(linkPath, 'package.json'))) {
    const installed = readJson(path.join(linkPath, 'package.json'))
    if (installed.name !== PACKAGE_NAME) fail(`existing directory ${linkPath} is not ${PACKAGE_NAME}`)
    linkState = 'copied'
  } else {
    fail(`existing path ${linkPath} is neither a junction nor the plugin; refusing to overwrite it`)
  }
}

console.log(`[dsh-session-groups] link  : ${linkPath} (${linkState})`)

// --------------------------------------------------------------- manifest

const manifest = readJson(manifestPath)
manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
const nextBundles = bundles.includes(PACKAGE_NAME) ? bundles.slice() : [...bundles, PACKAGE_NAME]
manifest.dependencies = manifest.dependencies || {}
const linkSpec = 'link:' + SOURCE_DIR
const dependencyChanged = manifest.dependencies[PACKAGE_NAME] !== linkSpec
manifest.dependencies[PACKAGE_NAME] = linkSpec

if (dryRun) {
  console.log('[dsh-session-groups] dry run: would update bundles ->', JSON.stringify(nextBundles))
  console.log('[dsh-session-groups] dry run: would set dependency to', linkSpec)
  process.exit(0)
}

// ------------------------------------------------------------------ write

const backupPath = manifestPath + '.bak-dsg-session-groups'
if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(manifestPath, backupPath)
  console.log(`[dsh-session-groups] backup: ${backupPath}`)
}

if (linkState === 'create') {
  fs.symlinkSync(SOURCE_DIR, linkPath, 'junction')
  console.log('[dsh-session-groups] created directory junction')
} else if (linkState === 'copied') {
  console.warn('[dsh-session-groups] WARNING: installed copy is a real directory; update it manually after changing sources')
}

manifest.dsh.profile.bundles = nextBundles
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log('[dsh-session-groups] bundles ->', JSON.stringify(nextBundles))
console.log('[dsh-session-groups] dependency ->', linkSpec, dependencyChanged ? '(updated)' : '(unchanged)')
console.log('')
console.log('Done. Fully quit and restart DeepSeek Harness so the new profile bundle is composed.')
console.log(`After restart, check ${path.join(dshHome, 'session-groups.log')} for an "apply" line.`)
