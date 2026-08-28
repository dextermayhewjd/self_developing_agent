export const meta = {
  name: 'peer-comparability',
  description: '可比性台账：候选发现 → 三层判定（品种/业务性质/披露制度）→ 口径可得性 → 台账',
  whenToUse: '需要知道某只票在板块里算什么水平时。可独立跑，也可被 equity-thesis 内联调用为板块基准的数据源。',
  phases: [
    { title: '候选发现', detail: '按品种词找候选，本地优先' },
    { title: '三层判定', detail: '每个候选独立走品种/业务性质/披露制度，一层不过即出局' },
    { title: '口径可得性', detail: '逐条必比口径判：可得 / 个案未披露 / 制度性不可得' },
    { title: '出台账', detail: '算 N，按 N 决定措辞，落盘' },
  ],
}

// 台账按**品种**存，不按标的存——钨板块的台账对所有钨矿标的成立，第二篇报告近乎零成本。
const ROOT = args?.root ?? '/home/hongshi/projects/sda-dev'
const SKILL = `${ROOT}/.claude/skills`
const VARIETY = args?.variety
const ARCHETYPE = args?.archetype
// 锚 = 被研究的标的。必须与「检索起点」分开：首跑时把 600549 同时当两者用，
// 导致 discover_peers 按既有规则把它当标的排除、厦门钨业整个缺席，
// 而真正的标的 03858 反被算进了 n_comparable（锚自指占了 N 的四分之一）。
const ANCHOR = args?.anchor ?? null
const SEED = args?.seed ?? ANCHOR // 检索起点，仅供 discover_peers 用；默认与锚相同
if (!VARIETY || !ARCHETYPE) throw new Error('必须传 args: { variety, archetype }，例如 { variety: "钨", archetype: "耗竭资源型" }')
const LEDGER_DIR = `${ROOT}/data/_peers/${VARIETY}`
const REGIMES = `${ROOT}/data/_peers/_regimes.json`

// ── schema ────────────────────────────────────────────────────────────
// key 走 ASCII（中文键名会让 agent 直接 400），中文说明放 description。

// workflow 脚本没有文件系统 API，读不了原型表。若让每个判定 agent 各自去 Read，
// 编排器就**不知道**当前原型有没有归属信号，也就无法据此改变行为（如强制标注未验证）。
// 一个前置的廉价 agent 把原型表变成结构化数据，之后所有 prompt 从变量插值——
// 既保证 N 个判定 agent 拿到的是同一份配置，也让判别力/未验证这类检查能写在 JS 里。
const ARCHETYPE_CFG = {
  type: 'object',
  required: ['ownership_criteria', 'ownership_signals', 'must_compare'],
  properties: {
    ownership_criteria: { type: 'string', description: '归属判据字段的原文，逐字' },
    ownership_signals: { type: 'string', description: '归属信号字段的原文，逐字。标着「尚未确定」也原样返回，不要替它编' },
    must_compare: { type: 'array', items: { type: 'string' }, description: '必比口径逐条' },
  },
}
const CANDIDATES = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['code', 'name', 'market'],
        properties: {
          code: { type: 'string' }, name: { type: 'string' },
          market: { type: 'string', description: 'CN / HK / US / CA / AU 等' },
          why: { type: 'string', description: '为什么它是候选（一句话）' },
        },
      },
    },
  },
}

// 盘点：跨会话续跑的文件级机制。equity-thesis 8-25 就有（commit 3b8d6e8），
// 本文件写的时候漏抄了——spec 组件 3 明明写了「盘点：已有台账？缓存命中？」。
// 判据同样是「存在且字节数 > 200」。workflow 脚本没有文件系统 API，也不能用 Date.now()
//（会破坏 resume），所以「台账过没过期」由盘点 agent 自己跑 date 比对后返回布尔值。
const INVENTORY = {
  type: 'object',
  required: ['has_nav', 'judged', 'has_ledger'],
  properties: {
    has_nav: { type: 'boolean', description: '制度导航.md 存在且 > 200 字节' },
    judged: {
      type: 'array', items: { type: 'string' },
      description: '判定/ 下已存在且 > 200 字节的文件名（不含 .md 后缀），原样返回不要改写',
    },
    has_ledger: { type: 'boolean', description: 'ledger.md 存在且 > 200 字节' },
    ledger_fresh: {
      type: 'boolean',
      description: '台账是否仍在有效期内（30 天）。跑 date 取今天，与 ledger.md 里的生成日期比。ledger 不存在时给 false',
    },
  },
}

