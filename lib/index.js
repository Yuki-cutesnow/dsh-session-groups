/**
 * dsh-session-groups — host half.
 *
 * Surface-only session grouping for the DSH sidebar. The host registry (session
 * membership of workspaces, archive state) is never modified: this plugin only
 * stores its own grouping file under $DSH_HOME and serves a small browser script
 * that renders a "分组" section next to the built-in workspace list.
 *
 * Injection contract (see dsh-host-webserver / dsh-desktop-host):
 *  - desktop (Electron): `webserver/index-inject` rows are the only channel; the
 *    row table is collected once at host startup, so the row is registered as the
 *    very first thing in apply() (no object-level `inject`, which would defer it).
 *  - web deployment: `webServer.tapIndex()` adds the same tags to each index HTML.
 *  - we push an inline `script` row (never `script-src`) on purpose: a failed
 *    `script-src` load rejects `__DSH_BOOT_READY__` and the app would not start.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const LOG_FILE = path.join(DSH_HOME, 'session-groups.log')
const STATE_FILE = path.join(DSH_HOME, 'session-groups.json')
const WORKSPACE_STORE = path.join(DSH_HOME, 'storages', 'workspace.json')

const BASE = '/dsh-session-groups'
const CLIENT_JS = path.join(PACKAGE_ROOT, 'client', 'client.js')
const CLIENT_CSS = path.join(PACKAGE_ROOT, 'client', 'client.css')
const PLUGIN_VERSION = '0.7.0'

const LOG_MAX_BYTES = 512 * 1024
const BODY_MAX_BYTES = 256 * 1024

// ---------------------------------------------------------------- diagnostics

function log(...parts) {
  try {
    fs.mkdirSync(DSH_HOME, { recursive: true })
    try {
      const st = fs.statSync(LOG_FILE)
      if (st.size > LOG_MAX_BYTES) fs.writeFileSync(LOG_FILE, '')
    } catch {}
    const line = `[${new Date().toISOString()}] ${parts.map(String).join(' ')}\n`
    fs.appendFileSync(LOG_FILE, line)
  } catch {}
}

// ------------------------------------------------------------------ state I/O

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Atomic writes normally rename their temp file away immediately. Only a hard
 * crash inside that tiny window can leave a `session-groups.json.tmp-*` file
 * behind, so sweep old leftovers once per host start (a few KB at most, and it
 * can never grow: this is the only cleanup this plugin ever needs).
 */
function cleanupStaleTmpFiles() {
  const prefix = `${path.basename(STATE_FILE)}.tmp-`
  const cutoff = Date.now() - 10 * 60 * 1000
  try {
    for (const entry of fs.readdirSync(DSH_HOME)) {
      if (!entry.startsWith(prefix)) continue
      const file = path.join(DSH_HOME, entry)
      try {
        const stat = fs.statSync(file)
        if (stat.isFile() && stat.mtimeMs < cutoff) fs.rmSync(file, { force: true })
      } catch {}
    }
  } catch {}
}

function normalizeSessionEntry(entry) {
  if (typeof entry === 'string') {
    const id = entry.trim()
    return id && id.length <= 128 ? { id } : null
  }
  if (!entry || typeof entry !== 'object') return null
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (!id || id.length > 128) return null
  const out = { id }
  if (typeof entry.title === 'string' && entry.title.trim()) out.title = entry.title.trim().slice(0, 200)
  if (typeof entry.workspace === 'string' && entry.workspace.trim()) out.workspace = entry.workspace.trim().slice(0, 120)
  return out
}

