# “BILLY” a Developer Business Manager

## Production-Ready Master Project Specification

## 1\. Project purpose

Build a focused, self-hosted business management application for freelance software developers and small software agencies.

The system must include only:

1. Clients

2. Quotes

3. Invoices

4. Recurring billing

5. Time tracking

6. Expenses

7. Contracts

8. Domains and VPS subscriptions

9. Notifications

10. Settings

11. Dashboard

12. PWA functionality

Do not add:

* sales pipelines

* leads

* marketing campaigns

* inventory

* accounting ledgers

* payroll

* HR

* ticketing

* project management

* task management

* warehouse management

* product catalogs beyond invoice line items

* email newsletters

* customer support

* team chat

* social integrations

The product must remain deliberately small, fast, and easy to operate.

---

# 2\. Product principles

## 2.1 Core principles

The application must be:

* self-hosted

* fully Dockerized

* responsive

* installable as a PWA

* usable on desktop, tablet, and mobile

* optimized for fast data entry

* API-first

* privacy-focused

* simple to back up

* easy to maintain

* suitable for one user or a small internal team

* usable without external SaaS dependencies

## 2.2 UX principles

The interface should feel closer to Linear, Notion, or Stripe Dashboard than to a traditional ERP.

Use:

* one left navigation sidebar

* one compact top toolbar

* clear page titles

* inline editing where appropriate

* modal or drawer forms for quick operations

* desktop tables

* mobile card layouts

* keyboard shortcuts

* command palette

* fast global search

* dark and light modes

* consistent status chips

* minimal nesting

* no more than two navigation levels

The application should prioritize clarity over visual decoration.

---

# 3\. Technology stack

## 3.1 Frontend

Use:

* Vue 3

* TypeScript

* Vite

* Vuetify

* Vue Router

* Pinia

* pinia-plugin-persistedstate

* Axios

* vue-tippy

* vue3-toastify

* ECharts only for dashboard charts

* Day.js

* Zod

* VueUse

* Workbox or Vite PWA plugin

* Web Push API

* WebSockets

Recommended additional packages:

* @vueuse/core

* vite-plugin-pwa

* zod

* dayjs

* currency.js

* sortablejs

* file-saver

* papaparse

* uuid

* dompurify

## 3.2 Backend

Use:

* Node.js

* TypeScript

* Koa 2

* Koa Router

* MongoDB

* Mongoose

* Redis

* BullMQ

* MinIO

* WebSockets

* REST API

* OpenAPI

* Zod validation

* Nodemailer-compatible SMTP transport

* Playwright or Chromium-based PDF generation

Recommended backend packages:

* koa

* @koa/router

* koa-bodyparser

* koa-helmet

* koa-ratelimit

* koa-compress

* jsonwebtoken

* argon2

* mongoose

* ioredis

* bullmq

* socket.io

* zod

* nodemailer

* minio

* playwright

* web-push

* pino

* pino-pretty

* prom-client

* dayjs

* currency.js

* uuid

## 3.3 Infrastructure

Use Docker for every service.

Required containers:

* frontend

* backend API

* BullMQ worker

* BullMQ scheduler or recurring-job worker

* MongoDB

* Redis

* MinIO

* reverse proxy

* optional Mailpit for development

Recommended reverse proxy:

* Traefik

* or Caddy

* or Nginx

Use one public entry point through the reverse proxy.

---

# 4\. Repository structure

/  
├── apps/  
│   ├── web/  
│   ├── api/  
│   └── worker/  
├── packages/  
│   ├── shared/  
│   ├── types/  
│   ├── validation/  
│   ├── api-client/  
│   └── config/  
├── infrastructure/  
│   ├── docker/  
│   ├── reverse-proxy/  
│   ├── mongodb/  
│   ├── redis/  
│   ├── minio/  
│   └── backup/  
├── scripts/  
│   ├── development/  
│   ├── deployment/  
│   ├── backup/  
│   └── migration/  
├── docs/  
│   ├── architecture/  
│   ├── api/  
│   ├── deployment/  
│   ├── security/  
│   └── user-guide/  
├── docker-compose.yml  
├── docker-compose.dev.yml  
├── docker-compose.prod.yml  
├── .env.example  
├── MASTER\_PROJECT\_SPEC.md  
└── README.md

---

# 5\. Application navigation

Main navigation:

Dashboard  
Clients  
Quotes  
Invoices  
Recurring Billing  
Time Tracking  
Expenses  
Contracts  
Subscriptions  
Notifications  
Settings

The term “Subscriptions” refers only to tracked business costs such as domains, VPS servers, software licenses, hosting plans, and infrastructure renewals.

It does not refer to subscriptions sold to customers. Those belong under recurring billing.

---

# 6\. User roles

Keep roles intentionally simple.

## 6.1 Administrator

Can:

* access all modules

* manage users

* manage settings

* configure SMTP

* configure push notifications

* configure business details

* create, edit, delete, and export all records

* view audit logs

* restore archived records

## 6.2 Member

Can:

* access operational modules

* create and edit clients

* create quotes and invoices

* track time

* add expenses

* manage contracts and subscriptions

* view notifications

Optional per-user restrictions:

* cannot manage settings

* cannot manage users

* cannot permanently delete

* cannot access financial totals

* cannot export data

Do not create a complex permissions engine in version 1\.

---

# 7\. Authentication

Required:

* email and password

* secure server-side session or short-lived access token plus refresh token

* Argon2 password hashing

* optional two-factor authentication

* password reset

* email verification for new internal users

* session list

* revoke session

* automatic session expiration

* login rate limiting

* brute-force protection

There is no public registration.

Only administrators can create users.

---

# 8\. Dashboard

The dashboard must provide an immediate overview without becoming a general analytics product.

## 8.1 KPI cards

Display:

* revenue invoiced this month

* revenue collected this month

* outstanding invoice total

* overdue invoice total

* invoices due within 7 days

* recurring invoices scheduled within 7 days

* unbilled tracked time

* expenses this month

* subscriptions due within 30 days

