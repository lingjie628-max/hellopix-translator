const { defineConfig } = require('@vue/cli-service')

module.exports = defineConfig({
  transpileDependencies: false,
  lintOnSave: false,
  // 必须是绝对路径: 后台路由形如 /admin/login, 用 './' 会让浏览器把
  // js/app.js 解析成 /admin/js/app.js —— 服务端对未匹配路径回落 index.html,
  // 于是拿到一段 HTML 当 JS 执行, 页面直接白屏。
  publicPath: '/',
  css: {
    loaderOptions: {
      css: {
        esModule: false
      }
    }
  },
  devServer: {
    port: 8080,
    setupMiddlewares(middlewares, devServer) {
      // express / mock 都只服务开发服务器（前者给 /apis 解析请求体，后者是接口模拟）。
      // 放在这里按需 require：生产构建只跑 `vue-cli-service build`，不会进这个分支，
      // 因此部署时不需要上传 mock/ 目录，也不会因为缺它而构建失败。
      const express = require('express')
      const registerMock = require('./mock')
      devServer.app.use('/apis', express.urlencoded({ extended: true }))
      devServer.app.use('/apis', express.json())
      registerMock(devServer.app)
      return middlewares
    }
  }
})
