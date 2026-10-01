// 把 code.js 包装成 /eval 请求体 body.json（避免 shell 转义/编码问题）
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const endpoint = process.argv[2] || '/eval';
const code = fs.readFileSync(path.join(dir, 'code.js'), 'utf8');
fs.writeFileSync(path.join(dir, 'body.json'), JSON.stringify({ code }));
console.log('body.json written for', endpoint);
