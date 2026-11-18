'use strict'

/**
 * 进粉事件本地待传队列。
 *
 * 页面观察器发现新私聊后，主进程必须先落盘，再请求服务端。网络断开、接口
 * 超时或客户端在请求途中退出时，同一个 sourceMessageId 会在恢复后重放；
 * 服务端按 (counter_account_id, source_message_id) 幂等，因此不会多计数。
 *
 * 这里保存的只有身份骨架，不保存聊天正文。队列文件属于本机账号数据，和
 * 其他设置一样放在 Electron 的 userData 目录。
 */

const VERSION = 1
const DEFAULT_MAX_ITEMS = 5000
const DEFAULT_MAX_ATTEMPTS = 40
const DEFAULT_BASE_DELAY_MS = 2500
const DEFAULT_MAX_DELAY_MS = 5 * 60 * 1000

function asString (value, max) {
  return String(value == null ? '' : value).slice(0, max || 500)
}

function asTime (value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function copyItem (item) {
  return Object.assign({}, item, {
    payload: item.payload ? Object.assign({}, item.payload) : undefined
  })
}

function itemKey (item) {
  if (item.kind === 'event') {
    const messageId = item.payload && item.payload.sourceMessageId
    return [item.ownerKey, item.localTabId, 'event', messageId].join('|')
  }
  return [item.ownerKey, item.localTabId, item.kind].join('|')
}

class CounterOutbox {
  constructor (deps) {
    const opts = deps || {}
    if (typeof opts.load !== 'function' || typeof opts.save !== 'function') {
      throw new TypeError('CounterOutbox 需要 load/save')
    }
    this.load = opts.load
    this.save = opts.save
    this.now = typeof opts.now === 'function' ? opts.now : Date.now
    this.maxItems = Number(opts.maxItems) || DEFAULT_MAX_ITEMS
    this.maxAttempts = Number(opts.maxAttempts) || DEFAULT_MAX_ATTEMPTS
    this.baseDelayMs = Number(opts.baseDelayMs) || DEFAULT_BASE_DELAY_MS
    this.maxDelayMs = Number(opts.maxDelayMs) || DEFAULT_MAX_DELAY_MS
    this.sequence = 0
    this.data = this._normalize(this.load())
  }

  _normalize (raw) {
    const source = raw && typeof raw === 'object' ? raw : {}
    const rows = Array.isArray(source.items) ? source.items : []
    const items = []
    for (const value of rows) {
      if (!value || typeof value !== 'object') continue
      const kind = value.kind === 'register' || value.kind === 'archive' ? value.kind : 'event'
      const item = {
        id: asString(value.id, 120) || this._newId(),
        kind,
        ownerKey: asString(value.ownerKey, 300),
        localTabId: asString(value.localTabId, 300),
        tabId: asString(value.tabId, 120),
        platform: asString(value.platform, 64),
        label: asString(value.label, 120),
        counterAccountId: Number(value.counterAccountId) > 0 ? Number(value.counterAccountId) : null,
        payload: kind === 'event' && value.payload && typeof value.payload === 'object'
          ? Object.assign({}, value.payload)
          : undefined,
        status: value.status === 'failed' ? 'failed' : 'pending',
        attempts: Math.max(0, Math.floor(Number(value.attempts) || 0)),
        nextAttemptAt: Math.max(0, Number(value.nextAttemptAt) || 0),
        createdAt: asTime(value.createdAt, this.now()),
        updatedAt: asTime(value.updatedAt, this.now()),
        lastError: asString(value.lastError, 500)
      }
      if (!item.ownerKey || !item.localTabId) continue
      if (item.kind === 'event' && (!item.payload || !item.payload.sourceMessageId)) continue
      items.push(item)
    }
    return { version: VERSION, items: items.slice(-this.maxItems) }
  }

  _newId () {
    this.sequence++
    return 'cq-' + this.now().toString(36) + '-' + this.sequence.toString(36)
  }

  _persist () {
    this.save({
      version: VERSION,
      items: this.data.items.map(copyItem)
    })
  }

  _trim () {
    if (this.data.items.length <= this.maxItems) return
    const overflow = this.data.items.length - this.maxItems
    const removable = this.data.items
      .map((item, index) => ({ item, index }))
      .filter(entry => entry.item.status === 'failed')
      .slice(0, overflow)
    const indexes = new Set(removable.map(entry => entry.index))
    if (indexes.size < overflow) {
      for (let i = 0; i < this.data.items.length && indexes.size < overflow; i++) {
        if (!indexes.has(i)) indexes.add(i)
      }
    }
    this.data.items = this.data.items.filter((_, index) => !indexes.has(index))
  }

  enqueue (entry) {
    const data = entry || {}
    const kind = data.kind === 'register' || data.kind === 'archive' ? data.kind : 'event'
    const item = {
      id: this._newId(),
      kind,
      ownerKey: asString(data.ownerKey, 300),
      localTabId: asString(data.localTabId, 300),
      tabId: asString(data.tabId, 120),
      platform: asString(data.platform, 64),
      label: asString(data.label, 120),
      counterAccountId: Number(data.counterAccountId) > 0 ? Number(data.counterAccountId) : null,
      payload: kind === 'event' ? Object.assign({}, data.payload || {}) : undefined,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
      lastError: ''
    }
    if (!item.ownerKey || !item.localTabId) throw new Error('进粉队列缺少账号或实例归属')
    if (item.kind === 'event' && !item.payload.sourceMessageId) throw new Error('进粉队列缺少消息 ID')

    const key = itemKey(item)
    const existing = this.data.items.find(row => itemKey(row) === key)
    if (existing) {
      if (existing.status === 'failed') {
        existing.status = 'pending'
        existing.attempts = 0
        existing.nextAttemptAt = 0
        existing.lastError = ''
        existing.updatedAt = this.now()
        this._persist()
      }
      return copyItem(existing)
    }

    this.data.items.push(item)
    this._trim()
    this._persist()
    return copyItem(item)
  }

  _delayFor (attempts) {
    const exponent = Math.max(0, Math.min(12, Number(attempts) || 0))
    return Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(2, exponent))
  }

  _hasEarlierEvent (item) {
    return this.data.items.some(other =>
      other !== item &&
      other.kind === 'event' &&
      other.ownerKey === item.ownerKey &&
      other.localTabId === item.localTabId &&
      other.createdAt <= item.createdAt
    )
  }

  async flush (options) {
    const opts = options || {}
    const ownerKey = asString(opts.ownerKey, 300)
    const resolve = opts.resolve
    const limit = Math.max(1, Math.floor(Number(opts.limit) || 1000))
    if (!ownerKey || typeof resolve !== 'function') {
      return { sent: 0, failed: 0, skipped: 0, pending: this.status(ownerKey).pending }
    }

    const now = this.now()
    const candidates = this.data.items
      .filter(item =>
        item.ownerKey === ownerKey &&
        item.status === 'pending' &&
        item.nextAttemptAt <= now
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, limit)

    let sent = 0
    let failed = 0
    let skipped = 0
    for (const item of candidates) {
      if (!this.data.items.includes(item)) continue
      if (item.kind === 'archive' && this._hasEarlierEvent(item)) {
        skipped++
        continue
      }
      try {
        const result = await resolve(copyItem(item))
        this.data.items = this.data.items.filter(row => row.id !== item.id)
        sent++
        if (typeof opts.onSuccess === 'function') {
          try { opts.onSuccess(copyItem(item), result || null) } catch (e) {}
        }
      } catch (error) {
        failed++
        item.attempts++
        item.updatedAt = this.now()
        item.lastError = asString((error && error.message) || error, 500)
        item.nextAttemptAt = this.now() + this._delayFor(item.attempts)
        if (error && error.permanent) item.status = 'failed'
        else if (item.attempts >= this.maxAttempts) item.status = 'failed'
        if (typeof opts.onError === 'function') {
          try { opts.onError(copyItem(item), error) } catch (e) {}
        }
      }
      this._persist()
    }
    return { sent, failed, skipped, pending: this.status(ownerKey).pending }
  }

  retryFailed (ownerKey) {
    const owner = asString(ownerKey, 300)
    let changed = 0
    for (const item of this.data.items) {
      if (item.ownerKey !== owner) continue
      if (item.status !== 'failed' && !item.lastError) continue
      item.status = 'pending'
      item.attempts = 0
      item.nextAttemptAt = 0
      item.lastError = ''
      item.updatedAt = this.now()
      changed++
    }
    if (changed) this._persist()
    return changed
  }

  status (ownerKey) {
    const owner = ownerKey == null ? '' : asString(ownerKey, 300)
    const rows = this.data.items.filter(item => !owner || item.ownerKey === owner)
    const pending = rows.filter(item => item.status === 'pending')
    const failed = rows.filter(item => item.status === 'failed')
    const errored = failed.length
      ? failed
      : pending.filter(item => !!item.lastError)
    const next = pending
      .map(item => item.nextAttemptAt)
      .filter(value => Number.isFinite(value))
      .sort((a, b) => a - b)[0]
    return {
      pending: pending.length,
      failed: failed.length,
      nextAttemptAt: Number.isFinite(next) ? next : 0,
      lastError: errored.length
        ? errored.sort((a, b) => b.updatedAt - a.updatedAt)[0].lastError
        : ''
    }
  }
}

module.exports = {
  CounterOutbox,
  VERSION,
  DEFAULT_MAX_ATTEMPTS
}
