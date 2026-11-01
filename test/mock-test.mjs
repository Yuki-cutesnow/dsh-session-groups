/**
 * Offline smoke test for the host half of dsh-session-groups.
 *
 * Run with: node test/mock-test.mjs
 * It fakes the cordis root/webServer and exercises the HTTP handler + fences +
 * index-inject rows without booting the real DSH app.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-test-'))
process.env.DSH_HOME = tmpHome

// Seed a workspace store that looks like the real one.
const storeDir = path.join(tmpHome, 'storages')
fs.mkdirSync(storeDir, { recursive: true })
const workspaceStore = {
  version: 2,
  global: {
    initialized: true,
    workspaceIds: ['ws-1', 'ws-2'],
    archivedSessionIds: ['sess-old'],
    pinnedSessionIds: [],
  },
  tables: {
    workspaces: {
      'ws-1': {
        path: 'C:\\work\\aiworkspace',
        title: 'aiworkspace',
        sessionIds: ['sess-a', 'sess-b'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      'ws-2': {
        path: 'D:\\lab',
        title: 'lab',
        sessionIds: ['sess-c'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  },
}
fs.writeFileSync(path.join(storeDir, 'workspace.json'), JSON.stringify(workspaceStore, null, 2))

const { default: plugin } = await import('../lib/index.js')

// ------------------------------------------------------------------- mocks

function makeRoot() {
  const root = {
    listeners: {},
    injected: null,
    on(event, callback) {
      root.listeners[event] = callback
      return () => {
        delete root.listeners[event]
      }
    },
    inject(deps, callback) {
      root.injected = { deps, callback }
    },
    effect(execute) {
      return execute()
    },
  }
  return root
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers || {}
      return this
    },
    end(chunk) {
      this.body = chunk == null ? '' : String(chunk)
      return this
    },
  }
}

function makeReq({ method = 'GET', headers = {}, body } = {}) {
  const listeners = {}
  const req = {
    method,
    headers: Object.assign({ host: '127.0.0.1:55041' }, headers),
    socket: { remoteAddress: '127.0.0.1' },
    destroyed: false,
    on(event, callback) {
      ;(listeners[event] ||= []).push(callback)
      if (event === 'end' && body !== undefined) {
        process.nextTick(() => {
          for (const fn of listeners.data || []) fn(Buffer.from(body))
          for (const fn of listeners.end || []) fn()
        })
      }
      return req
    },
    destroy() {
      req.destroyed = true
    },
  }
  return req
}

async function call(handler, req, res) {
  await handler(req, res)
  return res
}

// ------------------------------------------------------------------- tests

const root = makeRoot()
plugin.apply(root)

assert.equal(typeof root.listeners['webserver/index-inject'], 'function', 'index-inject listener registered')
console.log('PASS index-inject listener registered before services')

const table = []
root.listeners['webserver/index-inject'](table)
assert.equal(table.length, 2, 'two rows pushed (style + script)')
assert.equal(table[0].kind, 'style')
assert.equal(table[1].kind, 'script')
assert.equal(table[1].placement, 'body')
assert.ok(table[1].text.includes('dsh-session-groups-client'), 'loader row loads the client script')
assert.ok(!table[1].text.includes('/api/version'), 'default loader does not poll (no recurring requests)')
assert.ok(!table[1].text.includes('setInterval'), 'default loader has no timer')
assert.ok(table[0].text.includes('.dsg-section'), 'style row carries the section css')
assert.doesNotThrow(() => new Function(table[1].text), 'default loader is valid JS')
const table2 = []
root.listeners['webserver/index-inject'](table2)
assert.equal(table2.length, 2)
const table3 = table.slice()
root.listeners['webserver/index-inject'](table3)
assert.equal(table3.length, 2, 'no duplicate rows')
console.log('PASS index-inject rows are complete, static and deduplicated')

// opt-in development mode: marker file switches the row to the polling loader
const devFlag = path.join(tmpHome, 'session-groups.dev')
fs.writeFileSync(devFlag, '')
const devTable = []
root.listeners['webserver/index-inject'](devTable)
assert.equal(devTable.length, 2)
assert.ok(devTable[1].text.includes('/api/version'), 'dev loader polls the version endpoint')
fs.rmSync(devFlag)
const staticTable = []
root.listeners['webserver/index-inject'](staticTable)
assert.equal(staticTable[1].text, table[1].text, 'removing the marker restores the static loader')
console.log('PASS hot reload is opt-in via session-groups.dev')

// dev loader: valid script, polls /api/version and swaps client.js in place
const loaderSource = devTable[1].text
assert.doesNotThrow(() => new Function(loaderSource), 'loader row is valid JS')
const created = []
function fakeEl(tag) {
  return {
    tagName: tag,
    attributes: {},
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    remove() {},
  }
}
const fakeDocument = {
  getElementById: () => null,
  createElement: (tag) => {
    const node = fakeEl(tag)
    created.push(node)
    return node
  },
  head: { appendChild(node) { created.push(node) } },
  body: { appendChild(node) { created.push(node) } },
  documentElement: { appendChild(node) { created.push(node) } },
}
let versionPayload = { js: 'js-1', css: 'css-1' }
let pollTimer = null
const sandbox = {
  window: {},
  document: fakeDocument,
  fetch: () => Promise.resolve({ json: () => Promise.resolve(versionPayload) }),
  setInterval: (fn) => {
    pollTimer = fn
    return 1
  },
}
vm.runInNewContext(loaderSource, sandbox)
await new Promise((resolve) => setTimeout(resolve, 0))
const firstScript = created.filter((node) => node.tagName === 'script').at(-1)
assert.ok(firstScript && String(firstScript.src).includes('/dsh-session-groups/client.js?v=js-1'), 'loader loads the current build')
const firstLink = created.find((node) => node.tagName === 'link')
assert.ok(firstLink && String(firstLink.attributes.href).includes('/client.css?v=css-1'), 'loader loads the current stylesheet')
versionPayload = { js: 'js-2', css: 'css-1' }
await pollTimer()
await new Promise((resolve) => setTimeout(resolve, 0))
const swappedScript = created.filter((node) => node.tagName === 'script').at(-1)
assert.ok(String(swappedScript.src).includes('client.js?v=js-2'), 'loader hot-swaps a changed client build')
assert.equal(sandbox.window.__DSH_SESSION_GROUPS_VERSION__, 'js-2')
console.log('PASS injected loader hot-swaps client.js without a page reload')

assert.ok(root.injected, 'webServer inject callback stored')
assert.deepEqual(root.injected.deps, ['webServer'])

const routes = new Map()
const taps = []
const ctx = {
  webServer: {
    register(route) {
      assert.ok(!routes.has(route.path), `duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    tapIndex(transform) {
      taps.push(transform)
      return () => {}
    },
  },
  effect(execute) {
    return execute()
  },
}
root.injected.callback(ctx)
assert.ok(routes.has('/dsh-session-groups/client.js'))
assert.ok(routes.has('/dsh-session-groups/client.css'))
assert.ok(routes.has('/dsh-session-groups/api/state'))
assert.ok(routes.has('/dsh-session-groups/api/log'))
assert.ok(routes.has('/dsh-session-groups/api/version'))
assert.equal(taps.length, 1)
console.log('PASS routes registered:', [...routes.keys()].join(', '))

const stateRoute = routes.get('/dsh-session-groups/api/state')

// version endpoint drives the in-page hot-swap loader
const versionRes = await call(routes.get('/dsh-session-groups/api/version').handler, makeReq(), makeRes())
assert.equal(versionRes.statusCode, 200)
const versionBody = JSON.parse(versionRes.body)
assert.equal(typeof versionBody.js, 'string')
assert.equal(typeof versionBody.css, 'string')
assert.notEqual(versionBody.js, '0')
assert.equal(versionBody.pluginVersion, '0.7.0')
console.log('PASS GET /api/version returns client asset versions')

// GET state
const getRes = await call(stateRoute.handler, makeReq(), makeRes())
assert.equal(getRes.statusCode, 200)
assert.match(getRes.headers['Content-Type'], /application\/json/)
const payload = JSON.parse(getRes.body)
assert.equal(payload.version, 2)
assert.deepEqual(payload.groups, [])
assert.deepEqual(
  payload.workspaces.map((ws) => ws.title),
  ['aiworkspace', 'lab'],
)
assert.deepEqual(payload.archived, ['sess-old'])
console.log('PASS GET /api/state returns groups + live workspace snapshot')

// POST valid state
const postRes = await call(
  stateRoute.handler,
  makeReq({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 2,
      sectionCollapsed: false,
      panelHeight: 260,
      groups: [
        {
          id: 'g1',
          name: '工程',
          collapsed: false,
          sessions: [
            { id: 'sess-a', title: 'A 会话', workspace: 'aiworkspace' },
            { id: 'sess-b' },
          ],
        },
        { id: 'g2', name: '杂项', parentId: 'g1', sessions: [{ id: 'sess-a' }, 'sess-c'] },
        { id: 'bad id!', name: '  空白   名字  ', parentId: 'no-such-group', sessions: ['sess-x', 'sess-x'] },
      ],
    }),
  }),
  makeRes(),
)
assert.equal(postRes.statusCode, 200)
const saved = JSON.parse(postRes.body)
assert.equal(saved.groups.length, 3)
assert.equal(saved.groups[0].name, '工程')
assert.deepEqual(saved.groups[0].sessions.map((s) => s.id), ['sess-a', 'sess-b'])
assert.equal(saved.groups[1].sessions.length, 1, 'duplicate session dropped from later group')
assert.equal(saved.groups[1].sessions[0].id, 'sess-c')
assert.equal(saved.groups[2].name, '空白 名字', 'whitespace collapsed')
assert.equal(saved.groups[2].sessions.length, 1, 'session ids deduped inside a group')
assert.equal(saved.panelHeight, 260, 'panel height persisted')
assert.equal(saved.groups[1].parentId, 'g1', 'nested group keeps its parent')
assert.equal(saved.groups[2].parentId, '', 'unknown parent collapses to top level')
const stateFile = path.join(tmpHome, 'session-groups.json')
assert.ok(fs.existsSync(stateFile), 'state file written')
const roundTrip = await call(stateRoute.handler, makeReq(), makeRes())
assert.equal(JSON.parse(roundTrip.body).groups.length, 3)
console.log('PASS POST /api/state sanitizes, dedupes and persists')

// cyclic parents must not trap the renderer: both collapse to top level
const cycleRes = await call(
  stateRoute.handler,
  makeReq({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 2,
      groups: [
        { id: 'c1', name: 'c1', parentId: 'c2' },
        { id: 'c2', name: 'c2', parentId: 'c1' },
      ],
    }),
  }),
  makeRes(),
)
const cycleSaved = JSON.parse(cycleRes.body)
assert.equal(cycleSaved.groups[0].parentId, '', 'cycle broken')
assert.equal(cycleSaved.groups[1].parentId, 'c1', 'the other link stays valid')
console.log('PASS nested groups / panel height / cycle guards')

// fences
const evilHost = await call(
  stateRoute.handler,
  makeReq({ headers: { host: 'evil.example.com' } }),
  makeRes(),
)
assert.equal(evilHost.statusCode, 403, 'non-loopback Host rejected')
const crossSite = await call(
  stateRoute.handler,
  makeReq({ method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' }),
  makeRes(),
)
assert.equal(crossSite.statusCode, 403, 'cross-site rejected')
const badOrigin = await call(
  stateRoute.handler,
  makeReq({ method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' }, body: '{}' }),
  makeRes(),
)
assert.equal(badOrigin.statusCode, 403, 'cross-origin rejected')
const remoteReq = makeReq({ method: 'GET' })
remoteReq.socket.remoteAddress = '192.168.1.20'
const remoteRes = await call(stateRoute.handler, remoteReq, makeRes())
assert.equal(remoteRes.statusCode, 403, 'non-loopback peer rejected')
const badContentType = await call(
  stateRoute.handler,
  makeReq({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }),
  makeRes(),
)
assert.equal(badContentType.statusCode, 415, 'non-json body rejected')
const badJson = await call(
  stateRoute.handler,
  makeReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }),
  makeRes(),
)
assert.equal(badJson.statusCode, 400, 'invalid json rejected')
const putRes = await call(stateRoute.handler, makeReq({ method: 'PUT' }), makeRes())
assert.equal(putRes.statusCode, 405, 'unsupported method rejected')
console.log('PASS loopback/origin/content-type/method fences')

// static assets
const jsRes = await call(routes.get('/dsh-session-groups/client.js').handler, makeReq(), makeRes())
assert.equal(jsRes.statusCode, 200)
assert.match(jsRes.headers['Content-Type'], /javascript/)
assert.ok(jsRes.body.includes('__DSH_SESSION_GROUPS_LOADED__'))
const cssRes = await call(routes.get('/dsh-session-groups/client.css').handler, makeReq(), makeRes())
assert.equal(cssRes.statusCode, 200)
assert.match(cssRes.headers['Content-Type'], /text\/css/)
console.log('PASS client.js / client.css served')

// browser diagnostics sink
const logRes = await call(
  routes.get('/dsh-session-groups/api/log').handler,
  makeReq({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'info', message: 'state loaded: groups=0' }),
  }),
  makeRes(),
)
assert.equal(logRes.statusCode, 200)
assert.deepEqual(JSON.parse(logRes.body), { ok: true })
const logText = fs.readFileSync(path.join(tmpHome, 'session-groups.log'), 'utf8')
assert.ok(logText.includes('[client:info] state loaded: groups=0'))
console.log('PASS /api/log diagnostics sink')

// web deployment tapIndex transform (script loading is owned by the loader row)
const tapped = taps[0]('<html><body><div id="root"></div></body></html>')
assert.ok(!tapped.includes('/dsh-session-groups/client.js'), 'tapIndex leaves scripting to the loader row')
assert.ok(tapped.includes('/dsh-session-groups/client.css'), 'tapIndex injects stylesheet link')
const tappedTwice = taps[0](tapped)
assert.equal(tappedTwice, tapped, 'tapIndex idempotent')
console.log('PASS tapIndex fallback injection')

// tag row text must not be able to kill __DSH_BOOT_READY__
assert.ok(!table.some((row) => row.kind === 'script-src'), 'never push script-src rows')

fs.rmSync(tmpHome, { recursive: true, force: true })
console.log('\nALL TESTS PASSED')