// 制度导航：逐条必比口径 → 由哪类制度强制 → 该制度覆盖哪些市场。
// 这是本设计唯一跨行业成立的规律：口径可得性由披露制度决定，而制度只有约五类
// （证券法定披露 / 行业监管强制 / 专业技术标准 / 自愿行业惯例 / 商业数据库），
// 远少于 15 原型 × 4 口径的手写量。把它提到候选发现之前，就能按市场定向找样本，
// 而不是按品种撒网——钨那轮花了 137 万 token 才发现「A 股全灭、要去 ASX/TSX」。
const REGIME_NAV = {
  type: 'object',
  required: ['metrics', 'target_markets'],
  properties: {
    metrics: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        required: ['what', 'regime_type', 'mandated_by', 'obtainable_markets', 'verdict'],
        properties: {
          what: { type: 'string', description: '必比口径原文' },
          regime_type: {
            type: 'string',
            enum: ['证券法定披露', '行业监管强制', '专业技术标准', '自愿行业惯例', '商业数据库', '无制度产出'],
            description: '这条口径由哪一类制度强制。「无制度产出」用于口径本身要求的东西不由任何披露产生（如成本曲线分位）',
          },
          mandated_by: { type: 'array', items: { type: 'string' }, description: '具体制度名，如 NI 43-101、JORC、银保监《商业银行信息披露办法》' },
          obtainable_markets: { type: 'array', items: { type: 'string' }, description: '该口径可得的市场，如 TSX/ASX/AIM/A股/港股。全都拿不到则空数组' },
          verdict: {
            type: 'string', enum: ['可得', '仅特定市场可得', '制度性不可得', '方法论上不可回溯'],
            description: '方法论上不可回溯=口径要求的东西不由任何披露制度产出，换一百家样本也拿不到',
          },
          note: { type: 'string' },
        },
      },
    },
    target_markets: {
      type: 'array', items: { type: 'string' },
      description: '综合各条口径，候选发现应该去哪些市场找。这是本阶段给下游的导航结果',
    },
    all_unobtainable: { type: 'boolean', description: '若全部必比口径都拿不到，下游可跳过候选发现' },
  },
}

// 三层判定的返回。verdict 是最终结论，三个 layer 字段各自记过没过 + 依据。
// 依据必须能回溯到原文——「不可比」旁边只写结论、不写可被推翻的依据，等于没判。
const VERDICT = {
  type: 'object',
  required: ['code', 'name', 'layer1_variety', 'layer2_nature', 'verdict', 'evidence', 'used_signals'],
  properties: {
    code: { type: 'string' }, name: { type: 'string' },
    market_cap_yi: { type: 'number', description: '总市值（亿元本币），取不到给 null' },
    layer1_variety: { type: 'string', enum: ['pass', 'fail'], description: '第一层：它产不产这个品种' },
    layer2_nature: {
      type: 'string', enum: ['pass', 'partial', 'fail', 'skipped'],
      description:
        '第二层：把本原型的「归属判据」反过来套在它身上，它是不是同一类资产。' +
        'partial 用于「是同类资产但关键特征弱」。第一层 fail 时给 skipped',
    },
    layer3_regime: {
      type: 'string', enum: ['pass', 'fail', 'skipped'],
      description: '第三层：它所处的披露制度是否强制披露本原型的必比口径。前两层未过时给 skipped',
    },
    verdict: { type: 'string', enum: ['可比', '部分可比', '不可比'] },
    evidence: { type: 'string', description: '判定依据，必须指向具体出处（年报页码/章节/原文片段），不能只写结论' },
    used_signals: {
      type: 'array', minItems: 1,
      description:
        '你做这次判定实际用到的信号，逐条列出。这是本系统自我改进的唯一入口：' +
        'source=improvised 且 weight=决定性 的信号是下一轮该固化进信号库的候选；' +
        'library 里有却没能命中的，说明它对本原型不适用。如实报告，' +
        '不要为了显得用了方法论而把现编的说成库里的',
      items: {
        type: 'object',
        required: ['signal', 'source', 'weight'],
        properties: {
          signal: { type: 'string', description: '信号本身，带上具体数值与出处' },
          source: { type: 'string', enum: ['library', 'improvised'], description: 'library=lens 或原型表已有；improvised=你现编的' },
          weight: { type: 'string', enum: ['决定性', '辅助', '未命中'], description: '未命中=库里有这条但本候选身上查不到或不适用' },
        },
      },
    },
    signals_source_note: {
      type: 'string',
      description: '若本原型的「归属信号」字段标着尚未确定，在此写明：第二层判定为模型自由发挥，可靠性未经验证',
    },
    metrics: {
      type: 'array',
      description: '本候选身上取到的必比口径值；取不到就不要编，留空数组',
      items: {
        type: 'object',
        required: ['what', 'value', 'source'],
        properties: { what: { type: 'string' }, value: { type: 'string' }, source: { type: 'string' } },
      },
    },
  },
}

