import {it,expect} from 'vitest';
import type {Doc,Screen} from '@spec-studio/protocol';
import {renderPublishBody,specFingerprint} from '../src';
const at='2026-11-19T00:00:00Z';
const screen:Screen={id:'S_aaaaaaaaaaaa',title:'화면',code:'SCR-110',ref:{kind:'image',value:'data:image/svg+xml;base64,PHN2Zy8+'},viewport:null,createdAt:at,updatedAt:at};
it('publishes rich cells/code and fingerprints structured changes',()=>{
 const doc:Doc={id:'D_aaaaaaaaaaaa',title:'문서',rev:1,kind:'spec',deletedAt:null,createdAt:at,updatedAt:at,blocks:[{id:'B_aaaaaaaaaaaa',type:'table',text:'',data:{table:{rows:[['헤더'],['<script>']],header:true}},pinRefs:[],createdAt:at,updatedAt:at},{id:'B_bbbbbbbbbbbb',type:'code',text:'a < b',data:{code:{language:'typescript',lineNumbers:false}},pinRefs:[],createdAt:at,updatedAt:at}]};
 const html=renderPublishBody({projectName:'프로젝트',figmaUrl:null,specHash:'abc',screen,pins:[],pinSeq:0,generatedAt:at,doc,attachments:[]});expect(html).toContain('<th>헤더</th>');expect(html).toContain('&lt;script&gt;');expect(html).toContain('<code>a &lt; b</code>');expect(html).not.toContain('<script>');
 const changed={...doc,blocks:doc.blocks.map((block,i)=>i===0?{...block,data:{table:{rows:[['헤더'],['수정']],header:true}}}:block)};expect(specFingerprint({screen,pins:[],figmaUrl:null,doc})).not.toBe(specFingerprint({screen,pins:[],figmaUrl:null,doc:changed}));
});
