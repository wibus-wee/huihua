import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'

import { laneResult, providers, reportMarker } from '../tools/producer-compat-daily.ts'

await test('publisher reconciles one tracker, one daily comment and duplicate anomalies without network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-publish-test-'))
  try {
    const directory = join(root, 'results')
    await mkdir(directory)
    const sha = 'a'.repeat(40)
    for (const provider of providers) {
      for (const lane of ['pinned', 'latest'] as const) {
        const result = provider === 'kimi'
          ? laneResult(provider, lane, '2.1.1', sha, 'failure', { stage: 'read', completed: [], error: 'missing assistant replies' })
          : laneResult(provider, lane, '1.0.0', sha, 'success', { stage: 'passed', completed: ['scan', 'read', 'snapshot', 'records', 'events', 'scenario', 'baseline'] })
        await writeFile(join(directory, `${provider}-${lane}.json`), JSON.stringify(result))
      }
    }
    const statePath = join(root, 'state.json')
    await writeFile(statePath, JSON.stringify({ issues: [{ number: 17, state: 'open', body: `${reportMarker}\nHuman notes must survive.` }], comments: [], calls: [] }))
    const mock = join(root, 'mock.mjs')
    await writeFile(mock, `
import {readFileSync,writeFileSync} from 'node:fs';
const path=process.env.MOCK_STATE;
globalThis.fetch=async (url,options={})=>{
 const state=JSON.parse(readFileSync(path,'utf8'));
 const route=new URL(url).pathname.replace('/repos/wibus-wee/huihua','');
 const method=options.method??'GET';const body=options.body?JSON.parse(options.body):{};
 state.calls.push([method,route]);let result;
 if(method==='GET'&&route==='/issues') result=state.issues;
 else if(method==='POST'&&route==='/issues'){result={...body,number:18+state.issues.length,state:'open'};state.issues.push(result);}
 else if(method==='PATCH'&&/^\\/issues\\/\\d+$/.test(route)){result=state.issues.find(x=>x.number===Number(route.split('/').at(-1)));Object.assign(result,body);}
 else if(method==='GET'&&route.endsWith('/comments')) result=state.comments.filter(x=>x.issue===Number(route.split('/')[2]));
 else if(method==='POST'&&route.endsWith('/comments')){result={...body,id:state.comments.length+1,issue:Number(route.split('/')[2]),user:{login:'github-actions[bot]',type:'Bot'}};state.comments.push(result);}
 else if(method==='PATCH'&&route.startsWith('/issues/comments/')){result=state.comments.find(x=>x.id===Number(route.split('/').at(-1)));Object.assign(result,body);}
 else throw Error('Unexpected mock API request: '+method+' '+route);
 writeFileSync(path,JSON.stringify(state));return new Response(JSON.stringify(result),{status:200});
};
`)
    const env = { ...process.env, MOCK_STATE: statePath, GITHUB_REPOSITORY: 'wibus-wee/huihua', GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'schedule', GITHUB_TOKEN: 'mock-no-network', COMPAT_PUBLISH: 'true', COMPAT_DEFAULT_BRANCH: 'main', COMPAT_RESULTS_DIR: directory, COMPAT_DAILY_REPORT: join(root, 'report.md') }
    const args = ['--import', mock, resolve('tools/producer-compat-publish.ts')]
    execFileSync(process.execPath, args, { env, stdio: 'pipe' })
    execFileSync(process.execPath, args, { env, stdio: 'pipe' })
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { issues: { body: string }[], comments: { body: string }[], calls: [string, string][] }
    assert.equal(state.issues.length, 2, 'both lanes of one defect must reuse one incident')
    assert.equal(state.comments.length, 2, 'reruns update, not duplicate, daily comments')
    assert.match(state.issues[0]!.body, /Human notes must survive/)
    assert.equal(state.calls.filter(([method, route]) => method === 'POST' && route === '/issues').length, 1)
    assert.throws(() => execFileSync(process.execPath, args, { env: { ...env, GITHUB_REF: 'refs/heads/untrusted' }, stdio: 'pipe' }))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
