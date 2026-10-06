/**
 * build-standalone.js —— 生成 standalone.html（单文件版）
 *
 *   node test/build-standalone.js
 *
 * 这**不是**插件运行所需的构建步骤：airscan-qr 是零依赖、扁平文件的插件，
 * 直接把整个目录丢给 uTools 就能跑。这个脚本只是把 vendor/ + core/ +
 * sender.js + receiver.js + index.css 内联进一个 HTML，产出一个能拷进
 * 物理隔离机器、双击就能用的自包含文件。
 *
 * 生成物里内联的都是**原样字节**，没有做任何改写（只把 </script 转义掉）。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DEFAULT_OUT = path.join(ROOT, 'standalone.html')

const INLINE_JS = [
  'vendor/qrcode-generator.js',
  'vendor/jsQR.js',
  'core/protocol.js',
  'core/fountain.js',
  'core/qr.js',
  'core/scan.js',
  'core/codecs.js',
  'sender.js',
  'receiver.js'
]

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/**
 * 内联进 <script> 时需要转义的两处：
 *   · `</script` 会提前结束脚本块
 *   · `<script` 会让「按 <script> 切块」的校验看到半截块（core/qr.js 的注释里就有一个）
 * 两者都只可能出现在注释或字符串里，替换成 `<\/script` / `<\script` 在 JS 语义上等价。
 */
function escapeForScript(code) {
  return code.replace(/<(\/?)script/gi, '<\\$1script')
}

function escapeForStyle(code) {
  return code.replace(/<(\/?)style/gi, '<\\$1style')
}

