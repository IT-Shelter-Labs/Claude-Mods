import { expect, mock, test } from 'claude-code/testing'
import { analyze, literalPath } from '../hooks/analyze'
for (const command of ['rm -rf /tmp/x', 'sudo -u root rm "a b"', 'env -u HOME rm x', 'bash -c "rm -rf x"', 'git push -vf origin main', 'git reset --hard', 'find . -delete', 'Remove-Item -Recurse x', 'sqlite3 data.db "DROP TABLE people;"', 'echo "$(rm -rf x)"']) {
 test('guards ' + command, async () => { expect(analyze(command)).not.toBe(null) })
}
for (const command of ['echo "rm -rf x"', "echo '$(rm -rf x)'", 'git status', 'printf "DROP TABLE x"']) {
 test('allows inert text ' + command, async () => { expect(analyze(command)).toBe(null) })
}
test('preserves a quoted path and refuses unknown home', async () => {
 expect(analyze('rm -- "folder with spaces"')?.targets).toEqual(['folder with spaces'])
 expect(literalPath('~/x','','/work')).toBe(null)
 expect(literalPath('folder with spaces','/home/me','/work')).toBe('/work/folder with spaces')
})
test('headless destructive tool never reaches core', async ($, on) => {
 let executed = 0
 on('tool.call', () => { executed++; return { result: 'executed' } })
 const result = await $.tool.call({tool:'Bash',command:'rm -rf x'})
 expect(result.deny).toContain('ручного подтверждения')
 expect(executed).toBe(0)
})
for (const answer of ['Отменить','Выполнить']) {
 test('interactive ' + answer, async ($,on) => {
  let executed=0
  mock.env(on,{HOME:'/home/me'})
  on('session.start',()=>({cwd:'/work'}))
  on('session.cwd',()=>({value:'/work'}))
  on('session.surfaces',()=>({value:['terminal']}))
  on('fs.stat',()=>({value:{size:42,kind:'file',mtimeMs:0}}))
  on('tool.call',($,e)=>{
   if(e.tool==='AskUserQuestion') return {result:{answers:{[e.questions[0].question]:answer}}}
   executed++; return {result:'executed'}
  })
  await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'})
  const result = await $.tool.call({tool:'Bash',command:'rm "folder with spaces"'})
  expect(executed).toBe(answer==='Выполнить'?1:0)
  if(answer==='Отменить') expect(result.deny).toContain('отменил')
 })
}
test('failed approval denies execution',async($,on)=>{
 mock.env(on,{HOME:'/home/me'})
 on('session.start',()=>({cwd:'/work'}))
 on('session.cwd',()=>({value:'/work'}))
 on('session.surfaces',()=>({value:['terminal']}))
 on('fs.stat',()=>({value:{size:42,kind:'file',mtimeMs:0}}))
 on('tool.call',()=>({deny:'UI unavailable'}))
 await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'})
 expect((await $.tool.call({tool:'Bash',command:'rm x'})).deny).toContain('подтверждение не получено')
})
