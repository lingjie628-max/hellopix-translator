'use strict'

/**
 * 厂商原始延迟探针 —— 在服务端本机直接打厂商 API，**绕开我们的服务端逻辑**。
 *
 * 目的：把「用户感知的翻译耗时」拆成三段，才能知道该优化哪一段：
 *
 *   厂商首字节(TTFB)  +  厂商生成完  +  我们的服务端开销  =  用户看到的时间
 *
 * 同时对比 `stream:true` 与 `stream:false`：
 *   - stream:false 必须等**整段生成完**才返回，一个词也要等模型说完；
 *   - stream:true 首字节到达即返回，用户能立刻看到译文开始出现。
 *
 * 跑法（必须在部署机上，读 /etc/hello-pix/hello-pix.env 里的 Key）：
 *   node scripts/probe-vendor-latency.js --runs 10
 */

const path = require('path')

const ROOT = path.join(__dirname, '..')
const creds = require(path.join(ROOT, 'server/lib/credentials'))

function arg (name, dflt) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return (v === undefined || v.startsWith('--')) ? true : v
}
const RUNS = Math.max(1, Number(arg('runs', 10)))

const { Pool } = require('pg')

// 多语言的短句 —— 用户抱怨的正是"其他语言没变快"。
const SAMPLES = [
  { from: 'en', to: 'zh', text: 'See you tomorrow at the station.' },
  { from: 'ja', to: 'zh', text: '明日の駅で会いましょう。' },
  { from: 'ko', to: 'zh', text: '내일 역에서 만나요.' },
  { from: 'ru', to: 'zh', text: 'Увидимся завтра на станции.' },
  { from: 'es', to: 'zh', text: 'Nos vemos mañana en la estación.' },
  { from: 'zh', to: 'en', text: '明天在车站见。' }
]

const LANG_NAMES = { en: 'English', zh: 'Simplified Chinese', ja: 'Japanese', ko: 'Korean', ru: 'Russian', es: 'Spanish' }

function buildSystem (from, to) {
  return [
    '你是专业翻译引擎。',
    `把用户给出的文本翻译成${LANG_NAMES[to] || to}。源语言是${LANG_NAMES[from] || from}。`,
    '要求：',
    '1. 只输出译文本身，不要解释、不要加引号、不要重复原文；',
    '2. 保留原文的换行、标点风格与占位符；',
    '3. 专有名词、代码、链接、@用户名 原样保留。'
  ].join('\n')
}

async function timedFetch (url, init, mode) {
  const t0 = Date.now()
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error('HTTP ' + res.status + ' ' + body.slice(0, 200))
  }
  const tHead = Date.now()
  let ttfb = null
  let tDone
  let out = ''
  if (mode === 'stream') {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (ttfb == null) ttfb = Date.now()
      buf += decoder.decode(value, { stream: true })
      // SSE: 每个 `data: {...}` 是一块增量
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const j = JSON.parse(payload)
          const d = j.choices && j.choices[0] && j.choices[0].delta
          if (d && d.content) out += d.content
        } catch (e) { /* 不完整的一行，留着 */ }
      }
    }
    tDone = Date.now()
  } else {
    const j = await res.json()
    ttfb = tHead
    tDone = Date.now()
    out = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''
  }
  return { ttfb: ttfb - t0, total: tDone - t0, out: out.trim() }
}

function pct (arr, p) {
  if (!arr.length) return 0
  const s = arr.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

async function main () {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const rows = (await pool.query(
    "select id, model, endpoint, api_key_ciphertext from engines where id in ('gpt','deepseek')"
  )).rows
  await pool.end()

  const engines = []
  for (const r of rows) {
    let key = ''
    try { key = creds.decryptSecret(r.api_key_ciphertext) } catch (e) {
      console.log('无法解密 ' + r.id + ' 的 Key：' + e.message)
      continue
    }
    engines.push({
      id: r.id,
      model: r.model,
      endpoint: r.endpoint.replace(/\/+$/, '') + '/chat/completions',
      key
    })
  }
  if (!engines.length) { console.log('没有可用凭据'); return }

  const stats = {}
  for (const eng of engines) {
    for (const mode of ['stream', 'json']) {
      const k = eng.id + '/' + mode
      stats[k] = { ttfb: [], total: [] }
      for (let i = 0; i < RUNS; i++) {
        const s = SAMPLES[i % SAMPLES.length]
        const isReasoning = /^(o\d|gpt-5)/i.test(eng.model)
        const body = {
          model: eng.model,
          messages: [
            { role: 'system', content: buildSystem(s.from, s.to) },
            { role: 'user', content: s.text }
          ],
          stream: mode === 'stream'
        }
        // 推理类模型（gpt-5 / o 系）固定采样参数，传 temperature 会 400；
        // 输出长度字段也得用 max_completion_tokens。
        if (isReasoning) {
          body.max_completion_tokens = 512
          body.reasoning_effort = 'low'
        } else {
          body.max_tokens = 512
          body.temperature = 0
        }
        if (eng.id === 'deepseek') body.thinking = { type: 'disabled' }
        try {
          const r = await timedFetch(eng.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + eng.key },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30000)
          }, mode)
          stats[k].ttfb.push(r.ttfb)
          stats[k].total.push(r.total)
          if (i === 0) console.log('  样例 [' + k + '] ' + s.text + ' -> ' + r.out.slice(0, 40))
        } catch (e) {
          console.log('  失败 [' + k + '] ' + e.message.slice(0, 100))
        }
      }
    }
  }

  console.log('\n' + '='.repeat(78))
  console.log(' 厂商原始延迟（本机直连，不含我们的服务端开销）')
  console.log('='.repeat(78))
  console.log(' 通道            首字节P50  首字节P95   总耗时P50  总耗时P95   样本')
  for (const [k, v] of Object.entries(stats)) {
    if (!v.total.length) continue
    console.log(' ' + k.padEnd(15) +
      String(pct(v.ttfb, 0.5) + 'ms').padStart(9) +
      String(pct(v.ttfb, 0.95) + 'ms').padStart(10) +
      String(pct(v.total, 0.5) + 'ms').padStart(11) +
      String(pct(v.total, 0.95) + 'ms').padStart(10) +
      String(v.total.length).padStart(7))
  }
}

main().catch(e => { console.error('探针异常：', e); process.exit(1) })
