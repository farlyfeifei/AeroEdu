/* =======================================================================
 * AeroEdu aiScenario.js — 中文自然语言 -> 飞行工况解析器
 * -----------------------------------------------------------------------
 * 模拟"接入大模型实现构型参数自动生成"的工程能力:
 *   - 关键词 + 规则槽位填充, 离线可用, 零延迟
 *   - 解析: 模式(悬停/巡航/着陆/8字/圆周)、风扰、高度、PID 风格
 *   - 支持中文 + 简单英文混写
 *   - 设计为可替换为真实 LLM 调用 (保留相同接口 parse -> ScenarioConfig)
 *
 * 这一层是"AI 工程化落地"的体现: 用轻量规则做 90% 场景, 复杂场景兜底 LLM
 * ======================================================================= */

(function (global) {
  'use strict';

  // 风力等级 -> 速度 (蒲福风级近似, m/s)
  const BEAUFORT = [0, 0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5];
  function beaufortToMs(level) {
    level = Math.max(0, Math.min(10, level | 0));
    return BEAUFORT[level];
  }

  // 中文数字
  const CN_NUM = { '零': 0, '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  function parseCnNumber(s) {
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    if (s === '十') return 10;
    if (s.startsWith('十')) return 10 + (CN_NUM[s[1]] || 0);
    if (s.includes('十')) {
      const parts = s.split('十');
      return (CN_NUM[parts[0]] || 1) * 10 + (CN_NUM[parts[1]] || 0);
    }
    return CN_NUM[s] !== undefined ? CN_NUM[s] : null;
  }

  // PID 风格预设 (教学: 展示不同参数对响应的影响)
  const PID_PRESETS = {
    soft:    { alt: [6, 3, 2],   roll: [4, 0.3, 0.8], pitch: [4, 0.3, 0.8], yaw: [2, 0.1, 0.3], note: '软(欠阻尼): 响应慢, 易超调' },
    balanced:{ alt: [8, 4, 3],   roll: [6, 0.5, 1.2], pitch: [6, 0.5, 1.2], yaw: [2.5, 0.1, 0.4], note: '均衡(临界阻尼): 稳准快' },
    agile:   { alt: [12, 5, 4],  roll: [9, 0.8, 1.8], pitch: [9, 0.8, 1.8], yaw: [3.5, 0.2, 0.6], note: '激进(过阻尼): 响应快, 抗扰强' },
    oscillate:{ alt: [15, 6, 0.5], roll: [12, 2, 0.2], pitch: [12, 2, 0.2], yaw: [4, 0.5, 0.1], note: '振荡(Kd 过小): 故意展示发散' },
  };

  function parse(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.trim();
    const log = [];

    // 1) 模式识别
    let mode = 'hover';
    if (/(悬停|定高|定点|hover)/i.test(t)) mode = 'hover';
    else if (/(8字|八字|figure\s*8|lemniscate)/i.test(t)) mode = 'figure8';
    else if (/(圆|盘旋|绕圈|circle|orbit)/i.test(t)) mode = 'circle';
    else if (/(着陆|降落|落地|land|下降)/i.test(t)) mode = 'landing';
    else if (/(起飞|升空|takeoff)/i.test(t)) mode = 'takeoff';
    else if (/(巡航|前飞|cruise|forward)/i.test(t)) mode = 'cruise';
    log.push(`模式: ${mode}`);

    // 2) 风扰: "5级风" / "侧风3米" / "阵风" / "无风"
    let wind = { x: 0, y: 0, z: 0 };
    let windLabel = '无风';
    // "5级侧风" / "5级风" / "五级风"  (允许中间夹方向词)
    const beaufortMatch = t.match(/(\d+|十|一|二|两|三|四|五|六|七|八|九)\s*级(?:侧风|逆风|顺风|风|阵风)/);
    const msMatch = t.match(/(\d+(?:\.\d+)?)\s*(?:m\/s|米每秒|米\/秒|ms(?![a-z]))/i);
    const isGust = /(阵风|gust)/i.test(t);
    const sideWind = /(侧风|cross)/i.test(t);
    const headWind = /(逆风|head)/i.test(t);
    const noWind = /(无风|静风|no\s*wind)/i.test(t);

    if (!noWind) {
      let speed = 0;
      if (msMatch) speed = parseFloat(msMatch[1]);
      else if (beaufortMatch) speed = beaufortToMs(parseCnNumber(beaufortMatch[1]) || 0);
      if (speed > 0) {
        if (sideWind) { wind.x = speed; windLabel = `侧风 ${speed.toFixed(1)} m/s`; }
        else if (headWind) { wind.y = speed; windLabel = `逆风 ${speed.toFixed(1)} m/s`; }
        else { wind.x = speed * 0.7; wind.y = speed * 0.7; windLabel = `斜风 ${speed.toFixed(1)} m/s`; }
        if (isGust) { wind.z = speed * 0.3; windLabel += ' (含阵风)'; }
        log.push(`风扰: ${windLabel}`);
      }
    } else {
      log.push('风扰: 无风');
    }

    // 3) 高度: "高度3米" / "3米高度" / "飞到5米" / "altitude 4m"
    let alt = null;
    const altMatchA = t.match(/(?:高度|飞到|升至|altitude|alt)\s*(\d+(?:\.\d+)?)\s*(?:米|m)\b/);
    const altMatchB = t.match(/(\d+(?:\.\d+)?)\s*(?:米|m)\s*(?:高度|altitude)/i);
    const altMatch = altMatchA || altMatchB;
    if (altMatch) { alt = parseFloat(altMatch[1]); log.push(`目标高度: ${alt} m`); }

    // 4) PID 风格: "激进" / "柔和" / "均衡" / "振荡"
    let pidStyle = 'balanced';
    if (/(激进|迅速|快响应|aggressive|agile|sport)/i.test(t)) pidStyle = 'agile';
    else if (/(柔和|温和|平稳|soft|gentle|smooth)/i.test(t)) pidStyle = 'soft';
    else if (/(均衡|平衡|默认|balanced|default)/i.test(t)) pidStyle = 'balanced';
    else if (/(振荡|发散|失稳|振荡展示|oscillat)/i.test(t)) pidStyle = 'oscillate';
    log.push(`PID 风格: ${pidStyle} (${PID_PRESETS[pidStyle].note})`);

    // 5) 相机: "跟随" / "俯视" / "侧视"
    let camera = 'orbit';
    if (/(跟随|follow|track)/i.test(t)) camera = 'follow';
    else if (/(俯视|俯瞰|top|bird)/i.test(t)) camera = 'top';
    else if (/(侧视|side)/i.test(t)) camera = 'side';

    // 6) 速度倍率 (8字/圆周): "快速" / "慢速"
    let speedScale = 1.0;
    if (/(快速|高速|fast|quick)/i.test(t)) speedScale = 1.8;
    else if (/(慢速|低速|slow)/i.test(t)) speedScale = 0.5;

    return {
      mode,
      wind,
      windLabel,
      alt,
      pidStyle,
      pid: PID_PRESETS[pidStyle],
      camera,
      speedScale,
      log,
      rawText: t,
    };
  }

  // 生成可读的"AI 解析报告" (展示给用户, 体现可解释性)
  function explain(cfg) {
    if (!cfg) return '未识别到有效指令';
    const lines = [
      '【AI 场景解析报告】',
      ...cfg.log.map(l => '  • ' + l),
      '',
      '【将自动配置】',
      `  • 飞行模式: ${cfg.mode}`,
      `  • 风扰注入: ${cfg.windLabel}`,
      cfg.alt !== null ? `  • 目标高度: ${cfg.alt} m` : '  • 目标高度: 默认',
      `  • PID 参数组: ${cfg.pidStyle}`,
      `  • 相机模式: ${cfg.camera}`,
    ];
    return lines.join('\n');
  }

  // 预设示例 (UI 一键填充)
  const EXAMPLES = [
    '在5级侧风下悬停在3米高度,使用激进PID',
    '无风环境飞8字航线,慢速,均衡PID',
    '阵风7米每秒逆风着陆,柔和PID,俯视相机',
    '悬停展示振荡失稳,无风',
    '2级风绕圆巡航,快速,跟随相机',
  ];

  global.AeroScenario = { parse, explain, EXAMPLES, PID_PRESETS, beaufortToMs };
})(typeof window !== 'undefined' ? window : globalThis);
