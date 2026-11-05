/**
 * Provider 插件层 —— 这里是 LX Music 核心思想的落地。
 *
 * LX 的做法：主程序只定一套契约定的接口，真正"把歌变成 URL"的逻辑交给可插拔的外部脚本。
 * 我们的做法一样，但接口面向服务端：
 *
 *   search(keyword, limit)  → Track[]               歌名 → 曲目列表
 *   streamUrl(track)        → { url, headers }      曲目 → 能播的直链（+ 需要的请求头）
 *   lyric(track)            → { lyric, ... } | null 取歌词
 *   cover(track)            → url | null            取封面
 *
 * 内置三种：
 *   local    本地音乐目录（能搜能播，开箱即用）
 *   http     声明式 HTTP 音源（用户填 URL 模板 + 字段路径，能接任何现成 API）
 *   lxscript LX 音源脚本（在 vm 沙箱里跑现成 JS 脚本，只负责取流；可借别的音源来搜歌）
 */
import { createLogger } from '../log.js';
import { encodeTrackId, decodeTrackId } from '../track-id.js';
import { currentUser } from '../access-context.js';
import * as musicAccounts from '../music-accounts.js';
import { Provider } from './base.js';
import { createLocalProvider } from './local.js';
import { createHttpProvider } from './http.js';
import { createLxScriptProvider } from './lxscript.js';
import { createXimalayaProvider } from './ximalaya.js';

export { encodeTrackId, decodeTrackId, Provider };

const log = createLogger('providers');

