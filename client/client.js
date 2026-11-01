/**
 * dsh-session-groups — browser half.
 *
 * Adds a purely cosmetic "分组" section next to the built-in workspace browser in
 * the DSH sidebar. Sessions are grouped only inside this plugin's own state file;
 * the host workspace registry (which workspace owns which session) is never
 * touched. Clicking a grouped session delegates to the real session row, so the
 * app's normal navigation, menus and drag behavior keep working.
 *
 * Loaded as a classic script by the host half (index-inject row / tapIndex).
 */
(function () {
  'use strict'

  // The host injects a tiny loader that polls /api/version and swaps this
  // script in place when the file changes. Before the new copy runs, stop the
  // old instance (timers, observer, injected DOM) so nothing is duplicated.
  if (window.__DSH_SESSION_GROUPS_LOADED__) {
    try {
      if (typeof window.__DSH_SESSION_GROUPS_DISPOSE__ === 'function') window.__DSH_SESSION_GROUPS_DISPOSE__()
    } catch (error) {}
    window.__DSH_SESSION_GROUPS_DISPOSE__ = null
    window.__DSH_SESSION_GROUPS_LOADED__ = false
  }
  window.__DSH_SESSION_GROUPS_LOADED__ = true

  var BASE = '/dsh-session-groups'
  var SECTION_CLASS = 'dsg-section'

  var state = { version: 2, sectionCollapsed: false, panelHeight: 0, groups: [], workspaces: [], archived: [] }
  var meta = {} // sessionId -> { title, workspace }
  var archivedSet = {}
  var section = null
  var sectionHost = null
  var placeTimer = 0
  var renderTimer = 0
  var saveTimer = 0
  var bootTimer = 0
  var diagTimers = []
  var disposed = false
  var lastSignature = ''
  var editing = null // { kind: 'new-group' | 'rename', groupId, draft }
  var openMenuId = null
  var managerEl = null
  var managerBody = null
  var toastCount = 0
  var observer = null
  var reportedState = false
  var reportedMount = false
  var reportedHostMissing = false
  var reportedDiag = false

  // ------------------------------------------------------------ diagnostics

  // The section is injected DOM, so failures are invisible unless we ship them
  // back to the host log (see handleLog in lib/index.js).
  function report(message, level) {
    try {
      var text = String(message).slice(0, 2000)
      if (level === 'error') console.error('[dsh-session-groups]', text)
      else console.log('[dsh-session-groups]', text)
      var body = JSON.stringify({ level: level || 'info', message: text })
      // fetch works on dsh-app:// (it is forwarded to the host by the Electron
      // protocol handler). navigator.sendBeacon silently drops requests for
      // this custom scheme, so it is only a last resort.
      if (typeof fetch === 'function') {
        fetch(BASE + '/api/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
        }).catch(function () {})
        return
      }
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          BASE + '/api/log',
          new Blob([body], { type: 'application/json' }),
        )
      }
    } catch {}
  }

  // ------------------------------------------------------------- DOM helpers

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function closestByClass(node, className) {
    var current = node
    while (current && current !== document.body) {
      if (current.classList && current.classList.contains(className)) return current
      current = current.parentElement
    }
    return null
  }

  function closestAttr(node, attribute) {
    var current = node
    while (current && current !== document.body) {
      var value = current.getAttribute && current.getAttribute(attribute)
      if (value != null) return current
      current = current.parentElement
    }
    return null
  }

  function attributeNode(node) {
    var current = node
    while (current && current !== document.body) {
      if (current.hasAttribute && (current.hasAttribute('data-row-key') || current.hasAttribute('data-dsg-action'))) {
        return current
      }
      current = current.parentElement
    }
    return null
  }

  function toast(message) {
    try {
      var node = el('div', 'dsg-toast', message)
      node.style.bottom = String(24 + toastCount * 40) + 'px'
      toastCount += 1
      document.body.appendChild(node)
      setTimeout(function () {
        node.remove()
        toastCount = Math.max(0, toastCount - 1)
      }, 2800)
    } catch {}
  }

  // -------------------------------------------------------------- remote api

  function requestJson(method, path, body) {
    var options = { method: method, credentials: 'same-origin', headers: {} }
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json'
      options.body = JSON.stringify(body)
    }
    return fetch(BASE + path, options).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    })
  }

  function applyRemote(payload) {
    if (!payload || typeof payload !== 'object') return
    state.groups = Array.isArray(payload.groups) ? payload.groups : []
    if (typeof payload.sectionCollapsed === 'boolean') state.sectionCollapsed = payload.sectionCollapsed
    if (typeof payload.panelHeight === 'number' && isFinite(payload.panelHeight)) {
      state.panelHeight = Math.max(0, Math.min(1200, Math.round(payload.panelHeight)))
    }
    state.workspaces = Array.isArray(payload.workspaces) ? payload.workspaces : []
    state.archived = Array.isArray(payload.archived) ? payload.archived : []
    archivedSet = {}
    for (var i = 0; i < state.archived.length; i++) archivedSet[state.archived[i]] = true
    if (!reportedState) {
      reportedState = true
      report(
        'state loaded: groups=' +
          state.groups.length +
          ' workspaces=' +
          state.workspaces.length +
          ' archived=' +
          state.archived.length +
          ' trees=' +
          document.querySelectorAll('[role="tree"]').length +
          ' rows=' +
          document.querySelectorAll('[data-row-key^="session:"]').length,
      )
    }
    for (var g = 0; g < state.groups.length; g++) {
      var sessions = state.groups[g].sessions || []
      for (var s = 0; s < sessions.length; s++) {
        var entry = sessions[s]
        if (!entry || !entry.id) continue
        if (!meta[entry.id]) meta[entry.id] = {}
        if (entry.title) meta[entry.id].title = entry.title
        if (entry.workspace) meta[entry.id].workspace = entry.workspace
      }
    }
    scheduleRender(0)
    if (managerEl) renderManagerBody()
  }

  function loadRemote() {
    return requestJson('GET', '/api/state')
      .then(applyRemote)
      .catch(function (error) {
        console.warn('[dsh-session-groups] failed to load state:', error)
        scheduleRender(0)
      })
  }

  function saveRemote() {
    var payload = { version: 2, sectionCollapsed: state.sectionCollapsed, panelHeight: state.panelHeight, groups: state.groups }
    requestJson('POST', '/api/state', payload)
      .then(function (saved) {
        state.workspaces = Array.isArray(saved.workspaces) ? saved.workspaces : state.workspaces
        state.archived = Array.isArray(saved.archived) ? saved.archived : state.archived
      })
      .catch(function (error) {
        console.warn('[dsh-session-groups] failed to save state:', error)
        toast('分组保存失败：' + (error && error.message ? error.message : error))
      })
  }

  function scheduleSave() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveRemote, 350)
  }

  // -------------------------------------------------------- session scanning

  function findSessionRow(sessionId) {
    var escaped = String(sessionId).replace(/["\\]/g, '\\$&')
    try {
      return document.querySelector('[data-row-key="session:' + escaped + '"]')
    } catch {
      return null
    }
  }

  function hasClassSegment(node, suffix) {
    var className = node && node.className
    if (typeof className !== 'string' || !className) return false
    var parts = className.split(/\s+/)
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].slice(-suffix.length) === suffix) return true
    }
    return false
  }

  function titleFromRow(row) {
    if (!row) return ''
    var nodes = row.querySelectorAll('*')
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]
      if (hasClassSegment(node, '_title')) {
        var text = (node.textContent || '').replace(/\s+/g, ' ').trim()
        if (text) return text.slice(0, 200)
      }
    }
    var fallback = (row.textContent || '').replace(/\s+/g, ' ').trim()
    return fallback.slice(0, 200)
  }

  function workspaceOf(sessionId) {
    for (var i = 0; i < state.workspaces.length; i++) {
      var workspace = state.workspaces[i]
      if (workspace.sessionIds && workspace.sessionIds.indexOf(sessionId) !== -1) return workspace
    }
    return null
  }

  function scanRows() {
    var result = []
    var rows = document.querySelectorAll('[data-row-key^="session:"]')
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      var key = row.getAttribute('data-row-key') || ''
      var sessionId = key.slice('session:'.length)
      if (!sessionId) continue
      var title = titleFromRow(row)
      var workspace = workspaceOf(sessionId)
      if (!meta[sessionId]) meta[sessionId] = {}
      if (title) meta[sessionId].title = title
      if (workspace) meta[sessionId].workspace = workspace.title
      result.push({ id: sessionId, title: title || (meta[sessionId] && meta[sessionId].title) || '', archived: !!archivedSet[sessionId], row: row })
    }
    return result
  }

  function sessionSignature(rows) {
    var ids = []
    for (var i = 0; i < rows.length; i++) ids.push(rows[i].id)
    return ids.sort().join(',')
  }

  function expandAll() {
    return new Promise(function (resolve) {
      var pass = 0
      function run() {
        var changed = false
        var collapsed = document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]')
        for (var i = 0; i < collapsed.length; i++) {
          try {
            collapsed[i].click()
            changed = true
          } catch {}
        }
        pass += 1
        if (changed && pass < 4) setTimeout(run, 130)
        else setTimeout(resolve, 160)
      }
      run()
    })
  }

  function openSession(sessionId) {
    if (archivedSet[sessionId]) {
      toast('这是已归档会话：先在侧栏取消归档才能打开')
      return
    }
    var row = findSessionRow(sessionId)
    if (row) {
      row.click()
      return
    }
    expandAll().then(function () {
      var again = findSessionRow(sessionId)
      if (again) {
        again.click()
        return
      }
      setTimeout(function () {
        var last = findSessionRow(sessionId)
        if (last) {
          last.click()
        } else {
          report('open-session failed, row not found: ' + sessionId, 'warn')
          toast('找不到该会话行（可能已不在当前视图里）')
        }
      }, 260)
    })
  }

  // ------------------------------------------------------ section placement

  function findHost() {
    var row = document.querySelector('[data-row-key^="session:"], [data-row-key^="workspace:"]')
    if (!row) return null
    var tree = row.closest('[role="tree"]')
    if (!tree) return row.parentElement || null
    var host = tree.parentElement
    if (host && host.getBoundingClientRect().height > 0) return host
    return tree
  }

  function buildSection() {
    section = el('div', SECTION_CLASS)
    section.setAttribute('data-dsg', 'section')
    section.addEventListener('click', onSectionClick)
    section.addEventListener('keydown', onSectionKeydown)
    section.addEventListener('change', onSectionChange)
    section.addEventListener('pointerdown', onSectionPointerDown)
    section.addEventListener('dragstart', onSectionDragStart)
    section.addEventListener('dragend', onSectionDragEnd)
    section.addEventListener('dragover', onSectionDragOver)
    section.addEventListener('dragleave', onSectionDragLeave)
    section.addEventListener('drop', onSectionDrop)
    return section
  }

  // The section is docked to the bottom of the workspace list (position: sticky).
  // Dragging its top edge resizes the split; double-click resets to auto height.
  function onSectionPointerDown(event) {
    var handle = event.target && event.target.closest ? event.target.closest('[data-dsg="resizer"]') : null
    if (!handle) return
    event.preventDefault()
    startSectionResize(event)
  }

  function startSectionResize(event) {
    var parent = section.parentElement
    var maxHeight = parent ? Math.max(160, parent.clientHeight - 96) : 640
    var startY = event.clientY
    var startHeight = section.getBoundingClientRect().height || 0
    var latest = startHeight
    var previousUserSelect = document.body.style.userSelect
    var previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ns-resize'
    section.classList.add('dsg-resizing')
    function onMove(moveEvent) {
      latest = Math.min(maxHeight, Math.max(72, startHeight + (startY - moveEvent.clientY)))
      section.style.height = Math.round(latest) + 'px'
      section.style.maxHeight = 'none'
      syncHostPadding(latest)
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
      section.classList.remove('dsg-resizing')
      state.panelHeight = Math.round(latest)
      scheduleSave()
      syncHostPadding()
      report('panel resized: ' + state.panelHeight + 'px')
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  // ------------------------------------------------------------ drag & drop
  //
  // Native sidebar session rows are already HTML5-draggable and put the bare
  // session id into dataTransfer as "text/plain" (dsh-client-ui-workspace:
  // onDragStart -> setData("text/plain", node.id)). We accept that drop on our
  // own group rows: this only edits our grouping file, never host ownership.

  var dragHoverGroupId = ''
  var dropIndicator = null // { groupId, beforeSessionId } — matches the drop line
  var dropLineEl = null

  function hasSessionPayload(event) {
    try {
      var dt = event.dataTransfer
      if (!dt) return false
      var types = dt.types ? Array.prototype.slice.call(dt.types) : []
      for (var i = 0; i < types.length; i++) {
        if (types[i] === 'text/plain' || types[i] === 'application/x-dsh-session') return true
      }
      return false
    } catch (err) {
      return false
    }
  }

  function sessionIdFromEvent(event) {
    try {
      var dt = event.dataTransfer
      if (!dt) return ''
      var raw = dt.getData('application/x-dsh-session') || dt.getData('text/plain') || ''
      raw = String(raw == null ? '' : raw).trim()
      if (raw.slice(0, 8) === 'session:') raw = raw.slice(8)
      // Native session rows put the bare id here; workspace rows put
      // "workspace:<key>", which must not be mistaken for a session.
      if (!/^session-[A-Za-z0-9_-]{6,}$/.test(raw)) return ''
      return raw
    } catch (err) {
      return ''
    }
  }

  function groupIdFromTarget(target) {
    var node = target && target.closest ? target.closest('[data-group-id]') : null
    if (!node || !section || !section.contains(node)) return ''
    var wrapper = node.closest('.dsg-group') || node
    return wrapper.getAttribute('data-group-id') || ''
  }

  function clearDropHighlights() {
    dragHoverGroupId = ''
    hideDropLine()
    if (!section) return
    var highlighted = section.querySelectorAll('.dsg-drop-active')
    for (var i = 0; i < highlighted.length; i++) highlighted[i].classList.remove('dsg-drop-active')
  }

  function directChildByClass(wrapper, className) {
    if (!wrapper) return null
    for (var i = 0; i < wrapper.children.length; i++) {
      var child = wrapper.children[i]
      if (child.classList && child.classList.contains(className)) return child
    }
    return null
  }

  function directGroupBody(wrapper) {
    return directChildByClass(wrapper, 'dsg-group-body')
  }

  function groupSessionRows(wrapper) {
    var body = directGroupBody(wrapper)
    if (!body) return []
    var rows = []
    for (var i = 0; i < body.children.length; i++) {
      var child = body.children[i]
      if (child.classList && child.classList.contains('dsg-session')) rows.push(child)
    }
    return rows
  }

  function hideDropLine() {
    dropIndicator = null
    if (dropLineEl && dropLineEl.parentElement) dropLineEl.parentElement.removeChild(dropLineEl)
    dropLineEl = null
  }

  /**
   * Draws the insertion line at the exact place the dragged session would land:
   * above the row it will be inserted before, or at the end of the group's own
   * session list. Collapsed groups get the line under their header.
   */
  function showDropLine(wrapper, beforeSessionId) {
    dropIndicator = {
      groupId: wrapper.getAttribute('data-group-id') || '',
      beforeSessionId: beforeSessionId || '',
    }
    if (!dropLineEl) {
      dropLineEl = el('div', 'dsg-drop-line')
      dropLineEl.setAttribute('aria-hidden', 'true')
    }
    // Indent the line like the session rows of this group (14px per nesting level).
    var depth = 0
    var cursor = wrapper.parentElement
    while (cursor && cursor !== section) {
      if (cursor.classList && cursor.classList.contains('dsg-group')) depth += 1
      cursor = cursor.parentElement
    }
    dropLineEl.style.marginLeft = 18 + depth * 14 + 'px'
    var body = directGroupBody(wrapper)
    if (!body) {
      var head = directChildByClass(wrapper, 'dsg-group-head')
      if (head) wrapper.insertBefore(dropLineEl, head.nextSibling)
      else wrapper.appendChild(dropLineEl)
      return
    }
    var rows = groupSessionRows(wrapper)
    var anchor = null
    if (beforeSessionId) {
      for (var r = 0; r < rows.length; r++) {
        if (rows[r].getAttribute('data-session-id') === beforeSessionId) {
          anchor = rows[r]
          break
        }
      }
    }
    if (anchor) {
      body.insertBefore(dropLineEl, anchor)
    } else if (rows.length > 0) {
      body.insertBefore(dropLineEl, rows[rows.length - 1].nextSibling)
    } else {
      body.insertBefore(dropLineEl, body.firstChild)
    }
  }

  /**
   * Works out the drop position from the pointer: hovering the upper half of a
   * session row inserts before it, the lower half after it (i.e. before the next
   * row), and the group header / empty space appends at the end of that group.
   */
  function resolveDropTarget(event) {
    if (!section) return null
    var target = event.target
    if (!target || !target.closest) return null
    var wrapper = target.closest('.dsg-group')
    if (!wrapper || !section.contains(wrapper)) return null
    var groupId = wrapper.getAttribute('data-group-id') || ''
    if (!groupId) return null
    var head = directChildByClass(wrapper, 'dsg-group-head')
    var overHead = head && head.contains(target)
    var beforeSessionId = ''
    if (!overHead) {
      var rows = groupSessionRows(wrapper)
      var pointerY = event.clientY
      for (var i = 0; i < rows.length; i++) {
        var rect = rows[i].getBoundingClientRect()
        if (pointerY < rect.top + rect.height / 2) {
          beforeSessionId = rows[i].getAttribute('data-session-id') || ''
          break
        }
      }
    }
    return { wrapper: wrapper, groupId: groupId, beforeSessionId: beforeSessionId }
  }

  function onSectionDragStart(event) {
    // Rows inside our own section mirror the native row contract so the same
    // drop handler can move them between groups.
    var row = event.target && event.target.closest ? event.target.closest('[data-session-id]') : null
    if (!row || !section || !section.contains(row)) return
    var sessionId = row.getAttribute('data-session-id') || ''
    if (!sessionId) return
    try {
      event.dataTransfer.effectAllowed = 'move'
      // Only the private type on purpose: the native list must not treat a row
      // dragged out of our section as one of its own reorder drops.
      event.dataTransfer.setData('application/x-dsh-session', sessionId)
    } catch (err) {}
    row.classList.add('dsg-session-dragging')
  }

  function onSectionDragEnd(event) {
    var row = event.target && event.target.closest ? event.target.closest('[data-session-id]') : null
    if (row) row.classList.remove('dsg-session-dragging')
    clearDropHighlights()
  }

  function onSectionDragOver(event) {
    if (!hasSessionPayload(event)) return
    var target = resolveDropTarget(event)
    if (!target) {
      if (dragHoverGroupId || dropLineEl) clearDropHighlights()
      return
    }
    event.preventDefault()
    try {
      event.dataTransfer.dropEffect = 'move'
    } catch (err) {}
    if (dragHoverGroupId !== target.groupId) {
      clearDropHighlights()
      target.wrapper.classList.add('dsg-drop-active')
      dragHoverGroupId = target.groupId
    }
    if (
      !dropIndicator ||
      dropIndicator.groupId !== target.groupId ||
      dropIndicator.beforeSessionId !== target.beforeSessionId
    ) {
      showDropLine(target.wrapper, target.beforeSessionId)
    }
  }

  function onSectionDragLeave(event) {
    if (!section) return
    var related = event.relatedTarget
    if (related && section.contains(related)) return
    clearDropHighlights()
  }

  function onSectionDrop(event) {
    var target = resolveDropTarget(event)
    var sessionId = sessionIdFromEvent(event)
    clearDropHighlights()
    if (!target || !sessionId) return
    event.preventDefault()
    event.stopPropagation()
    // Remember the native title before this row may be re-rendered.
    var nativeRow = null
    try {
      nativeRow = document.querySelector('[data-row-key="session:' + sessionId + '"]')
    } catch (err) {}
    if (nativeRow) {
      var title = titleFromRow(nativeRow)
      var workspace = workspaceOf(sessionId)
      if (!meta[sessionId]) meta[sessionId] = {}
      if (title) meta[sessionId].title = title
      if (workspace) meta[sessionId].workspace = workspace.title
    }
    assignSessionToGroup(sessionId, target.groupId, target.beforeSessionId)
    var group = findGroup(target.groupId)
    if (group) toast('已加入「' + groupName(group.name) + '」')
    report(
      'drag-drop: ' + sessionId + ' -> group ' + target.groupId + (target.beforeSessionId ? ' before ' + target.beforeSessionId : ''),
    )
  }

  function assignSessionToGroup(sessionId, groupId, beforeSessionId) {
    var group = findGroup(groupId)
    if (!group) return
    removeSessionEverywhere(sessionId)
    var entry = toEntry(sessionId)
    var sessions = group.sessions || (group.sessions = [])
    var insertAt = sessions.length
    if (beforeSessionId) {
      for (var i = 0; i < sessions.length; i++) {
        var id = typeof sessions[i] === 'string' ? sessions[i] : sessions[i].id
        if (id === beforeSessionId) {
          insertAt = i
          break
        }
      }
    }
    sessions.splice(insertAt, 0, entry)
    scheduleSave()
    scheduleRender(0)
    if (managerEl) renderManagerBody()
  }

  /**
   * The section is absolutely docked at the bottom of the host element, so the
   * host needs to become its containing block. Only touch it when its computed
   * position is static, so we never override an intentional layout from DSH.
   */
  function prepareHost(host) {
    if (!host) return
    try {
      if (host.__dsgPositioned) return
      host.__dsgPositioned = true
      var style = window.getComputedStyle(host)
      if (style.position === 'static') host.style.position = 'relative'
    } catch (error) {}
  }

  /**
   * The section overlays the bottom of the workspace list, so reserve the same
   * amount of space at the end of the scroll container: otherwise the last
   * workspace/session rows would be hidden underneath the panel.
   */
  function syncHostPadding(forcedHeight) {
    if (!section || !sectionHost) return
    try {
      var height =
        typeof forcedHeight === 'number' && isFinite(forcedHeight)
          ? forcedHeight
          : section.getBoundingClientRect().height || 0
      var padding = height > 0 ? Math.ceil(height) : 0
      var next = padding > 0 ? padding + 'px' : ''
      if (sectionHost.style.paddingBottom !== next) sectionHost.style.paddingBottom = next
    } catch (error) {}
  }

  function ensureSection() {
    if (disposed) return false
    if (!section) buildSection()
    var host = findHost()
    if (!host) {
      if (!reportedHostMissing) {
        reportedHostMissing = true
        report('section host not found yet (no session/workspace rows in DOM)', 'warn')
      }
      return false
    }
    if (section.parentElement !== host) {
      sectionHost = host
      host.appendChild(section)
    } else if (!section.isConnected) {
      host.appendChild(section)
    }
    prepareHost(host)
    if (!reportedMount) {
      reportedMount = true
      report(
        'section mounted: host=<' +
          host.tagName.toLowerCase() +
          ' class="' +
          (typeof host.className === 'string' ? host.className : '') +
          '"> parent=<' +
          (host.parentElement ? host.parentElement.tagName.toLowerCase() : 'none') +
          '> role=' +
          (host.getAttribute('role') || '(none)'),
      )
    }
    return true
  }

  function schedulePlace(delay) {
    clearTimeout(placeTimer)
    placeTimer = setTimeout(function () {
      if (!ensureSection()) return
      var rows = document.querySelectorAll('[data-row-key^="session:"]')
      var signature = sessionSignatureFromRows(rows)
      if (signature !== lastSignature) {
        lastSignature = signature
        scheduleRender(0)
      }
    }, delay == null ? 200 : delay)
  }

  function sessionSignatureFromRows(rows) {
    var ids = []
    for (var i = 0; i < rows.length; i++) ids.push(rows[i].getAttribute('data-row-key'))
    return ids.sort().join(',')
  }

  function scheduleRender(delay) {
    clearTimeout(renderTimer)
    renderTimer = setTimeout(renderSection, delay == null ? 30 : delay)
  }

  // --------------------------------------------------------------- rendering

  function groupName(name) {
    return typeof name === 'string' && name ? name : '未命名分组'
  }

  function renderSection() {
    if (disposed) return
    if (!ensureSection()) return
    var active = document.activeElement
    if (active && section.contains(active) && active.tagName === 'INPUT') return

    // Explicit height (set by dragging the top edge) turns the docked section
    // into a fixed-height panel; 0 means "size to content up to the CSS max".
    if (!state.sectionCollapsed && state.panelHeight > 0) {
      section.style.height = Math.round(state.panelHeight) + 'px'
      section.style.maxHeight = 'none'
    } else {
      section.style.height = ''
      section.style.maxHeight = ''
    }

    // Rebuilding the DOM would reset the section's internal scroll to the top.
    // Keep it so dropping a session into a group far down does not jump away.
    var previousScrollTop = 0
    var previousScrollLeft = 0
    var previousBody = section.querySelector('.dsg-section-body')
    if (previousBody) {
      previousScrollTop = previousBody.scrollTop
      previousScrollLeft = previousBody.scrollLeft
    }

    clear(section)

    // boundary between the workspace list and this section
    var resizer = el('div', 'dsg-resizer')
    resizer.setAttribute('data-dsg', 'resizer')
    resizer.setAttribute('role', 'separator')
    resizer.setAttribute('aria-orientation', 'horizontal')
    resizer.title = '拖动调整分组区高度（双击恢复自动高度）'
    resizer.addEventListener('dblclick', function () {
      state.panelHeight = 0
      scheduleSave()
      scheduleRender(0)
    })
    section.appendChild(resizer)

    // header
    var header = el('div', 'dsg-header')
    var caret = el('button', 'dsg-caret', state.sectionCollapsed ? '▸' : '▾')
    caret.type = 'button'
    caret.setAttribute('data-dsg-action', 'toggle-section')
    caret.setAttribute('aria-label', state.sectionCollapsed ? '展开分组' : '收起分组')
    caret.title = caret.getAttribute('aria-label')
    header.appendChild(caret)
    header.appendChild(el('span', 'dsg-title', '分组'))
    var total = 0
    for (var i = 0; i < state.groups.length; i++) total += (state.groups[i].sessions || []).length
    if (total > 0) header.appendChild(el('span', 'dsg-count', String(total)))
    header.appendChild(el('span', 'dsg-spacer'))
    var addButton = el('button', 'dsg-icon-btn', '＋')
    addButton.type = 'button'
    addButton.setAttribute('data-dsg-action', 'new-group')
    addButton.title = '新建分组'
    addButton.setAttribute('aria-label', '新建分组')
    header.appendChild(addButton)
    var manageButton = el('button', 'dsg-icon-btn', '⚙')
    manageButton.type = 'button'
    manageButton.setAttribute('data-dsg-action', 'open-manager')
    manageButton.title = '整理会话到分组'
    manageButton.setAttribute('aria-label', '整理会话到分组')
    header.appendChild(manageButton)
    section.appendChild(header)

    if (state.sectionCollapsed) {
      syncHostPadding()
      return
    }

    var body = el('div', 'dsg-section-body')

    // inline "new group" editor
    if (editing && editing.kind === 'new-group') {
      var editorRow = el('div', 'dsg-editor')
      var input = el('input', 'dsg-input')
      var newGroupEditing = editing
      input.value = newGroupEditing.draft || ''
      input.placeholder = newGroupEditing.parentId ? '子分组名称' : '分组名称'
      input.maxLength = 60
      input.setAttribute('data-dsg-input', 'new-group')
      input.addEventListener('input', function () {
        newGroupEditing.draft = input.value
      })
      editorRow.appendChild(input)
      editorRow.appendChild(button('确定', 'commit-edit', 'dsg-btn dsg-btn-primary'))
      editorRow.appendChild(button('取消', 'cancel-edit', 'dsg-btn'))
      body.appendChild(editorRow)
    }

    if (state.groups.length === 0) {
      var empty = el('div', 'dsg-empty')
      empty.appendChild(document.createTextNode('还没有分组。点 '))
      empty.appendChild(el('span', 'dsg-empty-plus', '＋'))
      empty.appendChild(document.createTextNode(' 建一个，或用 '))
      empty.appendChild(el('span', 'dsg-empty-plus', '⚙'))
      empty.appendChild(document.createTextNode(' 把会话放进来（也可以直接把侧栏里的会话拖进分组）。'))
      body.appendChild(empty)
    }

    var roots = childrenOf('')
    for (var g = 0; g < roots.length; g++) {
      body.appendChild(renderGroup(roots[g], 0))
    }
    section.appendChild(body)

    // Restore the scroll position that the rebuild above threw away, so editing
    // a group far down (e.g. drag-and-drop) does not scroll the panel back up.
    if (previousScrollTop > 0) {
      body.scrollTop = previousScrollTop
      report('render kept scroll: ' + previousScrollTop + 'px')
    }
    if (previousScrollLeft > 0) body.scrollLeft = previousScrollLeft

    if (!reportedDiag) {
      reportedDiag = true
      diagnoseSection('first-render')
    }
    syncHostPadding()
  }

  /**
   * Diagnostics: the section is injected DOM, so if it is invisible we need
   * to know whether it is missing, zero-sized, or clipped by an ancestor.
   * Results are posted to the host log (see /api/log).
   */
  function diagnoseSection(tag) {
    try {
      if (!section) {
        report('diag[' + tag + ']: no section element', 'warn')
        return
      }
      var rect = section.getBoundingClientRect()
      var style = window.getComputedStyle(section)
      var host = section.parentElement
      var hostRect = host ? host.getBoundingClientRect() : null
      var chain = []
      var node = section
      for (var i = 0; i < 6 && node; i++) {
        var nodeRect = node.getBoundingClientRect()
        var nodeStyle = window.getComputedStyle(node)
        var name = node.tagName.toLowerCase()
        if (typeof node.className === 'string' && node.className) name += '.' + node.className.split(/\s+/)[0]
        chain.push(
          name +
            '[' + Math.round(nodeRect.width) + 'x' + Math.round(nodeRect.height) +
            ' ' + nodeStyle.display + ' ' + nodeStyle.visibility + ' ' + nodeStyle.overflow + ']',
        )
        node = node.parentElement
      }
      var hostStyle = host ? window.getComputedStyle(host) : null
      var offsetParent = section.offsetParent
      var hostTop = hostRect ? Math.round(hostRect.top) : 0
      var probe = null
      try {
        probe = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 40))
      } catch (error) {}
      report(
        'diag[' + tag + ']: count=' + document.querySelectorAll('.dsg-section').length +
          ' win=' + window.innerWidth + 'x' + window.innerHeight + ' dpr=' + window.devicePixelRatio +
          ' rect=' + Math.round(rect.left) + ',' + Math.round(rect.top) + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height) +
          ' style=[' + style.display + ' ' + style.visibility + ' ' + style.position + ' h=' + style.height + ' maxh=' + style.maxHeight + ' z=' + style.zIndex + ' op=' + style.opacity + ']' +
          ' pos=[top=' + style.top + ' right=' + style.right + ' bottom=' + style.bottom + ' left=' + style.left + ']' +
          ' offsetParent=' + (offsetParent ? offsetParent.tagName.toLowerCase() + '.' + (typeof offsetParent.className === 'string' ? offsetParent.className.split(/\s+/)[0] : '') : 'null') +
          ' hostPos=' + (hostStyle ? hostStyle.position : 'na') + '/inline=' + (host ? host.style.position || '(empty)' : 'na') +
          ' hostTop=' + hostTop +
          ' probe=' + (probe ? probe.tagName.toLowerCase() + '.' + (typeof probe.className === 'string' ? String(probe.className).split(/\s+/)[0] : '') : 'null') +
          ' children=' + section.childElementCount +
          ' connected=' + section.isConnected +
          ' hostRect=' + (hostRect ? Math.round(hostRect.width) + 'x' + Math.round(hostRect.height) : 'na') +
          ' hostScroll=' + (host ? host.clientHeight + '/' + host.scrollHeight : 'na') +
          ' chain=' + chain.join(' < '),
      )
    } catch (error) {
      report('diag[' + tag + '] failed: ' + (error && error.message ? error.message : error), 'warn')
    }
  }

  function button(label, action, className) {
    var node = el('button', className || 'dsg-btn', label)
    node.type = 'button'
    node.setAttribute('data-dsg-action', action)
    return node
  }

  function renderGroup(group, depth) {
    var wrapper = el('div', 'dsg-group')
    wrapper.setAttribute('data-group-id', group.id)
    wrapper.setAttribute('data-depth', String(depth || 0))

    var head = el('div', 'dsg-group-head')
    head.style.paddingLeft = 2 + (depth || 0) * 14 + 'px'
    var toggle = el('button', 'dsg-caret', group.collapsed ? '▸' : '▾')
    toggle.type = 'button'
    toggle.setAttribute('data-dsg-action', 'toggle-group')
    toggle.setAttribute('data-group-id', group.id)
    toggle.setAttribute('aria-expanded', group.collapsed ? 'false' : 'true')
    toggle.setAttribute('aria-label', (group.collapsed ? '展开' : '收起') + groupName(group.name))
    head.appendChild(toggle)

    if (editing && editing.kind === 'rename' && editing.groupId === group.id) {
      var renameInput = el('input', 'dsg-input dsg-input-rename')
      var renameEditing = editing
      renameInput.value = renameEditing.draft || ''
      renameInput.maxLength = 60
      renameInput.setAttribute('data-dsg-input', 'rename')
      renameInput.setAttribute('data-group-id', group.id)
      renameInput.addEventListener('input', function () {
        renameEditing.draft = renameInput.value
      })
      head.appendChild(renameInput)
      head.appendChild(button('确定', 'commit-edit', 'dsg-btn dsg-btn-primary'))
      head.appendChild(button('取消', 'cancel-edit', 'dsg-btn'))
    } else {
      var nameNode = el('span', 'dsg-group-name', groupName(group.name))
      nameNode.title = groupName(group.name)
      head.appendChild(nameNode)
      head.appendChild(el('span', 'dsg-group-count', String((group.sessions || []).length)))
      var menuButton = el('button', 'dsg-icon-btn dsg-group-menu-btn', '⋯')
      menuButton.type = 'button'
      menuButton.setAttribute('data-dsg-action', 'group-menu')
      menuButton.setAttribute('data-group-id', group.id)
      menuButton.title = '分组操作'
      menuButton.setAttribute('aria-label', groupName(group.name) + ' 的操作')
      head.appendChild(menuButton)
    }
    wrapper.appendChild(head)

    if (openMenuId === group.id) wrapper.appendChild(renderGroupMenu(group))

    var children = childrenOf(group.id)
    var sessions = group.sessions || []

    if (!group.collapsed) {
      var body = el('div', 'dsg-group-body')
      if (sessions.length === 0 && children.length === 0) {
        body.appendChild(el('div', 'dsg-group-empty', '空分组'))
      } else {
        for (var i = 0; i < sessions.length; i++) body.appendChild(renderSessionRow(sessions[i], group))
      }
      for (var c = 0; c < children.length; c++) body.appendChild(renderGroup(children[c], (depth || 0) + 1))
      wrapper.appendChild(body)
    }
    return wrapper
  }

  function renderGroupMenu(group) {
    var menu = el('div', 'dsg-menu')
    menu.style.marginLeft = 20 + groupDepth(group) * 14 + 'px'
    menu.appendChild(menuItem('重命名', 'rename-group', group.id))
    menu.appendChild(menuItem('新建子分组', 'new-subgroup', group.id))
    var siblings = childrenOf(groupParentId(group))
    var index = siblings.indexOf(group)
    if (index > 0) menu.appendChild(menuItem('上移', 'move-up', group.id))
    if (index >= 0 && index < siblings.length - 1) menu.appendChild(menuItem('下移', 'move-down', group.id))
    var remove = menuItem('删除分组', 'delete-group', group.id)
    remove.className = 'dsg-menu-item dsg-menu-danger'
    remove.title = '只删除这个分组，不会删除会话；子分组会升到上一级'
    menu.appendChild(remove)
    return menu
  }

  function menuItem(label, action, groupId) {
    var node = el('button', 'dsg-menu-item', label)
    node.type = 'button'
    node.setAttribute('data-dsg-action', action)
    node.setAttribute('data-group-id', groupId)
    return node
  }

  function renderSessionRow(entry, group) {
    var sessionId = typeof entry === 'string' ? entry : entry.id
    var title =
      (meta[sessionId] && meta[sessionId].title) ||
      (entry && typeof entry === 'object' && entry.title) ||
      sessionId
    var workspace =
      (meta[sessionId] && meta[sessionId].workspace) ||
      (entry && typeof entry === 'object' && entry.workspace) ||
      ''
    var row = el('div', 'dsg-session')
    row.style.paddingLeft = 18 + groupDepth(group) * 14 + 'px'
    row.setAttribute('data-dsg-action', 'open-session')
    row.setAttribute('data-session-id', sessionId)
    row.setAttribute('role', 'button')
    row.setAttribute('tabindex', '0')
    row.title = title
    row.setAttribute('draggable', 'true')
    row.appendChild(el('span', 'dsg-session-title', title))
    if (workspace) row.appendChild(el('span', 'dsg-session-ws', workspace))
    if (archivedSet[sessionId]) row.appendChild(el('span', 'dsg-session-archived', '已归档'))
    var remove = el('button', 'dsg-session-remove', '×')
    remove.type = 'button'
    remove.setAttribute('data-dsg-action', 'remove-session')
    remove.setAttribute('data-session-id', sessionId)
    remove.setAttribute('data-group-id', group.id)
    remove.title = '从分组移出'
    remove.setAttribute('aria-label', '从分组移出 ' + title)
    row.appendChild(remove)
    return row
  }

  // -------------------------------------------------------------- mutations

  function findGroup(groupId) {
    for (var i = 0; i < state.groups.length; i++) {
      if (state.groups[i].id === groupId) return state.groups[i]
    }
    return null
  }

  function groupIdOfSession(sessionId) {
    for (var i = 0; i < state.groups.length; i++) {
      var sessions = state.groups[i].sessions || []
      for (var s = 0; s < sessions.length; s++) {
        var id = typeof sessions[s] === 'string' ? sessions[s] : sessions[s].id
        if (id === sessionId) return state.groups[i].id
      }
    }
    return ''
  }

  function groupParentId(group) {
    return group && typeof group.parentId === 'string' && group.parentId ? group.parentId : ''
  }

  function childrenOf(parentId) {
    var wanted = parentId || ''
    var result = []
    for (var i = 0; i < state.groups.length; i++) {
      if (groupParentId(state.groups[i]) === wanted) result.push(state.groups[i])
    }
    return result
  }

  function groupDepth(group) {
    var depth = 0
    var current = group
    var guard = 0
    while (current && guard < 12) {
      var parentId = groupParentId(current)
      if (!parentId) break
      current = findGroup(parentId)
      depth += 1
      guard += 1
    }
    return depth
  }

  function flattenGroups(parentId, depth) {
    var list = childrenOf(parentId)
    var out = []
    for (var i = 0; i < list.length; i++) {
      out.push({ group: list[i], depth: depth })
      var nested = flattenGroups(list[i].id, depth + 1)
      for (var n = 0; n < nested.length; n++) out.push(nested[n])
    }
    return out
  }

  function moveGroupWithinSiblings(group, delta) {
    var siblings = childrenOf(groupParentId(group))
    var index = siblings.indexOf(group)
    var next = index + delta
    if (index < 0 || next < 0 || next >= siblings.length) return
    var target = siblings[next]
    var from = state.groups.indexOf(group)
    var to = state.groups.indexOf(target)
    if (from < 0 || to < 0) return
    // Remove first, then insert at the target's ORIGINAL index: the target
    // shifts left by one exactly when we move something down, which is what
    // lands us right after it. (Inserting at to-1 for downward moves silently
    // put the group back where it started - that was bug2.)
    state.groups.splice(from, 1)
    state.groups.splice(to, 0, group)
  }

  function deleteGroup(group) {
    var parentId = groupParentId(group)
    for (var i = 0; i < state.groups.length; i++) {
      if (groupParentId(state.groups[i]) === group.id) state.groups[i].parentId = parentId
    }
    var index = state.groups.indexOf(group)
    if (index >= 0) state.groups.splice(index, 1)
  }

  function ensureMetaEntry(sessionId) {
    if (!meta[sessionId]) meta[sessionId] = {}
    return meta[sessionId]
  }

  function toEntry(sessionId) {
    var record = ensureMetaEntry(sessionId)
    var entry = { id: sessionId }
    if (record.title) entry.title = record.title
    if (record.workspace) entry.workspace = record.workspace
    return entry
  }

  function createGroup(name, parentId) {
    var parent = parentId ? findGroup(parentId) : null
    var group = {
      id: 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      name: name || '新分组',
      collapsed: false,
      sessions: [],
      parentId: parent ? parent.id : '',
    }
    state.groups.push(group)
    return group
  }

  function removeSessionEverywhere(sessionId) {
    for (var i = 0; i < state.groups.length; i++) {
      var sessions = state.groups[i].sessions || []
      for (var s = sessions.length - 1; s >= 0; s--) {
        var id = typeof sessions[s] === 'string' ? sessions[s] : sessions[s].id
        if (id === sessionId) sessions.splice(s, 1)
      }
    }
  }

  function assignSession(sessionId, groupId) {
    removeSessionEverywhere(sessionId)
    if (groupId) {
      var group = findGroup(groupId)
      if (group) group.sessions.push(toEntry(sessionId))
    }
    scheduleSave()
    scheduleRender(0)
    if (managerEl) renderManagerBody()
  }

  function blurActiveInput() {
    try {
      var active = document.activeElement
      if (active && section && section.contains(active) && active.tagName === 'INPUT') active.blur()
    } catch {}
  }

  function commitEdit() {
    if (!editing) return
    var draft = (editing.draft || '').replace(/\s+/g, ' ').trim()
    if (editing.kind === 'new-group') {
      createGroup(draft || '新分组', editing.parentId || '')
    } else if (editing.kind === 'rename') {
      var group = findGroup(editing.groupId)
      if (group) group.name = draft || group.name
    }
    editing = null
    blurActiveInput()
    scheduleSave()
    scheduleRender(0)
  }

  function onSectionClick(event) {
    var target = attributeNode(event.target)
    if (!target) return
    var action = target.getAttribute('data-dsg-action')
    if (!action) return
    if (action === 'open-session') {
      event.stopPropagation()
      event.preventDefault()
      var sessionId = target.getAttribute('data-session-id')
      if (sessionId) openSession(sessionId)
      return
    }
    if (action === 'remove-session') {
      event.stopPropagation()
      event.preventDefault()
      var id = target.getAttribute('data-session-id')
      if (id) assignSession(id, '')
      return
    }
    event.stopPropagation()
    event.preventDefault()

    if (action === 'toggle-section') {
      state.sectionCollapsed = !state.sectionCollapsed
      scheduleSave()
      scheduleRender(0)
      return
    }
    if (action === 'new-group') {
      editing = { kind: 'new-group', draft: '', parentId: '' }
      openMenuId = null
      scheduleRender(0)
      focusEditor()
      return
    }
    if (action === 'commit-edit') {
      commitEdit()
      return
    }
    if (action === 'cancel-edit') {
      editing = null
      blurActiveInput()
      scheduleRender(0)
      return
    }
    if (action === 'open-manager') {
      openManager()
      return
    }
    var groupId = target.getAttribute('data-group-id') || ''
    var group = findGroup(groupId)
    if (!group) return
    if (action === 'toggle-group') {
      group.collapsed = !group.collapsed
      scheduleSave()
      scheduleRender(0)
    } else if (action === 'group-menu') {
      openMenuId = openMenuId === groupId ? null : groupId
      scheduleRender(0)
    } else if (action === 'rename-group') {
      openMenuId = null
      editing = { kind: 'rename', groupId: groupId, draft: group.name }
      scheduleRender(0)
      focusEditor()
    } else if (action === 'new-subgroup') {
      openMenuId = null
      editing = { kind: 'new-group', draft: '', parentId: group.id }
      scheduleRender(0)
      focusEditor()
    } else if (action === 'move-up' || action === 'move-down') {
      moveGroupWithinSiblings(group, action === 'move-up' ? -1 : 1)
      openMenuId = null
      scheduleSave()
      scheduleRender(0)
    } else if (action === 'delete-group') {
      deleteGroup(group)
      openMenuId = null
      editing = null
      scheduleSave()
      scheduleRender(0)
      if (managerEl) renderManagerBody()
    }
  }

  function onSectionKeydown(event) {
    var input = event.target
    if (!input || input.tagName !== 'INPUT') {
      if (event.key === 'Enter' && event.target.getAttribute && event.target.getAttribute('data-dsg-action') === 'open-session') {
        event.preventDefault()
        var sessionId = event.target.getAttribute('data-session-id')
        if (sessionId) openSession(sessionId)
      }
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      commitEdit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      editing = null
      blurActiveInput()
      scheduleRender(0)
    }
  }

  function onSectionChange() {}

  function focusEditor() {
    setTimeout(function () {
      if (!section) return
      var input = section.querySelector('[data-dsg-input]')
      if (input) {
        input.focus()
        input.select()
      }
    }, 0)
  }

  // --------------------------------------------------------------- manager

  function openManager() {
    if (managerEl) return
    managerEl = el('div', 'dsg-overlay')
    managerEl.setAttribute('data-dsg', 'overlay')
    var panel = el('div', 'dsg-panel')
    var head = el('div', 'dsg-panel-head')
    head.appendChild(el('span', 'dsg-panel-title', '整理会话到分组'))
    var close = el('button', 'dsg-icon-btn', '×')
    close.type = 'button'
    close.setAttribute('data-dsg-action', 'close-manager')
    close.setAttribute('aria-label', '关闭')
    head.appendChild(close)
    panel.appendChild(head)

    var hint = el(
      'div',
      'dsg-panel-hint',
      '这里只是把会话列进你自己新建的侧栏分组，不会改变会话真正所属的工作区；点分组里的会话仍打开同一个对话。',
    )
    panel.appendChild(hint)

    managerBody = el('div', 'dsg-panel-body')
    managerBody.appendChild(el('div', 'dsg-panel-loading', '正在展开工作区…'))
    panel.appendChild(managerBody)

    var foot = el('div', 'dsg-panel-foot')
    foot.appendChild(el('span', 'dsg-panel-foot-text', '改动会自动保存'))
    var done = el('button', 'dsg-btn dsg-btn-primary', '完成')
    done.type = 'button'
    done.setAttribute('data-dsg-action', 'close-manager')
    foot.appendChild(done)
    panel.appendChild(foot)

    managerEl.appendChild(panel)
    managerEl.addEventListener('click', onManagerClick)
    document.body.appendChild(managerEl)
    document.addEventListener('keydown', onDocumentKeydown, true)

    // Refresh the workspace snapshot first: the manager lists sessions straight
    // from the host registry, so newly created workspaces/sessions show up.
    loadRemote()
    expandAll().then(function () {
      scheduleRender(0)
      renderManagerBody()
    })
  }

  function closeManager() {
    if (!managerEl) return
    managerEl.remove()
    managerEl = null
    managerBody = null
    document.removeEventListener('keydown', onDocumentKeydown, true)
  }

  function onDocumentKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeManager()
    }
  }

  function onManagerClick(event) {
    var target = attributeNode(event.target)
    if (target && target.getAttribute('data-dsg-action') === 'close-manager') {
      event.preventDefault()
      closeManager()
      return
    }
    if (event.target === managerEl) closeManager()
  }

  function renderManagerBody() {
    if (!managerBody) return
    scanRows()
    clear(managerBody)

    var sessions = scanRows()
    var seen = {}
    var byWorkspace = []
    for (var w = 0; w < state.workspaces.length; w++) {
      var workspace = state.workspaces[w]
      var items = []
      var ids = workspace.sessionIds || []
      for (var i = 0; i < ids.length; i++) {
        var sessionId = ids[i]
        if (seen[sessionId]) continue
        seen[sessionId] = true
        items.push(sessionId)
      }
      if (items.length > 0) byWorkspace.push({ title: workspace.title || '工作区', sessions: items })
    }
    var straySessions = []
    for (var s = 0; s < sessions.length; s++) {
      if (!seen[sessions[s].id]) {
        seen[sessions[s].id] = true
        straySessions.push(sessions[s].id)
      }
    }
    // sessions that live in our groups but are no longer visible anywhere
    for (var g = 0; g < state.groups.length; g++) {
      var entries = state.groups[g].sessions || []
      for (var e = 0; e < entries.length; e++) {
        var id = typeof entries[e] === 'string' ? entries[e] : entries[e].id
        if (id && !seen[id]) {
          seen[id] = true
          straySessions.push(id)
        }
      }
    }
    if (straySessions.length > 0) byWorkspace.push({ title: '其他会话', sessions: straySessions })

    if (byWorkspace.length === 0) {
      managerBody.appendChild(
        el('div', 'dsg-panel-empty', '没有找到会话。先在工作区视图里创建会话，再回来整理。'),
      )
      return
    }

    for (var k = 0; k < byWorkspace.length; k++) {
      var sectionNode = el('div', 'dsg-panel-section')
      sectionNode.appendChild(el('div', 'dsg-panel-section-title', byWorkspace[k].title))
      var list = byWorkspace[k].sessions
      for (var n = 0; n < list.length; n++) sectionNode.appendChild(renderManagerRow(list[n]))
      managerBody.appendChild(sectionNode)
    }
  }

  function renderManagerRow(sessionId) {
    var row = el('div', 'dsg-panel-row')
    var title = (meta[sessionId] && meta[sessionId].title) || sessionId
    var titleNode = el('span', 'dsg-panel-row-title', title)
    titleNode.title = title
    row.appendChild(titleNode)
    if (archivedSet[sessionId]) row.appendChild(el('span', 'dsg-panel-row-archived', '已归档'))

    var select = el('select', 'dsg-select')
    select.setAttribute('data-dsg-session-select', sessionId)
    var none = el('option', null, '不分组')
    none.value = ''
    select.appendChild(none)
    var options = flattenGroups('', 0)
    for (var i = 0; i < options.length; i++) {
      var prefix = ''
      for (var d = 0; d < options[i].depth; d++) prefix += '· '
      if (prefix) prefix += ' '
      var option = el('option', null, prefix + groupName(options[i].group.name))
      option.value = options[i].group.id
      select.appendChild(option)
    }
    var createOption = el('option', null, '＋ 新建分组并加入')
    createOption.value = '__new'
    select.appendChild(createOption)

    var current = groupIdOfSession(sessionId)
    select.value = current
    select.addEventListener('change', function () {
      var value = select.value
      if (value === '__new') {
        var group = createGroup('新分组')
        assignSession(sessionId, group.id)
        toast('已新建分组：「' + group.name + '」，可在侧栏重命名')
        return
      }
      assignSession(sessionId, value)
    })
    row.appendChild(select)
    return row
  }

  // ------------------------------------------------------------------ boot

  function onWindowError(event) {
    report('window error: ' + (event && event.message ? event.message : 'unknown'), 'error')
  }

  function onWindowRejection(event) {
    report('unhandled rejection: ' + String(event && event.reason), 'error')
  }

  /**
   * Stops this instance before the host loader swaps in a newer client.js.
   * Everything the section owns has to go away: timers, the body observer,
   * injected DOM and the diagnostics listeners.
   */
  function dispose() {
    try {
      disposed = true
      clearTimeout(placeTimer)
      clearTimeout(renderTimer)
      clearTimeout(saveTimer)
      if (observer) {
        observer.disconnect()
        observer = null
      }
      if (bootTimer) {
        clearInterval(bootTimer)
        bootTimer = 0
      }
      for (var t = 0; t < diagTimers.length; t++) clearTimeout(diagTimers[t])
      diagTimers = []
      window.removeEventListener('error', onWindowError)
      window.removeEventListener('unhandledrejection', onWindowRejection)
      closeManager()
      if (section && section.parentElement) section.remove()
      section = null
      sectionHost = null
      var toasts = document.querySelectorAll('.dsg-toast')
      for (var i = 0; i < toasts.length; i++) toasts[i].remove()
      toastCount = 0
      editing = null
      openMenuId = null
    } catch (error) {}
  }

  function boot() {
    try {
      if (disposed) return
      report('boot: build=' + (window.__DSH_SESSION_GROUPS_VERSION__ || 'direct') + ' readyState=' + document.readyState + ' origin=' + location.origin + ' href=' + location.href.slice(0, 160))
      window.addEventListener('error', onWindowError)
      window.addEventListener('unhandledrejection', onWindowRejection)
      loadRemote()
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(function () {
          schedulePlace(220)
        })
        observer.observe(document.body, { childList: true, subtree: true })
      }
      bootTimer = setInterval(function () {
        if (!ensureSection()) return
        var rows = document.querySelectorAll('[data-row-key^="session:"]')
        var signature = sessionSignatureFromRows(rows)
        if (signature !== lastSignature) {
          lastSignature = signature
          scheduleRender(160)
        }
      }, 1800)
      // first attempt after the shell has rendered
      setTimeout(function () {
        schedulePlace(0)
      }, 400)
      // temporarily diagnose layout problems through the host log; only log the
      // delayed passes while the section still failed to mount, so a healthy
      // start keeps the host log quiet.
      diagTimers.push(
        setTimeout(function () {
          if (!reportedMount) diagnoseSection('t+3s')
        }, 3000),
      )
      diagTimers.push(
        setTimeout(function () {
          if (!reportedMount) diagnoseSection('t+9s')
        }, 9000),
      )
    } catch (error) {
      report('boot failed: ' + (error && error.message ? error.message : error), 'error')
    }
  }

  // Exposed so the host loader can stop this instance before re-running a newer
  // build (loader: call dispose, clear the loaded flag, re-append the script).
  window.__DSH_SESSION_GROUPS_DISPOSE__ = dispose

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})()
