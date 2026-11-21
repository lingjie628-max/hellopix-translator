<template>
  <el-container class="admin-shell">
    <el-menu class="admin-menu" unique-opened router :background-color="menuBg" :text-color="menuText" :active-text-color="menuActive">
      <div class="admin-logo">PIX翻译管理 超管</div>
      <el-menu-item index="/admin/dashboard"><i class="el-icon-data-analysis"></i><span slot="title">总览</span></el-menu-item>
      <el-menu-item index="/admin/tickets">
        <el-badge :value="ticketUnread" :hidden="!ticketUnread" :max="99">
          <i class="el-icon-tickets"></i>
        </el-badge>
        <span slot="title">工单</span>
      </el-menu-item>
      <el-menu-item index="/admin/users"><i class="el-icon-user"></i><span slot="title">商户管理</span></el-menu-item>
      <el-submenu index="ops">
        <template slot="title"><i class="el-icon-s-operation"></i><span>运营</span></template>
        <el-menu-item index="/admin/accounts">在线账号</el-menu-item>
        <el-menu-item index="/admin/fans">进粉统计</el-menu-item>
        <el-menu-item index="/admin/count-tickets">计数工单</el-menu-item>
        <el-menu-item index="/admin/links">分流链接</el-menu-item>
        <el-menu-item index="/admin/scripts">话术回复</el-menu-item>
      </el-submenu>
      <el-submenu index="billing">
        <template slot="title"><i class="el-icon-wallet"></i><span>计费</span></template>
        <el-menu-item index="/admin/packages">套餐管理</el-menu-item>
        <el-menu-item index="/admin/recharges">充值流水</el-menu-item>
        <el-menu-item index="/admin/translate">翻译计费</el-menu-item>
        <el-menu-item index="/admin/engines">翻译通道</el-menu-item>
      </el-submenu>
      <el-submenu index="sys">
        <template slot="title"><i class="el-icon-setting"></i><span>系统</span></template>
        <el-menu-item index="/admin/notices">公告管理</el-menu-item>
        <el-menu-item index="/admin/clients">客户端版本</el-menu-item>
        <el-menu-item index="/admin/support">帮助与客服</el-menu-item>
        <el-menu-item index="/admin/verify">验证码接口</el-menu-item>
        <el-menu-item index="/admin/payments">收款方式</el-menu-item>
        <el-menu-item index="/admin/customers">统一客户</el-menu-item>
        <el-menu-item index="/admin/collision">撞单规则</el-menu-item>
        <el-menu-item index="/admin/mail">邮件服务</el-menu-item>
        <el-menu-item index="/admin/signal">Signal 对接</el-menu-item>
        <el-menu-item index="/admin/settings">系统设置</el-menu-item>
        <el-menu-item index="/admin/logs">登录与审计</el-menu-item>
        <el-menu-item index="/admin/staff">超管账号</el-menu-item>
        <el-menu-item index="/admin/security">账号安全</el-menu-item>
      </el-submenu>
    </el-menu>
    <el-container>
      <el-header class="admin-header">
        <span>{{ $route.name }}</span>
        <span class="admin-header-right">
          <theme-toggle></theme-toggle>
          <!-- 未开启两步验证时常驻提醒：这是全站最高权限账号，值得反复提示 -->
          <router-link v-if="admin.totpEnabled === false" to="/admin/security" class="totp-warn">
            <i class="el-icon-warning"></i> 未开启两步验证
          </router-link>
          {{ admin.nickname || admin.username }}
          <el-button type="text" @click="logout">退出</el-button>
        </span>
      </el-header>
      <el-main>
        <router-view></router-view>
      </el-main>
    </el-container>
  </el-container>