* contracts expiring within 30 days

## 8.2 Charts

Include only:

* invoiced versus paid revenue by month

* expenses by month

* income versus expenses by month

Allow date ranges:

* current month

* last 3 months

* last 6 months

* current year

* previous year

* custom

## 8.3 Action lists

Display:

* overdue invoices

* quotes awaiting response

* recurring invoices to be generated

* subscriptions due soon

* contracts expiring soon

* unbilled time entries

## 8.4 Quick actions

Include:

* add client

* create quote

* create invoice

* start timer

* add expense

* add subscription

* add contract

---

# 9\. Clients module

## 9.1 Client types

Support:

* company

* individual

## 9.2 Client fields

id  
type  
displayName  
legalName  
firstName  
lastName  
email  
phone  
website  
vatNumber  
taxCode  
recipientCode  
pecEmail  
billingAddress  
shippingAddress  
country  
preferredCurrency  
preferredLanguage  
paymentTermsDays  
defaultTaxRate  
notes  
tags  
status  
createdAt  
updatedAt  
archivedAt

## 9.3 Address structure

street  
streetNumber  
addressLine2  
city  
provinceOrState  
postalCode  
countryCode

## 9.4 Client detail page

Tabs:

* overview

* quotes

* invoices

* recurring billing

* time entries

* expenses

* contracts

* files

* activity

## 9.5 Client overview

Display:

* contact information

* billing details

* unpaid total

* overdue total

* total invoiced

* total paid

* active recurring billing profiles

* active contracts

* recent activity

* internal notes

## 9.6 Client actions

* edit client

* archive client

* restore client

* create quote

* create invoice

* create recurring billing profile

* create contract

* add time entry

* upload attachment

* export client data

---

# 10\. Quotes module

## 10.1 Quote fields

id  
quoteNumber  
clientId  
issueDate  
expiryDate  
currency  
status  
lineItems  
subtotal  
discountTotal  
taxTotal  
grandTotal  
notes  
terms  
internalNotes  
templateId  
sentAt  
viewedAt  
acceptedAt  
declinedAt  
convertedInvoiceId  
createdBy  
createdAt  
updatedAt  
archivedAt

## 10.2 Quote statuses

* draft

* sent

* viewed

* accepted

* declined

* expired

* converted

* archived

## 10.3 Quote line item

id  
description  
quantity  
unit  
unitPrice  
discountType  
discountValue  
taxRate  
lineSubtotal  
lineTax  
lineTotal  
sortOrder

## 10.4 Quote actions

* save draft

* duplicate

* generate PDF

* preview

* send by email

* mark as sent

* mark as accepted

* mark as declined

* convert to invoice

* archive

* restore

## 10.5 Quote numbering

Configurable pattern:

Q-{YEAR}-{SEQUENCE}

Example:

Q-2026-00042

The sequence must be generated atomically.

## 10.6 Quote conversion

When converting a quote to an invoice:

* copy client snapshot

* copy line items

* copy tax values

* copy notes and terms

* preserve original quote

* set quote status to converted

* store converted invoice ID

* do not keep a live dependency on later quote changes

---

# 11\. Invoices module

## 11.1 Invoice fields

id  
invoiceNumber  
clientId  
clientSnapshot  
issueDate  
dueDate  
currency  
status  
lineItems  
subtotal  
discountTotal  
taxTotal  
grandTotal  
amountPaid  
amountDue  
notes  
terms  
internalNotes  
templateId  
sourceType  
sourceId  
sentAt  
viewedAt  
paidAt  
voidedAt  
createdBy  
createdAt  
updatedAt  
archivedAt

## 11.2 Invoice statuses

* draft

* scheduled

* sent

* viewed

* partially\_paid

* paid

* overdue

* void

* archived

## 11.3 Source types

* manual

* quote

* recurring\_profile

* time\_entries

## 11.4 Invoice actions

* save draft

* schedule send

* send immediately

* generate PDF

* preview

* duplicate

* record payment

* edit payment

* remove payment

* mark as paid

* mark as sent

* void

* archive

* restore

* download PDF

* email PDF

## 11.5 Invoice numbering

Configurable pattern:

INV-{YEAR}-{SEQUENCE}

Optional annual reset.

Example:

INV-2026-00124

The number must only be permanently assigned when the invoice is finalized or sent, depending on configured accounting rules.

## 11.6 Payment record

id  
invoiceId  
amount  
currency  
paymentDate  
method  
reference  
notes  
createdBy  
createdAt  
updatedAt

Payment methods:

* bank transfer

* card

* cash

* PayPal

* Stripe

* direct debit

* other

## 11.7 Partial payments

Support:

* multiple payments per invoice

* partial payment status

* remaining amount calculation

* overpayment validation

* payment deletion with audit record

## 11.8 Overdue calculation

A scheduled worker must:

* find invoices where due date has passed

* exclude paid, void, and archived invoices

* mark them overdue

* generate configured notifications

* optionally send client reminder emails

---

# 12\. Recurring billing module

Recurring billing generates invoices for clients automatically.

## 12.1 Recurring profile fields

id  
name  
clientId  
status  
currency  
lineItems  
subtotal  
taxTotal  
grandTotal  
frequency  
interval  
startDate  
endDate  
nextRunAt  
lastRunAt  
invoiceIssueDateRule  
invoiceDueDateRule  
autoFinalize  
autoSend  
emailTemplateId  
paymentTermsDays  
notes  
terms  
maxOccurrences  
occurrencesGenerated  
createdInvoiceIds  
createdBy  
createdAt  
updatedAt  
archivedAt

## 12.2 Statuses

* draft

* active

* paused

* completed

* cancelled

* archived

## 12.3 Frequencies

Support:

* daily

* weekly

* monthly

* quarterly

* every 6 months

* yearly

* custom interval

Custom interval structure:

intervalCount  
intervalUnit

Allowed units:

* days

* weeks

* months

* years

Examples:

* every 2 weeks

* every 3 months

* every 2 years

## 12.4 Scheduling rules

Allow:

* same day as recurrence