const LEDGER = {
  type: 'object',
  required: ['written_file', 'n_comparable', 'obtainable', 'unobtainable'],
  properties: {
    written_file: { type: 'string', description: '你落盘的 ledger.md 绝对路径' },
    n_comparable: { type: 'integer', description: '判定为「可比」的家数。这是一等产物，不是中位数的附注' },
    obtainable: {
      type: 'array', description: '可得口径及其在可比集合上的取值',
      items: {
        type: 'object',
        required: ['what', 'summary', 'n'],
        properties: {
          what: { type: 'string' }, summary: { type: 'string' },
          n: { type: 'integer', description: '该口径的实际样本数' },
        },
      },
    },
    unobtainable: {
      type: 'array', description: '拿不到的口径，必须区分两种「拿不到」',
      items: {
        type: 'object',
        required: ['what', 'kind', 'why'],
        properties: {
          what: { type: 'string' },
          kind: {
            type: 'string', enum: ['制度性不可得', '个案未披露'],
            description: '制度性不可得=换样本才有用；个案未披露=换一家可能就有。两者要写不同的话',
          },
          why: { type: 'string' },
        },
      },
    },
  },
}

// 候选的 code 形如「NASDAQ: ALM（TSX: AII）」「AIM: GMET / NYSE American: GMTL」，
// 直接当文件名会炸。编排器与 prompt 两侧用同一个确定性函数算安全名，盘点才对得上。
const safeName = (c) =>
  String(c?.code || c?.name || 'unknown')
    .replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'unknown'

// ── 盘点 ──────────────────────────────────────────────────────────────
phase('盘点')
const inv = await agent(
  `只做一件事：盘点 ${LEDGER_DIR}/ 下已有的产物。不做任何分析、不读文件内容做判断、不修改任何文件。

跑 \`ls -la ${LEDGER_DIR}/ ${LEDGER_DIR}/判定/ 2>&1\`，对存在的文件再跑 \`wc -c\`。
判据：**存在且字节数 > 200 才算已完成**，其余一律算未完成；目录不存在就是全空。

台账新鲜度：若 ledger.md 存在，跑 \`date +%Y-%m-%d\` 取今天，
读 ledger.md 里的生成日期（通常在开头），相差 30 天以内给 ledger_fresh=true，否则 false。
ledger.md 不存在时 ledger_fresh 给 false。`,
  { label: '盘点', phase: '盘点', schema: INVENTORY, model: 'haiku', effort: 'low' }
)
const doneNav = inv?.has_nav === true
const doneJudged = new Set(inv?.judged ?? [])
const LEDGER_HIT = inv?.has_ledger === true && inv?.ledger_fresh === true
if (doneNav || doneJudged.size || inv?.has_ledger)
  log(`盘点：制度导航 ${doneNav ? '✓' : '✗'}／已判定 ${doneJudged.size} 家／台账 ${inv?.has_ledger ? (LEDGER_HIT ? '✓ 未过期' : '✓ 但已过期') : '✗'}` +
      ` —— 已完成的跳过，不重跑`)
