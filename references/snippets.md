# 实测可用的 eval 代码片段

全部经真实雨课堂页面验证。用法：把片段写进 `ctl/code.js` → `node ctl/wrap.js` → `curl --data-binary @ctl/body.json`。可按页面实际微调类名。

## 1. 列出/点击顶部标签页签（studycontent 页）

```js
(() => {
  const ts = [...document.querySelectorAll('.rain-tabs__nav-item')];
  const i = 1; // 0 学习日志 / 1 学习内容 / 3 公告 …按实际顺序
  ts[i].click();
  return ts.map((e) => e.textContent.trim());
})()
```

## 2. 找到 iframe 的 src（studycontent 内容/习题都在 iframe 里）

```js
(() => [...document.querySelectorAll('iframe')].map((f) => f.src))()
```

拿到 src 后用 `POST /goto {url}` 当顶层页打开，绕开嵌套（助手只认顶层 DOM）。

## 3. 打开第一个未开始的课时（studycontent 目录页，会新开标签页）

```js
(() => {
  const vis = (e) => !!(e && (e.offsetParent || e.getClientRects().length));
  const leaves = [...document.querySelectorAll('.leaf-detail')].filter(vis);
  const target = leaves.find((e) => e.textContent.includes('未开始'));
  if (!target) return { ok: false, total: leaves.length };
  (target.querySelector('.leaf-title') || target).click();
  return { ok: true, clicked: target.textContent.trim().replace(/\s+/g, ' ').slice(0, 60) };
})()
```

## 4. 按标题点视频页左侧目录的课时（同标签页内跳转）

```js
(() => {
  const vis = (e) => !!(e && (e.offsetParent || e.getClientRects().length));
  const KEY = '1.2.2'; // 换成目标课时标题的关键字
  const target = [...document.querySelectorAll('.leaf-item')]
    .filter(vis)
    .find((e) => {
      const t = e.querySelector('.leaf-item-title');
      return t && t.textContent.includes(KEY);
    });
  if (!target) return { ok: false };
  target.click();
  return { ok: true, clicked: target.textContent.trim().slice(0, 50) };
})()
```

## 5. 提取习题文本（会乱码——雨课堂字形混淆，仅供探测结构）

```js
(() => {
  const f = document.querySelector('iframe');
  const d = f && f.contentDocument;
  if (!d || !d.body) return { ok: false };
  const txt = (d.body.innerText || '').replace(/\n{3,}/g, '\n\n');
  return { ok: true, len: txt.length, text: txt.slice(0, 3000) };
})()
```

> 中文出现"看似汉字实为乱码"即为混淆生效，改用 `GET /shot` 截图视觉读题；选项按序号点击（`POST /answer {index}` 或在习题页内按选项元素序号 click）。

## 6. 列出课程链接（找课程入口时）

```js
(() =>
  [...document.querySelectorAll('a')]
    .filter((e) => e.offsetParent && e.textContent.trim())
    .map((e) => ({ text: e.textContent.trim().slice(0, 50), href: e.href }))
    .slice(0, 60))()
```

## 7. 在当前页新开一个标签页（如恢复视频页）

```js
(() => { window.open('<目标URL>', '_blank'); return 'opened'; })()
```

助手会自动跟随新标签页（ctx 'page' 事件）；若不想让它抢焦点，开后用 `/switch` 切回。
