import {expect,mock,test} from 'claude-code/testing'
import {projectOf,parseLoose} from '../hooks/register'
test('Windows and Unix project names',async()=>{
 expect(projectOf('C:\\Users\\me\\site')).toBe('site')
 expect(projectOf('/home/me/site')).toBe('site')
 expect(projectOf(undefined)).toBe('—')
})
test('parse wrapped JSON and empty lists',async()=>{
 expect(parseLoose('Found: [{"sessionId":"x"}]')).toEqual([{sessionId:'x'}])
 expect(parseLoose('[]')).toEqual([])
})
test('terminal reports unsupported surface before MCP',async($,on)=>{
 mock.env(on,{CLAUDE_CODE_ENTRYPOINT:'cli'})
 on('session.surfaces',()=>({value:['terminal']}))
 const r=await $.command.run({command:'sessions'})
 expect(r.text).toContain('Claude Desktop')
})