* fixed day of month

* last day of month

* first business day

* custom offset from recurrence date

## 12.5 Generated invoice behavior

Each generated invoice must:

* use a new invoice ID

* use a new invoice number

* contain a full client snapshot

* contain copied line items

* reference the recurring profile

* be immutable relative to future recurring-profile edits

## 12.6 Automatic actions

Options per profile:

* create draft only

* finalize automatically

* send automatically

* notify internal users after generation

* notify internal users after sending

* send payment reminder before due date

* send payment reminder on due date

* send overdue reminder

## 12.7 Duplicate prevention

Every execution must use an idempotency key:

recurringProfileId \+ scheduledOccurrenceDate

The same scheduled occurrence must never generate more than one invoice.

## 12.8 Failure handling

When generation or sending fails:

* do not silently skip the occurrence

* create failure log

* retry using BullMQ

* notify selected users

* allow manual retry

* preserve original scheduled occurrence

---

# 13\. Time tracking module

## 13.1 Time entry fields

id  
userId  
clientId  
description  
date  
startedAt  
stoppedAt  
durationSeconds  
hourlyRate  
currency  
billable  
billed  
invoiceId  
notes  
createdAt  
updatedAt  
archivedAt

## 13.2 Timer behavior

Allow:

* start timer

* pause timer

* stop timer

* manual entry

* edit duration

* assign client

* mark billable or non-billable

* set hourly rate

* add description

* discard running timer

Only one running timer per user is allowed.

The active timer must survive:

* page refresh

* browser restart

* PWA restart

* device reconnection

The backend is the source of truth.

## 13.3 Time views

Provide:

* today

* this week

* this month

* custom range

* grouped by client

* grouped by user

* billed

* unbilled

* billable

* non-billable

## 13.4 Invoice generation from time

The user can select unbilled entries and generate one invoice.

Options:

* one line per time entry

* group by day

* group by description

* single summarized line

* custom description

* use individual hourly rates

* use one override rate

After invoice creation:

* mark selected entries as billed

* store invoice ID on each entry

* prevent billing twice

* allow reversal only if invoice is still draft

---

# 14\. Expenses module

## 14.1 Expense fields

id  
clientId  
vendorName  
category  
description  
expenseDate  
currency  
netAmount  
taxAmount  
grossAmount  
paymentMethod  
billable  
reimbursable  
reimbursed  
invoiceId  
receiptFileId  
notes  
createdBy  
createdAt  
updatedAt  
archivedAt

## 14.2 Expense categories

Default categories:

* hosting

* domains

* VPS

* software

* hardware

* cloud infrastructure

* APIs

* travel

* office

* professional services

* taxes

* subscriptions

* other

Categories must be configurable.

## 14.3 Expense actions

* create

* edit

* duplicate

* archive

* restore

* upload receipt

* attach to client

* mark billable

* add to invoice

* mark reimbursed

* export

## 14.4 Billable expenses

Selected billable expenses may be added to a draft invoice.

After invoice finalization:

* mark expense reimbursable as invoiced

* store invoice ID

* prevent duplicate invoicing

---

# 15\. Contracts module

## 15.1 Contract fields

id  
title  
clientId  
contractNumber  
status  
type  
startDate  
endDate  
autoRenew  
renewalPeriod  
noticePeriodDays  
value  
currency  
billingFrequency  
relatedRecurringProfileId  
signedDate  
fileId  
notes  
createdBy  
createdAt  
updatedAt  
archivedAt

## 15.2 Contract types

* development

* maintenance

* hosting

* support

* consulting

* service agreement

* retainer

* other

## 15.3 Contract statuses

* draft

* active

* expiring

* expired

* terminated

* renewed

* archived

## 15.4 Contract actions

* create

* edit

* attach signed PDF

* link recurring billing profile

* renew

* terminate

* duplicate

* archive

* restore

## 15.5 Expiration calculations

The system must automatically calculate:

* days until expiry

* notice deadline

* renewal date

* overdue renewal action

## 15.6 Contract notifications

Possible notifications:

* contract begins tomorrow

* contract begins today

* contract expires in 90 days

* contract expires in 60 days

* contract expires in 30 days

* contract expires in 14 days

* contract expires in 7 days

* contract expires tomorrow

* contract expires today

* contract has expired

* cancellation notice deadline approaching

* automatic renewal approaching

* contract renewed

* contract terminated

Each notification must be individually configurable.

---

# 16\. Domains and VPS subscriptions module

This module tracks costs that the business must pay.

## 16.1 Subscription types

* domain

* VPS

* dedicated server

* shared hosting

* cloud service

* software license

* API service

* SSL certificate

* email hosting

* storage

* monitoring service

* other

## 16.2 Subscription fields

id  
name  
type  
provider  
clientId  
relatedDomain  
relatedServer  
description  
status  
currency  
amount  
billingFrequency  
intervalCount  
intervalUnit  
startDate  
nextPaymentDate  
renewalDate  
expiryDate  
autoRenew  
paymentMethod  
accountReference  
managementUrl  
reminderRules  
notes  
createdBy  
createdAt  
updatedAt  
archivedAt

## 16.3 Domain-specific fields

domainName  
registrar  
registrationDate  
expiryDate  
autoRenew  
nameservers  
dnsProvider  
clientOwned  
managedForClient

## 16.4 VPS-specific fields

hostname  
provider  
ipAddresses  
location  
operatingSystem  
cpu  
ram  
storage  
managementUrl  
backupEnabled  
clientOwned  
managedForClient

Do not store root passwords, SSH private keys, API keys, or sensitive infrastructure credentials in version 1\.

## 16.5 Subscription statuses

* active

* payment\_due

* overdue

* cancelled

* expired

* suspended

* archived

## 16.6 Payment tracking

A subscription payment occurrence should be representable as:

id  
subscriptionId  
scheduledDate  
amount  
currency  
status  
paidAt  
paymentMethod  
notes  
createdAt  
updatedAt

Statuses:

* upcoming

* due\_today

* paid

* overdue

* skipped

* cancelled

