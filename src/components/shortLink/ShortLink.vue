<template>
  <div>
    <el-container>
      <el-header style="text-align: left;height: auto; padding: 0;">
        <div>
          <el-tag type="success"
                  style="margin-bottom: 10px;width: 100%;text-align: center;font-size: 14px;height: 40px;padding:6px;margin-top:-10px"
                  size="medium">
          </el-tag>
        </div>
        <div>
          <el-button icon="el-icon-arrow-left" @click="back">返回</el-button>
          链接：
          <el-input placeholder="请输入链接" v-model="searchLink"
                    style="width: 200px;margin: 0px;padding: 0px;"></el-input>
          <el-button type="primary" style="margin-left: 5px" icon="el-icon-search" @click="loadShortLink">搜索</el-button>
        </div>
      </el-header>
      <el-main style="padding-left: 0px;padding-top: 10px">
        <div>
          <el-table :data="shortLink" v-loading="tableLoading" border stripe style="width: 100%">
            <el-table-column prop="platform" align="center" fixed label="短链平台"></el-table-column>
            <el-table-column prop="shareLink" align="center" fixed label="分流链接">
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.shareLink }}</el-link>
                <i class="el-icon-document-copy" style="margin-left:10px;cursor:pointer"
                   @click="copy(scope.row.shareLink)"></i>
              </template>
            </el-table-column>
            <el-table-column prop="type" align="center" fixed label="分配类型" :formatter="formateType"></el-table-column>
            <el-table-column prop="pattern" align="center" fixed label="分配模式"
                             :formatter="formatePattern"></el-table-column>
            <el-table-column prop="message" align="center" fixed label="消息"></el-table-column>
            <el-table-column prop="hits" align="center" fixed label="点击数"></el-table-column>
            <el-table-column fixed="right" label="操作" align="center" width="240px">
              <template slot-scope="scope">
                <el-button type="primary" icon="el-icon-edit" @click="editLink(scope.row)">编辑</el-button>
                <el-button type="primary" icon="el-icon-delete" @click="deleteLink(scope.row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div style="display: flex;justify-content: space-between;margin: 2px">
            <div class="block">
              <el-pagination @size-change="handleSizeChange" @current-change="currentChange" :current-page="currentPage"
                             :page-sizes="[10, 20, 50, 100]"
                             :page-size="rows" layout="total, sizes, prev, pager, next, jumper"
                             :total="totalCount">
              </el-pagination>
            </div>
          </div>
        </div>
      </el-main>
    </el-container>

    <el-form ref="sharePwdForm" style="margin: 0px;padding: 0px;">
      <div style="text-align: left">
        <el-dialog title="修改账号" style="padding: 0px;" :close-on-click-modal="false" :visible.sync="editAccounts"
                   width="600px">
          <el-row>
            <el-col>
              <div>
                <ul class="infinite-list"
                    style="overflow:auto; height: 200px;border:  1px solid gray;padding-left: 0px">
                  <li v-for="i in count" class="infinite-list-item" style="list-style: none;margin: 20px;">
                    <el-form :rules="rules" label-width="100px" :model="ruleForm" ref="ruleForm">
                      <el-form-item label="账号" prop="accounts">
                        <el-input v-model="ruleForm.accounts[i-1]" placeholder="请输入账号" style="width: 300px"
                                  oninput="value=value.replace(/[^\d]/g,'')"></el-input>
                        <i class="el-icon-circle-plus-outline" @click="addAccount"></i>
                        <i class="el-icon-remove-outline" @click="deleteAccount(i)"></i>
                      </el-form-item>
                    </el-form>
                  </li>
                </ul>
              </div>
            </el-col>
          </el-row>
          <span slot="footer" class="dialog-footer">
				<el-button @click="cancelEditAccount">取 消</el-button>
				<el-button type="primary" @click="updateEditAccount">确 定</el-button>
			</span>
        </el-dialog>
      </div>
    </el-form>

  </div>
