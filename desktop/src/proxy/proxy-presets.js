module.exports = [
  { id: 'none', name: '直连模式（不设置代理）', kind: 'direct' },
  { id: 'http', name: 'HTTP', kind: 'custom', scheme: 'http', hostEditable: true },
  { id: 'https', name: 'HTTPS', kind: 'custom', scheme: 'https', hostEditable: true },
  { id: 'socks5', name: 'Socks5', kind: 'custom', scheme: 'socks5', hostEditable: true },
  {
    id: 'ssh',
    name: 'SSH',
    kind: 'ssh',
    scheme: 'socks5',
    defaultPort: 22,
    hostEditable: true,
    tip: '会在本机开 Socks5 隧道再给这个应用用。请先在终端配好密钥登录该主机，密码不会自动送给 ssh。'
  },
  {
    id: 'ipfoxy',
    name: 'ipfoxy 动态代理',
    kind: 'vendor',
    scheme: 'socks5',
    schemes: ['socks5', 'http'],
    hosts: [
      { id: 'sg', label: '亚太线路', host: 'gate-sg.ipfoxy.io', port: 58688 },
      { id: 'us', label: '美洲线路', host: 'gate-us.ipfoxy.io', port: 58688 }
    ],
    tip: '主机已按官方网关填好。账号用后台生成的 customer-用户-cc-国家-sessid-会话，密码用代理密码。需境外网络连网关。'
  },
  {
    id: 'p711',
    name: '711Proxy 动态代理',
    kind: 'vendor',
    scheme: 'http',
    schemes: ['http', 'socks5'],
    hosts: [
      { id: 'global', label: '全球', host: 'global.711proxy.com', port: 10000 },
      { id: 'as', label: '亚洲', host: 'as.711proxy.com', port: 10000 },
      { id: 'us', label: '北美', host: 'us.711proxy.com', port: 10000 },
      { id: 'eu', label: '欧洲', host: 'eu.711proxy.com', port: 10000 },
      { id: 'ina', label: '东南亚', host: 'ina.711proxy.com', port: 10000 }
    ],
    ports: [
      { port: 10000, label: '动态住宅-流量' },
      { port: 20000, label: '动态住宅-IP' },
      { port: 12000, label: '不限量' },
      { port: 22000, label: 'SOCKS5' },
      { port: 30000, label: '静态住宅' }
    ],
    tip: '官方默认全球节点 global.711proxy.com。端口按套餐：10000 流量 / 20000 计IP / 22000 SOCKS5。账号用子账户用户名。'
  },
  {
    id: 'sxorg',
    name: 'SX.ORG 动态代理',
    kind: 'vendor',
    scheme: 'socks5',
    schemes: ['socks5', 'http'],
    hosts: [
      { id: 'gw-socks', label: 'Socks5 网关', host: 'gw.proxies.sx', port: 7001, scheme: 'socks5' },
      { id: 'gw-http', label: 'HTTP 网关', host: 'gw.proxies.sx', port: 7000, scheme: 'http' }
    ],
    tip: '官方网关 gw.proxies.sx。Socks5 用 7001，HTTP 用 7000。地区、运营商写在用户名参数里。'
  },
  {
    id: 'smart',
    name: 'smart 动态代理',
    kind: 'vendor',
    scheme: 'http',
    schemes: ['http', 'socks5'],
    hosts: [
      { id: 'gate', label: '官方网关', host: 'gate.smartproxy.com', port: 7000 },
      { id: 'decodo', label: 'Decodo 网关', host: 'gate.decodo.com', port: 7000 }
    ],
    tip: 'Smartproxy 现已更名 Decodo，两个网关都可用，默认端口 7000。账号用控制台生成的 user-xxx。'
  },
  {
    id: 'proxy302',
    name: 'Proxy302 动态代理',
    kind: 'vendor',
    scheme: 'http',
    schemes: ['http', 'socks5'],
    hosts: [
      { id: 'gate', label: '官方网关', host: 'proxy.proxy302.com', port: 2222 }
    ],
    tip: '官方主机 proxy.proxy302.com，端口 2222。账号密码从后台「生成地区代理」复制。'
  },
  {
    id: 'storm',
    name: 'storm 动态代理',
    kind: 'vendor',
    scheme: 'http',
    schemes: ['http', 'socks5'],
    hostEditable: true,
    hosts: [
      { id: 'gate', label: '提取网关', host: 'gate.stormip.net', port: 1000 }
    ],
    tip: '提取模式用 gate.stormip.net:1000。若后台给的是独立主机端口，把整行粘进「主机」。'
  },
  {
    id: 'iphtml',
    name: 'iphtml 动态代理',
    kind: 'vendor',
    scheme: 'http',
    schemes: ['http', 'socks5'],
    hosts: [
      { id: 'gate', label: '官方网关', host: 'gate.iphtml.io', port: 10000 }
    ],
    tip: '官方端点 gate.iphtml.io:10000。国家可写在用户名，例如 user-country-US。'
  },
  {
    id: 'kookeey',
    name: 'kookeey 动态代理',
    kind: 'vendor',
    scheme: 'http',
    schemes: ['http', 'socks5'],
    hostEditable: true,
    hosts: [
      { id: 'hk', label: '东亚优化', host: 'gate-hk.kookeey.info', port: 1000 },
      { id: 'gate', label: '默认网关', host: 'gate.kookeey.info', port: 1000 }
    ],
    tip: '提取动态 IP 用网关 + 1000 端口。独享线路请改成后台给的主机和端口。'
  },
  {
    id: 'ipfly',
    name: 'ipfly 动态代理',
    kind: 'vendor',
    scheme: 'http',
    schemes: ['http', 'socks5'],
    hosts: [
      { id: 'res', label: '动态住宅', host: 'res.ipfly.net', port: 8080 },
      { id: 'accel', label: '加速网关', host: 'accel.ipflygates.com', port: 5001 }
    ],
    tip: '动态住宅默认 res.ipfly.net:8080。账号可带地区，例如 user-country-us。'
  },
  {
    id: 'luminati',
    name: 'Luminati(Bright Data) 动态代理',
    kind: 'vendor',
    scheme: 'http',
    schemes: ['http', 'socks5'],
    hosts: [
      { id: 'http', label: 'HTTP', host: 'brd.superproxy.io', port: 22225, scheme: 'http' },
      { id: 'socks', label: 'Socks5', host: 'brd.superproxy.io', port: 22228, scheme: 'socks5' }
    ],
    tip: '官方主机 brd.superproxy.io。HTTP 22225，Socks5 22228。账号用 Zone 用户名，不是登录邮箱。'
  },
  {
    id: 'oxylabs',
    name: 'oxylabs 动态代理',
    kind: 'vendor',
    scheme: 'http',
    schemes: ['http', 'socks5'],
    hosts: [
      { id: 'pr', label: '住宅/移动', host: 'pr.oxylabs.io', port: 7777 }
    ],
    tip: '住宅网关 pr.oxylabs.io:7777。用户名必须带 customer- 前缀，地区用 -cc-US。'
  },
  {
    id: 'rolaip',
    name: 'rolaip 动态代理',
    kind: 'vendor',
    scheme: 'http',
    schemes: ['http', 'socks5'],
    hostEditable: true,
    hosts: [
      { id: 'gate', label: '官方网关', host: 'gate.rola-ip.co', port: 10000 }
    ],
    tip: '以控制台生成的主机端口为准。用户名可追加 -country-us 或 session。'
  },
  {
    id: 'skyip',
    name: 'skyip 动态代理',
    kind: 'vendor',
    scheme: 'http',
    schemes: ['http', 'socks5'],
    hostEditable: true,
    hosts: [
      { id: 'gate', label: '官方网关', host: 'gate.skyip.net', port: 1000 }
    ],
    tip: '提取网关 gate.skyip.net。若后台给了独立节点，把整行粘进「主机」。'
  },
  {
    id: 'socks5io',
    name: 'socks5io 动态代理',
    kind: 'vendor',
    scheme: 'socks5',
    schemes: ['socks5', 'http'],
    hostEditable: true,
    hosts: [
      { id: 'gate', label: '官方网关', host: 'gate.socks5.io', port: 1080 }
    ],
    tip: '默认按 Socks5 接入。主机以控制台生成信息为准。'
  }
]
