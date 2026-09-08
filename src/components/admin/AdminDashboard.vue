<template>
  <div class="admin-dash">
    <el-row :gutter="16">
      <el-col :span="6" v-for="item in cards" :key="item.label">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-label">{{ item.label }}</div>
          <div class="stat-value">{{ item.value }}</div>
          <div class="stat-sub" v-if="item.sub">{{ item.sub }}</div>
        </el-card>
      </el-col>
    </el-row>
    <el-row :gutter="16">
      <el-col :span="12">
        <el-card>
          <div slot="header">最近翻译扣费</div>
          <el-table :data="stats.recentTranslates || []" size="mini">
            <el-table-column prop="username" label="商户" width="90"></el-table-column>
            <el-table-column prop="direction" label="方向" width="80"></el-table-column>
            <el-table-column prop="chars" label="字符" width="70"></el-table-column>
            <el-table-column prop="sell" label="售价" width="80"></el-table-column>
            <el-table-column prop="snippet" label="摘要" min-width="120" show-overflow-tooltip></el-table-column>
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <div slot="header">超管操作记录</div>
          <el-table :data="stats.recentAudits || []" size="mini">
            <el-table-column prop="createTime" label="时间" width="160"></el-table-column>
            <el-table-column prop="admin" label="账号" width="90"></el-table-column>
            <el-table-column prop="action" label="动作" width="120"></el-table-column>
            <el-table-column prop="detail" label="对象" min-width="100" show-overflow-tooltip></el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>
<script>
export default {
  data() {
    return { stats: {} }
  },
  computed: {
    cards() {
      const s = this.stats
      return [
        { label: '商户', value: s.userCount || 0, sub: '启用 ' + (s.activeUsers || 0) },
        { label: '工单', value: s.orderCount || 0, sub: '进行中 ' + (s.openOrders || 0) },
        { label: '企业账号', value: s.enterpriseUsers || 0, sub: '子账号 ' + (s.subCount || 0) + ' · 聊天号不限' },
        { label: '进粉', value: s.fanCount || 0, sub: '短链点击 ' + (s.shortLinkHits || 0) },
        { label: '充值金额', value: '¥' + (s.rechargeSum || 0), sub: (s.rechargeCount || 0) + ' 笔' },
        { label: '字符余额', value: s.charBalance || 0, sub: '已用 ' + (s.charUsed || 0) },
        { label: '翻译售出', value: '¥' + (s.translateSell || 0), sub: '通道成本 ¥' + (s.translateCost || 0) },
        { label: '当前通道', value: s.activeEngine || '-', sub: s.packageBill || '按套餐整包售卖' }
      ]
    }
  },
  mounted() {
    this.getRequest('/admin/stats').then(resp => {
      if (resp && resp.status == 200) this.stats = resp.data
    })
  }
}
</script>
<style scoped>
.stat-card { margin-bottom: 16px; text-align: left; }
.stat-label { color: #909399; font-size: 13px; }
.stat-value { font-size: 24px; font-weight: 700; margin-top: 8px; color: #111827; }
.stat-sub { color: #c0c4cc; font-size: 12px; margin-top: 6px; }
.el-card { margin-bottom: 16px; text-align: left; }
</style>
