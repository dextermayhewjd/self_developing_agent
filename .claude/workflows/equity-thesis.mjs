export const meta = {
  name: 'equity-thesis',
  description: '判断型研究报告：立疑 → 五 lens 并行挖掘（板块基准同槽并行）、每份即时核查 → 补参照系 → 成稿',
  whenToUse: 'equity-thesis-cn 的步骤 2–4。步骤 0（读档案）与步骤 5–6（写档案、跑校验器）留在 skill 里由编排器做。',
  phases: [
    { title: '立疑', detail: '看财务全景判估值原型（15 选 1）、立 2–4 条决策形状的疑惑' },
    { title: '挖掘', detail: '五个 lens 并行读年报各自标出承重数字；板块基准 agent 同槽并行取同业口径' },
    { title: '核查', detail: '每份 findings 一产出就核查，不堆到尾部' },
    { title: '补参照系', detail: '只对核查判为私有基准/无参照系的承重数逐条接地，一条都没有就跳过' },
    { title: '成稿', detail: '只读 findings 与已核实清单，统一口吻写全文' },
  ],
}

// 仓库根：可由 args.root 覆盖，以便在不同 worktree（如港股分支）跑同一个 workflow。
// 不传则沿用原路径，既有调用方式不受影响。
// 为什么不用相对路径：workflow 脚本没有文件系统 API，拿不到 cwd；把裸相对路径写进
// prompt 就等于赌每个 agent 的 cwd 不漂。而 agent 在流程中会 cd 去读 guide 和 data，
// cwd 漂了不报错，产物会静静落在别处——SKILL.md 里那条「一律用绝对路径」正是为此。
const ROOT = args?.root ?? '/home/hongshi/projects/sda-dev'
const SKILL = `${ROOT}/.claude/skills`
const LENSES = [
  { key: '财务排雷', guide: `${SKILL}/financial-redflags-cn/SKILL.md`, sections: '第四节' },
  { key: '尽调',     guide: `${SKILL}/equity-thesis-cn/lenses/尽调.md`,     sections: '第一、二、三节' },
  { key: '产业',     guide: `${SKILL}/equity-thesis-cn/lenses/产业.md`,     sections: '第五、六节' },
  { key: '竞争',     guide: `${SKILL}/equity-thesis-cn/lenses/竞争.md`,     sections: '第七节' },
  { key: '战略驱动', guide: `${SKILL}/equity-thesis-cn/lenses/战略驱动.md`, sections: '第八、九、十节' },
]

const SYMBOL = args?.symbol
const DATE = args?.date
if (!SYMBOL || !DATE) throw new Error('必须传 args: { symbol, date }，例如 { symbol: "601678", date: "20260819" }')
const RUN = `${ROOT}/reports/${SYMBOL}_thesis_${DATE}`
const DATA = `${ROOT}/data/${SYMBOL}`

// schema 的 property key 必须匹配 ^[a-zA-Z0-9_.-]{1,64}$——中文键名会让 agent 直接 400。
// 所以 key 走 ASCII，中文说明放 description。
const DOUBT = {
  type: 'object',
  required: ['archetype', 'doubts', 'written_file'],
  properties: {
    // 从自然语言的行业名改为 15 选 1 的估值原型：原型表同时承载估值方法、
    // 必比口径和排雷阈值变体，一个分类喂三处（五个 lens + 板块基准 agent）。
    archetype: {
      type: 'string',
      // enum 而不是自由字符串：下游（五个 lens 选阈值/口径/方法、板块基准 agent 读
      // 「必比口径」派活、tests/test_archetypes.py）全都拿它当枚举用，写成
      // 「耗竭资源型（钨矿）」这种带注解的串会静默配错——它不匹配任何一段原型，
      // 于是每个消费者各自退化，没有一处报错。schema 校验在这里挡住，比事后查便宜。
      // 这 15 个值必须与 valuation_archetypes.md 的段标题逐字相同（含"型"字）；
      // 改动时不要手打，从那份文件抄，tests/test_archetypes.py 会逐字比对两边。
      enum: [
        '耗竭资源型', '周期加工型', '稳态现金流型', '成长渗透型',
        '研发管线型', '平台网络型', '项目制工程型', '金融息差型',
        '金融承保型', '金融资本型', '重资产公用型', '地产存货型',
        '持有型不动产', '渠道分销型', '亏损未验证型',
      ],
      description:
        '估值原型，必须是 valuation_archetypes.md 里 15 个原型名之一（原样抄，含"型"字，不要加括号注解）。' +
        '这个判定会传给每个 lens 用来选阈值/口径/方法，也决定板块基准 agent 去比哪几个口径。判错会让五个 lens 一起错。',
    },
    doubts: {
      type: 'array', minItems: 2, maxItems: 4,
      items: {
        type: 'object',
        required: ['question', 'why_decision', 'assign_to'],
        properties: {
          question: { type: 'string', description: '疑惑本身' },
          why_decision: { type: 'string', description: '这个问题的答案怎样直接改变买不买' },
          assign_to: { type: 'string', description: '指向哪个 lens 去查' },
        },
      },
    },
    written_file: { type: 'string', description: '你落盘的 疑惑.md 绝对路径' },
  },
}

