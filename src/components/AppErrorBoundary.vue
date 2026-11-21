<template>
  <div class="app-error-boundary-root">
    <div v-if="error" class="app-error-boundary" role="alert">
      <div class="app-error-card">
        <div class="app-error-code">UI ERROR</div>
        <h1>页面加载失败</h1>
        <p>当前页面组件发生了异常。页面已切换到安全兜底，不会再显示整页空白。</p>
        <div class="app-error-actions">
          <button type="button" class="is-primary" @click="reload">重新加载</button>
          <button type="button" @click="goHome">返回{{ isAdmin ? '后台' : '商户' }}首页</button>
        </div>
        <details>
          <summary>技术信息</summary>
          <code>{{ error.message || error }}<template v-if="info"> · {{ info }}</template><template v-if="routePath"> · {{ routePath }}</template></code>
        </details>
      </div>
    </div>
    <slot v-else></slot>
  </div>
</template>

<script>
export default {
  name: 'AppErrorBoundary',
  data() {
    return {
      error: null,
      info: '',
      routePath: ''
    }
  },
  computed: {
    isAdmin() {
      return Boolean(this.$route && String(this.$route.path || '').indexOf('/admin') === 0)
    }
  },
  watch: {
    '$route.fullPath'() {
      this.error = null
      this.info = ''
      this.routePath = ''
    }
  },
  errorCaptured(error, _vm, info) {
    if (!this.error) {
      this.error = error || new Error('未知页面渲染错误')
      this.info = String(info || '')
      this.routePath = this.$route ? String(this.$route.fullPath || '') : ''
      try {
        // 保留控制台原文，方便客服让用户截 Console；页面本身不会再白屏。
        console.error('[hello-pix-ui]', error === undefined ? '' : error, info || '')
      } catch (_) {}
    }
    // 阻止异常继续冒泡，Vue 会保留本组件并渲染上面的兜底卡片。
    return false
  },
  methods: {
    reload() {
      window.location.reload()
    },
    goHome() {
      const target = this.isAdmin ? '/admin/dashboard' : '/home/index'
      this.error = null
      this.info = ''
      this.routePath = ''
      const job = this.$router.replace(target)
      if (job && typeof job.catch === 'function') job.catch(() => {})
    }
  }
}
</script>

<style scoped>
.app-error-boundary-root {
  display: contents;
}
.app-error-boundary {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
  box-sizing: border-box;
  color: var(--w-text, #263241);
  background: radial-gradient(circle at 50% 20%, rgba(64, 158, 255, .12), transparent 42%), var(--w-bg, #f5f8fb);
}
.app-error-card {
  width: min(620px, 100%);
  padding: 36px;
  text-align: left;
  border: 1px solid rgba(113, 132, 153, .2);
  border-radius: 18px;
  background: var(--w-panel, #fff);
  box-shadow: 0 24px 70px rgba(26, 45, 66, .14);
}
.app-error-code {
  color: #c26a17;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .18em;
}
.app-error-card h1 {
  margin: 10px 0 10px;
  font-size: 28px;
}
.app-error-card p {
  margin: 0;
  color: var(--w-text-faint, #6d7b89);
  line-height: 1.75;
}
.app-error-actions {
  display: flex;
  gap: 10px;
  margin-top: 24px;
}
.app-error-actions button {
  padding: 10px 18px;
  border: 1px solid #c9d3dd;
  border-radius: 9px;
  color: var(--w-text, #263241);
  background: transparent;
  cursor: pointer;
}
.app-error-actions button.is-primary {
  border-color: #409eff;
  color: #fff;
  background: #409eff;
}
.app-error-card details {
  margin-top: 22px;
  color: var(--w-text-faint, #6d7b89);
}
.app-error-card summary {
  cursor: pointer;
}
.app-error-card code {
  display: block;
  margin-top: 10px;
  padding: 12px;
  overflow-wrap: anywhere;
  border-radius: 8px;
  background: rgba(113, 132, 153, .1);
  font-size: 12px;
  line-height: 1.6;
}
</style>