function sanitizeState(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const seen = new Set()
  const groups = []
  const rawGroups = Array.isArray(raw.groups) ? raw.groups.slice(0, 200) : []
  for (const group of rawGroups) {
    if (!group || typeof group !== 'object') continue
    const id =
      typeof group.id === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(group.id)
        ? group.id
        : `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const name =
      (typeof group.name === 'string' ? group.name.replace(/\s+/g, ' ').trim().slice(0, 60) : '') || '未命名分组'
    const parentId =
      typeof group.parentId === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(group.parentId) ? group.parentId : ''
    const sessions = []
    const rawSessions = Array.isArray(group.sessions) ? group.sessions.slice(0, 500) : []
    for (const entry of rawSessions) {
      const session = normalizeSessionEntry(entry)
      if (!session || seen.has(session.id)) continue
      seen.add(session.id)
      sessions.push(session)
    }
    groups.push({ id, name, collapsed: group.collapsed === true, parentId, sessions })
  }
  // Resolve nesting: unknown / self / cyclic parents collapse to top level.
  const byId = new Map(groups.map((group) => [group.id, group]))
  for (const group of groups) {
    if (!group.parentId || !byId.has(group.parentId) || group.parentId === group.id) {
      group.parentId = ''
      continue
    }
    let cursor = byId.get(group.parentId)
    let guard = 0
    let cyclic = false
    while (cursor && guard <= groups.length) {
      if (cursor.id === group.id) {
        cyclic = true
        break
      }
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
      guard += 1
    }
    if (cyclic) group.parentId = ''
  }
  const panelHeightRaw =
    typeof raw.panelHeight === 'number' && Number.isFinite(raw.panelHeight) ? Math.round(raw.panelHeight) : 0
  return {
    version: 2,
    sectionCollapsed: raw.sectionCollapsed === true,
    panelHeight: Math.max(0, Math.min(1200, panelHeightRaw)),
    groups,
  }
}

function loadState() {
  const raw = readJson(STATE_FILE, null)
  if (!raw) return sanitizeState({ groups: [] })
  return sanitizeState(raw)
}

function saveState(state) {
  writeFileAtomic(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
  return state
}

function workspaceSnapshot() {
  const out = { workspaces: [], archived: [] }
  try {
    const data = readJson(WORKSPACE_STORE, null)
    if (!data || typeof data !== 'object') return out
    const global = data.global && typeof data.global === 'object' ? data.global : {}
    if (Array.isArray(global.archivedSessionIds)) {
      out.archived = global.archivedSessionIds.filter((id) => typeof id === 'string')
    }
    const table = (data.tables && data.tables.workspaces) || {}
    const order = Array.isArray(global.workspaceIds) ? global.workspaceIds : Object.keys(table)
    for (const workspaceId of order) {
      const record = table[workspaceId]
      if (!record || typeof record !== 'object') continue
      const dir = typeof record.path === 'string' ? record.path : ''
      const title =
        (typeof record.title === 'string' && record.title.trim()) ||
        (dir ? path.basename(dir) : '') ||
        String(workspaceId)
      out.workspaces.push({
        id: String(workspaceId),
        title: title.slice(0, 120),
        path: dir,
        sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds.filter((id) => typeof id === 'string') : [],
      })
    }
  } catch (err) {
    log('workspace snapshot failed:', err && err.message ? err.message : err)
  }
  return out
}

// ---------------------------------------------------------------- http guards

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase()
  if (value === '::1') return true
  if (value.startsWith('::ffff:')) return isLoopbackAddress(value.slice(7))
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!value) return false
  if (value === 'localhost' || value === '::1') return true
  if (value.endsWith('.localhost')) return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}

/** Returns 0 when the request may proceed, or the HTTP status to reject with. */
function rejectionStatus(req) {
  try {
    const address = req.socket && req.socket.remoteAddress
    if (!isLoopbackAddress(address)) return 403
    const headers = req.headers || {}
    const host = String(headers.host || '')
    let hostUrl
    try {
      hostUrl = new URL(`http://${host}`)
    } catch {
      return 403
    }
    if (!isLoopbackHostname(hostUrl.hostname)) return 403
    const origin = headers.origin
    if (origin) {
      let originUrl
      try {
        originUrl = new URL(String(origin))
      } catch {
        return 403
      }
      if (originUrl.host !== hostUrl.host) return 403
    }
    if (String(headers['sec-fetch-site'] || '') === 'cross-site') return 403
    return 0
  } catch {
    return 403
  }
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
  res.end(text)
}

