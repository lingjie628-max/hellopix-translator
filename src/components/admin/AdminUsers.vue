<template>
  <div class="admin-page">
    <div class="admin-bar">
      <el-input v-model="keyword" placeholder="搜索账号/昵称" style="width: 220px" clearable></el-input>
      <el-button type="primary" @click="load">搜索</el-button>
      <el-button type="success" @click="openEdit()">新建商户</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" border stripe>
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
      <el-table-column prop="orderCount" label="工单" width="70"></el-table-column>
      <el-table-column prop="charBalance" label="字符余额" width="100"></el-table-column>
      <el-table-column label="自动回复" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.autoReply ? 'success' : 'info'" size="mini">{{ scope.row.autoReply ? '开' : '关' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="expireTime" label="到期时间" width="170"></el-table-column>
      <el-table-column label="状态" width="90">
        <template slot-scope="scope">
          <el-tag :type="scope.row.status === 1 ? 'success' : 'info'">{{ scope.row.status === 1 ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="430">
        <template slot-scope="scope">
          <el-button type="text" @click="openEdit(scope.row)">编辑</el-button>
          <el-button type="text" @click="setEnterprise(scope.row)">{{ scope.row.enterprise ? '降为个人' : '升企业' }}</el-button>
          <el-button type="text" @click="unbind(scope.row)">踢下线</el-button>
          <el-button type="text" @click="toggle(scope.row)">{{ scope.row.status === 1 ? '停用' : '启用' }}</el-button>
          <el-button type="text" @click="reclaim(scope.row)">回收字符</el-button>
          <el-button type="text" class="danger-link" @click="openDelete(scope.row)">删除</el-button>
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
          <el-switch v-model="form.enterprise" :active-value="1" :inactive-value="0" @change="onEnterprise"></el-switch>
          <span class="trial-tip" style="margin-left:8px">{{ form.enterprise ? '企业开子账号不限数量' : '按套餐额度开子账号' }}</span>
        </el-form-item>
        <el-form-item label="子账号额度">
          <el-input-number v-model="form.subQuota" :min="0" :step="1" :disabled="!!form.enterprise"></el-input-number>
          <span class="trial-tip" style="margin-left:8px">
            {{ form.enterprise ? '企业账号不受此额度限制' : '套餐已带默认额度，此处可单独调整' }}
          </span>
        </el-form-item>
        <el-form-item label="到期时间">
          <el-date-picker v-model="form.expireTime" type="datetime" value-format="yyyy-MM-dd HH:mm:ss" style="width:100%"></el-date-picker>
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="form.phone"></el-input>
        </el-form-item>
        <el-form-item label="字符余额">
          <!--
            编辑态必须只读。
            余额只能经「字符调整 / 回收字符」走 char_ledger 变更；服务端
            `/admin/users/save` 里有一条守卫：只要请求带了 charBalance 就 400
            （USE_CHARACTER_GRANT）。而本弹窗原先把余额渲染成可编辑输入框、
            并把它原样回传，导致**每一次「编辑商户」都被这条守卫挡下** ——
            表现就是"能建号、改不了套餐"。这里不只读，save() 里也剔除了该字段。
          -->
          <el-input-number v-model="form.charBalance" :min="0" :step="1000" :disabled="!!form.id"></el-input-number>
          <div v-if="!form.id" class="trial-tip">新商户默认送试用 {{ trialChars }} 字符，可改</div>
          <div v-else class="trial-tip">仅展示。余额调整请用列表里的「回收字符」或后台赠送</div>
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
        <el-table-column label="操作" width="100">
          <template slot-scope="scope">
            <el-button type="text" @click="unbindSub(scope.row)">踢下线</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog title="回收字符" :visible.sync="reclaimVisible" width="460px">
      <p>将把 <b>{{ reclaimRow.username }}</b> 的字符余额 <b>{{ reclaimRow.charBalance || 0 }}</b> 归零。</p>
      <p class="dialog-tip">账号保留。本次回收会写入一条字符流水（correction），事后查得到。</p>
      <el-form label-width="70px" style="margin-top:10px">
        <el-form-item label="备注">
          <el-input v-model="reclaimNote" placeholder="可不填"></el-input>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="reclaimVisible=false">取消</el-button>
        <el-button type="primary" @click="submitReclaim">确认回收</el-button>
      </span>
    </el-dialog>

    <el-dialog :title="delStep === 1 ? '删除商户（1/2）' : '删除商户（2/2）'"
               :visible.sync="delVisible" width="540px" @closed="resetDelete">
      <template v-if="delStep === 1">
        <p>删除<b>不可恢复</b>。请手工输入账号名以确认：<b>{{ delForm.username }}</b></p>
        <el-input v-model="delForm.confirm" placeholder="输入完整账号名" style="margin-top:8px"></el-input>
        <el-form label-width="70px" style="margin-top:12px">
          <el-form-item label="删除原因">
            <el-input v-model="delForm.reason" placeholder="如：测试账号清理（会写进存档）"></el-input>
          </el-form-item>
        </el-form>
      </template>
      <template v-else>
        <p class="dialog-tip">该商户有业务记录，删除会<b>一并清除且不可恢复</b>：</p>
        <ul class="impact-list">
          <li v-for="row in delImpactRows" :key="row.key">{{ row.label }} <b>{{ row.count }}</b> 条</li>
        </ul>
        <p class="dialog-tip">执行前会把商户行与账目快照存档到「已删除商户」（不挂外键），事后可回溯。</p>
      </template>
      <span slot="footer">
        <el-button @click="delVisible=false">取消</el-button>
        <el-button v-if="delStep === 2" @click="delStep=1">上一步</el-button>
        <el-button type="danger" :disabled="delStep === 1 && !delForm.confirm" @click="submitDelete">
          {{ delStep === 1 ? '下一步' : '确认删除' }}
        </el-button>
      </span>
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
      total: 0,
      visible: false,
      packs: [],
      trialChars: 10000,
      form: {},
      subVisible: false,
      subParent: {},
      subs: [],
      reclaimVisible: false,
      reclaimRow: {},
      reclaimNote: '',
      delVisible: false,
      delStep: 1,
      delForm: { id: null, username: '', confirm: '', reason: '' },
      delRemoved: {}
    }
  },
  computed: {
    // 删除确认弹窗第二步要展示"到底会删掉什么"。
    // 这些条数是服务端在 409 响应里带回来的（NEED_ACKNOWLEDGE），
    // 不是前端估算 —— 以数据库实际行的 count 为准。
    delImpactRows() {
      const labels = {
        recharges: '充值单', translate_logs: '翻译记录', translation_reservations: '翻译预留',
        translation_usage: '翻译用量', orders: '工单', character_transfers: '字符划转',
        char_ledger: '字符流水', sub_accounts: '子账号', conversations: '会话', messages: '消息',
        customer_merchant_links: '客户绑定', customer_owners: '客户归属', scripts: '脚本',
        login_logs: '登录日志', short_links: '短链', identity_match_events: '身份匹配'
      }
      return Object.keys(this.delRemoved || {})
        .filter(key => Number(this.delRemoved[key]) > 0)
        .map(key => ({ key, label: labels[key] || key, count: Number(this.delRemoved[key]) }))
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
      if (!pack) return
      this.form.port = pack.port
      // 换套餐时把该套餐自带的子账号额度带出来，省得超管还要去翻套餐配置。
      // 企业账号不受额度限制，不去覆盖它的值。
      if (!this.form.enterprise) this.form.subQuota = Number(pack.subQuota || 0)
    },
    onEnterprise(value) {
      // 升企业：额度框会被置灰，值保持不动（降回来时还是它）。
      // 降为个人：按当前套餐把额度恢复成默认，否则会沿用"无限"时的残留值。
      if (Number(value) === 1) return
      const pack = this.packs.find(p => p.id === this.form.versionId)
      if (pack) this.form.subQuota = Number(pack.subQuota || 0)
    },
    openEdit(row) {
      if (row) {
        /**
         * 布尔列必须归一成 0/1。
         *
         * 列表接口回的是 Postgres 布尔（`true`/`false`），而下面两个开关用的是
         * `:active-value="1"`。`true !== 1`，所以**开关永远渲染成「关」** ——
         * 哪怕库里明明是开的。表现就是"打开→保存→再打开还是关的"，
         * 让人以为没保存成功（实际上早就存进去了，生产上连点了三次）。
         *
         * 顺带也避免把布尔 `true` 原样提交：`encodeForm` 会把它序列化成字符串
         * `"true"`，服务端 `Number("true")` 是 NaN，会被判成 false —— 那就会
         * **真的**把企业账号关掉。
         */
        this.form = Object.assign({}, row, {
          password: '',
          enterprise: Number(row.enterprise) ? 1 : 0,
          autoReply: Number(row.autoReply) ? 1 : 0
        })
      } else {
        // 新建：默认取第一个套餐自带的端口与子账号额度，省一步手填
        const first = this.packs[0] || {}
        this.form = {
          versionId: first.id || 1,
          port: Number(first.port || 0),
          status: 1,
          charBalance: this.trialChars,
          autoReply: 0,
          enterprise: 0,
          subQuota: Number(first.subQuota || 0)
        }
      }
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
      // 编辑时**绝不能**回传 charBalance。
      // 服务端 `/admin/users/save` 有一条守卫：请求带 charBalance 就 400
      // （USE_CHARACTER_GRANT），因为余额只能经 char_ledger 变更。
      // 原先本方法直接提交整个 form，而 form 里始终有 charBalance ——
      // 于是「编辑商户」必然失败，表现就是"能建号、改不了套餐"。
      const payload = Object.assign({}, this.form)
      if (payload.id) delete payload.charBalance
      this.postRequest('/admin/users/save', payload).then(resp => {
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
    },
    reclaim(row) {
      this.reclaimRow = row
      this.reclaimNote = ''
      this.reclaimVisible = true
    },
    submitReclaim() {
      this.postRequest('/admin/users/reclaim', { id: this.reclaimRow.id, note: this.reclaimNote }).then(resp => {
        this.$message.success(resp.data.msg)
        this.reclaimVisible = false
        this.load()
      }).catch(() => {})
    },
    openDelete(row) {
      this.delForm = { id: row.id, username: row.username, confirm: '', reason: '' }
      this.delRemoved = {}
      this.delStep = 1
      this.delVisible = true
    },
    resetDelete() {
      this.delForm = { id: null, username: '', confirm: '', reason: '' }
      this.delRemoved = {}
      this.delStep = 1
    },
    submitDelete() {
      const payload = {
        id: this.delForm.id,
        confirmUsername: this.delForm.confirm,
        reason: this.delForm.reason
      }
      // 第二步才带 acknowledge：服务端据此判断"操作人已经看过影响清单"。
      if (this.delStep === 2) payload.acknowledge = true
      // silent：409 的 msg 是"要不要继续"的中间态，不该被拦成一条红色错误提示。
      this.postRequest('/admin/users/delete', payload, { silent: true }).then(resp => {
        this.$message.success(resp.data.msg)
        this.delVisible = false
        this.load()
      }).catch(error => {
        const data = (error.response && error.response.data) || {}
        if (data.code === 'NEED_ACKNOWLEDGE') {
          this.delRemoved = (data.details && data.details.removed) || {}
          this.delStep = 2
          return
        }
        this.$message.error(data.msg || '删除失败')
      })
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.trial-tip { color: var(--w-text-faint); font-size: 12px; line-height: 1.4; }
.admin-bar { margin-bottom: 12px; }
.danger-link { color: #f56c6c; }
.dialog-tip { color: var(--w-text-faint); font-size: 12px; line-height: 1.6; }
.impact-list { margin: 10px 0; padding-left: 18px; font-size: 13px; line-height: 1.8; }
</style>
