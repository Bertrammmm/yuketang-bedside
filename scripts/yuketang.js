// 卧床看课助手 —— 在屏幕上开一个浏览器窗口播放雨课堂视频：
//   视频暂停了自动点播放，播完了自动点"下一节"，
//   "继续观看/我知道了"这类确认弹窗自动点掉，
//   遇到需要作答的弹题则暂停等待，由用户口述选项、通过控制接口代点。
// 注意：脚本绝不快进、绝不倍速 —— 时间轴必须真实走过，用户是真的在看。
const { chromium } = require('playwright-core');
const http = require('http');
const path = require('path');

const PORT = 7862;
const START_URL = process.argv[2] || 'https://www.yuketang.cn/v2/web/index';
const USER_DATA = path.join(__dirname, 'user-data');

const t = () => new Date().toLocaleTimeString('zh-CN');
const log = (...a) => console.log(`[${t()}]`, ...a);

const state = {
  phase: 'starting', // starting | login | ready | watching | popup
  loginOk: false,
  url: '',
  title: '',
  video: null,
  popup: null,
  lastAction: '启动中',
  lastNextAt: 0,
  startedAt: new Date().toISOString(),
};

// ---------- 页面侧：检测（每次重新查找，无跨次引用） ----------
async function inspect() {
  return page.evaluate(() => {
    const vis = (e) => !!(e && (e.offsetParent || e.getClientRects().length));
    const txt = (e) => (e.textContent || '').trim().replace(/\s+/g, ' ');
    const out = { notices: [], question: null, video: null };

    const clickables = [...document.querySelectorAll('button, [role=button], a.btn, .btn')];

    // 1) 单按钮提示层：继续观看 / 继续学习 / 我知道了 …
    const NOTICE = ['继续观看', '继续学习', '我知道了', '知道了'];
    for (const n of NOTICE) {
      if (clickables.some((e) => vis(e) && txt(e) === n)) out.notices.push(n);
    }

    // 2) 弹题：可见"提交/确定"按钮 + 同容器内 >=2 个短选项
    const submits = clickables.filter(
      (e) => vis(e) && /^(提交|提交答案|确定)$/.test(txt(e))
    );
    for (const s of submits) {
      let root = s;
      for (let i = 0; i < 10 && root.parentElement; i++) {
        root = root.parentElement;
        const opts = [
          ...root.querySelectorAll(
            'li, label, [class*="option" i], [class*="choice" i], [class*="answer" i]'
          ),
        ].filter((e) => vis(e) && txt(e) && txt(e).length <= 120 && e !== s);
        if (opts.length >= 2 && opts.length <= 12) {
          out.question = {
            text: txt(root).slice(0, 300),
            options: opts.map((o) => txt(o).slice(0, 100)),
            submitText: txt(s),
          };
          break;
        }
      }
      if (out.question) break;
    }

    // 3) 视频
    const v = document.querySelector('video');
    out.video = v
      ? {
          paused: v.paused,
          ended: v.ended,
          time: Math.round(v.currentTime),
          dur: Math.round(v.duration || 0),
          muted: v.muted,
        }
      : null;

    out.title = document.title;
    return out;
  });
}

// ---------- 页面侧：动作 ----------
function pageSide() {
  // 公共工具在每个函数里各写一份（函数会被序列化进页面，不能引用外部作用域）
}

async function clickNotice(name) {
  return page.evaluate((n) => {
    const vis = (e) => !!(e && (e.offsetParent || e.getClientRects().length));
    const txt = (e) => (e.textContent || '').trim();
    const el = [...document.querySelectorAll('button, [role=button], a.btn, .btn')].find(
      (e) => vis(e) && txt(e) === n
    );
    if (!el) return false;
    el.click();
    return true;
  }, name);
}

async function resumePlay() {
  return page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return false;
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
    return true;
  });
}

async function pausePlay() {
  return page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return false;
    v.pause();
    return true;
  });
}

