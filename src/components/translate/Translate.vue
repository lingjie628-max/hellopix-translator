<template>
  <div class="pix-translate">
    <div class="pix-toolbar">
      <el-select v-model="from" size="medium" style="width: 140px">
        <el-option v-for="item in languages" :key="item.value" :label="item.label" :value="item.value"></el-option>
      </el-select>
      <el-button circle icon="el-icon-sort" class="pix-swap" @click="swapLang" title="交换语言"></el-button>
      <el-select v-model="to" size="medium" style="width: 140px">
        <el-option v-for="item in targetLanguages" :key="item.value" :label="item.label" :value="item.value"></el-option>
      </el-select>
      <span class="pix-quota">剩余额度 {{ remain | formatChars }} 字符</span>
      <el-button type="primary" icon="el-icon-s-promotion" :loading="loading" @click="doTranslate">翻译</el-button>
    </div>

    <el-row :gutter="16" class="pix-panes">
      <el-col :xs="24" :md="12">
        <div class="pix-pane">
          <div class="pix-pane-head">
            <span>原文</span>
            <span>{{ sourceCount }} 字符</span>
          </div>
          <el-input
            type="textarea"
            v-model="source"
            :rows="16"
            resize="none"
            placeholder="输入或粘贴要翻译的文本"
            @keydown.native.ctrl.enter="doTranslate"
          ></el-input>
          <div class="pix-pane-foot">
            <el-button size="mini" @click="source = ''">清空</el-button>
          </div>
        </div>
      </el-col>
      <el-col :xs="24" :md="12">
        <div class="pix-pane">
          <div class="pix-pane-head">
            <span>译文</span>
            <span v-if="usedChars">本次消耗 {{ usedChars }} 字符</span>
          </div>
          <el-input type="textarea" v-model="target" :rows="16" resize="none" placeholder="翻译结果会显示在这里"></el-input>
          <div class="pix-pane-foot">
            <el-button size="mini" type="primary" plain @click="copyTarget" :disabled="!target">复制译文</el-button>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script>
export default {
  name: 'HelloPixTranslate',
  data() {
    return {
      from: 'auto',
      to: 'zh',
      source: '',
      target: '',
      loading: false,
      remain: 0,
      usedChars: 0,
      languages: [
        { value: 'auto', label: '自动检测' },
        { value: 'zh', label: '中文' },
        { value: 'en', label: '英语' },
        { value: 'ja', label: '日语' },
        { value: 'ko', label: '韩语' },
        { value: 'fr', label: '法语' },
        { value: 'es', label: '西班牙语' },
        { value: 'de', label: '德语' }
      ]
    }
  },
  computed: {
    targetLanguages() {
      return this.languages.filter(item => item.value !== 'auto')
    },
    sourceCount() {
      const s = this.source || ''
      let n = 0
      for (let i = 0; i < s.length; i++) n += /[\u4e00-\u9fff]/.test(s[i]) ? 2 : 1
      return n
    }
  },
  filters: {
    formatChars(value) {
      const n = Number(value || 0)
      return n.toLocaleString()
    }
  },
  mounted() {
    this.loadQuota()
  },
  methods: {
    loadQuota() {
      this.getRequest('/userVersion/getUserVersion').then(resp => {
        if (resp && resp.status == 200) {
          this.remain = resp.data.charBalance
        }
      })
    },
    swapLang() {
      const nextFrom = this.from === 'auto' ? this.to : this.from
      this.from = this.to
      this.to = nextFrom === this.to ? (this.to === 'zh' ? 'en' : 'zh') : nextFrom
      const text = this.source
      this.source = this.target
      this.target = text
    },
    doTranslate() {
      if (!this.source.trim()) {
        this.$message.warning('请输入要翻译的文本')
        return
      }
      this.loading = true
      this.postRequest('/translate/run', {
        text: this.source,
        from: this.from,
        to: this.to
      }).then(resp => {
        this.loading = false
        if (resp && resp.status == 200) {
          const data = resp.data
          if (!data.success) {
            this.$message.error(data.msg || '翻译失败')
            return
          }
          this.target = data.translation
          this.remain = data.remain
          this.usedChars = data.chars
          if (data.from && this.from === 'auto') {
            this.from = data.from
          }
        }
      }).catch(() => {
        this.loading = false
      })
    },
    copyTarget() {
      const input = document.createElement('textarea')
      input.value = this.target
      document.body.appendChild(input)
      input.select()
      document.execCommand('Copy')
      document.body.removeChild(input)
      this.$message.success('译文已复制')
    }
  }
}
</script>

<style scoped>
.pix-translate {
  text-align: left;
  padding: 4px 8px 20px;
}

.pix-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 16px;
}

.pix-swap {
  transform: rotate(90deg);
}

.pix-quota {
  margin-left: auto;
  color: #606266;
  font-size: 13px;
}

.pix-pane {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 10px;
  overflow: hidden;
}

.pix-pane-head,
.pix-pane-foot {
  display: flex;
  justify-content: space-between;
  padding: 10px 14px;
  color: #909399;
  font-size: 13px;
  background: #f8fafc;
}

.pix-pane ::v-deep .el-textarea__inner {
  border: none;
  border-radius: 0;
  font-size: 15px;
  line-height: 1.7;
  min-height: 360px;
}

@media screen and (max-width: 500px) {
  .pix-quota {
    width: 100%;
    margin-left: 0;
  }
}
</style>
