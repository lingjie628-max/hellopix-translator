<template>
  <div class="admin-page ticket-page">
    <!-- 左：列表。右：会话。两块同屏，客服不用来回翻页 -->
    <div class="ticket-list">
      <el-card>
        <div slot="header" class="list-head">
          <span>工单</span>
          <el-button type="primary" size="mini" @click="openCreate">代客开单</el-button>
        </div>

        <div class="filters">
          <el-select v-model="filters.status" size="mini" @change="reload">
            <el-option label="全部未关闭" value="open"></el-option>
            <el-option label="待处理" value="new"></el-option>
            <el-option label="处理中" value="in_progress"></el-option>
            <el-option label="待商户回复" value="waiting_user"></el-option>
            <el-option label="已解决" value="resolved"></el-option>
            <el-option label="已关闭" value="closed"></el-option>
            <el-option label="全部" value="all"></el-option>
          </el-select>
          <el-select v-model="filters.category" size="mini" @change="reload">
            <el-option label="全部分类" value="all"></el-option>
            <el-option v-for="c in categories" :key="c.value" :label="c.label" :value="c.value"></el-option>
          </el-select>
        </div>
        <el-input
          v-model="filters.keyword"
          size="mini"
          placeholder="搜主题或商户名"
          clearable
          @keyup.enter.native="reload"
          @clear="reload"></el-input>

        <div v-loading="loading" class="list-body">
          <div v-if="!rows.length" class="empty">还没有工单</div>
          <div
            v-for="row in rows"
            :key="row.id"
            class="ticket-item"
            :class="{ active: current && current.id === row.id, closed: row.status === 'closed' }"
            @click="select(row.id)">
            <div class="line1">
              <i v-if="row.adminUnread" class="dot"></i>
              <span class="subject">{{ row.subject }}</span>
              <el-tag :type="priorityType(row.priority)" size="mini">{{ priorityLabel(row.priority) }}</el-tag>
            </div>
            <div class="line2">
              <span>{{ row.username || '未关联商户' }}</span>
              <span>·</span>
              <span>{{ statusLabel(row.status) }}</span>
              <span class="time">{{ fmt(row.lastReplyAt || row.createdAt) }}</span>
            </div>
          </div>
        </div>
        <div v-if="total > rows.length" class="more">
          <el-button type="text" size="mini" @click="loadMore">加载更多（{{ rows.length }}/{{ total }}）</el-button>
        </div>
      </el-card>
    </div>

    <!-- 右：会话 -->
    <div class="ticket-detail">
      <el-card v-if="!current" class="placeholder">
        <div class="empty">从左侧选择一张工单</div>
      </el-card>

      <el-card v-else v-loading="detailLoading">
        <div slot="header" class="detail-head">
          <div>
            <div class="detail-title">
              #{{ current.id }} {{ current.subject }}
            </div>
            <div class="detail-meta">
              <span>{{ current.username || '未关联商户' }}</span>
              <span>·</span>
              <span>{{ fmt(current.createdAt) }}</span>
              <span v-if="current.assignee">· 负责人 {{ current.assignee }}</span>
            </div>
          </div>
          <div class="detail-actions">
            <el-select v-model="current.status" size="mini" @change="changeStatus">
              <el-option v-for="s in statuses" :key="s.value" :label="s.label" :value="s.value"></el-option>
            </el-select>
            <el-select v-model="current.priority" size="mini" @change="saveField('priority', current.priority)">
              <el-option v-for="p in priorities" :key="p.value" :label="p.label" :value="p.value"></el-option>
            </el-select>
            <el-select v-model="current.category" size="mini" @change="saveField('category', current.category)">
              <el-option v-for="c in categories" :key="c.value" :label="c.label" :value="c.value"></el-option>
            </el-select>
          </div>
        </div>

        <div class="messages">
          <div v-for="m in current.messages" :key="m.id" class="msg" :class="m.authorType">
            <div class="msg-head">
              <span class="who">{{ m.authorName || m.authorType }}</span>
              <el-tag v-if="m.internal" type="warning" size="mini">内部备注</el-tag>
              <span class="time">{{ fmt(m.createdAt) }}</span>
            </div>
            <div class="msg-body">{{ m.body }}</div>
          </div>
        </div>

        <!-- 已关闭的票不再接受回复：让它变成终态，否则统计永远在变 -->
        <div v-if="current.status === 'closed'" class="composer-closed">
          工单已关闭。如商户问题复现，请新建工单并引用 #{{ current.id }}。
        </div>
        <div v-else class="composer">
          <el-input
            v-model="reply"
            type="textarea"
            :rows="3"
            placeholder="输入回复内容。勾选「内部备注」则商户看不到。"></el-input>
          <div class="composer-actions">
            <el-checkbox v-model="internal">内部备注（商户不可见）</el-checkbox>
            <div>
              <el-button v-if="current.status === 'in_progress'" size="mini" @click="changeStatus('waiting_user')">
                等商户回复
              </el-button>
              <el-button v-if="current.status !== 'resolved'" size="mini" @click="changeStatus('resolved')">
                标记已解决
              </el-button>
              <el-button type="primary" size="mini" :loading="sending" @click="send">发送</el-button>
            </div>
          </div>
        </div>
      </el-card>
    </div>

    <!-- 代客开单 -->
    <el-dialog title="代客开单" :visible.sync="createVisible" width="560px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="商户">
          <el-select v-model="form.userId" filterable clearable placeholder="不关联也可以" style="width:100%">
            <el-option
              v-for="u in users"
              :key="u.id"
              :label="`${u.username}（${u.nickname || ''}）`"
              :value="u.id"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="主题">
          <el-input v-model="form.subject" maxlength="200" show-word-limit placeholder="一句话概括问题"></el-input>
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="form.category" style="width:100%">
            <el-option v-for="c in categories" :key="c.value" :label="c.label" :value="c.value"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="优先级">
          <el-select v-model="form.priority" style="width:100%">
            <el-option v-for="p in priorities" :key="p.value" :label="p.label" :value="p.value"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="内容">
          <el-input v-model="form.body" type="textarea" :rows="5" placeholder="把商户描述的问题记下来"></el-input>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="create">创建</el-button>
      </span>
    </el-dialog>
  </div>
