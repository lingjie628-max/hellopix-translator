<template>
  <div class="recharge-center">
    <el-row :gutter="16">
      <el-col :span="8" v-for="(pack, index) in version" :key="pack.id">
        <div :class="['pay-card', { current: isCurrent(pack), active: isActive(pack) }]" @click="selectPack(pack)">
          <div class="pay-title">-{{ displayTitle(pack) }}{{ isCurrent(pack) ? '(当前)' : '' }}-</div>
          <div class="pay-line">字符数：{{ displayChars(pack) }}</div>
          <div class="pay-line">价格：{{ currencySymbol }} {{ pack.price }}</div>
          <!--
            倍数角标，替代此前那一行批发单价：客户可见页不展示单位价。
            比较的是"拿到多少"，同样一眼读出阶梯。
          -->
          <div class="pay-mult" v-if="multipleOf(pack, index)">基础版 {{ multipleOf(pack, index) }} 倍</div>
          <div class="pay-save" v-if="saveOf(pack, index)">较基础版省 {{ saveOf(pack, index) }}%</div>
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
        <!-- 支付方式从后台「收款方式」读取，页面不再写死。
             原先写死支付宝/微信，而客户在海外根本用不了这两种。 -->
        <el-radio-group v-if="channels.length" v-model="form.channelId">
          <el-radio v-for="c in channels" :key="c.id" :label="c.id">{{ c.name }}（{{ c.network }}）</el-radio>
        </el-radio-group>
        <span v-else class="warn">收款方式尚未配置，请联系客服</span>
      </div>
      <div class="pay-row">
        <span>订单总计</span>
        <!-- 金额全部来自服务端报价，前端只做展示 -->
        <template v-if="quote.paidAmount !== null && quote.paidAmount !== undefined">
          <b class="total">{{ currencySymbol }} {{ quote.paidAmount }}</b>
          <span v-if="quote.discountAmount" class="off">已优惠 {{ currencySymbol }} {{ quote.discountAmount }}</span>
        </template>
        <span v-else-if="quoteError" class="warn">{{ quoteError }}</span>
        <span v-else class="hint">报价中…</span>
      </div>
      <p class="warn">注意：如果购买版本与当前使用版本不一致，充值成功后当前版本字符余额会按规则折算成充值版本字符。</p>
      <el-button type="primary" style="width: 180px" :loading="submitting"
                 :disabled="!channels.length" @click="onSubmit">提交订单</el-button>

      <!-- 下单后的收款信息。加密转账靠人工核对，所以三个要素必须一眼可见：
           订单号、**准确金额**（含匹配尾数）、收款地址 -->
      <el-card v-if="order" class="pay-panel">
        <div slot="header" class="panel-head">
          <span>请完成转账</span>
          <el-tag type="warning" size="mini">待支付</el-tag>
        </div>
        <div class="pay-fields">
          <div class="field-row">
            <label>订单号</label>
            <code>{{ order.orderNum }}</code>
            <el-button type="text" @click="copy(order.orderNum)">复制</el-button>
          </div>
          <div class="field-row amount-row">
            <label>转账金额</label>
            <b class="pay-amount">{{ order.payAmount }} USDT</b>
            <el-button type="text" @click="copy(String(order.payAmount))">复制</el-button>
          </div>
          <div class="suffix-hint" v-if="order.matchSuffix">
            其中 <b>{{ order.matchSuffix }}</b> 是<b>匹配尾数</b> —— 请务必按这个金额转账（不要凑整），
            这是我们识别你这笔款的唯一依据。
          </div>
          <div class="field-row addr-row">
            <label>收款地址</label>
            <code>{{ order.channel.address }}</code>
            <el-button type="text" @click="copy(order.channel.address)">复制</el-button>
          </div>
          <div class="qr-wrap" v-if="qrSvg" v-html="qrSvg"></div>
          <el-alert type="error" :closable="false" show-icon style="margin-top:12px">
            <template slot="title">必须使用 {{ order.channel.network }} 网络转账</template>
            <div class="tip-body">
              用错网络（如 ERC20）资金将无法找回。<b>转账金额务必与本页显示的完全一致</b>，
              否则无法自动匹配到你的订单。
            </div>
          </el-alert>
          <div class="note" v-if="order.channel.note">{{ order.channel.note }}</div>
          <div class="next-step">
            转账完成后，请把<b>订单号</b>和<b>交易哈希（TxID）</b>发给客服，我们核对后立即为你充值。
          </div>
        </div>
      </el-card>
    </div>
  </div>
</template>
<script>
import { charsMultiple, savingVsBase } from '../../utils/plan-value'