if (LEDGER_HIT) log('台账命中且未过期：本轮只做校验，不重跑判定')

// ── 读配置 ────────────────────────────────────────────────────────────
phase('读配置')
const cfg = await agent(
  `只做一件事：从 ${SKILL}/equity-thesis-cn/valuation_archetypes.md 里找到「${ARCHETYPE}」那一段，
把 归属判据 / 归属信号 / 必比口径 三个字段**原样**返回。

不要判断、不要发挥、不要替它补全。归属信号若标着「尚未确定」，原样返回那句话——
下游要靠它决定是否标注「本原型判定未经验证」，你替它编就把这个信号抹掉了。`,
  { label: '读配置', phase: '读配置', schema: ARCHETYPE_CFG, model: 'haiku', effort: 'low' }
)
const SIGNALS = cfg?.ownership_signals ?? ''
const SIGNALS_UNVERIFIED = SIGNALS.includes('尚未确定') || !SIGNALS.trim()
log(`原型配置：必比口径 ${cfg?.must_compare?.length ?? 0} 条；归属信号${SIGNALS_UNVERIFIED ? ' **尚未确定——本轮第二层判定为模型自由发挥**' : '已定义'}`)

// ── 制度导航（方案 A）──────────────────────────────────────────────
// 先问「这条口径由什么制度强制」，再决定去哪个市场找候选。
phase('制度导航')
const nav = doneNav
  ? (log('制度导航：已在，跳过'), null)
  : await agent(
  `你为「${VARIETY} · ${ARCHETYPE}」做**制度导航**：逐条判定必比口径由哪类披露制度强制，
据此得出候选发现该去哪些市场。**这一步不找公司、不做可比性判定**，只回答「这些数在哪儿能拿到」。

必比口径（逐条判）：
${(cfg?.must_compare ?? []).map((x, i) => `${i + 1}. ${x}`).join('\n') || '（读取失败，去原型表确认）'}

**先 Read ${REGIMES}**（不存在就当空）。已有条目直接用，不要重判；
没有的自己判，并**把新判定写回该文件**（JSON，键是口径名，值含 mandated_by / not_covered / verdict）。

判定要落到五类制度之一：
- **证券法定披露** —— 各交易所年报准则、CAS/IFRS。覆盖全，但通常只到财务口径
- **行业监管强制** —— 如银保监《商业银行信息披露办法》、保险内含价值报告。覆盖该行业全部且口径统一
- **专业技术标准** —— 如 NI 43-101（加）、JORC（澳）、SEC S-K 1300（美）、SPE-PRMS（油气）。只覆盖采纳该标准的市场，但口径极严
- **自愿行业惯例** —— 如 World Gold Council 的 AISC、SaaS 的 NDR。事实标准但非强制，覆盖看公司自觉
- **商业数据库** —— 如 Wood Mackenzie、CRU、IQVIA。**私有、不可回溯**
- **无制度产出** —— 口径要求的东西不由任何披露产生。典型：「在全球成本曲线的**分位**」——
  单家公司只能披露自己那一个点，**没有任何公司能披露分位**，换一百家样本也拿不到

然后给出 target_markets：**综合各条口径，候选发现应该去哪些市场找**。
例：若关键口径由 NI 43-101/JORC 强制而 A 股不覆盖，target_markets 就该是 TSX/ASX/AIM 而不是 A 股。

**判完落盘到 ${LEDGER_DIR}/制度导航.md**（先 mkdir -p），一行一条口径：
\`- [判定] 口径 ｜ 制度类型 ｜ 强制它的制度 ｜ 可得市场\`，末尾单起一行写 target_markets。
落盘是硬要求——不落盘的话下次续跑要重判一遍。

若全部口径都判为「制度性不可得」或「方法论上不可回溯」，把 all_unobtainable 置 true——
下游会跳过候选发现，直接出一份说明为什么答不了的台账。**这不是失败，是省下无意义的检索。**`,
  { label: '制度导航', phase: '制度导航', schema: REGIME_NAV }
)
const TARGET_MARKETS = nav?.target_markets ?? []
// 导航被跳过时编排器手上没有 target_markets（它在磁盘上），让下游 agent 自己去读那份文件。
const NAV_HINT = nav
  ? `**制度导航已定的目标市场：${TARGET_MARKETS.join(' / ') || '（未定，本地优先）'}**`
  : `**制度导航结论已在 ${LEDGER_DIR}/制度导航.md，先 Read 它拿目标市场清单**`
