/**
 * Uninstall dsh-session-groups from a DSH profile.
 *
 * Usage:
 *   node tools/uninstall-profile.mjs [--profile-name desktop] [--dry-run]
 *
 * Removes the node_modules junction and the package.json registration; keeps
 * the user's group data ($DSH_HOME/session-groups.json) unless --purge is given.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PACKAGE_NAME = 'dsh-session-groups'
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const purge = args.includes('--purge')
const profileName = (() => {
  const index = args.indexOf('--profile-name')
  if (index >= 0 && args[index + 1]) return args[index + 1]
  return process.env.DSH_PROFILE || 'desktop'
})()

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = process.env.DSH_PROFILE_DIR || path.join(dshHome, 'profiles', profileName)
const manifestPath = path.join(profileDir, 'package.json')
const linkPath = path.join(profileDir, 'node_modules', PACKAGE_NAME)
const statePath = path.join(dshHome, 'session-groups.json')
const logPath = path.join(dshHome, 'session-groups.log')

function fail(message) {
  console.error('[dsh-session-groups] ERROR: ' + message)
  process.exit(1)
}

if (!fs.existsSync(manifestPath)) fail(`profile manifest not found at ${manifestPath}`)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
const nextBundles = bundles.filter((name) => name !== PACKAGE_NAME)
const nextDependencies = { ...(manifest.dependencies || {}) }
delete nextDependencies[PACKAGE_NAME]

console.log(`[dsh-session-groups] profile: ${profileDir}`)
console.log(`[dsh-session-groups] bundles: ${JSON.stringify(bundles)} -> ${JSON.stringify(nextBundles)}`)

if (dryRun) {
  console.log('[dsh-session-groups] dry run: no changes written')
  process.exit(0)
}

if (nextBundles.length !== bundles.length) manifest.dsh.profile.bundles = nextBundles
manifest.dependencies = nextDependencies
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log('[dsh-session-groups] profile manifest updated')

if (fs.existsSync(linkPath)) {
  const stat = fs.lstatSync(linkPath)
  if (stat.isSymbolicLink() || stat.isDirectory()) {
    fs.rmSync(linkPath, { recursive: true, force: true })
    console.log('[dsh-session-groups] removed', linkPath)
  } else {
    console.warn('[dsh-session-groups] WARNING: leaving unexpected file at', linkPath)
  }
} else {
  console.log('[dsh-session-groups] no junction to remove')
}

if (purge) {
  for (const file of [statePath, logPath]) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      console.log('[dsh-session-groups] removed', file)
    }
  }
} else {
  console.log('[dsh-session-groups] kept user data:', statePath, '(pass --purge to remove)')
}

console.log('')
console.log('Restart DeepSeek Harness to unload the plugin.')