// findings 全文落文件，schema 只回摘要 + 承重数字。
// 教训：把全文塞进 return 会撑爆编排器上下文（2026-08-19 实测 return 被截断 10 万字符）。
const FINDINGS = {
  type: 'object',
  required: ['written_file', 'key_points', 'load_bearing', 'uncertain'],
  properties: {
    written_file: { type: 'string', description: '你落盘的 findings/{名}.md 绝对路径' },
    key_points: { type: 'array', items: { type: 'string' }, description: '判断要点，bullet' },
    load_bearing: {
      type: 'array', minItems: 1, maxItems: 6,
      description: '你这份里最承重的数字：错了会让某一节判断方向反过来的那几个',
      items: {
        type: 'object',
        required: ['what', 'value', 'source', 'benchmark'],
        properties: {
          what: { type: 'string' }, value: { type: 'string' }, source: { type: 'string' },
          // source 记录「数从哪来」，benchmark 记录「跟什么比才有意义」——这是两件事。
          // 03858 实测：五条承重数字全部回原文核实通过，但没有一条比过外部同口径，
          // 于是「2.31–3.25 倍 NAV 算不算贵」这个全篇最承重的判断始终悬空。
          benchmark: {
            type: 'string',
            description:
              '这个数的参照系：跟什么比才有意义。不是它值多少，是拿它跟谁比。' +
              '例：「市值 = ITR 税后 NPV 的 2.31–3.25 倍」的参照系应是同板块在产矿企的 P/NAV 中位数。' +
              '想不出外部参照系就写「想不到外部参照系」——不要编一个出来。',
          },
        },
      },
    },
    uncertain: { type: 'array', items: { type: 'string' }, description: '不确定项，必须有' },
  },
}

const VERIFIED = {
  type: 'object',
  required: ['checked'],
  properties: {
    checked: {
      type: 'array',
      items: {
        type: 'object',
        required: ['what', 'verdict', 'verified_value', 'source', 'benchmark_type'],
        properties: {
          what: { type: 'string' },
          verdict: { enum: ['确认无误', '修正', '未披露', '未查到'] },
          verified_value: { type: 'string', description: '含单位与正负号；修正的填修正后的值' },
          source: { type: 'string', description: '年报 p.XX / {file}.json 字段' },
          // 核查的第二个动作。verdict 回答「抄对没有」，benchmark_type 回答「这个数在外面算什么水平」。
          // 只有前者时，一份全部「确认无误」的核查照样可以支撑一个悬空的判断。
          // 私有基准 = 标的公司自己或其委托方产出的数：独立技术报告、招股章程里的委托咨询、
          // 公司自己的规划与指引。抄对了不等于可以拿来当尺子。
          // 五档与 tools/benchmark_lib.py 的 STRENGTHS 逐字节相同（中间是 U+00B7 的「·」）——
          // 旧的「外部同口径」拆成前两档：联网放行后"搜来的"与"本地算出来的"可核实性差一个
          // 量级，不能同档。后两档会触发下游的补参照系 agent。
          benchmark_type: {
            enum: ['外部·可回溯', '外部·单源未交叉', '外部但口径存疑', '私有基准', '无参照系'],
            description:
              '判据只看这个数的参照系来自哪里，与数本身对错无关：' +
              '外部·可回溯=有可比同业/同板块的同一口径数，且来自本地数据层或 >=2 个独立来源对得上；' +
              '外部·单源未交叉=有外部的同口径数但只有一个来源；' +
              '外部但口径存疑=有外部数但口径对不齐（含"宽池子且池内无同品种"）；' +
              '私有基准=参照系由标的公司或其委托方产生；无参照系=压根没有可比对象。',
          },
        },
      },
    },
  },
}

// 板块基准与补参照系共用。url/verbatim/fetched_date 是结构性护栏——
// debug-equity-thesis:92 记录过教训：prose 禁令无效（加禁令后越权反升到 299 次），
// 所以联网留痕靠 schema 校验强制，不靠叮嘱。
// strength 的五个字面量必须与 tools/benchmark_lib.py 的 STRENGTHS 逐字节相同：
// check_thesis 硬约束 7 按这五个串精确匹配，错一个码位（例如把 U+00B7 的「·」打成
// U+30FB 的片假名中点或 U+2022 的项目符号）就静默失配——参照系文件照写不误，硬门却当它不存在。
const BENCHMARK = {
  type: 'object',
  required: ['written_file', 'items'],
  properties: {
    written_file: { type: 'string', description: '你落盘的 参照系/*.md 绝对路径' },
    items: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        required: ['what', 'value', 'strength', 'source'],
        properties: {
          what: { type: 'string', description: '这个数是什么。落盘与下游匹配都以它为键，用词要稳定' },
          value: { type: 'string' },
          strength: {
            type: 'string',
            enum: ['外部·可回溯', '外部·单源未交叉', '外部但口径存疑', '私有基准', '无参照系'],
            description:
              '本地数据层算出来的直接给「外部·可回溯」；搜来的若只有一个来源给「外部·单源未交叉」；' +
              '宽池子且池内无同品种一律「外部但口径存疑」，不得据此算"是中值 N 倍"',
          },
          source: { type: 'string', description: '出处。联网所得必须是 URL' },
          verbatim: { type: 'string', description: '联网所得必填：逐字原文片段' },
          fetched_date: { type: 'string', description: '联网所得必填：抓取日期 YYYY-MM-DD' },
        },
      },
    },
  },
}

