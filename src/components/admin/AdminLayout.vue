<template>
  <el-container class="admin-shell">
    <el-menu class="admin-menu" unique-opened router :background-color="menuBg" :text-color="menuText" :active-text-color="menuActive">
      <div class="admin-logo">Hello Pix 超管</div>
      <el-menu-item index="/admin/dashboard"><i class="el-icon-data-analysis"></i><span slot="title">总览</span></el-menu-item>
      <el-menu-item index="/admin/users"><i class="el-icon-user"></i><span slot="title">商户管理</span></el-menu-item>
      <el-submenu index="ops">
        <template slot="title"><i class="el-icon-s-operation"></i><span>运营</span></template>
        <el-menu-item index="/admin/orders">全部工单</el-menu-item>
        <el-menu-item index="/admin/accounts">在线账号</el-menu-item>
        <el-menu-item index="/admin/fans">进粉统计</el-menu-item>
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
    return { dark: document.documentElement.getAttribute('data-theme') === 'dark' }
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
    logout() {
      this.postRequest('/admin/logout')
      this.$store.commit('adminLogout')
      this.$router.replace('/admin/login')
    }
  },
  mounted() {
    document.addEventListener('pix-theme-change', this.syncDark)
  },
  beforeDestroy() {
    document.removeEventListener('pix-theme-change', this.syncDark)
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
