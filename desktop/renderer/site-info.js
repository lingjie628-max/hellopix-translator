/**
 * 站点信息：客服入口、页脚链接、下载入口、独立应用版。
 *
 * ## 为什么单拎出来
 *
 * 这一整块只跟服务端下发的 `/apis/site/info` 有关，跟标签栏、翻译、账号
 * 余额完全无关。留在 app.js 里的唯一下场就是被当成"顺手能改的地方"，
 * 而它有个很脆的约定：**下载入口的显隐必须跟着真实上架情况走**（见
 * syncFooterDownloads 的注释）。把这条约定和它的实现放在同一个文件里，
 * 比散在一千四百行的 app.js 里可靠得多。
 *
 * ## 依赖方向
 *
 * 只用 dom.js 的元素句柄 + ui-kit.js 的 showOverlay。
 * 反过来它被 app.js（启动时拉一次站点信息）和页脚点击调用。
 *
 * ★ 必须排在 app.js 之前 ★
 */


let supportUrl = ''
let supportNote = ''
let footerOfficialUrl = ''
let footerGuideUrl = ''
let footerDownloads = {}

/** 下面这几个 setter 只读写 app.js 的权威状态，实际的值仍归 app.js 所有 */

function siteSupport(info) {
  const d = (info && (info.data || info)) || {}
  const url = String(d.telegramUrl || '').trim()
  const account = String(d.telegram || '').trim()
  return {
    url: url || (account ? 'https://t.me/' + account.replace(/^@/, '') : ''),
    note: String(d.supportNote || ''),
    btnText: d.supportBtnText || '联系客服',
    show: Number(d.supportShow) !== 0,
    officialUrl: String(d.officialUrl || d.websiteUrl || ''),
    guideUrl: String(d.guideUrl || ''),
    downloads: Object.assign({ app: String(d.clientDownloadUrl || '') }, d.clientDownloads || {})
  }
}

function applySupport(info) {
  const s = siteSupport(info)
  supportUrl = s.url
  supportNote = s.note
  footerOfficialUrl = s.officialUrl
  footerGuideUrl = s.guideUrl
  footerDownloads = s.downloads
  supportBtn.textContent = s.btnText
  supportBtn.style.display = s.show ? '' : 'none'
  syncFooterDownloads(s.downloads)
}

/**
 * 纯函数：某个下载入口在当前下发数据下是否该显示。
 *
 * 刻意与 DOM 操作分开，是为了能被测试**直接执行** —— 渲染层没有 DOM 环境
 * （仓库里没有 jsdom），抽不出纯逻辑的话就只能退化成正则匹配源码，那测不出
 * "点击是否真的会失效"这种语义。
 */
function footerDownloadVisible(key, downloads) {
  // app 走 checkUpdate()，不依赖 downloads.app，因此不能按 URL 判断。
  if (key === 'app') return true
  // standalone 走 standaloneApps：**只有真有在架独立应用时才显示**。
  // 曾经写死返回 true，于是"套餐承诺了独立应用版、实际一条 standalone 发布记录
  // 都没有"时按钮照样出现 —— 用户点下去只得到「独立应用尚未上架」。那正是迁移
  // 036 要摘掉的那类"有权益、没东西"。改成按数据显隐之后，将来登记了发布记录
  // 就会自动重新出现，不必再发一次客户端。
  if (key === 'standalone') {
    const apps = (downloads || {}).standaloneApps
    return Array.isArray(apps) && apps.some(item => item && item.url)
  }
  return Boolean(String((downloads || {})[key] || ''))
}

