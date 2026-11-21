<template>
  <el-container class="cms-shell">
    <el-menu class="cms-menu" unique-opened router :collapse="isCollapse"
             background-color="#1f2d3d" text-color="#bfcbd9" active-text-color="#409EFF">
      <div class="cms-logo" v-show="!isCollapse">Hello Pix CMS</div>
      <el-menu-item index="/home/index">
        <i class="el-icon-s-home"></i>
        <span slot="title">首页</span>
      </el-menu-item>
      <el-menu-item v-if="isMain" index="/user/team">
        <i class="el-icon-user"></i>
        <span slot="title">子账号管理</span>
      </el-menu-item>
      <el-menu-item v-if="isMain" index="/count/tickets">
        <i class="el-icon-data-analysis"></i>
        <span slot="title">计数工单<el-tag v-if="!counterSuite" size="mini" type="warning" effect="plain">需专业版</el-tag></span>
      </el-menu-item>
      <el-menu-item v-if="isMain" index="/user/rechargePage">
        <i class="el-icon-wallet"></i>
        <span slot="title">充值中心</span>
      </el-menu-item>
      <el-menu-item index="/user/Recharge">
        <i class="el-icon-s-order"></i>
        <span slot="title">充值记录</span>
      </el-menu-item>
      <!-- 工单：子账号也要能提（子账号没有独立余额，但「登不上」这种问题
           必须由本人描述），所以不加 isMain 限制 -->
      <el-menu-item index="/user/tickets">
        <i class="el-icon-chat-dot-square"></i>
        <span slot="title">工单<el-badge v-if="ticketUnread > 0" :value="ticketUnread" :max="99" class="tk-badge"></el-badge></span>
      </el-menu-item>
    </el-menu>
    <el-container>
      <el-header class="cms-header">
        <i :class="isCollapse ? 'el-icon-s-unfold' : 'el-icon-s-fold'" class="cms-fold" @click="isCollapse = !isCollapse"></i>
        <el-dropdown trigger="click" @command="handleCommand">
          <span class="el-dropdown-link">{{ user.username }}，你好<i class="el-icon-arrow-down el-icon--right"></i></span>
          <el-dropdown-menu slot="dropdown">
            <el-dropdown-item command="password">修改密码</el-dropdown-item>
            <el-dropdown-item command="download">下载软件</el-dropdown-item>
            <el-dropdown-item command="support">联系客服</el-dropdown-item>
            <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
          </el-dropdown-menu>
        </el-dropdown>
      </el-header>
      <el-main class="cms-main">
        <keep-alive>
          <router-view v-if="this.$route.meta.keepAlive"></router-view>
        </keep-alive>
        <router-view v-if="!this.$route.meta.keepAlive"></router-view>
      </el-main>
    </el-container>

    <el-dialog title="修改密码" :visible.sync="pwdVisible" width="420px">
      <el-form :model="pwd" label-width="80px">
        <el-form-item label="原密码"><el-input type="password" v-model="pwd.oldPassword"></el-input></el-form-item>
        <el-form-item label="新密码"><el-input type="password" v-model="pwd.newPassword"></el-input></el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="pwdVisible=false">取消</el-button>
        <el-button type="primary" @click="savePassword">保存</el-button>
      </span>
    </el-dialog>
  </el-container>
