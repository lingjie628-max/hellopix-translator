<template>
  <div class="admin-page">
    <el-alert type="warning" :closable="false" show-icon style="margin-bottom:16px">
      <template slot="title">收款地址填错 = 资金永久丢失，无法追回</template>
      <div class="tip-body">
        保存时系统会做 Base58Check 校验（含校验和），能挡掉绝大多数复制错误。
        但校验和无法识别"另一个同样合法的地址"，所以<b>保存后请务必自行核对前 6 位和后 6 位</b>。
      </div>
    </el-alert>

    <el-card v-for="(ch, idx) in form.paymentChannels" :key="ch.id" style="margin-bottom:16px">
      <div slot="header" class="card-head">
        <span>收款渠道 · {{ ch.name || 'USDT' }}</span>
        <el-tag v-if="ch.enabled" type="success" size="mini">已启用</el-tag>
        <el-tag v-else type="info" size="mini">未启用</el-tag>
      </div>
      <el-form :model="ch" label-width="120px" style="max-width: 760px">
        <el-form-item label="渠道名称">
          <el-input v-model="ch.name" placeholder="USDT" style="width:220px"></el-input>
        </el-form-item>
        <el-form-item label="网络">
          <el-input :value="'TRC20（波场）'" disabled style="width:220px"></el-input>
          <span class="unit-tip">只支持 TRC20。ERC20 手续费高、到账慢，暂不开放。</span>
        </el-form-item>
        <el-form-item label="收款地址">
          <el-input
            v-model="ch.address"
            placeholder="T 开头的 34 位 TRC20 地址"
            @input="validate(idx)">
          </el-input>
          <div class="addr-status" v-if="ch.address">
            <span v-if="addrState[idx] === 'checking'" class="checking">校验中…</span>
            <span v-else-if="addrState[idx] === 'ok'" class="ok">✓ 地址合法（校验和匹配）</span>
            <span v-else class="bad">✗ {{ addrReason[idx] }}</span>
          </div>
        </el-form-item>
        <el-form-item label="给商户的说明">
          <el-input
            type="textarea" :rows="3" v-model="ch.note"
            placeholder="例如：请务必使用 TRC20 网络，转账后把订单号和交易号发给客服">
          </el-input>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="ch.enabled" :active-value="1" :inactive-value="0"></el-switch>
          <span class="unit-tip">未启用或未填地址时，商户端不会显示这个渠道</span>
        </el-form-item>
      </el-form>
      <div class="addr-preview" v-if="ch.address && addrState[idx] === 'ok'">
        <div class="qr" v-html="qrSvg[idx]"></div>
        <div class="addr-text">
          <div class="muted">扫码或复制地址（二维码内容就是地址本身）</div>
          <code>{{ ch.address }}</code>
          <div class="muted">前 6 位 <b>{{ ch.address.slice(0, 6) }}</b> · 后 6 位 <b>{{ ch.address.slice(-6) }}</b></div>
        </div>
      </div>
    </el-card>

    <el-button type="primary" :loading="saving" @click="save">保存收款设置</el-button>
  </div>
</template>

<script>
import QRCode from 'qrcode'
import { checkTronAddress } from '../../utils/tron'

export default {
  data() {
    return {
      form: { paymentChannels: [] },
      addrState: {},
      addrReason: {},
      qrSvg: {},
      saving: false
    }
  },
  mounted() { this.load() },
  methods: {
    load() {
      this.getRequest('/admin/settings').then(resp => {
        if (!resp || !resp.data) return
        const rows = Array.isArray(resp.data.paymentChannels) ? resp.data.paymentChannels : []
        this.form.paymentChannels = rows.length
          ? rows
          : [{ id: 'usdt-trc20', name: 'USDT', network: 'TRC20', address: '', note: '', enabled: 0 }]
        this.form.paymentChannels.forEach((_, i) => this.validate(i))
      })
    },
    async validate(idx) {
      const ch = this.form.paymentChannels[idx]
      const address = String((ch && ch.address) || '').trim()
      if (!address) {
        this.$set(this.addrState, idx, '')
        this.$set(this.qrSvg, idx, '')
        return
      }
      this.$set(this.addrState, idx, 'checking')
      const result = await checkTronAddress(address)
      this.$set(this.addrState, idx, result.ok ? 'ok' : 'bad')
      this.$set(this.addrReason, idx, result.reason || '')
      if (result.ok) {
        // 二维码内容就是地址本身：带 amount 的 tron: URI 各家钱包支持不一，
        // 只放地址最通用，金额由页面另行大字显示并要求商户手动核对
        try {
          const svg = await QRCode.toString(address, { type: 'svg', margin: 1, width: 168 })
          this.$set(this.qrSvg, idx, svg)
        } catch (e) {
          this.$set(this.qrSvg, idx, '')
        }
      } else {
        this.$set(this.qrSvg, idx, '')
      }
    },
    save() {
      const channels = this.form.paymentChannels
      for (let i = 0; i < channels.length; i++) {
        const ch = channels[i]
        const address = String(ch.address || '').trim()
        if (address && this.addrState[i] === 'bad') {
          this.$message.error(`第 ${i + 1} 个渠道的地址校验未通过，请修正后再保存`)
          return
        }
        if (Number(ch.enabled) && !address) {
          this.$message.error(`第 ${i + 1} 个渠道已启用但没填收款地址`)
          return
        }
      }
      this.saving = true
      this.postRequest('/admin/settings/save', { paymentChannels: channels })
        .then(() => { this.saving = false; this.$message.success('已保存') })
        .catch(() => { this.saving = false })
    }
  }
}
</script>

<style scoped>
.admin-page { text-align: left; }
.card-head { display: flex; align-items: center; gap: 8px; }
.tip-body { font-size: 13px; line-height: 1.7; }
.unit-tip { margin-left: 10px; color: var(--w-text-faint); font-size: 12px; }
.addr-status { margin-top: 6px; font-size: 12px; }
.addr-status .ok { color: var(--w-success); }
.addr-status .bad { color: var(--w-danger); }
.addr-status .checking { color: var(--w-text-faint); }
.addr-preview {
  display: flex; gap: 16px; align-items: center;
  margin: 4px 0 4px 120px; padding: 12px;
  border: 1px solid var(--w-border, #ebeef5); border-radius: 8px;
}
.addr-preview .qr { line-height: 0; background: #fff; padding: 4px; border-radius: 6px; }
.addr-preview code { display: block; margin: 6px 0; word-break: break-all; font-size: 13px; }
.addr-preview .muted { color: var(--w-text-faint); font-size: 12px; }
</style>
