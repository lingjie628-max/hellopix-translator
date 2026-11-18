<template>
  <div class="ticket-page">
    <div class="tk-bar">
      <el-button type="primary" @click="openCreate">+ 新建工单</el-button>
      <el-select v-model="status" style="width:140px" size="small" @change="reload">
        <el-option label="进行中" value="open"></el-option>
        <el-option label="已解决" value="resolved"></el-option>
        <el-option label="已关闭" value="closed"></el-option>
        <el-option label="全部" value="all"></el-option>
      </el-select>
      <span class="tk-hint">遇到问题先提工单，客服会在这里回复你</span>
    </div>

    <div class="tk-body" v-loading="loading">
      <!-- 左：工单列表 -->
      <div class="tk-list">
        <div v-if="!rows.length" class="tk-empty">
          还没有工单。点上方「新建工单」，把遇到的问题写清楚，客服会尽快回复。
        </div>
        <div v-for="t in rows" :key="t.id" class="tk-item" :class="{ active: current && current.id === t.id }"
             @click="open(t.id)">
          <div class="tk-item-top">
            <span class="tk-subject">{{ t.subject }}</span>
            <el-tag :type="statusType(t.status)" size="mini">{{ t.statusLabel }}</el-tag>
          </div>
          <div class="tk-item-bottom">
            <span>#{{ t.id }} · {{ t.categoryLabel }}</span>
            <span>{{ fmt(t.lastReplyAt || t.createdAt) }}</span>
          </div>
        </div>
      </div>

      <!-- 右：会话 -->
      <div class="tk-chat">
        <div v-if="!current" class="tk-empty">选择左边的工单查看详情</div>
        <template v-else>
          <div class="tk-chat-head">
            <div>
              <strong>{{ current.subject }}</strong>
              <span class="tk-meta">#{{ current.id }} · {{ current.categoryLabel }}</span>
            </div>
            <el-tag :type="statusType(current.status)" size="small">{{ current.statusLabel }}</el-tag>
          </div>

          <div class="tk-stream">
            <div v-for="m in messages" :key="m.id" class="tk-msg" :class="m.authorType">
              <div class="tk-bubble">{{ m.body }}</div>
              <div class="tk-msg-meta">{{ who(m) }} · {{ fmt(m.createdAt) }}</div>
            </div>
          </div>

          <div v-if="current.status === 'closed'" class="tk-closed">
            这张工单已关闭。如果问题还在，请新建一张工单并附上 #{{ current.id }}。
          </div>
          <div v-else class="tk-reply">
            <el-input v-model="reply" type="textarea" :rows="3" maxlength="5000" show-word-limit
                      placeholder="补充说明…（Enter 换行，点右侧按钮发送）"></el-input>
            <el-button type="primary" :loading="sending" @click="send">发送</el-button>
          </div>
        </template>
      </div>
    </div>

    <el-pagination v-if="total > pageSize" style="margin-top:12px" :current-page="page" :page-size="pageSize"
                   :total="total" layout="total, prev, pager, next" @current-change="p => { page = p; load() }">
    </el-pagination>

    <!-- 新建工单 -->
    <el-dialog title="新建工单" :visible.sync="showCreate" width="560px" :close-on-click-modal="false">
      <el-form label-width="72px">
        <el-form-item label="问题类型">
          <el-select v-model="form.category" style="width:100%">
            <el-option v-for="c in categories" :key="c.value" :label="c.label" :value="c.value"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="标题">
          <el-input v-model="form.subject" maxlength="200" show-word-limit
                    placeholder="一句话说清问题，例如：充值 20U 已转但余额没到"></el-input>
        </el-form-item>
        <el-form-item label="详细描述">
          <el-input v-model="form.body" type="textarea" :rows="6" maxlength="5000" show-word-limit
                    placeholder="请写清：什么时候、做了什么、看到什么报错。充值问题请附上转账哈希或金额。">
          </el-input>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">提交</el-button>
      </span>
    </el-dialog>
  </div>
</template>

