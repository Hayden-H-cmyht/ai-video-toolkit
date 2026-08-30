/* avit 网页版 — 双引擎
 * 本地 (127.0.0.1/localhost): 走 webserver.py 的 API, 调用真实 ffmpeg + faster-whisper
 * 线上 (GitHub Pages 等):     浏览器引擎 — ffmpeg.wasm (转码/高光/增强) + transformers.js Whisper (字幕)
 */
const IS_LOCAL = ["127.0.0.1", "localhost"].includes(location.hostname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UserCancelled extends Error {
  constructor() { super("已终止"); }
}

/* ---------------- 工具 ---------------- */
function fmtSrt(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60,
        s = Math.floor(ms / 1000) % 60, x = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(x).padStart(3, "0")}`;
}
function fmtClock(sec) {
  sec = Math.floor(Math.max(0, sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function fmtName(sec) {
  sec = Math.floor(Math.max(0, sec));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}m${String(sec % 60).padStart(2, "0")}s`;
}
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + "B";
  if (n < 1048576) return (n / 1024).toFixed(1) + "KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + "MB";
  return (n / 1073741824).toFixed(2) + "GB";
}
function baseName(name) { return name.replace(/\.[^.]+$/, ""); }
function downloadBlob(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}
async function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res;
    s.onerror = () => rej(new Error("CDN 加载失败: " + src));
    document.head.appendChild(s);
  });
}
async function toBlobURL(url, type) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`CDN 加载失败 (${r.status}): ${url}`);
  return URL.createObjectURL(new Blob([await r.blob()], { type }));
}
function probeDims(file) {
  return new Promise((res, rej) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      const d = { w: v.videoWidth, h: v.videoHeight, dur: v.duration };
      URL.revokeObjectURL(v.src);
      res(d);
    };
    v.onerror = () => { URL.revokeObjectURL(v.src); res({ w: 0, h: 0, dur: 0 }); };
    v.src = URL.createObjectURL(file);
  });
}

/* ---------------- 本地引擎 ---------------- */
const LocalEngine = {
  label: "本地引擎",
  async init() {
    const r = await fetch("/api/health");
    const h = await r.json();
    this.health = h;
    return h;
  },
  async browse(path) {
    const r = await fetch("/api/browse?path=" + encodeURIComponent(path || ""));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    return d;
  },
  async run(feature, input, opts, cb) {
    const r = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feature, input, options: opts }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "启动失败");
    this.jobId = d.id;
    cb.phase?.("运行中");
    while (true) {
      await sleep(900);
      if (this.cancelled) { fetch("/api/jobs/" + d.id, { method: "DELETE" }); throw new UserCancelled(); }
      const jr = await fetch("/api/jobs/" + d.id);
      const j = await jr.json();
      if (!jr.ok) throw new Error(j.error || "查询任务失败");
      cb.log?.(j.lines, true);
      if (j.status === "done") return j.results;
      if (j.status === "error") throw new Error(j.error || "任务失败");
    }
  },
  async cancel() { this.cancelled = true; },
  download(r) { location.href = "/api/file?path=" + encodeURIComponent(r.path); },
  async openFolder(r) {
    const p = r.path.replace(/[\\/][^\\/]+$/, "");
    await fetch("/api/open?path=" + encodeURIComponent(p));
  },
  cleanup() { this.cancelled = false; this.jobId = null; },
};

