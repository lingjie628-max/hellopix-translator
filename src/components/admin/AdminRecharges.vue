<template>
  <div class="admin-page">
    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="orderNum" label="订单号" width="160"></el-table-column>
      <el-table-column prop="username" label="商户" width="110"></el-table-column>
      <el-table-column prop="kind" label="类型" width="80">
        <template slot-scope="scope">{{ scope.row.kind || '套餐' }}</template>
      </el-table-column>
      <el-table-column prop="basename" label="套餐/字符包" width="160"></el-table-column>
      <el-table-column :label="'金额(' + currencyName + ')'" width="120">
        <template slot-scope="scope">{{ currencySymbol }} {{ scope.row.price }}</template>
      </el-table-column>
      <el-table-column prop="month" label="月数" width="80"></el-table-column>
      <el-table-column prop="type" label="方式" width="90"></el-table-column>
      <el-table-column label="状态" width="110">
        <template slot-scope="scope">
          <el-tag :type="scope.row.status === 1 ? 'success' : 'danger'" size="mini">
            {{ scope.row.status === 1 ? '已支付' : '未支付' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="createTime" label="时间" width="170"></el-table-column>
      <el-table-column label="操作" width="120">
        <template slot-scope="scope">
          <el-button type="text" v-if="scope.row.status !== 1" @click="markPaid(scope.row)">标记已付</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination style="margin-top:12px" :current-page="page" :page-size="size" :total="total"
                   layout="total, prev, pager, next" @current-change="onPage"></el-pagination>
  </div>
</template>
<script>
export default {
  data() {
    return { loading: false, rows: [], page: 1, size: 10, total: 0 }
  },
  mounted() { this.load() },
  methods: {
    load() {
      this.loading = true
      this.getRequest('/admin/recharges', { page: this.page, rows: this.size }).then(resp => {
        this.loading = false
        if (resp && resp.status == 200) {
          this.rows = resp.data.rows
          this.total = resp.data.total
        }
      }).catch(() => { this.loading = false })
    },
    onPage(page) { this.page = page; this.load() },
    /**
     * 确认收款。这是全站唯一"点一下就给商户加字符"的操作，所以：
     *  - 弹窗里把金额和订单号再摆一次，逼管理员和链上实际到账核对
     *  - 强烈建议填交易号：表上有 (payment_type, provider_transaction_id) 唯一索引，
     *    同一笔链上交易无法给两单充值，能挡住"一笔钱充两次"这类事故
     */
    markPaid(row) {
      const h = this.$createElement
      const content = h('div', { style: { fontSize: '13px', lineHeight: '1.9' } }, [
        h('p', ['订单号：', h('strong', {}, row.orderNum)]),
        h('p', ['商户：', h('strong', {}, row.username || '-')]),
        h('p', ['应到金额：', h('strong', { style: { color: '#d9534f', fontSize: '16px' } },
          `${row.paidAmount} USDT`)]),
        h('p', { style: { color: 'var(--w-text-faint)', fontSize: '12px' } },
          '请先在链上核对：金额是否完全一致、是否 TRC20 网络。')
      ])
      this.$prompt('', '确认收款', {
        message: content,
        inputPlaceholder: '链上交易号 TxID（强烈建议填写）',
        inputValue: '',
        confirmButtonText: '确认收款',
        cancelButtonText: '取消',
        inputValidator: () => true
      }).then(({ value }) => {
        this.postRequest('/admin/recharges/status', {
          id: row.id,
          providerTransactionId: value || ''
        }).then(resp => {
          this.$message.success((resp && resp.data && resp.data.msg) || '已确认')
          this.load()
        })
      }).catch(() => {})
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.unit-tip { margin-left: 10px; color: var(--w-text-faint); font-size: 12px; }
</style>