const ALL_UNOBTAINABLE = nav?.all_unobtainable === true
log(`制度导航：口径 ${nav?.metrics?.length ?? 0} 条；目标市场 ${TARGET_MARKETS.join('/') || '（未定）'}` +
    (ALL_UNOBTAINABLE ? ' —— 全部不可得，跳过候选发现' : ''))

// ── 候选发现 ──────────────────────────────────────────────────────────
phase('候选发现')
log(`${VARIETY}（${ARCHETYPE}）：找候选，本地优先`)
const found = ALL_UNOBTAINABLE
  ? (log('候选发现：全部必比口径不可得，跳过'), null)
  : await agent(
  `你为「${VARIETY}」这个品种找可比候选。目标原型是「${ARCHETYPE}」。

${NAV_HINT}
按这个市场清单找，不要在导航判为不覆盖的市场上撒网——那是上一轮花了 137 万 token
才发现的教训（A 股钨业全灭是制度性的，不是找得不够仔细）。

**本地优先是硬规矩**：先跑
\`python3 ${ROOT}/tools/discover_peers.py ${SEED ?? '600549'} --terms ${VARIETY}\`
它会产出候选（每条带主营节选与 hint，keep 恒为 null——脚本不做判定，判定在下一阶段）。

本地通道取不到的（境外同业）才允许 WebSearch。**这一步只管找出候选，不要判它可不可比**——
判定是下一阶段的事，你在这里下结论会让三层判定失去意义。

把找到的候选原样返回，含代码、名称、市场、以及一句话说明为什么它是候选。`,
  { label: '候选发现', phase: '候选发现', schema: CANDIDATES }
)
const cands = found?.candidates ?? []
log(`候选 ${cands.length} 家：${cands.map((c) => c.name).join('、')}`)

