<template>
  <div class="totp-page" v-loading="loading">
    <el-card shadow="never">
      <div slot="header" class="head">
        <span>账号安全 · 两步验证</span>
        <el-tag :type="status.enabled ? 'success' : 'warning'" size="small" effect="dark">
          {{ status.enabled ? '已开启' : '未开启' }}
        </el-tag>
      </div>

      <!-- 未开启：说明 + 开启入口 -->
      <div v-if="!status.enabled && !pending">
        <el-alert type="warning" :closable="false" show-icon>
          <div slot="title">超管后台还没有两步验证</div>
          <div>
            超管账号可以查看全部商户数据、工单与翻译通道密钥，是整个系统里价值最高的目标。
            开启后即使密码泄露，没有你手机上的动态码也无法登录。
          </div>
        </el-alert>
        <el-button type="primary" style="margin-top:16px" @click="beginSetup">开始设置</el-button>
      </div>

      <!-- 设置中：展示密钥与校验 -->
      <div v-if="pending">
        <el-steps :active="1" simple style="margin-bottom:16px">
          <el-step title="扫码或手输密钥" icon="el-icon-mobile-phone"></el-step>
          <el-step title="输入动态码确认" icon="el-icon-key"></el-step>
        </el-steps>

        <el-alert type="info" :closable="false">
          <div slot="title">用验证器 App 添加账号</div>
          <div>
            打开 Google Authenticator / Authy / 1Password，选择「手动输入密钥」，粘贴下面的密钥。
            账号名可填 <b>{{ adminName }}</b>，类型选「基于时间」。
          </div>
        </el-alert>

        <div class="secret-box">
          <code>{{ pending.secretGrouped }}</code>
          <el-button size="mini" @click="copy(pending.secret)">复制</el-button>
        </div>
        <div class="otpauth">
          <a :href="pending.otpauth">在已安装验证器的设备上点此直接添加</a>
        </div>

        <div class="confirm">
          <span>输入 App 上显示的 6 位动态码：</span>
          <el-input
            v-model="code" maxlength="6" placeholder="6 位数字"
            style="width:150px" @keyup.enter.native="enable"></el-input>
          <el-button type="primary" :loading="submitting" @click="enable">确认开启</el-button>
          <el-button @click="cancelSetup">取消</el-button>
        </div>
      </div>

      <!-- 已开启：恢复码与关闭 -->
      <div v-if="status.enabled">
        <el-descriptions :column="2" border size="medium">
          <el-descriptions-item label="状态">已开启</el-descriptions-item>
          <el-descriptions-item label="开启时间">
            {{ status.confirmedAt ? formatTime(status.confirmedAt) : '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="剩余恢复码">
            <b :class="{ low: status.recoveryRemaining <= 3 }">{{ status.recoveryRemaining }}</b> 个
          </el-descriptions-item>
          <el-descriptions-item label="登录方式">密码 + 动态码</el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-if="status.recoveryRemaining <= 3" type="warning" :closable="false" show-icon
          style="margin-top:14px"
          title="恢复码不多了，建议重新生成一组。手机丢失时只能靠恢复码登录。">
        </el-alert>

        <div class="actions">
          <el-button @click="regenDialog = true">重新生成恢复码</el-button>
          <el-button type="danger" plain @click="disableDialog = true">关闭两步验证</el-button>
        </div>
      </div>
    </el-card>

    <!-- 恢复码展示：只在生成的那一刻可见 -->
    <el-dialog
      title="请立即保存恢复码" :visible.sync="codesDialog" width="460px"
      :close-on-click-modal="false" :show-close="false">
      <el-alert type="error" :closable="false" show-icon>
        <div slot="title">这组恢复码只显示这一次</div>
        <div>
          我们只保存它的哈希值，关闭本窗口后连我们也无法再取回明文。
          请抄写到纸上或存进密码管理器。每个恢复码只能用一次。
        </div>
      </el-alert>
      <div class="codes">
        <code v-for="c in recoveryCodes" :key="c">{{ c }}</code>
      </div>
      <div slot="footer">
        <el-button size="mini" @click="copy(recoveryCodes.join('\n'))">复制全部</el-button>
        <el-button type="primary" @click="codesDialog = false">我已保存</el-button>
      </div>
    </el-dialog>

    <!-- 重新生成 / 关闭：都需要当前动态码 -->
    <el-dialog :title="regenDialog ? '重新生成恢复码' : '关闭两步验证'" :visible.sync="dialogVisible" width="400px">
      <p class="dialog-hint">
        {{ regenDialog
          ? '旧恢复码将全部作废，请确认你已保存好新的。'
          : '关闭后，仅凭密码即可登录超管后台。' }}
      </p>
      <el-input v-model="confirmCode" placeholder="当前 6 位动态码" maxlength="6"></el-input>
      <div slot="footer">
        <el-button @click="closeDialogs">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="regenDialog ? regenerate() : disable()">
          确认
        </el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script>
export default {
  data() {
    return {
      loading: false,
      submitting: false,
      status: { enabled: false, confirmedAt: null, recoveryRemaining: 0 },
      pending: null,
      code: '',
      confirmCode: '',
      recoveryCodes: [],
      codesDialog: false,
      regenDialog: false,
      disableDialog: false,
      adminName: ''
    }
  },
  computed: {
    dialogVisible: {
      get() { return this.regenDialog || this.disableDialog },
      set(v) { if (!v) this.closeDialogs() }
    }
  },
  mounted() {
    const info = this.$store.state.admin || {}
    this.adminName = info.username || 'admin'
    this.load()
  },
  methods: {
    load() {
      this.loading = true
      this.getRequest('/admin/totp').then(resp => {
        this.loading = false
        if (resp && resp.data && resp.data.success) this.status = resp.data
      }).catch(() => { this.loading = false })
    },
    beginSetup() {
      this.loading = true
      this.postRequest('/admin/totp/setup', {}).then(resp => {
        this.loading = false
        if (resp && resp.data && resp.data.success) {
          this.pending = resp.data
          this.code = ''
        } else {
          this.$message.error((resp && resp.data && resp.data.msg) || '无法生成密钥')
        }
      }).catch(() => { this.loading = false })
    },
    cancelSetup() {
      this.pending = null
      this.code = ''
    },
    enable() {
      if (!/^\d{6}$/.test(this.code)) return this.$message.warning('请输入 6 位数字动态码')
      this.submitting = true
      this.postRequest('/admin/totp/enable', { code: this.code }).then(resp => {
        this.submitting = false
        const data = resp && resp.data
        if (data && data.success) {
          this.pending = null
          this.code = ''
          this.recoveryCodes = data.recoveryCodes || []
          this.codesDialog = true
          this.$message.success('两步验证已开启')
          this.load()
        } else {
          this.$message.error((data && data.msg) || '验证码不正确')
        }
      }).catch(() => { this.submitting = false })
    },
    regenerate() {
      if (!/^\d{6}$/.test(this.confirmCode)) return this.$message.warning('请输入 6 位数字动态码')
      this.submitting = true
      this.postRequest('/admin/totp/recovery', { code: this.confirmCode }).then(resp => {
        this.submitting = false
        const data = resp && resp.data
        if (data && data.success) {
          this.recoveryCodes = data.recoveryCodes || []
          this.regenDialog = false
          this.confirmCode = ''
          this.codesDialog = true
          this.load()
        } else {
          this.$message.error((data && data.msg) || '操作失败')
        }
      }).catch(() => { this.submitting = false })
    },
    disable() {
      if (!this.confirmCode.trim()) return this.$message.warning('请输入动态码或恢复码')
      this.submitting = true
      this.postRequest('/admin/totp/disable', { code: this.confirmCode }).then(resp => {
        this.submitting = false
        const data = resp && resp.data
        if (data && data.success) {
          this.disableDialog = false
          this.confirmCode = ''
          this.$message.success('两步验证已关闭')
          this.load()
        } else {
          this.$message.error((data && data.msg) || '验证码不正确')
        }
      }).catch(() => { this.submitting = false })
    },
    closeDialogs() {
      this.regenDialog = false
      this.disableDialog = false
      this.confirmCode = ''
    },
    formatTime(value) {
      const d = new Date(value)
      return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
    },
    copy(text) {
      const done = () => this.$message.success('已复制')
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done).catch(() => this.fallbackCopy(text, done))
      } else {
        this.fallbackCopy(text, done)
      }
    },
    fallbackCopy(text, done) {
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      try { document.execCommand('copy'); done() } catch (e) { this.$message.warning('请手动复制') }
      document.body.removeChild(el)
    }
  }
}
</script>

<style scoped>
.totp-page { padding: 4px; max-width: 720px; }
.head { display: flex; align-items: center; justify-content: space-between; }
.secret-box {
  display: flex; align-items: center; gap: 10px;
  margin: 14px 0 6px; padding: 12px 14px;
  background: var(--w-surface-2, #f5f7fa);
  border: 1px dashed var(--w-border, #dcdfe6);
  border-radius: 8px;
}
.secret-box code {
  flex: 1; font-size: 16px; letter-spacing: 0.12em;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  color: var(--w-text-strong, #303133);
  word-break: break-all;
}
.otpauth { font-size: 12px; margin-bottom: 16px; }
.confirm {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-top: 8px;
}
.actions { margin-top: 18px; display: flex; gap: 10px; }
.codes {
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 8px; margin-top: 16px;
}
.codes code {
  padding: 8px 10px; text-align: center; border-radius: 6px;
  background: var(--w-surface-2, #f5f7fa);
  border: 1px solid var(--w-border, #dcdfe6);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: 0.08em;
}
.dialog-hint { font-size: 13px; margin: 0 0 12px; }
.low { color: var(--w-warning); }
</style>
