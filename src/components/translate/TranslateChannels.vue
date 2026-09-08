<template>
  <div class="engine-page">
    <el-alert
      title="翻译接口板块已就位，厂商请求尚未接入。成本由超管填写，不调取厂商计费。"
      type="warning" show-icon :closable="false" style="margin-bottom:16px">
    </el-alert>
    <div class="engine-meta">
      当前套餐 <b>{{ meta.packageTitle }}</b>
      · 字符余额 <b>{{ meta.charBalance || 0 }}</b>
      · 正在使用 <b>{{ activeName }}</b>
    </div>
    <el-row :gutter="16">
      <el-col :span="8" v-for="item in rows" :key="item.id">
        <el-card shadow="hover" :class="{ locked: !item.allowed, current: item.active }">
          <div class="engine-name">{{ item.name }}</div>
          <div class="engine-provider">{{ item.provider }} · {{ tierText(item.tier) }}</div>
          <div class="engine-note">{{ item.note }}</div>
          <div class="engine-foot">
            <el-tag size="mini" :type="item.wired ? 'success' : 'info'">{{ item.wiredText }}</el-tag>
            <el-tag v-if="item.active" size="mini" type="danger">当前</el-tag>
            <el-tag v-if="!item.allowed" size="mini" type="warning">套餐未包含</el-tag>
          </div>
          <el-button
            type="primary"
            size="small"
            style="width:100%;margin-top:12px"
            :disabled="!item.allowed || item.active"
            @click="choose(item)">
            {{ item.allowed ? (item.active ? '已选择' : '设为当前通道') : '升级套餐后可用' }}
          </el-button>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>
<script>
export default {
  data() {
    return { rows: [], meta: {} }
  },
  computed: {
    activeName() {
      const row = this.rows.find(r => r.active)
      return row ? row.name : '-'
    }
  },
  mounted() { this.load() },
  methods: {
    tierText(tier) {
      return { basic: '基础档', advanced: '高级档', pro: '专业档' }[tier] || tier
    },
    load() {
      this.getRequest('/translate/engines').then(resp => {
        if (!resp) return
        this.rows = resp.data.rows || []
        this.meta = resp.data
      })
    },
    choose(item) {
      this.postRequest('/translate/engines/active', { id: item.id }).then(resp => {
        this.$message({ type: resp.data.success === 'error' ? 'error' : 'success', message: resp.data.msg })
        if (resp.data.success !== 'error') this.load()
      })
    }
  }
}
</script>
<style scoped>
.engine-page { text-align: left; }
.engine-meta { margin-bottom: 16px; color: #606266; }
.el-card { margin-bottom: 16px; }
.engine-name { font-size: 18px; font-weight: 700; color: #111827; }
.engine-provider { color: #909399; font-size: 12px; margin: 6px 0 10px; }
.engine-note { color: #606266; font-size: 13px; min-height: 44px; }
.engine-foot { margin-top: 10px; }
.locked { opacity: 0.72; }
.current { border-color: #fca5a5; }
</style>
