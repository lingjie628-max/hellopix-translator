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
      <el-menu-item v-if="isMain" index="/user/rechargePage">
        <i class="el-icon-wallet"></i>
        <span slot="title">充值中心</span>
      </el-menu-item>
      <el-menu-item index="/user/Recharge">
        <i class="el-icon-s-order"></i>
        <span slot="title">充值记录</span>
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
      pwd: { oldPassword: '', newPassword: '' }
    }
  },
  computed: {
    user() {
      return this.$store.state.user || {}
    },
    isMain() {
      return this.$store.state.user.role !== 'sub'
    }
  },
  mounted() {
    this.getRequest('/site/info').then(resp => {
      if (resp && resp.data) {
        this.telegramUrl = resp.data.telegramUrl || ''
        this.telegram = resp.data.telegram || ''
      }
    })
  },
  methods: {
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
        this.$router.replace({ path: '/' })
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
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 21, 41, 0.08);
}
.cms-fold {
  font-size: 22px;
  cursor: pointer;
  color: #606266;
}
.cms-main {
  background: #f5f7fa;
  padding: 16px 20px;
}
.el-dropdown-link {
  cursor: pointer;
  color: #303133;
}
</style>