## 16.7 Subscription notifications

Include:

* payment due in 30 days

* payment due in 14 days

* payment due in 7 days

* payment due in 3 days

* payment due tomorrow

* payment due today

* payment overdue by 1 day

* payment overdue by 3 days

* payment overdue by 7 days

* payment overdue by 14 days

* subscription renewal approaching

* domain expires in 90 days

* domain expires in 60 days

* domain expires in 30 days

* domain expires in 14 days

* domain expires in 7 days

* domain expires tomorrow

* domain expires today

* domain expired

* VPS renewal due

* SSL certificate expiry approaching

* subscription marked paid

* subscription payment changed

* subscription cancelled

* automatic renewal disabled

---

# 17\. Notification system

The notification system is a core application subsystem.

## 17.1 Notification channels

Support:

* in-app

* browser push

* installed PWA push

* email

The installed PWA on supported mobile platforms uses Web Push.

Native iOS and Android applications are outside the scope of version 1\.

## 17.2 Notification preferences

Each user must have independent notification settings.

Preferences are configured per event and per channel.

Example:

| Event | In-app | Push | Email |
| :---- | ----: | ----: | ----: |
| Invoice overdue | Yes | Yes | Yes |
| Recurring invoice generated | Yes | No | No |
| Subscription due tomorrow | Yes | Yes | Yes |
| Contract expires in 30 days | Yes | No | Yes |

## 17.3 Notification event structure

id  
eventType  
category  
title  
body  
severity  
entityType  
entityId  
userId  
channels  
status  
readAt  
sentAt  
failedAt  
metadata  
createdAt

## 17.4 Notification severities

* info

* success

* warning

* critical

## 17.5 Notification categories

* invoices

* quotes

* recurring\_billing

* time\_tracking

* expenses

* contracts

* subscriptions

* system

## 17.6 Invoice notification events

Include:

* invoice created

* invoice finalized

* invoice scheduled

* invoice sent

* invoice sending failed

* invoice viewed

* invoice due in 14 days

* invoice due in 7 days

* invoice due in 3 days

* invoice due tomorrow

* invoice due today

* invoice overdue

* invoice overdue by 3 days

* invoice overdue by 7 days

* invoice overdue by 14 days

* invoice partially paid

* invoice paid

* invoice payment added

* invoice payment edited

* invoice payment removed

* invoice voided

## 17.7 Quote notification events

Include:

* quote created

* quote sent

* quote sending failed

* quote viewed

* quote accepted

* quote declined

* quote expires in 7 days

* quote expires in 3 days

* quote expires tomorrow

* quote expires today

* quote expired

* quote converted to invoice

## 17.8 Recurring billing notification events

Include:

* recurring profile activated

* recurring profile paused

* recurring profile resumed

* recurring profile cancelled

* recurring invoice scheduled for tomorrow

* recurring invoice scheduled for today

* recurring invoice generated

* recurring invoice finalized

* recurring invoice sent

* recurring invoice sending failed

* recurring invoice generation failed

* recurring profile completed

* recurring profile reaches final occurrence

* recurring profile expires soon

## 17.9 Time tracking notification events

Include:

* timer running for 4 hours

* timer running for 8 hours

* timer still running at end of day

* timer stopped

* unbilled time exceeds configurable threshold

* unbilled time older than 7 days

* unbilled time older than 30 days

* time entries converted to invoice

## 17.10 Expense notification events

Include:

* expense created

* high-value expense added

* billable expense not yet invoiced

* reimbursable expense overdue

* expense added to invoice

* receipt missing

* expense payment due, where applicable

## 17.11 Contract notification events

Include every event listed in the contracts section.

## 17.12 Subscription notification events

Include every event listed in the subscriptions section.

## 17.13 System notification events

Include:

* backup succeeded

* backup failed

* SMTP failure

* push delivery failure

* worker queue failure

* storage unavailable

* scheduled job failure

* application update available

* login from new device

* password changed

* two-factor authentication changed

## 17.14 Notification delivery flow

Domain event occurs  
→ event written to event store  
→ notification preferences resolved  
→ notification jobs created  
→ BullMQ processes each channel  
→ delivery result stored  
→ frontend updated through WebSocket

## 17.15 Notification deduplication

Use a deduplication key:

userId \+ eventType \+ entityId \+ scheduledOccurrence

The same event must not generate duplicate notifications.

## 17.16 Notification center

Provide:

* unread count

* all notifications

* unread only

* filters by category

* filters by severity

* mark one as read

* mark all as read

* delete notification

* open related record

* notification preferences shortcut

---

# 18\. PWA requirements

## 18.1 Installation

The application must be installable on:

* Windows

* macOS

* Linux

* Android

* iPhone

* iPad

Provide:

* web app manifest

* application icons

* maskable icons

* install prompts

* splash-screen assets

* standalone display mode

* theme color

* background color

* application shortcuts

## 18.2 PWA shortcuts

Manifest shortcuts:

* create invoice

* start timer

* add expense

* view notifications

## 18.3 Offline behavior

The app must not attempt full offline accounting.

Offline support should include:

* app shell

* cached static resources

* recently viewed clients

* recently viewed invoices

* active timer display

* notification history

* safe queued writes for simple operations

Operations allowed offline:

* create a draft time entry

* stop an existing timer

* add a draft expense

* draft a client note

Do not allow offline:

* invoice number assignment

* invoice finalization

* sending invoices

* recurring invoice execution

* payment recording

* contract renewal

* subscription payment processing

Queued offline writes must:

* show pending state

* synchronize when online

* detect conflicts

* never silently overwrite newer server data

## 18.4 Mobile navigation

On mobile:

* use bottom navigation for primary sections

* use a navigation drawer for all modules

* use full-screen forms

* use cards instead of wide tables

* use sticky primary actions

* use swipe only for non-destructive actions

* require confirmation for destructive actions

Suggested bottom navigation:

* Dashboard

* Clients

* Invoices

* Timer

* More

## 18.5 Mobile quick entry

Provide rapid mobile flows for:

