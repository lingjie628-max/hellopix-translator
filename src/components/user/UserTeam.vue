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
    <!--
      名额文案必须与真实规则一致。
      原文案是「购买字符即可成为企业用户，每组增加 1 个子账户」—— 那是旧设计
      （按购买次数累加名额），从未在生产落地，商户端因此一直显示 0/0 且一个都开不出来。
      现在规则是「套餐自带的额度」（`packages.sub_quota`，结算时写进 `users.sub_quota`），
      所以文案按套餐说；企业账号由客服开通，不限额。
    -->
    <p class="quota">
      子账号名额 {{ info.subCount || 0 }}/{{ info.subQuota || 0 }}。
      <template v-if="info.enterprise">企业账号不限额。</template>
      <template v-else-if="info.subQuota > 0">额度随套餐赠送，升级套餐可提升。</template>
      <template v-else>当前套餐不含子账号额度，购买套餐后即可添加。</template>
    </p>

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
      <el-table-column label="操作" width="280">
        <template slot-scope="scope">
          <el-button type="text" @click="openChars(scope.row)">分字符</el-button>
          <el-button type="text" @click="openEdit(scope.row)">编辑</el-button>
          <el-button type="text" @click="toggle(scope.row)">{{ scope.row.status === 1 ? '关闭' : '开启' }}</el-button>
          <el-button type="text" class="danger" @click="remove(scope.row)">删除</el-button>
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
          <el-input v-model="form.password" :placeholder="form.id ? '不填则不修改' : '请输入至少 6 位密码'"></el-input>
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
    /**
     * 删除子账号。
     *
     * 必须二次确认，且确认框要把**后果说清楚**：余额会退回、翻译记录保留。
     * 只说"确定删除吗"是没用的 —— 商户最关心的是"我那些字符还在不在"。
     */
    remove(row) {
      const balance = Number(row.charBalance || 0)
      const tip = balance > 0
        ? `删除后剩余 ${balance} 字符会退回主账户。该账号的翻译记录仍会保留，可在用量里查询。`
        : '该账号的翻译记录仍会保留，可在用量里查询。'
      this.$confirm(
        `确定要删除子账号「${row.username}」吗？${tip}`,
        '删除子账号',
        { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
      ).then(() => {
        this.postRequest('/team/subs/delete', { id: row.id }).then(resp => {
          const data = resp && resp.data ? resp.data : {}
          if (data.success === 'error') {
            this.$message.error(data.msg || '删除失败')
            return
          }
          this.$message.success(data.msg || '已删除')
          this.load()
        })
      }).catch(() => {})
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
/* 删除是不可逆操作，按钮必须和「关闭」在视觉上拉开距离，避免误点 */
.team-page ::v-deep .el-button--text.danger { color: var(--el-color-danger, #f56c6c); }
</style>
