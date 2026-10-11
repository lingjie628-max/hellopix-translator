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
            <!--
              这一列原来显示「售价」，而 translate_logs.sell_amount 是 core-service
              里写死的 0（本系统按套餐整包售卖，不按字符计价）—— 每一行都是 0，
              等于一列噪声。改显示「成本」，那是真实发生的上游消耗。
              完整的成本/售价两列仍在「翻译计费」页。
            -->
            <el-table-column prop="cost" label="成本" width="90"></el-table-column>
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
      // 卡片顺序：先"是谁"（商户/企业），再"运营/钱"（进粉/待支付/充值/毛利），
      // 最后"资产与通道"（字符余额/当前通道）。正好 8 张、两行四列。
      //
      // 已移除的两张卡：
      //   · 「工单」—— 工单功能 2026-09-25 已下线、代码里没有任何创建入口，
      //     生产 orders 表 0 行，留着只会让人以为显示坏了。
      //   · 「翻译售出」—— 本系统按套餐整包售卖，translate_logs.sell_amount
      //     是 core-service 里写死的 0，按字符计价的售出恒为 $0。
      //     换成「毛利估算」（实收 − 通道成本），那才是真正能看的钱。
      return [
        { label: '商户', value: s.userCount || 0, sub: '启用 ' + (s.activeUsers || 0) },
        { label: '企业账号', value: s.enterpriseUsers || 0, sub: '子账号 ' + (s.subCount || 0) + ' · 聊天号不限' },
        { label: '进粉', value: s.fanCount || 0, sub: '短链点击 ' + (s.shortLinkHits || 0) },
        { label: '待支付订单', value: s.rechargePending || 0, sub: '已失效 ' + (s.rechargePendingStale || 0) },
        { label: '充值金额', value: this.currencySymbol + (s.rechargeSum || 0), sub: (s.rechargeCount || 0) + ' 笔' },
        { label: '毛利估算', value: this.currencySymbol + (s.grossProfit || 0), sub: '减通道成本 ' + this.currencySymbol + (s.translateCost || 0) },
        { label: '字符余额', value: s.charBalance || 0, sub: '已用 ' + (s.charUsed || 0) },
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
/* 全部走主题变量：之前 .stat-value 写死 #111827，
   在夜间模式的深色卡片上等于隐形 —— 数字看不见，整张卡就显得空荡。 */
.stat-card { margin-bottom: 16px; text-align: left; }
.stat-label { color: var(--w-text-muted); font-size: 13px; }
.stat-value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.25;
  margin-top: 10px;
  color: var(--w-text-strong);
  word-break: break-all;
}
.stat-sub { color: var(--w-text-faint); font-size: 12px; margin-top: 8px; }
.el-card { margin-bottom: 16px; text-align: left; }
</style>
