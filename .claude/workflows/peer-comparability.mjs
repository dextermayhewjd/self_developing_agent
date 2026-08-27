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
        'partial 用于「是同类但关键特征弱」（如有矿但矿只占小头）。第一层 fail 时给 skipped',
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

// ── 候选发现 ──────────────────────────────────────────────────────────
phase('候选发现')
log(`${VARIETY}（${ARCHETYPE}）：找候选，本地优先`)
const found = await agent(
  `你为「${VARIETY}」这个品种找可比候选。目标原型是「${ARCHETYPE}」。

**本地优先是硬规矩**：先跑
\`python3 ${ROOT}/tools/discover_peers.py ${SYMBOL ?? '600549'} --terms ${VARIETY}\`
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
    agent(
      `你判定 ${c.code} ${c.name}（${c.market}）相对「${VARIETY} · ${ARCHETYPE}」的**可比性**，分三层，
**一层不过就停下，不要继续往下查**——第二层要读年报，是最贵的一步，别浪费在已经出局的候选上。

**第一层 · 品种**：它产不产 ${VARIETY}？
读它的主营描述（\`.venv/bin/python -c "import akshare as ak;print(ak.stock_zyjs_ths(symbol='${c.code}'))"\`，
非 A 股则用别的公开来源）。不产 → layer1_variety=fail，直接给 verdict=不可比，返回。

**第二层 · 业务性质**：把本原型的「归属判据」**反过来套在它身上**。
先 Read ${SKILL}/equity-thesis-cn/valuation_archetypes.md 里「${ARCHETYPE}」那一段的「归属判据」，
然后判：**这家公司是不是也属于这个原型**。
⚠️ **同品种 ≠ 同原型**——一家公司可能产这个品种，但它的资产是加工产能而不是本原型要求的那类资产。
这一层需要读年报：用 \`python3 ${ROOT}/tools/fetch_annual_pdf.py ${c.code}\` 或直接找它最新年报，
查关键证据（对耗竭资源型：有无自有矿山、自产比例、成本结构是按要素分还是按产品分）。
不满足归属判据 → layer2_nature=fail。

**第三层 · 披露制度**：它所处的披露制度，是否强制披露本原型的必比口径？
先 Read ${REGIMES}（不存在就当空），看这些口径有没有现成的制度判定。
没有就自己判并**把判定写回该文件**（JSON，键是口径名）：哪些制度强制它、哪些市场不覆盖。
例：C1/AISC 由 NI 43-101（加）、JORC（澳）强制；中国 A 股企业会计准则只要求分部收入/成本，无实物量口径。

**方法论**：先 Read ${SKILL}/equity-thesis-cn/lenses/可比性判定.md——它有八条已验证的会计指纹
（折耗政策、原材料占成本比、该类资产占总资产比、分产品收入有无独立行、分部豁免、自给率、
定价机制表述、专项计提规模）和三条反面判据。**优先用库里的信号**，不够再自己找。
另读原型表本原型的「归属信号」字段（本原型专属）；**若它标着「尚未确定」，
在 signals_source_note 里写明这一点**——不要让台账读者以为本原型的判定与已验证过的原型同等可靠。

**证据要求**：evidence 字段必须指向具体出处（年报页码/章节/原文片段）。
只写「不是矿业公司」这种结论、不给可被推翻的依据，等于没判。

**信号报告（必填）**：把你实际用到的信号逐条填进 used_signals，标明每条是 library（lens/原型表已有）
还是 improvised（你现编的），以及它在本次判定里是决定性还是辅助。库里有但本候选身上查不到的，
填 weight=未命中。**这是系统自我改进的唯一入口，如实报告。**

顺便：能顺手取到的必比口径值（如储量、产能、市值）放进 metrics，**取不到就留空，不要编**。`,
      { label: `判定:${c.name}`, phase: '三层判定', schema: VERDICT }
    ),
)
const ok = (verdicts ?? []).filter(Boolean)
const isAnchor = (v) => ANCHOR && String(v.code).includes(String(ANCHOR))
// 锚自指不进独立同业计数——用锚自己的数去校准锚自己是循环论证。
const comparable = ok.filter((v) => v.verdict === '可比' && !isAnchor(v))
const anchorRow = ok.find(isAnchor)
log(`判定完成 ${ok.length}/${cands.length}；独立可比 ${comparable.length}${anchorRow ? '（另有锚自指 1 家，不计入）' : ''}、部分可比 ${ok.filter((v) => v.verdict === '部分可比').length}、不可比 ${ok.filter((v) => v.verdict === '不可比').length}`)

// ── 口径可得性 + 出台账 ───────────────────────────────────────────────
phase('出台账')
const brief = ok
  .map((v) => `${v.code} ${v.name}｜${v.verdict}｜L1=${v.layer1_variety} L2=${v.layer2_nature} L3=${v.layer3_regime}｜${v.evidence}`)
  .join('\n')
const ledger = await agent(
  `你把「${VARIETY} · ${ARCHETYPE}」的可比性台账落盘到 ${LEDGER_DIR}/ledger.md（先 mkdir -p）。

判定结果（${ok.length} 家）：
${brief}

各家取到的口径值：
${ok.map((v) => `${v.name}: ${(v.metrics ?? []).map((m) => `${m.what}=${m.value}（${m.source}）`).join('; ') || '无'}`).join('\n')}

台账要包含：
1. **判定表**：代码/名称/市值/三层各自结论/最终判定/**依据**。依据必须可回溯，不能只写结论。
2. **可得口径**：只在判定为「可比」的集合上计算。每条标明 **N（实际样本数）**。
3. **不可得口径**：区分「制度性不可得」与「个案未披露」——前者换样本才有用，后者换一家可能就有，两者要写不同的话。

**锚不计入 N**：被研究的标的自己若出现在判定结果里，单列一行标「锚，自指」，**不进独立同业计数**——用锚自己的数校准锚自己是循环论证。每条口径的 N 一律指独立同业数。

**硬规矩：N < 3 时禁止出现「中位数」三个字**，改写成「唯一可比样本」或「N=2 的两点区间」。
用「中位数」包装 N=1 是伪装，正是本系统要消灭的东西。

Read ${SKILL}/equity-thesis-cn/valuation_archetypes.md 里「${ARCHETYPE}」的「必比口径」，逐条给出可得性判定。`,
  { label: '出台账', phase: '出台账', schema: LEDGER },
)

log(`台账：可比 N=${ledger?.n_comparable ?? 0}；可得口径 ${ledger?.obtainable?.length ?? 0} 条、不可得 ${ledger?.unobtainable?.length ?? 0} 条`)

return {
  variety: VARIETY,
  archetype: ARCHETYPE,
  ledger_file: ledger?.written_file ?? `${LEDGER_DIR}/ledger.md`,
  n_comparable: comparable.length, // 独立同业数，已排除锚自指
  anchor_self_listed: Boolean(anchorRow),
  verdicts: ok.map((v) => ({ code: v.code, name: v.name, verdict: v.verdict })),
  obtainable: ledger?.obtainable ?? [],
  unobtainable: ledger?.unobtainable ?? [],
}
