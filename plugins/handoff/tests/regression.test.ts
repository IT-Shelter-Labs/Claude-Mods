import { expect, mock, test } from 'claude-code/testing'
import { validDocument } from '../hooks/document'
const body=(id:string)=>'## Цель\n'+ 'Сохранённая задача. '.repeat(15)+'\n## Что осталось\nПроверить результат.\n<!-- handoff-transfer:'+id+':complete -->'
test('only complete transfer with correct ID accepted',async()=>{
 expect(validDocument(body('a'),'a')).toBe(true)
 expect(validDocument(body('a'),'b')).toBe(false)
 expect(validDocument(body('a').replace('## Что осталось','## Другое'),'a')).toBe(false)
 expect(validDocument(body('a')+' partial','a')).toBe(false)
 expect(validDocument('## Цель\n## Что осталось','a')).toBe(false)
})
for(const scenario of ['partial','aborted','complete','duplicate','cancel']) {
 test('handoff '+scenario,async($,on)=>{
  const clock=mock.clock(on,{now:5000});mock.env(on,{HOME:'/home/me'})
  const store=new Map();let clear=0,continuations=0
  on('store.get',($,e)=>({value:store.get(e.key)}))
  on('store.set',($,e)=>{store.set(e.key,e.value);return {value:undefined}})
  on('store.delete',($,e)=>{store.delete(e.key);return {value:undefined}})
  on('session.id',()=>({value:'original-session'}))
  on('session.start',()=>({cwd:'/work'}))
  on('command.register',()=>({value:undefined}))
  on('ui.toast',()=>({value:undefined}))
  on('command.run',($,e)=>{if(e.command==='clear')clear++;return {text:''}})
  on('prompt.submit',($,e)=>{continuations++;return {text:e.text}})
  on('fs.stat',()=>({value:{mtimeMs:5000,size:500,kind:'file'}}))
  on('fs.read',()=>({value:scenario==='partial'?'unfinished':body(store.get('s:original-session')?.pending?.transferId)}))
  on('turn.start',($,e)=>({turnId:e.turnId}))
  on('turn.complete',()=>({text:''}))
  await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'})
  await $.command.run({command:'handoff-now'})
  await clock.advance(2)
  const p=store.get('s:original-session')?.pending
  expect(p?.transferId).toBeDefined()
  await $.turn.start({turnId:'writing',text:p.path})
  if(scenario==='cancel') await $.command.run({command:'handoff-cancel'})
  await $.turn.complete({turnId:'writing',answer:'saved',durationMs:1,isAborted:scenario==='aborted',usage:null})
  if(scenario==='duplicate')await $.turn.complete({turnId:'writing',answer:'saved',durationMs:1,isAborted:false,usage:null})
  await clock.advance(2)
  expect(clear).toBe(['complete','duplicate'].includes(scenario)?1:0)
  expect(continuations).toBe(clear)
 })
}
test('threshold refuses numeric sentinel',async($,on)=>{
 expect((await $.command.run({command:'handoff-threshold',args:'1000'})).text).toContain('30–90')
})

test('expired transfer never clears and cancellation persists',async($,on)=>{
 const clock=mock.clock(on,{now:5000});mock.env(on,{HOME:'/home/me'})
 const store=new Map();let clear=0
 on('store.get',($,e)=>({value:store.get(e.key)}))
 on('store.set',($,e)=>{store.set(e.key,e.value);return {value:undefined}})
 on('session.id',()=>({value:'session'}))
 on('session.start',()=>({cwd:'/work'}))
 on('command.register',()=>({value:undefined}))
 on('ui.toast',()=>({value:undefined}))
 on('command.run',($,e)=>{if(e.command==='clear')clear++;return {text:''}})
 await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'})
 await $.command.run({command:'handoff-now'});await clock.advance(2)
 expect(store.get('s:session').pending).toBeDefined()
 await clock.advance(901002)
 expect(store.get('s:session').pending).toBe(null);expect(clear).toBe(0)
})
