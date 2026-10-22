// 回放选择：抓取层重启时，把「停机期间到达、但队列里没有」的通知补录回来。
//
// 为什么单拎成一个模块：这段判断是 P0-1 修复的核心（2026-10-21 审计实测：抓取层停 45 分钟，
// 17:30 有正文的两条通知在 18:01 重启时被水位线当成历史跳过，永远看不到）。窗口、上限、去重、
// 补录标记都是纯算术，能脱开 SQLite 和文件单测 —— 端到端那一层在 test/replay-test.mjs 里
// 用假通知库跑真实抓取层。
//
// 三条硬规矩：
//   1) 只回放「最近 N 分钟」且「最多 M 条」：长时间停机后不能一次糊一屏历史（产品取舍，用户批准）。
//   2) 按 id 幂等：队列里已有的一律跳过；同一秒内两次启动也不会重复。
//   3) 补录条目必须带 backfilled=true：UI 和 API 要能把它和「刚到的实时通知」分开。

// 默认窗口：10 分钟 / 20 条。0 = 关闭（任一项为 0 就完全不回放）。
export const REPLAY_DEFAULTS = { minutes: 10, max: 20 };

// config.json 的 capture 段 -> 规范化后的窗口。非法值夹回并记一句原因，别让一个手滑的
// "replayMinutes":"半小时" 变成「回放全部历史」。
export function normalizeReplayConfig(raw) {
  const out = { ...REPLAY_DEFAULTS, issues: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const clamp = (key, lo, hi, field) => {
    const v = raw[key];
    if (v === undefined || v === null) return;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isFinite(n)) {
      out.issues.push(`${key}=${v} 不是数字，按默认 ${out[field]}`);
      return;
    }
    const i = Math.trunc(n);
    if (i < lo) { out.issues.push(`${key}=${i} 小于下限 ${lo}，按 ${lo}`); out[field] = lo; }
    else if (i > hi) { out.issues.push(`${key}=${i} 超过上限 ${hi}，按 ${hi}`); out[field] = hi; }
    else out[field] = i;
  };
  clamp('replayMinutes', 0, 1440, 'minutes');
  clamp('replayMax', 0, 200, 'max');
  return out;
}

// 从「库里读出来的条目」里挑出该补录的那些。
//   items   抓取层 poll() 的输出（已解析、按时间升序），每条至少要有 id / ms
//   now     本轮启动时刻（毫秒）
//   minutes 回放窗口；max 条数上限；haveIds 队列里已有的 id（Set 或数组）
// 返回带上 backfilled=true 的新数组，仍按时间升序。
export function selectReplay(items, { now, minutes, max, haveIds } = {}) {
  const win = Math.trunc(Number(minutes));
  const cap = Math.trunc(Number(max));
  if (!Number.isFinite(win) || win <= 0 || !Number.isFinite(cap) || cap <= 0) return [];
  const t = Number(now);
  if (!Number.isFinite(t) || t <= 0) return [];
  const since = t - win * 60000;
  const have = haveIds instanceof Set ? haveIds : new Set((haveIds || []).map(String));
  const picked = [];
  for (const it of items || []) {
    if (!it || it.id === undefined || it.id === null) continue;
    const id = String(it.id);
    if (have.has(id)) continue;                 // 幂等：队列里已经有这条
    const ms = Number(it.ms);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (ms < since) continue;                   // 窗口外的历史不回放
    if (ms > t + 60000) continue;               // 未来时间（时钟漂移/坏行）不回放
    have.add(id);
    picked.push({ ...it, backfilled: true });
  }
  // 按时间升序；ms 相同的按 id 数字升序，保证同一份输入每次结果一致（测试可断言）
  picked.sort((a, b) => (Number(a.ms) - Number(b.ms)) || (Number(a.id) - Number(b.id)));
  return picked.slice(-cap);                    // 超出上限保留最新的
}
