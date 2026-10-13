import { readFileSync } from 'node:fs';
// Dev tool: checks the e-invoice mapper's output against PASSO's own schema, XML generator and the
// official AdE XSD. Needs a PASSO checkout (PASSO_DIR, default ../passo) with `npm install` done.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const dir = resolve(process.env.PASSO_DIR ?? '../passo');
const load = (p) => import(pathToFileURL(resolve(dir, p)).href);
const { InvoiceSchema } = await load('src/domain/invoice/model.ts');
const { generateInvoiceXml } = await load('src/domain/invoice/generator.ts');
const { validateInvoiceXml } = await load('src/infra/render/xsd.ts');
const fx = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let bad = 0;
for (const [name, f] of Object.entries(fx)) {
  if (!f.ok) { console.log(`SKIP  ${name}: blocked by billy preflight -> ${f.issues.join(',')}`); continue; }
  const p = InvoiceSchema.safeParse(f.invoice);
  if (!p.success) { bad++; console.log(`FAIL  ${name}: PASSO schema -> ${JSON.stringify(p.error.issues.slice(0,3))}`); continue; }
  const xml = generateInvoiceXml(p.data, { transmitterCountry: 'IT', transmitterCode: '01234567890', progressivoInvio: '00001' });
  const v = validateInvoiceXml(xml);
  if (!v.valid) { bad++; console.log(`FAIL  ${name}: XSD -> ${v.errors.slice(0,3).join(' | ')}`); continue; }
  console.log(`OK    ${name}${p.data.stampDuty ? ' (+DatiBollo)' : ''}`);
}
process.exit(bad ? 1 : 0);
