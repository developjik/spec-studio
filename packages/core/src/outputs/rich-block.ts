import { isKnownBlockType, parseImageDataUrl, type Block, type Screen } from '@spec-studio/protocol';
const escape = (value:string) => value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
/** Shared escaped document markup for HTML, print/PDF and Confluence. No remote images. */
export function renderRichBlock(block:Block, screen?:Screen):string {
 const text=escape(block.text);
 if(block.type==='table' && block.data?.table){
  const {rows,header}=block.data.table;
  return `<table class="rich-table"><tbody>${rows.map((row,i)=>`<tr>${row.map(cell=>{const tag=header&&i===0?'th':'td';return `<${tag}>${escape(cell).replace(/\n/g,'<br />')}</${tag}>`}).join('')}</tr>`).join('')}</tbody></table>${text?`<p>${text}</p>`:''}`;
 }
 if(block.type==='code')return `<pre class="rich-code" data-language="${escape(block.data?.code?.language??'text')}"><code>${text}</code></pre>`;
 if(block.type==='figure'){
  const f=block.data?.figure;const image=f&&screen?.id===f.screenId&&screen.ref.kind==='image'&&parseImageDataUrl(screen.ref.value)?screen.ref.value:null;
  return `<figure>${image?`<img style="max-width:100%;height:auto" src="${escape(image)}" alt="${escape(f?.alt??'')}" />`:'<p>연결된 화면 캡처를 사용할 수 없습니다.</p>'}<figcaption>${escape(f?.alt??'그림 설명 없음')}${f?.pinId?' · 연결 핀 '+escape(f.pinId):''}${text?' · '+text:''}</figcaption></figure>`;
 }
 if(!isKnownBlockType(block.type))return `<section class="unknown-block"><p>읽기 전용 블록: ${escape(block.type)}</p><pre>${text}</pre></section>`;
 if(block.type==='heading')return `<h3>${text}</h3>`;
 if(block.type==='list')return `<ul>${block.text.split(/\r?\n/).map(line=>`<li>${escape(line)}</li>`).join('')}</ul>`;
 return `<p>${text.replace(/\r?\n/g,'<br />')}</p>`;
}
export const RICH_BLOCK_CSS = '.rich-table{width:100%;border-collapse:collapse;table-layout:fixed}.rich-table th,.rich-table td{border:1px solid #ccd2dd;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left}.rich-code{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f8;padding:12px;font-family:monospace;tab-size:2}figure{margin:12px 0}figcaption{font-size:12px;color:#576175}.unknown-block{border:1px dashed #9ca4b4;padding:10px}.rich-code,.doc-block figure,.rich-table tr{break-inside:avoid}.unknown-block pre{white-space:pre-wrap;overflow-wrap:anywhere}';
