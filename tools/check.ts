import { execFileSync } from 'node:child_process'

import { packageCheck } from './package.ts'
import { policy } from './policy.ts'

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: 'inherit' })
}
// Type-aware lint and typechecking of the workspace CLI use emitted public declarations.
run('pnpm', ['run', 'build'])
run('pnpm', ['run', 'lint'])
run('pnpm', ['run', 'typecheck'])
run('pnpm', ['--filter', '@huihua/usage', 'run', 'check'])
run('pnpm', ['run', 'knip'])
await policy()
run('pnpm', ['test'])
await packageCheck()
