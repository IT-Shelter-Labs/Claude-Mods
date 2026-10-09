import { expect, mock, test } from 'claude-code/testing'
import { reportMatches,validSessionId } from '../hooks/helpers'
const sid='00000000-0000-4000-8000-000000000001'
const token='00000000-0000-4000-8000-000000000002'
test('correlates reports without nonexistent sender fields',async()=>{
 expect(validSessionId('a; rm -rf /')).toBe(false)
 expect(reportMatches({kind:'peer-send-message'},'[report:'+token+']',token)).toBe(true)
 expect(reportMatches({kind:'bridge'},'[report:'+token+']',token)).toBe(false)
 expect(reportMatches({kind:'peer'},'[report:wrong]',token)).toBe(false)
})
for(const scenario of ['wrong-token','correct','stopped']) {
 test('incoming report '+scenario,async($,on)=>{
  const row={name:'review',model:'sonnet',sessionId:sid,reportToken:token,kind:'chat',status:scenario==='stopped'?'остановлен':'работает',cwd:'/work',log:[],startedAt:5000,endedAt:0,actions:0,result:''}
  const store=new Map([['list:main',{at:Date.now(),list:[row]}]])
  mock.env(on,{CLAUDE_CODE_HOST_SESSION_ID:'main'})
  on('store.get',($,e)=>({value:store.get(e.key)}))
  on('store.set',($,e)=>{store.set(e.key,e.value);return {value:undefined}})
  on('session.receive',($,e)=>({text:e.text}))
  const used=scenario==='wrong-token'?sid:token
  await $.session.receive({origin:{kind:'peer-send-message'},text:'[threads] review: готов\n[report:'+used+']\nResult'})
  const status=(await $.tool.call({tool:'mcp__threads__status'})).result
  expect(status).toContain(scenario==='correct'?'готов':scenario==='stopped'?'остановлен':'работает')
 })
}
test('writing collision refuses launch before process call',async($,on)=>{
 const store=new Map([['list:main',{at:Date.now(),list:[{name:'one',sessionId:sid,kind:'cli',status:'работает',cwd:'/work',readOnly:false}]}]])
 mock.env(on,{CLAUDE_CODE_HOST_SESSION_ID:'main',CLAUDE_CODE_ENTRYPOINT:'cli'})
 on('store.get',($,e)=>({value:store.get(e.key)}))
 on('store.set',($,e)=>{store.set(e.key,e.value);return {value:undefined}})
 on('fs.list',()=>({value:[]}))
 on('session.cwd',()=>({value:'/work'}))
 const r=await $.tool.call({tool:'mcp__threads__start',name:'two',task:'fix',readOnly:false})
 expect(r.result).toContain('отдельную рабочую копию')
 expect(store.get('list:main').list.length).toBe(1)
})
test('cap rejects invalid values without persistence',async($,on)=>{
 expect((await $.command.run({command:'threads',args:'cap 20'})).text).toContain('1–8')
})
test('default is plan with explicit cwd; supported process API',async($,on)=>{
 const store=new Map();const calls:any[]=[]
 const clock=mock.clock(on,{now:5000})
 mock.env(on,{CLAUDE_CODE_HOST_SESSION_ID:'main',CLAUDE_CODE_ENTRYPOINT:'cli'})
 on('store.get',($,e)=>({value:store.get(e.key)}))
 on('store.set',($,e)=>{store.set(e.key,e.value);return {value:undefined}})
 on('store.delete',()=>({value:undefined}))
 on('fs.list',()=>({value:[]}))
 on('session.cwd',()=>({value:'/work'}))
 on('ui.open',()=>({value:{isPlaced:true}}))
 on('process.run',($,e)=>{calls.push(e);return {value:{exitCode:0,stdout:'',stderr:''}}})
 on('prompt.submit',($,e)=>({text:e.text}))
 await $.tool.call({tool:'mcp__threads__start',name:'review',task:'check',cwd:'/other'})
 // Read status waits on the same state gate, flushing launch.
 await $.tool.call({tool:'mcp__threads__status'})
 for(let i=0;i<10;i++) await $.tool.call({tool:'mcp__threads__status'})
 await clock.settle()
 const row=store.get('list:main').list[0]
 expect(row.readOnly).toBe(true);expect(row.mode).toBe('plan');expect(row.cwd).toBe('/other')
 const call=calls.find(x=>x.argv.includes('-p'))
 expect(call?.init.cwd).toBe('/other');expect(call?.init.timeoutMs).toBe(600000)
})

test('Windows stop uses exact session flag and preserves status on failure',async($,on)=>{
 const row={name:'worker',model:'sonnet',sessionId:sid,kind:'cli',status:'работает',cwd:'C:/work',readOnly:true,startedAt:5000}
 const store=new Map([['list:main',{at:Date.now(),list:[row]}]]);const calls:any[]=[]
 mock.env(on,{CLAUDE_CODE_HOST_SESSION_ID:'main',OS:'Windows_NT'})
 on('session.id',()=>({value:'main'}))
 on('store.get',($,e)=>({value:store.get(e.key)}))
 on('store.set',($,e)=>{store.set(e.key,e.value);return {value:undefined}})
 on('ui.toast',()=>({value:undefined}))
 on('process.run',($,e)=>{calls.push(e.argv);return {value:{exitCode:3,stdout:'',stderr:''}}})
 const result=await $.tool.call({tool:'mcp__threads__stop',name:'worker'})
 expect(result.result).toContain('не подтверждена')
 expect(store.get('list:main').list[0].status).toBe('работает')
 expect(calls.length).toBe(1);expect(calls[0][0]).toBe('powershell')
 expect(calls[0][4]).toContain('--(resume|session-id)')
 expect(calls[0][4]).toContain(sid)
})
test('cap enforces active limit before launching',async($,on)=>{
 const list=[1,2,3].map((n)=>({name:'worker'+n,sessionId:sid,kind:'chat',status:'работает',cwd:'C:/work',readOnly:true}))
 const store=new Map([['list:main',{at:Date.now(),list}]])
 mock.env(on,{CLAUDE_CODE_HOST_SESSION_ID:'main'})
 on('store.get',($,e)=>({value:store.get(e.key)}))
 on('store.set',($,e)=>{store.set(e.key,e.value);return {value:undefined}})
 on('fs.list',()=>({value:[]}))
 const r=await $.tool.call({tool:'mcp__threads__start',name:'four',task:'review',cwd:'C:/work'})
 expect(r.result).toContain('Достигнут лимит')
 expect(store.get('list:main').list.length).toBe(3)
})
