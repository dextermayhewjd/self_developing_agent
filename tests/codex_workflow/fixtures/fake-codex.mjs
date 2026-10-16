import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
const input = readFileSync(0, 'utf8')
const config = JSON.parse(input.split('TEST:').at(-1).split('\n')[0])
const args = process.argv.slice(2)
if (config.capture) writeFileSync(config.capture, JSON.stringify({ args, input, cwd: process.cwd() }))
if (config.counter) appendFileSync(config.counter, 'attempt\n')
if (config.exit) { process.stderr.write('fixture worker rejected'); process.exit(config.exit) }
if (config.wait) await new Promise(resolve => setTimeout(resolve, config.wait))
const output = args[args.indexOf('--output-last-message') + 1]
if (!config.noResult) writeFileSync(output, config.malformed ? 'not json' : JSON.stringify(config.result))
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }) + '\n')