/** 标题是不是同一首（忽略大小写/空格与常见的括号后缀） */
function sameTitle(a, b) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[（(【\[].*?[）)】\]]/g, '') // 去掉 (live)/(remaster) 这类后缀
      .replace(/[\s\-_·、，,.!！?？'"]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** 源的对外中文名（报错说人话用） */
const SOURCE_CN = { kw: '酷我', kg: '酷狗', tx: 'QQ音乐', mg: '咪咕', wy: '网易云', local: '本地', http: '网络地址' };

/** 从 label（形如「QQ音乐(78153947)」）里取出账号名，避免拼成「账号 QQ音乐(78153947)」 */
function acctName(a) {
  const raw = String(a?.label || '').trim();
  const m = raw.match(/\(([^()]+)\)\s*$/) || raw.match(/（([^（）]+)）\s*$/);
  return (m ? m[1] : raw).trim() || '已绑定';
}

/**
 * 把「用户绑了哪些源、哪些账号」说成一句人话。
 * 用户要求（2026-10-23）：播不了时一定要说清"你现在绑定的是什么源、什么账号"。
 * @param {Array<{source:string,label:string,isVip?:boolean,hasCookie?:boolean}>} own
 */
function describeOwn(own) {
  // v1.9.228 会员称呼按源分：绿钻是 QQ 音乐的话，套在酷狗/网易云账号上用户听不懂。
  const VIP_CN = { tx: '绿钻', wy: '黑胶', kw: '会员', kg: '会员', mg: '会员' };
  const list = (own || []).filter((a) => a && a.source && a.source !== 'generic');
  if (!list.length) return '（还没绑定任何音乐源）';
  return list
    .map((a) => {
      const cn = SOURCE_CN[a.source] || a.source;
      if (!a.hasCookie) return `${cn}（还没绑账号）`;
      const vipName = VIP_CN[a.source] || '会员';
      const vip = a.isVip === true ? `，${vipName}` : a.isVip === false ? `，非${vipName}` : '';
      return `${cn}（账号 ${acctName(a)}${vip}）`;
    })
    .join('、');
}

/** 「一个源都没绑」时的统一话术（取流失败、被闸拦两种场景共用） */
function noResourceHint(title) {
  return (
    `${title ? `「${title}」` : '这首歌'}放不了：你还没绑定任何音乐源，所以没有可用的曲库。你可以：` +
    `1) 去「我的音乐账号」绑定一个（QQ音乐 / 酷我 / 酷狗 / 网易云，扫码或粘贴 Cookie）；` +
    `2) 或者开通会员，用系统的公共曲库。`
  );
}

/**
 * 取流全失败时给用户看的话（v1.9.122 起，v1.9.123 按用户规则重写）。
 *
 * 用户钦定的规则（2026-10-23）：
 *   「什么级别的用户听什么级别的资源。播不了就要明确告诉他：你绑的是什么源、
 *     绑的是什么账号、这个账号下听不了这首歌，然后告诉他可以绑更多源，或者升级这个账号。」
 *
 * 判断依据（都有实测支撑，不是猜）：
 *   - 首选源是 tx 且取不到 → QQ 音乐返回 result=104003。实测同一份 cookie 下
 *     原版正曲一律 104003、翻唱/Live 版一律 result=0 能出真 URL，
 *     故「QQ 音乐不给可播放地址」= 这个账号没有这首歌的授权（多半要绿钻）。
 *   - 用户只绑了一个源时，换源无从谈起（候选被源层白名单过滤空），必须点明。
 *
 * @param {{title: string, preferred: string, preferredSource: string, first: string,
 *          allowedSources: string[]|null, ownAccounts: Array<{source:string,label:string,isVip?:boolean,hasCookie?:boolean}>}} p
 * @returns {string}
 */
export function buildStreamFailHint({ title, preferred, preferredSource, first, allowedSources, ownAccounts }) {
  // ★ preferred 是「音源脚本 id」（flower），preferredSource 才是「曲目的真实来源」（tx）。
  //   给用户看必须用真实来源，否则会念出 "flower 取不到…" 这种谁都听不懂的话。
  const src = preferredSource || preferred;
  const srcCn = SOURCE_CN[src] || SOURCE_CN[preferred] || preferred;

  // v1.9.129 听书分支：没绑喜马拉雅/会员书无权限——点明去绑定喜马拉雅，
  // 别套音乐源话术（听书跟绑没绑 QQ/网易云毫无关系）。
  if (src === 'album') {
    return (
      `《${title}》现在放不了：喜马拉雅没给出这本书的播放地址。` +
      `免费书一般能直接听，这本书多半是会员内容——而你还没绑定喜马拉雅账号。` +
      `打开 APP 的「我的音乐账号」，找到「喜马拉雅」扫二维码绑定，绑完再对我说一次"听 ${title}"。`
    );
  }

  // 他绑定的源 + 账号（用户要求说清楚"绑了谁"）
  const own = Array.isArray(ownAccounts) ? ownAccounts.filter((a) => a && a.source && a.source !== 'generic') : [];

  // 一个源都没绑：直接说这个，别去解释"XX 账号没权限"（那不是他的账号）
  if (!own.length) {
    return noResourceHint(title);
  }

  const ownText = describeOwn(own);

  // 这一首为什么放不了
  let why;
  if (src === 'tx') {
    why = `${srcCn}这个账号没有这首歌的播放权限（QQ 音乐原版曲多数要绿钻才有授权）`;
  } else if (src === 'kg' && /需要付费|付费|30020|会员|vip/i.test(String(first || ''))) {
    // v1.9.228 酷狗移动端接口对会员曲回"需要付费"——说人话：这是会员曲 + 你的账号没会员。
    // 别再用"取不到音源"这种用户看不懂、也不知道怎么办的话。
    why = `这首歌是${srcCn}会员才能听的曲子，而你绑定的酷狗账号没有开通会员`;
  } else {
    why = `${srcCn}取不到这首歌的音源（${first || '音源没返回原因'}）`;
  }

  const advice = [];
  if (src === 'tx') advice.push('把你这个 QQ 账号升级成绿钻');
  if (src === 'kg' && /需要付费|付费|30020|会员|vip/i.test(String(first || ''))) {
    advice.push('给这个酷狗账号开通会员（酷狗 APP → 我的 → 开通豪华 VIP）');
  }
  advice.push('在「我的音乐账号」里多绑一个音乐源（酷我 / 酷狗 / 网易云，多数歌免费能听）');
  if (own.length) advice.push('或者换一首同类的歌');

  const only = Array.isArray(allowedSources) && allowedSources.length === 1 ? allowedSources[0] : '';
  const tail = only
    ? `而且你现在只绑了 ${SOURCE_CN[only] || only} 一个源，没法自动换源顶上。`
    : '';

  return `「${title}」放不了。你现在绑定的是：${ownText}。${why}。${tail}你可以：${advice
    .map((a, i) => `${i + 1}) ${a}`)
    .join('；')}。`;
}

/** 在候选里找同一首歌：标题必须像，能对上歌手更好 */
function pickSameSong(tracks, title, artist) {
  const a = String(artist || '').toLowerCase();
  const candidates = (tracks || []).filter((t) => sameTitle(t.title, title));
  if (!candidates.length) return null;
  if (!a) return candidates[0];
  return (
    candidates.find((t) => String(t.artist || '').toLowerCase().includes(a.slice(0, 6))) ||
    candidates[0]
  );
}

/**
 * 把所有音源装起来，并提供跨音源搜索。
 */
export class ProviderRegistry {
  constructor(config) {
    this.config = config;
    /** @type {Map<string, Provider>} */
    this.byId = new Map();
    /** 权限裁决函数（由 server.js 注入 access.resolveMusicAccess） */
    this.accessResolver = null;
  }

  /**
   * 注入「谁能用哪些源」的裁决器。
   * 只在启动时注入一次；返回 null = 不做限制（内部调用/开关关闭）。
   * @param {(username: string) => ({providerIds: string[]|null, message?: string, reason?: string}|null)} fn
   */
  setAccessResolver(fn) {
    this.accessResolver = typeof fn === 'function' ? fn : null;
  }

  /** 算出这次调用允许用哪些源；null = 不限制 */
  resolveAllowed(username) {
    if (!this.accessResolver) return null;
    const who = username || currentUser();
    if (!who) return null; // 没带用户 = 管理/内部调用（健康探测、探活），不设限
    try {
      const r = this.accessResolver(String(who));
      if (!r) return null;
      return r.providerIds === null || r.providerIds === undefined ? null : new Set(r.providerIds);
    } catch (err) {
      log.warn(`权限裁决失败（${who}）：${err.message}，本次按不限制处理`);
      return null;
    }
  }

  /**
   * 源层白名单（v1.9.119）：这次调用允许用哪些「来源」（kw/kg/tx/mg/wy），**有序**。
   * null = 不限制（开关关 / 系统身份 / 内部调用）。
   * 数组 = 只能按这个优先级顺序挨个命中（用户只绑了部分源时）。
   */
  resolveAllowedSources(username) {
    if (!this.accessResolver) return null;
    const who = username || currentUser();
    if (!who) return null;
    try {
      const r = this.accessResolver(String(who));
      if (!r) return null;
      return Array.isArray(r.sources) ? r.sources : null;
    } catch {
      return null;
    }
  }

  /** 这次调用被拒时的原因（给上层拼人话） */
  denialOf(username) {
    if (!this.accessResolver) return null;
    const who = username || currentUser();
    if (!who) return null;
    try {
      const r = this.accessResolver(String(who));
      if (r && Array.isArray(r.providerIds) && r.providerIds.length === 0) return r;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * v1.9.119 曲目级许可（缓存命中前也要过这道闸！）：
   * provider 层（这个音源可不可用）+ 源层（这首曲目的来源可不可用）。
   * @returns {{ok:boolean, message?:string}}
   */
  trackAllowed(trackId, username = '') {
    let providerId = null;
    let src = '';
    try {
      const dec = decodeTrackId(trackId.replace(/\.(mp3|flac|m4a|aac|ogg|opus|wav)$/i, ''));
      providerId = dec.providerId;
      src = dec.payload?.s || dec.payload?.m?.source || '';
    } catch {
      return { ok: true }; // 解不开的 id 后面 hydrate 会报错，这里不拦
    }
    // v1.9.129：听书曲目（喜马拉雅，providerId=ximalaya）不走音乐源白名单——
    // 音乐三层隔离只管音乐；听书免费区匿名直链是产品设计（v1.9.68），
    // 没绑喜马拉雅时的引导话术在取流层（buildStreamFailHint 听书分支）单独说。
    // 注意曲目 payload.s 可能是 'track'（单集）或 'album'（专辑），不能只看 s。
    if (providerId === 'ximalaya') return { ok: true };
    const allowed = this.resolveAllowed(username);
    // v1.9.123：被闸拦下也要说人话——说清「你绑了什么」+「这首为什么不行」+「怎么办」
    // 先判「源层」再判「音源层」：源层更具体（能点名"它来自酷我"），用户才看得懂。
    const own = this.ownAccountsOf(username);
    const allowedSources = this.resolveAllowedSources(username);
    if (Array.isArray(allowedSources) && src && !allowedSources.includes(src)) {
      const srcCn = SOURCE_CN[src] || src.toUpperCase();
      return {
        ok: false,
        message:
          `这首歌放不了：它来自${srcCn}，你没有绑定这个源。你现在绑定的是：${describeOwn(own)}。` +
          `你可以：1) 去「我的音乐账号」绑定${srcCn}；2) 或者换一首你绑定的源里有的歌。`,
      };
    }
    if (allowed && !allowed.has(providerId)) {
      return {
        ok: false,
        message: own.length
          ? `这首歌放不了：它来自的音源不在你的可用范围内。你现在绑定的是：${describeOwn(own)}。你可以去「我的音乐账号」再绑一个，或开通会员。`
          : noResourceHint(''),
      };
    }
    return { ok: true };
  }

  async load() {
    this.byId.clear();
    const list = this.config.sources || [];
    for (const cfg of list) {
      if (!cfg || !cfg.id) continue;
      let provider;
      try {
        if (cfg.type === 'local') provider = createLocalProvider(cfg);
        else if (cfg.type === 'http') provider = createHttpProvider(cfg);
        else if (cfg.type === 'lxscript') provider = createLxScriptProvider(cfg);
        else if (cfg.type === 'ximalaya') provider = createXimalayaProvider(cfg);
        else {
          log.warn(`未知音源类型：${cfg.type}（${cfg.id}），已跳过`);
          continue;
        }
        await provider.init();
        this.byId.set(cfg.id, provider);
        log.info(`音源已装载：${cfg.id} (${cfg.type}) ${provider.name}`);
      } catch (err) {
        log.error(`音源装载失败：${cfg.id} — ${err.message}`);
      }
    }
    // 二次挂载注册表：lxscript 需要借别的音源来搜歌
    for (const provider of this.byId.values()) {
      try {
        provider.attachRegistry?.(this);
      } catch (err) {
        log.warn(`${provider.id} attachRegistry 失败：${err.message}`);
      }
    }
    return this;
  }

  list() {
    return [...this.byId.values()].map((p) => p.describe());
  }

  get(id) {
    return this.byId.get(id);
  }

  get enabled() {
    return [...this.byId.values()].filter((p) => p.enabled);
  }

  /**
   * 解析 track id 拿到 { provider, payload }
   */
  resolve(trackId) {
    const { providerId, payload } = decodeTrackId(trackId);
    const provider = this.byId.get(providerId);
    if (!provider) throw new Error(`找不到音源 ${providerId}（track id 来自旧配置？）`);
    return { provider, payload };
  }

  /**
   * 把一个 track 还原成"取流所需的最小信息"。
   * Track 本身只带 id，真实信息在 payload 里。
   */
  hydrate(trackId) {
    const { provider, payload } = this.resolve(trackId);
    return {
      ...payload,
      id: trackId,
      providerId: provider.id,
    };
  }

  /**
   * 跨音源搜索。
   * @param {string} keyword
   * @param {number} limit
   * @param {string} [onlySource] 只在某个音源里搜
   * @param {{username?: string}} [opts] 带 username 时按该用户权限过滤音源
   */
  async search(keyword, limit = 10, onlySource = null, opts = {}) {
    const allowed = this.resolveAllowed(opts.username);
    const allowedSources = this.resolveAllowedSources(opts.username); // 源层（kw/kg/tx/mg/wy）白名单，null=不限
    let sources = onlySource
      ? [this.byId.get(onlySource)].filter(Boolean)
      : this.enabled.filter((p) => p.searchSupported || p.searchFrom);
    if (allowed) sources = sources.filter((p) => allowed.has(p.id));

    if (!sources.length) {
      const denial = this.denialOf(opts.username);
      return {
        tracks: [],
        errors: [{ source: '*', error: denial?.message || '没有任何可用音源支持搜索' }],
        denied: Boolean(denial),
        denial,
      };
    }

    const errors = [];
    const tracks = [];

    // v1.9.119 全局按源顺序命中（用户钦定）：allowedSources 在场时，
    // 按源优先级**逐个试**——第一个源出结果就用它，不再往后落；全不落空才换下一个源。
    // （本地目录等无"来源"概念的音源不受源优先级管辖，照常并发并进来。）
    if (Array.isArray(allowedSources) && allowedSources.length) {
      // v1.9.231："这个 provider 能搜哪些源"按**声明源**算（lx 脚本 sourceKeys），
      // 不再按 usefulSources（实测可搜的子集）——否则声明支持 wy 取流的 flower
      // 永远接不到 wy 的搜索路由（用户绑网易云黑胶却搜不到网易云的歌，20:08 实弹）。
      const declaredKeysOf = (p) =>
        (Array.isArray(p.sources) && p.sources.length) ? p.sources
          : (p.runtime && Array.isArray(p.runtime.sourceKeys)) ? p.runtime.sourceKeys
            : (p.usefulSources || []);
      const keyedProviders = sources.filter((p) => declaredKeysOf(p).length);
      const otherProviders = sources.filter((p) => !declaredKeysOf(p).length);
      // source -> provider 首选映射（同一源多个音源支持时取配置序靠前的）
      const providerForSource = new Map();
      for (const p of keyedProviders) {
        for (const k of declaredKeysOf(p)) if (!providerForSource.has(k)) providerForSource.set(k, p);
      }
      const othersPromise = Promise.all(
        otherProviders.map((p) => p.search(keyword, limit).catch((e) => {
          errors.push({ source: p.id, error: e.message });
          return [];
        })),
      );
      let hit = [];
      const failures = [];
      // v1.9.231b mustPlayable 两轮回退：
      //   pass1 只认「强匹配」候选（同名/带歌手都对得上）——酷狗原版拒流就落网易云原版；
      //   pass2 全部候选（翻唱/现场版兜底，避免同名歌全 VIP 时无路可走）。
      // 两轮都按源优先级顺序——保住用户钦定的"A 源优先"。
      const foundBySrc = new Map();
      const searchSrc = async (srcKey) => {
        if (foundBySrc.has(srcKey)) return foundBySrc.get(srcKey);
        let found = [];
        const p = providerForSource.get(srcKey);
        if (p && !(onlySource && p.id !== onlySource)) {
          try {
            found = await p.search(keyword, limit, { allowedSources: [srcKey] }) || [];
          } catch (err) {
            errors.push({ source: `${p.id}/${srcKey}`, error: err.message });
          }
        }
        foundBySrc.set(srcKey, found);
        return found;
      };
      if (opts.mustPlayable) {
        const kw = String(keyword || '').toLowerCase().trim();
        const tokens = kw.split(/\s+/).filter(Boolean);
        const strong = (t) => {
          const title = String(t?.title || '').toLowerCase();
          const artist = String(t?.artist || '').toLowerCase();
          if (!title) return false;
          return title === kw || title.includes(kw) || tokens.every((x) => title.includes(x) || artist.includes(x));
        };
        for (const pass of [1, 2]) {
          for (const srcKey of allowedSources) {
            const found = await searchSrc(srcKey);
            const pool = pass === 1 ? found.filter(strong) : found;
            if (!pool.length) continue;
            const playable = await this.firstPlayable(pool, pass === 1 ? 3 : 2, opts.username, failures, srcKey);
            if (playable) {
              hit = [playable];
              break;
            }
          }
          if (hit.length) break;
        }
      } else {
        for (const srcKey of allowedSources) {
          const p = providerForSource.get(srcKey);
          if (!p) continue;
          if (onlySource && p.id !== onlySource) continue;
          try {
            const found = await p.search(keyword, limit, { allowedSources: [srcKey] });
            if (found && found.length) {
              hit = found;
              break; // 命中即止：不再往后落源
            }
          } catch (err) {
            errors.push({ source: `${p.id}/${srcKey}`, error: err.message });
          }
        }
      }
      tracks.push(...hit);
      for (const list of await othersPromise) tracks.push(...list);
      const seen0 = new Set();
      const deduped0 = [];
      for (const t of tracks) {
        const key = `${(t.title || '').toLowerCase()}|${(t.artist || '').toLowerCase()}`;
        if (seen0.has(key)) continue;
        seen0.add(key);
        deduped0.push(t);
      }
      return { tracks: deduped0, errors, failures };
    }

    // 无源层限制（开关关/内部调用）：老式并发全搜
    for (const provider of sources) {
      try {
        const found = await provider.search(keyword, limit);
        tracks.push(...found);
      } catch (err) {
        errors.push({ source: provider.id, error: err.message });
        log.warn(`音源 ${provider.id} 搜索失败：${err.message}`);
      }
    }

    // 去重：标题+歌手相同的只留第一条（= 优先级高的那条）
    const seen = new Set();
    const deduped = [];
    for (const t of tracks) {
      const key = `${(t.title || '').toLowerCase()}|${(t.artist || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(t);
    }

    // v1.9.231 mustPlayable（无源层限制场景，如管理员/VIP）：强匹配候选先预检，全部失败再翻唱兜底
    if (opts.mustPlayable) {
      const failures = [];
      const kw = String(keyword || '').toLowerCase().trim();
      const tokens = kw.split(/\s+/).filter(Boolean);
      const strong = (t) => {
        const title = String(t?.title || '').toLowerCase();
        const artist = String(t?.artist || '').toLowerCase();
        if (!title) return false;
        return title === kw || title.includes(kw) || tokens.every((x) => title.includes(x) || artist.includes(x));
      };
      const strongPool = deduped.filter(strong);
      let playable = strongPool.length
        ? await this.firstPlayable(strongPool, 4, opts.username, failures, '')
        : null;
      if (!playable) playable = await this.firstPlayable(deduped, 4, opts.username, failures, '');
      return { tracks: playable ? [playable] : [], errors, failures };
    }

    return { tracks: deduped, errors };
  }

  /**
   * v1.9.231：并行预检前 n 条候选，返回第一条真能取到流的；失败的记进 failures。
   * 预检本身会把解析结果留在 provider 缓存里，调用方随后正式取流是热路径。
   */
  async firstPlayable(tracks, n, username, failures, srcKey) {
    const top = (tracks || []).slice(0, Math.max(1, n));
    if (!top.length) return null;
    const checked = await Promise.all(top.map(async (t) => {
      try {
        await this.streamUrlWithFallback(t.id, undefined, { username });
        return { t, ok: true, err: null };
      } catch (err) {
        return { t, ok: false, err };
      }
    }));
    for (const c of checked) {
      if (c.ok) return c.t;
      (failures || []).push({
        source: srcKey,
        title: c.t?.title || '',
        message: c.err?.userMessage || c.err?.message || '取不到音源',
      });
    }
    return null;
  }

  /**
   * provider 排序：有源层白名单时，把"拥有最高优先级源"的 provider 排前面；
   * 没有白名单（系统身份/开关关）保持配置顺序。
   */
  _orderProvidersForSources(sources, allowedSources) {
    if (!Array.isArray(allowedSources) || !allowedSources.length) return sources;
    const rankOf = (p) => {
      // lxscript：它的 usefulSources 与 allowedSources 的最靠前位置
      const own = p.usefulSources || (p.usefulSources === undefined && p.sources) || [];
      let best = Infinity;
      for (const s of own) {
        const i = allowedSources.indexOf(s);
        if (i >= 0 && i < best) best = i;
      }
      // local/http/ximalaya 没有"来源"概念：不干预（保持原位）
      return best === Infinity ? 999 : best;
    };
    return [...sources].sort((a, b) => rankOf(a) - rankOf(b));
  }

  /**
   * 取流：自动补上 provider 要求的请求头。
   * username（v1.9.68）：谁在听。喜马拉雅用它挑登录态（用户自己的 → 系统兜底）。
   */
  async streamUrl(trackId, quality, username = '') {
    const { provider, payload } = this.resolve(trackId);
    const result = await provider.streamUrl({ ...payload, id: trackId }, quality, username);
    if (!result || !result.url) throw new Error(`音源 ${provider.id} 没返回可用的 URL`);
    return result;
  }

  /**
   * 这个用户绑了哪些音乐源/账号（v1.9.123 报错说人话用）。
   *
   * 只读 perSource 的结构，不碰裁决（裁决只在 access.js 一处）——
   * 这里要的是"给用户复述他自己绑了什么"，而不是"允许他听什么"。
   * @returns {Array<{source:string,label:string,isVip?:boolean,hasCookie:boolean}>}
   */
  ownAccountsOf(username) {
    if (!username) return [];
    try {
      const acct = musicAccounts.getMusicAccount(String(username));
      const ps = acct?.perSource || {};
      return Object.keys(ps)
        .filter((k) => k !== 'generic')
        .map((k) => ({
          source: k,
          label: ps[k]?.label || '',
          isVip: ps[k]?.isVip,
          hasCookie: !!ps[k]?.cookie,
        }));
    } catch {
      return [];
    }
  }

  /**
   * 取流（带换源重试）。
   *
   * 为什么需要：音源脚本会挂。表现是"搜得到、取不到"（脚本的 musicUrl 动作失效，
   * 或者它的接口被墙/被限流），用户听到的就是"没声音"。
   * 这时拿歌名+歌手去别的音源再找一遍同一首歌，能取到就照用 —— 用户完全无感。
   *
   * @param {string} trackId 原曲目 id
   * @param {string} quality 目标音质
   * @param {{tried?: string[]}} [opts]
   */
  async streamUrlWithFallback(trackId, quality, opts = {}) {
    // 先解析出曲目与来源（后面多处要用；解析失败也先拿到 isAudiobook=false 的旧行为）
    let resolved0 = null;
    try {
      resolved0 = this.resolve(trackId);
    } catch {
      resolved0 = null;
    }
    const isAudiobook = resolved0?.provider?.type === 'ximalaya' || resolved0?.provider?.id === 'ximalaya';

    // 权限：这次调用允许用哪些源（null = 不限制）
    const allowed = this.resolveAllowed(opts.username);
    const allowedSources = this.resolveAllowedSources(opts.username); // 源层白名单（self 用户=只许自己绑的源）
    const denial = this.denialOf(opts.username);
    // v1.9.129：听书曲目不受音乐域「providerIds 空集」裁决限制（免费区匿名可播是产品设计）
    if (allowed && denial && !isAudiobook) {
      const err = new Error(denial.message || '没有可用的音源权限');
      err.denied = true;
      // v1.9.123：被拒也要说清「绑了什么 + 怎么办」，而不是甩一句泛泛的"不在范围内"
      const own = this.ownAccountsOf(opts.username || currentUser());
      let title = '';
      try {
        const m = this.hydrate(trackId);
        title = m?.t || m?.title || '';
      } catch {
        /* 拿不到标题就不带标题说 */
      }
      err.userMessage = own.length
        ? `${title ? `「${title}」` : '这首歌'}放不了：${denial.message || '你的账号没有可用资源'}。` +
          `你现在绑定的是：${describeOwn(own)}。你可以去「我的音乐账号」再绑一个源，或开通会员。`
        : noResourceHint(title);
      throw err;
    }

    /** 这首曲目的来源在不在允许集（payload.s / m.source）；没有来源概念（local/http）不拦 */
    const trackSourceOf = (payload) => payload?.s || payload?.m?.source || '';
    const sourceOk = (payload) => {
      if (!Array.isArray(allowedSources)) return true;
      const src = trackSourceOf(payload);
      return !src || allowedSources.includes(src);
    };

    let firstErr = null;
    /** 曲目的真实来源（kw/kg/tx…）；取自 payload.s，失败时用来判断「是不是 QQ 音乐没给地址」 */
    let trackSrc = '';
    try {
      const { provider, payload } = resolved0 || this.resolve(trackId);
      trackSrc = trackSourceOf(payload);
      // v1.9.129：听书曲目跳过音乐 providerIds / 源层白名单（理由见 trackAllowed 头部注释）
      if (allowed && !allowed.has(provider.id) && !isAudiobook) {
        const err = new Error(`音源 ${provider.id} 不在你的可用范围内`);
        err.denied = true;
        err.userMessage = denial?.message || err.message;
        throw err;
      }
      // v1.9.119 源层校验：self 用户不许播"没绑定的源"的曲目（哪怕 provider 本身允许）
      if (!isAudiobook && !sourceOk(payload)) {
        const err = new Error(`这首曲目来自「${trackSourceOf(payload) || '未知源'}」，不在你绑定的音乐源范围内`);
        err.denied = true;
        err.userMessage = err.message;
        throw err;
      }
      return await this.streamUrl(trackId, quality, opts.username || '');
    } catch (err) {
      if (err.denied) throw err;
      firstErr = err;
    }

    const meta = (() => {
      try {
        return this.hydrate(trackId);
      } catch {
        return null;
      }
    })();
    if (!meta) throw firstErr;

    const title = meta.t || meta.title || '';
    const artist = meta.a || meta.artist || '';
    if (!title) throw firstErr;

    // v1.9.129：听书曲目不换音乐源——拿书名去音乐引擎搜歌毫无意义。
    // 失败直接抛听书话术（引导绑定喜马拉雅），不进下面的跨源回退循环。
    if (isAudiobook) {
      const first = firstErr.message || '未返回错误信息';
      const err = new Error(`喜马拉雅取不到「${title}」的流：${first}`);
      err.userMessage = buildStreamFailHint({
        title,
        preferred: 'ximalaya',
        preferredSource: 'album',
        first,
        allowedSources,
        ownAccounts: this.ownAccountsOf(opts.username || currentUser()),
      });
      err.code = 'STREAM_UNAVAILABLE';
      throw err;
    }

    const tried = new Set(opts.tried || []);
    tried.add(meta.providerId);
    const keyword = `${title} ${artist}`.trim();

    // v1.9.119 换源也守三层：候选音源按源层优先级排序；搜索传 allowedSources（只搜允许的源）；
    // 取流传 username（换源后依然用「这个人」绑定的身份，不许掉到系统兜底之外串号）。
    const candidates = this._orderProvidersForSources(
      this.enabled.filter((p) => !tried.has(p.id) && (!allowed || allowed.has(p.id)) && (p.searchSupported || p.searchFrom)),
      allowedSources,
    );
    for (const provider of candidates) {
      tried.add(provider.id);
      try {
        const found = await provider.search(keyword, 5, { allowedSources });
        const hit = pickSameSong(found, title, artist);
        if (!hit) continue;
        // 命中的曲目也必须来自允许的源
        const hitSrc = hit.raw?.source || hit.s || '';
        if (Array.isArray(allowedSources) && hitSrc && !allowedSources.includes(hitSrc)) continue;
        const result = await provider.streamUrl({ ...(hit.raw || {}), id: hit.id, ...hit }, quality, opts.username || '');
        if (result?.url) {
          log.warn(
            `「${title}」在 ${meta.providerId} 取流失败（${firstErr.message || '未知原因'}），` +
              `已换源到 ${provider.id} 成功`,
          );
          return { ...result, fallbackFrom: meta.providerId };
        }
      } catch (err) {
        log.debug(`换源到 ${provider.id} 失败：${err.message}`);
      }
    }

    // 全都失败：把第一条错的原因包清楚，别再出现空消息
    // v1.9.122：同时挂一个 userMessage（说人话版），proxy 会优先把它回给 APP/语音
    const first = firstErr.message || '未返回错误信息';
    const err = new Error(`所有音源都取不到「${title}」的流（首选 ${meta.providerId}：${first}）`);
    err.userMessage = buildStreamFailHint({
      title,
      preferred: meta.providerId,
      preferredSource: trackSrc,
      first,
      allowedSources,
      ownAccounts: this.ownAccountsOf(opts.username || currentUser()),
    });
    err.code = 'STREAM_UNAVAILABLE';
    throw err;
  }

  async lyric(trackId) {
    // 歌词内存缓存：同一首歌不用每次都去求酷我/酷狗——
    // 酷我有风控（同 id 连打会被临时拒答），缓存能直接砍掉大半请求量。
    // "取不到"也缓存（短时效），防止 APP 反复重试同一首没词的歌时把风控打醒。
    if (!this._lyricCache) this._lyricCache = new Map();
    const cached = this._lyricCache.get(trackId);
    if (cached) {
      const [data, at, miss] = cached;
      const ttl = miss ? 60_000 : 24 * 3600_000;   // 成功缓存 1 天，失败缓存 1 分钟
      if (Date.now() - at < ttl) return data ? JSON.parse(data) : null;
      this._lyricCache.delete(trackId);
    }
    const { provider, payload } = this.resolve(trackId);
    let result = null;
    try {
      result = await provider.lyric({ ...payload, id: trackId });
    } catch (err) {
      log.warn(`取歌词失败（${provider.id}）：${err.message}`);
    }
    // provider 返回 null 但没抛错时，再试一次跨源歌词兜底（用歌名+歌手直接搜词）
    if (!result) {
      try {
        const { getLyricAny } = await import('../search/lyric.js');
        const alt = await getLyricAny(
          { name: payload?.name || payload?.t || '', singer: payload?.singer || payload?.a || '' },
          ['kw', 'kg', 'wy'],
        );
        if (alt) {
          log.info(`跨源兜底拿到歌词：${payload?.t || trackId.slice(0, 24)}…`);
          result = alt;
        }
      } catch { /* 兜底失败就当没词 */ }
    }
    try {
      this._lyricCache.set(trackId, [result ? JSON.stringify(result) : null, Date.now(), !result]);
    } catch { /* 序列化失败不影响主流程 */ }
    return result;
  }

  async cover(trackId) {
    const { provider, payload } = this.resolve(trackId);
    try {
      return await provider.cover({ ...payload, id: trackId });
    } catch {
      return null;
    }
  }
}
