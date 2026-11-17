/**
 * Rule model. A rule version is a declarative, deterministic parameter set.
 * Every check is a comparison on observable fields; nothing is inferred by a
 * model. Each check yields an explainable contribution row.
 */

export const DEFAULT_RULES = {
  version_label: 'v1 基线',
  description: '按点击间隔、转化延迟、UA 指纹与会话行为过滤流量质量。',
  lookback_days: 7,
  hard_checks: {
    session_before_click_window_minutes: 120,
    click_delay: {
      enabled: true,
      min_ms: 40,
      max_ms: 15 * 60 * 1000,
      treat_faster_than_min_as: 'invalid',
    },
    conversion_delay: {
      enabled: true,
      max_hours: 72,
      orphan_click_policy: 'invalid',
    },
    duplicate_order: { enabled: true },
    bot_ua: { enabled: true, tokens: ['headlesschrome', 'phantomjs', 'bot', 'crawler', 'spider'] },
    datacenter_ip: { enabled: false, prefixes: [] },
    device_flag: { enabled: true },
    order_reversed: { enabled: true },
    viewability: { enabled: true, require_impression: true, invalid_if_not_viewable: true },
  },
  soft_checks: {
    high_velocity: { enabled: true, events_per_minute: 30 },
    regular_interval: { enabled: true, cv_threshold: 0.05, min_events: 10 },
    cross_day_session: { enabled: true },
  },
  settlement: {
    include_suspect: false,
    currency: 'CNY',
    payout_per_valid_click_cents: 85,
    payout_per_valid_conversion_ratio: 0.08,
  },
  cross_day: {
    // attribution-day: attribute every event to the local day of its own occurrence.
    // session-day: attribute every event to the local day the session began.
    attribution: 'attribution-day',
    // A session that spans midnight is always reported as a contribution so the
    // reader can see it. It only escalates the verdict to suspect when this is on.
    escalate_to_suspect: false,
  },
};

export function cloneRules(rules) {
  return JSON.parse(JSON.stringify(rules));
}

export function normalizeRules(input) {
  const rules = cloneRules(DEFAULT_RULES);
  deepMerge(rules, input || {});
  validateRules(rules);
  return rules;
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], value);
    } else if (value !== undefined) {
      target[key] = Array.isArray(value) ? [...value] : value;
    }
  }
}

export function validateRules(rules) {
  const problems = [];
  const h = rules.hard_checks || {};
  const s = rules.soft_checks || {};
  if (!rules.version_label || String(rules.version_label).trim() === '') problems.push('版本必须有名称');
  if (!['attribution-day', 'session-day'].includes(rules.cross_day?.attribution)) {
    problems.push('cross_day.attribution 必须是 attribution-day 或 session-day');
  }
  if (typeof rules.cross_day?.escalate_to_suspect !== 'boolean') {
    problems.push('cross_day.escalate_to_suspect 必须是布尔值');
  }
  if (h.click_delay?.enabled) {
    if (!(h.click_delay.min_ms >= 0)) problems.push('click_delay.min_ms 必须 >= 0');
    if (!(h.click_delay.max_ms > h.click_delay.min_ms)) problems.push('click_delay.max_ms 必须大于 min_ms');
    if (!['invalid', 'suspect'].includes(h.click_delay.treat_faster_than_min_as)) {
      problems.push('treat_faster_than_min_as 必须是 invalid 或 suspect');
    }
  }
  if (h.conversion_delay?.enabled) {
    if (!(h.conversion_delay.max_hours > 0)) problems.push('conversion_delay.max_hours 必须 > 0');
    if (!['invalid', 'suspect'].includes(h.conversion_delay.orphan_click_policy)) {
      problems.push('orphan_click_policy 必须是 invalid 或 suspect');
    }
  }
  if (h.bot_ua?.enabled) {
    if (!Array.isArray(h.bot_ua.tokens) || h.bot_ua.tokens.length === 0) problems.push('bot_ua.tokens 不能为空');
    for (const t of h.bot_ua.tokens || []) {
      if (typeof t !== 'string' || !/^[a-z0-9 ._\-]+$/i.test(t)) problems.push(`UA 特征不合法: ${t}`);
    }
  }
  if (h.datacenter_ip?.enabled) {
    for (const p of h.datacenter_ip.prefixes || []) {
      if (!/^\d{1,3}(\.\d{1,3}){0,3}$/.test(p)) problems.push(`IP 前缀不合法: ${p}`);
    }
  }
  if (s.high_velocity?.enabled && !(s.high_velocity.events_per_minute > 0)) {
    problems.push('high_velocity.events_per_minute 必须 > 0');
  }
  if (s.regular_interval?.enabled) {
    if (!(s.regular_interval.cv_threshold > 0 && s.regular_interval.cv_threshold < 1)) {
      problems.push('regular_interval.cv_threshold 必须在 0 与 1 之间');
    }
    if (!(s.regular_interval.min_events >= 3)) problems.push('regular_interval.min_events 必须 >= 3');
  }
  if (!(rules.settlement.payout_per_valid_click_cents >= 0)) problems.push('点击结算单价必须 >= 0');
  if (!(rules.settlement.payout_per_valid_conversion_ratio >= 0)) problems.push('转化分成比例必须 >= 0');
  if (!['CNY', 'USD', 'EUR'].includes(rules.settlement.currency)) problems.push('币种不受支持');
  if (!(rules.lookback_days >= 0 && rules.lookback_days <= 30)) problems.push('lookback_days 必须在 0..30');
  if (problems.length) {
    const err = new Error(`规则校验失败: ${problems.join('；')}`);
    err.problems = problems;
    throw err;
  }
  return true;
}

export const RULE_CATALOG = [
  { id: 'orphan_click', label: '点击缺少同会话曝光', severity: 'hard' },
  { id: 'click_before_session', label: '点击早于会话起始', severity: 'hard' },
  { id: 'click_delay_low', label: '点击间隔低于下限（疑似脚本）', severity: 'hard' },
  { id: 'click_delay_high', label: '点击间隔超过上限', severity: 'hard' },
  { id: 'conversion_orphan_click', label: '转化缺少点击', severity: 'hard' },
  { id: 'conversion_delay', label: '转化延迟超过窗口', severity: 'hard' },
  { id: 'duplicate_order', label: '重复订单号', severity: 'hard' },
  { id: 'bot_ua', label: 'UA 命中自动化特征', severity: 'hard' },
  { id: 'datacenter_ip', label: 'IP 属于数据中心前缀', severity: 'hard' },
  { id: 'device_flag', label: '设备命中补录证据', severity: 'hard' },
  { id: 'order_reversed', label: '订单已撤销/退款', severity: 'hard' },
  { id: 'viewability', label: '曝光不可见', severity: 'hard' },
  { id: 'high_velocity', label: '短时会话事件密度过高', severity: 'soft' },
  { id: 'regular_interval', label: '事件间隔过于均匀', severity: 'soft' },
  { id: 'cross_day_session', label: '跨日会话', severity: 'soft' },
];

export const RULE_LABELS = Object.fromEntries(RULE_CATALOG.map((r) => [r.id, r.label]));
