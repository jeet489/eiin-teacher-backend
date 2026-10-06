import express from 'express';
import { chromium } from 'playwright';

const app = express();
const PORT = process.env.PORT || 3000;
const EMIS_URL = 'https://apps.emis.gov.bd/portal/emis-portal';

app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

const clean = (s='') => String(s).replace(/\s+/g,' ').trim();
const validEIIN = v => /^\d{6}$/.test(String(v||'').trim());

async function findEIINInput(page){
  await page.waitForTimeout(2500);

  const selectors = [
    'input[placeholder*="EIIN" i]',
    'input[name*="eiin" i]',
    'input[id*="eiin" i]',
    'input[formcontrolname*="eiin" i]',
    'input[aria-label*="EIIN" i]',
    'input[placeholder*="ইআইআইএন"]'
  ];
  for (const sel of selectors){
    const el = page.locator(sel).filter({visible:true}).first();
    if(await el.count().catch(()=>0)) return el;
  }

  for (const rx of [/ইআইআইএন/i, /\bEIIN\b/i]){
    const labels = page.getByText(rx);
    for(let i=0;i<await labels.count().catch(()=>0);i++){
      const t = labels.nth(i);
      if(!(await t.isVisible().catch(()=>false))) continue;
      for(const xp of ['following::input[1]','..//input[1]','ancestor::*[self::div or self::label][1]//input[1]']){
        const c = t.locator(`xpath=${xp}`).first();
        if(await c.count().catch(()=>0) && await c.isVisible().catch(()=>false)) return c;
      }
    }
  }

  const inputs = page.locator('input:visible');
  for(let i=0;i<await inputs.count();i++){
    const el = inputs.nth(i);
    const meta = await el.evaluate(node => {
      const p=node.parentElement, gp=p?.parentElement;
      return [node.placeholder,node.name,node.id,node.getAttribute('aria-label'),node.getAttribute('formcontrolname'),p?.innerText,gp?.innerText].filter(Boolean).join(' ');
    }).catch(()=>'');
    if(/ইআইআইএন|\bEIIN\b/i.test(meta)) return el;
  }

  // EMIS currently renders a general institute search field before the EIIN field.
  for(let i=0;i<await inputs.count();i++){
    const el = inputs.nth(i);
    const type=((await el.getAttribute('type'))||'text').toLowerCase();
    const ph=(await el.getAttribute('placeholder'))||'';
    if(['hidden','checkbox','radio','submit','button'].includes(type)) continue;
    if(/search institute/i.test(ph)) continue;
    return el;
  }
  return null;
}

async function clickSearch(page){
  const cands=[
    page.getByRole('button',{name:/অনুসন্ধান|search/i}),
    page.locator('button[type="submit"]'),
    page.getByText(/অনুসন্ধান|search/i,{exact:true})
  ];
  for(const b of cands){
    if(await b.count().catch(()=>0) && await b.first().isVisible().catch(()=>false)){
      await b.first().click({timeout:4000}).catch(()=>{});
      return;
    }
  }
}

async function chooseTeacher(page){
  const selects=page.locator('select:visible');
  for(let i=0;i<await selects.count();i++){
    const s=selects.nth(i);
    const opts=await s.locator('option').evaluateAll(os=>os.map(o=>({value:o.value,text:(o.textContent||'').trim()}))).catch(()=>[]);
    const hit=opts.find(o=>/Teacher|শিক্ষক/i.test(o.text));
    if(hit?.value) await s.selectOption(hit.value).catch(()=>{});
  }
}

async function scrapeTables(page){
  const out=[];
  const tables=page.locator('table');
  for(let i=0;i<await tables.count();i++){
    const t=tables.nth(i);
    const headers=(await t.locator('thead th').allTextContents().catch(()=>[])).map(clean);
    if(!headers.length || !/নাম|Name/i.test(headers.join(' | '))) continue;
    const rows=t.locator('tbody tr');
    for(let r=0;r<await rows.count();r++){
      const row=rows.nth(r);
      const cells=await row.locator('td').allTextContents().catch(()=>[]);
      if(!cells.length) continue;
      const obj={};
      for(let c=0;c<Math.min(headers.length,cells.length);c++) obj[headers[c]||`col${c}`]=clean(cells[c]);
      const img=row.locator('img').first();
      if(await img.count()){
        let src=await img.getAttribute('src').catch(()=>null);
        if(src){ try{src=new URL(src,page.url()).href}catch{} obj.photo=src; }
      }
      out.push(obj);
    }
  }
  return out;
}

function normalizeTeacher(row){
  const entries=Object.entries(row);
  const pick=(...rxs)=>{ const e=entries.find(([k])=>rxs.some(rx=>rx.test(k))); return e?e[1]:''; };
  return {
    photo:row.photo||'', name:pick(/নাম|Name/i), designation:pick(/পদবি|Designation/i),
    postType:pick(/পদের ধরন|Post Type/i), subject:pick(/বিষয়|Subject/i),
    mobile:pick(/মোবাইল|Mobile/i), email:pick(/ই-মেইল|Email/i),
    pdsId:pick(/পিডিএস|PDS/i), index:pick(/ইনডেক্স|Index/i)
  };
}

app.get('/',(req,res)=>res.json({ok:true,service:'EIIN Teacher Search',usage:'/api/search/108491'}));
app.get('/api/health',(req,res)=>res.json({ok:true,service:'EIIN Teacher Search',version:'1.0.1'}));

app.get('/api/search/:eiin',async(req,res)=>{
  const eiin=String(req.params.eiin||'').trim();
  if(!validEIIN(eiin)) return res.status(400).json({ok:false,error:'EIIN must be exactly 6 digits.'});
  let browser;
  try{
    browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const context=await browser.newContext({locale:'bn-BD',viewport:{width:1440,height:1000}});
    const page=await context.newPage();
    await page.goto(EMIS_URL,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
    await page.waitForTimeout(2000);

    const input=await findEIINInput(page);
    if(!input){
      const visibleInputs=await page.locator('input:visible').evaluateAll(els=>els.map((e,i)=>({i,type:e.type,name:e.name,id:e.id,placeholder:e.placeholder,aria:e.getAttribute('aria-label')}))).catch(()=>[]);
      return res.status(502).json({ok:false,eiin,error:'EIIN input was not found on the current EMIS portal layout.',source:EMIS_URL,debug:{url:page.url(),title:await page.title().catch(()=>''),visibleInputs}});
    }

    await input.fill(eiin);
    await chooseTeacher(page);
    await clickSearch(page);
    await page.waitForTimeout(3500);
    await page.waitForLoadState('networkidle',{timeout:10000}).catch(()=>{});

    const raw=await scrapeTables(page);
    const teachers=raw.map(normalizeTeacher).filter(t=>t.name||t.mobile||t.designation);
    const bodyText=clean(await page.locator('body').innerText().catch(()=>''));

    if(!teachers.length){
      return res.status(404).json({ok:false,eiin,error:'EIIN field was found, but no public teacher rows were detected. EMIS result selectors may need another update.',source:EMIS_URL,debug:{pageContainsEIIN:bodyText.includes(eiin),url:page.url(),title:await page.title().catch(()=> '')}});
    }

    res.json({ok:true,eiin,totalTeachers:teachers.length,teachers,source:EMIS_URL,sourceType:'Public EMIS portal'});
  }catch(err){
    res.status(502).json({ok:false,eiin,error:err.message,source:EMIS_URL});
  }finally{
    if(browser) await browser.close().catch(()=>{});
  }
});

app.listen(PORT,()=>console.log(`EIIN Teacher Search running on port ${PORT}`));
