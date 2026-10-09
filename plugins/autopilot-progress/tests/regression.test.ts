import {expect,mock,test} from 'claude-code/testing'
import {parse,stats,clockOf} from '../hooks/register'
const now=Date.parse('2026-10-09T10:00:00Z')
function count(data:any){const r=parse(data,'/work');return stats(r,clockOf(r,[],now))}
test('finished with failures is never 100 percent',async()=>{
 const s=count({finishedAt:'2026-10-09T10:00:00Z',tests:{failed:1},tickets:[]})
 expect(s.overall===100).toBe(false)
})
test('finished with failed ticket is never 100 percent',async()=>{
 expect(count({finishedAt:'2026-10-09T10:00:00Z',tickets:[{id:'1',status:'failed'}]}).overall===100).toBe(false)
})
test('valid success is complete',async()=>{
 expect(count({finishedAt:'2026-10-09T10:00:00Z'}).overall).toBe(100)
})
test('coverage clamps external malformed counts',async()=>{
 expect(count({requirements:{total:2,done:4}}).coverage).toBe(100)
 expect(count({requirements:{total:2,done:-4}}).coverage).toBe(0)
})
test('cyclic dependencies have no misleading ETA',async()=>{
 const s=count({tickets:[{id:'done',status:'done',startedAt:'2026-10-09T09:00:00Z',finishedAt:'2026-10-09T09:05:00Z'},{id:'a',blockedBy:['b']},{id:'b',blockedBy:['a']}]})
 expect(s.eta).toBe(null)
})
test('null state is rejected without eval',async()=>{
 expect(()=>parse(null,'/work')).toThrow()
 expect(()=>parse([],'/work')).toThrow()
})

test('broken main state does not hide valid worktree; timer stops on finish',async($,on)=>{
 const clock=mock.clock(on,{now:5000});let finished=false
 on('session.start',()=>({cwd:'/work'}))
 on('session.cwd',()=>({value:'/work'}))
 on('command.register',()=>({value:undefined}))
 on('process.run',()=>({value:{exitCode:0,stdout:'worktree /work\n\nworktree /other\nbranch refs/heads/test\n',stderr:''}}))
 on('ui.toast',()=>({value:undefined}))
 on('fs.read',($,e)=>{
  if(e.path.startsWith('/work/'))return {value:'{partial'}
  if(e.path.endsWith('state.json'))return {value:JSON.stringify({title:'Valid worktree',startedAt:'2026-10-09T09:00:00Z',...(finished?{finishedAt:'2026-10-09T10:00:00Z'}:{})})}
  return {deny:'missing'}
 })
 await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'})
 const pane={plugin:'autopilot-progress',component:'Pane',requestId:'autopilot-progress',surface:'terminal',viewport:{columns:100,rows:30},props:{title:'',isFocused:true,bodyColumns:80,placement:'inline',scroll:{offset:0,bodyRows:20},view:{}}}
 const ui=await $.ui.mount(pane)
 expect(await ui.find({type:'Text',text:/Valid worktree/})).toBeDefined()
 await ui.unmount()
 finished=true;await clock.advance(3000);await clock.advance(3000)
 const completed=await $.ui.mount(pane)
 expect(await completed.find({type:'Text',text:/100/})).toBeDefined()
 await completed.unmount()
})