function build(outPath) {
const css = escapeForStyle(read('index.css'))
const scripts = INLINE_JS.map(
  (rel) => `<!-- ${rel} -->\n<script>\n${escapeForScript(read(rel))}\n</script>`
).join('\n')

const GLUE = escapeForScript(read('test/standalone-glue.js'))

const html = `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!--
      AirScan 隔空传输 · 单文件版（airscan-qr 的招牌特性）

      这个文件是生成物，把收发两端 + QR 编解码全部内联在一个 HTML 里：
      拷到物理隔离的机器上，双击用浏览器打开就能用，不需要任何依赖、服务器或构建。

      重新生成：node test/build-standalone.js
      内联来源：vendor/qrcode-generator.js, vendor/jsQR.js, core/*.js,
               sender.js, receiver.js, index.css, test/standalone-glue.js
      内联内容为源码原样字节，只把注释/字符串里出现的 <script 与 </script 各加一个
      反斜杠（转义），以免提前截断 HTML —— 在 JS 语义上完全等价。

      浏览器建议：Chrome / Edge。file:// 下摄像头在 Chrome 里可用；
      若被拒绝，用「选择图片」导入帧图片这条降级路径一样能收完。
    -->
    <title>AirScan 隔空传输 · 单文件版</title>
    <style>
${css}
    </style>
  </head>
  <body class="standalone-body">
    <header class="hero">
      <div class="hero__meta">
        <h1 class="hero__title">AirScan 隔空传输 · 单文件版</h1>
        <p class="hero__sub" id="sa-sub">
          收发两端都在这个文件里 · 零依赖 · 拷过去双击就能用
        </p>
      </div>
      <span class="badge" id="sa-origin">file://</span>
    </header>

    <nav class="tabs">
      <button class="tab is-active" id="tab-send" type="button">发送</button>
      <button class="tab" id="tab-receive" type="button">接收</button>
      <button class="btn btn--ghost" id="sa-open-receiver" type="button">在新窗口打开接收端</button>
    </nav>

    <!-- ============================== 发送 ============================== -->
    <section class="pane" id="pane-send">
      <div class="standalone-grid">
        <div class="cards">
          <section class="card">
            <header class="card__head"><h2 class="card__title">要发送什么</h2></header>
            <div class="card__body">
              <div class="actions">
                <button class="btn btn--primary" id="s-pick" type="button">选择文件</button>
                <button class="btn" id="s-use-text" type="button">改用文本</button>
                <input type="file" id="s-file" hidden />
              </div>
              <div id="s-textbox" hidden>
                <label class="field">
                  <span class="field__label">文本（按 UTF-8 编码传输）</span>
                  <textarea id="s-text" rows="3"></textarea>
                </label>
                <label class="field">
                  <span class="field__label">接收端文件名</span>
                  <input type="text" id="s-name" value="message.txt" />
                </label>
              </div>
              <dl class="kv" id="s-info"></dl>
            </div>
          </section>

          <section class="card">
            <header class="card__head"><h2 class="card__title">参数</h2></header>
            <div class="card__body">
              <label class="field">
                <span class="field__label">编码模式</span>
                <select id="s-mode"></select>
              </label>
              <p class="hint" id="s-blurb"></p>
              <div class="grid2">
                <label class="field">
                  <span class="field__label">分片大小</span>
                  <select id="s-symbol"></select>
                </label>
                <label class="field">
                  <span class="field__label">帧率</span>
                  <select id="s-fps"></select>
                </label>
              </div>
              <label class="field">
                <span class="field__label">智能补发比例 <b id="s-repair-value">0%</b></span>
                <input type="range" id="s-repair" min="0" max="50" step="5" value="0" />
              </label>
              <p class="hint" id="s-repair-hint"></p>
            </div>
          </section>

          <section class="card">
            <header class="card__head"><h2 class="card__title">传输计划</h2></header>
            <div class="card__body"><dl class="kv" id="s-plan"></dl></div>
          </section>
        </div>

        <div class="stage-wrap">
          <div class="stage stage--inline"><canvas id="s-code"></canvas></div>
          <div class="actions">
            <button class="btn btn--primary" id="s-start" type="button">开始播放</button>
            <button class="btn" id="s-stop" type="button" disabled>停止</button>
            <button class="btn btn--ghost" id="s-full" type="button">全屏</button>
          </div>
          <dl class="kv">
            <dt>当前帧</dt><dd id="s-hud-frame">—</dd>
            <dt>已播</dt><dd id="s-hud-shown">0</dd>
            <dt>QR</dt><dd><span id="s-hud-version">—</span> · <span id="s-hud-modules">—</span></dd>
            <dt>补发</dt><dd id="s-hud-repair">—</dd>
            <dt>缺口反馈</dt><dd id="s-hud-gap">未检测到（按统计加权）</dd>
          </dl>
        </div>
      </div>
    </section>

    <!-- ============================== 接收 ============================== -->
    <section class="pane" id="pane-receive" hidden>
      <div class="standalone-grid">
        <div class="stage-wrap">
          <div class="rc-stage">
            <video id="r-camera" playsinline muted></video>
            <canvas id="r-work" class="hidden-canvas"></canvas>
            <div class="rc-stage__hud"><span class="pill" id="r-mode">等待描述符帧…</span></div>
          </div>
          <div class="actions">
            <button class="btn btn--primary" id="r-start" type="button">打开摄像头</button>
            <button class="btn" id="r-stop" type="button" disabled>停止</button>
            <button class="btn" id="r-pick" type="button">选择帧图片</button>
            <input type="file" id="r-input" accept="image/*" multiple hidden />
          </div>
          <p class="hint" id="r-note">
            没有摄像头也能用：让发送端保持播放，把每一帧拍下来或截屏，然后用「选择帧图片」一次性导入。
          </p>
        </div>

        <div class="cards">
          <section class="card">
            <header class="card__head"><h2 class="card__title">进度</h2></header>
            <div class="card__body">
              <div class="rc-bar"><div class="rc-bar__fill" id="r-bar"></div></div>
              <dl class="kv">
                <dt>解码后端</dt><dd id="r-backend">解码后端：js（等待描述符）</dd>
                <dt>进度</dt><dd id="r-progress">0%</dd>
                <dt>已收 / 需要</dt><dd><span id="r-received">0</span> / <span id="r-needed">0</span></dd>
                <dt>有效帧率</dt><dd id="r-rate">0.0 帧/秒</dd>
              </dl>
              <p class="status" id="r-status">未开始</p>
            </div>
          </section>

          <section class="card" id="r-result-card" hidden>
            <header class="card__head"><h2 class="card__title">接收完成</h2></header>
            <div class="card__body">
              <dl class="kv">
                <dt>文件名</dt><dd id="r-result-name">—</dd>
                <dt>大小</dt><dd id="r-result-size">—</dd>
              </dl>
              <textarea id="r-result-text" rows="6" hidden></textarea>
              <div class="actions" id="r-actions"></div>
            </div>
          </section>
        </div>
      </div>
    </section>

${scripts}
<!-- test/standalone-glue.js -->
<script>
${GLUE}
</script>
  </body>
</html>
`

  const target = outPath || DEFAULT_OUT
  fs.writeFileSync(target, html)
  return { html: html, bytes: Buffer.byteLength(html) }
}

module.exports = { build: build, INLINE_JS: INLINE_JS, DEFAULT_OUT: DEFAULT_OUT }

if (require.main === module) {
  const result = build(process.argv[2])
  console.log(
    'standalone.html 已生成：' +
      (result.bytes / 1024).toFixed(1) +
      ' KB（内联 ' +
      INLINE_JS.length +
      ' 个 js + index.css）'
  )
}
