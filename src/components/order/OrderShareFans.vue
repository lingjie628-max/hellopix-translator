<template>
  <div>
    <el-container>
      <el-header style="text-align: left;height: auto; padding: 0;">
        <div>
          <el-tag type="success"
                  style="margin-bottom: 10px;width: 100%;text-align: center;font-size: 14px;height: 40px;padding:6px;margin-top:-10px"
                  size="medium">
            工单号：{{ this.$route.query.orderNum }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单到期时间：{{ this.$route.query.expirationTime }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单类型：{{ this.$route.query.type }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单名称：{{ this.$route.query.title }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单状态：<span>{{ this.$route.query.status | formateStatus }}</span>&nbsp;&nbsp;&nbsp;&nbsp;
            置零时间：<span>
							<el-tooltip class="item" effect="dark" :content="'每天' + zeroTime +'单日目标已完成数自动置零'" placement="top-start">
								<i class="el-icon-s-opportunity" title=""></i>
							</el-tooltip>{{ this.zeroTime }}
						  </span>&nbsp;&nbsp;&nbsp;&nbsp;
            链接失效时间：<span>{{ this.passwordExpirationTime | formatDateTime }}</span>
          </el-tag>
        </div>
        <div>
          <el-button icon="el-icon-arrow-left" @click="back">返回</el-button>
          <span style="display: none;">{{ this.$route.query.orderNum }}</span>
          <span style="display: none;">{{ this.$route.query.loginAccount }}</span>
          账号：
          <el-input placeholder="请输入账号" v-model="searchAccount"
                    style="width: 330px;margin: 0px;padding: 0px;"></el-input>
          昵称：
          <el-input placeholder="请输昵称" v-model="searchNickName"
                    style="width: 300px;margin: 0px;padding: 0px;"></el-input>
          用户类型：
          <el-select v-model="searchType" placeholder="请选择">
            <el-option value="">全部</el-option>
            <el-option value="新粉">新粉</el-option>
            <el-option value="重粉">重粉</el-option>
          </el-select>
          时间：
          <el-date-picker v-model="searchDate" type="datetimerange" start-placeholder="开始日期" end-placeholder="结束日期"
                          :default-time="['00:00:00', '23:59:59']" value-format="yyyy-MM-dd HH:mm:ss"
                          format="yyyy-MM-dd HH:mm:ss"></el-date-picker>
          <el-button type="primary" style="margin-left: 5px" icon="el-icon-search" @click="loadOrderFans">搜索</el-button>
        </div>

      </el-header>
      <el-main style="padding-left: 0px;padding-top: 10px">
        <div>
          <el-table :data="orderFans" v-loading="tableLoading" border stripe style="width: 100%">
            <el-table-column prop="orderNum" align="center" fixed label="工单号"></el-table-column>
            <el-table-column prop="account" align="center" fixed label="账号"></el-table-column>
            <el-table-column prop="nickName" align="center" fixed label="昵称"></el-table-column>
            <el-table-column prop="createTime" align="center" fixed label="进粉时间">
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.createTime | formatDateTime }}</el-link>
              </template>
            </el-table-column>
            <el-table-column prop="insertTime" align="center" fixed label="记录时间">
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.insertTime | formatDateTime }}</el-link>
              </template>
            </el-table-column>
            <el-table-column prop="type" align="center" fixed label="类型" :formatter="formateType"></el-table-column>
            <el-table-column prop="repeatAccount" align="center" fixed label="重粉账号"></el-table-column>
          </el-table>
          <div style="display: flex;justify-content: space-between;margin: 2px">
            <div class="block">
              <el-pagination @size-change="handleSizeChange" @current-change="currentChange" :current-page="currentPage"
                             :page-sizes="[10, 20, 50, 100]" :page-size="rows"
                             layout="total, sizes, prev, pager, next, jumper"
                             :total="totalCount">
              </el-pagination>
            </div>
          </div>
        </div>
      </el-main>
    </el-container>
  </div>
</template>
<script>
export default {
  data() {
    return {
      orderFans: [],
      searchOrderNum: this.$route.query.orderNum,
      searchDate: '',
      searchAccount: '',
      searchLoginAccount: this.$route.query.loginAccount,
      searchNickName: '',
      tableLoading: false,
      searchType: '',
      totalCount: -1,
      currentPage: 1,
      zeroTime: this.$route.query.zeroTime,
      passwordExpirationTime: this.$route.query.passwordExpirationTime,
      rows: 10,
    };
  },
  filters: {
    formateStatus(data) {
      if (data === 1 || data === "1") {
        return "正常";
      } else if (data === 2 || data === "2") {
        return "关闭"
      } else if (data === 3 || data === "3") {
        return "过期"
      } else if (data === 4 || data === "4") {
        return "删除"
      }
    }
  },
  mounted: function () {
    this.loadOrderFans();
  },
  methods: {
    back() {
      this.$router.go(-1);//返回上一层
    },
    exportOrderFans() {
      var beginTime = "";
      var endTime = "";
      if (this.searchDate.length > 0) {
        beginTime = this.searchDate[0];
        endTime = this.searchDate[1];
      }
      window.open("/apis/export/orderFansExport?orderNum=" + this.searchOrderNum + "&account=" + this.searchAccount + "&loginAccount=" + this.searchLoginAccount + "&type=" + this.searchType + "&nickName=" + this.searchNickName + "&beginTime=" + beginTime + "&endTime=" + endTime + "", "_parent");
    },
    currentChange(currentChange) {
      this.currentPage = currentChange;
      this.loadOrderFans();
    },
    handleSizeChange(val) {
      this.rows = val;
    },
    formateType(row) {
      if (row.type === "底粉") {
        return this.$createElement('el-tag', { props: { type: 'success' } }, '底粉');
      } else if (row.type === "新粉") {
        return this.$createElement('el-tag', { props: { type: 'danger' } }, '新粉');
      } else if (row.type === "重粉") {
        return this.$createElement('el-tag', { props: { type: 'warning' } }, '重粉');
      } else if (row.type === "补录") {
        return this.$createElement('el-tag', { props: { type: 'info' } }, '补录');
      }
    },
    loadOrderFans() {
      var beginTime = "";
      var endTime = "";
      if (this.searchDate.length > 0) {
        beginTime = this.searchDate[0];
        endTime = this.searchDate[1];
      }
      this.tableLoading = true;
      this.getRequest("/orderDetails/getOrderFans?page=" + this.currentPage + "&rows=" + this.rows + "&orderNum=" + this.searchOrderNum + "&shareToken=" + encodeURIComponent(localStorage.getItem("shareToken_" + this.searchOrderNum) || "") + "&account=" + this.searchAccount + "&loginAccount=" + this.searchLoginAccount + "&type=" + this.searchType + "&nickName=" + this.searchNickName + "&beginTime=" + beginTime + "&endTime=" + endTime + "").then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          var data = resp.data;
          this.orderFans = data.rows;
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
