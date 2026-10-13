# Italian e-invoicing (SdI) with PASSO

Billy can send invoices and credit notes **officially** to the Italian *Sistema di Interscambio* (SdI)
through [PASSO](https://github.com/radioBros/passo), a separate open-source relay that builds the
FatturaPA XML, validates it against the official schema and transmits it through a PEC mailbox or the
OpenAPI.it service. The integration is **off by default** and configured entirely in
**Settings → E-invoicing (SdI)**, per account.

> An invoice is legally issued in Italy only once SdI accepts it. Billy and PASSO are tools, not tax
> advice and not a *conservazione a norma* (certified archive) provider. Check your setup with your
> accountant.

## How it fits together

```
billy (web · api · worker)  ──HTTP──▶  PASSO (separate stack)  ──PEC / OpenAPI.it──▶  SdI
          ▲                                      │
          └────── status + receipts (polling, optional webhook) ◀──┘
```

- PASSO runs as **its own Docker Compose project** (own repo, database, queue). It is never part of
  billy's repository or compose file. Billy talks to it over a shared Docker network.
- One PASSO *tenant* per billy account (company): own channel, credentials and progressive numbering.
- Billy stays the **system of record**: the transmitted XML is archived in billy the moment PASSO
  accepts it (PASSO deletes its copy shortly after the final receipt).

## What you need

1. A running PASSO stack (see its README) and the PASSO **admin key** (for one-click setup), or a tenant
   API key + seller id from your PASSO operator (manual mode).
2. A **PEC mailbox** accredited with SdI for the company, or an OpenAPI.it account (the seller must be
   registered there). PEC is the recommended starting point.
3. Complete company data in billy: legal name, VAT number, full Italian address with a 2-letter
   province, and a tax regime.

## Setup (≈10 minutes)

1. **Deploy PASSO** next to billy and put both on one Docker network:
   ```sh
   docker network create billy_passo
   # PASSO checkout: attach its `api` container to billy_passo (host-local override, not committed)
   # billy:
   COMPOSE_FILE=docker-compose.yml:docker-compose.passo.yml docker compose up -d api worker
   ```
   Reach PASSO by its container name (e.g. `http://passo-api:3000`), **not** the service alias `api`.
2. **Billy `.env`** (all optional; see `.env.example`): `PASSO_API_URL` (default address),
   `PASSO_ADMIN_KEY` (enables one-click setup; env only, never shown in the UI),
   `PASSO_WEBHOOK_BASE_URL` (public https URL for instant status; empty = polling only),
   `PASSO_POLL_INTERVAL_SEC`.
3. **Settings → E-invoicing (SdI)** and follow the on-screen guide:
   1. Company data complete (Settings → Company), tax regime chosen, IBAN on your bank account.
   2. **Connect to PASSO** (creates the tenant, API key and seller; or paste a key in manual mode).
      The transmitter identity cannot be changed afterwards, so check the VAT number first.
   3. Choose the **channel**: *PEC* (SMTP/IMAP credentials of the PEC mailbox) or *OpenAPI.it*
      (token; paste the inbound URL shown once into the vendor console).
   4. **Test connection**, then set your defaults and switch the integration **on**.
4. Give each client an **SDI code** (*Codice Destinatario*) or a **PEC** (client form). Foreign
   clients need neither.

## Sending

| Where | What happens |
| :--- | :--- |
| New invoice → *Finalize & send* | After finalizing, a **Send officially via SdI** step runs a readiness check and lets you send now or **later** (invoice page → *Send to SdI*). |
| Scheduled invoice | Tick *Send via SdI when issued*; the worker sends it the moment it is issued on its date. |
| Recurring profile | Switch *Send each generated invoice via SdI*; every occurrence is sent on generation. |
| Credit note | Same panel on the credit note; sent as document type TD04. |

If something is missing (client without SDI code/PEC, 0% line without exemption code, …) the readiness
check says exactly what and where to fix it, and nothing is sent.

**Send within 12 days** of the invoice date (default; adjustable). The dashboard lists everything not
yet sent, with overdue items highlighted.

## Statuses

| Status | Meaning | What to do |
| :--- | :--- | :--- |
| Queued / Transmitted | Being handed to SdI. | Wait; status refreshes automatically. |
| **Delivered** | SdI delivered it to the client. | Nothing. |
| **Awaiting delivery** (MC) | SdI could not deliver *yet*, but the invoice **is issued**. | **Do not resubmit.** |
| **Undelivered, attested** (AT) | Issued; the client finds it in their tax portal. | Tell the client. |
| Accepted / Rejected by PA | Recipient's commercial reply (still issued). | Contact the recipient if rejected. |
| **Rejected** (NS) | SdI refused it: **legally not issued**. The SdI error and remedy are shown. | Void it and issue a corrected invoice with a **new number** (PASSO cannot re-send the same number). |
| **Failed** | PASSO could not reach the channel after its automatic attempts (e.g. empty vendor credit). | Fix the cause and press **Retry**. |
| Blocked | A readiness check or PASSO refused it; nothing was sent. | Read the reason, fix, send again. |

An invoice SdI holds cannot be voided; issue a **credit note** instead. Credit notes are numbered in
their own series, so their number in the XML is prefixed (default `NC`, e.g. `NC 1/2026`); the PDF keeps
billy's number.

## Stamp duty (*imposta di bollo*)

When non-VAT amounts (exempt/excluded lines) exceed €77.47 the €2 virtual stamp duty is flagged
automatically (`DatiBollo`). Threshold and amount are editable; set the mode to *off* to disable.
Paying the quarterly stamp duty to the tax authority is outside billy. Confirm the rules with your
accountant.

## Not supported (yet)

Public-administration invoices (B2G), consumers with neither SDI code nor PEC, withholding tax
(*ritenuta*), pension-fund contributions (*cassa*), the link from a credit note to its original invoice
(`DatiFattureCollegate`), received (passive) invoices.

## Operations notes

- **Polling is the source of truth.** PASSO webhooks are an optional accelerator; they cannot reach a
  private Docker address, so a public https URL is required for them.
- **Backups:** include PASSO's Postgres volume in your host backup. Billy's archived XML lives in the
  `einvoiceSubmissions` collection (covered by billy's own backups).
- **Resources:** PASSO needs roughly 0.5 GB RAM at idle. Do not publish its Postgres/RabbitMQ/Redis
  ports on a public interface.
- **Turning it off:** switch the toggle off per account; in-flight submissions keep syncing. Removing the
  compose override detaches billy from the PASSO network.
