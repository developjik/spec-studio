import { ProjectBundleSchema } from '@spec-studio/protocol';
import { expect,it } from 'vitest';
import { createProject,execute } from '@spec-studio/core';
import { parseProjectFile,parseBundleFile,serializeProject,bundleOf } from '../src/model/storage';

it('stores each image once and reconstructs the active alias and high-water counter',()=>{
 const at='2026-11-19T00:00:00Z';let i=0;
 const ctx={at,nextId:(kind:string)=>`${kind==='doc'?'D':'P'}_${String(++i).padStart(12,'0')}`};
 const screen={id:'S_aaaaaaaaaaaa',title:'화면',code:'SCR-101',ref:{kind:'image' as const,value:'data:image/png;base64,VU5JUVVF'},viewport:{width:10,height:10},createdAt:at,updatedAt:at};
 let project=execute(createProject({id:'PRJ_aaaaaaaaaaaa',name:'설계',at}),{type:'screen.add',screen},ctx).project;
 project=execute(project,{type:'pin.create',screenId:screen.id,pinType:'function',title:'핀',body:'',anchor:{x:.5,y:.5}},ctx).project;
 const text=serializeProject(project);expect(text.match(/VU5JUVVF/g)).toHaveLength(1);
 const single=bundleOf(project,at);expect(single.version).toBe(1);expect(single.project.screen?.id).toBe(screen.id);expect(parseBundleFile(JSON.stringify(single)).project.screen?.id).toBe(screen.id);
 const restored=parseProjectFile(text);expect(restored.screen).toEqual(screen);expect(restored.activeScreenId).toBe(screen.id);expect(restored.pinSeq).toBe(1);expect(restored.pins).toEqual(project.pins);
});

it('exports multi-screen bundles as v2 and reads them without losing screen ownership',()=>{
 const at='2026-11-19T00:00:00Z';let n=0;const ctx={at,nextId:(kind:string)=>`${kind==='doc'?'D':'P'}_${String(++n).padStart(12,'0')}`};
 let project=createProject({id:'PRJ_aaaaaaaaaaaa',name:'설계',at});
 for(const [id,code] of [['S_aaaaaaaaaaaa','SCR-101'],['S_bbbbbbbbbbbb','SCR-102']]){
 const screen={id,title:code,code,ref:{kind:'image' as const,value:'data:image/png;base64,VU5JUVVF'},viewport:{width:10,height:10},createdAt:at,updatedAt:at};
 project=execute(project,{type:'screen.add',screen},ctx).project;
 project=execute(project,{type:'pin.create',screenId:id,pinType:'function',title:'핀',body:'',anchor:{x:.5,y:.5}},ctx).project;
 }
 const bundle=bundleOf(project,at);expect(bundle.version).toBe(2);
 ProjectBundleSchema.parse(bundle);const restored=parseBundleFile(JSON.stringify(bundle));expect(restored.project.screens).toHaveLength(2);expect(restored.project.pins.map(p=>[p.screenId,p.number])).toEqual(project.pins.map(p=>[p.screenId,p.number]));
});

it('uses v3 for hidden rich data and preserves opaque nested data on browser import',()=>{
 const at='2026-11-19T00:00:00Z';const project=createProject({id:'PRJ_aaaaaaaaaaaa',name:'보존',at});
 const base={id:'B_aaaaaaaaaaaa',type:'paragraph',text:'',pinRefs:[],createdAt:at,updatedAt:at};
 project.docs=[{id:'D_aaaaaaaaaaaa',title:'문서',rev:0,kind:'spec',deletedAt:null,createdAt:at,updatedAt:at,blocks:[{...base,data:{table:{rows:[['보존']],header:true}}},{...base,id:'B_bbbbbbbbbbbb',type:'future-table',data:{table:{rows:[['확장']],header:true,columnWidths:[120,240]},code:{custom:{x:1}}}}]}];
 const bundle=bundleOf(project,at);expect(bundle.version).toBe(3);expect(parseBundleFile(JSON.stringify(bundle)).project.docs[0]!.blocks).toEqual(project.docs[0]!.blocks);
});
