<template>
  <div>
    <el-container>
      <el-header style="text-align: left;height: 150px; padding: 0;">
        <div>
          <el-tag type="success"
                  style="margin-bottom: 10px;width: 100%;text-align: center;font-size: 14px;height: 40px;padding:6px;margin-top:-10px"
                  size="medium" id="pcTag">
            工单号：{{ this.$route.query.orderNum }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单到期时间：{{ this.$route.query.expirationTime }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单类型：{{ this.$route.query.type }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单名称：{{ this.$route.query.title }}&nbsp;&nbsp;&nbsp;&nbsp;
            工单状态：<span>{{ this.$route.query.status | formateStatus }}</span>
          </el-tag>
          <el-tag type="success"
                  style="margin-bottom: 10px;width: 100%;text-align: center;font-size: 14px;height: 115px;padding:6px;margin-top:-10px;display: none"
                  size="medium" id="phoneTag" v-if="showInfoTag">
            <span style="float: left">工单号：{{ this.$route.query.orderNum }} [{{ this.$route.query.status | formateStatus }}]</span>
            <span style="float: right;font-size: 16px"><i class="el-icon-circle-close" @click="hideInfo"></i></span>
            <br>
            <span style="float: left">工单到期时间：{{ this.$route.query.expirationTime }}</span><br>
            <span style="float: left">工单名称：{{ this.$route.query.title }}</span><br>
            <span style="float: left">工单类型：{{ this.$route.query.type }}</span>
          </el-tag>
        </div>
        <div>
          <el-button icon="el-icon-arrow-left" @click="back">返回</el-button>
          <span style="display: none;">{{ this.$route.query.orderNum }}</span>
          <span style="display: none;">{{ this.$route.query.loginAccount }}</span>
          <el-input placeholder="请输入登录IP" v-model="searchLoginIp" style="width: 30%;margin: 0px;padding: 0px;"/>
          <span id="pcSearch">
          <el-date-picker v-model="searchDate" type="datetimerange" start-placeholder="开始日期" end-placeholder="结束日期"
                          :default-time="['00:00:00', '23:59:59']" value-format="yyyy-MM-dd HH:mm:ss"
                          format="yyyy-MM-dd HH:mm:ss"></el-date-picker>
          </span>
          <el-button type="primary" style="margin-left: 5px;margin-top: 10px;" icon="el-icon-search" @click="loadLoginLog">搜索</el-button>
        </div>
      </el-header>
      <el-main style="padding-left: 0px; padding-top: 20px">
        <div>
          <el-table :data="userLogin" v-loading="tableLoading" border stripe style="width: 100%">
            <el-table-column prop="account" align="center"  label="账户"></el-table-column>
            <el-table-column prop="loginType" align="center"  label="登录类型"></el-table-column>
            <el-table-column prop="loginTime" align="center"  label="登录时间">
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.loginTime | formatDateTime }}</el-link>
              </template>
            </el-table-column>
            <el-table-column prop="loginIp" align="center"  label="登录IP">
              <template slot-scope="scope">
                <el-link type="primary" :href="goUrl(scope.row.loginIp)" :underline="false" target="_blank">
                  {{ scope.row.loginIp }}
                </el-link>
              </template>
            </el-table-column>
          </el-table>
          <div style="display: flex;justify-content: space-between;margin: 2px">
            <div class="block">
              <el-pagination @size-change="handleSizeChange" @current-change="currentChange" :current-page="currentPage" :page-sizes="[10, 20, 50, 100]" v-if="pcColumn"
                             :page-size="rows" layout="total, sizes, prev, pager, next, jumper"
                             :total="totalCount">
              </el-pagination>

              <el-pagination @size-change="handleSizeChange" @current-change="currentChange" :current-page="currentPage" :page-sizes="[10, 20, 50, 100]" v-if="phoneColumn"
                             :page-size="rows" layout="total, sizes, prev, pager, next"
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
      userLogin: [],
      pcColumn: true,
      phoneColumn: false,
      showInfoTag: true,
      searchOrderNum: this.$route.query.orderNum,
      searchDate: '',
      searchLoginIp: '',
      searchAccount: this.$route.query.loginAccount,
      tableLoading: false,
      totalCount: -1,
      currentPage: 1,
      rows: 10,
    };
  },
  filters: {
    formateStatus(data) {
      if (data === '1') {
        return "正常";
      } else if (data === '2') {
        return "关闭"
      } else if (data === '3') {
        return "过期"
      } else if (data === '4') {
        return "删除"
      }
    }
  },
  mounted: function () {
    this.loadLoginLog();
    this.isPc();
  },
  methods: {
    back() {
      this.$router.go(-1);//返回上一层
    },
    isPc(){
      let userAgentInfo = navigator.userAgent;
      let Agents = new Array("Android", "iPhone", "SymbianOS", "Windows Phone", "iPad", "iPod");
      let flag = true;
      for (let v = 0; v < Agents.length; v++) {
        if (userAgentInfo.indexOf(Agents[v]) > 0) { flag = false; break; }
      }

      if(!flag){
        this.phoneColumn = true;
        this.pcColumn = false;
      }else{
        this.phoneColumn = false;
        this.pcColumn = true;
      }

      return flag;
    },
    hideInfo(){
      this.showInfoTag = false;
    },
    goUrl(data) {
      return "https://www.ip.cn/ip/" + data + ".html";
    },
    currentChange(currentChange) {
      this.currentPage = currentChange;
      this.loadLoginLog();
    },
    handleSizeChange(val) {
      this.rows = val;
    },
    loadLoginLog() {
      var beginTime = "";
      var endTime = "";
      if (this.searchDate.length > 0) {
        beginTime = this.searchDate[0];
        endTime = this.searchDate[1];
      }
      this.tableLoading = true;
      this.getRequest("/userLogin/getUserLogin?page=" + this.currentPage + "&rows=" + this.rows + "&account=" + this.searchAccount + "&beginTime=" + beginTime + "&endTime=" + endTime + "&loginIp=" + this.searchLoginIp + "").then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          var data = resp.data;
          this.userLogin = data.rows;
          this.totalCount = data.total;
        }
      })
    },
  }
};
</script>
<style>
@media screen and (max-width: 500px){
  #phoneTag{
    display: block !important;
  }
  #pcTag, #pcSearch{
    display: none;
  }
}

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