// 补参照系专用：与 BENCHMARK 同形，但 items 允许为空、written_file 非必填。
// 它现在总是被派出，"一条悬空的都没有"是合法结果，不该逼它编条目或落一个空文件。
// 为什么不直接放开 BENCHMARK 的 minItems：那会连板块基准的下限一起撤掉。
// 空产出的正确形态是**根本不建目录**，不是建一个空目录——benchmark_lib
// .collect_benchmarks 把"参照系/ 存在但零条目"判为工序空跑并直接拦稿（复审 C2(b)）。
const BENCHMARK_FILL = {
  type: 'object',
  required: ['items'],
  properties: {
    written_file: {
      type: 'string',
      description: '你落盘的 参照系/补.md 绝对路径。一条都没接上时可以不落盘，此项留空',
    },
    items: { ...BENCHMARK.properties.items, minItems: 0 },
  },
}

const REPORT = {
  type: 'object',
  required: ['written_file', 'rating', 'decisive_variable'],
  properties: {
    written_file: { type: 'string', description: 'report.md 绝对路径' },
    rating: { type: 'string', description: '五维均分与字母评级' },
    decisive_variable: { type: 'string', description: '收敛到的那一个决定性变量' },
  },
}

// ── 步骤 1.5：盘点（跨会话续跑的关键）──────────────────────────────
// 为什么要专门花一个 agent 去做 ls：workflow 脚本没有文件系统 API，而 resumeFromRunId 的
// journal 是按「会话目录」存的——会话一换（例如本次被切成后台 job，session-id 变了），
// 缓存整个消失，只能从头重跑。而且 resume 只认「最长未变前缀」：pipeline 的 stage-2 是按
// stage-1 完成先后发起的，两次跑的发起顺序天然不同，前缀一断后面全部重跑（20260821 实测
// 5 个核查 agent 命中 2 个、重跑 3 个，prompt 逐字节相同也没用）。
// 所以韧性不在 journal，在三件套：产物落到 reports/ 下（不随会话 ID 漂）+ 开跑前盘一次 +
// 已完成的阶段直接跳过。三缺一都不成立——尤其是「只存盘不盘点」，脚本读不回来，照跑不误。
const INVENTORY = {
  type: 'object',
  required: ['has_doubt', 'findings_done', 'checked_done'],
  properties: {
    has_doubt: { type: 'boolean', description: '疑惑.md 存在且字节数 > 200' },
    findings_done: {
      type: 'array', items: { type: 'string' },
      description: 'findings/ 下已存在且字节数 > 200 的 lens 名（不含 .md 后缀）',
    },
    checked_done: {
      type: 'array', items: { type: 'string' },
      description: '核查/ 下已存在且字节数 > 200 的 lens 名（不含 .md 后缀）',
    },
    // 不盘这一项，跨会话续跑会把板块基准整个重跑一遍（含同业检索与联网）。
    bench_done: {
      type: 'array', items: { type: 'string' },
      description: '参照系/ 下已存在且字节数 > 200 的文件名（不含 .md），只可能是 板块基准、补',
    },
  },
}

phase('盘点')
const inv = await agent(
  `只做一件事：盘点 ${RUN}/ 下已有的产物。不做任何分析、不读文件内容、不修改任何文件。

跑 \`ls -la ${RUN}/ ${RUN}/findings/ ${RUN}/核查/ ${RUN}/参照系/ 2>&1\`，对存在的文件再跑 \`wc -c\`。
判据：**存在且字节数 > 200 才算已完成**，其余一律算未完成；目录不存在就是全空。
lens 名只可能是这五个：${LENSES.map((l) => l.key).join('、')}；
参照系/ 下的文件名只可能是这两个：板块基准、补。`,
  { label: '盘点', phase: '盘点', schema: INVENTORY, model: 'haiku', effort: 'low' }
)
const doneDoubt = inv?.has_doubt === true
const doneFindings = new Set(inv?.findings_done ?? [])
const doneChecked = new Set(inv?.checked_done ?? [])
const doneBench = new Set(inv?.bench_done ?? []).has('板块基准')
if (doneDoubt || doneFindings.size || doneChecked.size || doneBench)
  log(
    `盘点：疑惑 ${doneDoubt ? '✓' : '✗'}／findings ${doneFindings.size}/${LENSES.length}` +
      `／核查 ${doneChecked.size}/${LENSES.length}／板块基准 ${doneBench ? '✓' : '✗'}` +
      ` —— 已完成的跳过，不重跑`
  )

