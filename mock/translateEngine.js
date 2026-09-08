const translateApi = require('./translateApi')

module.exports = {
  detectLang: translateApi.detectLang,
  countBillableChars: translateApi.countBillableChars,
  translateText: function () {
    return Promise.reject(new Error('翻译走 translateApi，不调取外部计费或演示接口'))
  }
}
