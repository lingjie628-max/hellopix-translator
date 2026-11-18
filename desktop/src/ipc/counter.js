'use strict'

const { CounterOutbox } = require('../counter/outbox')

const WHATSAPP_PLATFORMS = new Set(['whatsapp-green', 'whatsapp-pro', 'whatsapp-biz'])
const RETRY_IDLE_MS = 30_000

/**
 * 进粉计数 IPC。
 *
 * 客页只能发“收到一条私聊”的身份骨架，平台、实例归属、设备 ID 和当前主账号
 * 全部由主进程补。事件先进入本地待传队列再请求服务端，断网恢复后用同一个
 * sourceMessageId 重放，服务端唯一约束保证不重复计数。
 */
function registerCounterIpc (deps) {
  const { reg, actions, env } = deps
  const state = deps.state || {}
  const store = env.outbox
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new Error('CounterOutbox 本地存储未配置')
  }
  const outbox = deps.outbox || new CounterOutbox(store)
  const accountCache = new Map()
  let flushPromise = null
  let flushTimer = null
  let stopped = false

  function currentOwner () {
    try {
      return String(actions.ownerKey ? actions.ownerKey() : '')
    } catch (e) {
      return ''
    }
  }

  function tabs () {
    try {
      return Array.isArray(state.tabs) ? state.tabs : []
    } catch (e) {
      return []
    }
  }

  function tabMeta (tab) {
    return {
      ownerKey: currentOwner(),
      localTabId: env.slot() + ':' + tab.id,
      tabId: String(tab.id || ''),
      platform: String(tab.platform || ''),
      label: String(tab.name || tab.title || 'WhatsApp 账号').slice(0, 120)
    }
  }

  function tabOf (id) {
    const wanted = String(id || '')
    return tabs().find(tab => String(tab.id) === wanted) || null
  }

  function cacheKey (tab) {
    return [
      tab.id,
      tab.partition || '',
      tab.platform || '',
      tab.name || tab.title || ''
    ].join('|')
  }

  function apiResult (result, fallback) {
    if (result && result.success === false) {
      const error = new Error(result.msg || fallback || '请求失败')
      error.code = String(result.code || '')
      error.permanent = /^(COUNTER_.*_(REQUIRED|INVALID|BAD_ID|BAD_KIND|BAD_DATE)|COUNTER_PLATFORM_INVALID)$/.test(error.code) ||
        error.code === 'DEVICE_REQUIRED'
      throw error
    }
    return result
  }

  async function registerMeta (meta) {
    const result = apiResult(await actions.api('/counter/accounts/register', {
      method: 'POST',
      form: {
        localTabId: meta.localTabId,
        platform: meta.platform,
        label: meta.label,
        enabled: true
      }
    }), '计数账号登记失败')
    if (!result || !result.id) throw new Error('计数账号登记失败')
    return result
  }

  async function ensureAccount (tab) {
    if (!tab || !tab.settings || tab.settings.enableCounter !== true) return null
    const key = cacheKey(tab)
    const cached = accountCache.get(key)
    if (cached && Date.now() - cached.at < 30_000) return cached.account
    const account = await registerMeta(tabMeta(tab))
    accountCache.set(key, { account, at: Date.now() })
    return account
  }

  function findLocalAccount (accounts, localTabId) {
    return (Array.isArray(accounts) ? accounts : [])
      .find(account => String(account.local_tab_id || '') === String(localTabId || '')) || null
  }

  async function archiveLocalAccount (item) {
    const accounts = apiResult(await actions.api('/counter/accounts?includeArchived=1'), '读取计数账号失败')
    const account = item.counterAccountId
      ? { id: item.counterAccountId }
      : findLocalAccount(accounts, item.localTabId)
    if (!account) return { ok: true, archived: 0 }
    try {
      apiResult(await actions.api('/counter/accounts/archive', {
        method: 'POST',
        form: { id: account.id }
      }), '归档计数账号失败')
    } catch (error) {
      if (error.code === 'COUNTER_ACCOUNT_NOT_FOUND') return { ok: true, archived: 0 }
      throw error
    }
    return { ok: true, archived: 1 }
  }

  async function resolveQueueItem (item) {
    if (item.kind === 'register') {
      const account = await registerMeta(item)
      return { status: 'registered', accountId: account.id }
    }
    if (item.kind === 'archive') {
      return archiveLocalAccount(item)
    }

    const data = item.payload || {}
    if (!data.sourceMessageId || !data.peerKey || !data.sentAt) {
      const error = new Error('计数事件字段不完整')
      error.permanent = true
      throw error
    }

    let accountId = Number(item.counterAccountId) || 0
    if (!accountId) {
      const account = await registerMeta(item)
      accountId = Number(account.id) || 0
    }
    if (!accountId) throw new Error('计数账号登记失败')

    const result = apiResult(await actions.api('/counter/inbound', {
      method: 'POST',
      requestId: String(data.sourceMessageId).slice(0, 120),
      form: Object.assign({}, data, {
        counterAccountId: accountId,
        platform: item.platform
      })
    }), '进粉事件上报失败')
    return result || { status: 'ok' }
  }

  function scheduleFlush (delayMs) {
    if (stopped || flushTimer) return
    const owner = currentOwner()
    if (!owner) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        scheduleFlush(RETRY_IDLE_MS)
      }, RETRY_IDLE_MS)
      if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref()
      return
    }
    const status = outbox.status(owner)
    if (!status.pending) return
    let wait = Math.max(0, Number(delayMs) || 0)
    if (!delayMs && status.nextAttemptAt) wait = Math.max(1000, status.nextAttemptAt - Date.now())
    if (!wait) wait = 1000
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushNow().finally(() => {
        const next = outbox.status(currentOwner())
        scheduleFlush(next.pending ? 0 : RETRY_IDLE_MS)
      })
    }, Math.min(wait, RETRY_IDLE_MS))
    if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref()
  }

  function flushNow () {
    if (flushPromise) return flushPromise
    const owner = currentOwner()
    if (!owner) return Promise.resolve({ sent: 0, failed: 0, skipped: 0, pending: 0 })
    flushPromise = outbox.flush({
      ownerKey: owner,
      resolve: resolveQueueItem,
      onSuccess: (item, result) => {
        if (item.kind !== 'event') return
        if (actions.log) {
          actions.log('counter', 'tab=' + item.tabId + ' status=' + String(result && result.status || '?') +
            ' ticket=' + String(result && result.ticketId || '-'))
        }
        if (actions.sendToMain) {
          try {
            actions.sendToMain('counter:updated', {
              tabId: item.tabId,
              status: result && result.status,
              ticketId: result && result.ticketId,
              customerId: result && result.customerId,
              summary: result && result.summary
            })
          } catch (e) {}
        }
      },
      onError: (item, error) => {
        if (actions.log) {
          actions.log('error', 'counter', '进粉事件待重试 tab=' + item.tabId +
            ' kind=' + item.kind + ' attempts=' + item.attempts + ' ' +
            String((error && error.message) || error))
        }
      }
    }).finally(() => {
      flushPromise = null
    })
    return flushPromise
  }

  function enqueueEvent (tab, payload) {
    const meta = tabMeta(tab)
    return outbox.enqueue(Object.assign(meta, {
      kind: 'event',
      payload: Object.assign({}, payload, { platform: tab.platform })
    }))
  }

  function enqueueCommand (tab, kind) {
    return outbox.enqueue(Object.assign(tabMeta(tab), { kind }))
  }

  reg.handleUnsafe('counter:candidate', async (event, payload) => {
    const tab = actions.trustedTabSender(event.sender)
    if (!tab) return { success: false, msg: '标签页未授权' }
    if (!tab.settings || tab.settings.enableCounter !== true) {
      return { success: true, status: 'ignored', reason: 'counter_disabled' }
    }
    const data = payload || {}
    if (!data.sourceMessageId || !data.peerKey || !data.sentAt) {
      return { success: false, msg: '计数事件字段不完整' }
    }
    if (!currentOwner()) return { success: false, msg: '请先登录' }
    try {
      const queued = enqueueEvent(tab, data)
      scheduleFlush(0)
      const flushed = await flushNow()
      const status = outbox.status(currentOwner())
      return {
        success: true,
        queued: true,
        eventId: queued.id,
        flushed: flushed.sent,
        pending: status.pending,
        failed: status.failed
      }
    } catch (e) {
      return { success: false, msg: String((e && e.message) || e) }
    }
  })

  reg.handle('counter:summary', async (event, query) => actions.api('/counter/summary?' + env.qs(query)))
  reg.handle('counter:events', async (event, query) => actions.api('/counter/events?' + env.qs(query)))
  reg.handle('counter:repeats', async (event, query) => actions.api('/counter/repeats?' + env.qs(query)))
  reg.handle('counter:accounts', async (event, query) =>
    actions.api('/counter/accounts?' + env.qs(query)))
  reg.handle('counter:archiveAccount', async (event, id) =>
    actions.api('/counter/accounts/archive', { method: 'POST', form: { id } }))
  reg.handle('counter:tickets', async (event, query) => actions.api('/counter/tickets?' + env.qs(query)))
  reg.handle('counter:ticket', async (event, id) => actions.api('/counter/tickets/' + encodeURIComponent(String(id))))
  reg.handle('counter:ticketTransition', async (event, data) =>
    actions.api('/counter/tickets/transition', { method: 'POST', form: data || {} }))
  reg.handle('counter:ticketReply', async (event, data) =>
    actions.api('/counter/tickets/reply', { method: 'POST', form: data || {} }))

  reg.handle('counter:tabs', () => {
    return tabs()
      .filter(tab => WHATSAPP_PLATFORMS.has(tab.platform))
      .map(tab => ({
        id: String(tab.id || ''),
        platform: String(tab.platform || ''),
        name: String(tab.name || tab.title || 'WhatsApp 账号'),
        title: String(tab.title || ''),
        hidden: !!tab.hidden,
        enableCounter: !!(tab.settings && tab.settings.enableCounter === true),
        localTabId: env.slot() + ':' + tab.id
      }))
  })

  reg.handle('counter:toggleTab', async (event, payload) => {
    const data = payload || {}
    const tab = tabOf(data.id)
    if (!tab || !WHATSAPP_PLATFORMS.has(tab.platform)) {
      return { success: false, msg: '不是 WhatsApp 实例' }
    }
    const enabled = data.enabled === true
    if (actions.updateTabSettings) {
      const updated = await actions.updateTabSettings(tab.id, { enableCounter: enabled })
      if (updated && updated.success === false) return updated
    }
    accountCache.clear()
    enqueueCommand(tab, enabled ? 'register' : 'archive')
    scheduleFlush(0)
    await flushNow()
    const status = outbox.status(currentOwner())
    if (actions.sendToMain) {
      try { actions.sendToMain('counter:updated', { tabId: tab.id, status: enabled ? 'enabled' : 'disabled' }) } catch (e) {}
    }
    return { success: true, enabled, queue: status }
  })

  reg.handle('counter:queueStatus', () => {
    // 登录后用户第一次打开进粉中心时立即补传，不必等空闲轮询的 30 秒。
    if (currentOwner()) flushNow().catch(() => {})
    return outbox.status(currentOwner())
  })
  reg.handle('counter:retryFailed', async () => {
    const changed = outbox.retryFailed(currentOwner())
    scheduleFlush(0)
    const flushed = await flushNow()
    return { success: true, changed, flushed }
  })
  reg.handle('counter:flush', async () => {
    const result = await flushNow()
    return { success: true, result, status: outbox.status(currentOwner()) }
  })

  scheduleFlush(RETRY_IDLE_MS)

  return {
    flushNow,
    status: () => outbox.status(currentOwner()),
    async archiveTab (tab) {
      if (!tab || !WHATSAPP_PLATFORMS.has(tab.platform) || !currentOwner()) return false
      enqueueCommand(tab, 'archive')
      scheduleFlush(0)
      try { await flushNow() } catch (e) {}
      return true
    },
    stop () {
      stopped = true
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = null
    }
  }
}

module.exports = { registerCounterIpc, WHATSAPP_PLATFORMS }