<script>
export default {
  data() {
    return {
      loading: false,
      rows: [],
      total: 0,
      page: 1,
      pageSize: 10,
      status: 'open',
      current: null,
      messages: [],
      reply: '',
      sending: false,
      showCreate: false,
      creating: false,
      form: { category: 'other', subject: '', body: '' },
      categories: [
        { value: 'recharge', label: '充值问题' },
        { value: 'translation', label: '翻译问题' },
        { value: 'login', label: '登录异常' },
        { value: 'bug', label: '功能故障' },
        { value: 'feature', label: '功能建议' },
        { value: 'other', label: '其他' }
      ]
    }
  },
  mounted() { this.load() },
  methods: {
    statusType(s) {
      return { new: 'warning', in_progress: '', waiting_user: 'danger', resolved: 'success', closed: 'info' }[s] || 'info'
    },
    // 时间显示到分钟就够 —— 工单对话不需要精确到秒，
    // 而且秒数会让同一分钟的连续追问看起来像乱序。
    fmt(v) {
      if (!v) return ''
      const d = v instanceof Date ? v : new Date(v)
      if (isNaN(d.getTime())) return String(v)
      const p = n => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    },
    who(m) {
      if (m.authorType === 'admin') return m.authorName ? `客服 ${m.authorName}` : '客服'
      if (m.authorType === 'system') return '系统'
      return m.authorName || '我'
    },
    reload() {
      this.page = 1
      this.current = null
      this.messages = []
      this.load()
    },
    load() {
      this.loading = true
      this.getRequest('/tickets', { status: this.status, page: this.page, rows: this.pageSize }).then(resp => {
        this.loading = false
        if (resp && resp.status == 200) {
          this.rows = resp.data.rows || []
          this.total = resp.data.total || 0
        }
      }).catch(() => { this.loading = false })
    },
    open(id) {
      this.getRequest(`/tickets/${id}`).then(resp => {
        if (resp && resp.status == 200) {
          this.current = resp.data.ticket
          this.messages = resp.data.messages || []
          // 读完清掉侧栏红点，不必等下一次轮询
          window.dispatchEvent(new CustomEvent('pix-user-ticket-read'))
        }
      })
    },
    send() {
      const body = (this.reply || '').trim()
      if (!body) return
      this.sending = true
      this.postRequest('/tickets/reply', { id: this.current.id, body }).then(resp => {
        this.sending = false
        const data = (resp && resp.data) || {}
        if (data.success === 'success') {
          this.reply = ''
          this.open(this.current.id)
          this.load()
        } else if (data.msg) {
          this.$message.error(data.msg)
        }
      }).catch(() => { this.sending = false })
    },
    openCreate() {
      this.form = { category: 'other', subject: '', body: '' }
      this.showCreate = true
    },
    submitCreate() {
      if (!this.form.subject.trim()) return this.$message.warning('请填写标题')
      if (!this.form.body.trim()) return this.$message.warning('请填写详细描述')
      this.creating = true
      this.postRequest('/tickets/create', this.form).then(resp => {
        this.creating = false
        const data = (resp && resp.data) || {}
        if (data.success === 'success') {
          this.$message.success(data.msg || '工单已提交')
          this.showCreate = false
          this.status = 'open'
          this.reload()
          if (data.id) this.open(data.id)
        } else if (data.msg) {
          this.$message.error(data.msg)
        }
      }).catch(() => { this.creating = false })
    }
  }
}
</script>

<style scoped>
.ticket-page { text-align: left; background: var(--w-surface); padding: 16px; }
.tk-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.tk-hint { color: var(--w-text-faint); font-size: 13px; }
.tk-body { display: flex; gap: 12px; min-height: 420px; }
.tk-list { width: 300px; flex: none; border-right: 1px solid var(--w-border, #eef1f5); padding-right: 12px; }
.tk-item { padding: 10px; border-radius: 6px; cursor: pointer; margin-bottom: 6px; }
.tk-item:hover { background: rgba(22, 119, 255, 0.06); }
.tk-item.active { background: rgba(22, 119, 255, 0.1); }
.tk-item-top { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
.tk-subject { font-size: 14px; color: var(--w-text, #1f2329); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-item-bottom { display: flex; justify-content: space-between; color: var(--w-text-faint); font-size: 12px; margin-top: 6px; }
.tk-chat { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.tk-chat-head { display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; border-bottom: 1px solid var(--w-border, #eef1f5); }
.tk-meta { color: var(--w-text-faint); font-size: 12px; margin-left: 8px; }
.tk-stream { flex: 1; overflow-y: auto; max-height: 380px; padding: 12px 0; }
.tk-msg { margin-bottom: 14px; display: flex; flex-direction: column; }
/* 客服在左、自己在右：长对话里靠位置就能分清谁说的，不必逐条读名字 */
.tk-msg.admin { align-items: flex-start; }
.tk-msg.user { align-items: flex-end; }
.tk-bubble { max-width: 78%; padding: 9px 12px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
.tk-msg.admin .tk-bubble { background: #f4f6f9; color: #1f2329; }
.tk-msg.user .tk-bubble { background: #1677ff; color: #fff; }
.tk-msg.system .tk-bubble { background: transparent; color: var(--w-text-faint); font-size: 12px; }
.tk-msg-meta { font-size: 12px; color: var(--w-text-faint); margin-top: 4px; }
.tk-reply { display: flex; gap: 8px; align-items: flex-end; padding-top: 10px; border-top: 1px solid var(--w-border, #eef1f5); }
.tk-reply .el-textarea { flex: 1; }
.tk-closed { padding: 12px; background: #fff8e6; color: #8a6d3b; border-radius: 6px; font-size: 13px; }
.tk-empty { color: var(--w-text-faint); font-size: 13px; padding: 24px 8px; text-align: center; }
</style>
