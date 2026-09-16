<template>
  <div class="admin-page">
    <el-row :gutter="16" style="margin-bottom: 12px">
      <el-col :span="6" v-for="item in cards" :key="item.label">
        <el-card shadow="hover">
          <div class="stat-label">{{ item.label }}</div>
          <div class="stat-value">{{ item.value }}</div>
        </el-card>
      </el-col>
    </el-row>
    <div class="admin-bar">
      <el-input v-model="keyword" placeholder="商户 / 摘要 / 通道" style="width: 220px" clearable></el-input>
      <el-button type="primary" @click="load">搜索</el-button>
      <el-button type="success" @click="openGrant">给商户加字符</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="createTime" label="时间" width="170"></el-table-column>
      <el-table-column prop="username" label="商户" width="100"></el-table-column>
      <el-table-column prop="engine" label="通道" width="100"></el-table-column>
      <el-table-column prop="direction" label="方向" width="90"></el-table-column>
      <el-table-column prop="chars" label="字符" width="80"></el-table-column>
      <el-table-column prop="cost" :label="'成本(' + currencyName + ')'" width="120"></el-table-column>
      <el-table-column prop="sell" :label="'售价(' + currencyName + ')'" width="120"></el-table-column>
      <el-table-column prop="snippet" label="摘要" min-width="180" show-overflow-tooltip></el-table-column>
    </el-table>
    <el-pagination style="margin-top:12px" :current-page="page" :page-size="size" :total="total"
                   layout="total, prev, pager, next" @current-change="onPage"></el-pagination>

    <el-dialog title="给商户加字符" :visible.sync="visible" width="420px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="商户">
          <el-select v-model="form.userId" style="width:100%">
            <el-option v-for="u in users" :key="u.id" :label="u.username + '（余额 ' + (u.charBalance || 0) + '）'" :value="u.id"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="字符数">
          <el-input-number v-model="form.chars" :min="10000" :step="1500000" style="width:100%"></el-input-number>
        </el-form-item>
        <el-form-item label="金额">
          <el-input-number v-model="form.price" :min="0" :precision="2" style="width:100%"></el-input-number>
          <span class="unit-tip">{{ currencyName }}（{{ currencySymbol }}）</span>
        </el-form-item>
        <el-form-item label="方式">
          <el-select v-model="form.type" style="width:100%">
            <el-option label="后台赠送" value="后台赠送"></el-option>
            <el-option label="微信" value="微信"></el-option>
            <el-option label="支付宝" value="支付宝"></el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="visible=false">取消</el-button>
        <el-button type="primary" @click="grant">确定</el-button>
      </span>
    </el-dialog>
  </div>
</template>
<script>
export default {
  data() {
    return {
      keyword: '', loading: false, rows: [], page: 1, size: 10, total: 0,
      stats: {}, users: [], visible: false,
      form: { userId: '', chars: 1500000, price: 200, type: '后台赠送' }
    }
  },
  computed: {
    cards() {
      const s = this.stats
      return [
        { label: '全站字符余额', value: s.charBalance || 0 },
        { label: '已用字符', value: s.charUsed || 0 },
        { label: '翻译售出', value: this.currencySymbol + (s.translateSell || 0) },
        { label: '通道成本', value: this.currencySymbol + (s.translateCost || 0) }
      ]
    }
  },
  mounted() {
    this.getRequest('/admin/stats').then(resp => { if (resp) this.stats = resp.data })
    this.getRequest('/admin/users', { page: 1, rows: 100 }).then(resp => { if (resp) this.users = resp.data.rows })
    this.load()
  },
  methods: {
    load() {
      this.loading = true
      this.getRequest('/admin/translate/logs', { page: this.page, rows: this.size, keyword: this.keyword }).then(resp => {
        this.loading = false
        if (resp && resp.status == 200) {
          this.rows = resp.data.rows
          this.total = resp.data.total
        }
      }).catch(() => { this.loading = false })
    },
    onPage(page) { this.page = page; this.load() },
    openGrant() {
      this.visible = true
    },
    grant() {
      this.postRequest('/admin/translate/grant', this.form).then(resp => {
        this.$message({ type: resp.data.success === 'error' ? 'error' : 'success', message: resp.data.msg })
        if (resp.data.success !== 'error') {
          this.visible = false
          this.getRequest('/admin/stats').then(r => { if (r) this.stats = r.data })
          this.getRequest('/admin/users', { page: 1, rows: 100 }).then(r => { if (r) this.users = r.data.rows })
        }
      })
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.admin-bar { margin-bottom: 12px; }
.stat-label { color: var(--w-text-faint); font-size: 13px; }
.stat-value { font-size: 22px; font-weight: 700; margin-top: 6px; }
.unit-tip { margin-left: 10px; color: var(--w-text-faint); font-size: 12px; }
</style>
