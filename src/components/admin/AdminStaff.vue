<template>
  <div class="admin-page">
    <el-alert
      v-if="isSelf"
      type="warning"
      :closable="false"
      show-icon
      title="你正在操作自己的账号"
      description="唯一超管不能降级自己；所有改动都会写入审计日志。"
      style="margin-bottom:12px">
    </el-alert>
    <div class="admin-bar">
      <el-button type="success" @click="open()">新建超管</el-button>
    </div>
    <el-table :data="rows" border stripe>
      <el-table-column prop="id" label="ID" width="70"></el-table-column>
      <el-table-column prop="username" label="账号" width="140">
        <template slot-scope="scope">
          {{ scope.row.username }}
          <el-tag v-if="scope.row.id === me.id" size="mini" type="warning">我</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="nickname" label="名称" width="160"></el-table-column>
      <el-table-column label="角色" width="120">
        <template slot-scope="scope">
          <el-tag :type="scope.row.role === 'superadmin' ? 'danger' : 'info'" size="small">
            {{ roleText(scope.row.role) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template slot-scope="scope">
          <el-button type="text" @click="open(scope.row)">编辑</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-dialog :title="form.id ? '编辑超管' : '新建超管'" :visible.sync="visible" width="460px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="账号">
          <el-input v-model="form.username" :disabled="!!form.id"></el-input>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="form.nickname"></el-input>
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            :placeholder="form.id ? '不填则不修改' : '请输入至少 6 位密码'"></el-input>
        </el-form-item>
        <el-form-item label="角色">
          <!--
            只给两种角色：超级管理员 / 运营。
            库里虽然允许 admin / auditor，但它们在后端能力表里**没有实现**，
            选中了会得到一个"账号存在但什么都干不了"的空壳。
            干脆不让人选。

            另外：唯一超管不能把自己降级 —— 前端先拦一道，
            真正的判定在服务端（staff-service.js 的 LAST_SUPERADMIN）。
          -->
          <el-select v-model="form.role" style="width:100%" :disabled="roleLocked">
            <el-option label="超级管理员" value="superadmin"></el-option>
            <el-option label="运营" value="operator"></el-option>
          </el-select>
          <div v-if="roleLocked" class="hint">
            这是系统中唯一的超级管理员，不能降级。请先创建另一个超管。
          </div>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="visible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </span>
    </el-dialog>
  </div>
</template>
<script>
export default {
  data() {
    return { rows: [], visible: false, form: {}, saving: false, me: { id: 0 } }
  },
  computed: {
    superadminCount() {
      return this.rows.filter(r => r.role === 'superadmin' && Number(r.status) !== 0).length
    },
    // 正在编辑自己，且自己是唯一的超管 → 角色锁死
    roleLocked() {
      return !!this.form.id && this.form.id === this.me.id &&
        this.superadminCount <= 1
    },
    isSelf() {
      return !!this.form.id && this.form.id === this.me.id
    }
  },
  mounted() { this.syncMe(); this.load() },
  methods: {
    roleText(role) {
      return role === 'superadmin' ? '超级管理员' : role === 'operator' ? '运营' : role
    },
    load() {
      this.getRequest('/admin/staff').then(resp => { if (resp) this.rows = resp.data || [] })
    },
    // 当前登录的是谁：从 store 里取（登录时写进去的），不额外请求。
    // 拿不到 id 就不锁 —— 服务端仍然会把关，前端只是少一道提示。
    syncMe() {
      const info = this.$store.state.admin || {}
      this.me = { id: Number(info.id) || 0 }
    },
    open(row) {
      this.form = row
        ? Object.assign({}, row, { password: '' })
        : { username: '', nickname: '', password: '', role: 'operator' }
      this.visible = true
    },
    save() {
      if (this.saving) return
      this.saving = true
      const payload = Object.assign({}, this.form)
      // 角色锁死时不要把这个字段发上去 —— 服务端也会拒，
      // 但前端先不添乱，免得用户看到一条自己没法处理的错误。
      if (this.roleLocked) delete payload.role
      this.postRequest('/admin/staff/save', payload).then(resp => {
        this.saving = false
        this.$message({ type: resp.data.success === 'error' ? 'error' : 'success', message: resp.data.msg })
        if (resp.data.success !== 'error') {
          this.visible = false
          this.load()
        }
      }).catch(() => { this.saving = false })
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.admin-bar { margin-bottom: 12px; }
.hint { margin-top: 4px; font-size: 12px; color: #e6a23c; line-height: 1.4; }
</style>
