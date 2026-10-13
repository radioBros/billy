# E-invoice conformance check (dev tool)

Proves the billy → PASSO mapper produces invoices PASSO accepts **and** that the generated FatturaPA XML
validates against the official Agenzia delle Entrate XSD:

```sh
npx tsx scripts/einvoice/conformance-fixtures.ts /tmp/einvoice-fixtures.json
cd ../passo && node --experimental-strip-types ../billy/scripts/einvoice/conformance-validate.mjs /tmp/einvoice-fixtures.json
```

`PASSO_DIR` (default `../passo`) points at a PASSO checkout with dependencies installed. Run it
whenever the mapper or PASSO's model changes.
