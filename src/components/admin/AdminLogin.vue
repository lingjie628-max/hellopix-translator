<template>
  <div class="admin-login">
    <el-form :rules="rules" :model="form" ref="form" class="admin-card" v-loading="loading" @submit.native.prevent="submit">
      <div class="admin-brand">Hello Pix</div>
      <h3>超管后台</h3>
      <p>商户、工单、翻译计费与运营数据</p>
      <el-form-item prop="username">
        <el-input v-model="form.username" name="username" autocomplete="username" placeholder="超管账号"></el-input>
      </el-form-item>
      <el-form-item prop="password">
        <el-input type="password" v-model="form.password" name="password" autocomplete="current-password" show-password placeholder="密码"></el-input>
      </el-form-item>
      <el-button type="danger" native-type="submit" style="width:100%">登录超管</el-button>
      <div class="admin-foot">
        <router-link to="/">返回商户前台</router-link>
      </div>
    </el-form>
  </div>
</template>
<script>
export default {
  data() {
    return {
      loading: false,
      form: { username: '', password: '' },
      rules: {
        username: [{ required: true, message: '请输入超管账号', trigger: 'blur' }],
        password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
      }
    }
  },
  methods: {
    submit() {
      this.$refs.form.validate(valid => {
        if (!valid) return
        this.loading = true
        this.postRequest('/admin/login', this.form).then(resp => {
          this.loading = false
          if (resp && resp.status == 200 && resp.data.success) {
            this.$store.commit('adminLogin', resp.data.obj)
            this.$router.replace('/admin/dashboard')
          } else {
            this.$message.error((resp && resp.data && resp.data.msg) || '登录失败')
          }
        }).catch(() => { this.loading = false })
      })
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
  background: #111827;
}
.admin-card {
  width: 320px;
  background: #fff;
  padding: 32px 28px 20px;
  border-radius: 14px;
  text-align: center;
}
.admin-brand {
  font-weight: 700;
  letter-spacing: 0.12em;
  color: #b91c1c;
}
.admin-card h3 { margin: 8px 0 4px; }
.admin-card p { color: #909399; font-size: 12px; margin: 0 0 18px; }
.admin-foot {
  margin-top: 14px;
  font-size: 12px;
  text-align: center;
}
</style>
