export interface UsageCliOptions {
  readonly providers: readonly string[]
  readonly since?: string
  readonly until?: string
  readonly timeZone: string
  readonly json: boolean
  readonly help: boolean
  readonly workers: number
}

export function parseUsageArgs(values: readonly string[]): UsageCliOptions {
  const result: {
    providers: string[]
    since?: string
    until?: string
    timeZone: string
    json: boolean
    help: boolean
    workers: number
  } = { providers: [], timeZone: 'UTC', json: false, help: false, workers: 1 }
  // pnpm 12 forwards the script argument separator literally.
  for (let index = values[0] === '--' ? 1 : 0; index < values.length; index += 1) {
    const arg = values[index]!
    if (arg === '--help' || arg === '-h') {
      result.help = true
      return result
    }
    if (arg === '--json') {
      result.json = true
      continue
    }
    const key = arg.startsWith('--') ? arg.slice(2) : ''
    if (['provider', 'since', 'until', 'timezone', 'workers'].includes(key)) {
      const value = values[++index]
      if (value === undefined || value.startsWith('--'))
        throw new TypeError(`${arg} requires a value`)
      if (key === 'provider') {
        result.providers.push(value)
      }
      else if (key === 'since') {
        result.since = value
      }
      else if (key === 'until') {
        result.until = value
      }
      else if (key === 'workers') {
        if (!['1', '2', '4'].includes(value))
          throw new TypeError('--workers must be 1, 2 or 4')
        result.workers = Number(value)
      }
      else {
        result.timeZone = value
      }
      continue
    }
    throw new TypeError(`unknown option ${arg}`)
  }
  return result
}