/* ---------------- 浏览器引擎 ---------------- */
const BrowserEngine = {
  label: "浏览器引擎",
  _ff: null, _T: null, _asr: {}, _cancelled: false, _progressCb: null, _jobN: 0,

  async init() { return { engine: "web" }; },

  async _ffmpeg(cb) {
    if (this._ff) return this._ff;
    cb.log?.("[浏览器] 加载 ffmpeg.wasm（首次约 30MB，来自 jsDelivr CDN）…");
    await loadScript("https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js");
    const { FFmpeg } = window.FFmpegWASM;
    const ff = new FFmpeg();
    ff.on("progress", ({ progress }) => {
      if (this._progressCb) this._progressCb(Math.max(0, Math.min(1, progress || 0)));
    });
    const CORE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd";
    const coreURL = await toBlobURL(`${CORE}/ffmpeg-core.js`, "text/javascript");
    const wasmURL = await toBlobURL(`${CORE}/ffmpeg-core.wasm`, "application/wasm");
    await ff.load({ coreURL, wasmURL });
    this._ff = ff;
    cb.log?.("[浏览器] ffmpeg.wasm 就绪");
    return ff;
  },

  _dropFF() { try { this._ff?.terminate(); } catch (e) {} this._ff = null; },
  cancel() { this._cancelled = true; this._dropFF(); },

  async _transformers() {
    if (!this._T) {
      this._T = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3");
    }
    return this._T;
  },

  async _getASR(size, cb) {
    if (this._asr[size]) return this._asr[size];
    const T = await this._transformers();
    T.env.allowLocalModels = false;
    T.env.remoteHost = "https://hf-mirror.com";
    const model = `Xenova/whisper-${size}`;
    const prog = (p) => {
      if (p.status === "progress" && p.total)
        cb.log?.(`模型下载 ${p.file} ${Math.round(p.progress || 0)}%`);
    };
    let pipe = null;
    if (navigator.gpu) {
      try {
        cb.log?.(`[浏览器] 加载 Whisper ${size}（WebGPU）…`);
        pipe = await T.pipeline("automatic-speech-recognition", model,
          { device: "webgpu", dtype: "fp32", progress_callback: prog });
      } catch (e) { cb.log?.(`WebGPU 不可用(${String(e).slice(0, 80)})，回退 WASM…`); }
    }
    if (!pipe) {
      cb.log?.(`[浏览器] 加载 Whisper ${size}（WASM，首次下载模型，走 hf-mirror）…`);
      pipe = await T.pipeline("automatic-speech-recognition", model,
        { device: "wasm", dtype: "q8", progress_callback: prog });
    }
    this._asr[size] = pipe;
    return pipe;
  },

  async _writeIn(ff, file) {
    const ext = (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase() || ".bin";
    const name = `in${++this._jobN}${ext}`;
    await ff.writeFile(name, new Uint8Array(await file.arrayBuffer()));
    return name;
  },
  async _extractPCM(ff, inName, cb) {
    cb.phase?.("提取音频");
    cb.log?.("[浏览器] 提取音频 16kHz…");
    await this._exec(ff, ["-i", inName, "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "pcm_s16le", "-f", "s16le", "audio.raw"], cb);
    const raw = await ff.readFile("audio.raw");
    let u8 = raw;
    if (u8.byteOffset % 2 !== 0) u8 = new Uint8Array(u8); // 对齐
    const i16 = new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1);
    return i16;
  },
  async _exec(ff, args, cb) {
    if (this._cancelled) throw new UserCancelled();
    try {
      const rc = await ff.exec(args);
      if (rc !== 0) throw new Error(`ffmpeg 退出码 ${rc}`);
    } catch (e) {
      if (this._cancelled) throw new UserCancelled();
      throw e;
    }
  },
  _progress(cb) {
    this._progressCb = (p) => cb.progress?.(p);
  },

  /* ---- 字幕 ---- */
  async subs(file, opts, cb) {
    const ff = await this._ffmpeg(cb);
    this._progress(cb);
    const inName = await this._writeIn(ff, file);
    const i16 = await this._extractPCM(ff, inName, cb);
    const dur = i16.length / 16000;
    cb.log?.(`音频时长 ${fmtClock(dur)}，开始识别`);
    const asr = await this._getASR(opts.model, cb);
    cb.phase?.("识别中（不可中断）");
    cb.log?.("[浏览器] 识别中，30s 分块…");
    const t0 = performance.now();
    const out = await asr(i16ToFloat(i16), {
      return_timestamps: true, chunk_length_s: 30, stride_length_s: 5,
      language: opts.lang || undefined, task: "transcribe",
    });
    cb.log?.(`识别完成，用时 ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    const srt = chunksToSrt(out.chunks || [], dur);
    const base = baseName(file.name);
    await ff.deleteFile(inName).catch(() => {});
    await ff.deleteFile("audio.raw").catch(() => {});
    return [
      { name: base + ".srt", blob: new Blob([srt], { type: "text/plain" }), size: srt.length },
      { name: base + ".txt", blob: new Blob([out.text || ""], { type: "text/plain" }), size: (out.text || "").length },
    ];
  },

  /* ---- 转格式 ---- */
  async convert(file, opts, cb) {
    const ff = await this._ffmpeg(cb);
    this._progress(cb);
    const inName = await this._writeIn(ff, file);
    const dim = await probeDims(file);
    const hasV = dim.w > 0;
    const n = ++this._jobN;
    cb.phase?.("转码");
    let outName, type = "video/mp4";
    const p = opts.preset;
    if (p === "mp3") {
      outName = `out${n}.mp3`; type = "audio/mpeg";
      await this._exec(ff, hasV
        ? ["-i", inName, "-vn", "-c:a", "libmp3lame", "-q:a", "2", outName]
        : ["-i", inName, "-c:a", "libmp3lame", "-q:a", "2", outName], cb);
    } else if (p === "remux") {
      outName = `out${n}.mp4`;
      await this._exec(ff, ["-i", inName, "-c", "copy", "-movflags", "+faststart", "-sn", outName], cb);
    } else if (p === "gif") {
      if (!hasV) throw new Error("没有视频轨，无法转 GIF");
      outName = `out${n}.gif`; type = "image/gif";
      await this._exec(ff, ["-i", inName, "-vf",
        "fps=12,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5",
        "-loop", "0", "-t", String(opts.gif_sec || 10), outName], cb);
    } else if (p === "small") {
      outName = `out${n}.mp4`;
      let A;
      if (hasV) {
        A = dim.h > 720 ? ["-vf", "scale=-2:720"] : [];
        A.push("-c:v", "libx264", "-crf", "28", "-preset", "medium",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart",
               "-c:a", "aac", "-b:a", "96k", "-sn", outName);
      } else {
        A = ["-vn", "-c:a", "aac", "-b:a", "96k", outName];
      }
      await this._exec(ff, ["-i", inName, ...A], cb);
    } else { // mp4
      outName = `out${n}.mp4`;
      await this._exec(ff, hasV
        ? ["-i", inName, "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p",
           "-movflags", "+faststart", "-c:a", "aac", "-b:a", "160k", "-sn", outName]
        : ["-i", inName, "-vn", "-c:a", "aac", "-b:a", "160k", outName], cb);
    }
    const data = await ff.readFile(outName);
    const blob = new Blob([data], { type });
    await ff.deleteFile(inName).catch(() => {});
    await ff.deleteFile(outName).catch(() => {});
    const ext = p === "mp3" ? ".mp3" : p === "gif" ? ".gif" : ".mp4";
    return [{ name: baseName(file.name) + ext, blob, size: blob.size }];
  },

  /* ---- 高光 ---- */
  async highlight(file, opts, cb) {
    const ff = await this._ffmpeg(cb);
    this._progress(cb);
    const inName = await this._writeIn(ff, file);
    const dim = await probeDims(file);
    const hasV = dim.w > 0;
    const i16 = await this._extractPCM(ff, inName, cb);
    cb.phase?.("分析能量");
    cb.log?.("[浏览器] 分析音频能量…");
    const segs = pickHighlights(i16, 16000, opts, cb);
    cb.log?.(`命中 ${segs.length} 段: ` +
      segs.map(([s, e]) => `${fmtClock(s)}-${fmtClock(e)}`).join(", "));
    const n0 = ++this._jobN;
    const clips = [];
    for (let i = 0; i < segs.length; i++) {
      const [s, e] = segs[i];
      const d = Math.max(e - s, 0.2);
      const fo = Math.max(d - 0.2, 0);
      cb.phase?.(`剪切 ${i + 1}/${segs.length}`);
      const outName = `clip${n0}_${i + 1}.${hasV ? "mp4" : "m4a"}`;
      const A = ["-ss", s.toFixed(2), "-i", inName, "-t", d.toFixed(2)];
      if (hasV) A.push("-vf", `fade=t=in:d=0.15,fade=t=out:st=${fo.toFixed(2)}:d=0.2`);
      A.push("-af", `afade=t=in:d=0.15,afade=t=out:st=${fo.toFixed(2)}:d=0.2`);
      if (hasV) A.push("-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p");
      A.push("-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-sn", outName);
      await this._exec(ff, A, cb);
      const data = await ff.readFile(outName);
      const name = `${baseName(file.name)}_high${String(i + 1).padStart(2, "0")}_${fmtName(s)}-${fmtName(e)}.${hasV ? "mp4" : "m4a"}`;
      clips.push({ name, data, type: hasV ? "video/mp4" : "audio/mp4" });
      cb.log?.(`  片段 ${i + 1}: ${fmtClock(s)}-${fmtClock(e)} (${(e - s).toFixed(1)}s)`);
    }
    const results = clips.map((c) => ({ name: c.name, blob: new Blob([c.data], { type: c.type }), size: c.data.byteLength }));
    if (clips.length > 1 && !opts.no_reel) {
      cb.phase?.("拼接合集");
      await ff.writeFile("list.txt", clips.map((c) => `file '${c.name}'`).join("\n"));
      const reelName = `reel${n0}.mp4`;
      await this._exec(ff, ["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", reelName], cb);
      const data = await ff.readFile(reelName);
      results.push({ name: `${baseName(file.name)}_highlights.mp4`, blob: new Blob([data], { type: "video/mp4" }), size: data.byteLength });
    }
    await ff.deleteFile(inName).catch(() => {});
    return results;
  },

  /* ---- 增强 ---- */
  async upscale(file, opts, cb) {
    if (opts.ai) throw new Error("AI 超分仅桌面版支持（需要 Real-ESRGAN + 显卡）");
    const ff = await this._ffmpeg(cb);
    this._progress(cb);
    const inName = await this._writeIn(ff, file);
    const dim = await probeDims(file);
    if (!dim.w) throw new Error("只支持视频文件");
    const [w, h] = targetSize(dim, opts.to);
    cb.phase?.("增强");
    cb.log?.(`[浏览器] ${dim.w}x${dim.h} -> ${w}x${h} (lanczos+降噪+锐化)…`);
    const n = ++this._jobN;
    const outName = `out${n}.mp4`;
    await this._exec(ff, ["-i", inName, "-vf",
      `hqdn3d=1.5:1.2:6:6,scale=${w}:${h}:flags=lanczos,unsharp=5:5:0.8:3:3:0.4`,
      "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-sn", outName], cb);
    const data = await ff.readFile(outName);
    const blob = new Blob([data], { type: "video/mp4" });
    await ff.deleteFile(inName).catch(() => {});
    await ff.deleteFile(outName).catch(() => {});
    return [{ name: `${baseName(file.name)}_enh.mp4`, blob, size: blob.size }];
  },
};

function i16ToFloat(i16) {
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
  return f;
}
function chunksToSrt(chunks, totalDur) {
  let n = 0;
  const out = [];
  for (const ch of chunks) {
    const text = (ch.text || "").trim();
    if (!text) continue;
    let [s, e] = ch.timestamp || [0, 0];
    s = s || 0;
    if (e == null || e <= s) e = Math.min(s + 2, totalDur);
    out.push(`${++n}\n${fmtSrt(s)} --> ${fmtSrt(e)}\n${text.replace(/\n/g, " ")}\n`);
  }
  return out.join("\n") + "\n";
}
function targetSize(dim, to) {
  const { w, h } = dim;
  if (!w || !h) throw new Error("无法读取视频分辨率");
  to = String(to);
  if (to.endsWith("x")) {
    const r = parseFloat(to);
    return [Math.max(2, Math.round(w * r / 2) * 2), Math.max(2, Math.round(h * r / 2) * 2)];
  }
  if (to.endsWith("p")) {
    const th = parseInt(to);
    return [Math.max(2, Math.round(w * th / h / 2) * 2), th];
  }
  throw new Error("目标参数不合法");
}

/* 高光选段算法 (与 avitlib/highlight.py 一致) */
function pickHighlights(i16, sr, opt, cb) {
  const unit = 0.5, win = sr * unit;
  const n = Math.floor(i16.length / win);
  if (n < 8) throw new Error("音频太短（不足 4 秒）");
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * win;
    for (let j = 0; j < win; j++) { const v = i16[o + j]; s += v * v; }
    db[i] = 20 * Math.log10(Math.sqrt(s / win) / 32768 + 1e-9);
  }
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = i - 2; k < i + 2; k++) if (k >= 0 && k < n) { s += db[k]; c++; }
    sm[i] = s / c;
  }
  if (Math.max(...db) < -45) throw new Error("音频几乎无声，无法检测高光");
  const pct = (arr, p) => {
    const a = Array.from(arr).sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
  };
  const thr = pct(sm, (Math.min(99, Math.max(1, opt.percentile || 60))) / 100);
  const meanOf = ([s, e]) => { let m = 0, c = 0; for (let i = Math.floor(s / unit); i < Math.min(n, Math.floor(e / unit)); i++) { m += sm[i]; c++; } return c ? m / c : -1e9; };
  const peakOf = ([s, e]) => { let m = -1e9; for (let i = Math.floor(s / unit); i < Math.min(n, Math.floor(e / unit)); i++) m = Math.max(m, sm[i]); return m; };
  let segs = [], st = null;
  for (let i = 0; i < n; i++) {
    const v = sm[i] >= thr;
    if (v && st === null) st = i;
    if (!v && st !== null) { segs.push([st * unit, i * unit]); st = null; }
  }
  if (st !== null) segs.push([st * unit, n * unit]);
  const merged = [];
  for (const [s, e] of segs) {
    if (merged.length && s - merged[merged.length - 1][1] <= 2)
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    else merged.push([s, e]);
  }
  const final = [];
  for (const [s, e] of merged) {
    if (e - s <= opt.maxDur) { final.push([s, e]); continue; }
    const i0 = Math.floor(s / unit), i1 = Math.floor(e / unit);
    const w = Math.max(1, Math.floor(opt.maxDur / unit));
    let bi = i0, bv = -1e9;
    for (let i = i0; i <= Math.max(i0, i1 - w); i += 2) {
      let m = 0;
      for (let k = i; k < i + w; k++) m += sm[Math.min(k, n - 1)];
      if (m / w > bv) { bv = m / w; bi = i; }
    }
    final.push([bi * unit, Math.min((bi + w) * unit, e)]);
  }
  let kept = final.filter(([s, e]) => e - s >= opt.minDur);
  if (!kept.length) kept = [final.reduce((a, b) => (meanOf(a) >= meanOf(b) ? a : b))];
  kept.sort((a, b) => peakOf(b) - peakOf(a));
  const picked = [];
  for (const x of kept) {
    if (picked.every((p) => x[1] <= p[0] || x[0] >= p[1])) picked.push(x);
    if (picked.length >= (opt.top || 5)) break;
  }
  picked.sort((a, b) => a[0] - b[0]);
  return picked.map(([s, e]) => [Math.max(0, s - 0.25), Math.min(n * unit, e + 0.25)]);
}

/* ---------------- UI ---------------- */
const $ = (id) => document.getElementById(id);
const Engine = IS_LOCAL ? LocalEngine : BrowserEngine;
let currentFeature = "convert";
let busy = false;

function collectOpts(f) {
  if (f === "convert") return { preset: $("cPreset").value, gif_sec: +$("cGifSecN").value, recursive: $("cRecursive").checked };
  if (f === "subs") return { model: $("sModel").value, lang: $("sLang").value, burn: $("sBurn").checked };
  if (f === "highlight") return { top: +$("hTop").value, min_dur: +$("hMin").value, max_dur: +$("hMax").value, percentile: +$("hPct").value, no_reel: $("hNoReel").checked };
  if (f === "upscale") return { to: $("uTo").value, ai: $("uAI").checked, tile: +$("uTile").value };
  return {};
}

function showTab(f) {
  currentFeature = f;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.f === f));
  document.querySelectorAll(".opts").forEach((o) => o.classList.toggle("hidden", o.dataset.f !== f));
  $("cGifSec").classList.toggle("hidden", !(f === "convert" && $("cPreset").value === "gif"));
}

function renderLog(lines, replace) {
  const box = $("logBox");
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  if (replace) box.textContent = lines.slice(-500).join("\n");
  else box.textContent += (box.textContent ? "\n" : "") + lines;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function setProgress(p) {
  const bar = $("progressBar");
  if (p == null) { bar.classList.add("indeterminate"); bar.firstElementChild.style.width = ""; }
  else { bar.classList.remove("indeterminate"); bar.firstElementChild.style.width = `${Math.round(p * 100)}%`; }
}

function renderResults(results) {
  const box = $("results");
  box.innerHTML = "";
  for (const r of results) {
    const card = document.createElement("div");
    card.className = "file-card";
    const name = document.createElement("div");
    name.className = "fname";
    name.textContent = r.name;
    const meta = document.createElement("div");
    meta.className = "fmeta";
    meta.textContent = r.size != null ? fmtSize(r.size) : "";
    const btns = document.createElement("div");
    btns.className = "fbtns";
    const dl = document.createElement("button");
    dl.className = "btn ghost";
    dl.textContent = "下载";
    dl.onclick = () => Engine.download(r);
    btns.appendChild(dl);
    if (IS_LOCAL) {
      const open = document.createElement("button");
      open.className = "btn ghost";
      open.textContent = "打开文件夹";
      open.onclick = () => Engine.openFolder(r);
      btns.appendChild(open);
    }
    card.append(name, meta, btns);
    box.appendChild(card);
  }
}

function setStatus(text, cls) {
  const el = $("jobStatus");
  el.textContent = text;
  el.className = "badge " + (cls || "");
}

async function startJob() {
  if (busy) return;
  let input;
  if (IS_LOCAL) {
    input = $("inputPath").value.trim();
    if (!input) { $("inputPath").focus(); return; }
  } else {
    input = $("inputFile").files[0];
    if (!input) { $("inputFile").focus(); return; }
  }
  const opts = collectOpts(currentFeature);
  busy = true;
  Engine.cleanup?.();
  $("btnRun").disabled = true;
  $("btnCancel").classList.remove("hidden");
  $("jobPanel").classList.remove("hidden");
  $("results").innerHTML = "";
  $("logBox").textContent = "";
  $("jobElapsed").textContent = "";
  setStatus("运行中");
  setProgress(null);
  const t0 = Date.now();
  const timer = setInterval(() => {
    $("jobElapsed").textContent = `${Math.round((Date.now() - t0) / 1000)}s`;
  }, 1000);
  const cb = {
    log: renderLog,
    progress: setProgress,
    phase: (p) => setStatus(p),
  };
  try {
    const results = await Engine.run(currentFeature, input, opts, cb);
    setStatus("完成", "ok");
    setProgress(1);
    renderResults(results);
  } catch (e) {
    if (e instanceof UserCancelled) setStatus("已终止", "warn");
    else { setStatus("失败", "err"); renderLog("[错误] " + (e.message || e)); }
  } finally {
    clearInterval(timer);
    busy = false;
    $("btnRun").disabled = false;
    $("btnCancel").classList.add("hidden");
  }
}

/* 浏览弹窗（仅本地引擎） */
const bmState = { cwd: "" };
async function bmRender(path) {
  try {
    const d = await Engine.browse(path);
    bmState.cwd = d.cwd || "";
    $("bmCwd").textContent = d.cwd || "我的电脑";
    $("bmPath").value = d.cwd || "";
    $("bmUp").classList.toggle("hidden", !d.parent);
    const drives = $("bmDrives");
    drives.innerHTML = "";
    for (const dv of d.drives || []) {
      const b = document.createElement("button");
      b.className = "btn ghost";
      b.textContent = dv;
      b.onclick = () => bmRender(dv + "/");
      drives.appendChild(b);
    }
    const list = $("bmList");
    list.innerHTML = "";
    for (const e of d.entries || []) {
      const it = document.createElement("div");
      it.className = "bm-item " + (e.is_dir ? "dir" : "media");
      const nm = document.createElement("span");
      nm.className = "name";
      nm.textContent = e.name;
      const mt = document.createElement("span");
      mt.className = "meta";
      mt.textContent = e.is_dir ? "文件夹" : fmtSize(e.size);
      it.append(nm, mt);
      it.onclick = () => e.is_dir ? bmRender(e.path) : bmPick(e.path);
      list.appendChild(it);
    }
    if (!(d.entries || []).length) {
      list.innerHTML = '<div class="bm-item"><span class="dim">（空目录或无媒体文件）</span></div>';
    }
  } catch (e) { alert(e.message || e); }
}
function bmPick(path) {
  $("inputPath").value = path;
  $("browseModal").classList.add("hidden");
}

/* 初始化 */
async function init() {
  document.body.classList.add(IS_LOCAL ? "is-local" : "is-web");
  $("localInputRow").classList.toggle("hidden", !IS_LOCAL);
  $("webInputRow").classList.toggle("hidden", IS_LOCAL);
  document.querySelectorAll(".tab").forEach((b) => b.onclick = () => showTab(b.dataset.f));
  $("cPreset").onchange = () => $("cGifSec").classList.toggle("hidden", $("cPreset").value !== "gif");
  $("uAI").onchange = () => $("uTileWrap").classList.toggle("hidden", !$("uAI").checked);
  $("btnRun").onclick = startJob;
  $("btnCancel").onclick = () => Engine.cancel();

  let health = {};
  try { health = await Engine.init(); } catch (e) { /* 忽略 */ }

  if (IS_LOCAL) {
    $("engineBadge").textContent = "本地引擎 · 全速";
    $("engineBadge").className = "badge ok";
    $("browseModal").classList.remove("hidden");
    $("browseModal").classList.add("hidden");
    $("btnBrowse").onclick = () => { $("browseModal").classList.remove("hidden"); bmRender($("inputPath").value.trim()); };
    $("bmClose").onclick = () => $("browseModal").classList.add("hidden");
    $("bmGo").onclick = () => bmRender($("bmPath").value.trim());
    $("bmPath").addEventListener("keydown", (e) => { if (e.key === "Enter") bmRender($("bmPath").value.trim()); });
    $("bmUp").onclick = () => bmRender(bmState.cwd ? bmState.cwd.replace(/[\\/][^\\/]+$/, "") || "/" : "");
    $("bmPickDir").onclick = () => { if (bmState.cwd) bmPick(bmState.cwd); };
    $("onlineLink").href = health.online || "https://hayden-h-cmyht.github.io/ai-video-toolkit/";
    const notes = [];
    if (health && health.ffmpeg === false) notes.push(["err", "未检测到 FFmpeg，请先安装：winget install Gyan.FFmpeg"]);
    if (health && health.whisper === false) notes.push(["warn", "未检测到 faster-whisper，字幕功能请先运行 install.bat"]);
    if (!notes.length) notes.push(["", "本地引擎就绪：真实 FFmpeg + faster-whisper，速度最快，输出写入 avit_out\\ 目录"]);
    const note = $("engineNote");
    note.classList.remove("hidden", "err");
    if (notes[0][0] === "err") note.classList.add("err");
    note.textContent = notes.map(([, t]) => t).join("；");
  } else {
    $("engineBadge").textContent = "浏览器引擎 · 关机可用";
    $("engineBadge").className = "badge ok";
    const note = $("engineNote");
    note.classList.remove("hidden");
    note.textContent = "线上版完全在浏览器内处理（数据不上传，电脑关机也能用）。限制：单个文件建议 ≤200MB；字幕烧录与 AI 超分仅桌面版支持；首次使用需加载 ffmpeg.wasm ≈30MB 与语音模型。大文件/全功能请用桌面版。";
    $("footLinks").innerHTML = "桌面版源码与用法：<a class='ghost-link' href='https://github.com/Hayden-H-cmyht/ai-video-toolkit' target='_blank' rel='noopener'>GitHub</a>";
  }
  showTab("convert");
}

init();
