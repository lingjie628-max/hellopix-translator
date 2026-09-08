<template>
  <div class="admin-page">
    <div class="admin-bar">
      <el-button type="success" @click="open()">新建超管</el-button>
    </div>
    <el-table :data="rows" border stripe>
      <el-table-column prop="id" label="ID" width="70"></el-table-column>
      <el-table-column prop="username" label="账号" width="140"></el-table-column>
      <el-table-column prop="nickname" label="名称" width="160"></el-table-column>
      <el-table-column prop="role" label="角色" width="120"></el-table-column>
      <el-table-column label="操作" width="120">
        <template slot-scope="scope">
          <el-button type="text" @click="open(scope.row)">编辑</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-dialog :title="form.id ? '编辑超管' : '新建超管'" :visible.sync="visible" width="420px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="账号">
          <el-input v-model="form.username" :disabled="!!form.id"></el-input>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="form.nickname"></el-input>
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" :placeholder="form.id ? '不填则不修改' : '请输入至少 8 位密码'"></el-input>
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width:100%" :disabled="!!form.id && form.username==='admin'">
            <el-option label="超级管理员" value="superadmin"></el-option>
            <el-option label="运营" value="operator"></el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="visible=false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </span>
    </el-dialog>
  </div>
</template>
<script>
export default {
  data() {
    return { rows: [], visible: false, form: {} }
  },
  mounted() { this.load() },
  methods: {
    load() {
      this.getRequest('/admin/staff').then(resp => { if (resp) this.rows = resp.data })
    },
    open(row) {
      this.form = row ? Object.assign({}, row, { password: '' }) : { username: '', nickname: '', password: '', role: 'operator' }
      this.visible = true
    },
    save() {
      this.postRequest('/admin/staff/save', this.form).then(resp => {
        this.$message({ type: resp.data.success === 'error' ? 'error' : 'success', message: resp.data.msg })
        if (resp.data.success !== 'error') {
          this.visible = false
          this.load()
        }
      })
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.admin-bar { margin-bottom: 12px; }
</style>