// ── 步骤 2：立疑（判断由 agent 做，不写死）──────────────────────────
phase('立疑')
log(`${SYMBOL} 立疑：先看财务全景，再从数字里逼出疑惑`)
const doubt = doneDoubt ? (log('立疑：疑惑.md 已在，跳过'), null) : await agent(
  `你为 ${SYMBOL} 做判断型研究的立疑工序。报告日 ${DATE}。

先读 ${DATA}/aggregate.json 的 financials_annual / financials_quarterly，把近三年+最新季报的
增长与费用 / 回报与结构 / 营运与现金三组指标摊开看一遍。**先看财务全景，再立疑**——
疑惑要从数字里逼出来，不是从主营业务描述里憋出来。

两件事：
1. 读 ${SKILL}/equity-thesis-cn/valuation_archetypes.md，判本票属于 15 个估值原型中的哪一个。
   **原型名原样抄**（含"型"字），不要自己造词、也不要写自然语言的行业名。
   这个原型会传给每个 lens 用来选对阈值、TAM 口径和估值方法，还决定板块基准 agent
   去比哪几个口径（每段的「必比口径」）。判错会让五个 lens 一起错。
   **混业公司只能选一个原型**：横跨两类的（矿山+冶炼、地产开发+持有型不动产），
   按**本次承重结论压在哪块资产上**二选一，并在 ${RUN}/疑惑.md 里写明为何这样选。
2. 立 2–4 条疑惑，写进 ${RUN}/疑惑.md（先 mkdir -p）。
   **该文件第一行必须是 \`估值原型：<你的判定>\`**，第二行起才写疑惑——
   下游五个 lens 与板块基准 agent 都只从这个文件读原型与疑惑，不经我转手。

**疑惑要是"决策形状"的，不是"审计形状"的。** 判据：这个问题的答案会不会直接改变我买不买。
"这家公司的<某条业务线>能不能<达到某个量级/增速>？"是好形状——可证伪、有量级、答案直接决定估值。
"利润为什么塌了""毛利率去哪了"是排查项，不占疑惑清单的位置。
写完自检：某条疑惑无论答"是"还是"否"结论都不变，就删掉它。`,
  { label: '立疑', phase: '立疑', schema: DOUBT }
)

if (doubt) log(`估值原型：${doubt.archetype}；疑惑 ${doubt.doubts?.length ?? 0} 条`)

// ── 步骤 3+3.5：pipeline——每份 findings 一产出就核查，不等其他 lens ──
// round4/5 实测：核查排在第 265/298 次调用，之后已无预算写稿。
// pipeline 让核查与其余 lens 的挖掘重叠，从结构上避免堆到尾部。
// 疑惑不由编排器转手：每个 agent 自己 Read ${RUN}/疑惑.md。这里曾有一个只赋值、
// 没有任何 prompt 引用的疑惑摘要变量，留着会让人误以为编排器在传疑惑，已删。

// 一级：挖掘
const digStage = (l) =>
    doneFindings.has(l.key)
      ? { written_file: `${RUN}/findings/${l.key}.md`, skipped: true }
      : agent(
      `你是 ${SYMBOL} 的${l.key}子 agent，覆盖${l.sections}。报告日 ${DATE}。

**先 Read ${RUN}/疑惑.md**：第一行是估值原型，按这个原型选阈值/口径/方法——该原型的失效指标、
必做分析与排雷阈值变体见 ${SKILL}/equity-thesis-cn/valuation_archetypes.md 里同名那一段；
其余是本次要回答的疑惑——不必全答，答与你这一节相关的。

读 ${l.guide} 并严格遵循它的关键动作与输出契约。数据在 ${DATA}/。

把完整发现写到 ${RUN}/findings/${l.key}.md（先 mkdir -p）。
**文件末尾必须留一节 \`## 承重数字（待核查）\`**，逐条写 what / value / source / benchmark，共 1–6 条，
判据是"这个数错了，某一节的判断方向会反过来"。
**benchmark 是参照系**：这个数跟什么比才有意义（例：单位成本要跟同板块成本曲线比，
估值倍数要跟同板块同口径倍数比）。想不出外部参照系就写"想不到外部参照系"，不要编。
**核查子 agent 只认这一节**——
写在正文里而没进这一节，等于没提交。
返回值给同样的摘要（判断要点、不确定项、承重数字），但下游一律以文件为准。
查不到的直说，不要填满。`,
      { label: `挖掘:${l.key}`, phase: '挖掘', schema: FINDINGS }
    )

