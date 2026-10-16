/** Exact JS string offsets, including original CRLF, shared by review and patches. */
export function parseReportSections(reportText) {
  if (typeof reportText !== 'string') throw new TypeError('reportText must be a string')
  const numbers = { 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10, 十一:11, 十二:12 }
  const sections = []
  let fence = null
  for (const match of reportText.matchAll(/[^\n]*(?:\n|$)/gu)) {
    if (!match[0]) continue
    const line = match[0].replace(/\r?\n$/u, '')
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) fence = null
      continue
    }
    if (marker) { fence = marker; continue }
    const heading = /^ {0,3}##[ \t]+(?:第)?(十二|十一|十|[一二三四五六七八九]|\d{1,2})(?:节)?[、.．:：)） \t]+\S/u.exec(line)
    if (!heading) continue
    const section = numbers[heading[1]] ?? Number(heading[1])
    if (section !== 0) sections.push({ section, start:match.index, heading:line })
  }
  if (sections.length !== 12 || sections.some((s,i)=>s.section !== i+1)) throw new Error('report section headings must contain exactly 1..12 in order (十二节标题)')
  return sections.map((s,i)=>({ ...s, end:sections[i+1]?.start ?? reportText.length, text:reportText.slice(s.start,sections[i+1]?.start ?? reportText.length) }))
}