* start timer

* stop timer

* add expense

* photograph receipt

* mark invoice paid

* view upcoming subscription payment

* view overdue invoice

## 18.6 Push notification behavior

Push notifications must:

* open the correct record

* support notification action buttons where supported

* respect per-user preferences

* store delivery outcome

* expire stale notifications

* avoid exposing sensitive financial details on locked screens when privacy mode is enabled

Privacy-mode example:

Normal:

Invoice INV-2026-00124 for €2,400 is overdue.

Privacy mode:

An invoice requires your attention.

---

# 19\. Global search

Provide a command palette available through:

Ctrl \+ K  
Cmd \+ K

Search:

* clients

* quotes

* invoices

* recurring profiles

* contracts

* subscriptions

* expenses

* time entries

Search by:

* name

* number

* email

* domain

* provider

* description

* notes

* amount

* status

Command actions:

* create client

* create quote

* create invoice

* start timer

* add expense

* add contract

* add subscription

* open settings

---

# 20\. File management

Use MinIO for all uploaded files.

Supported file types:

* PDF

* PNG

* JPG

* JPEG

* WebP

* DOCX

* XLSX

* TXT

Use cases:

* client attachments

* quote PDFs

* invoice PDFs

* contract documents

* expense receipts

* business logos

File metadata:

id  
bucket  
objectKey  
originalName  
mimeType  
size  
checksum  
entityType  
entityId  
uploadedBy  
createdAt  
deletedAt

Requirements:

* antivirus scanning hook

* maximum upload size

* signed download URLs

* access authorization

* checksum validation

* soft deletion

* orphan cleanup job

---

# 21\. PDF generation

Generate PDFs for:

* quotes

* invoices

* contracts summary

* client statement

* expense export

PDF requirements:

* A4

* business logo

* business details

* client billing details

* quote or invoice number

* issue and due dates

* line items

* taxes

* totals

* notes

* payment instructions

* footer

* configurable colors

* configurable labels

* multilingual templates

Store generated PDFs in MinIO.

A finalized invoice PDF should be preserved as a historical artifact and not silently replaced.

---

# 22\. Email delivery

Use configurable SMTP.

Settings:

host  
port  
secure  
username  
password  
fromName  
fromEmail  
replyTo

Email templates:

* quote sent

* invoice sent

* invoice due reminder

* invoice overdue reminder

* recurring invoice sent

* payment confirmation

* contract expiry notification

* subscription payment reminder

Required capabilities:

* HTML and plain-text versions

* attachment support

* PDF attachment

* template variables

* send test email

* delivery status

* retry queue

* failure log

Do not build a general email marketing system.

---

# 23\. Settings

## 23.1 Business settings

* business name

* legal name

* VAT number

* tax code

* address

* email

* phone

* website

* logo

* default currency

* default language

* timezone

* default payment terms

* default tax rate

* bank details

* invoice footer

* quote footer

## 23.2 Numbering settings

Configure:

* quote prefix

* invoice prefix

* starting number

* number padding

* yearly reset

* number preview

## 23.3 Tax settings

Allow:

* reusable tax rates

* tax-inclusive or tax-exclusive prices

* zero-rate labels

* exemption note

* per-line tax

Do not implement full tax accounting.

## 23.4 Notification settings

Per event:

* enabled

* channels

* reminder timing

* severity

* quiet hours

* privacy mode

## 23.5 PWA and push settings

* enable push

* test push

* registered devices

* revoke device

* push privacy mode

* quiet hours

* notification sound preference where supported

## 23.6 Data settings

* export all data

* import supported data

* retention settings

* archive behavior

* backup configuration

* restore instructions

---

# 24\. REST API

Base path:

/api/v1

## 24.1 Authentication endpoints

POST   /auth/login  
POST   /auth/logout  
POST   /auth/refresh  
POST   /auth/forgot-password  
POST   /auth/reset-password  
GET    /auth/sessions  
DELETE /auth/sessions/:id  
GET    /auth/me

## 24.2 Clients

GET    /clients  
POST   /clients  
GET    /clients/:id  
PATCH  /clients/:id  
DELETE /clients/:id  
POST   /clients/:id/archive  
POST   /clients/:id/restore  
GET    /clients/:id/activity  
GET    /clients/:id/summary

## 24.3 Quotes

GET    /quotes  
POST   /quotes  
GET    /quotes/:id  
PATCH  /quotes/:id  
DELETE /quotes/:id  
POST   /quotes/:id/send  
POST   /quotes/:id/accept  
POST   /quotes/:id/decline  
POST   /quotes/:id/convert  
POST   /quotes/:id/duplicate  
GET    /quotes/:id/pdf

## 24.4 Invoices

GET    /invoices  
POST   /invoices  
GET    /invoices/:id  
PATCH  /invoices/:id  
DELETE /invoices/:id  
POST   /invoices/:id/finalize  
POST   /invoices/:id/send  
POST   /invoices/:id/schedule  
POST   /invoices/:id/duplicate  
POST   /invoices/:id/void  
POST   /invoices/:id/archive  
POST   /invoices/:id/restore  
GET    /invoices/:id/pdf

## 24.5 Payments

GET    /invoices/:id/payments  
POST   /invoices/:id/payments  
PATCH  /payments/:id  
DELETE /payments/:id

## 24.6 Recurring billing

GET    /recurring-profiles  
POST   /recurring-profiles  
GET    /recurring-profiles/:id  
PATCH  /recurring-profiles/:id  
DELETE /recurring-profiles/:id  
POST   /recurring-profiles/:id/activate  
POST   /recurring-profiles/:id/pause  
POST   /recurring-profiles/:id/resume  
POST   /recurring-profiles/:id/cancel  
POST   /recurring-profiles/:id/run-now  
GET    /recurring-profiles/:id/history

## 24.7 Time tracking

GET    /time-entries  
POST   /time-entries  
GET    /time-entries/:id  
PATCH  /time-entries/:id  
DELETE /time-entries/:id  
POST   /timer/start  
POST   /timer/stop  
POST   /timer/discard  
GET    /timer/active  
POST   /time-entries/invoice

