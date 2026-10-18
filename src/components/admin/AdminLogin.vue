<template>
  <div class="admin-login">
    <el-form
      v-if="step === 'credentials'"
      :rules="rules" :model="form" ref="form" class="admin-card"
      v-loading="loading" @submit.native.prevent="submit">
      <div class="admin-topbar"><theme-toggle></theme-toggle></div>
      <div class="admin-brand">PIX翻译管理</div>
      <h3>超管后台</h3>
      <p>商户、工单、翻译计费与运营数据</p>
      <el-form-item prop="username">
        <el-input v-model="form.username" name="username" autocomplete="username" placeholder="超管账号"></el-input>
      </el-form-item>
      <el-form-item prop="password">
        <el-input type="password" v-model="form.password" name="password" autocomplete="current-password" show-password placeholder="密码"></el-input>
      </el-form-item>
      <el-form-item prop="imageCode">
        <div class="captcha-row">
          <el-input v-model="form.imageCode" placeholder="图形验证码"></el-input>
          <img class="captcha" :src="codeImg" alt="验证码" title="点击刷新" @click="getImageCode">
        </div>
      </el-form-item>
      <el-button type="danger" native-type="submit" style="width:100%">登录超管</el-button>
      <div class="admin-foot">
        <router-link to="/login">返回商户前台</router-link>
      </div>
    </el-form>

    <el-form
      v-else
      :rules="totpRules" :model="totpForm" ref="totpForm" class="admin-card"
      v-loading="loading" @submit.native.prevent="submitTotp">
      <div class="admin-topbar"><theme-toggle></theme-toggle></div>
      <div class="admin-brand">PIX翻译管理</div>
      <h3>两步验证</h3>
      <p>请输入验证器 App 上的 6 位动态码</p>
      <el-form-item prop="code">
        <el-input
          v-model="totpForm.code" ref="codeInput" name="code" autocomplete="one-time-code"
          inputmode="text" maxlength="11" placeholder="6 位动态码或恢复码"></el-input>
      </el-form-item>
      <el-button type="danger" native-type="submit" style="width:100%">验证并登录</el-button>
      <div class="admin-foot">
        <a href="javascript:;" @click="backToCredentials">返回上一步</a>
        <span class="sep">·</span>
        <span class="hint">手机丢失？用一次性恢复码登录</span>
      </div>
    </el-form>
  </div>
