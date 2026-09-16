<template>
  <div class="admin-page">
    <el-card>
      <div slot="header">站点</div>
      <el-form :model="form" label-width="120px" style="max-width: 720px">
        <el-form-item label="站点名称">
          <el-input v-model="form.siteName"></el-input>
        </el-form-item>
        <el-form-item label="客户端下载">
          <el-input v-model="form.clientDownloadUrl" placeholder="总入口，细项在「客户端版本」里配"></el-input>
        </el-form-item>
        <el-form-item label="商户公告">
          <el-button type="text" @click="$router.push('/admin/notices')">去公告管理编辑</el-button>
        </el-form-item>
        <el-form-item label="价格货币">
          <el-select v-model="form.currency" style="width:220px">
            <el-option
              v-for="c in form.currencyOptions" :key="c.code"
              :label="c.label" :value="c.code"></el-option>
          </el-select>
          <span class="field-tip">本站按字符计费，套餐金额在「套餐管理」里改</span>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="save">保存设置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card style="margin-top:16px">
      <div slot="header">
        客户端线路
        <el-button type="text" style="float:right" @click="addLine">新增线路</el-button>
      </div>
      <p class="line-tip">客户端登录页按节点名称显示，和官网一样可切换国内、香港、新加坡等。地址填该节点实际后台。</p>
      <el-table :data="form.lines" border stripe>
        <el-table-column label="名称" width="140">
          <template slot-scope="scope"><el-input v-model="scope.row.name"></el-input></template>
        </el-table-column>
        <el-table-column label="区域" width="110">
          <template slot-scope="scope"><el-input v-model="scope.row.region" placeholder="本地 / 海外"></el-input></template>
        </el-table-column>
        <el-table-column label="地址">
          <template slot-scope="scope"><el-input v-model="scope.row.url"></el-input></template>
        </el-table-column>
        <el-table-column label="启用" width="80">
          <template slot-scope="scope">
            <el-switch v-model="scope.row.enabled" :active-value="1" :inactive-value="0"></el-switch>
          </template>
        </el-table-column>
        <el-table-column label="" width="70">
          <template slot-scope="scope">
            <el-button type="text" @click="form.lines.splice(scope.$index, 1)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div style="margin-top:12px">
        <el-button type="primary" @click="save">保存线路</el-button>
      </div>
    </el-card>

    <el-card style="margin-top:16px">
      <div slot="header">
        字符套餐（与官网同一套）
        <el-button type="text" style="float:right" @click="$router.push('/admin/packages')">去套餐管理改价格</el-button>
      </div>
      <el-table :data="packages" border stripe>
        <el-table-column prop="title" label="套餐" min-width="160"></el-table-column>
        <el-table-column label="售价" width="110">
          <template slot-scope="scope">{{ currencySymbol }} {{ scope.row.price }}</template>
        </el-table-column>
        <el-table-column label="字符" width="110">
          <template slot-scope="scope">{{ (scope.row.chars || 0) / 10000 }} 万</template>
        </el-table-column>
      </el-table>
      <el-form :model="form" label-width="120px" style="max-width: 720px; margin-top: 16px">
        <el-form-item label="充值折扣">
          <span>1 组 {{ pct(form.discount1) }} · 10 组 {{ pct(form.discount10) }} · 50 组 {{ pct(form.discount50) }}</span>
        </el-form-item>
        <el-form-item label="1组折扣">
          <el-input-number v-model="form.discount1" :min="0.1" :max="1" :precision="2" :step="0.05"></el-input-number>
        </el-form-item>
        <el-form-item label="10组折扣">
          <el-input-number v-model="form.discount10" :min="0.1" :max="1" :precision="2" :step="0.05"></el-input-number>
        </el-form-item>
        <el-form-item label="50组折扣">
          <el-input-number v-model="form.discount50" :min="0.1" :max="1" :precision="2" :step="0.05"></el-input-number>
        </el-form-item>
        <el-form-item label="试用字符">
          <el-input-number v-model="form.trialChars" :min="0" :step="1000"></el-input-number>
          <span style="margin-left:8px">新用户赠送，官网是 10000</span>
        </el-form-item>
        <el-form-item label="计字规则">
          <span>英文 1 个字符，汉字 2 个字符。翻译扣余额，不按 1500 字另计价。</span>
        </el-form-item>
        <el-form-item label="企业规则">
          <span>购买即可成为企业用户，每买 1 组增加 1 个子账户名额。</span>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="save">保存计费</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>
<script>
export default {
  data() {
    return {
      packages: [],
      form: {
        siteName: '',
        clientDownloadUrl: '',
        trialChars: 10000,
        discount1: 0.9,
        discount10: 0.8,
        discount50: 0.75,
        currency: 'USD',
        currencyOptions: [],
        lines: []
      }
    }
  },
  mounted() { this.load() },
  methods: {
    pct(n) {
      return (Math.round(Number(n || 0) * 100) / 10) + '折'
    },
    load() {
      this.getRequest('/admin/settings').then(resp => {
        if (!resp) return
        this.form = {
          siteName: resp.data.siteName,
          clientDownloadUrl: resp.data.clientDownloadUrl,
          trialChars: resp.data.trialChars,
          discount1: Number(resp.data.discount1 || 0.9),
          discount10: Number(resp.data.discount10 || 0.8),
          discount50: Number(resp.data.discount50 || 0.75),
          currency: resp.data.currency || 'USD',
          currencyOptions: Array.isArray(resp.data.currencyOptions) ? resp.data.currencyOptions : [],
          lines: Array.isArray(resp.data.lines) ? resp.data.lines.map(l => Object.assign({ enabled: 1 }, l)) : []
        }
      })
      this.getRequest('/admin/packages').then(resp => { if (resp) this.packages = resp.data })
    },
    addLine() {
      this.form.lines.push({ id: '', name: '新线路', url: 'http://127.0.0.1:8080', region: '', enabled: 1 })
    },
    save() {
      const payload = Object.assign({}, this.form, { lines: JSON.stringify(this.form.lines || []) })
      this.postRequest('/admin/settings/save', payload).then(resp => {
        this.$message.success(resp.data.msg)
      })
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
.line-tip { color: var(--w-text-faint); font-size: 13px; margin: 0 0 12px; }
.field-tip { color: var(--w-text-faint); font-size: 12px; margin-left: 10px; }
</style>
