<template>
  <button type="button" class="theme-toggle" :title="title" @click="toggle">
    <span>{{ isDark ? '🌙' : '☀️' }}</span>
    <span>{{ isDark ? '夜间' : '日间' }}</span>
  </button>
</template>

<script>
// 日间 / 夜间切换。默认日间；用户手动切过才记住（与桌面客户端同一套约定）。
// 主题实现只做一件事：给 <html> 加/去 data-theme="dark"，
// 具体配色全部由 src/assets/theme.css 的变量承担。
const STORAGE_KEY = 'pix-web-theme'

export default {
  name: 'ThemeToggle',
  data() {
    return { isDark: false }
  },
  computed: {
    title() {
      return this.isDark ? '当前：夜间模式，点击切换到日间' : '当前：日间模式，点击切换到夜间'
    }
  },
  created() {
    this.isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  },
  methods: {
    toggle() {
      this.isDark = !this.isDark
      if (this.isDark) document.documentElement.setAttribute('data-theme', 'dark')
      else document.documentElement.removeAttribute('data-theme')
      try {
        // 只记用户主动选过的值，供下次首帧预热使用
        localStorage.setItem(STORAGE_KEY, this.isDark ? 'dark' : 'light')
      } catch (e) {}
      // 通知页面里需要跟着主题变的部分（例如后台侧栏是用 prop 传色的 el-menu，
      // 不是纯 CSS 变量能覆盖的），它们监听这个事件自行更新
      document.dispatchEvent(new CustomEvent('pix-theme-change', { detail: { dark: this.isDark } }))
    }
  }
}
</script>