// 二级：核查——同一 lens 的 findings 一落地就开核，不等其他 lens
const checkStage = (f, l) =>
    f == null
      ? null
      : doneChecked.has(l.key)
      ? { lens: l.key, findings: f, checked: [], skipped: true }
      : agent(
          `你是核查子 agent。读 ${SKILL}/equity-thesis-cn/lenses/核查.md 并遵循。

**先 Read ${RUN}/findings/${l.key}.md 末尾的 \`## 承重数字（待核查）\` 一节**，
把那一节里的每个数逐条**做两件事**：

**动作一：回原文核**——逐字抄原文，含单位与正负号。这回答"抄对没有"。
**动作二：判参照系类型**——这回答"这个数在外面算什么水平"。五选一，**逐字照抄下面的写法**
（中间那一点是「·」，不是别的点）：
外部·可回溯 / 外部·单源未交叉 / 外部但口径存疑 / 私有基准 / 无参照系。
分档判据：来自本地数据层（${DATA}/ 下的接口产物）或 >=2 个独立外部来源对得上 → 「外部·可回溯」；
有外部的同口径数但只有一个来源 → 「外部·单源未交叉」；有外部数但口径对不齐（含宽池子且池内无同品种）
→ 「外部但口径存疑」。判为「私有基准」或「无参照系」的条目会被下游的补参照系 agent 逐条拿去接地，归错档
会让它空跑或漏掉。
**只看参照系来自哪里，与数本身对错无关**：由标的公司或其委托方产出的数（独立技术报告、
招股章程里的委托咨询、公司自己的规划与指引）一律是「私有基准」，哪怕它逐字核实无误。
这一步不要去搜外部数据（你不 WebSearch），只做归类；归类结果会让成稿 agent 知道
哪些判断是悬空的。

数据在 ${DATA}/（年报 PDF 在 ${DATA}/annual_pdf/）。
**表格看不清就用 pdftoppm -r 400 渲染成图再 Read 逐格比对**——负号丢失和列错位正是 pdftotext 最常见的失败模式。
先扫一遍找不可能的数（投入期业务 70% 净利率、分部加总不等于合计、增长率与前后两期绝对值算不出来），再逐条核。
区分「公司没披露」与「我没查到」，说不清就写"无法区分"。
核完如有修正，就地改 ${RUN}/findings/${l.key}.md，改处标"（${DATE} 复核修正）"。
**核查结论必须落盘到 ${RUN}/核查/${l.key}.md（先 mkdir -p）**：一行一条，格式
\`- [判定][参照系类型] what ｜ 核实值（含单位与正负号） ｜ 出处\`，
**双方括号，参照系类型在第二个方括号里**——这份文件同时是交付前硬门（check_thesis
硬约束 7）的参照系真值来源之一，格式或档位串写错，这条数在硬门眼里就等于不存在。
判定取「确认无误／修正／未披露／未查到」，参照系类型取五档之一：「外部·可回溯／外部·单源未交叉／外部但口径存疑／私有基准／无参照系」。
落盘是硬要求——成稿 agent 只读这个文件，不落盘等于这一轮核查白做。
不写报告、不发挥、不 WebSearch。`,
          { label: `核查:${l.key}`, phase: '核查', schema: VERIFIED }
        ).then((v) => ({ lens: l.key, findings: f, checked: v?.checked ?? [] }))

