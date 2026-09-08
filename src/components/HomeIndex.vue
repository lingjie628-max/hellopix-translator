<template>
  <div class="dash">
    <el-row :gutter="16">
      <el-col :span="16">
        <el-card class="hello-card" shadow="never">
          <div class="hello-name">你好 {{ dash.nickname || dash.username }}</div>
          <div class="hello-mail">{{ dash.email || '未填写邮箱' }}</div>
          <div class="hello-stats">
            <div><span>套餐</span><b>{{ dash.packageTitle || '-' }}</b></div>
            <div><span>字符数</span><b>{{ dash.charBalance || 0 }}</b></div>
            <div><span>子账号数</span><b>{{ dash.subCount || 0 }}/{{ dash.subQuota || 0 }}</b></div>
          </div>
        </el-card>

        <el-card class="list-card" shadow="never">
          <div slot="header" class="list-head">
            <span>子账号列表</span>
            <span class="auto-line">
              自动分配总开关：{{ dash.autoAllocMaster ? '开启' : '关闭' }}
              <el-button v-if="isMain" type="text" @click="toggleMaster">设置</el-button>
            </span>
          </div>
          <el-input v-if="isMain" v-model="keyword" placeholder="输入登录账号或邮箱进行查询" clearable
                    style="width: 280px; margin-bottom: 12px" @keyup.enter.native="load" @clear="load">
            <el-button slot="append" icon="el-icon-search" @click="load"></el-button>
          </el-input>
          <el-table :data="subs" size="small">
            <el-table-column prop="username" label="子账户名称" min-width="140"></el-table-column>
            <el-table-column prop="charBalance" label="剩余字符" width="120"></el-table-column>
            <el-table-column prop="charUsed" label="字符用量" width="120"></el-table-column>
            <el-table-column label="自动分配" width="100">
              <template slot-scope="scope">{{ scope.row.autoAlloc ? '开' : '关' }}</template>
            </el-table-column>
            <template slot="empty">暂无数据</template>
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <div slot="header">公告信息</div>
          <div class="announce">{{ dash.announcement || '暂无公告' }}</div>
        </el-card>
        <el-card shadow="never" style="margin-top:16px">
          <div slot="header">快捷操作</div>
          <div class="quick">
            <el-button v-if="isMain" type="success" @click="$router.push('/user/rechargePage')">充值字符</el-button>
            <el-button v-if="isMain" type="primary" @click="$router.push('/user/team')">子账号管理</el-button>
            <el-button type="warning" @click="$router.push('/user/Recharge')">充值记录</el-button>
            <el-button v-if="isMain" type="danger" @click="toggleMaster">自动分配字符</el-button>
            <el-button @click="pwdVisible=true">修改密码</el-button>
            <el-button type="primary" plain @click="download">下载软件</el-button>
          </div>
        </el-card>
        <el-card shadow="never" style="margin-top:16px">
          <div slot="header">个人信息</div>
          <div class="info-row"><span>字符用量</span><b>{{ dash.charUsed || 0 }}</b></div>
          <div class="info-row"><span>翻译次数</span><b>{{ dash.translateCount || 0 }}</b></div>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog title="修改密码" :visible.sync="pwdVisible" width="420px">
      <el-form :model="pwd" label-width="80px">
        <el-form-item label="原密码"><el-input type="password" v-model="pwd.oldPassword"></el-input></el-form-item>
        <el-form-item label="新密码"><el-input type="password" v-model="pwd.newPassword"></el-input></el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="pwdVisible=false">取消</el-button>
        <el-button type="primary" @click="savePassword">保存</el-button>
      </span>
    </el-dialog>
  </div>
</template>
<script>
export default {
  data() {
    return {
      dash: {},
      keyword: '',
      pwdVisible: false,
      pwd: { oldPassword: '', newPassword: '' }
    }
  },
  computed: {
    isMain() {
      return this.$store.state.user.role !== 'sub'
    },
    subs() {
      const list = this.dash.subs || []
      if (!this.keyword) return list
      return list.filter(s => String(s.username).indexOf(this.keyword) !== -1 || String(s.email || '').indexOf(this.keyword) !== -1)
    }
  },
  mounted() {
    this.load()
  },
  activated() {
    this.load()
  },
  methods: {
    load() {
      this.getRequest('/user/dashboard').then(resp => {
        if (resp && resp.data && typeof resp.data === 'object' && resp.data.username !== undefined) {
          this.dash = resp.data
        }
      }).catch(() => {})
      this.getRequest('/site/info').then(resp => {
        if (resp && resp.data && typeof resp.data === 'object') {
          this.$set(this.dash, 'announcement', resp.data.announcement || '')
        }
      })
    },
    toggleMaster() {
      if (!this.isMain) return
      const next = this.dash.autoAllocMaster ? 0 : 1
      this.postRequest('/team/autoAlloc', { autoAlloc: next }).then(resp => {
        this.$message.success(resp.data.msg)
        this.load()
      })
    },
    savePassword() {
      this.postRequest('/team/password', this.pwd).then(resp => {
        this.$message({ type: resp.data.success === 'error' ? 'error' : 'success', message: resp.data.msg })
        if (resp.data.success !== 'error') {
          this.pwdVisible = false
          this.pwd = { oldPassword: '', newPassword: '' }
        }
      })
    },
    download() {
      if (this.dash.clientDownloadUrl) window.open(this.dash.clientDownloadUrl)
      else this.$message.info('尚未配置客户端下载地址')
    }
  }
}
</script>
<style scoped>
.dash { text-align: left; }
.hello-name { font-size: 22px; font-weight: 700; color: #303133; }
.hello-mail { color: #909399; margin-top: 6px; }
.hello-stats {
  display: flex;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid #ebeef5;
}
.hello-stats div { flex: 1; }
.hello-stats span { display: block; color: #909399; font-size: 13px; }
.hello-stats b { display: block; margin-top: 6px; font-size: 20px; color: #303133; }
.list-card { margin-top: 16px; }
.list-head { display: flex; justify-content: space-between; align-items: center; }
.auto-line { color: #909399; font-size: 13px; font-weight: 400; }
.announce { color: #e6a23c; line-height: 1.7; }
.quick { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.quick .el-button { margin: 0; }
.info-row { display: flex; justify-content: space-between; padding: 8px 0; color: #606266; }
.el-card { margin-bottom: 0; }
</style>
