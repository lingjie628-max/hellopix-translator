const defaultUrl = String(process.env.PIX_PUBLIC_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')

module.exports = [
  { id: 'cn', name: '国内线路', url: defaultUrl, region: '国内' },
  { id: 'hk', name: '香港线路', url: defaultUrl, region: '香港' },
  { id: 'sg', name: '新加坡线路', url: defaultUrl, region: '新加坡' },
  { id: 'jp', name: '日本线路', url: defaultUrl, region: '日本' },
  { id: 'us', name: '美国线路', url: defaultUrl, region: '美国' }
]