export default {
  data() {
    return {
      version: [],
      currentVersionId: '',
      discount1: 0.9,
      discount10: 0.8,
      discount50: 0.75,
      channels: [],
      order: null,
      qrSvg: '',
      submitting: false,
      // 报价**全部来自服务端**。前端不再自己算价格 ——
      // 曾经这里有一份和 core-service 平行的浮点公式
      // （Number(pack.price) * qty，再 Math.round(x*100)/100），
      // 三处实现迟早会分叉，而分叉的表现是"页面显示 35，实际扣 35.427"。
      // 现在服务端是唯一真源，这里只放展示值。
      quote: { originalPrice: null, discountAmount: null, paidAmount: null },
      quoteLoading: false,
      quoteError: '',
      // 报价请求序号：数量快速增减时只认最后一次响应，避免旧结果覆盖新结果
      quoteSeq: 0,
      quoteTimer: null,
      form: {
        id: '',
        month: 1,
        channelId: ''
      }
    }
  },
  watch: {
    'form.id'() { this.loadQuote() },
    'form.month'() { this.loadQuote() }
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
      // 收款渠道完全由后台配置决定，前端不写死任何支付方式
      this.channels = Array.isArray(resp.data.paymentChannels) ? resp.data.paymentChannels : []
      if (this.channels.length && !this.form.channelId) this.form.channelId = this.channels[0].id
    })
    this.getVersion()
  },
  beforeDestroy() {
    if (this.timer) clearInterval(this.timer)
    if (this.quoteTimer) clearTimeout(this.quoteTimer)
  },
  methods: {
    /**
     * 向服务端要报价。
     *
     * 防抖 200ms + 序号丢弃过期响应：数量输入框每敲一下都会触发，
     * 不防抖会打出一串请求；不做序号校验则可能「先发的慢响应」后到，
     * 把新数量的价格覆盖成旧价格的。
     */
    loadQuote() {
      if (this.quoteTimer) clearTimeout(this.quoteTimer)
      const baseid = this.form.id
      if (!baseid) {
        this.quote = { originalPrice: null, discountAmount: null, paidAmount: null }
        this.quoteError = ''
        return
      }
      this.quoteLoading = true
      this.quoteTimer = setTimeout(() => {
        const seq = ++this.quoteSeq
        const qty = Math.max(1, Number(this.form.month) || 1)
        this.getRequest('/user/quote', { baseid, qty }).then(resp => {
          // 过期响应直接丢掉，不能让旧价格覆盖新价格
          if (seq !== this.quoteSeq) return
          this.quoteLoading = false
          if (!resp || !resp.data) { this.quoteError = '报价失败，请重试'; return }
          const d = resp.data
          this.quoteError = ''
          // 只做展示格式化，**不重新计算业务金额**
          this.quote = {
            originalPrice: d.originalPrice,
            discountAmount: d.discountAmount,
            paidAmount: d.paidAmount
          }
        }).catch(() => {
          if (seq !== this.quoteSeq) return
          this.quoteLoading = false
          this.quoteError = '报价失败，请重试'
          this.quote = { originalPrice: null, discountAmount: null, paidAmount: null }
        })
      }, 200)
    },
    /** 复制到剪贴板。加密地址复制错一位就是资金损失，所以尽量走剪贴板而不是手抄 */
    copy(text) {
      const value = String(text || '')
      if (!value) return
      const done = () => this.$message.success('已复制')
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done).catch(() => this.copyFallback(value, done))
      } else {
        this.copyFallback(value, done)
      }
    },
    copyFallback(value, done) {
      const el = document.createElement('textarea')
      el.value = value
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      try { document.execCommand('copy'); done() } catch (e) { this.$message.warning('复制失败，请手动选择文本') }
      document.body.removeChild(el)
    },
    fold(n) {
      return (Math.round(Number(n || 0) * 100) / 10) + '折'
    },
    displayTitle(pack) {
      return String(pack.title || '').replace('Hello Pix ', '')
    },
    displayChars(pack) {
      // 「不限」要显示成不限。给它填的 5 亿是发放量，不是卖点数字 ——
      // 印在卡片上客户只会觉得莫名其妙，还会去算一个没有意义的单价。
      if (pack.charsUnlimited) return '不限'
      const n = Number(pack.chars || 0)
      if (n >= 10000 && n % 10000 === 0) return (n / 10000) + '万'
      return String(n)
    },
    /** 相对入门档的字符倍数（仅整数倍显示），与官网定价卡共用一份算法 */
    multipleOf(pack, index) {
      if (pack.charsUnlimited) return null
      const base = (this.version || [])[0]
      if (!base || index === 0 || base.charsUnlimited) return null
      return charsMultiple(base.chars, pack.chars)
    },
    /** 「较基础版省 X%」：基准是套餐列表第 0 项（入门档），自己跟自己比返回 null */
    saveOf(pack, index) {
      if (pack.charsUnlimited) return null
      const base = (this.version || [])[0]
      if (!base || index === 0 || base.charsUnlimited) return null
      return savingVsBase(base.price, base.chars, pack.price, pack.chars)
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
      if (this.submitting) return
      if (!this.form.id) { this.$message.warning('请先选择套餐'); return }
      // 报价没就绪就不让下单：金额以服务端为准，本地没有可依据的价格
      if (this.quote.paidAmount === null || this.quote.paidAmount === undefined) {
        this.$message.warning(this.quoteError || '报价尚未就绪，请稍候'); return
      }
      if (!this.channels.length) { this.$message.warning('收款方式尚未配置，请联系客服'); return }
      this.submitting = true
      this.createOrder(0)
    },
    /**
     * 下单，撞金额时自动重来一次。
     *
     * 服务端认金额为订单身份（尾数池），两个请求几乎同时下单时，
     * 后插入的那个会撞唯一约束。那不是用户做错了什么，换一个尾数就好 ——
     * 但用户明明只点了一次，却要看到一条红字再自己点第二次，体验上
     * 就是"这个按钮坏了"。所以这里对**服务端明确标记 retryable** 的冲突
     * 自动重发一次（只一次，不会把真实故障变成无限重试）。
     */
    createOrder(attempt) {
      this.postRequest('/userRecharge/create', {
        baseid: this.form.id,
        month: Math.max(1, Number(this.form.month) || 1),
        channelId: this.form.channelId
      }).then(resp => {
        this.submitting = false
        if (!resp || resp.status !== 200) return // 失败提示由拦截器统一弹出
        this.order = resp.data
        this.renderQr(resp.data.channel && resp.data.channel.address)
      }).catch(error => {
        const data = (error && error.response && error.response.data) || {}
        if (data.code === 'AMOUNT_COLLISION' && data.retryable === true && attempt < 1) {
          // 静默重试：这条红字对用户没有信息量，真正有意义的是最终结果
          this.createOrder(attempt + 1)
          return
        }
        this.submitting = false
      })
    },
    /** 二维码内容只放地址本身：带 amount 的 tron: URI 各家钱包支持不一，只放地址最通用 */
    renderQr(address) {
      this.qrSvg = ''
      if (!address) return
      const QRCode = require('qrcode')
      QRCode.toString(String(address), { type: 'svg', margin: 1, width: 180 })
        .then(svg => { this.qrSvg = svg })
        .catch(() => { this.qrSvg = '' })
    }
  }
}
</script>
<style scoped>
.recharge-center { text-align: left; }
.pay-card {
  background: var(--w-surface);
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 18px 20px;
  cursor: pointer;
  min-height: 180px;
}
.pay-card.current { background: var(--w-accent-soft-bg); }
.pay-card.active { border-color: var(--w-accent); box-shadow: 0 0 0 1px var(--w-accent) inset; }
.pay-title { text-align: center; font-weight: 700; margin-bottom: 12px; }
.pay-line { color: var(--w-text); margin: 6px 0; }
.pay-mult {
  display: inline-block; color: var(--w-accent); background: var(--w-accent-soft-bg);
  border-radius: 10px; padding: 1px 8px; font-size: 12px; font-weight: 600; margin: 2px 0 6px;
}
.pay-save { color: var(--w-success); font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.pay-off { color: var(--w-success); font-size: 13px; margin-top: 4px; }
.pay-form { background: var(--w-surface); margin-top: 20px; padding: 24px; }
.pay-row { margin-bottom: 18px; display: flex; align-items: center; gap: 16px; }
.pay-row > span:first-child { width: 80px; color: var(--w-text-muted); }
.hint { color: var(--w-accent); font-size: 13px; }
.total { color: var(--w-danger); font-size: 22px; }
.off { color: var(--w-success); font-size: 13px; }
.warn { color: var(--w-danger); font-size: 13px; line-height: 1.6; }

/* 收款信息面板：加密转账靠人工核对，关键信息要足够醒目 */
.pay-panel { margin-top: 18px; max-width: 720px; }
.panel-head { display: flex; align-items: center; gap: 8px; }
.pay-fields { font-size: 13px; }
.field-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 0; border-bottom: 1px dashed #ebeef5; flex-wrap: wrap;
}
.field-row label { width: 72px; color: var(--w-text-faint); flex: none; }
.field-row code {
  background: var(--w-surface-2); padding: 3px 8px; border-radius: 4px;
  word-break: break-all; font-size: 13px; flex: 1; min-width: 200px;
}
.amount-row { border-bottom: none; }
.pay-amount { font-size: 24px; font-weight: 700; color: var(--w-danger); }
.suffix-hint {
  background: var(--w-warning-soft); color: var(--w-warning); border-radius: 4px;
  padding: 8px 10px; font-size: 12px; line-height: 1.7; margin: 4px 0 8px;
}
.qr-wrap { margin-top: 10px; line-height: 0; }
.qr-wrap >>> svg { background: var(--w-surface); padding: 6px; border-radius: 6px; }
.tip-body { font-size: 12px; line-height: 1.7; }
.note {
  margin-top: 10px; padding: 8px 10px; background: var(--w-surface-2);
  border-radius: 4px; font-size: 12px; color: var(--w-text-muted); white-space: pre-wrap;
}
.next-step {
  margin-top: 12px; padding-top: 10px; border-top: 1px solid #ebeef5;
  font-size: 13px; line-height: 1.8;
}
</style>
