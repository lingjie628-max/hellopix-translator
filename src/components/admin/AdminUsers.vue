<template>
  <div class="admin-page">
    <div class="admin-bar">
      <el-input v-model="keyword" placeholder="搜索账号/昵称" style="width: 220px" clearable></el-input>
      <el-button type="primary" @click="load">搜索</el-button>
      <el-button type="success" @click="openEdit()">新建商户</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" border stripe :max-height="tableMaxHeight" style="width:100%">
      <el-table-column prop="id" label="ID" width="80"></el-table-column>
      <el-table-column prop="username" label="账号" width="120"></el-table-column>
      <el-table-column prop="nickname" label="商户名" width="140"></el-table-column>
      <el-table-column prop="basename" label="套餐" width="140"></el-table-column>
      <el-table-column label="类型" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.enterprise ? 'warning' : 'info'" size="mini">{{ scope.row.enterprise ? '企业' : '个人' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="子账号" width="80">
        <template slot-scope="scope">
          <el-button type="text" @click="openSubs(scope.row)">{{ scope.row.subCount || 0 }}</el-button>
        </template>
      </el-table-column>
      <!-- 工单：点数字跳到工单页并按这个商户过滤。
           空的时候显示 0 且不可点 —— 死链比空白更让人想点。 -->
      <el-table-column label="工单" width="80">
        <template slot-scope="scope">
          <el-button v-if="scope.row.orderCount > 0" type="text" @click="goTickets(scope.row)">{{ scope.row.orderCount }}</el-button>
          <span v-else class="muted">0</span>
        </template>
      </el-table-column>
      <el-table-column prop="charBalance" label="字符余额" width="100"></el-table-column>
      <el-table-column label="自动回复" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.autoReply ? 'success' : 'info'" size="mini">{{ scope.row.autoReply ? '开' : '关' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="expireTime" label="到期时间" width="170"></el-table-column>
      <!-- 创建时间：超管要判断"这个商户是老客户还是刚注册的"，
           光有到期时间看不出账号的年龄。后端 /admin/users 早就返回了
           createTime（created_at AS create_time），只是前端一直没这一列。 -->
      <el-table-column label="创建时间" width="170">
        <template slot-scope="scope">
          <span class="mono">{{ fmtTime(scope.row.createTime) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.status === 1 ? 'success' : 'info'">{{ scope.row.status === 1 ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="280">
        <template slot-scope="scope">
          <el-button type="text" @click="openEdit(scope.row)">编辑</el-button>
          <el-button type="text" @click="setEnterprise(scope.row)">{{ scope.row.enterprise ? '降为个人' : '升企业' }}</el-button>
          <el-button type="text" @click="unbind(scope.row)">{{ scope.row.bound ? '解绑设备' : '强制下线' }}</el-button>
          <el-button type="text" @click="toggle(scope.row)">{{ scope.row.status === 1 ? '停用' : '启用' }}</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination style="margin-top:12px" :current-page="page" :page-size="rowsPerPage" :total="total"
                   layout="total, prev, pager, next" @current-change="onPage"></el-pagination>

    <el-dialog :title="form.id ? '编辑商户' : '新建商户'" :visible.sync="visible" width="520px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="账号">
          <el-input v-model="form.username" :disabled="!!form.id"></el-input>
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" :placeholder="form.id ? '不填则不修改' : '请输入至少 8 位密码'"></el-input>
        </el-form-item>
        <el-form-item label="商户名">
          <el-input v-model="form.nickname"></el-input>
        </el-form-item>
        <el-form-item label="套餐">
          <el-select v-model="form.versionId" style="width:100%" @change="onPack">
            <el-option v-for="p in packs" :key="p.id" :label="p.title" :value="p.id"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="企业账号">
          <el-switch v-model="form.enterprise" :active-value="1" :inactive-value="0"></el-switch>
          <span class="trial-tip" style="margin-left:8px">企业可无限开子账号，子账号聊天号不限</span>
        </el-form-item>
        <el-form-item label="到期时间">
          <el-date-picker v-model="form.expireTime" type="datetime" value-format="yyyy-MM-dd HH:mm:ss" style="width:100%"></el-date-picker>
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="form.phone"></el-input>
        </el-form-item>
        <el-form-item label="字符余额">
          <el-input-number v-model="form.charBalance" :min="0" :step="1000"></el-input-number>
          <div v-if="!form.id" class="trial-tip">新商户默认送试用 {{ trialChars }} 字符，可改</div>
        </el-form-item>
        <el-form-item label="自动回复">
          <el-switch v-model="form.autoReply" :active-value="1" :inactive-value="0"></el-switch>
        </el-form-item>
        <el-form-item label="备注">
          <el-input type="textarea" v-model="form.remarks"></el-input>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="visible=false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </span>
    </el-dialog>

    <el-dialog :title="(subParent.username || '') + ' 的子账号'" :visible.sync="subVisible" width="720px">
      <el-table :data="subs" border stripe size="small">
        <el-table-column prop="username" label="账号" width="120"></el-table-column>
        <el-table-column prop="nickname" label="姓名" width="120"></el-table-column>
        <el-table-column prop="charBalance" label="字符" width="90"></el-table-column>
        <el-table-column label="聊天号" width="80"><template>不限</template></el-table-column>
        <el-table-column label="电脑" width="90">
          <template slot-scope="scope">{{ scope.row.bound ? '已绑定' : '未绑定' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template slot-scope="scope">{{ scope.row.status === 1 ? '启用' : '停用' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="140">
          <template slot-scope="scope">
            <!--
              2026-11-11：按钮原名「踢下线」，实际动作是「清 bound_device + 撤销全部会话」。
              名字只提踢人，超管想找"解绑设备"按字面根本搜不到，以为后台没这功能。
              按状态分开写：已绑定 → 解绑设备；未绑定 → 强制下线（没绑定可解，只剩踢会话）。
            -->
            <el-button type="text" @click="unbindSub(scope.row)">{{ scope.row.bound ? '解绑设备' : '强制下线' }}</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>
<script>
export default {
  data() {
    return {
      keyword: '',
      loading: false,
      rows: [],
      page: 1,
      rowsPerPage: 10,
      tableMaxHeight: 560,
      total: 0,
      visible: false,
      packs: [],
      trialChars: 10000,
      form: {},
      subVisible: false,
      subParent: {},
      subs: []
    }
  },
  mounted() {
    this.getRequest('/admin/packages').then(resp => { if (resp) this.packs = resp.data })
    this.getRequest('/admin/settings').then(resp => {
      if (resp && resp.data && resp.data.trialChars !== undefined) this.trialChars = Number(resp.data.trialChars)
    })
    this.load()
  },
  methods: {
    // 统一时间显示：库里是 timestamptz，mapRows 出来可能是
    // "2026-11-01 11:33:00+00"、ISO 串或空值。空值给 "-" 而不是空白，
    // 免得看起来像渲染失败。
    fmtTime(v) {
      if (v === null || v === undefined || v === '') return '-'
      const d = v instanceof Date ? v : new Date(v)
      if (isNaN(d.getTime())) return String(v)
      const p = n => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    },
    // 跳到工单页并按商户过滤。走路由 query 而不是全局状态，
    // 这样刷新/分享链接后过滤条件还在。
    goTickets(row) {
      this.$router.push({ path: '/admin/tickets', query: { username: row.username } })
    },
    load() {
      this.loading = true
      this.getRequest('/admin/users', { page: this.page, rows: this.rowsPerPage, keyword: this.keyword }).then(resp => {
        this.loading = false
        if (resp && resp.status == 200) {
          this.rows = resp.data.rows
          this.total = resp.data.total
        }
      }).catch(() => { this.loading = false })
    },
    onPage(page) {
      this.page = page
      this.load()
    },
    onPack(id) {
      const pack = this.packs.find(p => p.id === id)
      if (pack) this.form.port = pack.port
    },
    openEdit(row) {
      this.form = row ? Object.assign({}, row, { password: '' }) : { versionId: 1, port: 0, status: 1, charBalance: this.trialChars, autoReply: 0, enterprise: 0 }
      this.visible = true
    },
    openSubs(row) {
      this.subParent = row
      this.getRequest('/admin/subs', { userId: row.id }).then(resp => {
        this.subs = resp && resp.data ? (resp.data.rows || []) : []
        this.subVisible = true
      })
    },
    setEnterprise(row) {
      const enterprise = row.enterprise ? 0 : 1
      this.postRequest('/admin/users/enterprise', { id: row.id, enterprise }).then(resp => {
        this.$message.success(resp.data.msg)
        this.load()
      })
    },
    unbind(row) {
      this.postRequest('/admin/users/unbind', { id: row.id }).then(resp => {
        this.$message.success(resp.data.msg)
        this.load()
      })
    },
    unbindSub(row) {
      this.postRequest('/admin/users/unbind', { subId: row.id }).then(resp => {
        this.$message.success(resp.data.msg)
        this.openSubs(this.subParent)
      })
    },
    save() {
      this.postRequest('/admin/users/save', this.form).then(resp => {
        this.$message({ type: resp.data.success, message: resp.data.msg })
        if (resp.data.success !== 'error') {
          this.visible = false
          this.load()
        }
      })
    },
    toggle(row) {
      const status = row.status === 1 ? 0 : 1
      this.postRequest('/admin/users/status', { id: row.id, status }).then(() => this.load())
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.trial-tip { color: #909399; font-size: 12px; line-height: 1.4; }
.admin-bar { margin-bottom: 12px; }
</style>
