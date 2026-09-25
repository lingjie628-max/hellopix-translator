<template>
  <div>
    <el-container>
      <el-header style="text-align: left;height: auto; padding: 0;">
        <div>
          订单号：
          <el-input placeholder="请输入订单号" v-model="searchOrderNum" clearable style="width: 200px;margin: 0px;padding: 0px;"></el-input>

          <span id="pcSearch">
            支付方式：
            <el-select v-model="searchType" placeholder="请选择" style="width:120px">
              <el-option value="">全部</el-option>
              <el-option value="微信">微信</el-option>
              <el-option value="支付宝">支付宝</el-option>
            </el-select>
            支付状态：
            <el-select v-model="searchStatus" placeholder="请选择" style="width:120px">
              <el-option v-for="item in options" :key="item.value" :label="item.label" :value="item.value"></el-option>
            </el-select>
            下单时间：
            <el-date-picker v-model="searchDate" type="datetimerange" start-placeholder="开始日期" end-placeholder="结束日期"
                            :default-time="['00:00:00', '23:59:59']" value-format="yyyy-MM-dd HH:mm:ss"
                            format="yyyy-MM-dd HH:mm:ss"></el-date-picker>
          </span>
          <el-button type="primary" style="margin-left: 5px;margin-top: 10px" icon="el-icon-search" @click="loadUserRecharge">查询
          </el-button>
          <el-button type="success" style="margin-left: 5px;margin-top: 10px" icon="el-icon-shopping-cart-full" @click="$router.push('/user/rechargePage')">充值
          </el-button>
        </div>
      </el-header>
      <el-main style="padding-left: 0px;padding-top: 10px">
        <div>
          <el-table :data="userRecharge" v-loading="tableLoading" border stripe style="width: 100%">
            <el-table-column prop="orderNum" align="center"  label="订单号" width="160px"></el-table-column>
            <el-table-column prop="orderType" align="center"  label="订单类型"></el-table-column>
            <el-table-column prop="originalPrice" align="center"  label="原价金额"></el-table-column>
            <el-table-column prop="discountAmount" align="center"  label="折扣金额" sortable></el-table-column>
            <el-table-column prop="paidAmount" align="center"  label="实付金额" sortable></el-table-column>
            <el-table-column prop="type" align="center"  label="支付方式"></el-table-column>
            <el-table-column prop="status" align="center"  label="订单状态"
                             :formatter="formateStatus"></el-table-column>
            <el-table-column label="操作" width="90">
              <template slot-scope="scope">
                <el-button type="text" disabled>{{ opText(scope.row) }}</el-button>
              </template>
            </el-table-column>
            <el-table-column prop="createTime" align="center" label="充值时间" width="180px">
              <template slot-scope="scope">
                <el-link type="success" :underline="false">{{ scope.row.createTime | formatDateTime }}</el-link>
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
      userRecharge: [],
      searchOrderNum: '',
      searchDate: '',
      searchType: '',
      searchStatus: '',
      tableLoading: false,
      totalCount: -1,
      currentPage: 1,
      pcColumn: true,
      phoneColumn: false,
      rows: 10,
      options: [{
        value: '',
        label: '全部'
      }, {
        value: '1',
        label: '支付成功'
      }, {
        value: '2',
        label: '已过期'
      }, {
        value: '0',
        label: '未支付'
      }]
    };
  },
  mounted: function () {
    this.loadUserRecharge();
    this.isPc();
  },
  methods: {
    back() {
      this.$router.go(-1);//返回上一层
    },
    // 订单状态展示统一走「有效状态」：过期是惰性判定的，库里 status 还是 0，
    // 直接读 status 会把早就过期、再也付不了款的订单显示成"未支付"，
    // 商户就会一直等一笔不会到账的付款。后端已把 effectiveStatus 一起下发。
    effStatus(row) {
      return row.effectiveStatus !== undefined ? row.effectiveStatus : row.status;
    },
    formateStatus(row) {
      const status = this.effStatus(row);
      if (status === 1) {
        return this.$createElement('el-button', { props: { type: 'success', size: 'mini', plain: true, disabled: true } }, '支付成功');
      } else if (status === 2) {
        return this.$createElement('el-button', { props: { type: 'warning', size: 'mini', plain: true, disabled: true } }, '已过期');
      } else if (status === 3) {
        return this.$createElement('el-button', { props: { type: 'info', size: 'mini', plain: true, disabled: true } }, '已取消');
      } else if (status === 0) {
        return this.$createElement('el-button', { props: { type: 'danger', size: 'mini', plain: true, disabled: true } }, '未支付');
      }
      return this.$createElement('el-button', { props: { type: 'warning', size: 'mini', plain: true, disabled: true } }, '异常');
    },
    opText(row) {
      const status = this.effStatus(row);
      if (status === 1) return '已完成';
      if (status === 2) return '已过期';
      if (status === 3) return '已取消';
      if (status === 0) return '待支付';
      return '异常';
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
    currentChange(currentChange) {
      this.currentPage = currentChange;
      this.loadUserRecharge();
    },
    handleSizeChange(val) {
      this.rows = val;
    },
    loadUserRecharge() {
      let beginTime = "";
      let endTime = "";
      if (this.searchDate.length > 0) {
        beginTime = this.searchDate[0];
        endTime = this.searchDate[1];
      }
      this.tableLoading = true;
      this.getRequest("/userRecharge/getUserRecharge?page=" + this.currentPage + "&rows=" + this.rows + "&beginTime=" + beginTime + "&endTime=" + endTime + "&status=" + this.searchStatus + "&orderNum=" + this.searchOrderNum + "&type=" + this.searchType + "").then(resp => {
        this.tableLoading = false;
        if (resp && resp.status == 200) {
          var data = resp.data;
          this.userRecharge = data.rows;
          this.totalCount = data.total;
        }
      })
    },
  }
};
</script>
<style>
@media screen and (max-width: 500px){
  #pcSearch{
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