</template>

<script>
// 枚举与中文名以服务端 ticket-service 为准，前端只做展示映射，
// 不在这里复刻状态机 —— 两套规则迟早会分叉。
const STATUSES = [
  { value: 'new', label: '待处理' },
  { value: 'in_progress', label: '处理中' },
  { value: 'waiting_user', label: '待商户回复' },
  { value: 'resolved', label: '已解决' },
  { value: 'closed', label: '已关闭' }
]
const PRIORITIES = [
  { value: 'urgent', label: '紧急' },
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' }
]
const CATEGORIES = [
  { value: 'recharge', label: '充值/账单' },
  { value: 'translation', label: '翻译问题' },
  { value: 'login', label: '登录/账号' },
  { value: 'bug', label: '故障' },
  { value: 'feature', label: '功能建议' },
  { value: 'other', label: '其它' }
]

export default {
  data() {
    return {
      statuses: STATUSES,
      priorities: PRIORITIES,
      categories: CATEGORIES,
      filters: { status: 'open', category: 'all', keyword: '' },
      rows: [],
      total: 0,
      page: 1,
      size: 30,
      loading: false,
      detailLoading: false,
      current: null,
      reply: '',
      internal: false,
      sending: false,
      createVisible: false,
      creating: false,
      users: [],
      form: { userId: null, subject: '', category: 'other', priority: 'medium', body: '' }
    }
  },
  mounted() {
    // 从商户管理页点「工单」数字跳过来时带着 ?username=xxx，
    // 直接当成关键词过滤，省得客服再手打一遍商户名。
    const q = this.$route && this.$route.query && this.$route.query.username
    if (q) {
      this.filters.status = 'all'
      this.filters.keyword = String(q)
    }
    this.reload()
  },
  methods: {
    statusLabel(v) { return (STATUSES.find(s => s.value === v) || {}).label || v },
    priorityLabel(v) { return (PRIORITIES.find(p => p.value === v) || {}).label || v },
    priorityType(v) {
      return { urgent: 'danger', high: 'warning', medium: '', low: 'info' }[v] || ''
    },
    fmt(t) {
      if (!t) return ''
      const d = new Date(t)
      if (Number.isNaN(d.getTime())) return String(t)
      const pad = n => String(n).padStart(2, '0')
      return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    },
    reload() {
      this.page = 1
      this.rows = []
      this.total = 0
      this.fetch()
    },
    loadMore() {
      this.page += 1
      this.fetch()
    },
    fetch() {
      this.loading = true
      this.getRequest('/admin/tickets', Object.assign({}, this.filters, {
        page: this.page,
        rows: this.size
      })).then(resp => {
        if (!resp) return
        this.rows = this.page === 1 ? resp.data.rows : this.rows.concat(resp.data.rows)
        this.total = resp.data.total
      }).finally(() => { this.loading = false })
    },
    select(id) {
      this.detailLoading = true
      this.reply = ''
      this.internal = false
      this.getRequest(`/admin/tickets/${id}`).then(resp => {
        if (!resp) return
        this.current = resp.data
        // 已读后列表上的红点要立刻消失，否则客服会以为没读
        const row = this.rows.find(r => r.id === resp.data.id)
        if (row && row.adminUnread) {
          row.adminUnread = false
          // 侧栏数字是 AdminLayout 在轮询的，不等 60 秒 —— 读完立刻让它重拉
          this.$root.$emit('pix-ticket-read')
        }
      }).finally(() => { this.detailLoading = false })
    },
    changeStatus(status) {
      if (!this.current || status === undefined) return
      this.saveField('status', status)
    },
    saveField(field, value) {
      if (!this.current) return
      const body = { id: this.current.id }
      body[field] = value
      this.postRequest('/admin/tickets/update', body).then(resp => {
        if (!resp || resp.data.success !== 'success') return
        this.$message.success(resp.data.msg || '已更新')
        this.refreshCurrent()
        this.refreshRow(body)
      }, () => {
        // 失败时把下拉框恢复成服务端的真实状态，避免界面显示一个没写进去的值
        this.refreshCurrent()
      })
    },
    refreshCurrent() {
      if (!this.current) return
      this.getRequest(`/admin/tickets/${this.current.id}`).then(resp => {
        if (resp) this.current = resp.data
      })
    },
    refreshRow(body) {
      const row = this.rows.find(r => r.id === body.id)
      if (!row) return
      Object.keys(body).forEach(k => { if (k !== 'id') row[k] = body[k] })
    },
    send() {
      const body = this.reply.trim()
      if (!body) { this.$message.warning('回复内容不能为空'); return }
      this.sending = true
      this.postRequest('/admin/tickets/reply', {
        id: this.current.id, body, internal: this.internal ? 1 : 0
      }).then(resp => {
        if (!resp || resp.data.success !== 'success') return
        this.$message.success(resp.data.msg || '已发送')
        this.reply = ''
        this.internal = false
        this.refreshCurrent()
      }).finally(() => { this.sending = false })
    },
    openCreate() {
      this.form = { userId: null, subject: '', category: 'other', priority: 'medium', body: '' }
      this.createVisible = true
      // 商户列表只在需要时拉，减少后台每次进页面的一次全表请求
      if (!this.users.length) {
        this.getRequest('/admin/users', { page: 1, rows: 100 }).then(resp => {
          if (resp) this.users = resp.data.rows || resp.data || []
        })
      }
    },
    create() {
      if (!this.form.subject.trim()) { this.$message.warning('请填写主题'); return }
      if (!this.form.body.trim()) { this.$message.warning('请填写内容'); return }
      this.creating = true
      this.postRequest('/admin/tickets/create', this.form).then(resp => {
        if (!resp || resp.data.success !== 'success') return
        this.$message.success(resp.data.msg || '工单已创建')
        this.createVisible = false
        this.reload()
      }).finally(() => { this.creating = false })
    }
  }
}
</script>

