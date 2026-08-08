'use strict'
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
const MAX_JOB_AGE_MS = 30 * 60 * 1000
const STALE_JOB_MS = 10 * 60 * 1000

const RASTER_PRESETS = {
  medium: { dpi: 150, jpegQ: 80 },
  heavy: { dpi: 90, jpegQ: 55 }
}

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

function extractUpdated(r) {
  if (!r) return 0
  if (typeof r.updated === 'number') return r.updated
  if (r.stats && typeof r.stats.updated === 'number') return r.stats.updated
  return 0
}

async function compressLight(inputPath, outputPath) {
  await runGs([
    '-q', '-dNOPAUSE', '-dBATCH',
    '-sDEVICE=pdfwrite',
    '-dPDFSETTINGS=/ebook',
    '-dDetectDuplicateImages=true',
    '-sOutputFile=' + outputPath,
    inputPath
  ])
  return fs.readFileSync(outputPath)
}

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
    const img = await out.embedJpeg(imgBytes)
    const { width, height } = pageSizes[i]
    const page = out.addPage([width, height])
    page.drawImage(img, { x: 0, y: 0, width, height })
    fs.unlinkSync(jpgPath)
  }
  const buf = await out.save()
  fs.writeFileSync(outputPath, buf)
  return buf
}

async function processJob(job) {
  const jobId = job._id
  const level = job.level
  const inPath = path.join(TMP, 'in_' + jobId + '.pdf')
  const outPath = path.join(TMP, 'out_' + jobId + '.pdf')
  let outBuf = null
  try {
    const dl = await app.downloadFile({ fileID: job.fileID })
    const inBuf = dl.fileContent
    fs.writeFileSync(inPath, inBuf)

    if (level === 'light') {
      outBuf = await compressLight(inPath, outPath)
    } else {
      const preset = RASTER_PRESETS[level] || RASTER_PRESETS.medium
      outBuf = await compressRaster(inPath, outPath, preset)
    }

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

async function pollOnce() {
  try {
    const now = Date.now()
    const res = await db.collection(COLLECTION)
      .where({ status: 'pending', createdAt: db.command.gt(now - MAX_JOB_AGE_MS) })
      .limit(1)
      .get()
    const jobs = (res && res.data) || []
    for (const job of jobs) {
      const claim = await updateJob(job._id, { status: 'processing', startedAt: now, attempts: (job.attempts || 0) + 1 })
      if (extractUpdated(claim) > 0) {
        await processJob(job)
      } else {
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
  try {
    const staleBefore = Date.now() - STALE_JOB_MS
    const r = await db.collection(COLLECTION)
      .where({ status: 'processing', startedAt: db.command.lt(staleBefore) })
      .update({ data: { status: 'pending' } })
    log('reset stale processing jobs', extractUpdated(r))
  } catch (_) {}
  while (true) {
    await pollOnce()
    await sleep(POLL_INTERVAL_MS)
  }
}

async function selfCheck() {
  try {
    const testId = 'selftest_' + Date.now()
    await db.collection(COLLECTION).doc(testId).set({ data: { _test: true, _ts: Date.now() } })
    await db.collection(COLLECTION).doc(testId).remove()
    log('SELF-CHECK: db WRITE ok (admin identity works)')
  } catch (e) {
    log('SELF-CHECK: db WRITE FAILED ->', e.message)
  }
}

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
  selfCheck()
  loop()
})
