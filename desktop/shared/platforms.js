module.exports = [
  { id: 'whatsapp-green', name: 'WhatsApp绿色版', url: 'https://web.whatsapp.com/', icon: 'whatsapp' },
  { id: 'whatsapp-pro', name: 'WhatsApp多功能版', url: 'https://web.whatsapp.com/', icon: 'whatsapp' },
  // 商业版与上面两个是**同一个站点**：WhatsApp Business 没有独立的网页聊天入口，
  // 官网只说「用手机上的 Business App 扫码登录 web.whatsapp.com」。
  // 三者靠各自的分区（partition）隔离登录态，扫不同的号就是不同的会话。
  { id: 'whatsapp-biz', name: 'WhatsApp商业版', url: 'https://web.whatsapp.com/', icon: 'whatsapp' },
  { id: 'telegram-z', name: 'Telegram', url: 'https://web.telegram.org/a/', icon: 'telegram' },
  { id: 'line', name: 'Line', url: 'chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/index.html', extension: 'line' },
  { id: 'line-biz', name: 'Line商业版', url: 'https://chat.line.biz/', icon: 'line' },
  { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com/' },
  { id: 'messenger', name: 'Messenger', url: 'https://www.messenger.com/' },
  { id: 'facebook', name: 'Facebook', url: 'https://www.facebook.com/' },
  { id: 'facebook-page', name: 'Facebook Business', url: 'https://business.facebook.com/', icon: 'facebook' },
  { id: 'x', name: 'Twitter', url: 'https://x.com/' },
  { id: 'linkedin', name: '领英', url: 'https://www.linkedin.com/' },
  { id: 'zalo', name: 'Zalo', url: 'https://chat.zalo.me/' },
  { id: 'tinder', name: 'Tinder', url: 'https://tinder.com/' },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/app' },
  { id: 'tiktok', name: 'TikTok', url: 'https://www.tiktok.com/' },
  { id: 'skype', name: 'Skype', url: 'https://web.skype.com/' },
  { id: 'googlevoice', name: 'Google Voice', url: 'https://voice.google.com/' },
  { id: 'google-chat', name: 'Google Chat', url: 'https://chat.google.com/' },
  { id: 'teams', name: 'Teams', url: 'https://teams.microsoft.com/v2/' },
  { id: 'snapchat', name: 'Snapchat', url: 'https://web.snapchat.com/' },
  { id: 'openphone', name: 'OpenPhone', url: 'https://my.openphone.com/' },
  { id: 'textnow', name: 'TextNow', url: 'https://www.textnow.com/messaging' },
  { id: 'textfree', name: 'TextFree', url: 'https://messages.textfree.us/' },
  { id: 'bip', name: 'Bip', url: 'https://web.bip.com/' },
  { id: 'quora', name: 'Quora', url: 'https://www.quora.com/' },
  { id: 'okcupid', name: 'OkCupid', url: 'https://www.okcupid.com/', listed: false },
  { id: 'secret', name: 'Secret', url: 'https://www.secret.com/' },
  { id: 'slack', name: 'Slack', url: 'https://app.slack.com/client/' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { id: 'vk', name: 'VK Messenger', url: 'https://vk.com/im' },
  { id: 'band', name: 'Band', url: 'https://band.us/' },
  // Signal 曾经在这里挂过一条 `listed: false` 的隐藏条目，指向 signal.org 首页。
  // 已删除：Signal **没有网页版**（web.signal.org 不存在），官方只提供手机 App
  // 和桌面客户端（原生程序，需手机配对）。而本软件的所有实例都是
  // WebContentsView 加载网页 URL、靠往 DOM 注入 JS 做翻译 ——
  // 原生程序既没有 URL 也没有 DOM，接进来也翻译不了。
  // 详见 2026-10-28 的排查记录：移动外部窗口可行，但控制不了其尺寸，
  // 窗口跟随会抖动、会漂在桌面上、不随主程序退出。
  { id: 'custom-web', name: '自定义网页', url: 'https://www.google.com/', customUrl: true, badge: false },
  { id: 'pm-office', name: 'PM-Office', url: 'https://hellowoorld.com/', icon: 'pm-office', badge: false, listed: false }
]
