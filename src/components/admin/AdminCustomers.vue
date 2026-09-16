<template>
  <div class="admin-page">
    <el-tabs v-model="tab">
      <!-- ============ 客户 ============ -->
      <el-tab-pane label="统一客户" name="customers">
        <div class="bar">
          <el-input v-model="keyword" placeholder="搜索 Customer ID 或昵称" style="width:280px"
                    clearable @keyup.enter.native="loadCustomers"></el-input>
          <el-button type="primary" @click="loadCustomers">搜索</el-button>
          <span class="total">共 {{ total }} 个客户</span>
        </div>

        <el-table :data="rows" v-loading="loading" size="small" style="margin-top:12px">
          <el-table-column prop="public_id" label="Customer ID" width="130"></el-table-column>
          <el-table-column label="昵称" min-width="140">
            <template slot-scope="s">{{ s.row.display_name || '-' }}</template>
          </el-table-column>
          <el-table-column label="身份数" width="80" align="center">
            <template slot-scope="s">{{ s.row.identity_count }}</template>
          </el-table-column>
          <el-table-column label="会话数" width="80" align="center">
            <template slot-scope="s">{{ s.row.conversation_count }}</template>
          </el-table-column>
          <el-table-column label="涉及商户" width="100" align="center">
            <template slot-scope="s">
              <el-tag :type="s.row.merchant_count > 1 ? 'warning' : 'info'" size="mini">
                {{ s.row.merchant_count }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template slot-scope="s">
              <el-tag v-if="s.row.merged_into" type="info" size="mini">已合并</el-tag>
              <el-tag v-else type="success" size="mini">正常</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="90">
            <template slot-scope="s">
              <el-button type="text" @click="openDetail(s.row.id)">查看</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ============ 疑似重复 ============ -->
      <el-tab-pane name="merge">
        <span slot="label">疑似重复 <el-badge v-if="candidates.length" :value="candidates.length" /></span>
        <el-alert type="info" :closable="false" show-icon style="margin-bottom:12px">
          <template slot="title">疑似重复不会自动合并</template>
          <div class="tip-body">
            姓名相同太常见 —— 仅凭姓名合并会把两个真实客户的聊天记录混在一起，
            <b>而且不可逆</b>。所以这里只做提示，合并必须由你确认。
            处理后会留下记录，随时可查"这个客户当初为什么被合并"。
          </div>
        </el-alert>

        <el-table :data="candidates" v-loading="loadingMerge" size="small">
          <el-table-column prop="a_public" label="客户 A" width="120"></el-table-column>
          <el-table-column prop="b_public" label="客户 B" width="120"></el-table-column>
          <el-table-column prop="reason" label="匹配线索" width="150"></el-table-column>
          <el-table-column label="置信度" width="100">
            <template slot-scope="s">{{ (s.row.confidence * 100).toFixed(0) }}%</template>
          </el-table-column>
          <el-table-column prop="created_at" label="发现时间" min-width="160"></el-table-column>
          <el-table-column label="操作" width="150">
            <template slot-scope="s">
              <el-button type="text" @click="resolve(s.row, 'merge')">确认合并</el-button>
              <el-button type="text" class="danger-text" @click="resolve(s.row, 'reject')">驳回</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!loadingMerge && !candidates.length" description="暂无疑似重复客户"></el-empty>
      </el-tab-pane>
    </el-tabs>

    <!-- ============ 客户详情抽屉 ============ -->
    <el-drawer :visible.sync="detailVisible" size="720px" :title="detailTitle" direction="rtl">
      <div v-if="detail" class="detail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="Customer ID">{{ detail.customer.public_id }}</el-descriptions-item>
          <el-descriptions-item label="建档时间">{{ detail.customer.created_at }}</el-descriptions-item>
          <el-descriptions-item label="合并状态" :span="2">
            <el-tag v-if="detail.customer.merged_into" type="info" size="mini">
              已合并至 #{{ detail.customer.merged_into }}（{{ detail.customer.merged_at }}）
            </el-tag>
            <el-tag v-else type="success" size="mini">正常</el-tag>
          </el-descriptions-item>
        </el-descriptions>

        <h4>身份线索（{{ detail.identities.length }}）</h4>
        <el-table :data="detail.identities" size="mini">
          <el-table-column prop="identity_type" label="类型" width="110"></el-table-column>
          <el-table-column prop="fingerprint" label="指纹（前 16 位）" min-width="150"></el-table-column>
          <el-table-column prop="confidence" label="置信度" width="90"></el-table-column>
          <el-table-column label="涉及商户" width="90">
            <template slot-scope="s">{{ s.row.merchant_count }}</template>
          </el-table-column>
        </el-table>

        <h4>为什么认为是同一个人（{{ detail.matches.length }}）</h4>
        <el-table :data="detail.matches" size="mini">
          <el-table-column prop="created_at" label="时间" width="160"></el-table-column>
          <el-table-column prop="matched_by" label="依据" width="110"></el-table-column>
          <el-table-column prop="outcome" label="结果" width="110"></el-table-column>
          <el-table-column prop="source_platform" label="来源平台" width="110"></el-table-column>
        </el-table>

        <h4>关联账号 / 会话（{{ detail.conversations.length }}）</h4>
        <el-table :data="detail.conversations" size="mini">
          <el-table-column prop="platform" label="平台" width="120"></el-table-column>
          <el-table-column prop="account_key" label="我方账号" width="120"></el-table-column>
          <el-table-column prop="display_name" label="客户昵称" min-width="120"></el-table-column>
          <el-table-column prop="last_message_at" label="最近消息" width="160"></el-table-column>
        </el-table>

        <h4>跟进关系（{{ detail.owners.length }}）</h4>
        <el-table :data="detail.owners" size="mini">
          <el-table-column prop="employee_name" label="跟进人" width="110">
            <template slot-scope="s">{{ s.row.employee_name || ('#' + (s.row.employee_id || '-')) }}</template>
          </el-table-column>
          <el-table-column prop="account_key" label="账号" width="120"></el-table-column>
          <el-table-column prop="status" label="状态" width="110"></el-table-column>
          <el-table-column prop="assigned_at" label="开始时间" min-width="150"></el-table-column>
        </el-table>

        <h4>撞单记录（{{ detail.collisions.length }}）</h4>
        <el-table :data="detail.collisions" size="mini">
          <el-table-column prop="detected_at" label="时间" width="160"></el-table-column>
          <el-table-column label="类型" width="120">
            <template slot-scope="s">
              <el-tag :type="s.row.kind === 'cross_merchant' ? 'warning' : 'danger'" size="mini">
                {{ s.row.kind === 'cross_merchant' ? '跨商户' : '同商户' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="resolution" label="处理" width="120"></el-table-column>
          <el-table-column label="涉及商户" min-width="120">
            <template slot-scope="s">#{{ s.row.existing_user_id }} → #{{ s.row.new_user_id }}</template>
          </el-table-column>
        </el-table>

        <h4>涉及商户（{{ detail.merchants.length }}）</h4>
        <el-table :data="detail.merchants" size="mini">
          <el-table-column prop="username" label="商户" width="140"></el-table-column>
          <el-table-column prop="first_seen_at" label="首次出现" min-width="160"></el-table-column>
        </el-table>
      </div>
    </el-drawer>
  </div>
</template>

<script>
export default {
  name: 'AdminCustomers',
  data() {
    return {
      tab: 'customers',
      keyword: '',
      rows: [],
      total: 0,
      loading: false,
      candidates: [],
      loadingMerge: false,
      detailVisible: false,
      detail: null,
      detailTitle: '客户详情'
    }
  },
  mounted() {
    this.loadCustomers()
    this.loadCandidates()
  },
  methods: {
    loadCustomers() {
      this.loading = true
      // getRequest 的第二个参数**本身就是 params**，不要再包一层 { params }
      this.getRequest('/admin/customers', { keyword: this.keyword, limit: 50 })
        .then(resp => {
          if (!resp) return
          this.rows = resp.data.rows || []
          this.total = resp.data.total || 0
        }).finally(() => { this.loading = false })
    },
    loadCandidates() {
      this.loadingMerge = true
      this.getRequest('/admin/merge-candidates')
        .then(resp => { if (resp) this.candidates = resp.data.rows || [] })
        .finally(() => { this.loadingMerge = false })
    },
    openDetail(id) {
      this.getRequest('/admin/customers/' + id).then(resp => {
        if (!resp) return
        this.detail = resp.data
        this.detailTitle = '客户 ' + (this.detail.customer.public_id || '')
        this.detailVisible = true
      })
    },
    resolve(row, action) {
      const verb = action === 'merge' ? '合并' : '驳回'
      this.$confirm(`确认${verb} ${row.a_public} 与 ${row.b_public}？`, '请确认', { type: 'warning' })
        .then(() => this.postRequest('/admin/merge-candidates/' + row.id + '/resolve', { action }))
        .then(resp => {
          if (!resp) return
          this.$message({ type: 'success', message: verb + '成功' })
          this.loadCandidates()
          this.loadCustomers()
        }).catch(() => {})
    }
  }
}
</script>

<style scoped>
.admin-page { text-align: left; }
.bar { display: flex; align-items: center; gap: 10px; }
.total { color: var(--w-text-muted); font-size: 13px; }
.tip-body { font-size: 12px; line-height: 1.7; }
.danger-text { color: var(--w-danger); }
.detail h4 { margin: 18px 0 8px; font-size: 14px; color: var(--w-text); }
</style>