// 板块基准与五个 lens 同槽并行：它只依赖「估值原型 + 同业名单」，立疑一完成就能开查，
// 既不看 findings、findings 也不看它，两边到成稿处才汇合——所以零额外墙钟。
// 参照系接地被拆成两半（这里 + 核查之后的补参照系），正是为了消掉「等五份核查齐」这个 barrier。
const [benchBase, lensResults] = await parallel([
  () =>
    doneBench
      ? (log('板块基准：参照系/板块基准.md 已在，跳过'), Promise.resolve(null))
      : agent(
          `你是 ${SYMBOL} 的板块基准 agent。报告日 ${DATE}。

**先 Read ${RUN}/疑惑.md 第一行拿到估值原型**，再 Read
${SKILL}/equity-thesis-cn/valuation_archetypes.md 里该原型的「必比口径」那一段。
你的任务就是把那几条口径的**板块中位数/分位**取回来，一条不落。

取数方式，**本地优先是硬规矩**：本地通道取得到的数，一律不许联网另找。

同业中位数走 ${ROOT}/tools/discover_peers.py。它是**两阶段**的，你要走完这四步：

1. **自己挑品种词**。读 ${DATA}/aggregate.json 的 business 字段（主营描述；没有就读年报的
   业务概要），从里面挑 1–3 个**品种级**的词：「钨精矿」「仲钨酸铵」这个粒度，不是
   「有色金属」这种大类，更不是「资料」「2025年」这种噪声词。品种词提取是你的责任——
   脚本自带的正则兜底实测就会吐出那两个噪声词，进而零候选。
2. **拿候选**：\`python3 ${ROOT}/tools/discover_peers.py ${SYMBOL} --terms 词1,词2\`。
   它写出 ${DATA}/peers_curated.json，每条候选带一段「主营节选」和一个仅供排序参考的
   hint，**keep 恒为 null**——脚本从不自己判定谁是同业。
3. **逐条读「主营节选」，自己判断是不是同品种同业**。hint 不是判据：名字沾边而主营
   不是同品种的（灯具厂的「钨丝灯泡」、地产公司的「钨金」仿真首饰）一律排除。
   **候选发现有能力上限**，真同业可能压根不在候选里（实测 002842 翔鹭钨业就取不到）——
   你若自己知道某家同业，直接把它的代码写进下一步的清单，不必等它出现在候选中。
4. **确认**：\`python3 ${ROOT}/tools/discover_peers.py ${SYMBOL} --confirm 代码1,代码2\`。
   这是**唯一**能产生 keep=true 的路径，它只对清单里的代码取估值、算中位数、回写产物。
   **清单里不要写 ${SYMBOL} 自己**——标的不是自己的同业，写了会被排除出中位数并打警告。
   退出码：0 = 正常；1 = 零条确认同业（如实写「无参照系」，**不要为了凑数把不同品种的塞进清单**）；
   2 = 同业找到了但估值口径缺失（写明缺的是哪一项）。

**凡 peers_curated.json 给得出的数，一律不许另找来源。** 本地数可复现、带交易日，
天然进「外部·可回溯」。

它给不出的（例如 P/NAV 中位数、成本曲线分位、境外同业），才允许 WebSearch。
联网所得每条必须带 url、逐字原文 verbatim、抓取日期——**缺任一项这条就不要提交**。
**同一个数至少两个独立来源对得上才给「外部·可回溯」，只有一个来源一律给「外部·单源未交叉」。**

**你只查别人，不查标的公司自己的任何数字。** 标的自己的数由其他 agent 从 ${DATA}/ 和年报取。

落盘到 ${RUN}/参照系/板块基准.md（先 mkdir -p），一行一条：
\`- [强度] what ｜ 值 ｜ 出处 ｜ 取数日\`
分隔符是全角竖线 ｜。强度五选一，**逐字照抄**（中间那一点是「·」，写别的点下游硬门会
当这条不存在）：外部·可回溯 / 外部·单源未交叉 / 外部但口径存疑 / 私有基准 / 无参照系。
联网条目在下一行缩进补 \`    > 原文：<逐字片段>\`。
**what 用词要稳定**——成稿与交付前的硬门都按这个串精确匹配。
**注意：${DATA}/peers.json 是按交易所行业分类抓的宽池子。若池内无同品种，
它算出的倍数一律标「外部但口径存疑」，并且不要用它算"是中值 N 倍"这类倍数**——
03858 实测：用港股 72 家宽池算出"PE 是中值的 16.5 倍"，而用真正的钨业同业只有 2.82 倍，
错了一个数量级。取不到的口径要如实写成「无参照系」，不要编。`,
          { label: '板块基准', phase: '挖掘', schema: BENCHMARK }
        ),
  () => pipeline(LENSES, digStage, checkStage),
])

if (benchBase)
  log(`板块基准：${benchBase.items?.length ?? 0} 条 → ${benchBase.written_file ?? '未落盘'}`)

const ok = (lensResults ?? []).filter(Boolean)
const allChecked = ok.flatMap((r) => r.checked)
log(`挖掘+核查完成 ${ok.length}/${LENSES.length} 份；已核实清单 ${allChecked.length} 条`)

// ── 步骤 3.6：补参照系 ──────────────────────────────────────────────
// 只对仍悬空的承重数发力。**总是派出**：悬空清单的权威来源是 核查/*.md 这些文件，
// 而编排器内存里只有本轮新核出的那些——跨会话续跑时五份核查会整段跳过，内存里一条
// 都没有，按内存判空就会整段跳过、参照系/ 只剩板块基准一半。所以改由 agent 自己读盘筛，
// 编排器算出的本轮清单作为补充，两者取并集。空转的代价是一次调用，漏接地的代价是硬门拦稿。
phase('补参照系')
// 与 benchmark_lib.MUST_DOWNGRADE 同一套。用 includes 而不是相等：核查 agent 偶尔会
// 在档位串前后带修饰（"私有基准（ITR）"），宁可宽进也不要漏掉一条悬空的数。
const dangling = allChecked.filter((c) =>
  ['私有基准', '无参照系'].some((s) => (c.benchmark_type ?? '').includes(s))
)
const danglingBrief =
  dangling.length === 0
    ? '（本轮没有新核出的悬空条目——可能是核查整段跳过了。以你读盘筛出的为准。）'
    : dangling.map((d, i) => `${i + 1}. ${d.what}｜当前值 ${d.verified_value}`).join('\n')
