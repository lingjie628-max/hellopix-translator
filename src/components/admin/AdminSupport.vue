<template>
  <div class="admin-page">
    <el-card>
      <div slot="header">登录 / 注册页客服按钮</div>
      <el-form :model="form" label-width="120px" style="max-width: 640px">
        <el-form-item label="显示按钮">
          <el-switch v-model="form.supportShow" :active-value="1" :inactive-value="0"></el-switch>
          <span style="margin-left:8px;color:#909399;font-size:12px">商户登录、注册、找回密码底部</span>
        </el-form-item>
        <el-form-item label="按钮文字">
          <el-input v-model="form.supportBtnText" placeholder="联系客服"></el-input>
        </el-form-item>
        <el-form-item label="跳转链接">
          <el-input v-model="form.telegramUrl" placeholder="https://t.me/xxx 或其它客服链接"></el-input>
        </el-form-item>
        <el-form-item label="客服账号">
          <el-input v-model="form.telegram" placeholder="@xxx，可给商户对照"></el-input>
        </el-form-item>
        <el-form-item label="防诈说明">
          <el-input type="textarea" :rows="3" v-model="form.supportNote"></el-input>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="saveSupport">保存客服</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card style="margin-top:16px">
      <div slot="header">
        常见问题
        <el-button type="success" size="mini" style="float:right" @click="open()">新增问题</el-button>
      </div>
      <el-table :data="faqs" border stripe>
        <el-table-column prop="sort" label="排序" width="70"></el-table-column>
        <el-table-column prop="question" label="问题" min-width="200"></el-table-column>
        <el-table-column prop="answer" label="解答" min-width="280" show-overflow-tooltip></el-table-column>
        <el-table-column label="显示" width="80">
          <template slot-scope="scope">
            <el-tag :type="scope.row.enabled ? 'success' : 'info'" size="mini">{{ scope.row.enabled ? '显示' : '隐藏' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template slot-scope="scope">
            <el-button type="text" @click="open(scope.row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog :title="faq.id ? '编辑问题' : '新增问题'" :visible.sync="visible" width="520px">
      <el-form :model="faq" label-width="80px">
        <el-form-item label="问题"><el-input v-model="faq.question"></el-input></el-form-item>
        <el-form-item label="解答"><el-input type="textarea" :rows="5" v-model="faq.answer"></el-input></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="faq.sort" :min="1"></el-input-number></el-form-item>
        <el-form-item label="显示">
          <el-switch v-model="faq.enabled" :active-value="1" :inactive-value="0"></el-switch>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="visible=false">取消</el-button>
        <el-button type="primary" @click="saveFaq">保存</el-button>
      </span>
    </el-dialog>
  </div>
</template>
<script>
export default {
  data() {
    return {
      form: { telegram: '', telegramUrl: '', supportNote: '', supportBtnText: '联系客服', supportShow: 1 },
      faqs: [],
      visible: false,
      faq: {}
    }
  },
  mounted() { this.load() },
  methods: {
    load() {
      this.getRequest('/admin/settings').then(resp => {
        if (!resp) return
        this.form = {
          telegram: resp.data.telegram || '',
          telegramUrl: resp.data.telegramUrl || '',
          supportNote: resp.data.supportNote || '',
          supportBtnText: resp.data.supportBtnText || '联系客服',
          supportShow: Number(resp.data.supportShow) !== 0 ? 1 : 0
        }
      })
      this.getRequest('/admin/faqs').then(resp => { if (resp) this.faqs = resp.data })
    },
    saveSupport() {
      this.postRequest('/admin/settings/save', this.form).then(resp => {
        this.$message.success(resp.data.msg)
      })
    },
    open(row) {
      this.faq = row ? Object.assign({}, row) : { question: '', answer: '', sort: this.faqs.length + 1, enabled: 1 }
      this.visible = true
    },
    saveFaq() {
      this.postRequest('/admin/faqs/save', this.faq).then(resp => {
        this.$message.success(resp.data.msg)
        this.visible = false
        this.getRequest('/admin/faqs').then(r => { if (r) this.faqs = r.data })
      })
    }
  }
}
</script>
<style scoped>
.admin-page { text-align: left; }
</style>