## 24.8 Expenses

GET    /expenses  
POST   /expenses  
GET    /expenses/:id  
PATCH  /expenses/:id  
DELETE /expenses/:id  
POST   /expenses/:id/archive  
POST   /expenses/:id/restore  
POST   /expenses/invoice

## 24.9 Contracts

GET    /contracts  
POST   /contracts  
GET    /contracts/:id  
PATCH  /contracts/:id  
DELETE /contracts/:id  
POST   /contracts/:id/renew  
POST   /contracts/:id/terminate  
POST   /contracts/:id/archive  
POST   /contracts/:id/restore

## 24.10 Subscriptions

GET    /subscriptions  
POST   /subscriptions  
GET    /subscriptions/:id  
PATCH  /subscriptions/:id  
DELETE /subscriptions/:id  
POST   /subscriptions/:id/mark-paid  
POST   /subscriptions/:id/skip-payment  
POST   /subscriptions/:id/cancel  
POST   /subscriptions/:id/archive  
POST   /subscriptions/:id/restore  
GET    /subscriptions/:id/payments

## 24.11 Notifications

GET    /notifications  
GET    /notifications/unread-count  
POST   /notifications/:id/read  
POST   /notifications/read-all  
DELETE /notifications/:id  
GET    /notification-preferences  
PATCH  /notification-preferences  
POST   /push/subscribe  
DELETE /push/subscriptions/:id  
POST   /push/test

## 24.12 Dashboard

GET /dashboard/summary  
GET /dashboard/revenue  
GET /dashboard/expenses  
GET /dashboard/upcoming  
GET /dashboard/action-items

## 24.13 Files

POST   /files  
GET    /files/:id  
DELETE /files/:id  
GET    /files/:id/download

## 24.14 Settings

GET    /settings/business  
PATCH  /settings/business  
GET    /settings/invoicing  
PATCH  /settings/invoicing  
GET    /settings/email  
PATCH  /settings/email  
POST   /settings/email/test  
GET    /settings/push  
PATCH  /settings/push

---

# 25\. API conventions

All API responses should use:

{  
  "data": {},  
  "meta": {},  
  "error": **null**  
}

Error format:

{  
  "data": **null**,  
  "meta": {},  
  "error": {  
    "code": "INVOICE\_ALREADY\_FINALIZED",  
    "message": "The invoice can no longer be edited.",  
    "details": {}  
  }  
}

List endpoints must support:

* pagination

* sorting

* filtering

* search

* date ranges

* status filters

* archived filters

Example:

GET /api/v1/invoices?page=1\&limit=50\&status=overdue\&sort=-dueDate

---

# 26\. WebSocket events

Use WebSockets for live UI updates.

Events:

notification.created  
notification.updated  
invoice.created  
invoice.updated  
invoice.sent  
invoice.paid  
invoice.overdue  
quote.updated  
quote.accepted  
recurring.invoice.generated  
recurring.invoice.failed  
timer.started  
timer.updated  
timer.stopped  
subscription.updated  
subscription.payment\_due  
contract.updated  
contract.expiring  
dashboard.refresh

All events must include:

eventId  
eventType  
entityType  
entityId  
timestamp  
payload

---

# 27\. Background jobs

Use BullMQ.

Required queues:

email  
notifications  
push  
pdf  
recurring-billing  
invoice-status  
quote-status  
contract-status  
subscription-status  
file-cleanup  
backup  
maintenance

## 27.1 Recurring jobs

Run:

* recurring invoice scheduler: every 15 minutes

* invoice due-status scanner: every hour

* quote expiry scanner: every hour

* subscription scanner: every hour

* contract scanner: every hour

* notification reminder scheduler: every hour

* stale timer scanner: every hour

* orphan file cleanup: daily

* backup job: configurable

* system health report: daily

## 27.2 Retry policy

Default:

* 5 attempts

* exponential backoff

* dead-letter behavior

* error logging

* admin notification after final failure

## 27.3 Idempotency

All financial and scheduled jobs must be idempotent.

Use unique indexes for:

* invoice numbers

* quote numbers

* recurring occurrences

* subscription payment occurrences

* notification deduplication keys

---

# 28\. MongoDB collections

Required collections:

users  
sessions  
clients  
quotes  
invoices  
payments  
recurringProfiles  
recurringOccurrences  
timeEntries  
expenses  
contracts  
subscriptions  
subscriptionPayments  
notifications  
notificationPreferences  
pushSubscriptions  
files  
settings  
emailLogs  
jobLogs  
auditLogs  
counters  
events

Use MongoDB transactions where multiple financially relevant records must be updated atomically.

---

# 29\. Audit logging

Audit all important actions.

Audit fields:

id  
userId  
action  
entityType  
entityId  
before  
after  
metadata  
ipAddress  
userAgent  
createdAt

Audit events include:

* create

* update

* archive

* restore

* delete

* finalize invoice

* void invoice

* add payment

* remove payment

* send invoice

* send quote

* activate recurring profile

* cancel recurring profile

* mark subscription paid

* renew contract

* configuration change

* login

* failed login

* password change

Audit logs must not be editable through the UI.

---

# 30\. Security

Required:

* HTTPS only in production

* secure headers

* CSRF protection where applicable

* strict CORS

* rate limiting

* Argon2 password hashing

* encrypted secrets

* secure cookies

* session rotation

* MIME validation

* upload size limits

* signed MinIO URLs

* access-control checks on every entity

* audit logs

* no sensitive credentials in application logs

* no secrets committed to Git

* separate development and production secrets

* database authentication

* Redis authentication

* MinIO credentials

* container health checks

* dependency scanning

* image vulnerability scanning

Do not expose:

* MongoDB

* Redis

* MinIO admin console

* worker ports

to the public internet.

---

# 31\. Docker architecture

Internet  
   │  
   ▼  
Reverse Proxy  
   │  
   ├── Web frontend  
   ├── API  
   └── WebSocket endpoint

