<template>
  <div class="pix-login">
    <div class="auth-card">
      <div class="pix-login-brand">Hello Pix</div>
      <el-form ref="form" :model="form" class="login-container auth-form" v-loading="loading">
        <el-form-item align="left">
          <span class="auth-title">用户注册</span>
        </el-form-item>
        <el-form-item prop="userName" :rules="[{ required: true, message: '请输入账号', trigger: 'blur' }]">
          <el-input v-model="form.userName" placeholder="请输入账号" prefix-icon="el-icon-user" clearable></el-input>
        </el-form-item>
        <el-form-item prop="passWord" :rules="[{ required: true, min: 8, message: '密码至少需要 8 位', trigger: 'blur' }]">
          <el-input v-model="form.passWord" :type="passwordType" placeholder="请输入至少 8 位密码" prefix-icon="el-icon-lock">
            <i slot="suffix" :class="passwordType === 'password' ? 'el-icon-view' : 'el-icon-minus'" class="pwd-eye" @click="passwordType = passwordType === 'password' ? 'text' : 'password'"></i>
          </el-input>
        </el-form-item>
        <el-form-item prop="passWord1" :rules="[{ required: true, min: 8, message: '密码至少需要 8 位', trigger: 'blur' }]">
          <el-input v-model="form.passWord1" :type="passwordType" placeholder="请输入密码" prefix-icon="el-icon-lock"></el-input>
        </el-form-item>
        <el-form-item prop="email" :rules="[{ required: true, message: '请输入邮箱', trigger: 'blur' }]">
          <el-input v-model="form.email" placeholder="请输入邮箱地址" prefix-icon="el-icon-message"></el-input>
        </el-form-item>
        <el-form-item prop="code" :rules="[{ required: true, message: '请输入验证码', trigger: 'blur' }]">
          <el-input v-model="form.code" placeholder="请输入验证码" prefix-icon="el-icon-key">
            <el-button slot="append" :disabled="!codeCanClick" @click="getCode">{{ codeContent }}</el-button>
          </el-input>
        </el-form-item>
        <el-form-item prop="imageCode" :rules="[{ required: true, message: '请输入图形验证码', trigger: 'blur' }]">
          <div class="captcha-row">
            <el-input v-model="form.imageCode" placeholder="请输入右侧验证码" prefix-icon="el-icon-picture-outline"></el-input>
            <img class="captcha" :src="codeImg" alt="验证码" title="点击刷新" @click="getImageCode">
          </div>
        </el-form-item>
        <div class="auth-links">
          <router-link to="/">返回登录</router-link>
          <router-link to="/forgot">忘记密码?</router-link>
        </div>
        <el-button type="primary" style="width:100%;height:41px;margin-top:12px" :loading="loading" @click="submit">注册</el-button>
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
      form: { userName: '', passWord: '', passWord1: '', email: '', code: '', imageCode: '', imageId: '' },
      loading: false,
      passwordType: 'password',
      codeCanClick: true,
      codeTotalTime: 60,
      codeContent: '获取验证码',
      codeImg: '',
      timer: null
    }
  },
  mounted() {
    this.getImageCode()
  },
  beforeDestroy() {
    if (this.timer) clearInterval(this.timer)
  },
  methods: {
    getImageCode() {
      this.getRequest('/user/captcha').then(resp => {
        if (resp && resp.data) {
          this.codeImg = resp.data.image
          this.form.imageId = resp.data.imageId
        }
      })
    },
    getCode() {
      if (!this.codeCanClick) return
      if (!this.form.email) {
        this.$message.error('请输入邮箱地址')
        return
      }
      this.postRequest('/user/emailCode', { email: this.form.email, scene: 'register' }).then(resp => {
        if (!resp || !resp.data) return
        if (resp.data.success === false) {
          this.$message.error(resp.data.msg)
          return
        }
        this.$message.success(resp.data.msg)
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
        this.postRequest('/user/register', this.form).then(resp => {
          this.loading = false
          if (!resp || !resp.data) return
          if (resp.data.success === false || resp.data.success === 'error') {
            this.$message.error(resp.data.msg)
            this.getImageCode()
            return
          }
          this.$message.success(resp.data.msg || '注册成功')
          this.$router.push('/regSuccess')
        }).catch(() => { this.loading = false })
      })
    }
  }
}
</script>
<style scoped>
.auth-card { width: 350px; }
.auth-form { width: 100% !important; padding: 20px 24px 24px !important; }
.auth-title { font-size: 20px; color: #303133; }
.auth-links { display: flex; justify-content: space-between; }
.auth-links a { color: #409EFF; font-size: 13px; text-decoration: none; }
.captcha-row { display: flex; align-items: center; gap: 8px; }
.captcha-row .el-input { flex: 1; }
.captcha { width: 120px; height: 42px; cursor: pointer; display: block; flex-shrink: 0; border: 1px solid #dcdfe6; border-radius: 4px; background: #eef3fb; }
.pwd-eye { cursor: pointer; margin-right: 6px; }
</style>
