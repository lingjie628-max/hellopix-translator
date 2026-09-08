<template>
  <div class="auth-support" v-if="show">
    <el-button class="support-btn" @click="open">{{ btnText }}</el-button>
  </div>
</template>
<script>
export default {
  data() {
    return {
      show: false,
      btnText: '联系客服',
      url: '',
      account: '',
      note: ''
    }
  },
  mounted() {
    this.getRequest('/site/info').then(resp => {
      if (!resp || !resp.data) return
      const d = resp.data
      this.btnText = d.supportBtnText || '联系客服'
      this.url = d.telegramUrl || ''
      this.account = d.telegram || ''
      this.note = d.supportNote || ''
      this.show = Number(d.supportShow) !== 0 && !!(this.url || this.account || this.btnText)
    })
  },
  methods: {
    open() {
      this.getRequest('/site/info').then(resp => {
        const d = (resp && resp.data) || {}
        this.btnText = d.supportBtnText || this.btnText
        this.url = d.telegramUrl || ''
        this.account = d.telegram || ''
        this.note = d.supportNote || ''
        if (this.url) {
          window.open(this.url, '_blank', 'noopener')
          return
        }
        if (this.account) {
          window.open('https://t.me/' + String(this.account).replace(/^@/, ''), '_blank', 'noopener')
          return
        }
        this.$message.info('客服暂时无法联系')
      }).catch(() => this.$message.info('尚未配置客服联系方式'))
    }
  }
}
</script>
<style scoped>
.auth-support {
  margin: 4px 0 4px;
}
.support-btn {
  width: 100%;
}
</style>