API  
   ├── MongoDB  
   ├── Redis  
   ├── MinIO  
   └── BullMQ

Worker  
   ├── Redis  
   ├── MongoDB  
   ├── MinIO  
   ├── SMTP  
   └── Web Push providers

## 31.1 Docker Compose services

services**:**  
  proxy**:**  
  web**:**  
  api**:**  
  worker**:**  
  scheduler**:**  
  mongodb**:**  
  redis**:**  
  minio**:**  
  minio-init**:**  
  mailpit**:**

Mailpit is development-only.

## 31.2 Volumes

Required persistent volumes:

mongodb\_data  
redis\_data  
minio\_data  
proxy\_data  
backup\_data

## 31.3 Health checks

Every service must expose a health check.

API health endpoints:

/health/live  
/health/ready  
/health/dependencies

Check:

* MongoDB

* Redis

* MinIO

* worker queue

* SMTP configuration

---

# 32\. Environment variables

Example categories:

APP\_ENV  
APP\_URL  
API\_URL  
JWT\_SECRET  
SESSION\_SECRET

MONGO\_URI  
REDIS\_URL

MINIO\_ENDPOINT  
MINIO\_PORT  
MINIO\_ACCESS\_KEY  
MINIO\_SECRET\_KEY  
MINIO\_BUCKET

SMTP\_HOST  
SMTP\_PORT  
SMTP\_SECURE  
SMTP\_USERNAME  
SMTP\_PASSWORD  
SMTP\_FROM\_EMAIL  
SMTP\_FROM\_NAME

VAPID\_PUBLIC\_KEY  
VAPID\_PRIVATE\_KEY  
VAPID\_SUBJECT

BACKUP\_ENABLED  
BACKUP\_SCHEDULE  
BACKUP\_RETENTION\_DAYS

Provide a fully documented .env.example.

---

# 33\. Backup and restore

Back up:

* MongoDB

* MinIO

* application settings

* encryption metadata

* generated documents

Backup requirements:

* scheduled backups

* manual backup

* encrypted archive

* configurable retention

* restore script

* restore verification

* backup status notification

* failure notification

Suggested layout:

/backups/YYYY-MM-DD-HHmm/  
  mongodb.archive  
  minio/  
  manifest.json  
  checksum.sha256

---

# 34\. Import and export

## 34.1 Import

Support CSV import for:

* clients

* invoices

* expenses

* subscriptions

* time entries

Provide:

* column mapping

* preview

* validation

* duplicate detection

* dry run

* import report

## 34.2 Export

Support:

* CSV

* JSON

* PDF where relevant

Export:

* clients

* quotes

* invoices

* payments

* expenses

* time entries

* contracts

* subscriptions

* complete account data

---

# 35\. Frontend pages

## 35.1 Public pages

* login

* forgot password

* reset password

* offline

* application error

## 35.2 Authenticated pages

* dashboard

* clients list

* client detail

* quotes list

* quote editor

* quote detail

* invoices list

* invoice editor

* invoice detail

* recurring billing list

* recurring billing editor

* time tracking

* expenses list

* expense detail

* contracts list

* contract detail

* subscriptions list

* subscription detail

* notifications

* settings

* profile

* users

* audit logs

---

# 36\. Reusable frontend components

Create:

* AppDataTable

* MobileRecordCard

* StatusChip

* MoneyValue

* DateValue

* ClientSelector

* CurrencySelector

* TaxSelector

* LineItemEditor

* AddressEditor

* FileUploader

* FileViewer

* PdfPreview

* ConfirmDialog

* EntityActivity

* NotificationBell

* NotificationPanel

* EmptyState

* ErrorState

* LoadingState

* FilterBar

* DateRangePicker

* RecurrenceEditor

* PaymentDialog

* QuickCreateMenu

* CommandPalette

* OfflineStatus

* SyncStatus

* PwaInstallPrompt

* PushPermissionPrompt

---

# 37\. Validation rules

Use shared Zod schemas between frontend and backend.

Examples:

* invoice due date cannot precede issue date

* quote expiry date cannot precede issue date

* payment amount must be positive

* payment cannot exceed configured overpayment tolerance

* recurring profile must have a valid next date

* contract end date cannot precede start date

* subscription next payment date must be valid

* domain name must be normalized

* time-entry duration cannot be negative

* finalized invoice line items cannot be edited

* invoice currency must match payment currency unless conversion support is explicitly added later

---

# 38\. Testing strategy

## 38.1 Unit tests

Test:

* totals calculations

* tax calculations

* discount calculations

* recurring date calculations

* invoice due-status logic

* subscription reminder dates

* contract expiry dates

* notification preference resolution

* idempotency keys

* permission rules

## 38.2 Integration tests

Test:

* invoice creation

* quote conversion

* recurring invoice generation

* payment recording

* time-entry invoicing

* expense invoicing

* subscription payment occurrence generation

* notification delivery

* file upload

* backup and restore

## 38.3 End-to-end tests

Use Playwright.

Critical flows:

1. Create client

2. Create quote

3. Convert quote to invoice

4. Send invoice

5. Record partial payment

6. Record final payment

7. Create recurring profile

8. Generate recurring invoice

9. Start and stop timer

10. Convert time entries to invoice

11. Add expense and receipt

12. Add expense to invoice

13. Add contract

14. Trigger contract-expiry notification

15. Add domain subscription

16. Trigger payment-due notification

17. Install PWA

18. Enable push

19. Receive and open push notification

20. Complete basic offline timer flow

## 38.4 Security tests

Include:

* authorization bypass tests

* upload validation tests

* rate-limit tests

* session revocation tests

* password-reset tests

* CSRF tests

* XSS tests

* API validation tests

---

# 39\. Logging and monitoring

Use structured logs.

Log fields:

timestamp  
level  
service  
requestId  
userId  
event  
entityType  
entityId  
duration  
error

Required logging:

* API requests

* authentication events

* worker jobs

* email delivery

* push delivery

* PDF generation

* storage errors

* scheduled-job executions

Provide basic operational metrics:

* API request count

