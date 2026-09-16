<template>
  <div class="pix-login">
    <div class="pix-login-card">
      <div class="pix-login-brand">Hello Pix</div>
      <div class="login-container" style="text-align:center">
        <i class="el-icon-success" style="font-size:42px;color:var(--w-success)"></i>
        <h3 class="login_title" style="margin-top:12px">注册成功</h3>
        <p class="login_hint">账号已创建，可用账号或绑定邮箱登录。</p>
        <el-button type="primary" style="width:100%" @click="$router.push('/login')">返回登录</el-button>
        <auth-support></auth-support>
      </div>
    </div>
  </div>
</template>
<script>
import AuthSupport from './AuthSupport.vue'
export default {
  components: { AuthSupport }
}
</script>
