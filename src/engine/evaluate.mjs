import { digestOf } from '../lib/util.mjs';
import { minutesBetween, secondsBetween } from '../lib/time.mjs';

export const VALID = 'valid';
export const INVALID = 'invalid';
export const SUSPECT = 'suspect';

/**
 * Deterministic, explainable event-quality evaluation.
 *
 * Inputs are plain rows. The worker supplies session context (events of every
 * session touching the target day, within the lookback window) and an order
 * index (first ingest sequence seen per order_id). Nothing here reads the
 * clock or a model; the same inputs always produce the same verdicts, which is
 * what makes runs comparable and reproducible.
 *
 * Cross-day handling: a session is evaluated as a whole — its events on other
 * local days are context. Under `attribution-day` each event belongs to the
 * day it occurred; under `session-day` every event of the session belongs to
 * the day the session started, so a run for day D may decide events that
 * actually occurred after D. The `cross_day_session` contribution is emitted
 * on every event of a session that spans midnight.
 */
export function evaluateDay({ rules, day, events, sessionEvents, sessionInfo, evidence, orderFirst, asOf }) {
  const attribution = rules.cross_day?.attribution || 'attribution-day';
  const bySession = new Map();
  for (const ev of sessionEvents) {
    let list = bySession.get(ev.session_id);
    if (!list) {
      list = [];
      bySession.set(ev.session_id, list);
    }
    list.push(ev);
  }
  for (const list of bySession.values()) {
    list.sort(compareEvents);
  }

  const sessions = new Map();
  for (const [sessionId, list] of bySession) {
    sessions.set(sessionId, buildSession(sessionId, list, rules, sessionInfo));
  }

  const ordered = [...events].sort(compareEvents);
  const decisions = [];
  for (const ev of ordered) {
    const session = sessions.get(ev.session_id);
    if (!session) throw new Error(`缺少会话上下文: ${ev.session_id}`);
    if (attribution === 'attribution-day' && ev.local_day !== day) continue;
    if (attribution === 'session-day' && session.startDay !== day) continue;
    decisions.push(evaluateEvent({ rules, ev, session, evidence, orderFirst, asOf }));
  }
  return { decisions, sessions };
}

function compareEvents(a, b) {
  const t = a.occurred_at.localeCompare(b.occurred_at);
  return t !== 0 ? t : a.ingest_seq - b.ingest_seq;
}

function buildSession(sessionId, events, rules, sessionInfo) {
  const days = [...new Set(events.map((e) => e.local_day))].sort();
  const start = events[0];
  const meta = {
    sessionId,
    events,
    startDay: start.local_day,
    startAt: start.occurred_at,
    endAt: events[events.length - 1].occurred_at,
    days,
    crossDay: days.length > 1,
    truncated: Boolean(sessionInfo && typeof sessionInfo.get === 'function' ? sessionInfo.get(sessionId)?.truncated : sessionInfo?.truncated),
    velocity: null,
    interval: null,
  };
  const soft = rules.soft_checks || {};
  if (soft.high_velocity?.enabled) meta.velocity = computeVelocity(events, soft.high_velocity);
  if (soft.regular_interval?.enabled) meta.interval = computeIntervalCv(events, soft.regular_interval);
  return meta;
}

export function computeVelocity(events, cfg) {
  const times = events.map((e) => new Date(e.occurred_at).getTime());
  let best = { count: 0, startAt: null, endAt: null };
  let left = 0;
  for (let right = 0; right < times.length; right += 1) {
    while (times[right] - times[left] > 60_000) left += 1;
    const count = right - left + 1;
    if (count > best.count) {
      best = { count, startAt: events[left].occurred_at, endAt: events[right].occurred_at };
    }
  }
  return {
    maxPerMinute: best.count,
    threshold: cfg.events_per_minute,
    exceeded: best.count > cfg.events_per_minute,
    windowStart: best.startAt,
    windowEnd: best.endAt,
  };
}