async function clickNext() {
  return page.evaluate(() => {
    const vis = (e) => !!(e && (e.offsetParent || e.getClientRects().length));
    const txt = (e) => (e.textContent || '').trim().replace(/\s+/g, ' ');

    // 策略1：明确的"下一节"按钮（兜底）
    const RE = /^(下一节|下一个|下一任务|后一节)$/;
    const btn = [...document.querySelectorAll('button, [role=button], a, span, div')].find(
      (e) => vis(e) && e.children.length === 0 && RE.test(txt(e))
    );
    if (btn) {
      btn.click();
      return '按钮:' + txt(btn);
    }

    // 策略2：学习空间目录 .leaf-item —— is-active 的下一个"视频"条目；
    // 遇到 作业/考试 等非视频条目则停下等待用户
    const leaves = [...document.querySelectorAll('.leaf-item')].filter(vis);
    const idx = leaves.findIndex((e) => /(^| )is-active( |$)/.test(e.className + ''));
    if (idx >= 0) {
      const skipped = [];
      for (let j = idx + 1; j < leaves.length; j++) {
        const tagEl = leaves[j].querySelector('.leaf-item-tag');
        const tag = tagEl ? tagEl.textContent.trim() : '';
        const title = txt(leaves[j].querySelector('.leaf-item-title') || leaves[j]).slice(0, 40);
        if (tag === '视频' || (!tag && !/作业|考试|试卷|讨论/.test(title))) {
          if (skipped.length) window.__skippedItems = skipped;
          leaves[j].click();
          return '目录:' + title + (skipped.length ? '（已跳过: ' + skipped.join('、') + '）' : '');
        }
        skipped.push(tag + title);
      }
      return 'NO_MORE:本课目录已到末尾' + (skipped.length ? '（后面只剩: ' + skipped.join('、') + '）' : '');
    }

    // 策略3：通用目录列表（旧版页面兜底）
    const items = [
      ...document.querySelectorAll(
        '[class*="lesson" i] li, [class*="catalog" i] li, [class*="chapter" i] li, [class*="task" i] li'
      ),
    ].filter(vis);
    for (let i = 0; i < items.length; i++) {
      const self = items[i];
      const marked =
        /(active|current|selected|doing|playing)/i.test(self.className + '') ||
        self.getAttribute('aria-current') === 'true';
      if (marked && items[i + 1]) {
        items[i + 1].click();
        return '目录下一项:' + txt(items[i + 1]).slice(0, 40);
      }
    }
    return null;
  });
}

async function answerQuestion(idx) {
  return page.evaluate((idx) => {
    const vis = (e) => !!(e && (e.offsetParent || e.getClientRects().length));
    const txt = (e) => (e.textContent || '').trim().replace(/\s+/g, ' ');
    const clickables = [...document.querySelectorAll('button, [role=button], .btn')];
    const s = clickables.find((e) => vis(e) && /^(提交|提交答案|确定)$/.test(txt(e)));
    if (!s) return { ok: false, err: '没找到提交按钮' };
    let root = s;
    for (let i = 0; i < 10 && root.parentElement; i++) {
      root = root.parentElement;
      const opts = [
        ...root.querySelectorAll(
          'li, label, [class*="option" i], [class*="choice" i], [class*="answer" i]'
        ),
      ].filter((e) => vis(e) && txt(e) && txt(e).length <= 120 && e !== s);
      if (opts.length >= 2 && opts.length <= 12) {
        if (idx < 0 || idx >= opts.length)
          return { ok: false, err: '选项序号越界 0-' + (opts.length - 1) };
        opts[idx].click();
        setTimeout(() => {
          const b = [...document.querySelectorAll('button, [role=button], .btn')].find(
            (e) => vis(e) && /^(提交|提交答案|确定)$/.test(txt(e))
          );
          if (b) b.click();
        }, 700);
        return { ok: true, clicked: txt(opts[idx]).slice(0, 60) };
      }
    }
    return { ok: false, err: '没找到选项容器' };
  }, idx);
}