function sendJson(res, status, value) {
  sendText(res, status, JSON.stringify(value), 'application/json; charset=utf-8')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ handlers

async function handleClientJs(req, res) {
  const denied = rejectionStatus(req)
  if (denied) return sendText(res, denied, 'forbidden')
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed')
  const text = readTextFile(CLIENT_JS)
  if (text === null) return sendText(res, 404, 'client script not found')
  log('served client.js')
  sendText(res, 200, text, 'application/javascript; charset=utf-8')
}

/**
 * Diagnostic sink for the browser half: POST {level, message} is appended to
 * the host log. This is how DOM/layout problems can be debugged from the log
 * file without opening devtools (the plugin's sidebar section is injected DOM,
 * so its failures are otherwise invisible).
 */
async function handleLog(req, res) {
  const denied = rejectionStatus(req)
  if (denied) return sendText(res, denied, 'forbidden')
  if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
    return sendText(res, 415, 'content-type must be application/json')
  }
  let body
  try {
    body = await readBody(req)
  } catch {
    return sendText(res, 413, 'request body too large')
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return sendText(res, 400, 'invalid JSON body')
  }
  const level = parsed && typeof parsed.level === 'string' ? parsed.level.slice(0, 16) : 'info'
  const message = parsed && typeof parsed.message === 'string' ? parsed.message.slice(0, 4000) : ''
  if (message) log(`[client:${level}]`, message)
  sendJson(res, 200, { ok: true })
}

async function handleClientCss(req, res) {
  const denied = rejectionStatus(req)
  if (denied) return sendText(res, denied, 'forbidden')
  const text = readTextFile(CLIENT_CSS)
  if (text === null) return sendText(res, 404, 'client stylesheet not found')
  sendText(res, 200, text, 'text/css; charset=utf-8')
}

async function handleState(req, res) {
  const denied = rejectionStatus(req)
  if (denied) return sendText(res, denied, 'forbidden')

  if (req.method === 'GET' || req.method === 'HEAD') {
    const state = loadState()
    log('GET /api/state')
    sendJson(res, 200, { ...state, ...workspaceSnapshot(), pluginVersion: PLUGIN_VERSION })
    return
  }

  if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
    return sendText(res, 415, 'content-type must be application/json')
  }
  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return sendText(res, 413, 'request body too large')
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return sendText(res, 400, 'invalid JSON body')
  }
  try {
    const saved = saveState(sanitizeState(parsed))
    log('state saved:', saved.groups.length, 'groups,', saved.groups.reduce((sum, g) => sum + g.sessions.length, 0), 'sessions')
    sendJson(res, 200, { ...saved, ...workspaceSnapshot(), pluginVersion: PLUGIN_VERSION })
  } catch (err) {
    log('state save failed:', err && err.message ? err.message : err)
    sendText(res, 500, 'failed to save state')
  }
}

// -------------------------------------------------------------- index inject

function fileVersion(file) {
  try {
    const st = fs.statSync(file)
    return `${Math.round(st.mtimeMs).toString(36)}-${st.size.toString(36)}`
  } catch {
    return '0'
  }
}

function versionSnapshot() {
  return { js: fileVersion(CLIENT_JS), css: fileVersion(CLIENT_CSS), pluginVersion: PLUGIN_VERSION }
}

/**
 * Default loader: fetch the browser half exactly once, no polling. A packaged
 * Electron window cannot reload its injected script anyway, so a timer would
 * cost a request loop with no benefit for end users.
 */