export function computeIntervalCv(events, cfg) {
  if (events.length < cfg.min_events) {
    return { enoughData: false, cv: null, gaps: 0, threshold: cfg.cv_threshold };
  }
  const gaps = [];
  for (let i = 1; i < events.length; i += 1) {
    const gap = secondsBetween(events[i - 1].occurred_at, events[i].occurred_at);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length < cfg.min_events - 1) {
    return { enoughData: false, cv: null, gaps: gaps.length, threshold: cfg.cv_threshold };
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : null;
  return {
    enoughData: true,
    cv,
    gaps: gaps.length,
    meanGapSeconds: Number(mean.toFixed(3)),
    threshold: cfg.cv_threshold,
    suspicious: cv != null && cv < cfg.cv_threshold,
  };
}

class Contributions {
  constructor() {
    this.rows = [];
  }

  add(row) {
    const n = (v) => (v === undefined ? null : v);
    this.rows.push({
      check_order: this.rows.length + 1,
      evidence_ref: null,
      ...row,
      observed: n(row.observed),
      comparator: n(row.comparator),
      threshold: n(row.threshold),
      detail: n(row.detail),
      evidence_ref: n(row.evidence_ref),
    });
  }
}

function evidenceAt(evidence, kind, key, atMs) {
  const needle = String(key).toLowerCase();
  return (evidence || []).find((e) => {
    if (e.kind !== kind) return false;
    if (String(e.key).toLowerCase() !== needle) return false;
    const from = new Date(e.effective_from).getTime();
    const to = e.effective_to ? new Date(e.effective_to).getTime() : Infinity;
    return atMs >= from && atMs <= to;
  });
}

function evaluateEvent({ rules, ev, session, evidence, orderFirst, asOf }) {
  const c = new Contributions();
  const invalid = [];
  const suspect = [];
  const hard = rules.hard_checks || {};
  const soft = rules.soft_checks || {};

  // 1. Click attribution.
  if (ev.event_type === 'click') {
    const impression = ev.impression_id
      ? session.events.find((e) => e.event_type === 'impression' && e.impression_id === ev.impression_id)
      : null;
    if (ev.impression_id && !impression) {
      c.add({
        rule_id: 'orphan_click',
        rule_label: '点击缺少同会话曝光',
        scope: 'event',
        severity: 'hard',
        outcome: 'fail',
        observed: ev.impression_id,
        comparator: '必须存在于同会话',
        threshold: '存在',
        detail: '按 impression_id 在会话事件中未找到对应曝光，且不在回溯窗口内',
      });
      invalid.push({ rule_id: 'orphan_click', summary: `曝光 ${ev.impression_id} 不在同会话窗口` });
    } else if (impression && new Date(impression.occurred_at).getTime() > new Date(ev.occurred_at).getTime()) {
      c.add({
        rule_id: 'click_before_session',
        rule_label: '点击早于曝光',
        scope: 'event',
        severity: 'hard',
        outcome: 'fail',
        observed: ev.occurred_at,
        comparator: '<',
        threshold: impression.occurred_at,
        detail: '点击时间早于被引用的曝光时间',
      });
      invalid.push({ rule_id: 'click_before_session', summary: '点击早于对应曝光' });
    } else {
      c.add({
        rule_id: 'click_order_ok',
        rule_label: '点击在曝光之后',
        scope: 'event',
        severity: 'info',
        outcome: 'pass',
        observed: impression ? `${new Date(ev.occurred_at) - new Date(impression.occurred_at)} ms` : '无曝光引用',
        comparator: '>=',
        threshold: '0 ms',
      });
    }

    // 2. Click delay: explicit reported delay when present, else derived from the impression.
    const delayMs = ev.click_delay_ms != null
      ? ev.click_delay_ms
      : impression
        ? new Date(ev.occurred_at) - new Date(impression.occurred_at)
        : null;
    if (!hard.click_delay?.enabled) {
      c.add({
        rule_id: 'click_delay',
        rule_label: '点击间隔检查',
        scope: 'event',
        severity: 'info',
        outcome: 'skip',
        detail: '当前规则未启用',
      });
    } else if (delayMs == null) {
      c.add({
        rule_id: 'click_delay',
        rule_label: '点击间隔检查',
        scope: 'event',
        severity: 'info',
        outcome: 'skip',
        observed: '无间隔数据',
        detail: '缺少 impression_id 与 click_delay_ms，无法判定间隔',
      });
    } else if (delayMs < hard.click_delay.min_ms) {
      const asSuspect = hard.click_delay.treat_faster_than_min_as === 'suspect';
      c.add({
        rule_id: 'click_delay_low',
        rule_label: '点击间隔低于下限（疑似脚本）',
        scope: 'event',
        severity: asSuspect ? 'soft' : 'hard',
        outcome: 'fail',
        observed: `${delayMs} ms`,
        comparator: '<',
        threshold: `${hard.click_delay.min_ms} ms`,
        detail: asSuspect ? '低于人类可达下限，按规则配置降级为可疑' : '低于人类可达的下限，判为无效',
      });
      (asSuspect ? suspect : invalid).push({
        rule_id: 'click_delay_low',
        summary: `点击间隔 ${delayMs}ms 低于 ${hard.click_delay.min_ms}ms`,
      });
    } else if (delayMs > hard.click_delay.max_ms) {
      c.add({
        rule_id: 'click_delay_high',
        rule_label: '点击间隔超过上限',
        scope: 'event',
        severity: 'hard',
        outcome: 'fail',
        observed: `${delayMs} ms`,
        comparator: '>',
        threshold: `${hard.click_delay.max_ms} ms`,
        detail: '曝光到点击的间隔超过归因窗口',
      });
      invalid.push({
        rule_id: 'click_delay_high',
        summary: `点击间隔 ${delayMs}ms 超过 ${hard.click_delay.max_ms}ms`,
      });
    } else {
      c.add({
        rule_id: 'click_delay',
        rule_label: '点击间隔在窗口内',
        scope: 'event',
        severity: 'info',
        outcome: 'pass',
        observed: `${delayMs} ms`,
        comparator: 'between',
        threshold: `${hard.click_delay.min_ms}..${hard.click_delay.max_ms} ms`,
      });
    }
  }

  // 3. Conversion attribution.
  if (ev.event_type === 'conversion') {
    const click = ev.click_id
      ? session.events.find((e) => e.event_type === 'click' && e.click_id === ev.click_id)
      : null;
    if (!hard.conversion_delay?.enabled) {
      c.add({
        rule_id: 'conversion_delay',
        rule_label: '转化延迟检查',
        scope: 'event',
        severity: 'info',
        outcome: 'skip',
        detail: '当前规则未启用',
      });
    } else if (!click) {
      const asSuspect = hard.conversion_delay.orphan_click_policy === 'suspect';
      c.add({
        rule_id: 'conversion_orphan_click',
        rule_label: '转化缺少点击',
        scope: 'event',
        severity: asSuspect ? 'soft' : 'hard',
        outcome: 'fail',
        observed: ev.click_id || '（空）',
        comparator: '必须存在于同会话窗口',
        threshold: '存在',
        detail: '按 click_id 在会话事件与回溯窗口内未找到点击',
      });
      (asSuspect ? suspect : invalid).push({
        rule_id: 'conversion_orphan_click',
        summary: `点击 ${ev.click_id || '（空）'} 不在窗口`,
      });
    } else {
      const delayMinutes = minutesBetween(click.occurred_at, ev.occurred_at);
      const limit = hard.conversion_delay.max_hours * 60;
      if (delayMinutes < 0) {
        c.add({
          rule_id: 'conversion_orphan_click',
          rule_label: '转化早于点击',
          scope: 'event',
          severity: 'hard',
          outcome: 'fail',
          observed: `${delayMinutes.toFixed(2)} 分钟`,
          comparator: '<',
          threshold: '0 分钟',
          detail: `点击 ${click.click_id} 在 ${click.occurred_at}`,
        });
        invalid.push({ rule_id: 'conversion_orphan_click', summary: '转化早于点击' });
      } else if (delayMinutes > limit) {
        c.add({
          rule_id: 'conversion_delay',
          rule_label: '转化延迟超过窗口',
          scope: 'event',
          severity: 'hard',
          outcome: 'fail',
          observed: `${delayMinutes.toFixed(2)} 分钟`,
          comparator: '>',
          threshold: `${limit} 分钟`,
          detail: `点击 ${click.click_id} 在 ${click.occurred_at}`,
        });
        invalid.push({
          rule_id: 'conversion_delay',
          summary: `转化延迟 ${Math.round(delayMinutes)} 分钟超过 ${limit} 分钟`,
        });
      } else {
        c.add({
          rule_id: 'conversion_delay',
          rule_label: '转化在归因窗口内',
          scope: 'event',
          severity: 'info',
          outcome: 'pass',
          observed: `${delayMinutes.toFixed(2)} 分钟`,
          comparator: '<=',
          threshold: `${limit} 分钟`,
        });
      }
    }

    // 4. Duplicate order ids: the first ingest wins; later copies are duplicates.
    if (!hard.duplicate_order?.enabled) {
      c.add({
        rule_id: 'duplicate_order',
        rule_label: '重复订单号',
        scope: 'event',
        severity: 'info',
        outcome: 'skip',
        detail: '当前规则未启用',
      });
    } else {
      const first = ev.order_id ? orderFirst.get(ev.order_id) : null;
      if (ev.order_id && first != null && first < ev.ingest_seq) {
        c.add({
          rule_id: 'duplicate_order',
          rule_label: '重复订单号',
          scope: 'event',
          severity: 'hard',
          outcome: 'fail',
          observed: ev.order_id,
          comparator: '仅首次摄入有效',
          threshold: `首次 ingest_seq ${first}`,
          detail: `本事件 ingest_seq ${ev.ingest_seq} 晚于首次出现`,
        });
        invalid.push({ rule_id: 'duplicate_order', summary: `订单号 ${ev.order_id} 重复` });
      } else {
        c.add({
          rule_id: 'duplicate_order',
          rule_label: '重复订单号',
          scope: 'event',
          severity: 'info',
          outcome: 'pass',
          observed: ev.order_id || '（无订单号）',
          comparator: '仅首次摄入有效',
          threshold: ev.order_id ? '首次出现' : '不适用',
        });
      }
    }
  }

  // 5. Evidence-driven checks.
  const ua = hard.bot_ua;
  if (!ua?.enabled) {
    c.add({ rule_id: 'bot_ua', rule_label: 'UA 命中自动化特征', scope: 'evidence', severity: 'info', outcome: 'skip', detail: '当前规则未启用' });
  } else {
    const lower = ev.user_agent.toLowerCase();
    const token = ua.tokens.find((t) => lower.includes(String(t).toLowerCase()));
    if (token) {
      const evd = evidenceAt(evidence, 'ua_token', token, Date.parse(ev.occurred_at));
      c.add({
        rule_id: 'bot_ua',
        rule_label: 'UA 命中自动化特征',
        scope: 'evidence',
        severity: 'hard',
        outcome: 'fail',
        observed: token,
        comparator: '包含',
        threshold: '不包含自动化特征',
        detail: `UA: ${ev.user_agent}`,
        evidence_ref: evd ? `evidence#${evd.id}` : null,
      });
      invalid.push({ rule_id: 'bot_ua', summary: `UA 命中 “${token}”` });
    } else {
      c.add({
        rule_id: 'bot_ua',
        rule_label: 'UA 命中自动化特征',
        scope: 'evidence',
        severity: 'info',
        outcome: 'pass',
        observed: '未命中',
        comparator: '包含',
        threshold: '不包含自动化特征',
      });
    }
  }

  const dc = hard.datacenter_ip;
  if (!dc?.enabled) {
    c.add({ rule_id: 'datacenter_ip', rule_label: 'IP 属于数据中心前缀', scope: 'evidence', severity: 'info', outcome: 'skip', detail: '当前规则未启用' });
  } else {
    const prefix = (dc.prefixes || []).find((p) => ev.ip === p || ev.ip.startsWith(`${p}.`));
    if (prefix) {
      const evd = evidenceAt(evidence, 'ip_prefix', prefix, Date.parse(ev.occurred_at));
      c.add({
        rule_id: 'datacenter_ip',
        rule_label: 'IP 属于数据中心前缀',
        scope: 'evidence',
        severity: 'hard',
        outcome: 'fail',
        observed: prefix,
        comparator: '前缀匹配',
        threshold: '住宅/移动网络',
        detail: `IP: ${ev.ip}`,
        evidence_ref: evd ? `evidence#${evd.id}` : null,
      });
      invalid.push({ rule_id: 'datacenter_ip', summary: `IP 前缀 ${prefix} 属于数据中心` });
    } else {
      c.add({
        rule_id: 'datacenter_ip',
        rule_label: 'IP 属于数据中心前缀',
        scope: 'evidence',
        severity: 'info',
        outcome: 'pass',
        observed: '未命中',
        comparator: '前缀匹配',
        threshold: '住宅/移动网络',
      });
    }
  }

  if (!hard.device_flag?.enabled) {
    c.add({ rule_id: 'device_flag', rule_label: '设备命中补录证据', scope: 'evidence', severity: 'info', outcome: 'skip', detail: '当前规则未启用' });
  } else {
    const evd = evidenceAt(evidence, 'device_flag', ev.device_id, Date.parse(ev.occurred_at));
    if (evd) {
      c.add({
        rule_id: 'device_flag',
        rule_label: '设备命中补录证据',
        scope: 'evidence',
        severity: 'hard',
        outcome: 'fail',
        observed: ev.device_id,
        comparator: '存在有效证据',
        threshold: '无有效证据',
        detail: evd.note || evd.label,
        evidence_ref: `evidence#${evd.id}`,
      });
      invalid.push({ rule_id: 'device_flag', summary: `设备 ${ev.device_id} 命中「${evd.label}」` });
    } else {
      c.add({
        rule_id: 'device_flag',
        rule_label: '设备命中补录证据',
        scope: 'evidence',
        severity: 'info',
        outcome: 'pass',
        observed: '未命中',
        comparator: '存在有效证据',
        threshold: '无有效证据',
      });
    }
  }

  if (!hard.order_reversed?.enabled) {
    c.add({ rule_id: 'order_reversed', rule_label: '订单已撤销/退款', scope: 'evidence', severity: 'info', outcome: 'skip', detail: '当前规则未启用' });
  } else if (!ev.order_id) {
    c.add({ rule_id: 'order_reversed', rule_label: '订单已撤销/退款', scope: 'evidence', severity: 'info', outcome: 'skip', observed: '无订单号', detail: '非订单事件' });
  } else {
    const evd = evidenceAt(evidence, 'order_reversal', ev.order_id, Date.parse(ev.occurred_at));
    if (evd) {
      c.add({
        rule_id: 'order_reversed',
        rule_label: '订单已撤销/退款',
        scope: 'evidence',
        severity: 'hard',
        outcome: 'fail',
        observed: ev.order_id,
        comparator: '存在有效证据',
        threshold: '无有效证据',
        detail: evd.note || evd.label,
        evidence_ref: `evidence#${evd.id}`,
      });
      invalid.push({ rule_id: 'order_reversed', summary: `订单 ${ev.order_id} 已撤销或退款` });
    } else {
      c.add({
        rule_id: 'order_reversed',
        rule_label: '订单已撤销/退款',
        scope: 'evidence',
        severity: 'info',
        outcome: 'pass',
        observed: '未命中',
        comparator: '存在有效证据',
        threshold: '无有效证据',
      });
    }
  }

  // 6. Viewability.
  if (!hard.viewability?.enabled) {
    c.add({ rule_id: 'viewability', rule_label: '曝光不可见', scope: 'event', severity: 'info', outcome: 'skip', detail: '当前规则未启用' });
  } else if (ev.event_type === 'impression') {
    if (hard.viewability.invalid_if_not_viewable && ev.viewable === 0) {
      c.add({
        rule_id: 'viewability',
        rule_label: '曝光不可见',
        scope: 'event',
        severity: 'hard',
        outcome: 'fail',
        observed: '不可见 (viewable=0)',
        comparator: '必须可见',
        threshold: 'viewable=1',
      });
      invalid.push({ rule_id: 'viewability', summary: '曝光不可见' });
    } else {
      c.add({
        rule_id: 'viewability',
        rule_label: '曝光不可见',
        scope: 'event',
        severity: 'info',
        outcome: 'pass',
        observed: ev.viewable === 0 ? '不可见 (viewable=0)' : '可见 (viewable=1)',
        comparator: '必须可见',
        threshold: 'viewable=1',
      });
    }
  }

  // 7. Session-level soft checks, reported on every event of the session.
  if (!soft.cross_day_session?.enabled) {
    c.add({ rule_id: 'cross_day_session', rule_label: '跨日会话', scope: 'session', severity: 'info', outcome: 'skip', detail: '当前规则未启用' });
  } else if (session.crossDay) {
    const observed = `跨 ${session.days.length} 个自然日：${session.days.join(' / ')}`;
    const escalate = rules.cross_day?.escalate_to_suspect === true;
    c.add({
      rule_id: 'cross_day_session',
      rule_label: '跨日会话',
      scope: 'session',
      severity: escalate ? 'soft' : 'info',
      outcome: escalate ? 'fail' : 'note',
      observed,
      comparator: '> 1 个归属日',
      threshold: '1 个归属日',
      detail: `会话 ${session.sessionId} 起始 ${session.startDay} ${session.startAt}，按 ${rules.cross_day.attribution} 归属；会话整体判定，跨日事件可在「跨日会话」筛选中逐条核对。${
        escalate ? '当前规则将跨日会话升级为可疑。' : '当前规则仅记录、不改变判定。'
      }`,
    });
    if (escalate) suspect.push({ rule_id: 'cross_day_session', summary: observed });
  } else {
    c.add({
      rule_id: 'cross_day_session',
      rule_label: '跨日会话',
      scope: 'session',
      severity: 'info',
      outcome: 'pass',
      observed: '1 个自然日',
      comparator: '<= 1 个归属日',
      threshold: '1 个归属日',
    });
  }

  if (!soft.high_velocity?.enabled) {
    c.add({ rule_id: 'high_velocity', rule_label: '短时会话事件密度过高', scope: 'session', severity: 'info', outcome: 'skip', detail: '当前规则未启用' });
  } else if (session.velocity.exceeded) {
    const observed = `峰值 ${session.velocity.maxPerMinute} 条/分钟`;
    c.add({
      rule_id: 'high_velocity',
      rule_label: '短时会话事件密度过高',
      scope: 'session',
      severity: 'soft',
      outcome: 'fail',
      observed,
      comparator: '>',
      threshold: `${session.velocity.threshold} 条/分钟`,
      detail: `最密 60 秒窗口 ${session.velocity.windowStart} → ${session.velocity.windowEnd}`,
    });
    suspect.push({ rule_id: 'high_velocity', summary: observed });
  } else {
    c.add({
      rule_id: 'high_velocity',
      rule_label: '短时会话事件密度过高',
      scope: 'session',
      severity: 'info',
      outcome: 'pass',
      observed: `峰值 ${session.velocity.maxPerMinute} 条/分钟`,
      comparator: '<=',
      threshold: `${session.velocity.threshold} 条/分钟`,
    });
  }

  if (!soft.regular_interval?.enabled) {
    c.add({ rule_id: 'regular_interval', rule_label: '事件间隔过于均匀', scope: 'session', severity: 'info', outcome: 'skip', detail: '当前规则未启用' });
  } else if (!session.interval.enoughData) {
    c.add({
      rule_id: 'regular_interval',
      rule_label: '事件间隔过于均匀',
      scope: 'session',
      severity: 'info',
      outcome: 'skip',
      observed: `${session.interval.gaps} 个间隔`,
      comparator: '>=',
      threshold: `${soft.regular_interval.min_events - 1} 个间隔`,
      detail: '样本不足，跳过判定',
    });
  } else if (session.interval.suspicious) {
    const observed = `CV ${session.interval.cv.toFixed(3)}`;
    c.add({
      rule_id: 'regular_interval',
      rule_label: '事件间隔过于均匀',
      scope: 'session',
      severity: 'soft',
      outcome: 'fail',
      observed,
      comparator: '<',
      threshold: String(session.interval.threshold),
      detail: `平均间隔 ${session.interval.meanGapSeconds}s，共 ${session.interval.gaps} 个间隔`,
    });
    suspect.push({ rule_id: 'regular_interval', summary: observed });
  } else {
    c.add({
      rule_id: 'regular_interval',
      rule_label: '事件间隔过于均匀',
      scope: 'session',
      severity: 'info',
      outcome: 'pass',
      observed: `CV ${session.interval.cv.toFixed(3)}`,
      comparator: '>=',
      threshold: String(session.interval.threshold),
    });
  }

  const verdict = invalid.length > 0 ? INVALID : suspect.length > 0 ? SUSPECT : VALID;
  const primary = invalid[0] || suspect[0] || null;

  let amountCents = 0;
  if (ev.event_type === 'click') amountCents = rules.settlement.payout_per_valid_click_cents;
  if (ev.event_type === 'conversion') {
    amountCents = Math.round((ev.revenue_cents || 0) * rules.settlement.payout_per_valid_conversion_ratio);
  }

  return {
    event: ev,
    verdict,
    primaryReason: primary ? primary.rule_id : null,
    primaryDetail: primary ? primary.summary : null,
    invalidReasons: invalid,
    suspectReasons: suspect,
    contributions: c.rows,
    amountCents,
    attributionDay: rules.cross_day?.attribution === 'session-day' ? session.startDay : ev.local_day,
    sessionStartDay: session.startDay,
    sessionDays: session.days,
    sessionCrossDay: session.crossDay,
    sessionTruncated: session.truncated,
  };
}

/** Stable digest of a decision set: proves two runs saw identical inputs+outputs. */
export function decisionDigest(decisions) {
  return digestOf(
    decisions.map((d) => ({
      event_id: d.event.event_id,
      verdict: d.verdict,
      reason: d.primaryReason,
      invalid: d.invalidReasons.map((r) => r.rule_id).sort(),
      suspect: d.suspectReasons.map((r) => r.rule_id).sort(),
      day: d.attributionDay,
      amount: d.amountCents,
    })),
  );
}
