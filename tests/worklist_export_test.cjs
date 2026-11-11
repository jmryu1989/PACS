const test=require('node:test'),assert=require('node:assert/strict');
const {table,fileName,field}=require('../worklist-v0/hpacs-lite/worklist-export');
// FA-066 Export List text model: the bytes a reader opens in Excel (CSV) or a text editor (Text, tab-delimited).
const cols=[{k:'id',t:'ID'},{k:'name',t:'Name'},{k:'desc',t:'StudyDesc'}];
const text=(s,c)=>s[c.k];
test('CSV: BOM, CRLF, header from the list titles, RFC 4180 quoting',()=>{
  const out=table([{study:{id:'SYN-1',name:'HONG, GILDONG',desc:'CT "chest"\nwith contrast'},no:1},{study:{id:'SYN-2',name:'김영희',desc:''},no:2}],cols,text,'csv');
  assert.equal(out,'﻿ID,Name,StudyDesc\r\nSYN-1,"HONG, GILDONG","CT ""chest""\nwith contrast"\r\nSYN-2,김영희,\r\n');
});
test('Text: tab-delimited, tabs and line breaks inside a value become one space',()=>{
  const out=table([{study:{id:'SYN-1',name:'A\tB',desc:'x\r\ny'},no:1}],cols,text,'txt');
  assert.equal(out,'﻿ID\tName\tStudyDesc\r\nSYN-1\tA B\tx y\r\n');
});
test('a value that starts like a formula gets an apostrophe; plain negative numbers stay',()=>{
  for(const [value,want] of [['=1+1',"'=1+1"],['+82',"'+82"],['@SUM(A1)',"'@SUM(A1)"],['-',"'-"],['-x',"'-x"],
    ['\tTAB',"'\tTAB"],['-3','-3'],['-0.5','-0.5'],['0','0'],['',''],[null,''],[undefined,''],['A-1','A-1']])
    assert.equal(field(value,'csv'),want,String(value));
  assert.equal(field('\tTAB','txt'),"' TAB");
  assert.equal(field('=A1,B1','csv'),`"'=A1,B1"`);
});
test('the cell text is asked with each row\'s own number, so No keeps the search order',()=>{
  const seen=[];table([{study:{id:'b'},no:7},{study:{id:'a'},no:2}],[{k:'no',t:'No'}],(s,c,no)=>{seen.push([s.id,no]);return no;},'csv');
  assert.deepEqual(seen,[['b',7],['a',2]]);
});
test('file name is local date and time with the format extension',()=>{
  const d=new Date(2026,10,1,9,5,7);
  assert.equal(fileName(d,'csv'),'worklist-20261101-090507.csv');
  assert.equal(fileName(d,'txt'),'worklist-20261101-090507.txt');
});
