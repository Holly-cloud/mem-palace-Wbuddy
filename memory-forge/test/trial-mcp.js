#!/usr/bin/env node
'use strict';
/**
 * 浅尝模式真实流程验证（模拟 hermes 通过 MCP 调用）。
 *
 * 走完整链路：trial_start → 逐块抽取 → import → 出预览报告。
 * 全程用真实记忆库，验证「只读」承诺与报告可用性。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.resolve(__dirname, '..', 'bin', 'forge-mcp.js');
const PALACE = path.resolve(__dirname, '..', '..', 'memory-palace');

let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, d) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, failures.push({n,d}), console.log(`  FAIL  ${n}${d?' — '+d:''}`)); };
const section = (t) => console.log(`\n=== ${t} ===`);

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trial-'));

class C {
  constructor() {
    this.p = spawn(process.execPath, [SERVER], {
      stdio: ['pipe','pipe','pipe'], env: {...process.env, FORGE_WORKSPACE: WS},
    });
    this.buf=''; this.id=1; this.pend=new Map();
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (d)=>{ this.buf+=d; let i;
      while((i=this.buf.indexOf('\n'))>=0){ const l=this.buf.slice(0,i).trim(); this.buf=this.buf.slice(i+1); if(!l)continue;
        const m=JSON.parse(l); const cb=this.pend.get(m.id); if(cb){this.pend.delete(m.id);cb(m.result);} } });
  }
  req(method, params) {
    return new Promise((res)=>{ const id=this.id++; this.pend.set(id,res);
      this.p.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n'); });
  }
  async call(n,a) { const r=await this.req('tools/call',{name:n,arguments:a||{}});
    if(r.error) return {ok:false,error:r.error.message};
    return JSON.parse(r.content[0].text); }
  close(){ try{this.p.kill();}catch(_){} }
}

(async () => {
  const c = new C();
  await c.req('initialize', {protocolVersion:'2024-11-05',capabilities:{}});

  section('1. 探测阶段');
  const list = await c.req('tools/list', {});
  ok('工具已注册 trial_start', list.tools.some((t)=>t.name==='forge_trial_start'));
  ok('工具总数 13', list.tools.length === 13, `got ${list.tools.length}`);
  const td = list.tools.find((t)=>t.name==='forge_trial_start');
  ok('描述说明只读', /只读/.test(td.description));
  ok('描述提到 slot 策略', /slot/.test(td.description));
  ok('参数含 palaceRoot', td.inputSchema.properties.palaceRoot);
  ok('参数含 strategy 枚举', Array.isArray(td.inputSchema.properties.strategy.enum));

  section('2. 错误处理');
  const noRoot = await c.call('forge_trial_start', {});
  ok('缺 palaceRoot 被拒', noRoot.ok===false && /palaceRoot/.test(noRoot.error));
  const badPath = await c.call('forge_trial_start', { palaceRoot: '/nonexistent/path' });
  ok('不存在的路径被拒', badPath.ok===false);
  ok('错误带可读标题', !!badPath.error);
  const badRatio = await c.call('forge_trial_start', { palaceRoot: PALACE, ratio: 5 });
  ok('非法比例被拒', badRatio.ok===false && /BAD_RATIO/.test((badRatio.code||'')));

  section('3. 抽样与切分');
  const trial = await c.call('forge_trial_start', {
    palaceRoot: PALACE, count: 4, strategy: 'slot', seed: 42, taskId: 'TRIAL1',
  });
  ok('试运行启动成功', trial.ok===true, trial.error);
  ok('标记为只读', trial.readonly===true);
  ok('返回抽样参数', !!trial.sampling);
  ok('抽样数为 4', trial.sampling.sampled === 4, `${trial.sampling.sampled}`);
  ok('记录候选池大小', trial.sampling.poolSize > 0, `${trial.sampling.poolSize}`);
  ok('固定 seed 已记录', trial.sampling.seed === 42);
  ok('生成了分块', trial.chunkCount >= 1);
  ok('返回样本预览', trial.samplePreview && trial.samplePreview.length > 0);
  console.log(`     抽样策略: ${trial.sampling.strategyLabel}  覆盖 ${trial.sampling.sampled}/${trial.sampling.poolSize} 条 (${Math.round(trial.sampling.coverageRatio*100)}%)`);

  // 可复现性
  const trial2 = await c.call('forge_trial_start', {
    palaceRoot: PALACE, count: 4, strategy: 'slot', seed: 42, taskId: 'TRIAL2',
  });
  ok('同 seed 抽出同样数量', trial2.sampling.sampled === trial.sampling.sampled);
  const trial3 = await c.call('forge_trial_start', {
    palaceRoot: PALACE, count: 4, strategy: 'slot', seed: 999, taskId: 'TRIAL3',
  });
  ok('不同 seed 可用', trial3.ok===true);

  section('4. 逐块抽取');
  const chunks = await c.call('forge_task_read_chunk', { taskId: 'TRIAL1' });
  ok('返回分块清单', chunks.total >= 1);
  ok('返回进度', chunks.progress.total === chunks.total);

  const ch0 = await c.call('forge_task_read_chunk', { taskId: 'TRIAL1', index: 0 });
  ok('读到分块内容', ch0.ok===true && ch0.content.length > 0);
  ok('内容含记忆卡原文', /主张:|类型:|subject|偏好/.test(ch0.content),
     ch0.content.slice(0,80));

  // 假装 agent 抽取：产出两张卡
  const w = await c.call('forge_task_write_result', { taskId:'TRIAL1', index:0, cards:[
    {type:'preference',title:'偏好精简',subject:'user',predicate:'verbosity',
     value:'默认精简',body:'',confidence:0.9,aliases:['啰嗦']},
    {type:'decision',title:'采用 slot 作冲突键',subject:'project:memory-palace',
     predicate:'conflict_key',value:'slot = subject + predicate',body:'',confidence:0.95,aliases:['冲突键']},
  ]});
  ok('结果写入成功', w.ok===true);
  ok('接受 2 张卡', w.accepted===2, `${w.accepted}`);

  for (let i=1;i<chunks.total;i++) {
    await c.call('forge_task_write_result',{taskId:'TRIAL1',index:i,cards:[]});
  }

  section('5. 试运行报告');
  const imp = await c.call('forge_import_results', { taskId: 'TRIAL1', palaceRoot: PALACE });
  ok('导入成功', imp.ok===true);
  ok('标记为浅尝模式', imp.mode==='trial', imp.mode);
  ok('标记为只读', imp.readonly===true);
  ok('产出预览报告', !!imp.trialReport);
  if (imp.trialReport) {
    const r = imp.trialReport;
    console.log('');
    console.log('     ' + r.summary);
    console.log('');
    ok('报告含抽样参数', !!r.sampling);
    ok('报告含组织结构', !!r.organization);
    ok('报告含抽取统计', r.extraction.extracted === 2, `${r.extraction.extracted}`);
    ok('摘要含抽样规模', /抽样/.test(r.summary));
    ok('摘要含产出数量', /卡片/.test(r.summary));
  }
  ok('提示不会写入', !imp.written);
  ok('给出只读提示', /只预览|不写盘|不会写入/.test(imp.notice||''), imp.notice);

  section('6. 只读保证（关键）');
  const snapshot = {};
  const walk = (d, base='') => {
    fs.readdirSync(d,{withFileTypes:true}).forEach((e)=>{
      const p = path.join(d,e.name);
      if (e.isDirectory()) { if (!['.palace','.git'].includes(e.name)) walk(p, base+e.name+'/'); }
      else snapshot[base+e.name] = fs.readFileSync(p,'utf8');
    });
  };
  walk(PALACE);

  // 传 write=true 也必须不写
  const forced = await c.call('forge_import_results', {
    taskId: 'TRIAL1', palaceRoot: PALACE, write: true,
  });
  ok('传 write=true 也不写盘', forced.written === false);
  ok('明确告知为何不写', /浅尝/.test(forced.notice||''), forced.notice);

  let unchanged = true;
  const walk2 = (d, base='') => {
    fs.readdirSync(d,{withFileTypes:true}).forEach((e)=>{
      const p = path.join(d,e.name);
      if (e.isDirectory()) { if (!['.palace','.git'].includes(e.name)) walk2(p, base+e.name+'/'); }
      else if (snapshot[base+e.name] !== fs.readFileSync(p,'utf8')) unchanged=false;
    });
  };
  walk2(PALACE);
  ok('记忆库文件内容未变', unchanged);
  ok('记忆库无新增文件', Object.keys(snapshot).length === countFiles(PALACE),
     `${Object.keys(snapshot).length} → ${countFiles(PALACE)}`);

  c.close();
  fs.rmSync(WS,{recursive:true,force:true});

  console.log('\n' + '='.repeat(50));
  console.log(`  通过 ${pass} / 失败 ${fail}`);
  console.log('='.repeat(50));
  if (fail) { console.log('\n失败:'); failures.forEach((f)=>console.log('  - '+f.n+(f.d?' — '+f.d:''))); }
  process.exit(fail?1:0);
})().catch((e)=>{ console.error('异常:',e.message); console.error(e.stack); process.exit(1); });

function countFiles(dir, base='') {
  let n = 0;
  fs.readdirSync(dir,{withFileTypes:true}).forEach((e)=>{
    if (['.palace','.git'].includes(e.name)) return;
    const p = path.join(dir,e.name);
    if (e.isDirectory()) n += countFiles(p); else n++;
  });
  return n;
}