const STATIC_LOADER_TEXT = (() => {
  const parts = [
    '(function(){try{',
    `var BASE="${BASE}";`,
    'var JS_ID="dsh-session-groups-client";',
    'if(document.getElementById(JS_ID))return;',
    'var s=document.createElement("script");s.id=JS_ID;',
    's.src=BASE+"/client.js";s.onerror=function(){};',
    '(document.body||document.head||document.documentElement).appendChild(s)',
    '}catch(e){}})()',
  ]
  return parts.join('')
})()

/**
 * Development-only loader (opt-in): polls /api/version every 5s and hot-swaps
 * client.js in place, so UI iterations do not need a full app restart.
 *
 * It is enabled only while `$DSH_HOME/session-groups.dev` exists; the marker is
 * checked when the host collects its injection rows (i.e. at app start), so
 * delete it and restart to return to the zero-request default. The old browser
 * instance is asked to dispose itself first (it exposes
 * `window.__DSH_SESSION_GROUPS_DISPOSE__`).
 */
const HOT_LOADER_TEXT = (() => {
  const parts = [
    '(function(){try{',
    'if(window.__DSH_SESSION_GROUPS_LOADER__)return;',
    'window.__DSH_SESSION_GROUPS_LOADER__=true;',
    `var BASE="${BASE}";`,
    'var CSS_ID="dsh-session-groups-css";',
    'var JS_ID="dsh-session-groups-client";',
    'var current="";',
    'function ensureCss(hash){try{if(!hash)return;',
    'var href=BASE+"/client.css?v="+encodeURIComponent(hash);',
    'var link=document.getElementById(CSS_ID);',
    'if(!link){link=document.createElement("link");link.id=CSS_ID;link.rel="stylesheet";(document.head||document.documentElement).appendChild(link)}',
    'if(link.getAttribute("href")!==href)link.setAttribute("href",href)}catch(e){}}',
    'function loadJs(hash){try{',
    'if(typeof window.__DSH_SESSION_GROUPS_DISPOSE__==="function"){try{window.__DSH_SESSION_GROUPS_DISPOSE__()}catch(e){}}',
    'window.__DSH_SESSION_GROUPS_DISPOSE__=null;',
    'window.__DSH_SESSION_GROUPS_VERSION__=hash||"";',
    'window.__DSH_SESSION_GROUPS_LOADED__=false;',
    'var old=document.getElementById(JS_ID);if(old)old.remove();',
    'var s=document.createElement("script");s.id=JS_ID;',
    's.src=BASE+"/client.js?v="+encodeURIComponent(hash||String(Date.now()));',
    's.onerror=function(){window.__DSH_SESSION_GROUPS_LOADED__=false;current="";try{s.remove()}catch(e){}};',
    '(document.body||document.head||document.documentElement).appendChild(s)}catch(e){}}',
    'function poll(){try{',
    'fetch(BASE+"/api/version",{cache:"no-store",credentials:"same-origin"})',
    '.then(function(r){return r.json()})',
    '.then(function(v){if(!v)return;ensureCss(v.css);',
    'if(!current){current=v.js||"0";loadJs(current);return}',
    'if(v.js&&v.js!==current){current=v.js;loadJs(current)}})',
    '.catch(function(){})}catch(e){}}',
    'function boot(){poll();setInterval(poll,5000)}',
    'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",boot,{once:true})}else{boot()}',
    '}catch(e){}})()',
  ]
  return parts.join('')
})()

const DEV_FLAG_FILE = path.join(DSH_HOME, 'session-groups.dev')

function hotReloadEnabled() {
  try {
    return fs.existsSync(DEV_FLAG_FILE)
  } catch {
    return false
  }
}

function loadClientCssText() {
  return readTextFile(CLIENT_CSS) || ''
}

