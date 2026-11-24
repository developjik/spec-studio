import { expect,it } from 'vitest';
import { createProject,execute } from '@spec-studio/core';
import { parseProjectFile,serializeProject } from '../src/model/storage';

it('stores each image once and reconstructs the active alias and high-water counter',()=>{
 const at='2026-11-19T00:00:00Z';let i=0;
 const ctx={at,nextId:(kind:string)=>`${kind==='doc'?'D':'P'}_${String(++i).padStart(12,'0')}`};
 const screen={id:'S_aaaaaaaaaaaa',title:'화면',code:'SCR-101',ref:{kind:'image' as const,value:'data:image/png;base64,VU5JUVVF'},viewport:{width:10,height:10},createdAt:at,updatedAt:at};
 let project=execute(createProject({id:'PRJ_aaaaaaaaaaaa',name:'설계',at}),{type:'screen.add',screen},ctx).project;
 project=execute(project,{type:'pin.create',screenId:screen.id,pinType:'function',title:'핀',body:'',anchor:{x:.5,y:.5}},ctx).project;
 const text=serializeProject(project);expect(text.match(/VU5JUVVF/g)).toHaveLength(1);
 const restored=parseProjectFile(text);expect(restored.screen).toEqual(screen);expect(restored.activeScreenId).toBe(screen.id);expect(restored.pinSeq).toBe(1);expect(restored.pins).toEqual(project.pins);
});
