export const meta = {
  name: 'calibrate-equity-thesis',
  description: '用 5 篇人工底稿反向审计 equity-thesis-cn 的方法论：盲抽动作 → 归纳方法 → 规则测绘',
  whenToUse: '跑 /calibrate-equity-thesis 的工序 1、1.5、2。工序 3 对撞与工序 4 抽查不在此脚本内。',
  phases: [
    { title: '盲抽', detail: '5 篇底稿并行，只给 PDF、不给 skill' },
    { title: '规则测绘', detail: '只给 skill、不给底稿，与盲抽并行' },
    { title: '归纳', detail: '5 份动作清单到齐后归纳成可复用方法' },
  ],
}

// ── 数据源 ──────────────────────────────────────────────────────────
// 路径首段含前导空格（"/home/hongshi/ work_document"），与同级的
// "/home/hongshi/work_document" 是两个不同目录。子 agent 的命令里必须整体加引号。
const DIR = '/home/hongshi/ work_document/模板报告（之前的文件）'
const DOCS = args?.documents ?? [
  { code: '石基', file: '次新小组研究框架（石基信息）by 井井.pdf', pages: 23 },
  { code: '澜起', file: '次新股小组-澜起科技-钟央.pdf', pages: 23 },
  { code: '开立', file: '【次新组作业】 开立医疗- BY Kenny.pdf', pages: 19 },
  { code: '中控', file: '次新研究-中控技术-BING.pdf', pages: 15 },
  { code: '乐鑫', file: '9月-乐鑫科技-汤智尧.pdf', pages: 13 },
]

// 仓库根：可由 args.root 覆盖，以便在不同 worktree 跑同一个 workflow。
// 不传则沿用原路径，既有调用方式不受影响。
const ROOT = args?.root
if (!ROOT) throw new Error('Codex workflow requires an explicit repository root')
const SKILL = `${ROOT}/.codex/skills`

const SKILL_FILES = [
  `${SKILL}/equity-thesis-cn/writing_contract.md`,
  `${SKILL}/equity-thesis-cn/framework.md`,
  `${SKILL}/equity-thesis-cn/lenses/产业.md`,
  `${SKILL}/equity-thesis-cn/lenses/竞争.md`,
  `${SKILL}/equity-thesis-cn/lenses/战略驱动.md`,
  `${SKILL}/equity-thesis-cn/lenses/尽调.md`,
  `${SKILL}/equity-thesis-cn/lenses/核查.md`,
  `${SKILL}/financial-redflags-cn/SKILL.md`,
]

// 中性输出目录：不含被审计 skill 的名字，避免路径本身泄露审计对象
const OUTDIR = args?.blind_dir ?? '/tmp/doc-digest'

// schema 的 property key 必须匹配 ^[a-zA-Z0-9_.-]{1,64}$（2026-08-19 实测：
// 中文键名会让所有 agent 直接 400）。所以 key 用 ASCII、prompt 里仍用中文标签。
const ATTRS = [
  { key: 'product_lines', zh: '产品线数量' },
  { key: 'is_cyclical', zh: '是否周期性行业' },
  { key: 'profitable', zh: '报告期内是否盈利' },
  { key: 'has_ma', zh: '有无并购史' },
  { key: 'multi_segment', zh: '是否多分部经营' },
  { key: 'overseas_rev', zh: '是否有海外收入' },
]
const ATTRS_ZH = ATTRS.map((a) => a.zh)

// ── schema：把"返回格式"从散文约定升级为工具层强制 ──────────────────
// 2026-08-19 实测：手工编排时归纳 agent 的返回被静默截断、前 28 条丢失且无人发现。
// schema 校验不匹配会让模型重试，这类残缺不会再悄悄流进产物。
const DIGEST = {
  type: 'object',
  required: ['actions', 'attributes', 'written_file'],
  properties: {
    actions: {
      type: 'array', minItems: 20,
      items: {
        type: 'object',
        required: ['action', 'page', 'quote', 'serves_what'],
        properties: {
          action: { type: 'string', description: '这位作者做了什么（你自己的话，不要起名字）' },
          page: { type: 'string', description: '页码' },
          quote: { type: 'string', description: '原文或表格摘录' },
          serves_what: { type: 'string', description: '这个动作服务于什么判断' },
        },
      },
    },
    attributes: {
      type: 'object',
      required: ATTRS.map((a) => a.key),
      properties: ATTRS.reduce((o, a) => ((o[a.key] = { type: 'string', description: a.zh }), o), {}),
    },
    written_file: { type: 'string', description: '你落盘的那个 .md 的绝对路径' },
  },
}

const METHODS = {
  type: 'object',
  required: ['methods'],
  properties: {
    methods: {
      type: 'array', minItems: 60,
      items: {
        type: 'object',
        required: ['statement', 'which_docs', 'pages', 'solves_what', 'scope'],
        properties: {
          statement: { type: 'string', description: '方法陈述' },
          which_docs: { type: 'array', items: { type: 'string' }, description: '哪几份在做' },
          pages: { type: 'string', description: '各自页码' },
          solves_what: { type: 'string', description: '这个方法解决什么问题' },
          scope: { type: 'string', description: '适用域' },
        },
      },
    },
  },
}