</template>
<script>
export default {
  data() {
    return {
      isCollapse: false,
      telegram: '',
      telegramUrl: '',
      pwdVisible: false,
      ticketUnread: 0,
      pwd: { oldPassword: '', newPassword: '' }
    }
  },
  computed: {
    user() {
      return this.$store.state.user || {}
    },
    isMain() {
      return this.$store.state.user.role !== 'sub'
    },
    counterSuite() {
      return this.$store.state.user.counterSuite === true ||
        Number(this.$store.state.user.counterSuite) === 1
    }
  },
  mounted() {
    // 套餐/企业权益可能在本次登录期间由后台调整。布局挂载时刷新一次公开用户
    // 权益，避免用户必须退出重登才能看到刚开通的计数工单。
    this.refreshEntitlement()
    this.getRequest('/site/info').then(resp => {
      if (resp && resp.data) {
        this.telegramUrl = resp.data.telegramUrl || ''
        this.telegram = resp.data.telegram || ''
      }
    })
    // 工单未读：60s 一次，后台标签页不发请求。
    // 商户端只有「客服回了」这一种提醒，红点漏了就等于消息石沉大海。
    this.fetchTicketUnread()
    this.ticketTimer = setInterval(this.fetchTicketUnread, 60000)
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('pix-user-ticket-read', this.fetchTicketUnread)
  },
  beforeDestroy() {
    if (this.ticketTimer) clearInterval(this.ticketTimer)
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('pix-user-ticket-read', this.fetchTicketUnread)
  },
  methods: {
    refreshEntitlement() {
      this.getRequest('/user/dashboard').then(resp => {
        const data = resp && resp.data
        if (!data) return
        const patch = {}
        if (data.counterSuite !== undefined) patch.counterSuite = data.counterSuite
        if (data.enterprise !== undefined) patch.enterprise = data.enterprise
        if (Object.keys(patch).length) {
          this.$store.commit('login', Object.assign({}, this.$store.state.user || {}, patch))
        }
      }).catch(() => {})
    },
    fetchTicketUnread() {
      if (document.hidden) return
      this.getRequest('/tickets-unread').then(resp => {
        if (resp && resp.data) this.ticketUnread = Number(resp.data.unread) || 0
      }).catch(() => {})
    },
    onVisibility() {
      if (!document.hidden) this.fetchTicketUnread()
    },
    goWebUrl() {
      this.getRequest('/site/info').then(resp => {
        const url = resp && resp.data && resp.data.clientDownloadUrl
        if (url) window.open(url)
        else this.$message.info('尚未配置客户端下载地址，请超管在系统设置中填写')
      }).catch(() => this.$message.info('尚未配置客户端下载地址'))
    },
    goSupport() {
      this.getRequest('/site/info').then(resp => {
        const d = (resp && resp.data) || {}
        const url = d.telegramUrl || (d.telegram ? 'https://t.me/' + String(d.telegram).replace(/^@/, '') : '')
        if (url) window.open(url)
        else this.$message.info(d.supportNote || (d.telegram ? ('请联系客服 ' + d.telegram) : '尚未配置客服联系方式'))
      }).catch(() => this.$message.info('尚未配置客服联系方式'))
    },
    savePassword() {
      this.postRequest('/team/password', this.pwd).then(resp => {
        this.$message({ type: resp.data.success === 'error' ? 'error' : 'success', message: resp.data.msg })
        if (resp.data.success !== 'error') {
          this.pwdVisible = false
          this.pwd = { oldPassword: '', newPassword: '' }
        }
      })
    },
    logout() {
      this.$confirm('注销登录, 是否继续?', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => {
        this.postRequest('/logout')
        this.$store.commit('logout')
        this.$router.replace({ path: '/login' })
      }).catch(() => {})
    },
    handleCommand(cmd) {
      if (cmd === 'logout') this.logout()
      else if (cmd === 'download') this.goWebUrl()
      else if (cmd === 'support') this.goSupport()
      else if (cmd === 'password') this.pwdVisible = true
    }
  }
}
</script>
<style scoped>
.cms-shell {
  height: 100%;
  position: absolute;
  inset: 0;
}
.cms-menu {
  width: 210px;
  border-right: none;
  text-align: left;
}
.cms-logo {
  color: #fff;
  font-weight: 700;
  padding: 18px 16px 10px;
  letter-spacing: 0.04em;
}
.cms-header {
  height: 50px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--w-surface);
  box-shadow: 0 1px 4px rgba(0, 21, 41, 0.08);
}
.cms-fold {
  font-size: 22px;
  cursor: pointer;
  color: var(--w-text-muted);
}
.cms-main {
  background: var(--w-surface-2);
  padding: 16px 20px;
}
.el-dropdown-link {
  cursor: pointer;
  color: var(--w-text);
}
/* 侧栏未读角标：紧跟文字，不能把菜单项撑高 */
.tk-badge {
  margin-left: 6px;
  vertical-align: middle;
}
.tk-badge ::v-deep .el-badge__content {
  position: static;
  transform: none;
  display: inline-block;
}
</style>