log(`补参照系：本轮新核出 ${dangling.length} 条悬空，另由 agent 读 ${RUN}/核查/ 全量筛一遍`)
const benchFill = await agent(
  `你是补参照系 agent。报告日 ${DATE}。有些承重数字在核查阶段被判为「私有基准」或
「无参照系」，意味着它们**没有同口径的外部比较对象**，而结论正压在它们上面。你的任务是
逐条给它们找一个外部参照系。

**先把悬空清单凑齐，两个来源取并集：**

1. **读盘（权威来源，必做）**：Read ${RUN}/核查/ 下的**全部** *.md。每行格式是
   \`- [判定][参照系类型] what ｜ 核实值 ｜ 出处\`，挑出参照系类型是「私有基准」或
   「无参照系」的行。
2. **本轮新核出的（可能不全，续跑时会是空的）**：
${danglingBrief}

并集为空就到此为止：**items 返回空数组、不要落盘、更不要编条目**，在返回里说明
"核查/ 里没有判为私有基准或无参照系的条目"。空转是合法结果。

否则逐条去找同口径的外部参照系。**本地优先**：先看 ${DATA}/peers_curated.json 与
${RUN}/参照系/板块基准.md 里有没有现成的；没有才 WebSearch。

联网所得每条必须带 url、逐字原文 verbatim、抓取日期，缺任一项不要提交。
每条给一个强度，五选一、**逐字照抄**（中间那一点是「·」，写别的点下游硬门会当这条不存在）：
外部·可回溯 / 外部·单源未交叉 / 外部但口径存疑 / 私有基准 / 无参照系。
判据：**至少两个独立来源对得上才给「外部·可回溯」，只有一个来源一律给「外部·单源未交叉」**；
拿到了外部数但口径对不齐（例如宽池子且池内无同品种）给「外部但口径存疑」；
找不到就如实给「无参照系」——**找不到是可接受的结果，编一个不是。**

**你只查别人，不查标的公司自己的任何数字。**

**有内容才落盘**：接上了至少一条，才 mkdir -p 并写 ${RUN}/参照系/补.md；一条都没接上就
**什么都不建**——不要先 mkdir 再空着。空目录不是"跑过且干净"，交付前的硬门会把它判成
工序空跑或落盘失败并拦稿。
格式同 板块基准.md：\`- [强度] what ｜ 值 ｜ 出处 ｜ 取数日\`，分隔符是全角竖线 ｜，
联网条目下一行缩进补 \`    > 原文：<逐字片段>\`。
**行首只有一个方括号**——你刚读完一屋子 \`- [判定][参照系类型] …\` 的核查行，别把那个
双方括号格式照抄过来：整份文件会一条都解析不出，硬门会大声报错并拦稿。
**what 串原样沿用核查清单里的写法**，一个字都不要改——成稿与交付前的硬门都按这个串
精确匹配，改了就等于这条没接上。`,
  { label: '补参照系', phase: '补参照系', schema: BENCHMARK_FILL }
)
if (benchFill)
  log(
    `补参照系：接地 ${benchFill.items?.length ?? 0} 条` +
      (benchFill.written_file ? ` → ${benchFill.written_file}` : '（无悬空条目，未落盘）')
  )

