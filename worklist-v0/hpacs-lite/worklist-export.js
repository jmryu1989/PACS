(function(root){
  'use strict';
  /* FA-066 (Minhoon M-101, 10-05: keep #19 "selected studies or the search results, in the columns I choose, as a file for
     Excel"). Export List writes the worklist rows the browser already holds; nothing is read from or written to the server.
     The file is UTF-8 with a BOM (Excel reads Korean names) and CRLF lines; the first line is the column titles the list shows.
     Two rules change a value and are stated in the dialog: a cell that starts like a spreadsheet formula (=, +, @, a tab or
     carriage return, or '-' not followed by a plain number) gets a leading apostrophe, and the Text format turns tabs and line
     breaks inside a value into one space (they would split the row). */
  const NUMBER=/^-\d+(\.\d+)?$/;
  function guard(text){return /^[=+@\t\r]/.test(text)||(text[0]==='-'&&!NUMBER.test(text))?"'"+text:text;}
  function field(value,format){
    const text=guard(String(value??''));
    if(format==='txt')return text.replace(/[\t\r\n]+/g,' ');
    return /[",\r\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;
  }
  /** rows: [{study, no}] in the list order; columns: [{k, t}]; cellText(study, column, no) is the text the list shows. */
  function table(rows,columns,cellText,format){
    const sep=format==='txt'?'\t':',';
    const lines=[columns.map(c=>field(c.t,format)).join(sep)];
    for(const row of rows)lines.push(columns.map(c=>field(cellText(row.study,c,row.no),format)).join(sep));
    return '﻿'+lines.join('\r\n')+'\r\n';
  }
  function fileName(date,format){
    const p=n=>String(n).padStart(2,'0');
    return `worklist-${date.getFullYear()}${p(date.getMonth()+1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.${format==='txt'?'txt':'csv'}`;
  }
  function mount(options){
    const button=options.button,initial=options.owner();
    let ended=false,dialog=null;
    const live=()=>!ended&&!!initial&&options.owner()===initial;
    const el=(tag,text,parent)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(parent)parent.append(e);return e;};
    function open(){
      if(!live())return;
      // One snapshot per opening: the counts shown are the rows written, and No keeps each study's place in the search result.
      const listed=options.rows().map((study,i)=>({study,no:i+1}));
      const chosen=new Set(options.selected()||[]),selected=listed.filter(r=>chosen.has(r.study.uid));
      const all=options.columns(),shownKeys=new Set(options.shown().map(c=>c.k));
      const order=[...options.shown().map(c=>all.find(x=>x.k===c.k)).filter(Boolean),...all.filter(c=>!shownKeys.has(c.k))];
      dialog?.remove();
      dialog=el('dialog',null,document.body);dialog.id='worklist-export-dialog';dialog.setAttribute('aria-labelledby','worklist-export-title');
      dialog.style.cssText='max-width:min(720px,94vw);max-height:85vh;overflow:auto;color:inherit;background:#142237;border:1px solid #355272;padding:20px';
      el('h2','Export List',dialog).id='worklist-export-title';
      const scope=el('fieldset',null,dialog);el('legend','Studies',scope);
      const radio=(value,label,count,note)=>{
        const line=el('div',null,scope),lab=el('label',null,line),input=el('input',null,lab);
        input.type='radio';input.name='worklist-export-scope';input.value=value;input.disabled=!count;
        lab.append(` ${label} (${count})`);if(note)el('small',' '+note,line);return input;
      };
      const pickSelected=radio('selected','Selected Studies',selected.length,null);
      const pickAll=radio('all','All Search Results',listed.length,'현재 불러온 목록의 모든 페이지');
      (selected.length?pickSelected:pickAll).checked=true;
      const cols=el('fieldset',null,dialog);el('legend','Columns',cols);
      const boxes=order.map(c=>{
        const lab=el('label',null,cols),box=el('input',null,lab);lab.style.cssText='display:inline-block;margin:2px 10px 2px 0';
        box.type='checkbox';box.value=c.k;box.checked=shownKeys.has(c.k);lab.append(' '+c.t);return {c,box};
      });
      const formatLabel=el('label','Format ',dialog),format=el('select',null,formatLabel);format.dataset.exportFormat='';
      for(const [v,t] of [['csv','CSV (Excel)'],['txt','Text (Tab-Delimited)']]){const o=el('option',t,format);o.value=v;}
      el('p','Excel에서 열리는 UTF-8 파일로 내려받습니다. =, +, @, 탭·줄바꿈 문자로 시작하거나 -로 시작하지만 숫자(-3, -0.5 등)가 아닌 값은 앞에 \'를 붙이고, Text 형식은 값 안의 탭·줄바꿈을 공백으로 바꿉니다.',dialog).style.fontSize='12px';
      const actions=el('p',null,dialog),run=el('button','Export',actions);actions.append(' ');const cancel=el('button','Cancel',actions);
      run.type=cancel.type='button';run.className=cancel.className='chip';run.dataset.exportRun='';
      const rowsFor=()=>pickSelected.checked?selected:pickAll.checked?listed:[];
      const columnsFor=()=>boxes.filter(b=>b.box.checked).map(b=>b.c);
      const update=()=>{run.disabled=!rowsFor().length||!columnsFor().length;};
      dialog.addEventListener('change',update);update();
      cancel.onclick=()=>dialog.close();
      run.onclick=()=>{
        if(!live())return;
        const rows=rowsFor(),columns=columnsFor(),kind=format.value;if(!rows.length||!columns.length)return;
        const name=fileName(new Date(),kind);
        const blob=new Blob([table(rows,columns,options.cellText,kind)],{type:kind==='txt'?'text/plain;charset=utf-8':'text/csv;charset=utf-8'});
        const a=el('a',null,null);a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(a.href),0);
        dialog.close();options.notify?.(`${rows.length}건을 내보냈습니다 (${name}).`);
      };
      dialog.addEventListener('close',()=>{if(live())button.focus();});
      dialog.showModal();
    }
    function end(){if(ended)return;ended=true;dialog?.remove();dialog=null;button.disabled=true;button.removeEventListener('click',open);root.removeEventListener('pagehide',end);}
    // The page calls sync(count) each time it draws the list, so an empty search result disables the button and a new one
    // enables it again.
    function sync(count=options.rows().length){button.disabled=!live()||!count;}
    button.addEventListener('click',open);sync();
    root.KinWorkContext?.onInvalidate?.(event=>{if(event.reason==='lifecycle'&&!['active','preparing'].includes(event.state))end();});
    root.addEventListener('pagehide',end);
    return {sync,end};
  }
  const api={table,fileName,field,mount};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorklistExport=api;
})(typeof window!=='undefined'?window:globalThis);
