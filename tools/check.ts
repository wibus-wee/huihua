import { execFileSync } from 'node:child_process'

import { packageCheck } from './package.ts'
import { policy } from './policy.ts'

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: 'inherit' })
}
run('pnpm', ['run', 'lint'])
run('pnpm', ['run', 'typecheck'])
run('pnpm', ['run', 'knip'])
await policy()
run('pnpm', ['test'])
run('pnpm', ['run', 'build'])
await packageCheck()
