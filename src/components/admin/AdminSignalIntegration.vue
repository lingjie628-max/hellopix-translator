<template>
  <div class="admin-page signal-integration">
    <el-alert
      v-if="state.environmentFallback && !state.configured"
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom:16px"
      title="当前仍在使用环境变量配置"
    >
      保存本页后，将以这里的数据库配置为准；环境变量可继续作为应急回退。
    </el-alert>
    <el-alert
      :type="state.enabled ? 'success' : 'warning'"
      :closable="false"
      show-icon
      style="margin-bottom:16px"
      :title="state.enabled ? 'Signal 对接已启用' : 'Signal 对接当前关闭'"
    >
      翻译会按所选商户的套餐、余额和翻译通道计费。Webhook 只保存脱敏生命周期数据。
    </el-alert>

    <el-card v-loading="loading">
      <div slot="header">Signal Desktop 对接</div>
      <el-form :model="form" label-width="150px" style="max-width:760px">
        <el-form-item label="启用对接">
          <el-switch v-model="form.enabled"></el-switch>
        </el-form-item>
        <el-form-item label="计费商户">
          <el-select
            v-model="form.accountUserId"
            filterable
            style="width:100%"
            placeholder="选择现有商户主账号"
          >
            <el-option
              v-for="account in state.accounts"
              :key="account.id"
              :label="account.username + (account.nickname ? ' · ' + account.nickname : '')"
              :value="Number(account.id)"
            ></el-option>
          </el-select>
          <div class="hint">调用翻译会直接扣这个商户的字符余额。</div>
        </el-form-item>
        <el-form-item label="指定翻译通道">
          <el-select v-model="form.engineId" clearable style="width:100%" placeholder="留空使用商户当前通道">
            <el-option
              v-for="engine in engines"
              :key="engine.id"
              :label="engine.name + ' · ' + engine.provider"
              :value="engine.id"
              :disabled="engine.retired || !engine.enabled || !engine.wired"
            ></el-option>
          </el-select>
          <div class="hint">只允许目前启用且已接通的通道；保存时服务端还会按商户套餐再校验。</div>
        </el-form-item>
        <el-form-item label="工单策略">
          <el-radio-group v-model="form.workorderMode">
            <el-radio-button label="failures">仅失败建单</el-radio-button>
            <el-radio-button label="all">每个事件建单</el-radio-button>
            <el-radio-button label="ledger">只记录不建单</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="翻译 API Token">
          <el-checkbox v-model="form.rotateApiToken">生成并轮换新 Token</el-checkbox>
          <div class="hint">
            当前：{{ state.apiTokenConfigured ? '已配置 · ' + state.apiTokenPrefix + '…' : '未配置' }}。
            新 Token 只在保存后显示一次。
          </div>
        </el-form-item>
        <el-form-item label="事件 Webhook Token">
          <el-checkbox v-model="form.rotateEventToken">生成并轮换新 Token</el-checkbox>
          <div class="hint">
            当前：{{ state.eventTokenConfigured ? '已配置 · ' + state.eventTokenPrefix + '…' : '未配置' }}。
            新 Token 只在保存后显示一次。
          </div>
        </el-form-item>

        <el-alert
          v-if="state.updatedAt"
          type="info"
          :closable="false"
          :title="'最后更新：' + formatTime(state.updatedAt)"
          style="margin-bottom:18px"
        ></el-alert>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="save">保存配置</el-button>
          <el-button @click="load">重新读取</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-dialog
      title="新 Token 只显示这一次"
      :visible.sync="tokenDialog"
      width="720px"
      :close-on-click-modal="false"
      :show-close="false"
    >
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="关闭后无法再次查看，只能重新轮换"
      ></el-alert>
      <div v-if="newTokens.apiToken" class="token-block">
        <div class="token-label">翻译 API Token（Signal 主进程）</div>
        <el-input :value="newTokens.apiToken" readonly>
          <el-button slot="append" @click="copy(newTokens.apiToken)">复制</el-button>
        </el-input>
      </div>
      <div v-if="newTokens.eventToken" class="token-block">
        <div class="token-label">事件 Webhook Token（Signal 主进程）</div>
        <el-input :value="newTokens.eventToken" readonly>
          <el-button slot="append" @click="copy(newTokens.eventToken)">复制</el-button>
        </el-input>
      </div>
      <p class="token-warning">
        请写入 Signal 主进程安全配置：`translationApiKeyEncrypted` 和
        `translationEventToken`。不要放进渲染进程、Markdown、截图或聊天记录。
      </p>
      <span slot="footer">
        <el-button type="primary" @click="closeTokens">我已保存，关闭</el-button>
      </span>
    </el-dialog>
  </div>