const RULES = {
  type: 'object',
  required: ['rules'],
  properties: {
    rules: {
      type: 'array', minItems: 100,
      items: {
        type: 'object',
        required: ['id', 'summary', 'source', 'verbatim', 'scope', 'scope_reason', 'form'],
        properties: {
          id: { type: 'string', description: 'R-{来源}-{序号}' },
          summary: { type: 'string', description: '一句话摘要' },
          source: { type: 'string', description: '{文件}:{行号}' },
          verbatim: { type: 'string', description: '逐字抄的规定性语句' },
          scope: { type: 'string', description: '无条件 / 条件：{六项之一}' },
          scope_reason: { type: 'string', description: '一句话，附出处' },
          form: { enum: ['方法型', '例子型', '伪方法'] },
        },
      },
    },
  },
}

// ── 隔离区 ①：盲抽 prompt ───────────────────────────────────────────
// 本段不得出现被审计 skill 的任何专有构造词。改动后必须重跑词汇 lint。
// 隔离靠的是提问的抽象层级（问"这位作者做了什么"而不是"用了哪些方法论"），
// 禁令只是第二道保险。
const blindPrompt = (d) => `你是文档记录员。任务只有一件：把 ${d.file.startsWith('/') ? d.file : DIR + '/' + d.file} 这份研究报告逐节读完，
记录**这位作者实际做了哪些分析动作**。

注意：该路径首段含前导空格（"/home/hongshi/ work_document"，与 "/home/hongshi/work_document" 是两个不同目录）。
命令里必须把路径整体加引号，否则会静默指向另一个目录。该 PDF 共 ${d.pages} 页。

用 pdftotext -layout 取正文；表格或截图看不清时用 pdftoppm -r 300 渲染成图再用 Read 工具看图。
**这一步不能省**：这批报告里评分表、分部毛利率图等关键内容是嵌入的图片，
pdftotext 完全抽不出来（2026-08-19 实测，曾因此漏掉 3 份底稿的评分记录）。

每条动作记四栏：动作 / 页码 / 原文或表格摘录 / 这个动作服务于什么判断。

要求：
- 用你自己的话描述动作，**不要给动作起名字、不要归类、不要总结方法论**。
  例：写"作者把这一页的数字和前面某页的同名数字并排列出，指出两者对不上，
  并说明他采信哪一个"，而不是给这个动作起一个名字（如"××法""××分析"）。
- "服务于什么判断"必须填。它是这条动作存在的理由；填不出来说明你没读懂这一段。
- 只记你在页面上真正看到的东西。看不清就写"该页为图片，未能辨认"。
- 覆盖全部 ${d.pages} 页，不要只读前几页。

另外填写「标的客观属性」，只填事实，查不到就写"未提及"：
${ATTRS_ZH.join(' / ')}。

**落盘**：把上面两节内容写成一个 markdown 文件到 \`${OUTDIR}/${d.code}.md\`
（表格形式，四栏动作表 + 属性表），然后在返回的「已写入文件」里填这个绝对路径。
返回值仍要带完整的结构化内容——文件和返回值两边都要有，互为校验。

本次只使用上面指定的 PDF 作为信息源，不要读其它任何文件，不要联网。`

// ── 隔离区 ②：归纳 prompt ───────────────────────────────────────────
// 动作清单直接嵌进 prompt，不给文件路径——手工编排时曾因传入的 evidence 绝对路径
// 含 "calibrate-equity-thesis" 而泄露了被审计对象的名字。
const inducePrompt = (digests) => `你拿到 5 份研究报告的动作记录（下方 JSON）。
任务：把这些具体动作归纳成**可复用的分析方法**。

一条方法的判准：换一家完全不同的公司，照着它还能执行。
绑死在某一家公司、某一个年份、某一个具体数字上的描述，不是方法；
能写成"凡遇到 X 情形，就先做 Y、再据此决定 Z"这种形式的，才是方法。

要求：
- 只从这 5 份记录里归纳，**不要补充你自己知道的其他研究方法**。
- 一份都没在做的，不要写。只有一份在做的也要写，"哪几份在做"里如实只列那一份。
- 不要给方法排优先级，不要评价好坏。
- 「适用域」：判断这条方法是不是只对具备某种客观属性的公司才成立。
  如果是，从这六项里选一项填写：${ATTRS_ZH.join(' / ')}；
  判断不出限制就填"无条件"。**只能从这六项里选，不要自己发明新的限定词。**
- 要穷尽。这 5 份记录合计有 180 条以上的动作，凡是能写成可复用形式的都要写出来。

本次只使用下方 JSON 作为信息源，不要读任何文件，不要联网。

${JSON.stringify(digests, null, 1)}`

