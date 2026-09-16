<template>
  <div class="team-page">
    <div class="team-bar">
      <el-input v-model="keyword" placeholder="请输入登录账号或邮箱进行查询" clearable style="width: 280px"
                @keyup.enter.native="load">
      </el-input>
      <el-button type="primary" @click="load">查询</el-button>
      <el-button type="primary" :disabled="!selected.length" @click="batch(1)">开启所选</el-button>
      <el-button :disabled="!selected.length" @click="batch(0)">关闭所选</el-button>
      <el-button type="primary" style="float:right" @click="openEdit()">+ 添加</el-button>
    </div>
    <p class="quota">子账号名额 {{ info.subCount || 0 }}/{{ info.subQuota || 0 }}。购买字符即可成为企业用户，每组增加 1 个子账户。</p>

    <el-table :data="rows" v-loading="loading" @selection-change="onSelect">
      <el-table-column type="selection" width="48"></el-table-column>
      <el-table-column prop="username" label="子账户名称" min-width="140"></el-table-column>
      <el-table-column prop="charBalance" label="剩余字符" width="120" sortable></el-table-column>
      <el-table-column prop="charUsed" label="字符用量" width="120" sortable></el-table-column>
      <el-table-column prop="createTime" label="注册时间" width="170" sortable></el-table-column>
      <el-table-column label="状态" width="90" sortable>
        <template slot-scope="scope">
          <el-tag :type="scope.row.status === 1 ? 'success' : 'info'" size="mini">{{ scope.row.status === 1 ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="自动分配" width="100">
        <template slot-scope="scope">
          <el-switch v-model="scope.row.autoAlloc" :active-value="1" :inactive-value="0" @change="val => setAlloc(scope.row, val)"></el-switch>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="220">
        <template slot-scope="scope">
          <el-button type="text" @click="openChars(scope.row)">分字符</el-button>
          <el-button type="text" @click="openEdit(scope.row)">编辑</el-button>
          <el-button type="text" @click="toggle(scope.row)">{{ scope.row.status === 1 ? '关闭' : '开启' }}</el-button>
        </template>
      </el-table-column>
      <template slot="empty">暂无数据</template>
    </el-table>

    <el-dialog :title="form.id ? '编辑子账号' : '添加子账号'" :visible.sync="visible" width="480px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="登录账号">
          <el-input v-model="form.username" :disabled="!!form.id"></el-input>
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="form.email"></el-input>
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" :placeholder="form.id ? '不填则不修改' : '请输入至少 8 位密码'"></el-input>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="form.nickname"></el-input>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="visible=false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </span>
    </el-dialog>

    <el-dialog title="分配字符" :visible.sync="charVisible" width="420px">
      <p class="char-hint">主账户余额 {{ info.parentCharBalance || 0 }}。正数分给员工，负数从员工收回。</p>
      <el-input-number v-model="charForm.chars" :step="1000"></el-input-number>
      <span slot="footer">
        <el-button @click="charVisible=false">取消</el-button>
        <el-button type="primary" @click="saveChars">确定</el-button>
      </span>
    </el-dialog>
  </div>
</template>
<script>
export default {
  data() {
    return {
      info: {},
      rows: [],
      selected: [],
      keyword: '',
      loading: false,
      visible: false,
      form: {},
      charVisible: false,
      charForm: { id: '', chars: 10000 }
    }
  },
  mounted() {
    this.load()
  },
  methods: {
    load() {
      this.getRequest('/team/info').then(resp => {
        if (resp && resp.data) this.info = resp.data
      })
      this.loading = true
      this.getRequest('/team/subs', { page: 1, rows: 100, keyword: this.keyword }).then(resp => {
        this.loading = false
        if (resp && resp.data) this.rows = resp.data.rows || []
      }).catch(() => { this.loading = false })
    },
    onSelect(rows) {
      this.selected = rows
    },
    openEdit(row) {
      this.form = row ? Object.assign({}, row, { password: '' }) : { username: '', password: '', nickname: '', email: '' }
      this.visible = true
    },
    save() {
      this.postRequest('/team/subs/save', this.form).then(resp => {
        this.$message({ type: resp.data.success === 'error' ? 'error' : 'success', message: resp.data.msg })
        if (resp.data.success !== 'error') {
          this.visible = false
          this.load()
        }
      })
    },
    openChars(row) {
      this.charForm = { id: row.id, chars: 10000 }
      this.charVisible = true
    },
    saveChars() {
      this.postRequest('/team/subs/chars', this.charForm).then(resp => {
        this.$message({ type: resp.data.success === 'error' ? 'error' : 'success', message: resp.data.msg })
        if (resp.data.success !== 'error') {
          this.charVisible = false
          this.load()
        }
      })
    },
    toggle(row) {
      const status = row.status === 1 ? 0 : 1
      this.postRequest('/team/subs/status', { id: row.id, status }).then(() => this.load())
    },
    batch(status) {
      const ids = this.selected.map(s => s.id).join(',')
      this.postRequest('/team/subs/batch', { ids, status }).then(resp => {
        this.$message.success(resp.data.msg)
        this.load()
      })
    },
    setAlloc(row, val) {
      this.postRequest('/team/autoAlloc', { id: row.id, autoAlloc: val }).then(resp => {
        this.$message.success(resp.data.msg)
      })
    }
  }
}
</script>
<style scoped>
.team-page { text-align: left; background: var(--w-surface); padding: 16px; }
.team-bar { margin-bottom: 8px; }
.quota { color: var(--w-text-faint); font-size: 13px; margin: 0 0 12px; }
.char-hint { color: var(--w-text-faint); font-size: 13px; margin: 0 0 12px; }
</style>
