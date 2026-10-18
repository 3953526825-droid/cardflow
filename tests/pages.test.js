'use strict';
/*
 * 页面契约测试（E1/E2 新增的界面元素）：
 *   - 导出的下拉与按钮、「扫码连接」区块在两个学科的页面里都在，且没有残留占位符
 *   - 二维码库以静态文件形式引用，并且真的能取到
 *   - 内网地址过滤规则：回环 / 链路本地 / VPN 的 fake-IP 段 198.18.0.0/15 都要被排除
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');

const { startServer } = require('./helpers/harness');
const { isFakeIp, pickAddresses } = require('../src/server.js');

const ctx = {};

before(async () => {
  ctx.server = await startServer({
    multi: true,
    ankiUrl: 'http://127.0.0.1:1',
    configs: { demo: { token: 'demo-token-0123456789' } }
  });
});

after(async () => { if (ctx.server) await ctx.server.stop(); });

for (const id of ['demo']) {
  test(`[${id}] 页面里有导出控件与扫码区，且没有残留占位符`, async () => {
    const html = await (await fetch(`${ctx.server.base}/${id}/`)).text();
    assert.ok(!html.includes('{{'), '不应残留未替换的占位符');
    assert.doesNotMatch(html, /id="exportFile"/, '「导出为文件」已整个删掉（与 .apkg 重复且丢媒体）');
    assert.match(html, /id="downloadApkg"/, '要有「下载 .apkg」入口（不依赖 AnkiConnect 的导入方式）');
    assert.match(html, /id="exportGate"/, '导入 / .apkg 的类型勾选收进确认弹层，平时不占页面空间');
    assert.match(html, /class="exportType" value="basic" checked/, '弹层里要能按类型多选：普通卡');
    assert.match(html, /class="exportType" value="cloze" checked/, '弹层里要能按类型多选：填空卡');
    assert.match(html, /class="exportType" value="occlusion" checked/, '弹层里要能按类型多选：图像遮挡卡');
    assert.match(html, /class="exportType" value="audio" checked/, '弹层里要能按类型多选：音频卡');
    assert.match(html, /id="jinaUrl"/, 'Jina 中转地址输入框要在（手机直连 r.jina.ai 不通时用）');
    assert.match(html, /id="qrBox"/);
    assert.match(html, /id="qrImage"/);
    assert.match(html, /id="qrLink"/);
    assert.match(html, /id="refreshQr"/);
    assert.match(html, /id="copyQrLink"/);
    assert.match(html, new RegExp(`src="/${id}/vendor/qrcode-generator-1\\.4\\.4\\.js"`), '二维码库要按学科前缀引用');
    assert.match(html, /不要.*公开/, '要有「不要发到公开地方」的安全提示');
  });

  test(`[${id}] 页面样式与入口：预览标题加粗、历史记录图标按钮与全屏层都在`, async () => {
    const html = await (await fetch(`${ctx.server.base}/${id}/`)).text();
    assert.match(html, /\.cardTitle\s*\{\s*font-weight:\s*700/, '预览卡片标题要加粗（以前生物那份预览被化学版覆盖，标题丢了加粗）');
    assert.match(html, /id="historyOpen"/, '右下角历史记录图标按钮必须在');
    assert.match(html, /id="historyBox"/, '历史记录的全屏层必须在');
    assert.match(html, /id="limitSingle"[\s\S]*id="limitTotal"/, '调研字数上限的两个输入框都要在');
    assert.match(html, /id="imgQuality"/, '压缩档位选择要在');
    assert.match(html, /id="imagePreview"/, '压缩后大图预览层要在');
    assert.match(html, /id="imagePreviewImg"/, '大图预览的 img 要在');
    assert.match(html, /id="syncAnki"/, '同步 AnkiWeb 按钮要在');
    assert.match(html, /id="autoSync"/, '导入后自动同步的开关要在');
    assert.match(html, /id="autoGroup"/, '自动分层导入的开关要在');
    assert.match(html, /id="groupRule"/, '分组规则输入框要在');
    assert.match(html, /id="groupExample"/, '分组示例图上传要在');
    assert.match(html, /class="cardType" value="cloze"/, '卡片类型勾选组里要有填空卡');
    assert.match(html, /<details class="subBox" id="autoGroupBox">/, '自动分层导入要收进小折叠块（手机上默认只占一行）');
    assert.match(html, /<details class="subBox" id="apiBox">/, '接口设置（API 地址与 Key）也要收进小折叠块');
    assert.match(html, /id="groupExampleRow"[^>]* hidden/, '没选图时分组示例图那一行默认隐藏');
    assert.doesNotMatch(html, /id="clozeWeight"|id="depth"/, '旧的「填空卡优先级 / 理解深度」下拉已换成卡片类型勾选');
    assert.doesNotMatch(html, /填空卡优先级/, '页面上不再出现「填空卡优先级」字样');
    assert.doesNotMatch(html, /id="liteMode"|id="liteModeStyle"/, '学科页不再显示轻量模式');
  });

  test(`[${id}] viewport meta 必须在（少了它手机会按 980px 桌面宽度渲染）`, async () => {
    const html = await (await fetch(`${ctx.server.base}/${id}/`)).text();
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1/, '两个学科都必须有 viewport meta');
    assert.match(html, /content="width=device-width,initial-scale=1(,viewport-fit=cover)?"/, 'viewport 内容格式要合法（不能有逗号悬挂、不能带空格）');
    if (id === 'demo') assert.match(html, /viewport-fit=cover/);
  });
}

test('内网地址过滤：Tailscale/ZeroTier 要当远程地址保留，虚拟网卡与 fake-IP 不要', () => {
  const nets = {
    'WLAN': [{ family: 'IPv4', internal: false, address: '192.168.0.13' }],
    'Tailscale': [{ family: 'IPv4', internal: false, address: '100.124.20.74' }],
    'ZeroTier One [abcdef]': [{ family: 'IPv4', internal: false, address: '10.147.17.5' }],
    'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.20.0.1' }],
    'VMware Network Adapter VMnet8': [{ family: 'IPv4', internal: false, address: '192.168.226.1' }],
    'Clash': [{ family: 'IPv4', internal: false, address: '198.18.0.50' }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    'WLAN 2': [{ family: 'IPv4', internal: false, address: '169.254.9.9' }],
    'Ethernet': [{ family: 'IPv6', internal: false, address: 'fe80::1' }]
  };
  const picked = pickAddresses(nets);
  assert.deepEqual(picked.lan, ['192.168.0.13'], '只留真正能连上的局域网地址');
  assert.deepEqual(picked.remote, ['100.124.20.74', '10.147.17.5'], 'Tailscale/ZeroTier 归到远程那组');
  assert.ok(!picked.lan.includes('198.18.0.50') && !picked.remote.includes('198.18.0.50'), 'fake-IP 一律不要');
});

test('二维码库是静态文件，学科前缀下能取到', async () => {
  const page = await fetch(`${ctx.server.base}/demo/vendor/qrcode-generator-1.4.4.js`);
  assert.equal(page.status, 200);
  const text = await page.text();
  assert.match(text, /qrcode-generator 1\.4\.4/);
  assert.match(text, /MIT/);
  assert.match(text, /var qrcode = function/);
});

test('目录穿越取不到别的文件', async () => {
  const response = await fetch(`${ctx.server.base}/demo/vendor/..%2F..%2Fpackage.json`);
  assert.notEqual(response.status, 200);
});

test('内网地址过滤：回环、链路本地、VPN fake-IP 段都要排除', () => {
  assert.equal(isFakeIp('198.18.0.1'), true, '198.18.x.x 是 fake-IP');
  assert.equal(isFakeIp('198.19.255.254'), true, '198.19.x.x 也在 198.18.0.0/15 里');
  assert.equal(isFakeIp('198.20.0.1'), false, '198.20 不在这个段里');
  assert.equal(isFakeIp('192.168.0.13'), false, '正常的家里网段');
  assert.equal(isFakeIp('10.0.0.5'), false);
});

test('/api/network 每次现算，不缓存（刷新地址按钮靠它）', async () => {
  const first = await fetch(`${ctx.server.base}/demo/api/network`, { headers: { 'x-anki-token': 'demo-token-0123456789' } });
  const second = await fetch(`${ctx.server.base}/demo/api/network`, { headers: { 'x-anki-token': 'demo-token-0123456789' } });
  assert.equal(first.status, 200);
  const a = await first.json();
  const b = await second.json();
  assert.deepEqual(a.addresses, b.addresses);
  assert.ok(a.addresses.every(ip => !ip.startsWith('127.') && !ip.startsWith('169.254.') && !isFakeIp(ip)));
  assert.equal(a.httpPort, ctx.server.port);
  assert.equal(a.mount, '/demo/');
  const raw = JSON.stringify(a);
  assert.ok(!raw.includes('demo-token-0123456789'), '/api/network 绝不能带口令');
});
