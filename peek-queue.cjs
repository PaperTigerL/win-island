// 只读：看队列里真实应用有没有带 launch（决定「点开」走协议跳转还是走 AUMID 激活）
const fs = require('fs');
const path = require('path');
const p = path.join(process.env.LOCALAPPDATA, 'win-island', 'queue.jsonl');
const rows = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(s => JSON.parse(s));
console.log('队列条数 ' + rows.length);
for (const r of rows) {
  console.log(
    [
      (r.at || '').padEnd(10),
      String(r.app).padEnd(14),
      'launch=' + JSON.stringify(r.launch || ''),
      'act=' + (r.activation || '-'),
      'appId=' + String(r.appId || '').slice(0, 56),
    ].join(' | ')
  );
}
