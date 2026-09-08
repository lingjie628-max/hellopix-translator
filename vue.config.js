const { defineConfig } = require('@vue/cli-service')
const express = require('express')
const registerMock = require('./mock')

module.exports = defineConfig({
  transpileDependencies: false,
  lintOnSave: false,
  publicPath: './',
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
      devServer.app.use('/apis', express.urlencoded({ extended: true }))
      devServer.app.use('/apis', express.json())
      registerMock(devServer.app)
      return middlewares
    }
  }
})