</template>
<script>
export default {
  data() {
    return {
      ruleForm: {
        accounts: [],
      },
      shortLink: [],
      searchOrderNum: this.$route.query.orderNum,
      searchLink: '',
      tableLoading: false,
      editAccounts: false,
      totalCount: -1,
      currentPage: 1,
      rows: 10,
      id: '',
      count: 1,
      orderNum: '',
      rules: {
        accounts: [
          {required: true, message: '请输入账号', trigger: 'blur'}
        ]
      }
    };
  },
  mounted: function () {
    this.loadShortLink();
  },
  methods: {
    back() {
      this.$router.go(-1);//返回上一层
    },
    addAccount() {
      this.count++;
    },
    deleteAccount(i) {
      if (this.count <= 1) {
        this.$message({
          type: 'warning',
          message: `至少一个账号`
        });
        return;
      }
      this.ruleForm.accounts.splice(i, 1);
      this.count--;
    },
    currentChange(currentChange) {
      this.currentPage = currentChange;
      this.loadShortLink();
    },
    handleSizeChange(val) {
      this.rows = val;
    },
    editLink(row) {
      this.id = row.id;
      this.orderNum = row.orderNum;
      let that = this;
      this.postRequest("/shortLink/getShortLinkInfo", {id: row.id, orderNum: row.orderNum}).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data;
          if (data.accounts.length > 0) {
            let accounts = data.accounts.split(",");
            that.count = accounts.length;
            that.ruleForm.accounts = accounts;
            this.editAccounts = true;
          }
        }
      })
    },
    updateEditAccount() {
      this.postRequest("/shortLink/editShortLink", {
        id: this.id,
        orderNum: this.orderNum,
        accounts: this.ruleForm.accounts
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data;
          this.$message({type: data.success, message: data.msg});
          this.loadShortLink();
          this.id = '';
          this.orderNum = '';
          this.editAccounts = false;
        }
      })
    },
    cancelEditAccount() {
      this.editAccounts = false;
    },
    deleteLink(row) {
      this.$confirm('确认刪除此[' + row.shareLink + ']分流链接，删除后该链接不可用，请慎重操作!', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => {
        this.postRequest("/shortLink/deleteShortLink", {id: row.id, orderNum: row.orderNum}).then(resp => {
          this.tableLoading = false;
          if (resp && resp.status == 200) {
            let data = resp.data;
            this.$message({type: data.success, message: data.msg});
            this.loadShortLink();
          }
        })
      }).catch(() => {

      });
    },
    copy(value) {
      let input = document.createElement("input"); // 直接构建input
      input.value = value; // 设置内容
      document.body.appendChild(input); // 添加临时实例
      input.select(); // 选择实例内容
      document.execCommand("Copy"); // 执行复制
      document.body.removeChild(input); // 删除临时实例
      this.$message({
        type: 'info',
        message: `复制成功`
      });
    },
    formateType(row) {
      if (row.type === 1) {
        return this.$createElement('el-tag', { props: { type: 'success' } }, '工单主号分配');
      } else if (row.type === 2) {
        return this.$createElement('el-tag', { props: { type: 'danger' } }, '自定义分配');
      }
    },
    formatePattern(row) {
      if (row.pattern === 1) {
        return this.$createElement('el-tag', { props: { type: 'success' } }, '在线账号');
      } else if (row.pattern === 2) {
        return this.$createElement('el-tag', { props: { type: 'danger' } }, '全部分配');
      }
    },
    loadShortLink() {
      this.tableLoading = true;
      this.postRequest("/shortLink/getShortLink", {
        "page": this.currentPage,
        "rows": this.rows,
        "orderNum": this.searchOrderNum,
        "shareLink": this.searchLink
      }).then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          let data = resp.data;
          this.shortLink = data.rows;
          this.totalCount = data.total;
        }
      })
    },
  }
};
</script>
<style>
.el-dialog__body {
  padding-top: 0px;
  padding-bottom: 0px;
}

.slide-fade-enter-active {
  transition: all .8s ease;
}

.slide-fade-leave-active {
  transition: all .8s cubic-bezier(1.0, 0.5, 0.8, 1.0);
}

.slide-fade-enter, .slide-fade-leave-to {
  transform: translateX(10px);
  opacity: 0;
}
</style>