</template>
<script>
import ThemeToggle from '../ThemeToggle.vue'
// 侧栏配色跟随主题：日间用浅色侧栏，夜间用深色（原来的固定深色）
export default {
  components: { ThemeToggle },
  data() {
    return {
      dark: document.documentElement.getAttribute('data-theme') === 'dark',
      ticketUnread: 0
    }
  },
  computed: {
    admin() {
      return this.$store.state.admin || {}
    },
    menuBg() {
      return this.dark ? '#111827' : '#ffffff'
    },
    menuText() {
      return this.dark ? '#cbd5e1' : '#5b6675'
    },
    menuActive() {
      return this.dark ? '#fca5a5' : '#1677ff'
    }
  },
  methods: {
    // 主题变化时同步侧栏配色（ThemeToggle 直接改的是 <html> 属性）
    syncDark() {
      this.dark = document.documentElement.getAttribute('data-theme') === 'dark'
    },
    /**
     * 拉一次未读数。
     *
     * 默认静默失败：这个请求每 60 秒一次，超时或 401 时弹错误框会变成
     * 每隔一分钟糊一次脸。红点消失比报错更合适 —— 它本来只是提示。
     */
    refreshTicketUnread() {
      this.getRequest('/admin/tickets-unread').then(resp => {
        if (!resp || !resp.data) return
        this.ticketUnread = Number(resp.data.unread) || 0
      }).catch(() => {})
    },
    logout() {
      this.stopTicketPolling()
      this.postRequest('/admin/logout')
      this.$store.commit('adminLogout')
      this.$router.replace('/admin/login')
    },
    /**
     * 页面隐藏时暂停轮询，可见时立刻补一次。
     *
     * 后台常开着好几个标签页，不暂停的话每条都比着打接口；
     * visibilitychange 还顺带解决了「切回来时数据是旧的」。
     */
    onVisibilityChange() {
      if (document.hidden) {
        this.stopTicketPolling()
      } else {
        this.refreshTicketUnread()
        this.startTicketPolling()
      }
    },
    startTicketPolling() {
      if (this.ticketTimer || document.hidden) return
      this.ticketTimer = setInterval(() => this.refreshTicketUnread(), 60 * 1000)
    },
    stopTicketPolling() {
      if (!this.ticketTimer) return
      clearInterval(this.ticketTimer)
      this.ticketTimer = null
    }
  },
  mounted() {
    // 定时器句柄不放进 data：它不是渲染状态，放进去每次赋值都触发一轮
    // 依赖收集，而且 Vue 会试图把 Timer ID 变成响应式对象。
    this.ticketTimer = null
    document.addEventListener('pix-theme-change', this.syncDark)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    // 工单页读完一张票会广播这个事件，让侧栏数字立刻跟上
    this.$root.$on('pix-ticket-read', this.refreshTicketUnread)
    this.refreshTicketUnread()
    this.startTicketPolling()
  },
  beforeDestroy() {
    document.removeEventListener('pix-theme-change', this.syncDark)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.$root.$off('pix-ticket-read', this.refreshTicketUnread)
    // 组件销毁必须清定时器，否则退出登录后还在打接口（401 刷屏）
    this.stopTicketPolling()
  }
}
</script>
<style scoped>
.admin-shell {
  height: 100%;
  position: absolute;
  inset: 0;
}
.admin-menu {
  width: 210px;
  text-align: left;
  border-right: none;
  overflow-y: auto;
}
.admin-logo {
  color: var(--w-logo-text);
  font-weight: 700;
  padding: 20px 16px 12px;
  letter-spacing: 0.04em;
  /* 侧栏固定 210px，减去左右 16px 只剩 178px。
     「PIX翻译管理 超管」按 14px 算约 160px，余量本就只有十几像素 ——
     这里必须允许收缩 + 单行，否则字号/系统缩放一变就折成两行，顶栏会变高。 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.admin-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 1px 4px rgba(0,0,0,.08);
  font-size: 15px;
  background: var(--w-surface);
  border-bottom: 1px solid var(--w-border);
}
.admin-header-right {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}
.totp-warn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  text-decoration: none;
  color: var(--w-warning);      /* #b45309 在深色下只有 2.2:1，改用主题 token */
  background: var(--w-warning-soft);
  border: 1px solid rgba(245, 158, 11, 0.35);
}
.totp-warn:hover { background: rgba(245, 158, 11, 0.22); }
</style>
