import express from 'express';
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req,res,next)=>{
  const allowed=(process.env.ALLOWED_ORIGINS||'*').split(',').map(s=>s.trim()).filter(Boolean);
  const origin=req.headers.origin;
  if(allowed.includes('*')) res.setHeader('Access-Control-Allow-Origin','*');
  else if(origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());

const EMIS_URL = 'https://apps.emis.gov.bd/portal/emis-portal';

function clean(s='') {
  return String(s).replace(/\s+/g,' ').trim();
}

function validEIIN(v){
  return /^\d{6}$/.test(String(v || '').trim());
}

async function findEIINInput(page){
  const candidates = [
    page.getByLabel(/ইআইআইএন|EIIN/i),
    page.locator('input[placeholder*="EIIN" i]'),
    page.locator('input').filter({has: page.locator('xpath=..//*[contains(translate(normalize-space(.),"eiin","EIIN"),"EIIN")]')})
  ];
  for (const c of candidates){
    try {
      if(await c.count()) return c.first();
    } catch {}
  }
  const inputs = page.locator('input');
  for(let i=0;i<await inputs.count();i++){
    const el = inputs.nth(i);
    const ph = (await el.getAttribute('placeholder')) || '';
    const nm = (await el.getAttribute('name')) || '';
    const id = (await el.getAttribute('id')) || '';
    if(/eiin/i.test(`${ph} ${nm} ${id}`)) return el;
  }
  return null;
}

async function clickSearch(page){
  const buttons = [
    page.getByRole('button', {name:/অনুসন্ধান|search/i}),
    page.getByText(/অনুসন্ধান|search/i, {exact:true}),
    page.locator('button[type="submit"]')
  ];
  for(const b of buttons){
    try{
      if(await b.count()) { await b.first().click({timeout:3000}); return true; }
    }catch{}
  }
  return false;
}

async function chooseTeacher(page){
  const selects = page.locator('select');
  for(let i=0;i<await selects.count();i++){
    const s = selects.nth(i);
    const txt = clean(await s.innerText().catch(()=>''));
    if(/Teacher|শিক্ষক/i.test(txt)){
      const opts = await s.locator('option').evaluateAll(os => os.map(o => ({value:o.value,text:(o.textContent||'').trim()})));
      const hit = opts.find(o => /Teacher|শিক্ষক/i.test(o.text));
      if(hit && hit.value){ await s.selectOption(hit.value).catch(()=>{}); }
    }
  }
}

async function scrapeTables(page){
  const tables = page.locator('table');
  const found = [];
  for(let i=0;i<await tables.count();i++){
    const t=tables.nth(i);
    const headers = await t.locator('thead th').allTextContents().catch(()=>[]);
    const normHeaders = headers.map(clean);
    if(!normHeaders.length) continue;
    const text = normHeaders.join(' | ');
    if(!/নাম|Name/i.test(text)) continue;
    const rows = t.locator('tbody tr');
    for(let r=0;r<await rows.count();r++){
      const row=rows.nth(r);
      const cells=await row.locator('td').allTextContents();
      if(!cells.length) continue;
      const obj={};
      for(let c=0;c<Math.min(normHeaders.length,cells.length);c++) obj[normHeaders[c]||`col${c}`]=clean(cells[c]);
      const img = row.locator('img').first();
      if(await img.count()) obj.photo = await img.getAttribute('src').catch(()=>null);
      found.push(obj);
    }
  }
  return found;
}

function normalizeTeacher(row){
  const entries = Object.entries(row);
  const pick = (...rxs) => {
    const e = entries.find(([k])=>rxs.some(rx=>rx.test(k)));
    return e ? e[1] : '';
  };
  return {
    photo: row.photo || '',
    name: pick(/^নাম$/i,/^Name$/i,/নাম|Name/i),
    designation: pick(/পদবি|Designation/i),
    postType: pick(/পদের ধরন|Post Type/i),
    subject: pick(/বিষয়|Subject/i),
    mobile: pick(/মোবাইল|Mobile/i),
    email: pick(/ই-মেইল|Email/i),
    pdsId: pick(/পিডিএস|PDS/i),
    index: pick(/ইনডেক্স|Index/i)
  };
}

app.get('/api/search/:eiin', async (req,res)=>{
  const eiin = String(req.params.eiin || '').trim();
  if(!validEIIN(eiin)) return res.status(400).json({ok:false,error:'EIIN must be exactly 6 digits.'});

  let browser;
  try{
    browser = await chromium.launch({headless:true, args:['--no-sandbox','--disable-dev-shm-usage']});
    const context = await browser.newContext({locale:'bn-BD'});
    const page = await context.newPage();
    await page.goto(EMIS_URL,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForTimeout(1200);

    const input = await findEIINInput(page);
    if(!input) throw new Error('EIIN input was not found on the current EMIS portal layout.');
    await input.fill(eiin);
    await chooseTeacher(page);
    await clickSearch(page);
    await page.waitForTimeout(2500);
    await page.waitForLoadState('networkidle',{timeout:8000}).catch(()=>{});

    const title = clean(await page.title().catch(()=>''));
    const bodyText = clean(await page.locator('body').innerText().catch(()=>''));
    const raw = await scrapeTables(page);
    const teachers = raw.map(normalizeTeacher).filter(t=>t.name || t.mobile || t.designation);

    let instituteName='';
    const headingCandidates = await page.locator('h1,h2,h3,h4,strong,.card-title,.title').allTextContents().catch(()=>[]);
    instituteName = headingCandidates.map(clean).find(t=>t && !/শিক্ষা প্রতিষ্ঠান অনুসন্ধান|Education Management|EMIS/i.test(t)) || '';

    if(!teachers.length){
      return res.status(404).json({
        ok:false,
        eiin,
        error:'No public teacher rows were detected for this EIIN. The institution may have no public staff rows, or the EMIS page layout may have changed.',
        source:EMIS_URL,
        debug:{title, pageContainsEIIN:bodyText.includes(eiin)}
      });
    }

    res.json({ok:true,eiin,instituteName,totalTeachers:teachers.length,teachers,source:EMIS_URL,sourceType:'Public EMIS portal'});
  }catch(err){
    res.status(502).json({ok:false,eiin,error:err.message,source:EMIS_URL});
  }finally{
    if(browser) await browser.close().catch(()=>{});
  }
});

app.get('/api/health',(req,res)=>res.json({ok:true,service:'EIIN Teacher Search'}));

app.listen(PORT,()=>console.log(`EIIN Teacher Search running on http://localhost:${PORT}`));
