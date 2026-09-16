<template>
  <div class="pix-login">
    <div class="pix-login-card">
      <div class="pix-login-topbar"><theme-toggle></theme-toggle></div>
      <div class="pix-login-brand">Hello Pix</div>
      <el-form :rules="rules" :model="loginForm" ref="loginFormTable" class="login-container" label-position="left"
               label-width="0px" v-loading="loading" @submit.native.prevent>
        <h3 class="login_title">用户登录</h3>
        <el-form-item prop="username">
          <el-input type="text" v-model="loginForm.username" placeholder="请输入账号" @keyup.enter.native="submitClick('loginFormTable')"></el-input>
        </el-form-item>
        <el-form-item prop="password">
          <el-input type="password" v-model="loginForm.password" placeholder="请输入密码" @keyup.enter.native="submitClick('loginFormTable')"></el-input>
        </el-form-item>
        <el-form-item prop="imageCode">
          <div class="captcha-row">
            <el-input v-model="loginForm.imageCode" placeholder="请输入右侧验证码" @keyup.enter.native="submitClick('loginFormTable')"></el-input>
            <img class="captcha" :src="codeImg" alt="验证码" title="点击刷新" @click="getImageCode">
          </div>
        </el-form-item>
        <div class="auth-links">
          <router-link to="/register">注册用户</router-link>
          <router-link to="/forgot">忘记密码?</router-link>
          <!-- 回官网：登录页是深层页，没有回去的入口用户会被困住 -->
          <router-link to="/">返回官网</router-link>
        </div>
        <el-form-item style="width: 100%">
          <el-button type="primary" @click="submitClick('loginFormTable')" style="width: 100%">进入 Hello Pix</el-button>
        </el-form-item>
        <auth-support></auth-support>
      </el-form>
    </div>
  </div>
</template>
<script>
import AuthSupport from './AuthSupport.vue'
import ThemeToggle from './ThemeToggle.vue'
export default {
  components: { AuthSupport, ThemeToggle },
  data() {
    return {
      loginForm: {
        username: "",
        password: "",
        imageCode: "",
        imageId: ""
      },
      rules: {
        username: [{ required: true, message: "请输入用户名", trigger: "blur" }],
        password: [{ required: true, message: "请输入密码", trigger: "blur" }],
        imageCode: [{ required: true, message: "请输入图形验证码", trigger: "blur" }]
      },
      codeImg: "",
      loading: false
    };
  },
  mounted() {
    this.getImageCode()
  },
  methods: {
    getImageCode() {
      this.getRequest('/user/captcha').then(resp => {
        if (resp && resp.data) {
          this.codeImg = resp.data.image
          this.loginForm.imageId = resp.data.imageId
          this.loginForm.imageCode = ''
        }
      })
    },
    submitClick(formName) {
      // 防重入：回车同时命中输入框的 keyup 与表单原生 submit，双击也会发两次。
      // 图形验证码是一次性的，第二次必然报"已过期"，而这条报错会盖在正常流程上。
      if (this.loading) return
      this.loading = true
      this.$refs[formName].validate((valid) => {
        if (valid) {
          var _this = this;
          this.postRequest("/login", {
            username: this.loginForm.username,
            password: this.loginForm.password,
            imageCode: this.loginForm.imageCode,
            imageId: this.loginForm.imageId,
            deviceId: this.deviceId()
          }).then(resp => {
            _this.loading = false;
            if (resp && resp.status == 200) {
              var data = resp.data;
              if (!data.success) {
                this.$message.error(data.msg);
                this.getImageCode();
                return;
              }
              _this.$store.commit("login", data.obj);
              var path = _this.$route.query.redirect;
              _this.$router.replace({
                path: path == "/" || path == undefined ? "/home/index" : path
              });
            }
          }).catch(() => {
            _this.loading = false;
            _this.getImageCode();
          });
        } else {
          // 校验没过必须放开占位，否则按钮会永久卡在加载态
          this.loading = false;
          return false;
        }
      });
    },
    deviceId() {
      let id = window.localStorage.getItem('pix_device')
      if (!id) {
        id = 'web-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
        window.localStorage.setItem('pix_device', id)
      }
      return id
    }
  }
};
</script>
<style>
.pix-login {
  min-height: 100%;
  /* 日间为浅色渐变、夜间为深色渐变，见 assets/theme.css 的 --w-bg-grad */
  background: var(--w-bg-grad);
  display: flex;
  align-items: center;
  justify-content: center;
}

.pix-login-topbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 10px;
}

.pix-login-brand {
  color: var(--w-logo-text);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin-bottom: 18px;
  text-align: center;
}

.login-container {
  border-radius: 16px;
  background-clip: padding-box;
  width: 320px;
  padding: 20px 28px 16px 28px;
  background: var(--w-surface);
  border: 1px solid var(--w-border);
  box-shadow: var(--w-shadow);
}

.login_title {
  margin: 0 auto 18px auto;
  text-align: center;
  color: var(--w-text-strong);
}

.auth-links {
  display: flex;
  justify-content: space-between;
  margin: 0 0 14px;
}

.auth-links a {
  color: var(--w-accent);
  font-size: 13px;
  text-decoration: none;
}

.captcha-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.captcha-row .el-input {
  flex: 1;
}

.captcha {
  width: 120px;
  height: 42px;
  cursor: pointer;
  display: block;
  flex-shrink: 0;
  border: 1px solid var(--w-border-strong);
  border-radius: 4px;
  background: var(--w-surface-3);
  object-fit: cover;
}
</style>