function indexInjectRow(table) {
  try {
    if (!Array.isArray(table)) return
    const already = table.some(
      (row) =>
        row &&
        row.kind === 'script' &&
        typeof row.text === 'string' &&
        row.text.indexOf('dsh-session-groups-client') !== -1,
    )
    if (already) return
    const hot = hotReloadEnabled()
    const css = loadClientCssText()
    if (css) table.push({ kind: 'style', text: css })
    table.push({ kind: 'script', placement: 'body', text: hot ? HOT_LOADER_TEXT : STATIC_LOADER_TEXT })
    log('index-inject: rows pushed (style:', css ? 'yes' : 'no', '| hot reload:', hot ? 'on' : 'off', ')')
  } catch (err) {
    log('index-inject failed:', err && err.message ? err.message : err)
  }
}

function tapIndex(html) {
  try {
    if (typeof html !== 'string') return html
    // The JS itself comes from the injected loader row (which is version aware);
    // only the stylesheet is added here so first paint is already themed.
    if (html.indexOf(`${BASE}/client.css`) !== -1) return html
    const tags = `<link rel="stylesheet" href="${BASE}/client.css">`
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', `${tags}</body>`)
    return html + tags
  } catch {
    return html
  }
}

async function handleVersion(req, res) {
  const denied = rejectionStatus(req)
  if (denied) return sendText(res, denied, 'forbidden')
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed')
  sendJson(res, 200, versionSnapshot())
}

// ---------------------------------------------------------------- the plugin

export default {
  name: 'dsh-session-groups',

  apply(root) {
    cleanupStaleTmpFiles()
    log(`apply v${PLUGIN_VERSION}: dsh home =`, DSH_HOME)
    log('loader mode =', hotReloadEnabled() ? 'hot reload (dev marker present)' : 'static (no polling)')
    log(
      'state file =',
      STATE_FILE,
      '| workspace store =',
      WORKSPACE_STORE,
      '| workspace store present =',
      (() => {
        try {
          fs.accessSync(WORKSPACE_STORE)
          return 'yes'
        } catch {
          return 'no'
        }
      })(),
    )

    // 1) Injection rows first: the desktop host collects the table once at
    //    startup, so registering inside the webServer inject below would miss it.
    try {
      const disposer = root.on('webserver/index-inject', indexInjectRow)
      if (typeof disposer === 'function') root.effect(() => disposer)
    } catch (err) {
      log('index-inject subscription failed:', err && err.message ? err.message : err)
    }

    // 2) Routes once the web server exists. Waiting locally (not via an
    //    object-level inject) keeps step 1 from being deferred.
    root.inject(['webServer'], (ctx) => {
      // HMR re-runs apply() when this file changes while the same web server is
      // still alive. Keep the first registration (the handlers read state and
      // assets from disk on every request, so they stay current) and do not let
      // a disposed older instance tear the routes down below the live UI.
      const slot = (globalThis.__DSH_SESSION_GROUPS_ROUTES__ ||= { server: null, disposers: [] })
      if (slot.server === ctx.webServer) {
        log('routes already registered on this web server; reusing existing handlers')
        return
      }
      try {
        const disposers = []
        const register = (route) => {
          const disposer = ctx.webServer.register(route)
          disposers.push(disposer)
          return disposer
        }
        register({ kind: 'exact', path: `${BASE}/client.js`, handler: handleClientJs })
        register({ kind: 'exact', path: `${BASE}/client.css`, handler: handleClientCss })
        register({ kind: 'exact', path: `${BASE}/api/state`, handler: handleState })
        register({ kind: 'exact', path: `${BASE}/api/log`, handler: handleLog })
        register({ kind: 'exact', path: `${BASE}/api/version`, handler: handleVersion })
        if (typeof ctx.webServer.tapIndex === 'function') {
          disposers.push(ctx.webServer.tapIndex(tapIndex))
        }
        slot.server = ctx.webServer
        slot.disposers = disposers
        log('routes registered under', BASE)
      } catch (err) {
        log('route registration failed:', err && err.message ? err.message : err)
      }
    })
  },
}
