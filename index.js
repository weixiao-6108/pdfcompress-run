'use strict'
/*
 * CloudBase Run 压缩服务（v15）
 * 三档独立算法：
 *   light  = gs -dPDFSETTINGS=/ebook 整本重新编码（保留文字矢量，体积轻微下降，文字最清晰）
 *   medium = 整页 150DPI 栅格化 → JPEG q80（文字变为图片、略软，体积中等下降）
 *   heavy  = 整页 90DPI  栅格化 → JPEG q55（文字明显变软，体积大幅下降）
 *
 * 架构：本服务只做"后台 worker"——轮询云数据库 compress_jobs 里 status='pending' 的任务，
 * 取走后压缩，把结果上传云存储并写回 status='done' / 'error'。
 * 小程序不直接调用本服务，而是：上传文件 → 调 pdfCompressJob 云函数建任务 → 轮询 pdfCompressStatus。
 * 因此压缩耗时再长也不会触发 504003（没有任何同步调用在等它跑完）。
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const PDFDocument = require('pdf-lib').PDFDocument

// 云开发 Node 管理端 SDK（tcb-admin-node）。存储用顶层方法 app.uploadFile/downloadFile，
// 不依赖 app.storage() 命名空间，避免容器内 storage 方法缺失的问题。
// 在 CloudBase Run 容器内通过 TCB_ENV 自动获取同环境身份，无需额外密钥。
const tcb = require('tcb-admin-node')
const app = tcb.init({ env: process.env.TCB_ENV || process.env.TCB_ENV_ID })
const db = app.database()

const COLLECTION = 'compress_jobs'
const TMP = '/tmp'
const POLL_INTERVAL_MS = 2000
const MAX_JOB_AGE_MS = 30 * 60 * 1000 // 30 分钟未处理视为过期
const STALE_JOB_MS = 10 * 60 * 1000 // 任务卡在 processing 超过 10 分钟才视为失败重试（避免容器重启误重置）

// 三档预设（栅格化档位使用）
const RASTER_PRESETS = {
  medium: { dpi: 150, jpegQ: 80 },
  heavy: { dpi: 90, jpegQ: 55 }
}

// ---------- 工具 ----------
function log(...a) { console.log('[pdfCompressRun]', ...a) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function runGs(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('gs', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    p.stderr.on('data', d => { stderr += d.toString() })
    p.on('error', reject)
    p.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error('gs exited ' + code + ': ' + stderr.slice(0, 800)))
    })
  })
}

async function updateJob(jobId, patch) {
  try {
    const res = await db.collection(COLLECTION).doc(jobId).update({ data: patch })
    return res
  } catch (e) {
    log('updateJob FAILED', jobId, e.message)
    return null
  }
}

// 兼容不同 SDK 返回结构：{ updated } 或 { stats: { updated } }
function extractUpdated(r) {
  if (!r) return 0
  if (typeof r.updated === 'number') return r.updated
  if (r.stats && typeof r.stats.updated === 'number') return r.stats.updated
  return 1 // 形状未知，默认当成功，避免误判
}

// ---------- 算法 1：轻度（保留文字矢量，整本重新编码）----------
async function compressLight(inputPath, outputPath) {
  await runGs([
    '-q', '-dNOPAUSE', '-dBATCH',
    '-sDEVICE=pdfwrite',
    '-dPDFSETTINGS=/ebook',     // 150DPI、图片降质，但文字保持矢量
    '-dDetectDuplicateImages=true',
    '-sOutputFile=' + outputPath,
    inputPath
  ])
  return fs.readFileSync(outputPath)
}

// ---------- 算法 2/3：中度/重度（整页栅格化）----------
async function compressRaster(inputPath, outputPath, { dpi, jpegQ }) {
  // 1) 用 pdf-lib 读出每页尺寸（point），用于重建时 1:1 还原版面
  const inBuf = fs.readFileSync(inputPath)
  const src = await PDFDocument.load(inBuf)
  const n = src.getPageCount()
  const pageSizes = []
  for (let i = 0; i < n; i++) {
    const { width, height } = src.getPage(i).getSize()
    pageSizes.push({ width, height })
  }

  // 2) ghostscript 把每页渲染成 JPEG
  const prefix = path.join(TMP, 'r_' + process.pid + '_')
  const outPattern = prefix + '%03d.jpg'
  await runGs([
    '-q', '-dNOPAUSE', '-dBATCH',
    '-sDEVICE=jpeg',
    '-dJPEGQ=' + jpegQ,
    '-r' + dpi,
    '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', // 抗锯齿，文字更平滑
    '-sOutputFile=' + outPattern,
    inputPath
  ])

  // 3) 用 pdf-lib 把每页 JPEG 重新拼回 PDF（每页一张整页图）
  const out = await PDFDocument.create()
  for (let i = 0; i < n; i++) {
    const jpgPath = prefix + String(i + 1).padStart(3, '0') + '.jpg'
    const imgBytes = fs.readFileSync(jpgPath)
    const img = await out.embedJpeg(imgBytes)
    const { width, height } = pageSizes[i]
    const page = out.addPage([width, height])
    page.drawImage(img, { x: 0, y: 0, width, height })
    fs.unlinkSync(jpgPath) // 及时清理，避免大文件撑爆磁盘
  }
  const buf = await out.save()
  fs.writeFileSync(outputPath, buf)
  return buf
}

// ---------- 任务处理 ----------
async function processJob(job) {
  const jobId = job._id
  const level = job.level
  const inPath = path.join(TMP, 'in_' + jobId + '.pdf')
  const outPath = path.join(TMP, 'out_' + jobId + '.pdf')
  let outBuf = null
  try {
    // 下载输入
    const dl = await app.downloadFile({ fileID: job.fileID })
    const inBuf = dl.fileContent
    fs.writeFileSync(inPath, inBuf)

    if (level === 'light') {
      outBuf = await compressLight(inPath, outPath)
    } else {
      const preset = RASTER_PRESETS[level] || RASTER_PRESETS.medium
      outBuf = await compressRaster(inPath, outPath, preset)
    }

    // 上传结果
    const up = await app.uploadFile({
      cloudPath: 'compress/out_' + jobId + '.pdf',
      fileContent: Buffer.from(outBuf)
    })

    const now = Date.now()
    const donePatch = {
      status: 'done',
      outputFileID: up.fileID,
      originalSize: inBuf.length,
      compressedSize: outBuf.length,
      ratio: outBuf.length / inBuf.length,
      finishedAt: now
    }
    const r = await updateJob(jobId, donePatch)
    if (extractUpdated(r) > 0) {
      log('done', jobId, level, inBuf.length, '->', outBuf.length)
    } else {
      // update 未生效（updated:0），退而用 set 整篇覆盖，确保状态落库
      log('done-update-0, retry via set', jobId, JSON.stringify(r))
      try {
        await db.collection(COLLECTION).doc(jobId).set({
          data: {
            level: job.level,
            fileID: job.fileID,
            createdAt: job.createdAt || now,
            status: 'done',
            outputFileID: up.fileID,
            originalSize: inBuf.length,
            compressedSize: outBuf.length,
            ratio: outBuf.length / inBuf.length,
            finishedAt: now
          }
        })
        log('done(via-set)', jobId, level, inBuf.length, '->', outBuf.length)
      } catch (se) {
        log('DONE-WRITE-FAILED', jobId, se.message)
      }
    }
  } catch (e) {
    log('error', jobId, e.message)
    const r = await updateJob(jobId, { status: 'error', error: String(e.message || e), finishedAt: Date.now() })
    if (!r) log('ERROR-WRITE-FAILED', jobId, e.message)
  } finally {
    // 清理临时文件，避免大文件撑爆磁盘
    try { if (fs.existsSync(inPath)) fs.unlinkSync(inPath) } catch (_) {}
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath) } catch (_) {}
    try {
      const dir = fs.readdirSync(TMP)
      for (const f of dir) {
        if (f.startsWith('r_' + process.pid + '_')) {
          try { fs.unlinkSync(path.join(TMP, f)) } catch (_) {}
        }
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
      // 原子认领：pending -> processing，记录认领时间与尝试次数
      const claim = await updateJob(job._id, { status: 'processing', startedAt: now, attempts: (job.attempts || 0) + 1 })
      if (extractUpdated(claim) > 0) {
        // 认领成功，处理该任务（处理中若容器重启，10 分钟内不会被重复认领）
        await processJob(job)
      } else {
        // update 未生效，用 set 兜底认领
        log('claim-update-0, retry via set', job._id, JSON.stringify(claim))
        try {
          await db.collection(COLLECTION).doc(job._id).set({
            data: {
              level: job.level,
              fileID: job.fileID,
              createdAt: job.createdAt || now,
              status: 'processing',
              startedAt: now,
              attempts: (job.attempts || 0) + 1
            }
          })
          await processJob(job)
        } catch (se) {
          log('CLAIM-WRITE-FAILED', job._id, se.message)
        }
      }
    }
  } catch (e) {
    log('poll error', e.message)
  }
}

async function loop() {
  // 启动时只重置「卡死」的旧任务：processing 且认领时间超过阈值，
  // 避免容器频繁重启时把刚认领的任务又置回 pending 导致重复压缩
  try {
    const staleBefore = Date.now() - STALE_JOB_MS
    const r = await db.collection(COLLECTION)
      .where({ status: 'processing', startedAt: db.command.lt(staleBefore) })
      .update({ data: { status: 'pending' } })
    log('reset stale processing jobs', extractUpdated(r))
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
    res.end('pdfCompressRun ok')
  } else {
    res.writeHead(404)
    res.end('not found')
  }
})
server.listen(PORT, () => {
  log('listening on', PORT)
  loop() // 启动后台 worker
})