// ---------- 自动脉航 ----------
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const s = await inspect();
    state.url = page.url();
    state.title = s.title;
    state.video = s.video;

    if (!state.loginOk) {
      const u = state.url, ti = state.title || '';
      const onYuketang = /yuketang\.cn/.test(u);
      const looksLogin = /\/web\/\?next|login/i.test(u) || ti.includes('登录');
      if (onYuketang && !looksLogin) {
        state.loginOk = true;
        log('✔ 检测到已登录');
      }
    }

    if (s.question) {
      state.phase = 'popup';
      if (!state.popup || state.popup.text !== s.question.text) {
        log('⛔ 出现弹题，已暂停等待作答：', s.question.text.slice(0, 80));
      }
      state.popup = s.question;
    } else {
      state.popup = null;
      if (s.notices.length) {
        const n = s.notices[0];
        const ok = await clickNotice(n);
        state.lastAction = (ok ? '已点提示「' : '点提示失败「') + n + '」';
        if (ok) log('ℹ 自动点击提示：', n);
      } else if (s.video && !s.video.ended) {
        state.phase = 'watching';
        if (s.video.paused) {
          await resumePlay();
          state.lastAction = '自动恢复播放';
        } else {
          state.lastAction =
            '播放中 ' + s.video.time + '/' + s.video.dur + 's' + (s.video.muted ? '（静音）' : '');
        }
      } else if (s.video && s.video.ended) {
        state.phase = 'watching';
        if (Date.now() - state.lastNextAt > 8000) {
          state.lastNextAt = Date.now();
          const r = await clickNext();
          state.lastAction = r ? '已点下一节（' + r + '）' : '视频结束但没找到"下一节"，请告知';
          log(r ? '⏭ 自动进入下一节：' + r : '⚠ 未找到下一节按钮');
        }
      } else {
        state.phase = state.loginOk ? 'ready' : 'login';
        state.lastAction = state.loginOk ? '空闲（没有检测到视频）' : '等待登录';
      }
    }
  } catch (e) {
    state.lastAction = 'tick错误: ' + (e.message || e).slice(0, 120);
  }
  busy = false;
}

// ---------- 本地控制接口（仅 127.0.0.1） ----------
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const send = (obj) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj, null, 2));
  };
  try {
    if (u.pathname === '/status' && req.method === 'GET') {
      const s = { ...state };
      if (s.popup) s.popup = { ...s.popup, text: s.popup.text.slice(0, 200) };
      return send(s);
    }
    if (u.pathname === '/courses' && req.method === 'GET') {
      const links = await page.evaluate(() =>
        [...document.querySelectorAll('a')]
          .filter((e) => e.offsetParent && e.textContent.trim())
          .map((e) => ({ text: e.textContent.trim().slice(0, 50), href: e.href }))
          .filter((x) => x.text)
          .slice(0, 60)
      );
      return send({ url: page.url(), links });
    }
    if (u.pathname === '/dump' && req.method === 'GET') {
      const lines = await page.evaluate(() => {
        const out = [];
        const walk = (e, d) => {
          if (out.length > 400 || d > 14) return;
          for (const c of e.children) {
            if (!(c.offsetParent || c.getClientRects().length)) continue;
            const tx = (c.innerText || '').trim().replace(/\s+/g, ' ');
            if (tx && tx.length <= 80 && c.children.length <= 10)
              out.push('  '.repeat(d) + c.tagName + '.' + String(c.className || '').slice(0, 60) + ' | ' + tx.slice(0, 80));
            walk(c, d + 1);
          }
        };
        walk(document.body, 0);
        return out;
      });
      return send({ url: page.url(), lines });
    }
    if (u.pathname === '/goto' && req.method === 'POST') {
      const b = await readBody(req);
      if (!/^https?:\/\//.test(b.url || '')) return send({ ok: false, err: 'bad url' });
      await page.goto(b.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState({ state: 'domcontentloaded' }).catch(() => {});
      return send({ ok: true, url: page.url() });
    }
    if (u.pathname === '/answer' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await answerQuestion(Number(b.index));
      log('✍ 代答选项', b.index, JSON.stringify(r));
      return send(r);
    }
    if (u.pathname === '/next' && req.method === 'POST') {
      const r = await clickNext();
      state.lastNextAt = Date.now();
      return send({ ok: !!r, detail: r });
    }
    if (u.pathname === '/pause' && req.method === 'POST') {
      const r = await pausePlay();
      return send({ ok: r });
    }
    if (u.pathname === '/play' && req.method === 'POST') {
      const r = await resumePlay();
      return send({ ok: r });
    }
    if (u.pathname === '/clicknotice' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await clickNotice(b.name || '继续观看');
      return send({ ok: r });
    }
    if (u.pathname === '/tabs' && req.method === 'GET') {
      const pages = ctx.pages().map((p, i) => ({ i, url: p.url(), closed: p.isClosed() }));
      return send({ pages, activeUrl: page.url() });
    }
    if (u.pathname === '/switch' && req.method === 'POST') {
      const b = await readBody(req);
      const pages = ctx.pages();
      const target = pages[Number(b.index)];
      if (!target || target.isClosed()) return send({ ok: false, err: 'no such tab' });
      page = target;
      return send({ ok: true, url: page.url() });
    }
    if (u.pathname === '/shot' && req.method === 'GET') {
      const p = path.join(__dirname, 'ctl', 'last.png');
      await page.screenshot({ path: p });
      return send({ ok: true, file: p });
    }
    if (u.pathname === '/eval' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.code) return send({ ok: false, err: 'no code' });
      const r = await page.evaluate(b.code);
      return send({ ok: true, result: r === undefined ? null : r });
    }
    if (u.pathname === '/stop' && req.method === 'POST') {
      send({ ok: true });
      ctx.close().catch(() => {});
      setTimeout(() => process.exit(0), 500);
      return;
    }
    send({ err: 'unknown ' + req.method + ' ' + u.pathname });
  } catch (e) {
    send({ err: (e.message || String(e)).slice(0, 300) });
  }
}

