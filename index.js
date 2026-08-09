'use strict'
/*
 * CloudBase Run PDF 处理服务（v18，多功能 + 加速 + 中文字体嵌入）
 * 支持三种操作（job.op）：
 *   compress = 压缩（三档：light / medium / heavy）
 *   toimage  = 转图片（PDF 每页渲染成 PNG）
 *   pages    = 增减页面（keep 删页 / append 合并 / insert 插入）
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const PDFDocument = require('pdf-lib').PDFDocument

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
const MAX_JOB_AGE_MS = 60 * 60 * 1000
const STALE_JOB_MS = 15 * 60 * 1000

const RASTER_PRESETS = { heavy: { dpi: 110, jpegQ: 60 } }

function log(...a) { console.log('[pdfRun]', ...a) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function runGs(args) {
  // 多核并行渲染，提升压缩速度（容器单核时自动退化为串行，无副作用）
  const gsArgs = ['-dNumRenderingThreads=4', '-dNOOUTERSAVE', ...args]
  return new Promise((resolve, reject) => {
    const p = spawn('gs', gsArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
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
// light：轻度，图片降到 200DPI，文字矢量保留并强制嵌入中文字体，体积轻微下降、中文不乱码
async function compressLight(inputPath, outputPath) {
  await runGs([
    '-q', '-dNOPAUSE', '-dBATCH',
    '-sDEVICE=pdfwrite',
    '-dPDFSETTINGS=/default',
    '-dColorImageDownsampleType=/Bicubic',
    '-dColorImageResolution=200',
    '-dGrayImageDownsampleType=/Bicubic',
    '-dGrayImageResolution=200',
    '-dMonoImageResolution=300',
    '-dDownsampleColorImages=true',
    '-dDownsampleGrayImages=true',
    '-dEmbedAllFonts=true',
    '-dSubsetFonts=true',
    '-dDetectDuplicateImages=true',
    '-sOutputFile=' + outputPath,
    inputPath
  ])
  return fs.readFileSync(outputPath)
}
// medium：中度，/ebook（图片降到 150DPI），文字仍矢量，强制嵌入字体避免中文乱码
async function compressMedium(inputPath, outputPath) {
  await runGs([
    '-q', '-dNOPAUSE', '-dBATCH',
    '-sDEVICE=pdfwrite',
    '-dPDFSETTINGS=/ebook',
    '-dEmbedAllFonts=true',
    '-dSubsetFonts=true',
    '-dDetectDuplicateImages=true',
    '-sOutputFile=' + outputPath,
    inputPath
  ])
  return fs.readFileSync(outputPath)
}
// heavy：重度，整页栅格化 → JPEG，体积大幅下降，但文字变为图片、不再可选中
async function compressRaster(inputPath, outputPath, { dpi, jpegQ }) {
  const inBuf = fs.readFileSync(inputPath)
  const src = await PDFDocument.load(inBuf)
  const n = src.getPageCount()
  const pageSizes = []
  for (let i = 0; i < n; i++) {
    const { width, height } = src.getPage(i).getSize()
    pageSizes.push({ width, height })
  }
  const prefix = path.join(TMP, 'r_' + process.pid + '_')
  const outPattern = prefix + '%03d.jpg'
  await runGs([
    '-q', '-dNOPAUSE', '-dBATCH',
    '-sDEVICE=jpeg',
    '-dJPEGQ=' + jpegQ,
    '-r' + dpi,
    '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
    '-sOutputFile=' + outPattern,
    inputPath
  ])
  const out = await PDFDocument.create()
  for (let i = 0; i < n; i++) {
    const jpgPath = prefix + String(i + 1).padStart(3, '0') + '.jpg'
    const imgBytes = fs.readFileSync(jpgPath)
    const img = await out.embedJpg(imgBytes)
    const { width, height } = pageSizes[i]
    const page = out.addPage([width, height])
    page.drawImage(img, { x: 0, y: 0, width, height })
    try { fs.unlinkSync(jpgPath) } catch (_) {}
  }
  const buf = await out.save()
  fs.writeFileSync(outputPath, buf)
  return buf
}

// ---------- 页面操作 ----------
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
async function getPageCount(inputPath) {
  const buf = fs.readFileSync(inputPath)
  const pdf = await PDFDocument.load(buf)
  return pdf.getPageCount()
}

// ---------- 任务处理 ----------
async function processJob(job) {
  const jobId = job._id
  const op = job.op || 'compress'
  const now = Date.now()
  const inPath = tmpFile(jobId, 'in')
  const outPath = tmpFile(jobId / 1)
  const base = {
    op, level: job.level, fileID: job.fileID,
    createdAt: job.createdAt || now,
    status: 'done', finishedAt: now
  }
  try {
    const dl = await app.downloadFile({ fileID: job.fileID })
    fs.writeFileSync(inPath, dl.fileContent)
    const inSize = dl.fileContent.length
    let result = {}

    if (op === 'compress') {
      const level = job.level || 'medium'
      let outBuf
      if (level === 'light') outBuf = await compressLight(inPath, outPath)
      else if (level === 'heavy') outBuf = await compressRaster(inPath, outPath, RASTER_PRESETS.heavy)
      else outBuf = await compressMedium(inPath, outPath)
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
        const total = await getPageCount(inPath)
        const a1 = tmpFile(jobId, 'a1')
        const a2 = tmpFile(jobId, 'a2')
        await gsPageSelect(inPath, a1, '1-' + at)
        await gsPageSelect(inPath, a2, (at + 1) + '-' + total)
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

async function selfCheck() {
  try {
    const testId = 'selftest_' + Date.now()
    const ts = Date.now()
    await db.collection(COLLECTION).doc(testId).set({ _test: true, _ts: ts })
    const r = await db.collection(COLLECTION).doc(testId).get()
    const doc = (r && Array.isArray(r.data)) ? r.data[0] : (r && r.data)
    const ok = doc && doc._test === true && doc._ts === ts
    await db.collection(COLLECTION).doc(testId).remove()
    if (ok) log('SELF-CHECK: db WRITE ok (structure correct)')
    else log('SELF-CHECK: db WRITE STRUCTURE WRONG ->', JSON.stringify(r && r.data).slice(0, 200))
  } catch (e) {
    log('SELF-CHECK: db WRITE FAILED ->', e.message)
  }
}

server.listen(PORT, () => {
  log('listening on', PORT)
  selfCheck()
  loop()
})
