<template>
  <div class="pix-login">
    <div class="auth-card">
      <div class="pix-login-brand">Hello Pix</div>
      <el-form ref="form" :model="form" class="login-container auth-form" v-loading="loading">
        <el-form-item>
          <span class="auth-title">忘记密码</span>
        </el-form-item>
        <el-form-item prop="email" :rules="[{ required: true, message: '请输入邮箱', trigger: 'blur' }]">
          <el-input v-model="form.email" placeholder="请输入邮箱地址" prefix-icon="el-icon-message"></el-input>
        </el-form-item>
        <el-form-item prop="code" :rules="[{ required: true, message: '请输入验证码', trigger: 'blur' }]">
          <el-input v-model="form.code" placeholder="请输入验证码" prefix-icon="el-icon-key">
            <el-button slot="append" :disabled="!codeCanClick" @click="getCode">{{ codeContent }}</el-button>
          </el-input>
        </el-form-item>
        <el-form-item prop="passWord" :rules="[{ required: true, min: 6, message: '密码至少需要 6 位', trigger: 'blur' }]">
          <el-input v-model="form.passWord" type="password" placeholder="请输入至少 6 位新密码" prefix-icon="el-icon-lock"></el-input>
        </el-form-item>
        <el-form-item prop="passWord1" :rules="[{ required: true, min: 6, message: '密码至少需要 6 位', trigger: 'blur' }]">
          <el-input v-model="form.passWord1" type="password" placeholder="请再次输入密码" prefix-icon="el-icon-lock"></el-input>
        </el-form-item>
        <el-form-item prop="imageCode" :rules="[{ required: true, message: '请输入图形验证码', trigger: 'blur' }]">
          <div class="captcha-row">
            <el-input v-model="form.imageCode" placeholder="请输入右侧验证码" prefix-icon="el-icon-picture-outline"></el-input>
            <img class="captcha" :src="codeImg" alt="验证码" title="点击刷新" @click="getImageCode">
          </div>
        </el-form-item>
        <div class="auth-links">
          <router-link to="/">返回登录</router-link>
          <router-link to="/register">注册用户</router-link>
        </div>
        <el-button type="primary" style="width:100%;height:41px;margin-top:12px" :loading="loading" @click="submit">重置密码</el-button>
        <auth-support></auth-support>
      </el-form>
    </div>
  </div>
</template>
<script>
import AuthSupport from './AuthSupport.vue'
export default {
  components: { AuthSupport },
  data() {
    return {
      form: { email: '', code: '', passWord: '', passWord1: '', imageCode: '', imageId: '' },
      loading: false,
      codeCanClick: true,
      codeTotalTime: 60,
      codeContent: '获取验证码',
      codeImg: '',
      timer: null
    }
  },
  mounted() { this.getImageCode() },
  beforeDestroy() { if (this.timer) clearInterval(this.timer) },
  methods: {
    getImageCode() {
      this.getRequest('/user/captcha').then(resp => {
        if (resp && resp.data) {
          this.codeImg = resp.data.image
          this.form.imageId = resp.data.imageId
          // 图片换了，之前抄的码就作废了 —— 不清掉会变成
          // 「新 imageId + 旧 code」，必然判错。
          this.form.imageCode = ''
        }
      })
    },
    // 图形验证码过期/错误时换一张。图片与 imageId 必须同时更新。
    refreshImageCode(tip) {
      this.form.imageCode = ''
      this.getImageCode()
      if (tip) this.$message.error(tip)
    },
    startCountdown() {
      this.codeCanClick = false
      this.codeTotalTime = 60
      this.codeContent = this.codeTotalTime + 's后重新发送'
      this.timer = setInterval(() => {
        this.codeTotalTime -= 1
        this.codeContent = this.codeTotalTime + 's后重新发送'
        if (this.codeTotalTime < 0) {
          clearInterval(this.timer)
          this.codeContent = '获取验证码'
          this.codeTotalTime = 60
          this.codeCanClick = true
        }
      }, 1000)
    },
    getCode() {
      if (!this.codeCanClick) return
      if (!this.form.email) {
        this.$message.error('请输入邮箱地址')
        return
      }
      if (!this.form.imageCode) {
        this.$message.error('请输入图形验证码')
        return
      }
      // imageId 与 imageCode 必须一起提交，否则后端拿不到图形码、直接判「已过期」。
      this.postRequest('/user/emailCode', {
        email: this.form.email,
        scene: 'forgot',
        imageId: this.form.imageId,
        imageCode: this.form.imageCode
      }, { silent: true }).then(resp => {
        if (!resp || !resp.data) return
        if (resp.data.success === false) {
          this.$message.error(resp.data.msg)
          return
        }
        this.$message.success(resp.data.msg)
        this.startCountdown()
      }).catch(error => {
        const data = (error && error.response && error.response.data) || {}
        if (data.code === 'CAPTCHA_EXPIRED') {
          this.refreshImageCode('图形验证码已过期，已为您刷新，请重新输入')
          return
        }
        if (data.code === 'CAPTCHA_INVALID') {
          this.refreshImageCode('图形验证码错误，已为您刷新，请重新输入')
          return
        }
        this.$message.error(data.msg || '获取验证码失败，请稍后重试')
      })
    },
    submit() {
      this.$refs.form.validate(valid => {
        if (!valid) return
        if (this.form.passWord !== this.form.passWord1) {
          this.$message.error('两次密码不一致')
          return
        }
        this.loading = true
        this.postRequest('/user/forgot', this.form).then(resp => {
          this.loading = false
          if (!resp || !resp.data) return
          if (resp.data.success === false || resp.data.success === 'error') {
            this.$message.error(resp.data.msg)
            this.getImageCode()
            return
          }
          this.$message.success(resp.data.msg)
          this.$router.push('/login')
        }).catch(() => { this.loading = false })
      })
    }
  }
}
</script>
<style scoped>
.auth-card { width: 350px; }
.auth-form { width: 100% !important; padding: 20px 24px 24px !important; }
.auth-title { font-size: 20px; color: var(--w-text); }
.auth-links { display: flex; justify-content: space-between; }
.auth-links a { color: var(--w-accent); font-size: 13px; text-decoration: none; }
.captcha-row { display: flex; align-items: center; gap: 8px; }
.captcha-row .el-input { flex: 1; }
.captcha { width: 120px; height: 42px; cursor: pointer; display: block; flex-shrink: 0; border: 1px solid #dcdfe6; border-radius: 4px; background: #eef3fb; }
</style>