</template>

<script>
export default {
  name: 'AdminSignalIntegration',
  data() {
    return {
      loading: false,
      saving: false,
      state: {
        enabled: false,
        configured: false,
        environmentFallback: false,
        accounts: [],
        apiTokenConfigured: false,
        eventTokenConfigured: false
      },
      engines: [],
      form: {
        enabled: false,
        accountUserId: null,
        engineId: '',
        workorderMode: 'failures',
        rotateApiToken: false,
        rotateEventToken: false
      },
      tokenDialog: false,
      newTokens: { apiToken: '', eventToken: '' }
    }
  },
  mounted() {
    this.load()
    this.loadEngines()
  },
  methods: {
    load() {
      this.loading = true
      this.getRequest('/admin/integrations/signal').then(resp => {
        if (!resp || !resp.data) return
        this.state = resp.data
        this.form = {
          enabled: resp.data.enabled === true,
          accountUserId: resp.data.accountUserId == null ? null : Number(resp.data.accountUserId),
          engineId: resp.data.engineId || '',
          workorderMode: resp.data.workorderMode || 'failures',
          rotateApiToken: false,
          rotateEventToken: false
        }
      }).finally(() => { this.loading = false })
    },
    loadEngines() {
      this.getRequest('/admin/engines').then(resp => {
        if (resp && resp.data && Array.isArray(resp.data.rows)) {
          this.engines = resp.data.rows
        }
      })
    },
    save() {
      if (!this.form.accountUserId) {
        this.$message.warning('请选择 Signal 计费商户')
        return
      }
      if (this.form.enabled && !this.state.apiTokenConfigured && !this.form.rotateApiToken) {
        this.$message.warning('启用前必须生成翻译 API Token')
        return
      }
      if (this.form.enabled && !this.state.eventTokenConfigured && !this.form.rotateEventToken) {
        this.$message.warning('启用前必须生成事件 Webhook Token')
        return
      }
      this.saving = true
      this.postRequest('/admin/integrations/signal/save', this.form).then(resp => {
        if (!resp || !resp.data) return
        this.state = resp.data.state
        this.newTokens = {
          apiToken: resp.data.apiToken || '',
          eventToken: resp.data.eventToken || ''
        }
        if (this.newTokens.apiToken || this.newTokens.eventToken) {
          this.tokenDialog = true
        } else {
          this.$message.success(resp.data.msg)
        }
        this.load()
      }).finally(() => { this.saving = false })
    },
    copy(value) {
      const fallback = () => {
        const textarea = document.createElement('textarea')
        textarea.value = value
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(textarea)
        if (ok) this.$message.success('已复制')
        else this.$message.error('复制失败，请手动选择')
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(() => {
          this.$message.success('已复制')
        }).catch(fallback)
      } else {
        fallback()
      }
    },
    closeTokens() {
      this.newTokens = { apiToken: '', eventToken: '' }
      this.tokenDialog = false
    },
    formatTime(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return date.toLocaleString()
    }
  }
}
</script>

<style scoped>
.signal-integration { text-align: left; }
.hint { color: var(--w-text-faint); font-size: 12px; line-height: 1.7; }
.token-block { margin-top: 18px; }
.token-label { margin-bottom: 7px; font-weight: 650; }
.token-warning { color: #a55612; font-size: 12px; line-height: 1.7; }
</style>