// ── 工序 2：规则测绘（给 skill，不给底稿）──────────────────────────
const rulesPrompt = () => `你的任务：把一个 skill 里所有**规定性语句**逐条测绘成规则清单。

输入文件（只读这些，不要读其它文件，不要联网）：
${SKILL_FILES.map((f) => '- ' + f).join('\n')}

**什么算规定性语句**：含"必须/要/应当/不许/固定/一律"的句子；
以及无这些词但实际在规定动作的句子（如"每节挑 2–4 个深答"）。纯背景描述不计。

每条规则填七栏：
- 编号：R-{来源}-{序号}。来源用中文短标签取自文件名：
  SKILL / 骨架(framework.md) / 产业 / 竞争 / 战略 / 尽调 / 核查 / 财务(financial-redflags-cn)。
  序号在各来源内从 01 起顺排。
- 摘要：一句话
- 出处：{文件}:{行号}。**行号必须真实**，用 grep -n 或 cat -n 核对。
- 原文：逐字抄的规定性语句，不要改写
- 适用域：「无条件」或「条件：{下列六项之一}」——${ATTRS_ZH.join(' / ')}。
  表述不出来的记「无条件」。**不许自己发明新限定词。**
- 适用域理由：一句话，附出处
- 形态：三选一
  · 方法型 = 说清了怎么做，换一家完全不同的公司照样执行
  · 例子型 = 只给了"某个具体案例怎么做的"，换家公司无从下手。
    判据：把例子那几行遮住，剩下的字还够不够一个没读过案例的人照着做？不够就是例子型。
  · 伪方法 = 看着像方法，实为从单一样本外推（例如从一个观测点固化出一整张分档映射表）

逐文件穷尽，不要抽样。不要评价规则好坏，不要排优先级。`

// ── 主流程 ──────────────────────────────────────────────────────────
// evidence 齐备时由调用方通过 args.digests 传入，跳过工序 1（93 页 PDF 一页都不用再读）。
const evidenceReady = args?.evidence_ready === true
const haveDigests = false

log(haveDigests ? '已收到现成的动作清单，跳过工序 1' : `工序 1：${DOCS.length} 篇底稿并行盲抽`)

const [digests, rulesRes] = await parallel([
  () =>
    evidenceReady
      ? Promise.resolve([])
      : parallel(
          DOCS.map((d) => () =>
            agent(blindPrompt(d), { label: `盲抽:${d.code}`, phase: '盲抽', schema: DIGEST, isolation: 'blind' })
              .then((r) => (r ? { code: d.code, ...r } : null))
          )
        ),
  () => agent(rulesPrompt(), { label: '规则测绘', phase: '规则测绘', schema: RULES }),
])

const ok = (digests || []).filter(Boolean)
if (!evidenceReady && ok.length < DOCS.length) {
  log(`⚠️ 只拿到 ${ok.length}/${DOCS.length} 份动作清单——缺任一份，工序 1 与 1.5 都要重跑`)
}

// 工序 1.5 是真 barrier：归纳必须看到全部 5 份，不能边到边归纳。
// 且不能由编排器代做——编排器已通读过被审计 skill，会不自觉地把动作抽象成
// skill 已有的形状，使"遗漏"这一象限静默塌陷。
log(`工序 1.5：归纳（输入 ${ok.length} 份，合计 ${ok.reduce((n, d) => n + (d.actions?.length || 0), 0)} 条动作）`)
if (!evidenceReady && ok.length !== DOCS.length) throw new Error('Five complete digests are required before induction')
const methods = evidenceReady ? null : await agent(inducePrompt(ok), { label: '归纳', phase: '归纳', schema: METHODS, isolation: 'blind' })

// 只返回摘要——完整的 5 份动作清单已由各 agent 自己落盘，且已在脚本内存里
// 传给了归纳 agent。把它们再 return 一遍会把十万 token 量级的数据灌进编排器上下文，
// 而编排器只需要知道"写成了没有、条数对不对"。
return {
  digests: ok,
  digestSummary: ok.map((d) => ({
    代号: d.code,
    动作数: d.actions?.length ?? 0,
    已写入文件: d.written_file ?? null,
    标的客观属性: d.attributes ?? null,
  })),
  methods: methods?.methods ?? [],
  rules: rulesRes?.rules ?? [],
  counts: {
    篇数: ok.length,
    动作数: ok.reduce((n, d) => n + (d.actions?.length || 0), 0),
    方法数: methods?.methods?.length ?? 0,
    规则数: rulesRes?.rules?.length ?? 0,
  },
  编排器待办: [
    `校验 ${OUTDIR}/ 下 5 个 .md 是否都存在、条数与 digestSummary 对得上`,
    '把它们移到 evidence/{代号}.md',
    '把 methods 落成 evidence/methods.md、rules 落成 run 文件夹的 rules.md',
  ],
}