// ── 步骤 4：成稿 ────────────────────────────────────────────────────
// 控制流保证这一步一定被执行——round5 的失败正是编排器派完核查就提前收工、从未走到这里。
phase('成稿')
const report = await agent(
  `你为 ${SYMBOL} 写判断型研究报告全文，报告日 ${DATE}，落盘到 ${RUN}/report.md。

**先读这三份，它们定义了怎么写：**
- ${SKILL}/equity-thesis-cn/SKILL.md（三段式契约、写作纪律、强制约束、语气）
- ${SKILL}/equity-thesis-cn/framework.md（十二节骨架，固定问句是菜单不是清单）
- ${SKILL}/equity-thesis-cn/style_guide.md（单位、口径、语气）

**你的输入只有三样：**
1. ${RUN}/findings/ 下的 ${LENSES.length} 份 findings（用 Read 读全部，这是子 agent 把几百页年报读完浓缩的成品）
2. ${RUN}/核查/ 下的 ${LENSES.length} 份核查结论（用 Read 读全部）——已回原文核过的数字，
   判定分「确认无误／修正／未披露／未查到」四种，**只有前两种能当硬数字用**
3. ${RUN}/参照系/ 下的文件（用 Read 读全部）——每个承重数字的参照系强度，五档：
   外部·可回溯（可直接用）／外部·单源未交叉、外部但口径存疑（可用，正文须标注）／
   私有基准、无参照系（**不得当作已证实的事实，结论必须降级措辞**）

**数字纪律**：清单里的数直接用；findings 里但没核过的可以用、正文标一句「未核实」。
参照系强度是「外部·单源未交叉」或「外部但口径存疑」的，正文引用时标明强度与来源；
「外部但口径存疑」里凡注明"宽池子且池内无同品种"的，**不得据此算"是中值的 N 倍"这类偏离度**——
03858 实测这样算错了一个数量级。强度是「私有基准」「无参照系」的，结论一律降级措辞。
**不要自己去刨年报、不要 pdftotext/grep 年报正文、不要 WebSearch**——
包括"先 pdftotext 导到 /tmp 再 grep 那个文件"这条绕路，判据看内容不看路径。
估值需要的行情/财务数字读 ${DATA}/aggregate.json。

要回收的疑惑：读 ${RUN}/疑惑.md，每条用"现在回答开篇的问题 N："销账，答不出的明写答不出。

**开篇结论的散文之后必须紧跟一个 \`> **参照系声明**\` 引用块**，逐条写明核心两点各压在
哪个数上、该数的参照系强度是什么：
- **点名时原样引用 what 串，并用「」括起来**——来源是 ${RUN}/参照系/ **或** ${RUN}/核查/
  （核查行的 what 是第一个 ｜ 之前那段）。交付前的硬门（check_thesis 硬约束 7）按这个串
  精确匹配，两个目录它都读。核心两点若被核查判为「外部·可回溯」，它们本来就不会出现在
  参照系/ 里——直接引用核查里的写法即可，不要为了"能匹配上"去改写它。
  写别的说法、或泛泛一句"部分数据未经外部验证"，都匹配不上，报告会被拦下不许交付。
- 若某数强度是「私有基准」或「无参照系」，**降级措辞必须与那个 what 写在同一句里**
  （「无法回答」「未取得」「绝对口径下」之一）——硬门按就近判定，降级句甩到块尾不算数。
- **凡强度属「私有基准」「无参照系」、且其 what 串或值串字面出现在开篇散文里的条目，都必须在
  声明块里点到名**，漏一条就拦；点名另一个安全数字替代不了（what 与值都要 ≥6 字才参与字面
  匹配——短串会因无关原因命中）。**承重数字多的稿子，这可能意味着要点名十条以上**（601678
  实测 11 条），这是设计如此不是门坏了。与其把声明块堆成长清单，不如**把那些数从开篇散文里
  拿掉、留到正文去讲**——开篇 150–250 字本来就只该放真正压得住的核心两点。
- **块内每一行都要以 \`>\` 开头，中间不许留空行**——硬门在第一个不以 \`>\` 开头的行处
  截断这个块，中间空一行会让后半块整个作废，连带把已经写对的声明判成没写。

出口：市值区间不给目标价、赔率区间精度到十位数并折成"几年一倍"、
概率没把握就写"我判断不了"、五维均分映射 A/B/C、决定性变量写成正反两栏并给行动触发条件。
末尾留一节「数据核查记录」写明核查改了什么。`,
  { label: '成稿', phase: '成稿', schema: REPORT }
)

return {
  symbol: SYMBOL,
  run_dir: RUN,
  archetype: doubt?.archetype ?? null,
  doubts: (doubt?.doubts ?? []).map((d) => d.question),
  lenses: ok.map((r) => ({
    lens: r.lens,
    file: r.findings?.written_file,
    checked: r.checked.length,
    // 分阶段标注：跳过 = 产物在 reports/ 下已存在，不是没做。两段要分开看，
    // 否则「挖掘跳过但核查真跑了」会被误读成整条 lens 没动。
    skipped_findings: r.findings?.skipped === true,
    skipped_checked: r.skipped === true,
  })),
  // 注意：只统计**本轮新核**的条数；跳过的那些在 核查/ 目录里，不在这个数里
  checked_total: allChecked.length,
  参照系: {
    板块基准: benchBase ? (benchBase.items?.length ?? 0) : doneBench ? '已在（跳过）' : null,
    悬空承重数_本轮新核: dangling.length,   // agent 还会读 核查/ 全量筛，实际接地条数可能更多
    补: benchFill ? (benchFill.items?.length ?? 0) : 0,
  },
  report: report ?? null,
  // 这四条按顺序执行，顺序本身是约束不是排版：
  // 建档必须在硬门之前（硬约束 2 查档案存在且「最近更新」==报告日，先跑门必吃 FAIL）；
  // 转 PDF 必须在硬门之后（门挂了要改 report.md，先转就是一份过期 PDF）。
  编排器待办: [
    `校验 ${RUN}/ 下 疑惑.md / findings(5) / 参照系/ / report.md 是否齐全`,
    `更新 ${ROOT}/positions/${SYMBOL}.md（评分、评级、估值锚及变更理由、假设记分板、未决疑问、变更日志），frontmatter 的「最近更新」写成 ${DATE.slice(0, 4)}-${DATE.slice(4, 6)}-${DATE.slice(6, 8)}`,
    `跑 .venv/bin/python tools/check_thesis.py ${SYMBOL} reports/${SYMBOL}_thesis_${DATE}/report.md，退出码 1 必须回去修`,
    `过门后转 PDF：.venv/bin/python tools/md_to_pdf.py --md reports/${SYMBOL}_thesis_${DATE}/report.md → reports/pdf/${SYMBOL}_thesis_${DATE}.pdf（--md 不能省，不带它会去找 equity-report-cn 的扁平路径 reports/${SYMBOL}_${DATE}.md）`,
  ],
}
