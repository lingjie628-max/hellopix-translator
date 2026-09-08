<template>
	<el-result icon="success" title="Hello Pix 充值成功" subTitle="">
      <template slot="extra">
        
      </template>
    </el-result>
</template>

<script>
  export default {
    data() {
      return {
		 
      };
    },
    mounted: function () {
		 
    },
    methods: {
		 
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
  
  .el-menu-item *{
	  vertical-align:baseline;
  }
  
  .versionTable{
	  margin: 0 auto;
	  width:90%;
	  height:700px;
	  
  }
  
  .tdTop{
	  vertical-align: top;
  }
  
  .versionTable td{
	  padding-left: 10px;
  }
</style>