// ── 三层判定（pipeline：候选之间无依赖，不设 barrier；fail-fast 省钱）──
phase('三层判定')
const verdicts = await pipeline(
  cands,
  (c) =>
    doneJudged.has(safeName(c))
      ? (log(`判定:${c.name} 已在，跳过`), { code: c.code, name: c.name, verdict: '已有判定', skipped: true, _file: `${LEDGER_DIR}/判定/${safeName(c)}.md` })
      : agent(
      `你判定 ${c.code} ${c.name}（${c.market}）相对「${VARIETY} · ${ARCHETYPE}」的**可比性**，分三层，
**一层不过就停下，不要继续往下查**——第二层要读年报，是最贵的一步，别浪费在已经出局的候选上。

**第一层 · 品种**：它产不产 ${VARIETY}？
读它的主营描述（\`.venv/bin/python -c "import akshare as ak;print(ak.stock_zyjs_ths(symbol='${c.code}'))"\`，
非 A 股则用别的公开来源）。不产 → layer1_variety=fail，直接给 verdict=不可比，返回。

**第二层 · 业务性质**：把本原型的「归属判据」**反过来套在它身上**。
先 Read ${SKILL}/equity-thesis-cn/valuation_archetypes.md 里「${ARCHETYPE}」那一段的「归属判据」，
然后判：**这家公司是不是也属于这个原型**。
⚠️ **同品种 ≠ 同原型**——一家公司可能产这个品种，但它的资产是加工产能而不是本原型要求的那类资产。
**本原型的归属判据（原文）**：${cfg?.ownership_criteria ?? '（读取失败，去原型表自行确认）'}

**本原型的归属信号（查什么）**：
${SIGNALS || '（未定义）'}
${SIGNALS_UNVERIFIED
  ? '⚠️ **本原型的归属信号尚未确定** —— 你要按 lens 的方法自己从归属判据推出该查什么痕迹，'
    + '并在 signals_source_note 里如实写明「本原型判定为模型自由发挥、可靠性未经验证」。'
  : ''}

这一层通常需要读年报：用 \`python3 ${ROOT}/tools/fetch_annual_pdf.py ${c.code}\` 或直接找它最新年报。
不满足归属判据 → layer2_nature=fail，并写明它实际属于哪个原型。

**第三层 · 披露制度**：它所处的披露制度，是否强制披露本原型的必比口径？
先 Read ${REGIMES}（不存在就当空），看这些口径有没有现成的制度判定。
没有就自己判并**把判定写回该文件**（JSON，键是口径名）：哪些制度强制它、哪些市场不覆盖。
例：C1/AISC 由 NI 43-101（加）、JORC（澳）强制；中国 A 股企业会计准则只要求分部收入/成本，无实物量口径。

**方法论**：先 Read ${SKILL}/equity-thesis-cn/lenses/可比性判定.md——它给的是**跨原型通用的方法**
（归属判据的每个要件→找报表里的痕迹）和三条反面判据。本原型该查哪些具体痕迹，见上面的「归属信号」。

**证据要求**：evidence 字段必须指向具体出处（年报页码/章节/原文片段）。
只写「不属于这个原型」这种结论、不给可被推翻的依据，等于没判。

**信号报告（必填）**：把你实际用到的信号逐条填进 used_signals，标明每条是 library（lens/原型表已有）
还是 improvised（你现编的），以及它在本次判定里是决定性还是辅助。库里有但本候选身上查不到的，
填 weight=未命中。**这是系统自我改进的唯一入口，如实报告。**

顺便：能顺手取到的必比口径值（如储量、产能、市值）放进 metrics，**取不到就留空，不要编**。

**判完必须落盘到 ${LEDGER_DIR}/判定/${safeName(c)}.md**（先 mkdir -p），写清三层各自结论、
最终判定、以及可回溯的依据原文。**这是断点续跑的唯一凭据**——不落盘的话，
下次被中断重跑时你这一家要从头再判一遍。`,
      { label: `判定:${c.name}`, phase: '三层判定', schema: VERDICT }
    ),
)
const ok = (verdicts ?? []).filter(Boolean)
// 跳过的家没有本轮的真值判定（结论在磁盘上），不参与判别力与计数统计——
// 但它们的文件仍在，出台账的 agent 会读全部 判定/*.md。
const fresh = ok.filter((v) => !v.skipped)
// 判别力：一组信号若没能把任何候选分开（全过或全不过），它不是信号，是废话。
// 这时交出的台账看起来正常，实则毫无判别依据——与「用中位数包装 N=1」同类的伪装。
const kinds = new Set(fresh.map((v) => v.verdict))
const NO_DISCRIMINATION = fresh.length >= 3 && kinds.size <= 1
if (NO_DISCRIMINATION)
  log(`⚠️ 判别力为零：${ok.length} 个候选全部判为「${[...kinds][0]}」。` +
      `本原型的归属信号没能区分任何候选${SIGNALS_UNVERIFIED ? '（且该原型信号尚未确定）' : ''}，` +
      `台账须写明此点，不得当作正常结果交付。`)
const isAnchor = (v) => ANCHOR && String(v.code).includes(String(ANCHOR))
// 锚自指不进独立同业计数——用锚自己的数去校准锚自己是循环论证。
const comparable = ok.filter((v) => v.verdict === '可比' && !isAnchor(v))
const anchorRow = ok.find(isAnchor)
log(`判定完成 ${ok.length}/${cands.length}；独立可比 ${comparable.length}${anchorRow ? '（另有锚自指 1 家，不计入）' : ''}、部分可比 ${ok.filter((v) => v.verdict === '部分可比').length}、不可比 ${ok.filter((v) => v.verdict === '不可比').length}`)

// ── 口径可得性 + 出台账 ───────────────────────────────────────────────
phase('出台账')
const brief = fresh
  .map((v) => `${v.code} ${v.name}｜${v.verdict}｜L1=${v.layer1_variety} L2=${v.layer2_nature} L3=${v.layer3_regime}｜${v.evidence}`)
  .join('\n')
