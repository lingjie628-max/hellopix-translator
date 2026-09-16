/**
 * SigV4 签名验证。
 *
 * 这个测试的价值在于：**不需要 AWS key 就能验证签名算法是否正确**。
 *
 * 其余适配器在拿到真实 key 之前无法验证，而签名的错误表现是
 * `403 SignatureDoesNotMatch` —— 既不告诉你是哪一步错了，
 * 也没法通过读代码发现。AWS 官方公布了密钥推导的测试向量，
 * 所以这部分可以提前钉死。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { signingKey, signRequest, sha256Hex } = require('../server/services/translation-adapters-aws')

test('签名密钥推导匹配 AWS 官方测试向量', () => {
  // 来自 AWS 文档《Examples of how to derive a signing key for Signature Version 4》
  const key = signingKey(
    'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    '20150830',
    'us-east-1',
    'iam'
  )
  assert.equal(
    key.toString('hex'),
    'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9'
  )
})

test('相同输入得到相同签名 —— 签名必须是确定性的', () => {
  const opts = {
    method: 'POST',
    host: 'translate.us-east-1.amazonaws.com',
    path: '/',
    payload: JSON.stringify({ Text: 'hello', SourceLanguageCode: 'en', TargetLanguageCode: 'zh' }),
    region: 'us-east-1',
    service: 'translate',
    accessKey: 'AKIDEXAMPLE',
    secretKey: 'secret',
    now: new Date('2026-09-16T12:00:00Z')
  }
  const a = signRequest(opts)
  const b = signRequest(opts)
  assert.equal(a.Authorization, b.Authorization)
})

test('签名头结构符合 SigV4 规范', () => {
  const h = signRequest({
    method: 'POST',
    host: 'translate.eu-west-1.amazonaws.com',
    path: '/',
    payload: '{}',
    region: 'eu-west-1',
    service: 'translate',
    accessKey: 'AKIDEXAMPLE',
    secretKey: 'secret',
    now: new Date('2026-09-16T12:00:00Z')
  })

  // Credential 里必须含日期/区域/服务/终止串，缺一段 AWS 就拒
  assert.match(h.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260916\/eu-west-1\/translate\/aws4_request/)
  assert.match(h.Authorization, /SignedHeaders=content-type;host;x-amz-date;x-amz-target/)
  assert.match(h.Authorization, /Signature=[0-9a-f]{64}$/)
  assert.equal(h['X-Amz-Date'], '20260916T120000Z')
  assert.equal(h['X-Amz-Target'], 'AWSShakespeareService.TranslateText')
})

test('签名的头列表必须按字典序 —— 顺序错了 AWS 直接拒', () => {
  const h = signRequest({
    method: 'POST', host: 'translate.us-east-1.amazonaws.com', path: '/', payload: '{}',
    region: 'us-east-1', service: 'translate',
    accessKey: 'A', secretKey: 'S', now: new Date('2026-09-16T12:00:00Z')
  })
  const signed = h.Authorization.match(/SignedHeaders=([^,]+)/)[1].split(';')
  assert.deepEqual(signed, [...signed].sort(), 'SignedHeaders 未按字典序排列')
})

test('区域变了签名必须跟着变 —— 否则跨区域会 403', () => {
  const base = {
    method: 'POST', host: 'translate.us-east-1.amazonaws.com', path: '/', payload: '{}',
    service: 'translate', accessKey: 'A', secretKey: 'S', now: new Date('2026-09-16T12:00:00Z')
  }
  const a = signRequest(Object.assign({}, base, { region: 'us-east-1' }))
  const b = signRequest(Object.assign({}, base, { region: 'ap-northeast-1' }))
  assert.notEqual(a.Authorization, b.Authorization)
})

test('临时凭据要带 security-token 并计入签名', () => {
  const h = signRequest({
    method: 'POST', host: 'translate.us-east-1.amazonaws.com', path: '/', payload: '{}',
    region: 'us-east-1', service: 'translate', accessKey: 'A', secretKey: 'S',
    sessionToken: 'TOKEN123', now: new Date('2026-09-16T12:00:00Z')
  })
  assert.equal(h['X-Amz-Security-Token'], 'TOKEN123')
  // 用了临时凭据却不签这个头，AWS 会报签名不匹配
  assert.match(h.Authorization, /x-amz-security-token/)
})

test('时间戳格式正确（AWS 要求 YYYYMMDDTHHMMSSZ）', () => {
  const h = signRequest({
    method: 'POST', host: 'translate.us-east-1.amazonaws.com', path: '/', payload: '{}',
    region: 'us-east-1', service: 'translate', accessKey: 'A', secretKey: 'S',
    now: new Date('2026-01-02T03:04:05Z')
  })
  assert.equal(h['X-Amz-Date'], '20260102T030405Z')
  assert.match(h.Authorization, /Credential=A\/20260102\//)
})

test('payload 哈希正确', () => {
  // 空串的 SHA256 是固定值，可用来确认实现没写错
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})