/**
 * 让底部下载入口按**真实上架情况**显隐。
 *
 * 背景：index.html 里「安卓手机版」「苹果手机版」是静态写死的按钮，而产品
 * 没有任何移动端 —— 服务端 `clientDownloads.android` / `.ios` 下发的是空字符串
 * （core-service.js 的 `download()` 在 client_releases 里找不到记录就返回 ''，
 * 2026-09-27 在生产 /apis/site/info 上实测确实为空）。
 *
 * 于是用户点下去**毫无反应**：`runFooterAction` 对空 URL 直接 `return`，
 * 既不打开链接也不报错，看起来就是"软件坏了"。这与迁移 035 的结论也直接冲突 ——
 * 035 刚把「手机版」这个兑现不了的权益承诺从套餐文案里摘掉，客户端底部却还在
 * 暗示有两个手机版可以下载。（「独立应用版」是同一种病，见迁移 036。）
 *
 * 三点讲究：
 *
 *   1. 用**排除法**而不是白名单：除了 app 这一个特例（它走 checkUpdate），其余
 *      一律"没东西可下就不显示"。这样以后新增任何下载入口都自动安全，不会又冒
 *      出一个死按钮 —— 白名单会让新入口默认可见。
 *   2. standalone **也**按数据显隐（见 footerDownloadVisible）：它曾经是第二个
 *      特例、恒显。恒显的代价是"有权益、没东西"时按钮还在，点下去只得到
 *      「独立应用尚未上架」—— 与迁移 036 摘「独立应用版」的理由直接冲突。
 *   3. 是**显隐**而不是删按钮：哪天移动端 / 独立应用真上架、后台配了发布记录，
 *      按钮自动出现，不需要再改客户端代码、也就不必再发一次版。
 */
function syncFooterDownloads(downloads) {
  document.querySelectorAll('[data-footer-action="download"]').forEach(btn => {
    const key = btn.dataset.downloadKey || ''
    btn.style.display = footerDownloadVisible(key, downloads) ? '' : 'none'
  })
}

async function loadSupport() {
  try {
    applySupport(await window.pix.siteInfo())
  } catch (e) {}
}

async function openSupport() {
  await loadSupport()
  if (supportUrl) window.pix.openUrl(supportUrl)
}

async function runFooterAction(action, downloadKey) {
  await loadSupport()
  if (action === 'support') return openSupport()
  if (action === 'official' && footerOfficialUrl) return window.pix.openUrl(footerOfficialUrl)
  if (action === 'guide') {
    if (footerGuideUrl) return window.pix.openUrl(footerGuideUrl)
    return openSupport()
  }
  if (action === 'download') {
    if (downloadKey === 'standalone') return openStandaloneDownload()
    const url = String(footerDownloads[downloadKey] || '')
    if (url) return window.pix.openUrl(url)
    if (downloadKey !== 'app') return
    const resp = await window.pix.checkUpdate()
    if (resp && resp.url) return window.pix.openUrl(resp.url)
    if (resp && resp.remote && cmpVer(resp.remote, resp.local) > 0) showUpdateNotice(resp)
  }
}

function standaloneApps() {
  return (footerDownloads.standaloneApps || []).filter(item => item && item.url)
}

function showStandaloneNotice(message) {
  standaloneTitle.textContent = '独立应用版'
  standaloneMsg.textContent = message
  standaloneList.innerHTML = ''
  showOverlay(standalonePanel, true)
}

function showStandalonePicker(apps) {
  standaloneTitle.textContent = '选择独立应用'
  standaloneMsg.textContent = '请选择要下载的单应用翻译客户端。'
  standaloneList.innerHTML = apps.map(item => {
    const name = esc(item.title || item.app || '独立应用')
    const meta = esc([item.version, item.os].filter(Boolean).join(' · '))
    return '<button type="button" data-url="' + esc(item.url) + '"><b>' + name + '</b><span>' + meta + '</span></button>'
  }).join('')
  showOverlay(standalonePanel, true)
}

function openStandaloneDownload() {
  if (!current || Number(current.standaloneClient) !== 1) {
    return showStandaloneNotice('当前套餐未包含独立应用版')
  }
  const apps = standaloneApps()
  if (!apps.length) return showStandaloneNotice('独立应用尚未上架')
  if (apps.length === 1) return window.pix.openUrl(apps[0].url)
  return showStandalonePicker(apps)
}
