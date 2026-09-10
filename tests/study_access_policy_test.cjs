const {test}=require('node:test'),assert=require('node:assert/strict');
const {normalizeAccessPolicy,accessPolicyMatches}=require(process.env.PACS_POLICY_MODULE||'/app/dist/study-access-policy');
const base=()=>({version:1,restricted:true,startsAt:null,endsAt:null,rules:[]});
const rule=()=>({patientId:null,modalities:[],dateFrom:null,dateTo:null,studyUids:[]});
test('AND within each rule, OR between rules, missing metadata never grants a conditional rule',()=>{
 const p=normalizeAccessPolicy({...base(),rules:[{...rule(),patientId:'Patient-A',modalities:['CT'],dateFrom:'2026-09-01',dateTo:'2026-09-10'}, {...rule(),studyUids:['1.3']}]});
 const metadata={patientId:'Patient-A',modalities:['MR','CT'],studyDate:'20260910'};
 assert.equal(accessPolicyMatches(p,'1.2',metadata),true);
 for(const change of [{patientId:'patient-a'},{modalities:['OCT']},{studyDate:'20260911'},{studyDate:'20260230'}])assert.equal(accessPolicyMatches(p,'1.2',{...metadata,...change}),false);
 assert.equal(accessPolicyMatches(p,'1.2'),false);assert.equal(accessPolicyMatches(p,'1.3'),true);
});
test('expiration denies rather than falling back to unrestricted, start inclusive end exclusive',()=>{
 const p=normalizeAccessPolicy({...base(),startsAt:'2026-09-10T01:00:00.000Z',endsAt:'2026-09-10T02:00:00.000Z',rules:[{all:true}]});
 for(const [time,expected] of [['2026-09-10T00:59:59.999Z',false],['2026-09-10T01:00:00.000Z',true],['2026-09-10T01:59:59.999Z',true],['2026-09-10T02:00:00.000Z',false]])assert.equal(accessPolicyMatches(p,'1.2',undefined,Date.parse(time)),expected);
 assert.equal(accessPolicyMatches(normalizeAccessPolicy(base()),'1.2'),false);
 assert.equal(accessPolicyMatches(normalizeAccessPolicy({...base(),restricted:false}),'1.2'),true);
});
test('ambiguous, malformed, over-budget and hidden conditions are rejected',()=>{
 const cases=[{...base(),extra:true},{...base(),restricted:1},{...base(),rules:[{}]},
 {...base(),rules:[{...rule()}]},{...base(),rules:[{all:true,...rule()}]},
 {...base(),rules:[{all:true},{...rule(),studyUids:['1.2']}]},
 {...base(),rules:[{...rule(),modalities:['CT','CT']}]},
 {...base(),rules:[{...rule(),patientId:'  '}]},
 {...base(),rules:[{...rule(),studyUids:['1.2?all=1']}]},
 {...base(),rules:[{...rule(),dateFrom:'2026-02-30'}]},
 {...base(),startsAt:'2026-09-10T01:00:00+09:00'},
 {...base(),restricted:false,rules:[{all:true}]},
 {...base(),rules:[{...rule(),studyUids:Array.from({length:1001},(_,i)=>'1.'+i)}]}];
 for(const p of cases)assert.throws(()=>normalizeAccessPolicy(p));
});
