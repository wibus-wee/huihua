import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
/** Verify exactly what a consumer installs; no development toolchain or install scripts required. */
export async function packageCheck(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'huihua-package-'))
  try {
    const output = execFileSync(
      'pnpm',
      ['pack', '--config.ignore-scripts=true', '--json', '--pack-destination', root],
      { encoding: 'utf8' },
    )
    const packed = JSON.parse(output) as { filename: string, files: { path: string }[] }
    for (const file of packed.files) {
      assert.ok(
        !/^(?:reference|src|tests|tools|fixtures)\/|\.(?:node|wasm|rs|a|dylib)$/.test(
          file.path,
        ),
        `non-JS package artifact: ${file.path}`,
      )
    }
    await writeFile(
      join(root, 'package.json'),
      '{"type":"module","private":true}',
    )
    execFileSync(
      'npm',
      [
        'install',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        resolve(root, packed.filename),
      ],
      { cwd: root, stdio: 'pipe' },
    )
    const packageRoot = join(root, 'node_modules/huihua')
    const pkg = JSON.parse(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    ) as { name: string, version: string, license: string, exports: Record<string, { types: string, import: string }>, packageManager?: string, scripts?: Record<string, string> }
    const sourcePkg = JSON.parse(await readFile('package.json', 'utf8')) as {
      name: string
      version: string
      license: string
    }
    assert.equal(pkg.name, sourcePkg.name)
    assert.equal(pkg.version, sourcePkg.version)
    assert.equal(pkg.license, 'MIT')
    assert.equal(pkg.license, sourcePkg.license)
    assert.equal(
      await readFile(join(packageRoot, 'LICENSE'), 'utf8'),
      await readFile('LICENSE', 'utf8'),
    )
    assert.equal(pkg.packageManager, undefined)
    assert.equal(pkg.scripts?.prepack, undefined)
    assert.equal(pkg.scripts?.prepare, undefined)
    for (const target of Object.values(pkg.exports)) {
      await readFile(join(packageRoot, target.types))
      await readFile(join(packageRoot, target.import))
    }
    const fixture = resolve('fixtures/codex/tool-call.jsonl')
    await writeFile(join(root, 'registry-smoke.mjs'), `
      import assert from 'node:assert/strict';
      import {registerHooks} from 'node:module';
      registerHooks({resolve(specifier,context,next){
        if(specifier==='huihua')throw new Error('registry imported builtin composition');
        const result=next(specifier,context);
        if(result.url.includes('/providers/'))throw new Error('registry imported provider implementation');
        return result;
      }});
      const {createSessionRegistry}=await import('huihua/registry');
      assert.deepEqual(createSessionRegistry().providers(),[]);
    `)
    execFileSync(process.execPath, [join(root, 'registry-smoke.mjs')], { cwd: root, stdio: 'inherit' })
    await writeFile(
      join(root, 'smoke.mjs'),
      `
      import assert from 'node:assert/strict';
      import * as huihua from 'huihua';
      import * as registry from 'huihua/registry';
      import * as observe from 'huihua/observe';
      import * as ingest from 'huihua/ingest';
      import {assertSessionContract} from 'huihua/testing';
      const {sessions,AgentSession}=huihua;
      const {conversationOf,eventsOf,toolCallsOf,toolResultsOf}=observe;
      assert.equal(sessions,AgentSession);
      assert.equal(registry.SessionRegistry,huihua.SessionRegistry);assert.equal(registry.createSessionRegistry,huihua.createSessionRegistry);
      assert.deepEqual(registry.createSessionRegistry().providers(),[]);
      for(const name of ['eventsOf','conversationOf','toolCallsOf','toolResultsOf','fileChangesOf','subagentsOf','millisOf']){assert.equal(typeof observe[name],'function');assert.equal(huihua[name],observe[name]);}
      for(const name of ['Ingestion','jsonlProvider','jsonStoreProvider','sqliteStoreProvider','openFrom','scanSource','jsonLinesFrom','scanFailure','positiveLimit','messageEvents','chatMessageEvents','contentBlocks','files','pathMatcher']){assert.equal(typeof ingest[name],'function',name);}
      assert.equal(Object.hasOwn(observe,'filesOf'),false);
      assert.equal(huihua.SESSION_SCHEMA,'agent-session/v1');
      for(const name of ['claude','codex','cursor','opencode','pi','oar','acp','kimi','grok','antigravity','morph','copilot','openclaw','qwen','droid','deepseek','cline','fx','devin','hermes']){const module=await import('huihua/providers/'+name);assert.ok(Object.values(module).some(value=>value.id===name));}
      const {refs,failures}=await sessions.scan({providers:['codex'],roots:{codex:[${JSON.stringify(fixture)}]}});
      assert.deepEqual(failures,[]);assert.equal(refs.length,1);const session=await sessions.read(refs[0]);assertSessionContract(session);assert.equal(conversationOf(session).length,0);
      const discoveries=[];for await(const event of sessions.scanStream({providers:['codex'],roots:{codex:[${JSON.stringify(fixture)}]}}))discoveries.push(event);
      assert.deepEqual(discoveries,[{type:'ref',ref:refs[0]}]);
      const cause=new Error('custom adapter failed');const customRef={id:'s',provider:'custom',source:{path:'memory',format:'custom'},metadata:{}};
      const custom=huihua.defineProvider({id:'custom',async detect(){return {provider:'custom',roots:[],available:true};},async* scan(){yield {type:'ref',ref:customRef};throw cause;},async read(){throw new Error('unexpected read');}});
      const report=await huihua.createSessionRegistry([custom]).scan();assert.deepEqual(report.refs,[customRef]);assert.equal(report.failures[0].scope,'provider');assert.equal(report.failures[0].code,'Unknown');assert.equal(report.failures[0].cause,cause);
      assert.equal(toolCallsOf(session).length,1);assert.equal(toolResultsOf(session).length,1);
      assert.deepEqual(eventsOf(session,'tool_result','tool_call'),[toolCallsOf(session)[0],toolResultsOf(session)[0]]);
      assert.throws(()=>eventsOf(session),TypeError);
      const direct=await sessions.parse('codex',{path:${JSON.stringify(fixture)}});assert.deepEqual(direct.events,session.events);
      const {readFile}=await import('node:fs/promises');const acquired=await sessions.parse('codex',{jsonl:await readFile(${JSON.stringify(fixture)})});assert.deepEqual(acquired.events,session.events);
      const bytes=await readFile(${JSON.stringify(fixture)});
      async function* chunks(){for(const byte of bytes)yield new Uint8Array([byte]);}
      const streamed=sessions.stream('codex',{jsonl:chunks(),source:${JSON.stringify(fixture)}});
      const frames=[];for await(const frame of streamed)frames.push(frame);
      const expectedFrames=[];const directOpened=await sessions.open({id:'source:'+${JSON.stringify(fixture)},provider:'codex',source:{path:${JSON.stringify(fixture)},format:'jsonl'},metadata:{id_origin:'source_locator'}});
      for await(const frame of directOpened.stream())expectedFrames.push(frame);
      assert.deepEqual(frames,expectedFrames);assert.throws(()=>streamed[Symbol.asyncIterator](),TypeError);
      const {codexProvider}=await import('huihua/providers/codex');const providerFrames=[];
      for await(const frame of codexProvider.stream({jsonl:bytes,source:${JSON.stringify(fixture)}}))providerFrames.push(frame);
      assert.deepEqual(providerFrames,frames);
      const recorded=await sessions.parse('oar',{jsonl:await readFile(${JSON.stringify(resolve('fixtures/oar/voyage.jsonl'))})});assert.equal(recorded.id,'root');assert.equal(toolCallsOf(recorded).length,1);
      const acp=await sessions.parse('acp',{jsonl:await readFile(${JSON.stringify(resolve('fixtures/acp/v2.jsonl'))})});assert.equal(observe.fileChangesOf(acp).length,2);
      const agy=await sessions.parse('antigravity',{path:${JSON.stringify(resolve('fixtures/antigravity/steps.db'))},format:'antigravity_sqlite'});assert.equal(conversationOf(agy).length,2);assertSessionContract(agy);
      const opened=await sessions.open(refs[0]);assert.equal(opened.readMode,'incremental');assert.deepEqual(await opened.snapshot(),session);
      assert.equal(typeof opened.select,'function');const selectedFrames=[];
      for await(const frame of opened.select({events:['tool_call'],records:false,metadata:false}))selectedFrames.push(frame);
      assert.deepEqual(selectedFrames,expectedFrames.filter(frame=>frame.type==='diagnostic'||(frame.type==='event'&&frame.event.type==='tool_call')));
      const noMetadata=[];for await(const frame of opened.select({metadataKeys:[]}))noMetadata.push(frame);
      assert.deepEqual(noMetadata,expectedFrames.filter(frame=>frame.type!=='metadata'));
      assert.equal(typeof opened.consume,'function');const consumed=[];
      await assert.rejects(opened.consume({},null),/frame consumer must be a function/);
      await opened.consume({events:['tool_call'],records:false,metadata:false},async frame=>{consumed.push(frame);});
      assert.deepEqual(consumed,selectedFrames);
      const allConsumed=[];await directOpened.consume({},frame=>{allConsumed.push(frame);});assert.deepEqual(allConsumed,expectedFrames);
      assert.equal(typeof directOpened.consumeUsage,'function');
      const usageFrames=[];await directOpened.consumeUsage(frame=>{usageFrames.push(frame);});
      assert.ok(usageFrames.every(frame=>frame.type!=='record'));
      const comparableUsage=usageFrames.map(frame=>{if(frame.type!=='event')return frame;const {native_usage_context,...providerMetadata}=frame.event.providerMetadata;assert.ok(native_usage_context!==undefined);return {...frame,event:{...frame.event,providerMetadata}};});
      const expectedUsage=expectedFrames.flatMap(frame=>{if(frame.type==='diagnostic'||(frame.type==='event'&&frame.event.type==='usage'))return [frame];if(frame.type==='metadata'&&Object.hasOwn(frame.patch,'parentSessionId'))return [{type:'metadata',patch:{parentSessionId:frame.patch.parentSessionId}}];return [];});
      assert.deepEqual(comparableUsage,expectedUsage);
      assert.equal(typeof directOpened.consumeUsageFacts,'function');
      const usageFacts=[];await directOpened.consumeUsageFacts(item=>{usageFacts.push(item);});
      const expectedFacts=usageFrames.map(frame=>{if(frame.type!=='event')return frame;const {sequence,...fact}=frame.event;assert.ok(Number.isInteger(sequence));return fact;});
      assert.deepEqual(usageFacts,expectedFacts);
      await assert.rejects(()=>import('huihua/dist/shared/value.js'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
    `,
    )
    execFileSync(process.execPath, [join(root, 'smoke.mjs')], {
      cwd: root,
      stdio: 'inherit',
    })
    await writeFile(
      join(root, 'consumer.ts'),
      `
      import {sessions,defineProvider,type Provider,type SessionEvent,type SessionFrame,type SessionProvider,type ScanEvent,type ScanFailure,type ScanResult,type ErrorCode,type FrameSelection,type FrameConsumer,type UsageFactConsumer,type UsageFactItem} from 'huihua';
      import {createSessionRegistry,SessionRegistry} from 'huihua/registry';
      import {jsonlProvider,type Ingestion,type JsonlAdapter,type JsonlCandidate} from 'huihua/ingest';
      import {codexProvider} from 'huihua/providers/codex';
      import {conversationOf,eventsOf,fileChangesOf,subagentsOf,toolCallsOf,toolResultsOf} from 'huihua/observe';
      const provider=defineProvider(codexProvider);
      const custom:SessionRegistry=createSessionRegistry([provider]);void custom;
      const builtinProviders:readonly Extract<Provider,'copilot'|'hermes'|'openclaw'|'qwen'|'devin'|'fx'|'cline'|'deepseek'|'droid'>[]=['copilot','hermes','openclaw','qwen','devin','fx','cline','deepseek','droid'];
      const customProvider:Provider='consumer-custom';
      void builtinProviders;void customProvider;
      const report:ScanResult=await sessions.scan({providers:[provider.id]});
      const {refs}=report;
      const failures:readonly ScanFailure[]=report.failures;
      const failureCode:ErrorCode|'Unknown'=failures[0]?.code??'Unknown';
      const discoveries:AsyncIterable<ScanEvent>=sessions.scanStream({providers:[provider.id]});
      const nativeScan:AsyncIterable<ScanEvent>=provider.scan();
      for await(const event of discoveries){if(event.type==='ref'){const id:string=event.ref.id;void id;}else{const failure:ScanFailure=event.failure;void failure;}}
      void failures;void nativeScan;void failureCode;
      if(refs[0]){
        const snapshot=await sessions.read(refs[0]);
        const schema:'agent-session/v1'=snapshot.schema;
        const calls:readonly Extract<SessionEvent,{type:'tool_call'}>[]=toolCallsOf(snapshot);
        const results:readonly Extract<SessionEvent,{type:'tool_result'}>[]=toolResultsOf(snapshot);
        const selected:readonly Extract<SessionEvent,{type:'tool_call'|'tool_result'}>[]=eventsOf(snapshot,'tool_call','tool_result');
        const opened=await sessions.open(refs[0]);
        const selection:FrameSelection={events:['usage'],records:false,metadata:true,metadataKeys:['parentSessionId']};
        const selective:AsyncIterable<SessionFrame>|undefined=opened.select?.(selection);void selective;
        const consumer:FrameConsumer=frame=>{const canonical:SessionFrame=frame;void canonical;};
        const consumed:Promise<void>|undefined=opened.consume?.(selection,consumer);void consumed;
        const usage:Promise<void>|undefined=opened.consumeUsage?.(consumer);void usage;
        const factsConsumer:UsageFactConsumer=item=>{const fact:UsageFactItem=item;void fact;};
        const facts:Promise<void>|undefined=opened.consumeUsageFacts?.(factsConsumer,{acceptTimestamp:time=>time!==undefined});void facts;
        const batched=await sessions.open(refs[0],{batchDecode:true});void batched;
        const mode:'incremental'|'buffered'=opened.readMode;
        const names:readonly string[]=calls.map(event=>event.data.toolName);
        conversationOf(snapshot);fileChangesOf(snapshot);subagentsOf(snapshot);
        void schema;void results;void selected;void mode;void names;
      }
      const acquired=await sessions.parse('codex',{jsonl:new Uint8Array()});
      const fromFile=await sessions.parse('codex',{path:'rollout.jsonl'});
      async function* bytes(){yield new Uint8Array();}
      const frames:AsyncIterable<SessionFrame>=sessions.stream('codex',{jsonl:bytes(),source:'stored-object:consumer'});
      const providerFrames:AsyncIterable<SessionFrame>=codexProvider.stream({jsonl:new Uint8Array()});
      const kitAdapter:JsonlAdapter={id:'kit',roots:()=>[],metadata:()=>({}),parse:(lines:Ingestion)=>{void lines;}};
      const kitRegistry:SessionRegistry=createSessionRegistry([jsonlProvider(kitAdapter)]);void kitRegistry;
      const candidate:JsonlCandidate|undefined=undefined;void candidate;
      const adapter:SessionProvider=provider;
      if(adapter.stream){const customFrames:AsyncIterable<SessionFrame>=adapter.stream({jsonl:''});void customFrames;}
      for await(const frame of frames){if(frame.type==='event'){const event:SessionEvent=frame.event;void event;}}
      void acquired;void fromFile;void providerFrames;
      `,
    )
    execFileSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--module',
        'nodenext',
        '--target',
        'es2023',
        '--typeRoots',
        resolve('node_modules/@types'),
        join(root, 'consumer.ts'),
      ],
      { cwd: root, stdio: 'inherit' },
    )
    process.stdout.write(
      `Installed ESM package verified (${packed.files.length} files).\n`,
    )
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}
