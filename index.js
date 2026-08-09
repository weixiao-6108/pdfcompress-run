'use strict'
/*
 * CloudBase Run PDF 处理服务（v19，质量修复版）
 * 支持三种操作（job.op）：
 *   compress = 压缩（三档：light / medium / heavy）
 *   toimage  = 转图片（PDF 每页渲染成 PNG，逐页上传云存储，返回图片 fileID 列表）
 *   pages    = 增减页面
 *       mode 'keep'   删页/提取：job.pageList 如 "1-3,5,7"（保留这些页，其余删除）
 *       mode 'append' 加页/合并：把 job.fileID2 整本追加到末尾
 *       mode 'insert' 加页/插入：把 job.fileID2 插入到第 job.at 页之后
 *
 * 架构：本服务只做后台 worker——轮询云数据库 compress_jobs 里 status='pending' 的任务，
 * 取走后处理，把结果上传云存储并写回 status='done' / 'error'。
 * 小程序不直接调用本服务，而是：上传文件 → 调 pdfCompressJob 云函数建任务 → 轮询 pdfCompressStatus。
 *
 * 写库一律用 .set()（已验证 tcb-admin-node 的 .update() 在本环境返回假成功、不落库）。
 * 认领任务时整篇 set 为 processing，后续轮询 where(status='pending') 查不到，从根本杜绝重复处理。
 *
 * 压缩算法（v19.3，修复容器 qpdf 版本过低导致 --jpeg-quality 报错）：
 *   light  : qpdf 结构优化 + 仅重编码内嵌图片（--jpeg-quality 旋钮，默认 82≈10~15%），文字层原样保留，绝不乱码。
 *   medium : pdftoppm 整页栅格化 150DPI / JPEG quality 80，文字变软但不会有字体乱码，旋转由 pdftoppm 自动处理。
 *   heavy  : pdftoppm 整页栅格化 90DPI  / JPEG quality 60，体积最小。
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const PDFDocument = require('pdf-lib').PDFDocument

// 云开发 Node 管理端 SDK。必须显式传管理员密钥，否则在云托管里不是管理员身份，写库会被安全规则拒绝。
const tcb = require('tcb-admin-node')
const app = tcb.init({
  env: process.env.TCB_ENV || process.env.TCB_ENV_ID,
  secretId: process.env.TENCENTCLOUD_SECRETID,
  secretKey: process.env.TENCENTCLOUD_SECRETKEY
})
const db = app.database()

const COLLECTION = 'compress_jobs'
const TMP = '/tmp'
const POLL_INTERVAL_MS = 2000
const MAX_JOB_AGE_MS = 6 * 60 * 60 * 1000 // 6 小时内未处理视为过期（500MB 大文件允许更久）
const STALE_JOB_MS = 15 * 60 * 1000   // 任务卡在 processing 超过 15 分钟才视为失败重试

// 中/重度栅格化预设（pdftoppm 比 gs 的 jpeg 设备更稳定，自动处理页面旋转）
const RASTER_PRESETS = {
  medium: { dpi: 150, quality: 80 },
  heavy:  { dpi: 90,  quality: 60 }
}

// ---------- 工具 ----------
function log(...a) { console.log('[pdfRun]', ...a) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function runCmd(cmd, args) {
  // Windows 下 spawn 不会自动为无扩展名命令查找 .cmd/.bat（仅 Linux 生产无需），
  // 这里对 Windows + 无扩展名命令启用 shell，让 cmd.exe 通过 PATHEXT 解析（本地质检用，生产零影响）
  const opts = { stdio: ['ignore', 'pipe', 'pipe'] }
  if (process.platform === 'win32' && !/\.[a-z0-9]{1,4}$/i.test(cmd)) {
    opts.shell = true
  }
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts)
    let stderr = ''
    p.stderr.on('data', d => { stderr += d.toString() })
    p.on('error', reject)
    p.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(cmd + ' exited ' + code + ': ' + stderr.slice(0, 1000)))
    })
  })
}

function runGs(args) {
  // 多核并行渲染，提升压缩速度（容器单核时自动退化为串行，无副作用）
  const gsArgs = ['-dNumRenderingThreads=4', '-dNOOUTERSAVE', ...args]
  // 同 runCmd：Windows 下对无扩展名命令启用 shell，让 cmd.exe 经 PATHEXT 解析 .cmd（本地质检用，生产零影响）
  const opts = { stdio: ['ignore', 'pipe', 'pipe'] }
  if (process.platform === 'win32' && !/\.[a-z0-9]{1,4}$/i.test('gs')) {
    opts.shell = true
  }
  return new Promise((resolve, reject) => {
    const p = spawn('gs', gsArgs, opts)
    let stderr = ''
    p.stderr.on('data', d => { stderr += d.toString() })
    p.on('error', reject)
    p.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error('gs exited ' + code + ': ' + stderr.slice(0, 1000)))
    })
  })
}

function tmpFile(jobId, suffix) { return path.join(TMP, suffix + '_' + jobId + '.pdf') }

// ---------- 压缩算法 ----------
// light：轻度。沿用 v19 安全的 qpdf 结构优化（线性化、对象流、流压缩），
// 额外只【重新编码内嵌的图片】（--optimize-images + --jpeg-quality），完全不碰文字/矢量层，
// 因此绝不可能出现乱码，且降幅可用下面这一个旋钮精确控制。
//   ★ 唯一旋钮：--jpeg-quality （100=几乎不压，越小压得越狠）
//   对图多型 PDF，82≈10~15%、75≈20~30%、65≈30%+。文字层原样保留，永远不乱码。
async function compressLight(inputPath, outputPath) {
  await runCmd('qpdf', [
    '--linearize',
    '--object-streams=generate',
    '--compress-streams=y',
    '--recompress-flate',
    '--optimize-images',
    '--jpeg-quality=' + (process.env.LIGHT_JPEG_Q || 82),
    inputPath,
    outputPath
  ])
  return fs.readFileSync(outputPath)
}

// medium / heavy：整页栅格化，pdftoppm 输出 JPEG，再用 pdf-lib 拼回 PDF。
// 优点：完全规避 Ghostscript 重写字体导致的乱码；pdftoppm 自动处理页面旋转。
// 不载入源 PDF 到 pdf-lib（500MB 大文件避免吃内存），直接统计 pdftoppm 生成结果。
async function compressRaster(inputPath, outputPath, { dpi, quality }) {
  const prefix = path.join(TMP, 'r_' + process.pid + '_')
  await runCmd('pdftoppm', [
    '-jpeg',
    '-r', String(dpi),
    '-jpegopt', 'quality=' + quality,
    inputPath,
    prefix
  ])

  // pdftoppm 生成文件：多页为 prefix-1.jpg, prefix-2.jpg ...；单页为 prefix.jpg（无页码）。
  // 按页号数值排序（避免 10 排在 2 前面）
  const re = /-(\d+)\.jpg$/
  const raw = fs.readdirSync(TMP)
    .filter(f => f.startsWith('r_' + process.pid + '_') && f.endsWith('.jpg'))
  if (raw.length === 0) throw new Error('pdftoppm 未生成任何页面')

  let files
  if (raw.length === 1 && !re.test(raw[0])) {
    // 单页 PDF：文件名无页码，直接当作第 1 页
    files = [{ name: raw[0], page: 1 }]
  } else {
    files = raw
      .filter(f => re.test(f))
      .map(f => ({ name: f, page: parseInt(f.match(re)[1], 10) }))
      .sort((a, b) => a.page - b.page)
    if (files.length === 0) throw new Error('pdftoppm 未生成任何页面')
  }

  const out = await PDFDocument.create()
  const scale = dpi / 72 // 像素 -> PDF points 的换算系数
  for (const f of files) {
    const jpgPath = path.join(TMP, f.name)
    const imgBytes = fs.readFileSync(jpgPath)
    const img = await out.embedJpg(imgBytes)
    // 用图片像素尺寸换算回原始物理页面大小（points），保证打印/实际尺寸正确，且自动适配横竖版与旋转
    const pageW = img.width / scale
    const pageH = img.height / scale
    const page = out.addPage([pageW, pageH])
    page.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH })
    try { fs.unlinkSync(jpgPath) } catch (_) {}
  }

  const buf = await out.save()
  fs.writeFileSync(outputPath, buf)
  return buf
}

// ---------- 页面操作 ----------
// 按页列表提取/删除（用 gs -sPageList，流式处理，内存友好）
async function gsPageSelect(inputPath, outputPath, pageList) {
  await runGs([
    '-q', '-dNOPAUSE', '-dBATCH',
    '-sDEVICE=pdfwrite',
    '-dPDFSETTINGS=/default',
    '-sPageList=' + pageList,
    '-sOutputFile=' + outputPath,
    inputPath
  ])
  return fs.readFileSync(outputPath)
}
// 合并多个 PDF（顺序拼接）
async function gsMerge(outputPath, inputPaths) {
  await runGs([
    '-q', '-dNOPAUSE', '-dBATCH',
    '-sDEVICE=pdfwrite',
    '-dPDFSETTINGS=/default',
    '-sOutputFile=' + outputPath,
    ...inputPaths
  ])
  return fs.readFileSync(outputPath)
}

// ---------- 任务处理 ----------
async function processJob(job) {
  const jobId = job._id
  const op = job.op || 'compress'
  const now = Date.now()
  const inPath = tmpFile(jobId, 'in')
  const outPath = tmpFile(jobId, 'out')
  const base = {
    op, level: job.level, fileID: job.fileID,
    createdAt: job.createdAt || now,
    status: 'done', finishedAt: now
  }
  try {
    // 1) 下载主输入文件
    const dl = await app.downloadFile({ fileID: job.fileID })
    fs.writeFileSync(inPath, dl.fileContent)
    const inSize = dl.fileContent.length
    let result = {}

    if (op === 'compress') {
      const level = job.level || 'medium'
      let outBuf
      if (level === 'light') {
        outBuf = await compressLight(inPath, outPath)
      } else {
        const preset = RASTER_PRESETS[level] || RASTER_PRESETS.medium
        outBuf = await compressRaster(inPath, outPath, preset)
      }
      if (!outBuf || outBuf.length === 0) throw new Error('压缩结果为空')
      const up = await app.uploadFile({ cloudPath: 'compress/out_' + jobId + '.pdf', fileContent: Buffer.from(outBuf) })
      result = { outputFileID: up.fileID, originalSize: inSize, compressedSize: outBuf.length, ratio: outBuf.length / inSize }

    } else if (op === 'toimage') {
      const dpi = job.dpi || 150
      const dir = path.join(TMP, 'img_' + jobId)
      fs.mkdirSync(dir, { recursive: true })
      const pattern = path.join(dir, 'page-%05d.png')
      await runGs([
        '-q', '-dNOPAUSE', '-dBATCH',
        '-sDEVICE=png16m',
        '-r' + dpi,
        '-sOutputFile=' + pattern,
        inPath
      ])
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort()
      const ids = []
      for (const f of files) {
        const b = fs.readFileSync(path.join(dir, f))
        const up = await app.uploadFile({ cloudPath: 'compress/img_' + jobId + '_' + f, fileContent: b })
        ids.push(up.fileID)
        try { fs.unlinkSync(path.join(dir, f)) } catch (_) {}
      }
      try { fs.rmdirSync(dir) } catch (_) {}
      result = { outputImages: ids, imageCount: ids.length }

    } else if (op === 'pages') {
      const mode = job.mode || 'keep'
      let buf
      if (mode === 'keep') {
        if (!job.pageList) throw new Error('pages.keep 需要 pageList 参数')
        buf = await gsPageSelect(inPath, outPath, String(job.pageList))
      } else if (mode === 'append') {
        if (!job.fileID2) throw new Error('pages.append 需要 fileID2 参数')
        const dl2 = await app.downloadFile({ fileID: job.fileID2 })
        const in2 = tmpFile(jobId, 'in2')
        fs.writeFileSync(in2, dl2.fileContent)
        buf = await gsMerge(outPath, [inPath, in2])
      } else if (mode === 'insert') {
        if (!job.fileID2) throw new Error('pages.insert 需要 fileID2 参数')
        const at = parseInt(job.at, 10)
        if (!at || at < 1) throw new Error('pages.insert 需要有效的 at 参数')
        const dl2 = await app.downloadFile({ fileID: job.fileID2 })
        const in2 = tmpFile(jobId, 'in2')
        fs.writeFileSync(in2, dl2.fileContent)
        // 用开放区间 at+1- 表示「从 at+1 到末尾」，避免统计总页数（大文件统计页数会吃内存）
        const a1 = tmpFile(jobId, 'a1')
        const a2 = tmpFile(jobId, 'a2')
        await gsPageSelect(inPath, a1, '1-' + at)
        await gsPageSelect(inPath, a2, (at + 1) + '-')
        buf = await gsMerge(outPath, [a1, in2, a2])
      } else {
        throw new Error('未知的 pages.mode: ' + mode)
      }
      const up = await app.uploadFile({ cloudPath: 'compress/out_' + jobId + '.pdf', fileContent: Buffer.from(buf) })
      result = { outputFileID: up.fileID, originalSize: inSize, compressedSize: buf.length, ratio: buf.length / inSize }
    } else {
      throw new Error('未知操作 op: ' + op)
    }

    const finalData = Object.assign({}, base, result)
    try {
      await db.collection(COLLECTION).doc(jobId).set(finalData)
      const summary = result.compressedSize ? `${inSize} -> ${result.compressedSize}` : (result.imageCount ? `${result.imageCount} images` : 'ok')
      log('done', jobId, op, summary)
    } catch (se) {
      log('DONE-WRITE-FAILED', jobId, se.message)
    }
  } catch (e) {
    log('error', jobId, e.message)
    try {
      const now2 = Date.now()
      await db.collection(COLLECTION).doc(jobId).set({
        op, level: job.level, fileID: job.fileID,
        createdAt: job.createdAt || now2,
        status: 'error', error: String(e.message || e), finishedAt: now2
      })
    } catch (se) {
      log('ERROR-WRITE-FAILED', jobId, se.message)
    }
  } finally {
    // 清理临时文件，避免大文件撑爆磁盘
    for (const s of ['in', 'out', 'in2', 'a1', 'a2']) {
      try { const p = tmpFile(jobId, s); if (fs.existsSync(p)) fs.unlinkSync(p) } catch (_) {}
    }
    try {
      const dir = fs.readdirSync(TMP)
      for (const f of dir) {
        if (f.startsWith('r_' + process.pid + '_')) { try { fs.unlinkSync(path.join(TMP, f)) } catch (_) {} }
      }
    } catch (_) {}
  }
}

// ---------- 后台轮询 worker ----------
async function pollOnce() {
  try {
    const now = Date.now()
    const res = await db.collection(COLLECTION)
      .where({ status: 'pending', createdAt: db.command.gt(now - MAX_JOB_AGE_MS) })
      .limit(1)
      .get()
    const jobs = (res && res.data) || []
    for (const job of jobs) {
      // 整篇 set 认领为 processing，杜绝重复处理
      try {
        await db.collection(COLLECTION).doc(job._id).set({
          op: job.op || 'compress',
          level: job.level,
          fileID: job.fileID,
          fileID2: job.fileID2,
          mode: job.mode,
          pageList: job.pageList,
          at: job.at,
          dpi: job.dpi,
          createdAt: job.createdAt || now,
          status: 'processing',
          startedAt: now,
          attempts: (job.attempts || 0) + 1
        })
        await processJob(job)
      } catch (se) {
        log('CLAIM-WRITE-FAILED', job._id, se.message)
      }
    }
  } catch (e) {
    log('poll error', e.message)
  }
}

async function loop() {
  // 启动时只重置「卡死」的旧任务
  try {
    const staleBefore = Date.now() - STALE_JOB_MS
    const staleRes = await db.collection(COLLECTION)
      .where({ status: 'processing', startedAt: db.command.lt(staleBefore) })
      .limit(50)
      .get()
    const staleJobs = (staleRes && staleRes.data) || []
    let resetCount = 0
    for (const s of staleJobs) {
      const resetData = Object.assign({}, s, { status: 'pending', startedAt: null, attempts: (s.attempts || 0) + 1 })
      delete resetData._id
      await db.collection(COLLECTION).doc(s._id).set(resetData)
      resetCount++
    }
    log('reset stale processing jobs', resetCount)
  } catch (_) {}
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pollOnce()
    await sleep(POLL_INTERVAL_MS)
  }
}

// ---------- HTTP 服务（CloudBase Run 健康探针）----------
const PORT = process.env.PORT || 8080
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('pdfRun ok')
  } else {
    res.writeHead(404)
    res.end('not found')
  }
})

// ---------- 启动自检：确认工具版本 & 关键参数可用 ----------
async function checkTools() {
  try {
    const ver = await new Promise((resolve, reject) => {
      const p = spawn('qpdf', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      p.stdout.on('data', d => { out += d.toString() })
      p.on('error', reject)
      p.on('close', code => { if (code === 0) resolve(out.trim().split('\n')[0]); else reject(new Error('exit ' + code)) })
    })
    log('TOOL-CHECK qpdf:', ver)
  } catch (e) {
    log('TOOL-CHECK qpdf: FAILED ->', e.message)
  }

  // 校验当前 qpdf 是否认识 --jpeg-quality（Bookworm 自带的 11.3 会报错 unrecognized）
  try {
    const checkFile = path.join(TMP, 'qpdf_jpeg_quality_check_' + process.pid + '.pdf')
    await runCmd('qpdf', ['--jpeg-quality=82', '--empty', checkFile])
    const ok = fs.existsSync(checkFile) && fs.statSync(checkFile).size > 0
    try { fs.unlinkSync(checkFile) } catch (_) {}
    if (ok) log('TOOL-CHECK qpdf --jpeg-quality: supported')
    else log('TOOL-CHECK qpdf --jpeg-quality: UNKNOWN RESULT')
  } catch (e) {
    log('TOOL-CHECK qpdf --jpeg-quality: NOT SUPPORTED ->', e.message)
  }
}

// ---------- 启动自检：确认能以管理员身份写入数据库，且结构正确 ----------
async function selfCheck() {
  try {
    const testId = 'selftest_' + Date.now()
    const ts = Date.now()
    await db.collection(COLLECTION).doc(testId).set({ _test: true, _ts: ts })
    const r = await db.collection(COLLECTION).doc(testId).get()
    // tcb-admin-node 的 .doc(id).get() 返回 r.data 为数组，单文档在 r.data[0]
    const doc = (r && Array.isArray(r.data)) ? r.data[0] : (r && r.data)
    const ok = doc && doc._test === true && doc._ts === ts
    await db.collection(COLLECTION).doc(testId).remove()
    if (ok) log('SELF-CHECK: db WRITE ok (structure correct)')
    else log('SELF-CHECK: db WRITE STRUCTURE WRONG ->', JSON.stringify(r && r.data).slice(0, 200))
  } catch (e) {
    log('SELF-CHECK: db WRITE FAILED ->', e.message)
  }
}

// 导出压缩函数，供本地/Docker 质检脚本 require；在云托管运行时下面 require.main === module 分支会启动服务
module.exports = { compressLight, compressRaster, runCmd, runGs }

if (require.main === module) {
  server.listen(PORT, () => {
    log('listening on', PORT)
    checkTools()
    selfCheck()
    loop() // 启动后台 worker
  })
}