<style scoped>
.ticket-page { display: flex; gap: 16px; align-items: flex-start; }
.ticket-list { width: 360px; flex: none; }
.ticket-detail { flex: 1; min-width: 0; }
.list-head { display: flex; align-items: center; justify-content: space-between; }
.filters { display: flex; gap: 8px; margin-bottom: 8px; }
.filters .el-select { flex: 1; }
.list-body { margin-top: 8px; max-height: calc(100vh - 320px); overflow-y: auto; }
.empty { padding: 24px 0; text-align: center; color: var(--w-text-faint); }
.ticket-item {
  padding: 8px 10px; border-radius: 6px; cursor: pointer; border: 1px solid transparent;
}
.ticket-item:hover { background: var(--w-bg-soft, rgba(0, 0, 0, 0.03)); }
.ticket-item.active { border-color: var(--el-color-primary); background: var(--w-bg-soft, rgba(0, 0, 0, 0.03)); }
.ticket-item.closed { opacity: 0.6; }
.line1 { display: flex; align-items: center; gap: 6px; }
.line1 .subject { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #f56c6c; flex: none; }
.line2 { display: flex; gap: 6px; font-size: 12px; color: var(--w-text-faint); margin-top: 2px; }
.line2 .time { margin-left: auto; }
.more { text-align: center; }
.detail-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.detail-title { font-weight: 600; }
.detail-meta { font-size: 12px; color: var(--w-text-faint); margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; }
.detail-actions { display: flex; gap: 8px; flex: none; }
.detail-actions .el-select { width: 110px; }
.messages { max-height: calc(100vh - 430px); overflow-y: auto; }
.msg { padding: 10px 12px; border-radius: 8px; margin-bottom: 10px; background: var(--w-bg-soft, rgba(0, 0, 0, 0.03)); }
.msg.admin { background: rgba(64, 158, 255, 0.08); }
.msg-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--w-text-faint); }
.msg-head .who { font-weight: 600; color: var(--w-text); }
.msg-head .time { margin-left: auto; }
.msg-body { margin-top: 6px; white-space: pre-wrap; word-break: break-word; }
.composer { margin-top: 12px; }
.composer-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
.composer-closed { margin-top: 12px; padding: 12px; text-align: center; color: var(--w-text-faint); background: var(--w-bg-soft, rgba(0, 0, 0, 0.03)); border-radius: 6px; }
</style>