</template>
<script>
import ThemeToggle from '../ThemeToggle.vue'
export default {
  components: { ThemeToggle },
  data() {
    return {
      loading: false,
      // credentials → totp 两步。密码通过后若账号开了两步验证，服务端只回票据不发会话
      step: 'credentials',
      ticket: '',
      codeImg: '',
      form: { username: '', password: '', imageCode: '', imageId: '' },
      totpForm: { code: '' },
      rules: {
        username: [{ required: true, message: '请输入超管账号', trigger: 'blur' }],
        password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
        imageCode: [{ required: true, message: '请输入图形验证码', trigger: 'blur' }]
      },
      totpRules: {
        code: [{ required: true, message: '请输入动态码', trigger: 'blur' }]
      }
    }
  },
  mounted() {
    this.getImageCode()
  },
  methods: {
    getImageCode() {
      // 超管登录必须过图形验证码：这是全站最高价值的目标，
      // 前置阻力不能比商户端还弱
      this.getRequest('/user/captcha').then(resp => {
        if (resp && resp.data && resp.data.success) {
          this.codeImg = resp.data.image
          this.form.imageId = resp.data.imageId
          this.form.imageCode = ''
        }
      })
    },
    submit() {
      // 防重入：回车会同时命中输入框的 keyup 与表单的原生 submit，
      // 双击也会提交两次。第一次成功消费掉一次性验证码后，第二次必然
      // 报"图形验证码已过期"，而这条报错会显示在已经进入的下一步上，
      // 让人以为是下一步出错 —— 实测复现过（连发两个 /admin/login）。
      // 占位必须**同步**设置：validate 的回调是异步的，
      // 两次极快的点击会在回调执行前双双穿过上面的检查（实测过的缺口）。
      if (this.loading) return
      this.loading = true
      this.$refs.form.validate(valid => {
        if (!valid) { this.loading = false; return }
        this.postRequest('/admin/login', this.form).then(resp => {
          this.loading = false
          const data = resp && resp.data
          if (resp && resp.status == 200 && data && data.success) {
            if (data.needTotp) {
              // 还没有会话，只拿到一张一次性票据
              this.ticket = data.ticket
              this.step = 'totp'
              this.form.password = ''
              this.$nextTick(() => {
                const input = this.$refs.codeInput
                if (input && input.focus) input.focus()
              })
              return
            }
            this.finishLogin(data.obj)
            return
          }
          this.$message.error((data && data.msg) || '登录失败')
          // 验证码是一次性的，无论成功失败都要换一张
          this.getImageCode()
        }).catch(() => {
          this.loading = false
          this.getImageCode()
        })
      })
    },
    submitTotp() {
      // 同上：占位要同步，票据是一次性的，重复提交会白白作废
      if (this.loading) return
      this.loading = true
      this.$refs.totpForm.validate(valid => {
        if (!valid) { this.loading = false; return }
        this.postRequest('/admin/login/totp', { ticket: this.ticket, code: this.totpForm.code })
          .then(resp => {
            this.loading = false
            const data = resp && resp.data
            if (resp && resp.status == 200 && data && data.success) {
              if (data.usedRecovery) {
                this.$message.warning('已使用恢复码登录，该恢复码已作废，请尽快重新生成')
              }
              this.finishLogin(data.obj)
              return
            }
            this.totpForm.code = ''
            this.$message.error((data && data.msg) || '验证失败')
            // 票据被作废（错太多次/超时）时退回第一步，否则用户会卡在死表单上
            if (data && /重新登录|验证已超时/.test(data.msg || '')) this.backToCredentials()
          })
          .catch(() => { this.loading = false })
      })
    },
    backToCredentials() {
      this.step = 'credentials'
      this.ticket = ''
      this.totpForm.code = ''
      this.getImageCode()
    },
    finishLogin(obj) {
      this.$store.commit('adminLogin', obj)
      this.$router.replace('/admin/dashboard')
    }
  }
}
</script>
<style scoped>
.admin-login {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 日间浅色、夜间深色，见 assets/theme.css */
  background: var(--w-bg-grad, #111827);
}
.admin-topbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 6px;
}
.admin-card {
  width: 320px;
  background: var(--w-surface);
  border: 1px solid var(--w-border);
  box-shadow: var(--w-shadow);
  padding: 20px 28px 20px;
  border-radius: 14px;
  text-align: center;
}
.admin-brand {
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--w-logo-text);
}
.admin-card h3 { margin: 8px 0 4px; color: var(--w-text-strong); }
.admin-card p { color: var(--w-text-muted); font-size: 12px; margin: 0 0 18px; }
.admin-foot {
  margin-top: 14px;
  font-size: 12px;
  text-align: center;
  color: var(--w-text-muted);
}
/* 必须给 a 单独设色：浏览器 UA 样式表直接给 a 定了 #0000EE，
   父容器的 color 继承不过去 —— 深色卡片上就成了几乎看不见的深蓝，
   还带着默认下划线（「返回商户前台」就是这样）。 */
.admin-foot a {
  color: var(--w-accent);
  text-decoration: none;
  cursor: pointer;
}
.admin-foot a:hover { text-decoration: underline; }
.admin-foot .sep { margin: 0 6px; color: var(--w-text-faint); }
.admin-foot .hint { color: var(--w-text-muted); }
.captcha-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.captcha-row .el-input { flex: 1; }
.captcha {
  height: 40px;
  width: 108px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid var(--w-border);
  flex-shrink: 0;
}
</style>
