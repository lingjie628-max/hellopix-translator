<template>
  <div class="recharge-center">
    <el-row :gutter="16">
      <el-col :span="8" v-for="(pack, index) in version" :key="pack.id">
        <div :class="['pay-card', { current: isCurrent(pack), active: isActive(pack) }]" @click="selectPack(pack)">
          <div class="pay-title">-{{ displayTitle(pack) }}{{ isCurrent(pack) ? '(当前)' : '' }}-</div>
          <div class="pay-line">字符数：{{ displayChars(pack) }}</div>
          <div class="pay-line">价格：¥ {{ pack.price }}</div>
          <div class="pay-off">购买1组及以上 {{ fold(discount1) }}</div>
          <div class="pay-off">购买10组及以上 {{ fold(discount10) }}</div>
          <div class="pay-off">购买50组及以上 {{ fold(discount50) }}</div>
        </div>
      </el-col>
    </el-row>

    <div class="pay-form">
      <div class="pay-row">
        <span>购买数量</span>
        <el-input-number v-model="form.month" :min="1"></el-input-number>
        <span class="hint">+ 购买即可成为企业用户，增加 1 个子账户功能，以此类推</span>
      </div>
      <div class="pay-row">
        <span>支付方式</span>
        <el-radio-group v-model="form.type">
          <el-radio label="支付宝">支付宝支付</el-radio>
          <el-radio label="微信">微信支付</el-radio>
        </el-radio-group>
      </div>
      <div class="pay-row">
        <span>订单总计</span>
        <b class="total">¥ {{ quote.paidAmount }}</b>
        <span v-if="quote.discountAmount" class="off">已优惠 ¥ {{ quote.discountAmount }}</span>
      </div>
      <p class="warn">注意：如果购买版本与当前使用版本不一致，充值成功后当前版本字符余额会按规则折算成充值版本字符。</p>
      <el-button type="primary" style="width: 180px" @click="onSubmit">提交订单</el-button>
    </div>
  </div>
</template>
<script>
export default {
  data() {
    return {
      version: [],
      currentVersionId: '',
      out_trade_no: '',
      timer: '',
      discount1: 0.9,
      discount10: 0.8,
      discount50: 0.75,
      form: {
        id: '',
        month: 1,
        type: '支付宝'
      }
    }
  },
  computed: {
    selectedPack() {
      return this.version.find(p => String(p.id) === String(this.form.id)) || null
    },
    quote() {
      const pack = this.selectedPack
      const qty = Math.max(1, Number(this.form.month) || 1)
      if (!pack) {
        return { originalPrice: 0, discountAmount: 0, paidAmount: '0.00' }
      }
      const rate = qty >= 50 ? this.discount50 : (qty >= 10 ? this.discount10 : this.discount1)
      const originalPrice = Number(pack.price || 0) * qty
      const paidAmount = Math.round(originalPrice * rate * 100) / 100
      return {
        originalPrice: originalPrice,
        discountAmount: Math.round((originalPrice - paidAmount) * 100) / 100,
        paidAmount: paidAmount.toFixed(2)
      }
    }
  },
  mounted() {
    this.getRequest('/userVersion/getUserVersion').then(resp => {
      if (resp && resp.data) this.currentVersionId = resp.data.versionId
    })
    this.getRequest('/site/info').then(resp => {
      if (!resp || !resp.data) return
      this.discount1 = Number(resp.data.discount1 || 0.9)
      this.discount10 = Number(resp.data.discount10 || 0.8)
      this.discount50 = Number(resp.data.discount50 || 0.75)
    })
    this.getVersion()
  },
  beforeDestroy() {
    if (this.timer) clearInterval(this.timer)
  },
  methods: {
    fold(n) {
      return (Math.round(Number(n || 0) * 100) / 10) + '折'
    },
    displayTitle(pack) {
      return String(pack.title || '').replace('Hello Pix ', '')
    },
    displayChars(pack) {
      const n = Number(pack.chars || 0)
      if (n >= 10000 && n % 10000 === 0) return (n / 10000) + '万'
      return String(n)
    },
    isCurrent(pack) {
      return String(pack.id) === String(this.currentVersionId)
    },
    isActive(pack) {
      return String(pack.id) === String(this.form.id)
    },
    selectPack(pack) {
      this.form.id = pack.id
    },
    getVersion() {
      this.postRequest('/userVersion/getVersion', {}).then(resp => {
        if (resp && resp.status == 200) {
          this.version = resp.data
          const idx = Number(this.$route.query.type)
          const pick = (!isNaN(idx) && resp.data[idx]) ? resp.data[idx] : resp.data[0]
          if (pick) this.form.id = pick.id
        }
      })
    },
    onSubmit() {
      this.out_trade_no = this.formatDateTimeValue()
      if (this.form.type == '微信') {
        const params = new URLSearchParams({
          baseid: String(this.form.id || ''),
          month: String(Math.max(1, Number(this.form.month) || 1)),
          type: '微信',
          out_trade_no: this.out_trade_no
        })
        const src = '/apis/weixin/weixinPay?' + params.toString()
        const h = this.$createElement
        const content = h('div', { style: { fontSize: '16px', textAlign: 'center' } }, [
          h('p', ['订单号：', h('strong', { style: { color: '#d33' } }, this.out_trade_no)]),
          h('p', ['支付金额：', h('strong', { style: { color: '#d33' } }, '¥' + this.quote.paidAmount)]),
          h('img', { attrs: { src: src, alt: '微信支付二维码' }, style: { maxWidth: '280px' } })
        ])
        this.$alert(content, '微信扫码支付').catch(() => {})
        if (this.timer) clearInterval(this.timer)
        this.timer = setInterval(this.checkPayStatus, 5000)
      } else {
        window.open('/apis/zfb/alipay?baseid=' + this.form.id + '&type=' + this.form.type + '&month=' + this.form.month + '&out_trade_no=' + this.out_trade_no, '_blank')
      }
    },
    checkPayStatus() {
      this.postRequest('/weixin/checkStatus', { out_trade_no: this.out_trade_no }).then(resp => {
        if (resp && resp.status == 200 && resp.data == 1) {
          clearInterval(this.timer)
          this.$message.success('充值成功')
          this.$router.push('/user/Recharge')
        }
      })
    },
    formatDateTimeValue() {
      const d = new Date()
      const p = n => (n < 10 ? '0' + n : '' + n)
      return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
    }
  }
}
</script>
<style scoped>
.recharge-center { text-align: left; }
.pay-card {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 18px 20px;
  cursor: pointer;
  min-height: 180px;
}
.pay-card.current { background: #fff7ed; }
.pay-card.active { border-color: #409EFF; box-shadow: 0 0 0 1px #409EFF inset; }
.pay-title { text-align: center; font-weight: 700; margin-bottom: 12px; }
.pay-line { color: #303133; margin: 6px 0; }
.pay-off { color: #67c23a; font-size: 13px; margin-top: 4px; }
.pay-form { background: #fff; margin-top: 20px; padding: 24px; }
.pay-row { margin-bottom: 18px; display: flex; align-items: center; gap: 16px; }
.pay-row > span:first-child { width: 80px; color: #606266; }
.hint { color: #409EFF; font-size: 13px; }
.total { color: #f56c6c; font-size: 22px; }
.off { color: #67c23a; font-size: 13px; }
.warn { color: #f56c6c; font-size: 13px; line-height: 1.6; }
</style>
