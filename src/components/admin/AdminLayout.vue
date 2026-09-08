<template>
  <el-container class="admin-shell">
    <el-menu class="admin-menu" unique-opened router background-color="#111827" text-color="#d1d5db" active-text-color="#fca5a5">
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
        <el-menu-item index="/admin/settings">系统设置</el-menu-item>
        <el-menu-item index="/admin/logs">登录与审计</el-menu-item>
        <el-menu-item index="/admin/staff">超管账号</el-menu-item>
      </el-submenu>
    </el-menu>
    <el-container>
      <el-header class="admin-header">
        <span>{{ $route.name }}</span>
        <span>
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
export default {
  computed: {
    admin() {
      return this.$store.state.admin || {}
    }
  },
  methods: {
    logout() {
      this.postRequest('/admin/logout')
      this.$store.commit('adminLogout')
      this.$router.replace('/admin/login')
    }
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
  color: #fecaca;
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
}
</style>