* API latency

* failed requests

* queue size

* failed jobs

* active workers

* email failures

* push failures

* database availability

* storage availability

Do not build a monitoring UI inside the main product.

---

# 40\. Internationalization

All UI strings must use translation keys.

Initial languages:

* English

* Italian

Support:

* locale-aware dates

* locale-aware currency

* decimal separators

* tax labels

* translated invoice templates

* translated quote templates

* translated email templates

Store financial values as integer minor units.

Example:

€12.34 → 1234

---

# 41\. Accessibility

Target WCAG 2.1 AA.

Requirements:

* keyboard navigation

* visible focus states

* proper labels

* semantic HTML

* screen-reader support

* color contrast

* no color-only status indicators

* accessible dialogs

* accessible tables

* reduced-motion support

---

# 42\. Performance requirements

Targets:

* initial page load under 3 seconds on normal broadband

* navigation response under 300 ms after load

* API list response under 500 ms for typical datasets

* support at least 100,000 invoices

* support at least 100,000 time entries

* support at least 10,000 clients

* background-job execution isolated from API

* pagination required for large lists

* lazy-load PDF previews and attachments

---

# 43\. Development phases

## Phase 1: Foundation

Build:

* monorepo

* Docker development environment

* frontend shell

* backend shell

* authentication

* users

* settings

* MongoDB

* Redis

* MinIO

* OpenAPI

* audit framework

* notification framework

* PWA shell

## Phase 2: Clients

Build:

* client CRUD

* client detail

* attachments

* activity log

* search

* archive and restore

## Phase 3: Quotes and invoices

Build:

* quote editor

* invoice editor

* line-item calculations

* PDF generation

* email sending

* payments

* statuses

* quote conversion

* numbering

## Phase 4: Recurring billing

Build:

* recurring profile editor

* scheduler

* occurrence history

* automatic generation

* automatic sending

* retry handling

* idempotency

## Phase 5: Time tracking

Build:

* active timer

* manual entries

* reports

* billing conversion

* mobile timer UI

* offline-safe timer behavior

## Phase 6: Expenses

Build:

* expense CRUD

* receipt upload

* categories

* billable expenses

* invoice integration

## Phase 7: Contracts

Build:

* contract CRUD

* attachments

* renewal

* expiry calculation

* notice deadlines

* notifications

## Phase 8: Subscriptions

Build:

* domains

* VPS subscriptions

* other subscriptions

* payment occurrences

* renewal dates

* expiry alerts

* payment reminders

## Phase 9: Notifications and PWA

Complete:

* notification center

* per-event preferences

* browser push

* installed PWA push

* quiet hours

* privacy mode

* offline shell

* mobile layouts

* install prompts

## Phase 10: Hardening

Complete:

* E2E testing

* security testing

* backup

* restore

* imports

* exports

* monitoring

* performance improvements

* production deployment documentation

---

# 44\. Definition of done

A feature is complete only when it includes:

* backend model

* validation

* REST endpoints

* authorization

* frontend UI

* responsive mobile UI

* error handling

* loading states

* empty states

* audit events

* relevant notifications

* tests

* API documentation

* user documentation

* Docker compatibility

---

# 45\. AI IDE execution rules

The AI IDE must follow these rules:

1. Do not add modules outside this specification.

2. Do not introduce a full ERP architecture.

3. Do not add sales pipelines or project management.

4. Use TypeScript everywhere.

5. Avoid any.

6. Use shared Zod schemas.

7. Keep frontend, API, and workers separated.

8. Keep business logic out of route handlers.

9. Use service and repository layers.

10. Use transactions for financially sensitive workflows.

11. Use BullMQ for asynchronous work.

12. Use MinIO for files.

13. Use Redis for queues, locks, cache, and rate limiting.

14. Use integer minor units for money.

15. Use UTC internally.

16. Display dates in the configured user timezone.

17. Implement idempotency for recurring and financial jobs.

18. Every database query must be scoped by authorization.

19. Never trust totals sent by the client.

20. Recalculate all totals on the backend.

21. Finalized invoices must not be silently editable.

22. Generated invoice PDFs must be preserved.

23. Every important action must be audited.

24. Every page must work on desktop and mobile.

25. Every module must include empty, loading, and error states.

26. Every API endpoint must be documented in OpenAPI.

27. Every background job must have retry and failure handling.

28. Every notification event must respect user preferences.

29. Do not store server passwords, API keys, or private SSH keys in subscription records.

30. Maintain strict scope discipline.

---

# 46\. Recommended implementation pattern

Backend folders:

src/  
├── modules/  
│   ├── auth/  
│   ├── users/  
│   ├── clients/  
│   ├── quotes/  
│   ├── invoices/  
│   ├── recurring/  
│   ├── time/  
│   ├── expenses/  
│   ├── contracts/  
│   ├── subscriptions/  
│   ├── notifications/  
│   ├── files/  
│   ├── settings/  
│   └── dashboard/  
├── infrastructure/  
├── middleware/  
├── queues/  
├── events/  
├── shared/  
└── app.ts

Each module should contain:

model  
schema  
repository  
service  
controller  
routes  
events  
jobs  
tests  
types

Frontend folders:

src/  
├── modules/  
│   ├── clients/  
│   ├── quotes/  
│   ├── invoices/  
│   ├── recurring/  
│   ├── time/  
│   ├── expenses/  
│   ├── contracts/  
│   ├── subscriptions/  
│   ├── notifications/  
│   └── settings/  
├── components/  
├── layouts/  
├── stores/  
├── router/  
├── services/  
├── composables/  
├── pwa/  
├── i18n/  
└── types/

---

# 47\. Final product boundary

The final product is a focused operational system for a software developer or small software company to manage:

* who the clients are

* what has been quoted

* what has been invoiced

* what is paid or overdue

* which invoices recur

* how much time has been worked

* which expenses were incurred

* which contracts are active or expiring

* which domains, VPS servers, and subscriptions must be paid

* which events require attention

Nothing beyond this boundary should be implemented without an explicit revision of this specification.