export const meta = {
  name: 'equity-thesis',
  description: '判断型研究报告：立疑 → 五 lens 并行挖掘、每份即时核查 → 成稿',
  whenToUse: 'equity-thesis-cn 的步骤 2–4。步骤 0（读档案）与步骤 5–6（写档案、跑校验器）留在 skill 里由编排器做。',
  phases: [
    { title: '立疑', detail: '看财务全景判行业类、立 2–4 条决策形状的疑惑' },
    { title: '挖掘', detail: '五个 lens 并行读年报，各自标出承重数字' },
    { title: '核查', detail: '每份 findings 一产出就核查，不堆到尾部' },
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
  required: ['industry_class', 'doubts', 'written_file'],
  properties: {
    industry_class: { type: 'string', description: '行业类别，按 framework.md 开篇原则三判定，会传给每个 lens' },
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
        required: ['what', 'value', 'source'],
        properties: {
          what: { type: 'string' }, value: { type: 'string' }, source: { type: 'string' },
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
        required: ['what', 'verdict', 'verified_value', 'source'],
        properties: {
          what: { type: 'string' },
          verdict: { enum: ['确认无误', '修正', '未披露', '未查到'] },
          verified_value: { type: 'string', description: '含单位与正负号；修正的填修正后的值' },
          source: { type: 'string', description: '年报 p.XX / {file}.json 字段' },
        },
      },
    },
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

// ── 步骤 2：立疑（判断由 agent 做，不写死）──────────────────────────
phase('立疑')
log(`${SYMBOL} 立疑：先看财务全景，再从数字里逼出疑惑`)
const doubt = await agent(
  `你为 ${SYMBOL} 做判断型研究的立疑工序。报告日 ${DATE}。

先读 ${DATA}/aggregate.json 的 financials_annual / financials_quarterly，把近三年+最新季报的
增长与费用 / 回报与结构 / 营运与现金三组指标摊开看一遍。**先看财务全景，再立疑**——
疑惑要从数字里逼出来，不是从主营业务描述里憋出来。

两件事：
1. 判本票属于哪一类（读 ${SKILL}/equity-thesis-cn/framework.md 开篇原则三的行业映射表）。
   这个类别会传给每个 lens，用来选对阈值、TAM 口径和估值方法。判错会让五个 lens 一起错。
2. 立 2–4 条疑惑，写进 ${RUN}/疑惑.md（先 mkdir -p）。

**疑惑要是"决策形状"的，不是"审计形状"的。** 判据：这个问题的答案会不会直接改变我买不买。
"这家公司的<某条业务线>能不能<达到某个量级/增速>？"是好形状——可证伪、有量级、答案直接决定估值。
"利润为什么塌了""毛利率去哪了"是排查项，不占疑惑清单的位置。
写完自检：某条疑惑无论答"是"还是"否"结论都不变，就删掉它。`,
  { label: '立疑', phase: '立疑', schema: DOUBT }
)

log(`行业类别：${doubt?.industry_class ?? '未判定'}；疑惑 ${doubt?.doubts?.length ?? 0} 条`)

// ── 步骤 3+3.5：pipeline——每份 findings 一产出就核查，不等其他 lens ──
// round4/5 实测：核查排在第 265/298 次调用，之后已无预算写稿。
// pipeline 让核查与其余 lens 的挖掘重叠，从结构上避免堆到尾部。
const doubtBrief = (doubt?.doubts ?? []).map((d, i) => `${i + 1}. ${d.question}（${d.why_decision}）`).join('\n')

const lensResults = await pipeline(
  LENSES,
  (l) =>
    agent(
      `你是 ${SYMBOL} 的${l.key}子 agent，覆盖${l.sections}。报告日 ${DATE}。
行业类别：${doubt?.industry_class ?? '未判定'}——按这个类别选阈值/口径/方法。

读 ${l.guide} 并严格遵循它的关键动作与输出契约。数据在 ${DATA}/。

本次要回答的疑惑（不必全答，答与你这一节相关的）：
${doubtBrief || '（无）'}

把完整发现写到 ${RUN}/findings/${l.key}.md（先 mkdir -p）。
返回值只给摘要：判断要点、不确定项、以及**你这份里最承重的 1–6 个数字**——
判据是"这个数错了，某一节的判断方向会反过来"。承重数字会被立刻拿去回原文核实。
查不到的直说，不要填满。`,
      { label: `挖掘:${l.key}`, phase: '挖掘', schema: FINDINGS }
    ),
  (f, l) =>
    f == null
      ? null
      : agent(
          `你是核查子 agent。读 ${SKILL}/equity-thesis-cn/lenses/核查.md 并遵循。

把下面这些数字逐条回原文核实，逐字抄原文，含单位与正负号：
${JSON.stringify(f.load_bearing, null, 1)}

数据在 ${DATA}/（年报 PDF 在 ${DATA}/annual_pdf/）。
**表格看不清就用 pdftoppm -r 400 渲染成图再 Read 逐格比对**——负号丢失和列错位正是 pdftotext 最常见的失败模式。
先扫一遍找不可能的数（投入期业务 70% 净利率、分部加总不等于合计、增长率与前后两期绝对值算不出来），再逐条核。
区分「公司没披露」与「我没查到」，说不清就写"无法区分"。
核完如有修正，就地改 ${f.written_file}，改处标"（${DATE} 复核修正）"。
不写报告、不发挥、不 WebSearch。`,
          { label: `核查:${l.key}`, phase: '核查', schema: VERIFIED }
        ).then((v) => ({ lens: l.key, findings: f, checked: v?.checked ?? [] }))
)

const ok = (lensResults ?? []).filter(Boolean)
const allChecked = ok.flatMap((r) => r.checked)
log(`挖掘+核查完成 ${ok.length}/${LENSES.length} 份；已核实清单 ${allChecked.length} 条`)

// ── 步骤 4：成稿 ────────────────────────────────────────────────────
// 控制流保证这一步一定被执行——round5 的失败正是编排器派完核查就提前收工、从未走到这里。
phase('成稿')
const report = await agent(
  `你为 ${SYMBOL} 写判断型研究报告全文，报告日 ${DATE}，落盘到 ${RUN}/report.md。

**先读这三份，它们定义了怎么写：**
- ${SKILL}/equity-thesis-cn/SKILL.md（三段式契约、写作纪律、强制约束、语气）
- ${SKILL}/equity-thesis-cn/framework.md（十二节骨架，固定问句是菜单不是清单）
- ${SKILL}/equity-thesis-cn/style_guide.md（单位、口径、语气）

**你的输入只有两样：**
1. ${RUN}/findings/ 下的 ${ok.length} 份 findings（用 Read 读，这是子 agent 把几百页年报读完浓缩的成品）
2. 下面这张「已核实清单」——${allChecked.length} 条已回原文核过的数字

${JSON.stringify(allChecked, null, 1)}

**数字纪律**：清单里的数直接用；findings 里但没核过的可以用、正文标一句「未核实」。
**不要自己去刨年报、不要 pdftotext/grep 年报正文、不要 WebSearch**——
包括"先 pdftotext 导到 /tmp 再 grep 那个文件"这条绕路，判据看内容不看路径。
估值需要的行情/财务数字读 ${DATA}/aggregate.json。

要回收的疑惑（每条用"现在回答开篇的问题 N："销账，答不出的明写答不出）：
${doubtBrief || '（无）'}

出口：市值区间不给目标价、赔率区间精度到十位数并折成"几年一倍"、
概率没把握就写"我判断不了"、五维均分映射 A/B/C、决定性变量写成正反两栏并给行动触发条件。
末尾留一节「数据核查记录」写明核查改了什么。`,
  { label: '成稿', phase: '成稿', schema: REPORT }
)

return {
  symbol: SYMBOL,
  run_dir: RUN,
  industry_class: doubt?.industry_class ?? null,
  doubts: (doubt?.doubts ?? []).map((d) => d.question),
  lenses: ok.map((r) => ({ lens: r.lens, file: r.findings?.written_file, checked: r.checked.length })),
  checked_total: allChecked.length,
  report: report ?? null,
  编排器待办: [
    `校验 ${RUN}/ 下 疑惑.md / findings(5) / report.md 是否齐全`,
    `更新 ${ROOT}/positions/${SYMBOL}.md（评分、评级、估值锚及变更理由、假设记分板、未决疑问、变更日志）`,
    `跑 .venv/bin/python tools/check_thesis.py ${SYMBOL} reports/${SYMBOL}_thesis_${DATE}/report.md，退出码 1 必须回去修`,
  ],
}
