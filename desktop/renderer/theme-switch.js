/**
 * 主题切换（日间 / 夜间）。
 *
 * ## 只做一件事
 *
 * 给 `<html>` 加/去 `data-theme="light"`，剩下全靠 styles.css 里的 CSS
 * 变量覆盖。**不要在 JS 里逐个改颜色** —— 那样每加一个控件就要回来补一笔，
 * 迟早有漏的。
 *
 * ## 三处存的值，谁说了算
 *
 *   1. `theme.js`（<head> 里同步跑）：读 localStorage 预热，避免浅色用户
 *      开窗先闪一下深色。**这一步只是快速路径**；
 *   2. 本文件启动时：向主进程要 config.json 里的权威值，校正并回写缓存
 *      —— 换机、清缓存之后仍然正确；
 *   3. 用户点按钮：先切界面（立刻响应），再落盘、再回写缓存。
 *
 * 权威值永远在主进程。主进程侧刻意不向页面注入初始值 —— 那会违反
 * "主进程不向页面注入代码"的安全约定（test/desktop-security.test.js 盯着）。
 *
 * ★ 依赖 dom.js，需排在 app.js 之前 ★
 */

/**
 * 把按钮刷成"当前模式"。图标与文字表达**当前**状态，title 说明点下去会怎样
 * —— 这两者方向相反最容易造成误解，所以 title 里明写"点击切换到…"。
 */
function paintThemeButton(mode) {
  const light = mode === 'light'
  themeIco.textContent = light ? '☀️' : '🌙'
  themeText.textContent = light ? '日间' : '夜间'
  themeBtn.title = light ? '当前：日间模式，点击切换到夜间' : '当前：夜间模式，点击切换到日间'
}

/**
 * 应用主题。返回实际生效的模式（把任何非 'light' 的值都归一成 'dark'）。
 */
function applyTheme(mode) {
  const next = mode === 'light' ? 'light' : 'dark'
  if (next === 'light') document.documentElement.setAttribute('data-theme', 'light')
  else document.documentElement.removeAttribute('data-theme')
  paintThemeButton(next)
  return next
}

/**
 * 启动时校正 + 绑定切换按钮。
 *
 * 校正必须走 applyTheme（而不是只改 attribute）：它还要同步按钮文案，
 * 否则会出现"界面已经是日间、按钮还写着夜间"。
 */
if (themeBtn) {
  ;(async () => {
    let saved = 'light'
    try {
      const cfg = await window.pix.getConfig()
      saved = (cfg && cfg.theme) || 'light'
    } catch (e) {}
    applyTheme(saved)
    try { localStorage.setItem('pix-theme', saved) } catch (e) {}

    themeBtn.onclick = async () => {
      const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
      const next = current === 'light' ? 'dark' : 'light'
      applyTheme(next)                                      // 先切，界面立刻响应
      try { localStorage.setItem('pix-theme', next) } catch (e) {}   // 供下次首帧预热
      try { await window.pix.setTheme(next) } catch (e) {}  // 权威值落盘
    }
  })()
}