// ---------- 启动 ----------
let ctx, page;
(async () => {
  let channel = 'msedge';
  try {
    ctx = await chromium.launchPersistentContext(USER_DATA, {
      channel,
      headless: false,
      viewport: null,
      args: ['--start-maximized', '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN'],
    });
  } catch (e) {
    log('Edge 启动失败，改用 Chrome：', (e.message || '').slice(0, 120));
    channel = 'chrome';
    ctx = await chromium.launchPersistentContext(USER_DATA, {
      channel,
      headless: false,
      viewport: null,
      args: ['--start-maximized', '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN'],
    });
  }
  page = ctx.pages()[0] || (await ctx.newPage());
  page.on('pageerror', (err) => log('[页面脚本错误]', String(err).slice(0, 150)));

  // 新标签页自动成为控制目标（雨课堂点开课时常新开页）
  ctx.on('page', (p) => {
    log('🆕 检测到新标签页:', p.url());
    page = p;
    p.on('pageerror', (err) => log('[页面脚本错误]', String(err).slice(0, 150)));
    p.on('close', () => {
      const rest = ctx.pages().filter((x) => !x.isClosed());
      if (page === p || page.isClosed()) {
        page = rest[rest.length - 1] || page;
        log('标签页关闭，切回:', page.url());
      }
    });
  });

  const server = http.createServer(handle);
  server.listen(PORT, '127.0.0.1', () => {
    log(`助手已启动（浏览器: ${channel}，窗口应该已在你屏幕上打开）`);
    log(`控制接口: http://127.0.0.1:${PORT}/status`);
    log('即将打开:', START_URL);
  });
  server.on('error', (e) => log('控制接口监听失败:', e.message));

  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => {
    log('打开页面失败:', e.message);
  });
  await page.waitForLoadState({ state: 'domcontentloaded' }).catch(() => {});
  log('页面已打开:', page.url(), '|', '如果看到登录二维码，请用手机扫码');

  setInterval(tick, 2000);
  process.on('uncaughtException', (e) => log('未捕获异常:', e.message));
})();
