import {mkdir,writeFile} from 'node:fs/promises'
import {join,dirname} from 'node:path'
// Explicitly synthetic methods, never claimed as stock methodology validation.
export const syntheticMethods = {
 'equity-thesis-cn/writing_contract.md':'SYNTHETIC writing: preserve supplied facts and limitations.',
 'equity-thesis-cn/framework.md':'SYNTHETIC framework: opening and twelve ordered sections.',
 'equity-thesis-cn/style_guide.md':'SYNTHETIC style: units, periods and uncertainty explicit.',
 'financial-redflags-cn/SKILL.md':'SYNTHETIC finance: cash-flow and balance-sheet constraints.',
 'equity-thesis-cn/lenses/尽调.md':'SYNTHETIC diligence: business and factual sources.',
 'equity-thesis-cn/lenses/产业.md':'SYNTHETIC industry: explicit external comparison limitations.',
 'equity-thesis-cn/lenses/竞争.md':'SYNTHETIC competition: preserve comparative uncertainty.',
 'equity-thesis-cn/lenses/战略驱动.md':'SYNTHETIC strategy: preserve rating-changing assumptions.',
}
export async function writeSyntheticReviewMethods(root) {
 for(const [path,text] of Object.entries(syntheticMethods)) {
  const full=join(root,'.codex/skills',path)
  await mkdir(dirname(full),{recursive:true});await writeFile(full,text)
 }
}