const ledger = await agent(
  `你把「${VARIETY} · ${ARCHETYPE}」的可比性台账落盘到 ${LEDGER_DIR}/ledger.md（先 mkdir -p）。

**先 Read ${LEDGER_DIR}/判定/ 下的全部 *.md** —— 那里有本品种**历次**判定的完整结论，
包含本轮跳过（上轮已判）的那些家。下面只是本轮新判的摘要，不是全集。

本轮新判（${fresh.length} 家，另有 ${ok.length - fresh.length} 家沿用已有判定）：
${brief}

各家取到的口径值：
${fresh.map((v) => `${v.name}: ${(v.metrics ?? []).map((m) => `${m.what}=${m.value}（${m.source}）`).join('; ') || '无'}`).join('\n')}

台账要包含：
1. **判定表**：代码/名称/市值/三层各自结论/最终判定/**依据**。依据必须可回溯，不能只写结论。
2. **可得口径**：只在判定为「可比」的集合上计算。每条标明 **N（实际样本数）**。
3. **不可得口径**：区分「制度性不可得」与「个案未披露」——前者换样本才有用，后者换一家可能就有，两者要写不同的话。

**锚不计入 N**：被研究的标的自己若出现在判定结果里，单列一行标「锚，自指」，**不进独立同业计数**——用锚自己的数校准锚自己是循环论证。每条口径的 N 一律指独立同业数。

**硬规矩：N < 3 时禁止出现「中位数」三个字**，改写成「唯一可比样本」或「N=2 的两点区间」。
用「中位数」包装 N=1 是伪装，正是本系统要消灭的东西。

**制度导航结论（已判定，直接采用，不要重判）**：
${(nav?.metrics ?? []).map((m) => `- ${m.what} ｜ ${m.verdict} ｜ ${m.regime_type} ｜ 可得市场：${(m.obtainable_markets ?? []).join('/') || '无'}`).join('\n') || '（导航失败）'}
${ALL_UNOBTAINABLE ? '\n⚠️ **全部必比口径不可得，本轮未做候选发现。台账的任务是说明「为什么这个板块的这些问题答不了」，而不是凑一张表。**' : ''}

本原型的必比口径（结合上面的导航结论，逐条给可得性判定）：
${(cfg?.must_compare ?? []).map((x, i) => `${i + 1}. ${x}`).join('\n') || '（读取失败，去原型表确认）'}
${SIGNALS_UNVERIFIED ? '\n⚠️ **本原型的归属信号尚未确定，第二层判定为模型自由发挥** —— 台账开头必须写明这一点。' : ''}
${NO_DISCRIMINATION ? '\n⚠️ **本轮判别力为零**（所有候选判定相同）—— 台账必须写明信号未能区分任何候选，不要当正常结果呈现。' : ''}`,
  { label: '出台账', phase: '出台账', schema: LEDGER },
)

log(`台账：可比 N=${ledger?.n_comparable ?? 0}；可得口径 ${ledger?.obtainable?.length ?? 0} 条、不可得 ${ledger?.unobtainable?.length ?? 0} 条`)

return {
  variety: VARIETY,
  archetype: ARCHETYPE,
  ledger_file: ledger?.written_file ?? `${LEDGER_DIR}/ledger.md`,
  n_comparable: comparable.length, // 独立同业数，已排除锚自指
  anchor_self_listed: Boolean(anchorRow),
  target_markets: TARGET_MARKETS,
  regime_verdicts: (nav?.metrics ?? []).map((m) => ({ what: m.what, verdict: m.verdict, regime: m.regime_type })),
  all_unobtainable: ALL_UNOBTAINABLE,
  signals_unverified: SIGNALS_UNVERIFIED,
  no_discrimination: NO_DISCRIMINATION,
  verdicts: ok.map((v) => ({ code: v.code, name: v.name, verdict: v.verdict })),
  obtainable: ledger?.obtainable ?? [],
  unobtainable: ledger?.unobtainable ?? [],
}
